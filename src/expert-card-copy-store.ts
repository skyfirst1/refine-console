import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, rmdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {validateFewShotCases,renderFewShotCases,type FewShotCase} from './expert-card-few-shot.js';

export const cardDigest = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const ALIGNER_ROLE = 'refine.evidence-aligner' as const;
export const MATCHER_ROLE = 'refine.aspect-matcher' as const;
export interface CardCopy {version:string; parent:string|null; roleId:typeof ALIGNER_ROLE|typeof MATCHER_ROLE; systemPrompt:string; skill:string; reason:string; digest:string;fewShotCases?:FewShotCase[]}
export type AttemptStatus = 'not-sent'|'running'|'settled-success'|'settled-parse-failure'|'pre-send-blocked'|'unknown';
export interface Settlement {status:'settled'; requestId:string; costUsd:number; totalTokens:number; parsed:boolean}
export type ExecutionReceipt = Settlement | {status:'not-sent'|'pre-send-blocked'|'running'|'unknown'};
export interface CopyRun {runId:string; version:string; copyDigest:string; producerBinding:string; status:AttemptStatus; value?:any; error?:string; receipt?:ExecutionReceipt}
export interface TrialAuthorization {id:string;allowedNewVersions:string[];originVersions:Record<string,string>;requireReadyForTrial:boolean;allowConfirmation?:boolean}
export interface CopyState {sourceBinding:string; versions:Record<string,CardCopy>; runs:Record<string,CopyRun>; updates:number; freezes:Record<string,{version:string;copyDigest:string;runIds:string[]}>;draftSupersessions?:Record<string,{successor:string;predecessorDigest:string;successorDigest:string}>;trialSubmissions?:Record<string,{authorizationId:string;authorizationDigest:string;copyDigest:string;readyForTrial:boolean}>}
export interface StoreOptions {
  /** Explicit Matcher blind-candidate storage only; never enables execution. */
  candidateOnlyRole?:typeof MATCHER_ROLE;
  maxUpdates?:number; sampleCount?:number; confirmationCount?:number;
  /** Immutable input/model/parameter binding, excluding the selected Card. */
  executionBinding?:string;
  /** Accounting is independent of parsing. Absence never proves settlement. */
  receipt?:(runId:string)=>Promise<ExecutionReceipt>;
  requirePriorBatch?:boolean;
  /** Explicit opt-in: complete the latest immutable draft only before any trial identity exists. */
  allowUnstartedDraftCompletion?:boolean;
  /** Required independent accounting check for the opt-in draft path. */
  assertDraftAccountingClear?:()=>Promise<void>;
  /** Explicit phase authority for NEW requests; settled identities remain readable. */
  trialAuthorization?:TrialAuthorization;
  assertTrialAccountingClear?:()=>Promise<void>;
  /** Optional operator review gate. Empty means no new execution is reviewed; no quality certification. */
  reviewedCopies?:Record<string,string>;
}
export interface CardArgs {action:'create'|'read'|'update'|'append';roleId:string;version?:string;parentVersion?:string;systemPrompt?:string;skill?:string;reason?:string;readyForTrial?:boolean;fewShotCases?:FewShotCase[];promptAppend?:string;badCaseAppend?:string;parentDigest?:string;startStateSha256?:string}
export function isSettled(run:CopyRun|undefined):boolean {return run?.status==='settled-success'||run?.status==='settled-parse-failure';}
export function validateSettlement(receipt:ExecutionReceipt):ExecutionReceipt {
  if(receipt.status==='settled' && (!receipt.requestId || !Number.isFinite(receipt.costUsd) || receipt.costUsd<0 || !Number.isSafeInteger(receipt.totalTokens) || receipt.totalTokens<0 || typeof receipt.parsed!=='boolean')) throw Error('Invalid settlement receipt');
  if(!['settled','not-sent','pre-send-blocked','running','unknown'].includes(receipt.status))throw Error('Unknown receipt status');
  return receipt;
}
export function receiptStatus(receipt:ExecutionReceipt):AttemptStatus {validateSettlement(receipt);return receipt.status==='settled'?(receipt.parsed?'settled-success':'settled-parse-failure'):receipt.status;}
const safeId=(id:string)=>{if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id))throw Error('Invalid identity');return id;};

/** Immutable experimental copies. No production paths are accepted. */
export function createExpertCardCopyStore(root:string,source:{roleId:string;systemPrompt:string},execute:(copy:CardCopy,runId:string)=>Promise<unknown>,options:StoreOptions={}) {
  const absolute=resolve(root),sourceBinding=cardDigest(source),maxUpdates=options.maxUpdates??2,sampleCount=options.sampleCount??3,confirmCount=options.confirmationCount??2;
  const candidateOnly=options.candidateOnlyRole===MATCHER_ROLE;
  if(options.candidateOnlyRole!==undefined&&(!candidateOnly||source.roleId!==MATCHER_ROLE||sampleCount!==0||confirmCount!==0||options.trialAuthorization))throw Error('Matcher candidate-only binding requires zero execution authority');
  for(const limit of [maxUpdates,sampleCount,confirmCount])if(!Number.isSafeInteger(limit)||limit<0)throw Error('Invalid quota');
  if(options.reviewedCopies&&Object.entries(options.reviewedCopies).some(([id,digest])=>!/^v\d+$/.test(id)||!/^[a-f0-9]{64}$/.test(digest)))throw Error('Invalid reviewed copy binding');
  const authorization=options.trialAuthorization,authorizationDigest=authorization?cardDigest(authorization):undefined;
  if(authorization){
    safeId(authorization.id);
    const originIds=Object.keys(authorization.originVersions),allowed=authorization.allowedNewVersions;
    if(!originIds.length||typeof authorization.requireReadyForTrial!=='boolean'||(authorization.allowConfirmation!==undefined&&typeof authorization.allowConfirmation!=='boolean')||!Array.isArray(allowed)||!allowed.length||new Set(allowed).size!==allowed.length||[...originIds,...allowed].some(v=>!/^v\d+$/.test(v))||Object.values(authorization.originVersions).some(d=>!/^[a-f0-9]{64}$/.test(d)))throw Error('Invalid trial authorization');
    const lastOrigin=Math.max(...originIds.map(v=>Number(v.slice(1))));
    if(allowed.some(v=>Number(v.slice(1))<=lastOrigin))throw Error('Only future versions may receive new trial authority');
  }
  let queue:Promise<unknown>=Promise.resolve();
  const statePath=resolve(absolute,'state.json');
  const load=async():Promise<CopyState>=>{try{const s=JSON.parse(await readFile(statePath,'utf8'));if(!s.freezes)s.freezes={};return s;}catch(e:any){if(e.code!=='ENOENT')throw e;return{sourceBinding,versions:{},runs:{},updates:0,freezes:{}};}};
  const save=async(s:CopyState)=>{await writeFile(statePath+'.tmp',JSON.stringify(s,null,2));await rename(statePath+'.tmp',statePath);};
  const serial=<T>(fn:()=>Promise<T>):Promise<T>=>{const op=queue.then(async()=>{await mkdir(absolute,{recursive:true});const lock=resolve(absolute,'.operation-lock');try{await mkdir(lock);}catch(e:any){if(e.code==='EEXIST')throw Error('Store operation already running; reconcile before recovery');throw e;}try{return await fn();}finally{await rmdir(lock);}});queue=op.catch(()=>undefined);return op;};
  const check=(s:CopyState,role:string)=>{if(role!==(candidateOnly?MATCHER_ROLE:ALIGNER_ROLE)||source.roleId!==role)throw Error('Role is not allowed');if(s.sourceBinding!==sourceBinding)throw Error('Original Card binding changed');};
  const get=(s:CopyState,version:string):CardCopy=>{if(!/^v\d+$/.test(version)||!Object.hasOwn(s.versions,version))throw Error('Unknown immutable Card version');const copy=s.versions[version]!;const{digest,...body}=copy;if(cardDigest(body)!==digest||copy.roleId!==source.roleId)throw Error('Card copy digest or role mismatch');return copy;};
  const ids=(version:string)=>Array.from({length:sampleCount},(_,i)=>version==='v0'?`baseline${i+1}`:`${version}s${i+1}`);
  const unresolved=(s:CopyState)=>Object.values(s.runs).some(r=>!['not-sent','pre-send-blocked','settled-success','settled-parse-failure'].includes(r.status));
  const batchDone=(s:CopyState,version:string)=>ids(version).every(id=>isSettled(s.runs[id]));
  const producerBinding=(copy:CardCopy)=>cardDigest({execution:options.executionBinding??'legacy-unbound',copyDigest:copy.digest});
  const checkOrigin=(s:CopyState)=>{if(authorization)for(const [id,digest]of Object.entries(authorization.originVersions))if(get(s,id).digest!==digest)throw Error('Trial authorization origin changed');};
  const checkNewVersion=(s:CopyState,copy:CardCopy)=>{
    if(options.reviewedCopies&&options.reviewedCopies[copy.version]!==copy.digest)throw Error('Candidate requires operator review before any new execution');
    if(s.draftSupersessions?.[copy.version])throw Error('Superseded draft cannot start new trials');
    if(!authorization)return;
    checkOrigin(s);
    if(!authorization.allowedNewVersions.includes(copy.version))throw Error('Version is outside this phase trial authorization');
    const submission=s.trialSubmissions?.[copy.version];
    if(!submission||submission.copyDigest!==copy.digest||submission.authorizationId!==authorization.id||submission.authorizationDigest!==authorizationDigest)throw Error('Candidate is not bound to this trial authorization');
    if(authorization.requireReadyForTrial&&!submission.readyForTrial)throw Error('Candidate is an unsubmitted draft; complete a new immutable successor before trials');
    let current=copy;const seen=new Set<string>();
    while(!Object.hasOwn(authorization.originVersions,current.version)){
      if(seen.has(current.version)||!authorization.allowedNewVersions.includes(current.version)||!current.parent)throw Error('Candidate lineage is outside the authorized origin');
      seen.add(current.version);current=get(s,current.parent);
    }
  };
  const checkNewAccounting=async()=>{if(authorization){if(!options.assertTrialAccountingClear)throw Error('Trial authorization requires independent accounting');await options.assertTrialAccountingClear();}};
  const replay=async(args:{roleId:string;version:string;runId:string}):Promise<CopyRun&{delivery:string}>=>serial(async()=>{
    if(candidateOnly)throw Error('Matcher candidate-only store forbids execution');
    const s=await load();check(s,args.roleId);const copy=get(s,args.version);safeId(args.runId);
    const old=s.runs[args.runId];
    const allowed=ids(copy.version).includes(args.runId)||Object.values(s.freezes).some(f=>f.version===copy.version&&f.runIds.includes(args.runId))||(!options.executionBinding&&['baseline','trial1','trial2'].includes(args.runId));
    if(old&&(old.copyDigest!==copy.digest||old.producerBinding!==producerBinding(copy)))throw Error('Run already bound to another version or producer');
    if(!allowed)throw Error('Unknown run identity for version');
    if(args.runId==='baseline'&&copy.version!=='v0')throw Error('Baseline requires v0');
    if(old){if(isSettled(old))return{...old,delivery:'cached-existing'};if(!['not-sent','pre-send-blocked'].includes(old.status))throw Error('Run accounting unknown or running; do not replay');}
    if(authorization?.allowConfirmation===false&&!ids(copy.version).includes(args.runId))throw Error('This phase forbids new confirmation requests');
    checkNewVersion(s,copy);
    if(unresolved(s))throw Error('Unresolved execution exists; reconcile accounting before another request');
    await checkNewAccounting();
    const record:CopyRun={runId:args.runId,version:copy.version,copyDigest:copy.digest,producerBinding:producerBinding(copy),status:'running'};s.runs[args.runId]=record;await save(s);
    let value:unknown,error:string|undefined;
    try{value=await execute(copy,args.runId);}catch(e){error=String(e);}
    let receipt:ExecutionReceipt;
    try{receipt=validateSettlement(options.receipt?await options.receipt(args.runId):{status:'unknown'});}catch(e){receipt={status:'unknown'};error=[error,String(e)].filter(Boolean).join('\n');}
    const next:CopyRun={...record,status:receiptStatus(receipt),receipt,...(value!==undefined?{value}:{}),...(error?{error}:{})};
    if(error&&next.status==='settled-success'){next.status='unknown';next.error=error+'; receipt claims parsing success';}
    s.runs[args.runId]=next;await save(s);return{...next,delivery:'new-execution'};
  });
  return {
    snapshot(){return serial(async()=>{const s=await load();check(s,source.roleId);return s;});},
    async quota(){const s=await this.snapshot();return{maxUpdates,remainingUpdates:Math.max(0,maxUpdates-s.updates),sampleCount,confirmationCount:confirmCount,versions:Object.keys(s.versions),updatePrerequisites:{requirePriorBatch:options.requirePriorBatch===true,baselineBatchComplete:batchDone(s,'v0'),latestVersion:`v${s.updates}`,latestBatchComplete:batchDone(s,`v${s.updates}`)},freezes:s.freezes,...(options.reviewedCopies?{reviewedCopies:options.reviewedCopies}:{}),...(authorization?{trialAuthorization:authorization,trialSubmissions:s.trialSubmissions??{},draftSupersessions:s.draftSupersessions??{}}:{})};},
    card(args:CardArgs){return serial(async()=>{
      const s=await load();check(s,args.roleId);
      if(candidateOnly&&!['create','read','append'].includes(args.action))throw Error('Matcher candidate-only store accepts blind append, not replacement updates');
      if(args.action==='create'){if(!s.versions.v0){const body={version:'v0',parent:null,roleId:candidateOnly?MATCHER_ROLE:ALIGNER_ROLE,systemPrompt:source.systemPrompt,skill:'',reason:'Original Card copied without changes'};s.versions.v0={...body,digest:cardDigest(body)};await save(s);}return get(s,'v0');}
      if(args.version&&args.parentVersion&&args.version!==args.parentVersion)throw Error('Ambiguous parentVersion and version');
      const parent=get(s,args.parentVersion??args.version??'');if(args.action==='read')return parent;
      if(args.action==='append'){
        if(args.systemPrompt!==undefined||args.skill!==undefined||args.reason!==undefined||args.fewShotCases!==undefined)throw Error('Append accepts increments only');
        if(!args.parentDigest||parent.digest!==args.parentDigest||!args.startStateSha256||cardDigest(s)!==args.startStateSha256)throw Error('Append parent or prepared state changed');
        if(typeof args.promptAppend!=='string'||!args.promptAppend.trim()||typeof args.badCaseAppend!=='string'||!args.badCaseAppend.trim())throw Error('Both append strings are required');
        args={...args,action:'update',systemPrompt:parent.systemPrompt+'\n\n'+args.promptAppend+'\n\n'+args.badCaseAppend,reason:parent.reason};
      }
      if(args.action!=='update'||(args.systemPrompt===undefined&&args.skill===undefined&&args.fewShotCases===undefined))throw Error('Specify at least one changed field');
      const systemPrompt=args.systemPrompt===undefined?parent.systemPrompt:args.systemPrompt,skill=args.skill===undefined?parent.skill:args.skill;
      const fewShotCases=args.fewShotCases===undefined?parent.fewShotCases:args.fewShotCases;if(fewShotCases!==undefined)validateFewShotCases(fewShotCases);
      if(typeof systemPrompt!=='string'||!systemPrompt.trim()||systemPrompt.length>16000||typeof skill!=='string'||skill.length>16000||!args.reason?.trim())throw Error('Nonempty systemPrompt, skill string and reason required');
      if(args.readyForTrial!==undefined&&typeof args.readyForTrial!=='boolean')throw Error('readyForTrial must be boolean');
      const repeated=Object.values(s.versions).find(v=>v.parent===parent.version&&v.systemPrompt===systemPrompt&&v.skill===skill&&cardDigest(v.fewShotCases??null)===cardDigest(fewShotCases??null)&&v.reason===args.reason);if(repeated){const submission=s.trialSubmissions?.[repeated.version];if(authorization&&submission&&(submission.authorizationDigest!==authorizationDigest||submission.readyForTrial!==(args.readyForTrial===true)))throw Error('Immutable submission cannot change readiness or authorization');return repeated;}
      if(unresolved(s))throw Error('Unresolved execution prevents update');
      if(s.updates>=maxUpdates)throw Error('Copy update quota exhausted');
      let completesDraft=false;
      if(options.requirePriorBatch&&(!batchDone(s,'v0')||(s.updates>0&&!batchDone(s,`v${s.updates}`)))) {
        completesDraft=options.allowUnstartedDraftCompletion===true&&s.updates>0&&parent.version===`v${s.updates}`&&batchDone(s,'v0')&&!Object.values(s.runs).some(r=>r.version===parent.version)&&!Object.values(s.freezes).some(f=>f.version===parent.version);
        if(!completesDraft)throw Error('Settle prior sample batch before update');
        if(!options.assertDraftAccountingClear)throw Error('Draft completion requires an independent accounting check');
        await options.assertDraftAccountingClear();
      }
      const next=Math.max(0,...Object.keys(s.versions).map(v=>Number(v.slice(1))))+1;
      if(authorization){checkOrigin(s);if(!authorization.allowedNewVersions.includes(`v${next}`))throw Error('New version exceeds phase authorization');}
      const body={version:`v${next}`,parent:parent.version,roleId:parent.roleId,systemPrompt,skill,reason:args.reason!,...(fewShotCases!==undefined?{fewShotCases}:{})};const copy={...body,digest:cardDigest(body)};s.versions[copy.version]=copy;s.updates=next;
      if(authorization)s.trialSubmissions={...s.trialSubmissions,[copy.version]:{authorizationId:authorization.id,authorizationDigest:authorizationDigest!,copyDigest:copy.digest,readyForTrial:args.readyForTrial===true}};
      if(completesDraft)s.draftSupersessions={...s.draftSupersessions,[parent.version]:{successor:copy.version,predecessorDigest:parent.digest,successorDigest:copy.digest}};
      await save(s);return copy;
    });},
    replay,
    async sample(args:{roleId:string;version:string}){if(candidateOnly)throw Error('Matcher candidate-only store forbids execution');const values=[];for(const runId of ids(args.version)){const result=await replay({...args,runId});values.push(result);if(!isSettled(result))break;}return values;},
    freeze(args:{roleId:string;version:string;selectionId:string}){return serial(async()=>{if(candidateOnly)throw Error('Matcher candidate-only store forbids execution');const s=await load();check(s,args.roleId);safeId(args.selectionId);const copy=get(s,args.version);const old=s.freezes[args.selectionId];if(old){if(old.copyDigest!==copy.digest)throw Error('Frozen selection cannot be rebound');return old;}if(authorization?.allowConfirmation===false)throw Error('This phase forbids new confirmation requests');checkNewVersion(s,copy);if(unresolved(s))throw Error('Unresolved execution prevents freeze');await checkNewAccounting();if(Object.values(s.freezes).some(f=>f.version===copy.version))throw Error('Version already frozen under another selection identity');if(!batchDone(s,args.version))throw Error('Settle selected batch before confirmation');const frozen={version:copy.version,copyDigest:copy.digest,runIds:Array.from({length:confirmCount},(_,i)=>`${args.selectionId}-confirm${i+1}`)};for(const id of frozen.runIds){safeId(id);if(s.runs[id])throw Error('Confirmation identity already exists');}s.freezes[args.selectionId]=frozen;await save(s);return frozen;});},
    async confirm(args:{roleId:string;version:string;selectionId:string}){const f=await this.freeze(args);const values=[];for(const runId of f.runIds){const r=await replay({...args,runId});values.push(r);if(!isSettled(r))break;}return values;},
    /** Operator accounting reconciliation only; not exposed as an LLM tool. */
    reconcile(runId:string,receipt:ExecutionReceipt){return serial(async()=>{const s=await load();check(s,source.roleId);const r=s.runs[runId];if(!r)throw Error('Unknown run');if(isSettled(r))throw Error('Settled records are immutable');r.receipt=validateSettlement(receipt);r.status=receiptStatus(receipt);await save(s);return r;});},
  };
}

export function applyCardCopy(originalSystem:string,originalPrompt:string,copy:CardCopy):string {
  const{digest,...body}=copy;if(cardDigest(body)!==digest)throw Error('Card copy digest mismatch');
  if(!originalSystem.startsWith(originalPrompt))throw Error('Actual producer does not begin with bound original Card');
  return copy.systemPrompt+(copy.skill?'\n\n实验副本配套 Skill：\n'+copy.skill:'')+renderFewShotCases(copy.fewShotCases)+originalSystem.slice(originalPrompt.length);
}
