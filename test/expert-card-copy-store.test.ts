import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createExpertCardCopyStore,applyCardCopy} from '../src/expert-card-copy-store.js';
test('isolated Card copies bind actual prompt and idempotent executions across recovery',async()=>{
 const root=await mkdtemp(join(tmpdir(),'expert-copy-'));const source={roleId:'refine.evidence-aligner',systemPrompt:'ORIGINAL'};const original=JSON.stringify(source);let count=0;
 const execute=async(copy:any)=>{count++;return{system:applyCardCopy('ORIGINAL\nSUFFIX','ORIGINAL',copy),matched:false};};
 const options={receipt:async()=>({status:'settled' as const,requestId:'test',costUsd:0,totalTokens:1,parsed:true})};
 const store=createExpertCardCopyStore(root,source,execute,options);await store.card({action:'create',roleId:source.roleId});
 await assert.rejects(store.card({action:'read',roleId:'refine.aspect-matcher',version:'v0'}),/Role/);
 await assert.rejects(store.card({action:'read',roleId:source.roleId,version:'../outside'}),/Unknown/);
 const update={action:'update' as const,roleId:source.roleId,version:'v0',systemPrompt:'MODEL COPY',skill:'MODEL SKILL',reason:'experiment'};
 const copy=await store.card(update);assert.equal(copy.version,'v1');assert.equal((await store.card(update)).version,'v1');
 const result=await store.replay({roleId:source.roleId,version:'v1',runId:'trial1'});assert.equal(result.value.system,'MODEL COPY\n\n实验副本配套 Skill：\nMODEL SKILL\nSUFFIX');
 const resumed=createExpertCardCopyStore(root,source,execute,options);const replay=await resumed.replay({roleId:source.roleId,version:'v1',runId:'trial1'});assert.equal(replay.delivery,'cached-existing');assert.equal(count,1);
 const copy2=await resumed.card({...update,version:'v1',systemPrompt:'SECOND'});assert.notEqual(copy.digest,copy2.digest);
 await assert.rejects(resumed.replay({roleId:source.roleId,version:'v2',runId:'trial1'}),/another version/);
 await assert.rejects(resumed.card({...update,version:'v2',systemPrompt:'THIRD'}),/quota/);
 assert.equal(JSON.stringify(source),original);assert.equal(JSON.parse(await readFile(join(root,'state.json'),'utf8')).updates,2);
});
test('failed paid execution is not silently repeated',async()=>{
 const root=await mkdtemp(join(tmpdir(),'expert-copy-fail-'));let count=0;const source={roleId:'refine.evidence-aligner',systemPrompt:'original'};const execute=async()=>{count++;throw Error('saved failure');};const options={receipt:async()=>({status:'settled' as const,requestId:'test',costUsd:0,totalTokens:1,parsed:false})};const store=createExpertCardCopyStore(root,source,execute,options);
 await store.card({action:'create',roleId:source.roleId});assert.equal((await store.replay({roleId:source.roleId,version:'v0',runId:'baseline'})).status,'settled-parse-failure');
 assert.equal((await createExpertCardCopyStore(root,source,execute,options).replay({roleId:source.roleId,version:'v0',runId:'baseline'})).delivery,'cached-existing');assert.equal(count,1);
});
