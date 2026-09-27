import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cardDigest,createExpertCardCopyStore,applyCardCopy} from '../src/expert-card-copy-store.js';
import {createCardReplayRuntime,registerCardReplayTools,type ReplayRuntimeConfig} from '../src/expert-card-replay-runtime.js';

async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'blind-card-'));
  const source={roleId:'refine.evidence-aligner',systemPrompt:'PRIVATE_PARENT_\r\n原文'};
  const store=createExpertCardCopyStore(join(root,'copies'),source,async()=>{throw Error('No paid calls in test');});
  const parent=await store.card({action:'create',roleId:source.roleId});
  const state=await store.snapshot();
  const config:ReplayRuntimeConfig={root,source,generationOnly:true,modificationToolContract:'blind-append-v1',blindAppendBinding:{parentVersion:'v0',parentDigest:parent.digest,startStateSha256:cardDigest(state)},storeOptions:{maxUpdates:1,reviewedCopies:{}},evidence:{sessions:{},artifacts:{},defaultArtifacts:{}},stageVisibility:{artifactIds:[],sessionIds:[],versionIds:[],cardReadVersions:[],updateParentVersions:['v0'],allowCreate:false,allowDynamicArtifacts:false,allowVersionBundles:false}};
  return{root,source,store,parent,state,config};
}

test('blind append exposes only increments and a receipt, preserves parent, and stops following request',async()=>{
  const f=await fixture();
  // Mechanical fixture enrichment tests inheritance without using any production Card.
  const parent=f.state.versions.v0!;
  parent.skill='PRIVATE_SKILL';
  parent.reason='PRIVATE_REASON';
  parent.fewShotCases=[{syntheticTaskRequirement:'PRIVATE_CASE',mode:'content',sourceAspect:{id:'s',title:'s',description:'s',evidences:[{quote:'source',location:'s'}]},targetAspect:{id:'t',title:'t',description:'t',evidences:[{quote:'target',location:'t'}]},expectedMatched:false,evidenceRationale:[{side:'source',evidenceIndex:0,quotedText:'source',explanation:'s'},{side:'target',evidenceIndex:0,quotedText:'target',explanation:'t'}],whyBoundaryApplies:'fixture',scope:'fixture'}];
  const {digest:_,...body}=parent;
  parent.digest=cardDigest(body);
  f.config.blindAppendBinding!.parentDigest=parent.digest;
  f.config.blindAppendBinding!.startStateSha256=cardDigest(f.state);
  await writeFile(join(f.root,'copies/state.json'),JSON.stringify(f.state));
  const runtime=createCardReplayRuntime(f.config,async()=>{throw Error('No execution');});
  const definitions:any[]=[];const handlers:Record<string,Function[]>={};let active:string[]=[];
  const pi={registerTool:(d:any)=>definitions.push(d),on:(name:string,fn:Function)=>(handlers[name]??=[]).push(fn),setActiveTools:(names:string[])=>{active=names;}};
  registerCardReplayTools(pi,runtime,join(f.root,'engineering-stop.json'));
  handlers.session_start![0]!();
  assert.deepEqual(active,['expert_card_append']);
  assert.deepEqual(definitions.map(d=>d.name),active);
  assert.deepEqual(Object.keys(definitions[0].parameters.properties),['promptAppend','badCaseAppend']);
  assert.equal(definitions[0].parameters.type,'object');
  assert.equal(definitions[0].parameters.additionalProperties,false);
  const increments={promptAppend:'MODEL_INCREMENT\nnew rule',badCaseAppend:'MODEL_BAD_CASE\ncomplete example'};
  const result=await definitions[0].execute('tool-1',increments);
  assert(!JSON.stringify(result).includes('PRIVATE_'));
  const copy=await runtime.store.card({action:'read',roleId:f.source.roleId,version:'v1'});
  assert.equal(copy.systemPrompt,f.source.systemPrompt+'\n\n'+increments.promptAppend+'\n\n'+increments.badCaseAppend);
  assert.equal(copy.skill,'PRIVATE_SKILL');assert.equal(copy.reason,'PRIVATE_REASON');assert.deepEqual(copy.fewShotCases,parent.fewShotCases);
  assert.equal((await runtime.store.card({action:'read',roleId:f.source.roleId,version:'v0'})).digest,parent.digest);
  const rendered=applyCardCopy(f.source.systemPrompt+'\nEXPRESSION_SUFFIX',f.source.systemPrompt,copy);
  assert(rendered.endsWith('\nEXPRESSION_SUFFIX'));assert(rendered.includes(increments.badCaseAppend));
  const receipt=JSON.parse(await readFile(join(f.root,'card-append-receipt.json'),'utf8'));
  for(const key of ['parentPromptPreserved','skillPreserved','fewShotCasesPreserved','reasonPreserved'])assert.equal(receipt[key],true);
  assert.deepEqual(JSON.parse(await readFile(join(f.root,'card-increments.json'),'utf8')),increments);
  assert(!JSON.stringify(receipt).includes('PRIVATE_'));
  let aborted=false;
  assert.throws(()=>handlers.before_provider_request![0]!({}, {abort(){aborted=true;}}),/Planned candidate review pause/);
  assert(aborted);
  await assert.rejects(definitions[0].execute('tool-2',increments),/Planned candidate review pause/);
});

test('blind append rejects full-content fields and changed bindings without altering state',async()=>{
  const f=await fixture();
  const increments={action:'append' as const,roleId:f.source.roleId,...f.config.blindAppendBinding!,promptAppend:'A',badCaseAppend:'B'};
  await assert.rejects(f.store.card({...increments,systemPrompt:'REPLACE'}),/increments only/);
  await assert.rejects(f.store.card({...increments,parentDigest:'0'.repeat(64)}),/parent or prepared state changed/);
  await assert.rejects(f.store.card({...increments,startStateSha256:'0'.repeat(64)}),/parent or prepared state changed/);
  await assert.rejects(f.store.card({...increments,badCaseAppend:'  '}),/Both append strings/);
  assert.equal(cardDigest(await f.store.snapshot()),cardDigest(f.state));
  assert.throws(()=>createCardReplayRuntime({...f.config,stageVisibility:{...f.config.stageVisibility,cardReadVersions:['v0']}},async()=>{}),/no parent disclosure routes/);
});

test('blind tool rejects extra model fields before mutation',async()=>{
  const f=await fixture();const definitions:any[]=[];
  const runtime=createCardReplayRuntime(f.config,async()=>{});
  registerCardReplayTools({registerTool:(d:any)=>definitions.push(d),on(){}},runtime,join(f.root,'engineering-stop.json'));
  await assert.rejects(definitions[0].execute('bad',{promptAppend:'A',badCaseAppend:'B',systemPrompt:'replacement'}),/Invalid expert_card_append fields/);
  assert.equal(cardDigest(await runtime.store.snapshot()),cardDigest(f.state));
});
