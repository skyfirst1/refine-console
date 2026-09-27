import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Check} from 'typebox/value';
import {createExpertCardCopyStore,ALIGNER_ROLE as roleId,cardDigest} from '../src/expert-card-copy-store.js';
import {createCardReplayRuntime,registerCardReplayTools} from '../src/expert-card-replay-runtime.js';
async function fixture(allowConfirmation?:boolean){
 const root=await mkdtemp(join(tmpdir(),'trial-authority-')),copies=join(root,'copies'),budget=join(root,'budget'),source={roleId,systemPrompt:'base'};await mkdir(budget);const ledgerPath=join(budget,'provider-budget.json');await writeFile(ledgerPath,JSON.stringify({inFlight:{}}));let calls=0;
 const execute=async()=>{calls++;return{offlineFixture:true};},receipt=async(id:string)=>({status:'settled' as const,requestId:id,costUsd:0,totalTokens:1,parsed:true});
 const options={maxUpdates:6,sampleCount:2,confirmationCount:2,requirePriorBatch:true,allowUnstartedDraftCompletion:true,assertDraftAccountingClear:async()=>{},executionBinding:'offline-fixture',receipt};
 const old=createExpertCardCopyStore(copies,source,execute,options);await old.card({action:'create',roleId});await old.sample({roleId,version:'v0'});
 for(const parentVersion of ['v0','v1']){const v=await old.card({action:'update',roleId,parentVersion,systemPrompt:'prior '+parentVersion,reason:'setup'});await old.sample({roleId,version:v.version});}
 await old.card({action:'update',roleId,parentVersion:'v0',systemPrompt:'old unstarted draft',reason:'setup'});await old.card({action:'update',roleId,parentVersion:'v3',systemPrompt:'old complete',reason:'setup'});await old.sample({roleId,version:'v4'});
 const origin=await old.snapshot(),trialAuthorization={id:'phase-new',allowedNewVersions:['v5','v6'],originVersions:Object.fromEntries(Object.entries(origin.versions).map(([id,c])=>[id,c.digest])),requireReadyForTrial:true,...(allowConfirmation!==undefined?{allowConfirmation}:{})};
 const runtime=createCardReplayRuntime({root,source,defaultCardVersion:'v0',storeOptions:{...options,trialAuthorization},evidence:{sessions:{},artifacts:{},defaultArtifacts:{}},settledTrialEvidence:{budgetRoot:budget} as any},execute),tools:any[]=[],handlers:any={};
 registerCardReplayTools({registerTool:(t:any)=>tools.push(t),on:(n:string,h:any)=>handlers[n]=h},runtime,join(root,'stop.json'));
 const baselineCalls=calls;return{root,copies,ledgerPath,origin,runtime,trial:tools.find(t=>t.name==='expert_trial'),card:tools.find(t=>t.name==='expert_card_copy'),handlers,calls:()=>calls-baselineCalls,writeState:async(s:any)=>writeFile(join(copies,'state.json'),JSON.stringify(s)),update:{action:'update' as const,roleId,parentVersion:'v0',systemPrompt:'fixture complete candidate',skill:'fixture explanation',reason:'offline complete',readyForTrial:true}};
}
test('exact real215 sample-batch JSON rejects superseded draft and hard-stops before another provider',async()=>{
 const f=await fixture(),failure=JSON.parse(await readFile(new URL('./fixtures/expert-trial-superseded-batch.json',import.meta.url),'utf8'));assert(Check(f.trial.parameters,failure.event.args));
 await assert.rejects(f.trial.execute(failure.event.toolCallId,failure.event.args),/Superseded/);assert.equal(f.calls(),0);assert.deepEqual(await f.runtime.store.snapshot(),f.origin);
 let aborted=false;assert.throws(()=>f.handlers.before_provider_request({}, {abort(){aborted=true;}}),/Engineering stop/);assert(aborted);await assert.rejects(f.card.execute('later',f.update),/Engineering stop/);
});
test('all old versions reject NEW batch requests and confirmation/freeze; settled identities only return cached results',async()=>{
 for(const version of ['v0','v1','v2','v3','v4']){const f=await fixture();for(const action of ['freeze','confirm'] as const)await assert.rejects(f.runtime.store[action]({roleId,version,selectionId:'new-selection'}),/authorization|Superseded/);
 if(version!=='v3'){const result=await f.runtime.store.sample({roleId,version});assert(result.every(r=>r.delivery==='cached-existing'));}
 const state=await f.runtime.store.snapshot();for(const [id,r]of Object.entries(state.runs))if(r.version===version)delete state.runs[id];await f.writeState(state);
 await assert.rejects(f.trial.execute('new-old-batch',{action:'sample',version}),/authorization|Superseded/);assert.equal(f.calls(),0);assert.deepEqual((await f.runtime.store.snapshot()).freezes,{});
 }
 const f=await fixture();await assert.rejects(f.trial.execute('tool-confirm',{action:'confirm',version:'v0',selectionId:'bypass'}),/authorization/);assert.equal(f.calls(),0);
});
test('one complete submission executes exactly two identities, then recovery is paid-idempotent and old state is immutable',async()=>{
 const f=await fixture();assert(Check(f.card.parameters,f.update));const copy=await f.runtime.store.card(f.update),state=await f.runtime.store.snapshot();assert.equal(copy.version,'v5');assert.equal(state.trialSubmissions?.v5?.copyDigest,copy.digest);assert.equal(state.trialSubmissions?.v5?.readyForTrial,true);
 const result=JSON.parse((await f.trial.execute('batch',{action:'sample',version:'v5'})).content[0].text);assert.equal(result.length,2);assert.equal(f.calls(),2);
 assert.deepEqual(await f.runtime.store.card(f.update),copy);assert((await f.runtime.store.sample({roleId,version:'v5'})).every(r=>r.delivery==='cached-existing'));assert.equal(f.calls(),2);assert.equal((await f.runtime.store.quota()).remainingUpdates,1);
 const after=await f.runtime.store.snapshot();for(const [id,c]of Object.entries(f.origin.versions))assert.deepEqual(after.versions[id],c);for(const [id,r]of Object.entries(f.origin.runs))assert.deepEqual(after.runs[id],r);
});
test('draft is nonexecutable; its immutable complete successor consumes final slot and supersedes it without trials',async()=>{
 const f=await fixture(),{readyForTrial,...draftArgs}=f.update,draft=await f.runtime.store.card(draftArgs);await assert.rejects(f.runtime.store.sample({roleId,version:draft.version}),/unsubmitted draft/);
 await assert.rejects(f.runtime.store.card(f.update),/Immutable submission/);
 const full={...f.update,parentVersion:'v5',systemPrompt:'complete successor with all fixture materials'};const v6=await f.runtime.store.card(full);assert.equal(v6.version,'v6');await assert.rejects(f.runtime.store.sample({roleId,version:'v5'}),/Superseded/);assert.equal(f.calls(),0);
 await f.runtime.store.sample({roleId,version:'v6'});assert.equal(f.calls(),2);assert.equal((await f.runtime.store.quota()).remainingUpdates,0);assert.deepEqual(await f.runtime.store.card(full),v6);assert.equal((await f.runtime.store.snapshot()).versions.v5?.digest,draft.digest);
});
test('unknown/running state and bound budget inFlight/unknown/block all prevent paid execution',async()=>{
 for(const status of ['unknown','running']){const f=await fixture(),v=await f.runtime.store.card(f.update),s=await f.runtime.store.snapshot();s.runs.v5s1={runId:'v5s1',version:'v5',copyDigest:v.digest,producerBinding:cardDigest({execution:'offline-fixture',copyDigest:v.digest}),status:status as any};await f.writeState(s);await assert.rejects(f.trial.execute('unknown',{action:'sample',version:'v5'}),/unknown or running/);assert.equal(f.calls(),0);}
 for(const ledger of [{inFlight:{999:{}}},{inFlight:{},accountingUnknown:{reason:'fixture'}},{inFlight:{},blocked:{reason:'fixture'}}]){const f=await fixture();await f.runtime.store.card(f.update);await writeFile(f.ledgerPath,JSON.stringify(ledger));await assert.rejects(f.trial.execute('accounting',{action:'sample',version:'v5'}),/accounting is not clear/);assert.equal(f.calls(),0);assert(!(await f.runtime.store.snapshot()).runs.v5s1);}
});
test('origin/digest/authorization/role/path boundaries cannot be bypassed by sample or freeze',async()=>{
 for(const change of ['origin','submission']){const f=await fixture();await f.runtime.store.card(f.update);const s=await f.runtime.store.snapshot();if(change==='origin'){const{digest,...body}=s.versions.v0!;body.systemPrompt='changed origin';s.versions.v0={...body,digest:cardDigest(body)};}else s.trialSubmissions!.v5!.authorizationId='another';await f.writeState(s);await assert.rejects(f.runtime.store.sample({roleId,version:'v5'}),/origin changed|not bound/);assert.equal(f.calls(),0);}
 const f=await fixture();await f.runtime.store.card(f.update);await assert.rejects(f.runtime.store.sample({roleId:'wrong',version:'v5'}),/Role/);await assert.rejects(f.runtime.store.sample({roleId,version:'../v5'}),/Unknown/);await assert.rejects(f.runtime.store.sample({roleId,version:'v99'}),/Unknown/);assert.equal(f.calls(),0);
});
test('explicit confirmation prohibition covers freeze, confirm, direct pending replay; old settled confirmation remains read-only',async()=>{
 const f=await fixture(false),copy=await f.runtime.store.card(f.update);await f.runtime.store.sample({roleId,version:'v5'});
 for(const action of ['freeze','confirm'] as const)await assert.rejects(f.runtime.store[action]({roleId,version:'v5',selectionId:'new'}),/forbids new confirmation/);assert.deepEqual((await f.runtime.store.snapshot()).freezes,{});
 const s=await f.runtime.store.snapshot();s.freezes.historical={version:'v5',copyDigest:copy.digest,runIds:['historical-confirm1','historical-confirm2']};const run={runId:'historical-confirm1',version:'v5',copyDigest:copy.digest,producerBinding:cardDigest({execution:'offline-fixture',copyDigest:copy.digest}),status:'settled-success' as const,receipt:{status:'settled' as const,requestId:'fixture-old-paid',costUsd:0,totalTokens:1,parsed:true}};s.runs[run.runId]=run;await f.writeState(s);
 assert.equal((await f.runtime.store.replay({roleId,version:'v5',runId:run.runId})).delivery,'cached-existing');await assert.rejects(f.runtime.store.replay({roleId,version:'v5',runId:'historical-confirm2'}),/forbids new confirmation/);
 await assert.rejects(f.trial.execute('confirm',{action:'confirm',version:'v5',selectionId:'historical'}),/forbids new confirmation/);assert.equal(f.calls(),2);let aborted=false;assert.throws(()=>f.handlers.before_provider_request({}, {abort(){aborted=true;}}),/Engineering stop/);assert(aborted);
 const allowed=await fixture(true);await allowed.runtime.store.card(allowed.update);await allowed.runtime.store.sample({roleId,version:'v5'});await allowed.runtime.store.confirm({roleId,version:'v5',selectionId:'allowed'});assert.equal(allowed.calls(),4);
});
