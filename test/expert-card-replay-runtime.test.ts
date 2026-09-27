import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {createExpertCardCopyStore,ALIGNER_ROLE as roleId,cardDigest,type ExecutionReceipt} from '../src/expert-card-copy-store.js';
import {createCardReplayRuntime,registerCardReplayTools,mergeResumeMessages,bindCardReplayRequest,runCardReplaySession} from '../src/expert-card-replay-runtime.js';
import {receiptFromLegacyEvidence,importLegacyCopyState} from '../src/expert-card-replay-recovery.js';

const source={roleId,systemPrompt:'ORIGINAL'};
const settled=(id:string,parsed=true):ExecutionReceipt=>({status:'settled',requestId:id,costUsd:0,totalTokens:1,parsed});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'replay-infra-'));const receipts:Record<string,ExecutionReceipt>={};let calls=0;const options={maxUpdates:9,executionBinding:'fixed-input',requirePriorBatch:true,receipt:async(id:string)=>receipts[id]??{status:'unknown'} as ExecutionReceipt};const execute=async(_c:any,id:string)=>{calls++;receipts[id]=settled(id,id!=='baseline1');if(id==='baseline1')throw Error('parse failure');return{matched:true};};return{root,receipts,options,execute,calls:()=>calls,store:createExpertCardCopyStore(root,source,execute,options)};}

test('settled parse failure continues batch and survives resume; partial update, freeze and branching remain idempotent',async()=>{
 const f=await fixture();await f.store.card({action:'create',roleId});const batch=await f.store.sample({roleId,version:'v0'});assert.deepEqual(batch.map(r=>r.status),['settled-parse-failure','settled-success','settled-success']);assert.equal(f.calls(),3);
 const resumed=createExpertCardCopyStore(f.root,source,f.execute,f.options);assert.equal((await resumed.sample({roleId,version:'v0'}))[0]!.delivery,'cached-existing');assert.equal(f.calls(),3);
 const v1=await resumed.card({action:'update',roleId,parentVersion:'v0',systemPrompt:'FIRST',reason:'edit'});assert.equal(v1.skill,'');
 await assert.rejects(resumed.card({action:'update',roleId,parentVersion:'v0',version:'v1',skill:'x',reason:'x'}),/Ambiguous/);
 await resumed.sample({roleId,version:'v1'});await resumed.confirm({roleId,version:'v1',selectionId:'selection1'});const n=f.calls();await resumed.confirm({roleId,version:'v1',selectionId:'selection1'});assert.equal(f.calls(),n);
 await assert.rejects(resumed.confirm({roleId,version:'v1',selectionId:'alias'}),/already frozen/);assert.equal(f.calls(),n);
 const v2=await resumed.card({action:'update',roleId,parentVersion:'v1',skill:'SKILL',reason:'branch'});assert.equal(v2.systemPrompt,'FIRST');await resumed.sample({roleId,version:'v2'});
 const v3=await resumed.card({action:'update',roleId,parentVersion:'v2',skill:'',reason:'clear'});assert.equal(v3.skill,'');assert.equal(v3.version,'v3');await resumed.sample({roleId,version:'v3'});
 await assert.rejects(resumed.confirm({roleId,version:'v3',selectionId:'selection1'}),/rebound/);await resumed.confirm({roleId,version:'v3',selectionId:'selection2'});
 assert.equal((await resumed.snapshot()).freezes.selection1!.version,'v1');await assert.rejects(resumed.card({action:'read',roleId:'wrong',version:'v1'}),/Role/);
 await assert.rejects(resumed.card({action:'read',roleId,version:'../v0'}),/Unknown/);
});

test('unknown/running cannot masquerade as settled; explicit pre-send receipt is retryable',async()=>{
 const f=await fixture();await f.store.card({action:'create',roleId});const store=createExpertCardCopyStore(f.root,source,async()=>{throw Error('network unknown');},f.options);
 assert.equal((await store.sample({roleId,version:'v0'}))[0]!.status,'unknown');await assert.rejects(store.sample({roleId,version:'v0'}),/unknown/);await assert.rejects(store.card({action:'update',roleId,parentVersion:'v0',skill:'x',reason:'x'}),/Unresolved/);
 await store.reconcile('baseline1',{status:'pre-send-blocked'});const recovered=await f.store.sample({roleId,version:'v0'});assert.equal(recovered.length,3);
 const s=await f.store.snapshot();s.runs.baseline1!.status='running';await writeFile(join(f.root,'state.json'),JSON.stringify(s));await assert.rejects(f.store.sample({roleId,version:'v0'}),/running/);
});

test('legacy status strings alone never certify settlement',()=>{
 const events=[{type:'admit',id:1,phase:'p'},{type:'settled',id:1,phase:'p',actual:{costUsd:0.1,totalTokens:20}}];
 assert.equal(receiptFromLegacyEvidence(events,'p','failure').status,'settled');assert.equal(receiptFromLegacyEvidence(events.slice(1),'p','failure').status,'unknown');assert.equal(receiptFromLegacyEvidence(events,'p','unknown').status,'unknown');
 const body={version:'v0',parent:null,roleId,systemPrompt:'ORIGINAL',skill:'',reason:'initial'};const copy={...body,digest:cardDigest(body)};const legacy={sourceBinding:cardDigest(source),versions:{v0:copy},updates:0,runs:{baseline1:{version:'v0',copyDigest:copy.digest,status:'failed'}}};
 assert.equal(importLegacyCopyState({legacy,source,executionBinding:'x',receipts:{},freezes:{}}).runs.baseline1!.status,'unknown');
});

test('exact artifact defaults and session inventory reject paths; stable schema independent of quota',async()=>{
 const root=await mkdtemp(join(tmpdir(),'card-tools-')),file=join(root,'raw.md');await writeFile(file,'RAW');
 const config={root,source,storeOptions:{maxUpdates:8},evidence:{sessions:{actual:'REPORT'},defaultSession:'actual',artifacts:{'r1/public-output.md':{path:file,sha256:cardDigest('RAW')}},defaultArtifacts:{r1:'r1/public-output.md'}}};
 const runtime=createCardReplayRuntime(config,async()=>{});assert.deepEqual(await runtime.evidence({kind:'artifact',id:'r1'}),{id:'r1/public-output.md',raw:'RAW'});assert.deepEqual(await runtime.evidence({kind:'session'}),{id:'actual',raw:'REPORT'});
 await assert.rejects(runtime.evidence({kind:'artifact',id:'../outside'}),/Unknown/);await assert.rejects(runtime.evidence({kind:'session',id:'priorSessionOutputs'}),/Unknown/);
 const schemas:any[]=[];const pi={registerTool:(t:any)=>schemas.push({name:t.name,parameters:t.parameters,description:t.description}),on:()=>{}};registerCardReplayTools(pi,runtime,join(root,'stop1'));const first=JSON.stringify(schemas);schemas.length=0;registerCardReplayTools(pi,createCardReplayRuntime({...config,storeOptions:{maxUpdates:20}},async()=>{}),join(root,'stop2'));assert.equal(JSON.stringify(schemas),first);
});

test('resume retains one user and prior paid tool messages; request/cache bind actual Card',async()=>{
 const prefix=[{role:'system',content:'S'},{role:'user',content:[{type:'text',text:'U'}]},{role:'assistant',content:'already paid'},{role:'tool',content:'saved output'}],fresh=[...prefix.slice(0,2),{role:'assistant',content:'new output'}];
 assert.deepEqual(mergeResumeMessages(prefix,fresh,'S','U'),[...prefix,fresh[2]]);assert.throws(()=>mergeResumeMessages([...prefix,prefix[1]],fresh,'S','U'),/exactly/);
 const f=await fixture();const c=await f.store.card({action:'create',roleId});const a=bindCardReplayRequest({systemPrompt:'ORIGINAL suffix',prompt:'same',model:'fixed'},source.systemPrompt,c);assert.equal(a.producer.systemSha256,cardDigest(a.request.systemPrompt));assert.equal(a.cacheKey,cardDigest(a.request));
 await f.store.replay({roleId,version:'v0',runId:'baseline1'});
 await assert.rejects(createExpertCardCopyStore(f.root,source,f.execute,{...f.options,executionBinding:'changed'}).replay({roleId,version:'v0',runId:'baseline1'}),/another version or producer/);
});

// Exercise the actual Agent CLI and shared extension path against a loopback-only fake provider.
async function offlinePi(invalid:boolean){
 const root=await mkdtemp(join(tmpdir(),'card-pi-e2e-'));const calls:any[]=[];const role=roleId;
 const plan:any[]=invalid?[['expert_evidence',{kind:'artifact',id:'not-real'}]]:[
 ['expert_card_copy',{action:'create',roleId:role}],['expert_trial',{action:'sample',roleId:role,version:'v0'}],
 ['expert_card_copy',{action:'update',roleId:role,parentVersion:'v0',systemPrompt:'CHANGED',reason:'edit'}],
 ['expert_trial',{action:'sample',roleId:role,version:'v1'}],['expert_trial',{action:'confirm',roleId:role,version:'v1',selectionId:'chosen'}],
 ['expert_card_copy',{action:'update',roleId:role,parentVersion:'v1',skill:'BRANCH',reason:'branch after freeze'}],
 ['expert_evidence',{kind:'artifact',id:'baseline1'}]];
 const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;calls.push(JSON.parse(raw));const step=plan[calls.length-1];const delta=step?{role:'assistant',tool_calls:[{index:0,id:`call${calls.length}`,type:'function',function:{name:step[0],arguments:JSON.stringify(step[1])}}]}:{role:'assistant',content:'Offline report complete'};
 res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${JSON.stringify({id:'fake',object:'chat.completion.chunk',model:'card-fake',choices:[{index:0,delta,finish_reason:null}]})}\n\n`);res.end(`data: ${JSON.stringify({id:'fake',object:'chat.completion.chunk',model:'card-fake',choices:[{index:0,delta:{},finish_reason:step?'tool_calls':'stop'}],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}})}\n\ndata: [DONE]\n\n`);});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;
 const modulePath=resolve('src/expert-card-replay-runtime.ts').replaceAll('\\','/');const extension=join(root,'extension.ts');await writeFile(join(root,'raw.md'),'parse-failed raw');
 await writeFile(extension,`import fs from 'node:fs';import{createCardReplayRuntime,registerCardReplayTools}from ${JSON.stringify(modulePath)};
 export default function(pi){const root=${JSON.stringify(root)};const receipts={};const runtime=createCardReplayRuntime({root,source:${JSON.stringify(source)},storeOptions:{maxUpdates:4,sampleCount:2,confirmationCount:1,requirePriorBatch:true,executionBinding:'same-input',receipt:async(id)=>receipts[id]},evidence:{sessions:{},artifacts:{'baseline1/public-output.md':{path:root+'/raw.md',sha256:'${cardDigest('parse-failed raw')}'}},defaultArtifacts:{baseline1:'baseline1/public-output.md'}}},async(copy,id)=>{receipts[id]={status:'settled',requestId:id,costUsd:0,totalTokens:1,parsed:id!=='baseline1'};fs.appendFileSync(root+'/fake-expert.jsonl',JSON.stringify({id,copy:copy.digest})+'\\n');if(id==='baseline1')throw Error('parse failure');return{matched:true};});registerCardReplayTools(pi,runtime,root+'/engineering-stop.json');pi.registerProvider('card-offline',{baseUrl:'http://127.0.0.1:${port}/v1',apiKey:'offline',api:'openai-completions',models:[{id:'card-fake',name:'Offline',reasoning:false,input:['text'],contextWindow:200000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]});}`);
 try{const options={cwd:resolve('.'),provider:'card-offline',model:'card-fake',systemPrompt:'Use tools',prompt:'Offline fixture',rawEventsPath:join(root,'events.jsonl'),timeoutMs:60000,extensionPaths:[extension],session:{id:crypto.randomUUID(),dir:join(root,'sessions')}};
 if(invalid){await assert.rejects(runCardReplaySession(options));assert.equal(calls.length,1,'engineering failure must prevent second through tenth provider requests');}
 else{const result=await runCardReplaySession(options);assert.equal(result.finalText,'Offline report complete');const state=JSON.parse(await readFile(join(root,'copies/state.json'),'utf8'));assert.equal(state.runs.baseline1.status,'settled-parse-failure');assert.equal(state.versions.v2.parent,'v1');assert.equal(state.freezes.chosen.version,'v1');assert.equal(calls.length,8);}
 return{requests:calls.length,realProviderRequests:0};
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
}
test('real Agent offline copy/update/parse-failure/branch/artifact flow', {timeout:90000},async()=>{await offlinePi(false);});
test('real Agent engineering rejection prevents any next provider request', {timeout:90000},async()=>{await offlinePi(true);});
