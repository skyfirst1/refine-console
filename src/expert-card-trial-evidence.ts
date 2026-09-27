import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {applyCardCopy,cardDigest,isSettled,type CopyState} from './expert-card-copy-store.js';

export interface TrialEvidenceSource {root:string;budgetRoot:string;phasePrefix:string;baselineRequestPath:string;sourcePrompt:string;}

const forbiddenObservationKeys=new Set(['expectedMatched','proposedPatch','fewShotCases','repairExample','repairExamples','suggestedFix']);
function rejectForbiddenObservationFields(value:unknown,path='$') {
  if(!value||typeof value!=='object')return;
  for(const[key,child]of Object.entries(value)){if(forbiddenObservationKeys.has(key))throw Error(`Forbidden observation field at ${path}.${key}`);rejectForbiddenObservationFields(child,`${path}.${key}`);}
}

/** Deterministic no-Card view of an already-settled Expert request and its raw output. */
export function projectSettledExpertObservation(input:{runId:string;request:any;rawOutput:string;requestId:string;requestSha256?:string}) {
  rejectForbiddenObservationFields(input);
  if(!input.runId||!input.requestId||typeof input.rawOutput!=='string')throw Error('Invalid settled Expert observation projection');
  const messages=Array.isArray(input.request?.messages)?input.request.messages:[];
  const userMessages=messages.filter((message:any)=>message?.role==='user').map((message:any)=>structuredClone(message));
  if(!userMessages.length)throw Error('Settled Expert request has no local user input');
  const requestSha256=input.requestSha256??cardDigest(input.request);
  if(requestSha256!==cardDigest(input.request))throw Error('Settled Expert request digest mismatch');
  return{schemaVersion:'1.0',kind:'settled-expert-local-observation',epistemicStatus:'not-gold',runId:input.runId,settlement:{requestId:input.requestId,requestSha256},visibility:{included:['actual local user message(s)','raw Expert output'],excluded:['system prompt','Card and Skill instructions','hidden model reasoning'],limitation:'This is a deterministic partial projection, not the complete provider request. It supports observation of the local input/output relation but cannot establish which hidden instruction caused it.'},request:{messages:userMessages},rawOutput:input.rawOutput};
}

export interface ObservationReceiptInput {
  observationText:string;
  sources:Record<string,{raw:string;sha256:string;scope:string}>;
  actualReadIds:string[];
  citations:Array<{sourceId:string;quotedText:string}>;
  uncertainties:string[];
}

/** Freeze S1's public observation and only citations that occur in sources it actually read. */
export function createObservationReceipt(input:ObservationReceiptInput) {
  rejectForbiddenObservationFields(input);
  const allowed=new Set(['observationText','sources','actualReadIds','citations','uncertainties']);
  if(Object.keys(input as any).some(key=>!allowed.has(key)))throw Error('Unknown observation receipt field');
  if(typeof input.observationText!=='string'||!input.observationText.trim())throw Error('Observation text is required');
  if(!Array.isArray(input.actualReadIds)||new Set(input.actualReadIds).size!==input.actualReadIds.length)throw Error('Observation reads must be unique');
  const reads=input.actualReadIds.map(id=>{const source=input.sources[id];if(!source)throw Error('Observation read is not a registered source');if(cardDigest(source.raw)!==source.sha256)throw Error('Observation source digest mismatch');if(typeof source.scope!=='string'||!source.scope.trim())throw Error('Observation source scope is required');return{id,sha256:source.sha256,scope:source.scope};});
  const readIds=new Set(input.actualReadIds);
  const citations=input.citations.map(citation=>{const source=input.sources[citation.sourceId];if(!readIds.has(citation.sourceId)||!source)throw Error('Observation citation source was not actually read');if(typeof citation.quotedText!=='string'||!citation.quotedText||!source.raw.includes(citation.quotedText))throw Error('Observation citation is not an exact substring of its read source');return structuredClone(citation);});
  if(!Array.isArray(input.uncertainties)||input.uncertainties.some(x=>typeof x!=='string'||!x.trim()))throw Error('Invalid observation uncertainty');
  return{schemaVersion:'1.0',kind:'frozen-observation-receipt',epistemicStatus:'model-observation-not-gold',observationText:input.observationText,actualReads:reads,citations,uncertainties:[...input.uncertainties]};
}

/** Immutable receipt write: a retry may verify identical bytes but cannot replace the observation. */
export function writeObservationReceipt(path:string,input:ObservationReceiptInput) {
  const receipt=createObservationReceipt(input),text=JSON.stringify(receipt,null,2);mkdirSync(dirname(resolve(path)),{recursive:true});
  if(existsSync(path)){if(readFileSync(path,'utf8')!==text)throw Error('Frozen observation receipt already differs');}
  else writeFileSync(path,text,{flag:'wx'});
  return{receipt,path,sha256:cardDigest(text)};
}
/** Discover only allowlisted files from independently settled, copy-bound executions. */
export function settledTrialArtifacts(state:CopyState,source:TrialEvidenceSource,executionBinding?:string) {
  const artifacts:Record<string,{path:string;sha256:string}>={},aliases:Record<string,string>={},defaults:Record<string,string>={};
  const read=(p:string)=>readFileSync(p,'utf8'),json=(p:string)=>JSON.parse(read(p));
  const events=read(resolve(source.budgetRoot,'provider-events.jsonl')).split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));
  for(const run of Object.values(state.runs)) {
    if(!isSettled(run)||!/^\w[\w-]{0,99}$/.test(run.runId))continue;
    const dir=resolve(source.root,'trials',run.runId),producerPath=resolve(dir,'producer.json');
    if(!existsSync(producerPath))continue; // Imported historical runs keep their original explicit registry.
    const receipt=run.receipt;assert(receipt?.status==='settled','Trial evidence lacks settlement');
    const settled=events.filter(e=>e.type==='settled'&&String(e.id)===receipt.requestId&&e.phase===source.phasePrefix+'-'+run.runId);assert.equal(settled.length,1);
    const e=settled[0];assert(events.some(a=>a.type==='admit'&&a.id===e.id&&a.phase===e.phase));assert.equal(e.actual.costUsd,receipt.costUsd);assert.equal(e.actual.totalTokens,receipt.totalTokens);
    const copy=state.versions[run.version]!,producer=json(producerPath),actual=json(resolve(dir,'actual-request.json')),baseline=json(source.baselineRequestPath);
    assert.equal(copy.digest,run.copyDigest);assert.equal(producer.copyDigest,copy.digest);assert.equal(producer.version,run.version);
    assert.equal(run.producerBinding,cardDigest({execution:executionBinding??'legacy-unbound',copyDigest:copy.digest}));
    const expected={...baseline,messages:baseline.messages.map((m:any)=>m.role==='system'?{...m,content:applyCardCopy(m.content,source.sourcePrompt,copy)}:m)};
    assert.deepEqual(actual,expected);assert.deepEqual(actual,json(resolve(source.budgetRoot,`provider-request-${String(e.id).padStart(6,'0')}.json`)));
    const canonical=resolve(dir,'trial-result.json');
    if(receipt.parsed) {assert.equal(run.status,'settled-success');assert.deepEqual(json(canonical),run.value);assert.equal(read(resolve(dir,'public-output.md')),run.value.raw);}
    else {assert.equal(run.status,'settled-parse-failure');assert(existsSync(resolve(dir,'error.json')));}
    for(const name of ['trial-result.json','public-output.md','producer.json','actual-request.json','error.json']) {
      const path=resolve(dir,name);if(existsSync(path))artifacts[`${run.runId}/${name}`]={path,sha256:cardDigest(read(path))};
    }
    if(artifacts[`${run.runId}/trial-result.json`])aliases[`${run.runId}/result.json`]=`${run.runId}/trial-result.json`;
    if(artifacts[`${run.runId}/public-output.md`])defaults[run.runId]=`${run.runId}/public-output.md`;
  }
  return {artifacts,aliases,defaults};
}
