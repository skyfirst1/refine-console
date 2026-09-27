import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {assessReplayDelta,beginReplayAssessment,finishReplayAssessment} from '../src/expert-card-replay-completion.js';
import {ALIGNER_ROLE,cardDigest,type CopyState} from '../src/expert-card-copy-store.js';
import {settledTrialArtifacts} from '../src/expert-card-trial-evidence.js';

const initial=():CopyState=>({sourceBinding:'source',versions:{},runs:{},updates:0,freezes:{}});
function candidate(s:CopyState,id:string,parent:string|null='v0') {const body={version:id,parent,roleId:ALIGNER_ROLE,systemPrompt:id,skill:'',reason:'hypothesis'};s.versions[id]={...body,digest:cardDigest(body)};}
function run(s:CopyState,id:string,v:string,parsed=true) {s.runs[id]={runId:id,version:v,copyDigest:s.versions[v]!.digest,producerBinding:'input',status:parsed?'settled-success':'settled-parse-failure'};}
const assess=(a:CopyState,b:CopyState,verified:string[]=[],feedback:string[]=[])=>assessReplayDelta(a,b,3,new Set(verified),new Set(feedback));
const structuredCase=()=>({syntheticTaskRequirement:'independent fixture',mode:'content' as const,sourceAspect:{id:'s',title:'source',description:'fixture',evidences:[{quote:'complete source fixture',location:'source'}]},targetAspect:{id:'t',title:'target',description:'fixture',evidences:[{quote:'complete target fixture',location:'target'}]},expectedMatched:true,evidenceRationale:[{side:'source' as const,evidenceIndex:0,quotedText:'source',explanation:'fixture mapping'},{side:'target' as const,evidenceIndex:0,quotedText:'target',explanation:'fixture mapping'}],whyBoundaryApplies:'fixture boundary',scope:'fixture only'});

test('historical versions and 22 historical attempts never satisfy this invocation',()=>{
  const s=initial();candidate(s,'v0',null);for(let i=0;i<22;i++)run(s,'old'+i,'v0');
  s.freezes.old={version:'v0',copyDigest:s.versions.v0!.digest,runIds:['old0','old1']};
  const result=assess(s,structuredClone(s),Object.keys(s.runs),Object.keys(s.runs));
  assert.equal(result.newAttemptCount,0);assert.equal(result.newCandidateCount,0);assert.equal(result.executionStatus,'incomplete');assert.equal(result.objectiveStatus,'objective-not-achieved');assert.deepEqual(result.newSelections,[]);
});
test('partial batch and fake receipts cannot complete live evidence; parse failures count as attempts only',()=>{
  const a=initial();candidate(a,'v0',null);const b=structuredClone(a);candidate(b,'v1');run(b,'v1s1','v1');
  assert.equal(assess(a,b).batches[0]!.attemptedBatchCompleted,false);
  run(b,'v1s2','v1',false);run(b,'v1s3','v1');
  const ids=Object.keys(b.runs);let result=assess(a,b);
  assert.equal(result.batches[0]!.attemptedBatchCompleted,true);assert.equal(result.batches[0]!.successfulSamples,2);assert.equal(result.batches[0]!.parseFailures,1);assert.equal(result.executionStatus,'incomplete');
  result=assess(a,b,ids);assert.equal(result.executionStatus,'incomplete');
  result=assess(a,b,ids,ids);assert.equal(result.executionStatus,'live-loop-evidence-recorded');assert.equal(result.objectiveStatus,'objective-not-achieved');assert.equal(result.qualityStatus,'not-assessed');
});
test('historical mutation invalidates even otherwise complete action evidence',()=>{
  const a=initial();candidate(a,'v0',null);const b=structuredClone(a);candidate(b,'v1');for(let i=1;i<=3;i++)run(b,'v1s'+i,'v1');b.versions.v0!.reason='rewritten';
  const ids=Object.keys(b.runs);assert.equal(assess(a,b,ids,ids).executionStatus,'incomplete');
});
test('few-shot-only change is effective while undefined and empty cases are semantically equal',()=>{
  const a=initial();candidate(a,'v0',null);const b=structuredClone(a);const body={version:'v1',parent:'v0',roleId:ALIGNER_ROLE,systemPrompt:'v0',skill:'',reason:'structured',fewShotCases:[structuredCase()]};b.versions.v1={...body,digest:cardDigest(body)};b.updates=1;
  assert.equal(assess(a,b).newEffectiveCandidateCount,1);
  const c=structuredClone(a),empty={version:'v1',parent:'v0',roleId:ALIGNER_ROLE,systemPrompt:'v0',skill:'',reason:'empty',fewShotCases:[]};c.versions.v1={...empty,digest:cardDigest(empty)};c.updates=1;
  assert.equal(assess(a,c).newCandidateCount,1);assert.equal(assess(a,c).newEffectiveCandidateCount,0);
});

function generationFixture(kind:'valid'|'stale'|'wrong-digest'|'not-ready'|'no-update') {
  const root=mkdtempSync(resolve(tmpdir(),'generation-completion-')),copies=resolve(root,'copies');mkdirSync(copies);
  const state=initial();candidate(state,'v0',null);writeFileSync(resolve(copies,'state.json'),JSON.stringify(state));writeFileSync(resolve(root,'provider-budget.json'),JSON.stringify({requests:1,inFlight:{},accountingUnknown:null,blocked:null}));
  const authorization={id:'generate-v1',allowedNewVersions:['v1'],originVersions:{v0:state.versions.v0!.digest},requireReadyForTrial:true,allowConfirmation:false};
  const config:any={sessionOutputRoot:root,budgetRoot:root,runtime:{root,generationOnly:true,source:{roleId:ALIGNER_ROLE,systemPrompt:'source'},storeOptions:{sampleCount:3,reviewedCopies:{},trialAuthorization:authorization}}};
  const pausePath=resolve(root,'candidate-review-pause.json');if(kind==='stale')writeFileSync(pausePath,JSON.stringify({kind:'planned-candidate-review-pause'}));
  const checkpoint=beginReplayAssessment(config,'generation');
  if(kind!=='no-update'){
    const end=structuredClone(state),body={version:'v1',parent:'v0',roleId:ALIGNER_ROLE,systemPrompt:'v0',skill:'',reason:'few-shot only',fewShotCases:[structuredCase()]};end.versions.v1={...body,digest:cardDigest(body)};end.updates=1;end.trialSubmissions={v1:{authorizationId:authorization.id,authorizationDigest:cardDigest(authorization),copyDigest:end.versions.v1.digest,readyForTrial:kind!=='not-ready'}};writeFileSync(resolve(copies,'state.json'),JSON.stringify(end));
    if(kind!=='stale')writeFileSync(pausePath,JSON.stringify({kind:'planned-candidate-review-pause',version:'v1',copyDigest:kind==='wrong-digest'?'bad':end.versions.v1.digest,fewShotCasesSha256:cardDigest(end.versions.v1.fewShotCases)}));
  }
  const events=resolve(root,'events.jsonl');writeFileSync(events,JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'claimed complete'}]}})+'\n');
  return finishReplayAssessment(config,checkpoint,events);
}
test('generation completion requires a new authorized ready candidate and its matching fresh pause',()=>{
  const valid:any=generationFixture('valid');assert.equal(valid.executionStatus,'candidate-saved-awaiting-review');assert.equal(valid.generation.automaticRetry,false);assert.equal(valid.generation.checks.pauseMatches,true);assert.equal(valid.newVerifiedLiveAttempts,0);
  for(const kind of ['stale','wrong-digest','not-ready','no-update'] as const){const result:any=generationFixture(kind);assert.equal(result.executionStatus,'generation-incomplete',kind);assert.equal(result.generation.automaticRetry,false);}
});
test('separated modification accepts only a fresh bound no-change receipt, never prose alone',()=>{
  const fixture=(writeReceipt:boolean,wrong=false,wrongStart=false)=>{const root=mkdtempSync(resolve(tmpdir(),'no-change-completion-')),copies=resolve(root,'copies');mkdirSync(copies);const state=initial();candidate(state,'v0',null);writeFileSync(resolve(copies,'state.json'),JSON.stringify(state));writeFileSync(resolve(root,'provider-budget.json'),JSON.stringify({requests:1,inFlight:{},accountingUnknown:null,blocked:null}));const observationReceiptSha256='a'.repeat(64),parentDigest=state.versions.v0!.digest;const config:any={sessionOutputRoot:root,budgetRoot:root,runtime:{root,generationOnly:true,separatedModificationDecision:{observationReceiptSha256,parentVersion:'v0',parentDigest,...(wrongStart?{startStateSha256:'f'.repeat(64)}:{})},source:{roleId:ALIGNER_ROLE,systemPrompt:'source'},storeOptions:{sampleCount:3,reviewedCopies:{},trialAuthorization:{id:'unused',allowedNewVersions:['v1'],originVersions:{v0:parentDigest}}}}};const checkpoint=beginReplayAssessment(config,'decision');if(writeReceipt)writeFileSync(resolve(root,'modification-no-change-receipt.json'),JSON.stringify({kind:'separated-modification-no-change',observationReceiptSha256:wrong?'b'.repeat(64):observationReceiptSha256,parentVersion:'v0',parentDigest,reason:'ORIGINAL REASON',at:new Date().toISOString()}));const events=resolve(root,'events.jsonl');writeFileSync(events,JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'No change is needed'}]}})+'\n');return finishReplayAssessment(config,checkpoint,events);};
  const valid:any=fixture(true);assert.equal(valid.executionStatus,'no-change-decision-recorded');assert.equal(valid.generation.reason,'ORIGINAL REASON');assert.equal(valid.generation.checks.noChangeReceiptValid,true);assert.equal(fixture(false).executionStatus,'generation-incomplete');assert.equal(fixture(true,true).executionStatus,'generation-incomplete');assert.equal(fixture(true,false,true).executionStatus,'generation-incomplete');
});
test('durable final assessment records zero action and errors without trusting final text',()=>{
  const root=mkdtempSync(resolve(tmpdir(),'completion-'));
  writeFileSync(resolve(root,'provider-budget.json'),JSON.stringify({requests:174,inFlight:{},usage:{costUsd:0}}));
  const config={runtime:{root,source:{roleId:ALIGNER_ROLE,systemPrompt:'source'},storeOptions:{sampleCount:3}},budgetRoot:root};
  const checkpoint=beginReplayAssessment(config,'session');
  assert.throws(()=>beginReplayAssessment(config,'session'),/EEXIST/);
  const events=resolve(root,'events.jsonl');writeFileSync(events,JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'I completed the live experiment'}]}})+'\n');
  const result=finishReplayAssessment(config,checkpoint,events,new Error('runner stopped'));
  assert.equal(result.objectiveStatus,'objective-not-achieved');assert.equal(result.executionStatus,'incomplete');assert.equal(result.newVerifiedLiveAttempts,0);assert.equal(JSON.parse(readFileSync(result.assessmentPath,'utf8')).executionError,'Error: runner stopped');
});

test('producer evidence and a later settled Harness delivery are both required; loopback remains fake',()=>{
  const root=mkdtempSync(resolve(tmpdir(),'completion-proof-'));
  const write=(path:string,value:any)=>writeFileSync(path,JSON.stringify(value));
  const a=initial();candidate(a,'v0',null);mkdirSync(resolve(root,'copies'));write(resolve(root,'copies/state.json'),a);
  write(resolve(root,'provider-budget.json'),{requests:10,inFlight:{}});
  const baselinePath=resolve(root,'baseline.json'),baseline={model:'fixture',max_tokens:8000,messages:[{role:'system',content:'v0'},{role:'user',content:'input'}]};write(baselinePath,baseline);
  const config:any={phase:'harness',runtime:{root,source:{roleId:ALIGNER_ROLE,systemPrompt:'source'},storeOptions:{sampleCount:3,executionBinding:'fixed'}},budgetRoot:root,expertExecution:{root,budgetRoot:root,phasePrefix:'expert',providerOrigin:'https://fixture.invalid',baselineRequestPath:baselinePath,sourcePrompt:'v0'}};
  const checkpoint=beginReplayAssessment(config,'proof');
  const b=structuredClone(a);candidate(b,'v1');const events:any[]=[];
  for(let i=1;i<=3;i++) {
    const id='v1s'+i,request=10+i;run(b,id,'v1');const r=b.runs[id]!;
    r.producerBinding=cardDigest({execution:'fixed',copyDigest:r.copyDigest});r.receipt={status:'settled',requestId:String(request),costUsd:0.01,totalTokens:100,parsed:true};r.value={raw:'valid fixture'};
    const trial=resolve(root,'trials',id);mkdirSync(trial,{recursive:true});
    const payload={...baseline,messages:[{role:'system',content:'v1'},baseline.messages[1]]};write(resolve(trial,'actual-request.json'),payload);write(resolve(root,`provider-request-${String(request).padStart(6,'0')}.json`),payload);
    write(resolve(trial,'actual-options.json'),{systemPrompt:'v1',prompt:'input'});write(resolve(trial,'producer.json'),{version:'v1',copyDigest:r.copyDigest,systemSha256:cardDigest('v1'),promptSha256:cardDigest('input')});write(resolve(trial,'trial-result.json'),r.value);writeFileSync(resolve(trial,'public-output.md'),r.value.raw);
    events.push({type:'admit',id:request,phase:'expert-'+id},{type:'settled',id:request,phase:'expert-'+id,actual:{costUsd:0.01,totalTokens:100}});
  }
  write(resolve(root,'copies/state.json'),b);write(resolve(root,'provider-budget.json'),{requests:14,inFlight:{}});
  const results=Object.values(b.runs),eventPath=resolve(root,'events.jsonl');
  writeFileSync(eventPath,[{type:'tool_execution_end',toolName:'expert_trial',result:{content:[{type:'text',text:JSON.stringify(results)}]}},{type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'feedback'}]}}].map(x=>JSON.stringify(x)).join('\n'));
  const setEvents=()=>writeFileSync(resolve(root,'provider-events.jsonl'),events.map(x=>JSON.stringify(x)).join('\n'));
  setEvents();let result=finishReplayAssessment(config,checkpoint,eventPath);assert.equal(result.newVerifiedLiveAttempts,3);assert.equal(result.executionStatus,'incomplete');
  events.push({type:'admit',id:14,phase:'harness'},{type:'settled',id:14,phase:'harness'});setEvents();write(resolve(root,'provider-request-000014.json'),{messages:[{role:'tool',content:JSON.stringify(results)}]});
  const next=(id:string)=>{const dir=resolve(root,'completion',id);mkdirSync(dir);return {dir,start:checkpoint.start};};
  result=finishReplayAssessment(config,next('with-feedback'),eventPath);assert.equal(result.executionStatus,'live-loop-evidence-recorded');assert.equal(result.objectiveStatus,'objective-not-achieved');
  const registry=settledTrialArtifacts(b,config.expertExecution,'fixed');assert.equal(registry.aliases['v1s3/result.json'],'v1s3/trial-result.json');assert(registry.artifacts['v1s3/trial-result.json']);assert.equal(registry.aliases['unknown/result.json'],undefined);
  const corrupt=structuredClone(b);corrupt.runs.v1s3!.copyDigest='changed';assert.throws(()=>settledTrialArtifacts(corrupt,config.expertExecution,'fixed'));
  const intentionPath=resolve(root,'intention.jsonl');writeFileSync(intentionPath,[{type:'tool_execution_end',toolName:'expert_trial',result:{content:[{type:'text',text:JSON.stringify(results)}]}},{type:'message_end',message:{role:'assistant',stopReason:'toolUse',content:[{type:'text',text:'I will evaluate now'},{type:'toolCall',name:'expert_evidence'}]}}].map(x=>JSON.stringify(x)).join('\n'));
  const intention=finishReplayAssessment(config,next('intention'),intentionPath);assert.equal(intention.batches[0]!.batchResultsDelivered,true);assert.equal(intention.batches[0]!.feedbackCompleted,false);assert.equal(intention.executionStatus,'incomplete');
  config.expertExecution.providerOrigin='http://127.0.0.1:9000';result=finishReplayAssessment(config,next('fake'),eventPath);assert.equal(result.newVerifiedLiveAttempts,0);assert.equal(result.executionStatus,'incomplete');
  config.expertExecution.providerOrigin='https://fixture.invalid';
  const pending=resolve(root,'pending.json'),scope='New authorization: feedback only';
  const pendingMessages=[...baseline.messages,{role:'tool',content:JSON.stringify(results)}];write(pending,{messages:pendingMessages});
  const bind=(path:string)=>({path,sha256:cardDigest(readFileSync(path,'utf8'))});
  const resume={...config,phase:'harness-feedback',runtime:{...config.runtime,feedbackOnly:true},sessionOutputRoot:resolve(root,'resume'),prefix:[...pendingMessages,{role:'user',content:scope}],authorizedContinuationMessage:scope,completionLineage:{originStart:bind(resolve(checkpoint.dir,'start.json')),parentAssessment:bind(resolve(checkpoint.dir,'assessment.json')),originEvents:bind(eventPath),pendingPayload:bind(pending)}};
  const resumeStart=beginReplayAssessment(resume,'resume');
  const resumedEvents=resolve(root,'resumed.jsonl');writeFileSync(resumedEvents,JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Decision with limits'}]}})+'\n');
  events.push({type:'admit',id:15,phase:'harness-feedback'},{type:'settled',id:15,phase:'harness-feedback'});setEvents();write(resolve(root,'provider-request-000015.json'),{messages:resume.prefix});write(resolve(root,'provider-budget.json'),{requests:15,inFlight:{}});
  const resumed=finishReplayAssessment(resume,resumeStart,resumedEvents);
  assert.equal(resumed.newCandidateCount,0);assert.equal(resumed.newVerifiedLiveAttempts,0);assert.equal(resumed.lineage!.newCandidateCount,1);assert.equal(resumed.lineage!.newVerifiedLiveAttempts,3);assert.equal(resumed.lineage!.executionStatus,'live-loop-evidence-recorded');assert.deepEqual(resumed.lineage!.feedbackRequestIds,[15]);
  assert.throws(()=>beginReplayAssessment({...resume,prefix:[...resume.prefix.slice(1)]},'tampered'),/prefix/);
});
