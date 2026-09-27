import assert from 'node:assert/strict';
import {existsSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {applyCardCopy, cardDigest, isSettled, type CopyState, type CopyRun} from './expert-card-copy-store.js';

const read = (path:string) => readFileSync(path, 'utf8');
const json = (path:string) => JSON.parse(read(path));
const lines = (path:string):any[] => existsSync(path) ? read(path).split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x)) : [];

function textContent(content:any):string {
  if(typeof content==='string')return content;
  assert(Array.isArray(content)&&content.every(b=>b.type==='text'&&typeof b.text==='string'),'Unsupported tool content');
  return content.map(b=>b.text).join('');
}
const fewShotDigest=(value:any)=>cardDigest(Array.isArray(value)&&value.length?value:[]);
const effectiveCopyChange=(parent:any,copy:any)=>parent&&(copy.systemPrompt!==parent.systemPrompt||copy.skill!==parent.skill||fewShotDigest(copy.fewShotCases)!==fewShotDigest(parent.fewShotCases));
export function decodeTrialToolResult(event:any):{runs:CopyRun[];toolContent:string}|undefined {
  if(event.type!=='tool_execution_end'||event.toolName!=='expert_trial'||event.isError)return;
  try {const toolContent=textContent(event.result.content),value=JSON.parse(toolContent),runs=Array.isArray(value)?value:value.samples;
    if(!Array.isArray(runs))return;return {runs,toolContent};
  } catch{return;}
}
export function payloadIncludesToolResult(payload:any,event:any,toolContent:string):boolean {
  return payload.messages.some((m:any)=>{try{return m.role==='tool'&&textContent(m.content)===toolContent&&(!event.toolCallId||m.tool_call_id===event.toolCallId);}catch{return false;}});
}

function boundJson(binding:{path:string;sha256:string}) {const raw=read(binding.path);assert.equal(cardDigest(raw),binding.sha256,'Completion lineage binding changed');return JSON.parse(raw);}
function completionLineage(config:any,state:CopyState) {
  if(!config.completionLineage)return;
  assert(config.runtime.feedbackOnly,'Completion lineage continuation must forbid mutations');
  const binding=config.completionLineage,origin=boundJson(binding.originStart),parent=boundJson(binding.parentAssessment),pending=boundJson(binding.pendingPayload);
  let originCompletion=parent;const seen=new Set<string>();
  while(originCompletion.lineage?.parentCompletion) {const prior=originCompletion.lineage.parentCompletion;assert(!seen.has(prior.sha256)&&seen.size<10,'Invalid completion lineage cycle');seen.add(prior.sha256);originCompletion=boundJson(prior);}
  assert.equal(origin.sessionId,originCompletion.sessionId);assert.equal(origin.stateSha256,cardDigest(origin.state));assert.equal(originCompletion.startStateSha256,origin.stateSha256);
  assert.equal(parent.endStateSha256,cardDigest(state),'Continuation state differs from parent completion');
  assert.equal(cardDigest(read(binding.originEvents.path)),binding.originEvents.sha256);assert.equal(originCompletion.eventsSha256,binding.originEvents.sha256);
  const users=config.prefix.filter((m:any)=>m.role==='user');assert(config.authorizedContinuationMessage&&users.length===2);
  assert.equal(textContent(users[1].content),config.authorizedContinuationMessage);
  const scopeAlreadyPresent=pending.messages.some((m:any)=>m.role==='user'&&textContent(m.content)===config.authorizedContinuationMessage);
  assert.deepEqual(scopeAlreadyPresent?config.prefix:config.prefix.slice(0,-1),pending.messages,'Paid prefix or saved trial results changed');
  return {origin,parent,binding};
}

/** Operator evidence, never a model assertion or an instruction containing case answers. */
export function beginReplayAssessment(config:any, sessionId:string) {
  const dir=resolve(config.sessionOutputRoot??config.runtime.root,'completion',sessionId);
  mkdirSync(dir,{recursive:true});
  const statePath=resolve(config.runtime.root,'copies/state.json');
  const state:CopyState=existsSync(statePath)?json(statePath):{sourceBinding:cardDigest(config.runtime.source),versions:{},runs:{},freezes:{},updates:0};
  const ledger=json(resolve(config.budgetRoot,'provider-budget.json'));
  const lineage=completionLineage(config,state);
  const pausePath=resolve(config.sessionOutputRoot??config.runtime.root,'candidate-review-pause.json');
  const noChangePath=resolve(config.sessionOutputRoot??config.runtime.root,'modification-no-change-receipt.json');
  const start={sessionId,mode:config.prefix?'paid-prefix-resume':'new-session',state,stateSha256:cardDigest(state),ledgerRequest:ledger.requests,configSha256:cardDigest(config),candidateReviewPauseAtStart:existsSync(pausePath)?cardDigest(read(pausePath)):null,noChangeReceiptAtStart:existsSync(noChangePath)?cardDigest(read(noChangePath)):null,...(lineage?{parentCompletion:lineage.binding.parentAssessment,originSessionId:lineage.origin.sessionId}:{}),at:new Date().toISOString()};
  writeFileSync(resolve(dir,'start.json'),JSON.stringify(start,null,2),{flag:'wx'});
  return {dir,start};
}

/** Count only this invocation's state delta. Structural execution never certifies quality. */
export function assessReplayDelta(start:CopyState,end:CopyState,sampleCount:number,verifiedRunIds:Set<string>,feedbackRunIds:Set<string>,deliveredRunIds:Set<string>=feedbackRunIds) {
  const historicalChanges=Object.keys(start.versions).filter(id=>cardDigest(start.versions[id])!==cardDigest(end.versions[id]));
  const changedSettledRuns=Object.keys(start.runs).filter(id=>isSettled(start.runs[id])&&cardDigest(start.runs[id])!==cardDigest(end.runs[id]));
  const changedFreezes=Object.keys(start.freezes).filter(id=>cardDigest(start.freezes[id])!==cardDigest(end.freezes[id]));
  const newVersions=Object.values(end.versions).filter(v=>!start.versions[v.version]&&v.parent!==null);
  const newRuns=Object.values(end.runs).filter(r=>!start.runs[r.runId]||!isSettled(start.runs[r.runId]));
  const effectiveVersions=newVersions.filter(v=>effectiveCopyChange(end.versions[v.parent!],v));
  const batches=effectiveVersions.map(v=>{
    const ids=Array.from({length:sampleCount},(_,i)=>`${v.version}s${i+1}`);
    const runs=ids.map(id=>end.runs[id]);
    return {version:v.version,runIds:ids,attemptedBatchCompleted:sampleCount>0&&runs.every(r=>isSettled(r)),successfulSamples:runs.filter(r=>r?.status==='settled-success').length,parseFailures:runs.filter(r=>r?.status==='settled-parse-failure').length,liveEvidenceComplete:sampleCount>0&&ids.every(id=>verifiedRunIds.has(id)),batchResultsDelivered:sampleCount>0&&ids.every(id=>deliveredRunIds.has(id)),feedbackCompleted:sampleCount>0&&ids.every(id=>feedbackRunIds.has(id)),feedbackDelivered:sampleCount>0&&ids.every(id=>feedbackRunIds.has(id))};
  });
  const newSelections=Object.entries(end.freezes).filter(([id])=>!start.freezes[id]).map(([id,f])=>({selectionId:id,...f,newIndependentEvidence:f.runIds.length>0&&f.runIds.every(r=>!start.runs[r]&&verifiedRunIds.has(r))}));
  const intact=start.sourceBinding===end.sourceBinding&&!historicalChanges.length&&!changedSettledRuns.length&&!changedFreezes.length;
  return {objectiveStatus:'objective-not-achieved' as const,executionStatus:intact&&batches.some(b=>b.attemptedBatchCompleted&&b.liveEvidenceComplete&&b.feedbackDelivered)?'live-loop-evidence-recorded':'incomplete',qualityStatus:'not-assessed',newCandidateCount:newVersions.length,newEffectiveCandidateCount:effectiveVersions.length,newAttemptCount:newRuns.filter(isSettled).length,newVerifiedLiveAttempts:newRuns.filter(r=>verifiedRunIds.has(r.runId)).length,batches,newSelections,historicalChanges,changedSettledRuns,changedFreezes,sourceBindingUnchanged:start.sourceBinding===end.sourceBinding,limitation:'Execution evidence is necessary but not sufficient for the user objective. Quality, decision rationale and any improvement claim require review; historical or fake samples cannot establish this round.'};
}

function assessGenerationReceipt(config:any,start:any,end:CopyState,delta:ReturnType<typeof assessReplayDelta>,accountingClear:boolean,engineeringStopped:boolean) {
  if(!config.runtime.generationOnly)return;
  const pausePath=resolve(config.sessionOutputRoot??config.runtime.root,'candidate-review-pause.json');
  const noChangePath=resolve(config.sessionOutputRoot??config.runtime.root,'modification-no-change-receipt.json');
  let pause:any,noChange:any,error:string|undefined;
  try {pause=existsSync(pausePath)?json(pausePath):undefined;noChange=existsSync(noChangePath)?json(noChangePath):undefined;} catch(e) {error=String(e);}
  const authorization=config.runtime.storeOptions.trialAuthorization;
  const candidate=delta.newEffectiveCandidateCount===1&&delta.newCandidateCount===1
    ? Object.values(end.versions).find((v:any)=>!start.state.versions[v.version])
    : undefined;
  const submission=candidate?end.trialSubmissions?.[(candidate as any).version]:undefined;
  const historicalRunChanges=Object.keys(start.state.runs).filter(id=>cardDigest(start.state.runs[id])!==cardDigest(end.runs[id]));
  const addedRuns=Object.keys(end.runs).filter(id=>!start.state.runs[id]);
  const addedFreezes=Object.keys(end.freezes).filter(id=>!start.state.freezes[id]);
  const authorizationDigest=authorization?cardDigest(authorization):undefined;
  const parent=candidate?(candidate as any).parent&&start.state.versions[(candidate as any).parent]:undefined;
  const candidateDigestValid=!!candidate&&(()=>{const {digest,...body}=candidate as any;return cardDigest(body)===digest;})();
  const originValid=!!authorization&&Object.entries(authorization.originVersions??{}).every(([id,digest])=>start.state.versions[id]?.digest===digest&&end.versions[id]?.digest===digest);
  const lineageValid=!!candidate&&!!authorization&&(()=>{let current:any=candidate;const seen=new Set<string>();while(!Object.hasOwn(authorization.originVersions,current.version)){if(seen.has(current.version)||!authorization.allowedNewVersions?.includes(current.version)||!current.parent)return false;seen.add(current.version);current=end.versions[current.parent];if(!current)return false;}return true;})();
  const pauseMatches=!!candidate&&start.candidateReviewPauseAtStart===null&&pause?.kind==='planned-candidate-review-pause'&&pause.version===(candidate as any).version&&pause.copyDigest===(candidate as any).digest&&pause.fewShotCasesSha256===fewShotDigest((candidate as any).fewShotCases);
  const reviewGateIsolated=!!config.runtime.storeOptions.reviewedCopies&&!Object.keys(config.runtime.storeOptions.reviewedCopies).length;
  const saved=!!candidate&&!noChange&&!!parent&&effectiveCopyChange(parent,candidate)&&candidateDigestValid&&!!authorization&&originValid&&lineageValid&&reviewGateIsolated&&submission?.authorizationId===authorization.id&&submission?.authorizationDigest===authorizationDigest&&submission?.copyDigest===(candidate as any).digest&&submission?.readyForTrial===true&&pauseMatches&&end.updates===start.state.updates+1&&Object.keys(end.versions).length===Object.keys(start.state.versions).length+1&&delta.sourceBindingUnchanged&&!delta.historicalChanges.length&&!historicalRunChanges.length&&!delta.changedFreezes.length&&!addedRuns.length&&!addedFreezes.length&&accountingClear&&!engineeringStopped;
  const decision=config.runtime.separatedModificationDecision;
  const noChangeKeys=noChange?Object.keys(noChange).sort():[];
  const noChangeValid=!!decision&&!candidate&&!pause&&start.noChangeReceiptAtStart===null&&noChange?.kind==='separated-modification-no-change'&&noChange.observationReceiptSha256===decision.observationReceiptSha256&&noChange.parentVersion===decision.parentVersion&&noChange.parentDigest===decision.parentDigest&&typeof noChange.reason==='string'&&!!noChange.reason.trim()&&typeof noChange.at==='string'&&JSON.stringify(noChangeKeys)===JSON.stringify(['at','kind','observationReceiptSha256','parentDigest','parentVersion','reason'])&&(!decision.startStateSha256||decision.startStateSha256===start.stateSha256)&&start.state.versions[decision.parentVersion]?.digest===decision.parentDigest&&cardDigest(end)===start.stateSha256&&delta.newCandidateCount===0&&delta.newEffectiveCandidateCount===0&&delta.sourceBindingUnchanged&&!delta.historicalChanges.length&&!historicalRunChanges.length&&!delta.changedFreezes.length&&!addedRuns.length&&!addedFreezes.length&&accountingClear&&!engineeringStopped;
  return {
    status:saved?'candidate-saved-awaiting-review' as const:noChangeValid?'no-change-decision-recorded' as const:'generation-incomplete' as const,
    automaticRetry:false,
    candidateVersion:candidate?(candidate as any).version:null,
    candidateDigest:candidate?(candidate as any).digest:null,
    pausePath,noChangeReceiptPath:noChangePath,
    ...(noChangeValid?{decision:'no-change' as const,reason:noChange.reason,observationReceiptSha256:noChange.observationReceiptSha256,parentVersion:noChange.parentVersion,parentDigest:noChange.parentDigest}:{}),
    checks:{exactlyOneEffectiveCandidate:delta.newEffectiveCandidateCount===1&&delta.newCandidateCount===1,parentBoundToStart:!!parent,candidateDigestValid,authorizationValid:!!authorization&&originValid&&lineageValid,reviewGateIsolated,submissionReady:!!candidate&&submission?.authorizationId===authorization?.id&&submission?.authorizationDigest===authorizationDigest&&submission?.copyDigest===(candidate as any).digest&&submission?.readyForTrial===true,pauseMatches,noChangeReceiptValid:noChangeValid,noHistoricalMutation:delta.sourceBindingUnchanged&&!delta.historicalChanges.length&&!historicalRunChanges.length&&!delta.changedFreezes.length,noNewTrialOrFreeze:!addedRuns.length&&!addedFreezes.length,accountingClear:accountingClear&&!engineeringStopped},
    ...(error?{pauseReadError:error}:{}),
  };
}

export function finishReplayAssessment(config:any,checkpoint:ReturnType<typeof beginReplayAssessment>,eventsPath:string,error?:unknown) {
  const {start,dir}=checkpoint;
  const statePath=resolve(config.runtime.root,'copies/state.json');
  const end:CopyState=existsSync(statePath)?json(statePath):start.state;
  const ledger=json(resolve(config.budgetRoot,'provider-budget.json'));
  const events=lines(resolve(config.budgetRoot,'provider-events.jsonl'));
  const settled=events.filter(e=>e.type==='settled'&&Number(e.id)>start.ledgerRequest);
  const lineage=completionLineage(config,start.state),evidenceStart=lineage?.origin??start;
  const evidenceSettled=events.filter(e=>e.type==='settled'&&Number(e.id)>evidenceStart.ledgerRequest);
  const verified=new Set<string>(),feedback=new Set<string>(),deliveredRuns=new Set<string>(),evidenceErrors:Record<string,string>={};
  const paid=config.expertExecution;
  // Loopback fixtures exercise infrastructure only. They are explicitly excluded from live evidence.
  const remote=(origin:string)=>{try {const u=new URL(origin);return u.protocol==='https:'&&!['localhost','127.0.0.1','[::1]'].includes(u.hostname);}catch{return false;}};
  for(const run of Object.values(end.runs)) {
    if(isSettled(evidenceStart.state.runs[run.runId])||!isSettled(run)||!paid)continue;
    try {
      assert(remote(paid.providerOrigin),'Offline/fake transport is not live evidence');
      const receipt=run.receipt;assert(receipt?.status==='settled');
      const matches=evidenceSettled.filter(e=>String(e.id)===receipt.requestId&&e.phase===paid.phasePrefix+'-'+run.runId);assert.equal(matches.length,1);
      const event=matches[0];assert.equal(event.actual.costUsd,receipt.costUsd);assert.equal(event.actual.totalTokens,receipt.totalTokens);assert(receipt.totalTokens>0);
      assert(events.some(e=>e.type==='admit'&&e.id===event.id&&e.phase===event.phase));
      const trial=resolve(paid.root,'trials',run.runId),copy=end.versions[run.version]!;
      const producer=json(resolve(trial,'producer.json')),actual=json(resolve(trial,'actual-request.json'));
      const options=json(resolve(trial,'actual-options.json'));
      const baseline=json(paid.baselineRequestPath);
      const expected={...baseline,messages:baseline.messages.map((m:any)=>m.role==='system'?{...m,content:applyCardCopy(m.content,paid.sourcePrompt,copy)}:m)};
      assert.deepEqual(actual,expected,'Non-Card producer inputs changed');
      assert.equal(copy.digest,run.copyDigest);assert.equal(producer.copyDigest,copy.digest);assert.equal(producer.version,run.version);
      assert.equal(run.producerBinding,cardDigest({execution:config.runtime.storeOptions.executionBinding,copyDigest:copy.digest}));
      assert.equal(producer.systemSha256,cardDigest(options.systemPrompt));assert.equal(producer.promptSha256,cardDigest(options.prompt));
      assert.equal(actual.messages[0].content,options.systemPrompt);
      const content=actual.messages.find((m:any)=>m.role==='user').content;
      assert.equal(typeof content==='string'?content:content.map((b:any)=>b.text).join(''),options.prompt);
      assert.deepEqual(actual,json(resolve(config.budgetRoot,`provider-request-${String(event.id).padStart(6,'0')}.json`)));
      assert.equal(receipt.parsed,run.status==='settled-success');
      if(receipt.parsed)assert.deepEqual(json(resolve(trial,'trial-result.json')),run.value);
      else assert(existsSync(resolve(trial,'error.json')),'Missing parse failure evidence');
      verified.add(run.runId);
    } catch(e) {evidenceErrors[run.runId]=String(e);}
  }
  const publicEvents=[...(lineage?lines(lineage.binding.originEvents.path):[]),...lines(eventsPath)];
  const feedbackRequestIds=new Set<number>();
  for(let i=0;i<publicEvents.length;i++) {
    const event=publicEvents[i];
    const decoded=decodeTrialToolResult(event);if(!decoded)continue;
    const {runs,toolContent}=decoded;
    const ids=runs.filter(r=>verified.has(r.runId)&&r.copyDigest===end.runs[r.runId]?.copyDigest&&r.status===end.runs[r.runId]?.status).map(r=>r.runId);
    if(!ids.length)continue;
    const laterResponse=publicEvents.slice(i+1).some(e=>e.type==='message_end'&&e.message?.role==='assistant'&&e.message.stopReason==='stop'&&!e.message.content?.some((b:any)=>b.type==='toolCall')&&e.message.content?.some((b:any)=>b.type==='text'&&b.text?.trim()));
    const delivered=settled.some(e=>e.phase===config.phase&&events.some(a=>a.type==='admit'&&a.id===e.id&&a.phase===e.phase)&&ids.every(id=>Number(e.id)>Number((end.runs[id]!.receipt as any).requestId))&&(()=>{
      try {const payload=json(resolve(config.budgetRoot,`provider-request-${String(e.id).padStart(6,'0')}.json`));if(lineage)assert.deepEqual(payload.messages.slice(0,config.prefix.length),config.prefix);const included=payloadIncludesToolResult(payload,event,toolContent);if(included)feedbackRequestIds.add(e.id);return included;}catch{return false;}
    })());
    if(delivered)ids.forEach(id=>{deliveredRuns.add(id);if(laterResponse)feedback.add(id);});
  }
  const engineeringStopped=existsSync(resolve(config.sessionOutputRoot??config.runtime.root,'engineering-stop.json'));
  if(engineeringStopped)feedback.clear();
  const lineageAssessment=lineage?{...assessReplayDelta(evidenceStart.state,end,config.runtime.storeOptions.sampleCount??3,verified,feedback,deliveredRuns),originSessionId:evidenceStart.sessionId,originStartStateSha256:evidenceStart.stateSha256,parentCompletion:lineage.binding.parentAssessment,feedbackRequestIds:[...feedbackRequestIds]}:undefined;
  const delta=assessReplayDelta(start.state,end,config.runtime.storeOptions.sampleCount??3,verified,feedback,deliveredRuns);
  const accountingClear=!ledger.blocked&&!ledger.accountingUnknown&&!Object.keys(ledger.inFlight??{}).length;
  const generation=assessGenerationReceipt(config,start,end,delta,accountingClear,engineeringStopped);
  const plannedPauseCompleted=generation?.status==='candidate-saved-awaiting-review'||generation?.status==='no-change-decision-recorded';
  const assessment={...delta,...(generation?{executionStatus:generation.status,generation}:{executionStatus:delta.executionStatus}),...(lineageAssessment?{lineage:lineageAssessment}:{}),sessionId:start.sessionId,mode:start.mode,startStateSha256:start.stateSha256,endStateSha256:cardDigest(end),eventsSha256:existsSync(eventsPath)?cardDigest(read(eventsPath)):null,ledgerRequestStart:start.ledgerRequest,ledgerRequestEnd:ledger.requests,engineeringStopped,accountingClear,evidenceErrors,...(error&&!plannedPauseCompleted?{executionError:String(error)}:{}),at:new Date().toISOString()};
  if((error&&!plannedPauseCompleted)||engineeringStopped||!assessment.accountingClear)assessment.executionStatus=config.runtime.generationOnly?'generation-incomplete':'incomplete';
  if(lineageAssessment&&(error||engineeringStopped||!assessment.accountingClear||cardDigest(end)!==start.stateSha256))lineageAssessment.executionStatus='incomplete';
  writeFileSync(resolve(dir,'end-state.json'),JSON.stringify(end,null,2),{flag:'wx'});
  writeFileSync(resolve(dir,'assessment.json'),JSON.stringify(assessment,null,2),{flag:'wx'});
  return {...assessment,assessmentPath:resolve(dir,'assessment.json')};
}
