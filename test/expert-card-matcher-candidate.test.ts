import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cardDigest,createExpertCardCopyStore,MATCHER_ROLE,ALIGNER_ROLE} from '../src/expert-card-copy-store.js';
import {createCardReplayRuntime,registerCardReplayTools,type ReplayRuntimeConfig} from '../src/expert-card-replay-runtime.js';

test('Matcher opt-in is immutable blind append only; all execution routes and cross-role access fail',async()=>{
 const root=await mkdtemp(join(tmpdir(),'matcher-candidate-')),source={roleId:MATCHER_ROLE,systemPrompt:'PRIVATE_MATCHER_PARENT'},options={candidateOnlyRole:MATCHER_ROLE,sampleCount:0,confirmationCount:0,maxUpdates:1,reviewedCopies:{}};
 let executed=0;const execute=async()=>{executed++;throw Error('Execution forbidden');};
 const store=createExpertCardCopyStore(join(root,'copies'),source,execute,options),parent=await store.card({action:'create',roleId:MATCHER_ROLE});
 assert.equal(parent.roleId,MATCHER_ROLE);
 await assert.rejects(store.card({action:'read',roleId:ALIGNER_ROLE,version:'v0'}),/Role is not allowed/);
 await assert.rejects(store.card({action:'update',roleId:MATCHER_ROLE,parentVersion:'v0',systemPrompt:'replacement',reason:'x'}),/not replacement/);
 await assert.rejects(store.replay({roleId:MATCHER_ROLE,version:'v0',runId:'baseline1'}),/forbids execution/);
 await assert.rejects(store.sample({roleId:MATCHER_ROLE,version:'v0'}),/forbids execution/);
 await assert.rejects(store.freeze({roleId:MATCHER_ROLE,version:'v0',selectionId:'s'}),/forbids execution/);
 await assert.rejects(store.confirm({roleId:MATCHER_ROLE,version:'v0',selectionId:'s'}),/forbids execution/);
 const config:ReplayRuntimeConfig={root,source,storeOptions:options,generationOnly:true,modificationToolContract:'blind-append-v1',blindAppendBinding:{parentVersion:'v0',parentDigest:parent.digest,startStateSha256:cardDigest(await store.snapshot())},stageVisibility:{artifactIds:[],sessionIds:[],versionIds:[],cardReadVersions:[],updateParentVersions:['v0'],allowCreate:false,allowDynamicArtifacts:false,allowVersionBundles:false},evidence:{sessions:{},artifacts:{},defaultArtifacts:{}}};
 assert.throws(()=>createCardReplayRuntime({...config,generationOnly:false},execute),/only explicit blind/);
 assert.throws(()=>createCardReplayRuntime({...config,modificationToolContract:'legacy'},execute),/only explicit blind/);
 const runtime=createCardReplayRuntime(config,execute),definitions:any[]=[];
 registerCardReplayTools({registerTool:(d:any)=>definitions.push(d),on(){},setActiveTools(){}},runtime,join(root,'stop.json'));
 assert.deepEqual(definitions.map(d=>d.name),['expert_card_append']);assert.equal(Buffer.byteLength(JSON.stringify(definitions[0].parameters)),200);
 const result=await definitions[0].execute('a',{promptAppend:'GENERAL',badCaseAppend:'INPUT -> OUTPUT'});
 assert(!JSON.stringify(result).includes('PRIVATE_MATCHER_PARENT'));
 const child=await store.card({action:'read',roleId:MATCHER_ROLE,version:'v1'});assert.equal(child.roleId,MATCHER_ROLE);assert.equal(child.systemPrompt,'PRIVATE_MATCHER_PARENT\n\nGENERAL\n\nINPUT -> OUTPUT');assert.equal((await store.card({action:'read',roleId:MATCHER_ROLE,version:'v0'})).digest,parent.digest);
 await assert.rejects(definitions[0].execute('b',{promptAppend:'X',badCaseAppend:'Y'}),/Planned candidate review pause/);assert.equal(executed,0);
});

test('default store still rejects Matcher and candidate opt-in cannot impersonate Aligner',async()=>{
 const root=await mkdtemp(join(tmpdir(),'matcher-default-'));
 const source={roleId:MATCHER_ROLE,systemPrompt:'private'},store=createExpertCardCopyStore(root,source,async()=>null);
 await assert.rejects(store.card({action:'create',roleId:MATCHER_ROLE}),/Role is not allowed/);
 assert.throws(()=>createExpertCardCopyStore(root,{...source,roleId:ALIGNER_ROLE},async()=>null,{candidateOnlyRole:MATCHER_ROLE,sampleCount:0,confirmationCount:0}),/zero execution authority/);
 assert.throws(()=>createExpertCardCopyStore(root,source,async()=>null,{candidateOnlyRole:MATCHER_ROLE,sampleCount:1,confirmationCount:0}),/zero execution authority/);
});
