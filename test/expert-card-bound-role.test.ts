import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Check} from 'typebox/value';
import {createCardReplayRuntime,registerCardReplayTools} from '../src/expert-card-replay-runtime.js';
import {ALIGNER_ROLE as roleId} from '../src/expert-card-copy-store.js';
function register(runtime:any,path:string){const tools:any[]=[],handlers:Record<string,any>={};registerCardReplayTools({registerTool:(t:any)=>tools.push(t),on:(n:string,f:any)=>handlers[n]=f},runtime,path);return{tools,handlers};}
test('real failed update defaults only the bound role and preserves every model-generated field',async()=>{
 const fixture=JSON.parse(await readFile(new URL('./fixtures/expert-card-missing-role-update.json',import.meta.url),'utf8')),args=fixture.arguments;
 assert.equal(fixture.source.requestId,198);assert(!Object.hasOwn(args,'roleId'));
 const root=await mkdtemp(join(tmpdir(),'bound-role-'));let executions=0;
 const runtime=createCardReplayRuntime({root,source:{roleId,systemPrompt:'base'},storeOptions:{sampleCount:2,maxUpdates:2,requirePriorBatch:true,receipt:async id=>({status:'settled',requestId:id,costUsd:0,totalTokens:1,parsed:true})},evidence:{sessions:{},artifacts:{},defaultArtifacts:{}}},async()=>{executions++;return{offline:true};});
 await runtime.card({action:'create',roleId});await runtime.store.sample({roleId,version:'v0'});await runtime.card({action:'update',roleId,parentVersion:'v0',systemPrompt:'prior',reason:'offline setup'});await runtime.store.sample({roleId,version:'v1'});
 const {tools}=register(runtime,join(root,'stop')),card=tools.find(t=>t.name==='expert_card_copy'),trial=tools.find(t=>t.name==='expert_trial');
 const legacySchema={...card.parameters,required:[...card.parameters.required,'roleId']};assert.equal(Check(legacySchema,args),false);assert.equal(Check(card.parameters,args),true);
 const response=await card.execute('real-failed-shape',args),value=JSON.parse(response.content[0].text);assert.equal(value.version,'v2');assert.equal(value.roleId,roleId);assert.equal(value.parent,args.parentVersion);assert.equal(value.reason,args.reason);assert.equal(value.systemPrompt,args.systemPrompt);
 assert.deepEqual(await card.execute('same-update',args),response);assert.equal((await runtime.store.snapshot()).updates,2);assert.equal(executions,4,'update never invokes a model');
 assert(Check(trial.parameters,{action:'sample',version:'v2'}));await trial.execute('batch',{action:'sample',version:'v2'});assert.equal(executions,6);
});
test('wrong explicit role or wrong bound source hard-stops both Card and trial before execution',async()=>{
 for(const sourceRole of [roleId,'wrong-source'])for(const name of ['expert_card_copy','expert_trial']){
  const root=await mkdtemp(join(tmpdir(),'wrong-role-'));let executed=0;
  const runtime=createCardReplayRuntime({root,source:{roleId:sourceRole,systemPrompt:'base'},storeOptions:{},evidence:{sessions:{},artifacts:{},defaultArtifacts:{}}},async()=>{executed++;});const r=register(runtime,join(root,'stop'));
  const args={action:name==='expert_card_copy'?'create':'sample',...(sourceRole===roleId?{roleId:'wrong-role'}:{}),version:'v0'};
  await assert.rejects(r.tools.find(t=>t.name===name).execute('bad',args),/Role is not allowed/);let aborted=false;assert.throws(()=>r.handlers.before_provider_request({}, {abort(){aborted=true;}}),/Engineering stop/);assert(aborted);assert.equal(executed,0);
 }
});
test('omitting role does not bypass feedback-only or read-only stage locks',async()=>{
 for(const mode of ['feedbackOnly','readOnly'])for(const name of ['expert_card_copy','expert_trial']){
  const root=await mkdtemp(join(tmpdir(),'role-lock-')),runtime=createCardReplayRuntime({root,source:{roleId,systemPrompt:'base'},[mode]:true,storeOptions:{},evidence:{sessions:{},artifacts:{},defaultArtifacts:{}}},async()=>{throw Error('no execution');}),r=register(runtime,join(root,'stop'));
  await assert.rejects(r.tools.find(t=>t.name===name).execute('locked',{action:name==='expert_card_copy'?'update':'sample',parentVersion:'v0',version:'v0',skill:'x',reason:'x'}),/forbid|read-only/);
 }
});
