import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Check} from 'typebox/value';
import {createCardReplayRuntime,registerCardReplayTools} from '../src/expert-card-replay-runtime.js';
import {ALIGNER_ROLE as roleId,cardDigest} from '../src/expert-card-copy-store.js';
import {createObservationReceipt,projectSettledExpertObservation,writeObservationReceipt} from '../src/expert-card-trial-evidence.js';

test('stage visibility closes inventory, resolution, version and Card-parent bypasses',async()=>{
  const root=await mkdtemp(join(tmpdir(),'stage-visibility-')),safe=join(root,'safe.txt'),hidden=join(root,'hidden.txt'),budget=join(root,'budget');
  await writeFile(safe,'SAFE RECEIPT');await writeFile(hidden,'HIDDEN HISTORY SENTINEL');await import('node:fs/promises').then(fs=>fs.mkdir(budget));await writeFile(join(budget,'provider-budget.json'),JSON.stringify({inFlight:{},blocked:null,accountingUnknown:null}));
  const source={roleId,systemPrompt:'CARD SENTINEL'};
  const seed=createCardReplayRuntime({root,source,storeOptions:{maxUpdates:2},evidence:{sessions:{old:'SESSION SENTINEL'},artifacts:{safe:{path:safe,sha256:cardDigest('SAFE RECEIPT')},hidden:{path:hidden,sha256:cardDigest('HIDDEN HISTORY SENTINEL')}},defaultArtifacts:{old:'hidden'}}},async()=>{});
  const v0=await seed.card({action:'create',roleId});const v1=await seed.card({action:'update',roleId,parentVersion:'v0',systemPrompt:'AUTHORIZED PARENT',reason:'seed'});
  const authorization={id:'scoped-stage',allowedNewVersions:['v2'],originVersions:{v0:v0.digest,v1:v1.digest},requireReadyForTrial:true,allowConfirmation:false};
  const runtime=createCardReplayRuntime({root,source,generationOnly:true,defaultCardVersion:'v1',storeOptions:{maxUpdates:2,reviewedCopies:{},trialAuthorization:authorization},settledTrialEvidence:{root,budgetRoot:budget,phasePrefix:'never',baselineRequestPath:hidden,sourcePrompt:'CARD SENTINEL'},evidence:{sessions:{old:'SESSION SENTINEL'},artifacts:{safe:{path:safe,sha256:cardDigest('SAFE RECEIPT')},hidden:{path:hidden,sha256:cardDigest('HIDDEN HISTORY SENTINEL')}},defaultArtifacts:{old:'hidden'}},stageVisibility:{artifactIds:['safe'],cardReadVersions:['v1'],updateParentVersions:['v1'],versionIds:[],sessionIds:[],allowDynamicArtifacts:false,allowVersionBundles:false}},async()=>{});
  const inventory:any=await runtime.evidence({kind:'inventory'}),serialized=JSON.stringify(inventory);
  assert.deepEqual(inventory.artifacts,['safe']);assert.deepEqual(inventory.defaultArtifacts,{});assert(!serialized.includes('HIDDEN HISTORY SENTINEL'));assert(!serialized.includes('CARD SENTINEL'));assert(!serialized.includes('v0/version-bundle'));assert(!serialized.includes('originVersions'));
  assert.deepEqual(inventory.cardAccess,{tool:'expert_card_copy',readAction:'read',allowedReadVersions:['v1'],defaultReadVersion:'v1',evidenceVersionKindAvailable:false,instruction:'Read an allowed Card with expert_card_copy action=read and version=<allowedReadVersion>. Do not use expert_evidence kind=version when evidenceVersionKindAvailable is false.'});
  assert.equal((await runtime.evidence({kind:'artifact',id:'safe'})).raw,'SAFE RECEIPT');
  for(const args of [{kind:'artifact',id:'old'},{kind:'artifact',id:'hidden'},{kind:'artifact',id:'v1'},{kind:'artifact',id:'v1/version-bundle.json'},{kind:'artifact',id:'v1s1'},{kind:'version',id:'v1'}] as const)await assert.rejects(runtime.evidence(args as any),/outside stage visibility/);
  assert.equal((await runtime.card({action:'read',roleId,version:'v1'})).digest,v1.digest);
  assert.throws(()=>runtime.card({action:'read',roleId,version:'v0'}),/outside stage visibility/);
  assert.throws(()=>runtime.card({action:'update',roleId,parentVersion:'v0',skill:'x',reason:'bad'}),/outside stage visibility/);
  const registered:any[]=[],handlers:Record<string,any>={};registerCardReplayTools({registerTool:(x:any)=>registered.push(x),on:(n:string,f:any)=>handlers[n]=f,setActiveTools(){}},runtime,join(root,'stop.json'));
  const evidenceTool=registered.find(x=>x.name==='expert_evidence'),cardTool=registered.find(x=>x.name==='expert_card_copy');
  assert(!JSON.stringify(evidenceTool.parameters).includes('version'));assert.equal(Check(evidenceTool.parameters,{kind:'version',id:'v1'}),false);assert.match(evidenceTool.description,/does not support kind=version/);assert.match(evidenceTool.description,/expert_card_copy/);assert.match(cardTool.description,/Read may omit version/);
  const updated=await registered.find(x=>x.name==='expert_card_copy').execute('update',{action:'update',parentVersion:'v1',skill:'scoped change',reason:'local shadow',readyForTrial:true});
  assert.equal(JSON.parse(updated.content[0].text).version,'v2');assert.equal((await readFile(join(root,'candidate-review-pause.json'),'utf8')).includes(v1.digest),false);
  assert.deepEqual(Object.keys((await seed.store.snapshot()).runs),[]);
});

test('observation receipts preserve raw text, limit citations to reads, and express uncertainty',async()=>{
  const source='A complete source passage with an exact quote.';
  const projected=projectSettledExpertObservation({runId:'v1s1',requestId:'252',request:{messages:[{role:'system',content:'SYSTEM CARD SENTINEL'},{role:'user',content:'LOCAL PAIR WITH BOTH SIDES'}],temperature:0},rawOutput:'RAW EXPERT OUTPUT'});
  const text=JSON.stringify(projected);assert(text.includes('LOCAL PAIR WITH BOTH SIDES'));assert(text.includes('RAW EXPERT OUTPUT'));assert(!text.includes('SYSTEM CARD SENTINEL'));assert.equal(projected.epistemicStatus,'not-gold');
  const input={observationText:'S1 ORIGINAL TEXT',sources:{source:{raw:source,sha256:cardDigest(source),scope:'cached full source'},unread:{raw:'UNREAD',sha256:cardDigest('UNREAD'),scope:'not selected'}},actualReadIds:['source'],citations:[{sourceId:'source',quotedText:'exact quote'}],uncertainties:['The local projection omits the Card, so cause is insufficiently observed.']};
  const receipt=createObservationReceipt(input);assert.equal(receipt.observationText,'S1 ORIGINAL TEXT');assert.equal(receipt.epistemicStatus,'model-observation-not-gold');assert.equal(receipt.uncertainties.length,1);assert(!JSON.stringify(receipt).includes('UNREAD'));
  await assert.rejects(async()=>createObservationReceipt({...input,citations:[{sourceId:'unread',quotedText:'UNREAD'}]}),/not actually read/);
  await assert.rejects(async()=>createObservationReceipt({...input,citations:[{sourceId:'source',quotedText:'invented'}]}),/not an exact substring/);
  assert.throws(()=>createObservationReceipt({...input,expectedMatched:true} as any),/Forbidden observation field/);
  const path=join(await mkdtemp(join(tmpdir(),'receipt-')),'receipt.json');const frozen=writeObservationReceipt(path,input);writeObservationReceipt(path,input);assert.equal(frozen.sha256,cardDigest(await readFile(path,'utf8')));
  assert.throws(()=>writeObservationReceipt(path,{...input,observationText:'changed'}),/already differs/);
});
