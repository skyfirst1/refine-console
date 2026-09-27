import {existsSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {Type} from 'typebox';
import {Check} from 'typebox/value';
import {createExpertCardCopyStore, applyCardCopy, cardDigest, ALIGNER_ROLE, MATCHER_ROLE, type CardCopy, type StoreOptions} from './expert-card-copy-store.js';
import {runAgentTask, type AgentTaskOptions, type AgentTaskResult} from './agent-task-runner.js';
import {settledTrialArtifacts,type TrialEvidenceSource} from './expert-card-trial-evidence.js';
import {fewShotCasesSchema,compactFewShotCasesSchema,expandCompactFewShotCases} from './expert-card-few-shot.js';

export interface EvidenceCatalog {
  sessions:Record<string,string>; defaultSession?:string;
  /** Trusted local registry, never an arbitrary path supplied by the model. */
  artifacts:Record<string,{path:string;sha256:string}>;
  defaultArtifacts:Record<string,string>;
}
/**
 * Optional least-privilege projection for one stage.  An omitted policy keeps
 * the historical, full recovery view for backwards compatibility.  When the
 * policy is present every identifier is denied unless it is named here; the
 * checks are repeated after default/alias resolution so an alternate spelling
 * cannot disclose a hidden object.
 */
export interface ReplayStageVisibility {
  artifactIds?:string[];
  sessionIds?:string[];
  versionIds?:string[];
  cardReadVersions?:string[];
  updateParentVersions?:string[];
  allowDynamicArtifacts?:boolean;
  allowVersionBundles?:boolean;
  allowCreate?:boolean;
}
export interface SeparatedModificationDecisionBinding {
  observationReceiptSha256:string;
  parentVersion:string;
  parentDigest:string;
  /** Present on newly prepared stages; omitted legacy configs remain readable. */
  startStateSha256?:string;
}
export function separatedModificationDecisionToken(binding:SeparatedModificationDecisionBinding) {
  return cardDigest({kind:'separated-modification-decision-token-v1',observationReceiptSha256:binding.observationReceiptSha256,parentVersion:binding.parentVersion,parentDigest:binding.parentDigest,startStateSha256:binding.startStateSha256??null});
}
export interface ReplayRuntimeConfig {
  root:string;source:{roleId:string;systemPrompt:string};storeOptions:StoreOptions;
  evidence:EvidenceCatalog; readOnly?:boolean;
  /** Explicit session default for omitted read version; never used for updates. */
  defaultCardVersion?:string;
  /** Preserve the bound tool schema while disallowing all new actions during feedback. */
  feedbackOnly?:boolean;
  /** Independent observation: expose only this session's explicit source-artifact allowlist. */
  observationOnly?:boolean;
  /** Generate one candidate, then durably pause for operator review before any further request. */
  generationOnly?:boolean;
  settledTrialEvidence?:TrialEvidenceSource;
  stageVisibility?:ReplayStageVisibility;
  /** Enables an explicit, durable no-change decision only for a prepared separated modification stage. */
  separatedModificationDecision?:SeparatedModificationDecisionBinding;
  /** Versioned model interface. Omission preserves historical request contracts. */
  modificationToolContract?:'compact-v1'|'blind-append-v1'|'legacy';
  /** Runtime-only binding. The blind model never receives the parent Card. */
  blindAppendBinding?:{parentVersion:string;parentDigest:string;startStateSha256:string};
}
export function createCardReplayRuntime(config:ReplayRuntimeConfig,execute:(copy:CardCopy,id:string)=>Promise<unknown>) {
  if(config.source.roleId===MATCHER_ROLE&&(!config.generationOnly||config.modificationToolContract!=='blind-append-v1'||config.storeOptions.candidateOnlyRole!==MATCHER_ROLE))throw Error('Matcher runtime permits only explicit blind candidate generation');
  if(config.observationOnly&&(!config.readOnly||Object.keys(config.evidence.sessions).length||config.evidence.defaultSession))throw Error('Observation stage requires readOnly and no session disclosure');
  if(config.evidence.defaultSession&&!Object.hasOwn(config.evidence.sessions,config.evidence.defaultSession))throw Error('Default session is not registered');
  if(config.generationOnly&&(config.readOnly||config.observationOnly||config.feedbackOnly||!config.storeOptions.reviewedCopies||Object.keys(config.storeOptions.reviewedCopies).length))throw Error('Generation stage requires writable isolation and an empty operator review gate');
  const visibility=config.stageVisibility;
  const visibilitySet=(values:string[]|undefined,label:string)=>{const result=new Set(values??[]);if([...result].some(id=>typeof id!=='string'||!id.length)||result.size!==(values??[]).length)throw Error(`Invalid ${label} visibility allowlist`);return result;};
  const visibleArtifacts=visibilitySet(visibility?.artifactIds,'artifact'),visibleSessions=visibilitySet(visibility?.sessionIds,'session'),visibleVersions=visibilitySet(visibility?.versionIds,'version'),visibleCardReads=visibilitySet(visibility?.cardReadVersions,'Card read'),visibleUpdateParents=visibilitySet(visibility?.updateParentVersions,'update parent');
  const decision=config.separatedModificationDecision;
  const compact=config.modificationToolContract==='compact-v1';
  const blind=config.modificationToolContract==='blind-append-v1';
  if(blind){
    const binding=config.blindAppendBinding;
    if(!config.generationOnly||!binding||!/^v\d+$/.test(binding.parentVersion)||! /^[a-f0-9]{64}$/.test(binding.parentDigest)||! /^[a-f0-9]{64}$/.test(binding.startStateSha256)||decision||config.defaultCardVersion||!visibility||visibleCardReads.size||visibleVersions.size||visibleSessions.size||visibleArtifacts.size||visibility.allowCreate||visibility.allowDynamicArtifacts||visibility.allowVersionBundles||visibleUpdateParents.size!==1||!visibleUpdateParents.has(binding.parentVersion)||Object.keys(config.evidence.sessions).length||Object.keys(config.evidence.artifacts).length)throw Error('Blind append requires isolated generation and no parent disclosure routes');
  }else if(config.blindAppendBinding)throw Error('Blind append binding requires its tool contract');
  if(compact&&!decision)throw Error('Compact tools require a bound separated modification stage');
  if(compact&&!decision?.startStateSha256)throw Error('Compact tools require a prepared state binding');
  if(decision){
    const receipt=config.evidence.artifacts.diagnosis;
    if(!config.generationOnly||!visibility||config.defaultCardVersion!==decision.parentVersion||!visibleCardReads.has(decision.parentVersion)||!visibleUpdateParents.has(decision.parentVersion)||!visibleArtifacts.has('diagnosis')||receipt?.sha256!==decision.observationReceiptSha256)throw Error('No-change decision requires a bound separated modification stage');
    if(!/^[a-f0-9]{64}$/.test(decision.observationReceiptSha256)||!/^[a-f0-9]{64}$/.test(decision.parentDigest)||(decision.startStateSha256!==undefined&&!/^[a-f0-9]{64}$/.test(decision.startStateSha256)))throw Error('Invalid separated modification decision digest');
  }
  if(visibility&&config.defaultCardVersion&&!visibleCardReads.has(config.defaultCardVersion))throw Error('Default Card version is outside stage visibility');
  if(visibility&&config.evidence.defaultSession&&!visibleSessions.has(config.evidence.defaultSession))throw Error('Default session is outside stage visibility');
  const assertAccountingClear=async()=>{
    const budgetRoot=config.settledTrialEvidence?.budgetRoot;if(!budgetRoot)throw Error('Scoped execution requires bound accounting');
    const ledger=JSON.parse(readFileSync(resolve(budgetRoot,'provider-budget.json'),'utf8'));
    if(ledger.blocked||ledger.accountingUnknown||Object.keys(ledger.inFlight??{}).length)throw Error('Execution accounting is not clear');
  };
  const assertSeparatedAccountingClear=async()=>{
    if(!config.settledTrialEvidence){if(config.storeOptions.trialAuthorization)throw Error('Separated decision requires bound accounting');return;}
    await assertAccountingClear();
  };
  const store=createExpertCardCopyStore(resolve(config.root,'copies'),config.source,execute,{...config.storeOptions,...(config.storeOptions.allowUnstartedDraftCompletion?{assertDraftAccountingClear:assertAccountingClear}:{}),...(config.storeOptions.trialAuthorization?{assertTrialAccountingClear:assertAccountingClear}:{})});
  const evidence=async(args:{kind:'inventory'|'version'|'session'|'artifact';id?:string;fileName?:string})=>{
    if(config.observationOnly){
      if(args.kind==='inventory'){
        const ids=Object.keys(config.evidence.artifacts).filter(id=>!visibility||visibleArtifacts.has(id));
        const defaults=Object.fromEntries(Object.entries(config.evidence.defaultArtifacts).filter(([alias,id])=>ids.includes(id)&&(!visibility||(visibleArtifacts.has(alias)&&visibleArtifacts.has(id)))));
        return{artifacts:ids,defaultArtifacts:defaults,...(visibility?{stageVisibility:{artifactIds:ids,sessionIds:[],versionIds:[],cardReadVersions:[],updateParentVersions:[],allowDynamicArtifacts:false,allowVersionBundles:false}}:{})};
      }
      if(args.kind!=='artifact')throw Error('Observation stage forbids Card, version and session disclosure');
    }
    const dynamic=!config.observationOnly&&config.settledTrialEvidence&&(!visibility||visibility.allowDynamicArtifacts)?settledTrialArtifacts(await store.snapshot(),config.settledTrialEvidence,config.storeOptions.executionBinding):{artifacts:{},aliases:{},defaults:{}};
    const artifacts={...config.evidence.artifacts,...dynamic.artifacts},defaults={...config.evidence.defaultArtifacts,...dynamic.defaults};
    const state=config.observationOnly?undefined:await store.snapshot();
    const bundles:Record<string,string>={};
    for(const version of Object.keys(state?.versions??{})){
      if(visibility&&(!visibility.allowVersionBundles||!visibleArtifacts.has(`${version}/version-bundle.json`)))continue;
      const runs=Object.values(state!.runs).filter(r=>r.version===version);
      bundles[`${version}/version-bundle.json`]=JSON.stringify({version,card:state!.versions[version],samples:runs,freezes:Object.fromEntries(Object.entries(state!.freezes).filter(([,f])=>f.version===version)),artifacts:Object.keys(artifacts).filter(id=>runs.some(r=>id.startsWith(r.runId+'/')))});
      defaults[version]=`${version}/version-bundle.json`;
    }
    if(args.kind==='inventory'){
      const publicArtifacts=[...Object.keys(artifacts),...Object.keys(bundles)].filter(id=>!visibility||visibleArtifacts.has(id));
      const publicDefaults=Object.fromEntries(Object.entries(defaults).filter(([alias,id])=>publicArtifacts.includes(id)&&(!visibility||(visibleArtifacts.has(alias)&&visibleArtifacts.has(id)))));
      const publicAliases=Object.fromEntries(Object.entries(dynamic.aliases).filter(([alias,id])=>publicArtifacts.includes(id)&&(!visibility||visibleArtifacts.has(alias))));
      if(decision){if(state?.versions[decision.parentVersion]?.digest!==decision.parentDigest)throw Error('No-change parent Card changed');if(decision.startStateSha256&&cardDigest(state)!==decision.startStateSha256)throw Error('Separated modification state changed since preparation');}
      if(compact)return{
        artifacts:publicArtifacts,
        cardAccess:{tool:'expert_card_read'},
        remainingUpdates:(await store.quota()).remainingUpdates,
        completion:{tools:['expert_card_update','expert_card_no_change'],pauseAfterSuccess:true},
      };
      const stageFlags={...(config.generationOnly?{generationOnly:true,pauseAfterCandidate:true,trialsAvailable:false,completionContract:{requiredAction:'expert_card_copy.update',...(decision?{alternativeAction:'expert_card_copy.no-change',requiresMatchingNoChangeReceipt:true}:{}),requiresMatchingCandidateReviewPause:true,proseFinalWithoutReceipt:'generation-incomplete',automaticRetry:false},...(decision?{noChangeAction:{tool:'expert_card_copy',action:'no-change',decisionToken:separatedModificationDecisionToken(decision),requiredFields:['action','decisionToken','reason'],forbiddenFields:['roleId','observationReceiptSha256','parentVersion','parentDigest'],example:{action:'no-change',decisionToken:'<copy inventory.noChangeAction.decisionToken>',reason:'Explain why the available task evidence does not justify changing the parent.'}}}:{})}:{})};
      if(visibility){
        const quota=await store.quota();
        const cardAccess={tool:'expert_card_copy',readAction:'read',allowedReadVersions:[...visibleCardReads],...(config.defaultCardVersion?{defaultReadVersion:config.defaultCardVersion}:{}),evidenceVersionKindAvailable:visibleVersions.size>0,instruction:'Read an allowed Card with expert_card_copy action=read and version=<allowedReadVersion>. Do not use expert_evidence kind=version when evidenceVersionKindAvailable is false.'};
        return{maxUpdates:quota.maxUpdates,remainingUpdates:quota.remainingUpdates,sampleCount:quota.sampleCount,confirmationCount:quota.confirmationCount,...stageFlags,stageVisibility:{artifactIds:publicArtifacts,sessionIds:[...visibleSessions],versionIds:[...visibleVersions],cardReadVersions:[...visibleCardReads],updateParentVersions:[...visibleUpdateParents],allowDynamicArtifacts:visibility.allowDynamicArtifacts===true,allowVersionBundles:visibility.allowVersionBundles===true},cardAccess,...(config.defaultCardVersion?{defaultCardVersion:config.defaultCardVersion}:{}),sessions:Object.keys(config.evidence.sessions).filter(id=>visibleSessions.has(id)),...(config.evidence.defaultSession?{defaultSession:config.evidence.defaultSession}:{}),artifacts:publicArtifacts,artifactAliases:publicAliases,defaultArtifacts:publicDefaults,...(config.storeOptions.trialAuthorization?{updateAuthority:{allowedNewVersions:config.storeOptions.trialAuthorization.allowedNewVersions,requireReadyForTrial:config.storeOptions.trialAuthorization.requireReadyForTrial,allowConfirmation:config.storeOptions.trialAuthorization.allowConfirmation??true,allowedParentVersions:[...visibleUpdateParents]}}:{})};
      }
      return{...await store.quota(),...stageFlags,...(config.storeOptions.allowUnstartedDraftCompletion?{unstartedDraftCompletion:true,draftSupersessions:state?.draftSupersessions??{}}:{}),defaultCardVersion:config.defaultCardVersion,sessions:Object.keys(config.evidence.sessions),defaultSession:config.evidence.defaultSession,artifacts:publicArtifacts,artifactAliases:publicAliases,defaultArtifacts:publicDefaults};
    }
    if(args.kind==='version'){if(visibility&&(!args.id||!visibleVersions.has(args.id)))throw Error('Version is outside stage visibility');const state=await store.snapshot();if(!args.id||!Object.hasOwn(state.versions,args.id))throw Error('Unknown version; use inventory');return{card:await store.card({action:'read',roleId:ALIGNER_ROLE,version:args.id}),samples:Object.values(state.runs).filter(r=>r.version===args.id),freezes:Object.fromEntries(Object.entries(state.freezes).filter(([,f])=>f.version===args.id))};}
    if(args.kind==='session'){const id=args.id??config.evidence.defaultSession;if(visibility&&(!id||!visibleSessions.has(id)))throw Error('Session is outside stage visibility');if(!id||!Object.hasOwn(config.evidence.sessions,id))throw Error('Unknown session; use inventory');return{id,raw:config.evidence.sessions[id]};}
    if(args.kind!=='artifact')throw Error('Unknown evidence kind');
    let id=args.id;
    if(id&&args.fileName){if(id.includes('/'))throw Error('Ambiguous artifact identity');id=`${id}/${args.fileName}`;}
    const requestedId=id;
    if(id&&!Object.hasOwn(artifacts,id)&&!Object.hasOwn(bundles,id))id=dynamic.aliases[id]??defaults[id];
    if(visibility&&(!requestedId||!id||!visibleArtifacts.has(requestedId)||!visibleArtifacts.has(id)))throw Error('Artifact is outside stage visibility');
    if(id&&Object.hasOwn(bundles,id))return{id,raw:bundles[id],generatedFrom:'current-bound-copy-state',sha256:cardDigest(bundles[id])};
    const item=id?artifacts[id]:undefined;
    if(!item)throw Error('Unknown artifact; use an inventory ID or run with a declared default');
    const raw=readFileSync(item.path,'utf8');if(cardDigest(raw)!==item.sha256)throw Error('Artifact changed since registration');return{id,...(requestedId&&dynamic.aliases[requestedId]?{requestedId,aliasOf:id}:{}),raw};
  };
  const card=(args:Parameters<typeof store.card>[0])=>{if(config.observationOnly)throw Error('Observation stage forbids Card access');if(config.feedbackOnly&&args.action!=='read')throw Error('Feedback-only stage forbids Card mutations');const effective=args.action==='read'&&!args.version&&!args.parentVersion&&config.defaultCardVersion?{...args,version:config.defaultCardVersion}:args;if(visibility){if(effective.action==='create'&&!visibility.allowCreate)throw Error('Card creation is outside stage visibility');if(effective.action==='read'&&(!effective.version||!visibleCardReads.has(effective.version)))throw Error('Card read is outside stage visibility');if(effective.action==='update'&&(!effective.parentVersion||!visibleUpdateParents.has(effective.parentVersion)))throw Error('Update parent is outside stage visibility');}return store.card(effective);};
  const append=async(args:{promptAppend:string;badCaseAppend:string})=>{
    const binding=config.blindAppendBinding;
    if(!blind||!binding)throw Error('Blind append is outside this stage');
    await assertSeparatedAccountingClear();
    return store.card({action:'append',roleId:config.source.roleId,...binding,promptAppend:args.promptAppend,badCaseAppend:args.badCaseAppend,readyForTrial:true});
  };
  return{store,evidence,card,append,config,assertSeparatedAccountingClear};
}
export type CardReplayRuntime=ReturnType<typeof createCardReplayRuntime>;

/** A durable stop belongs to this session. It cannot be cleared by a model tool. */
export function createEngineeringStop(path:string) {
  return{
    reject(error:unknown){mkdirSync(dirname(path),{recursive:true});if(!existsSync(path))writeFileSync(path,JSON.stringify({reason:String(error),at:new Date().toISOString()}));},
    assertClear(){if(existsSync(path))throw Error(`Engineering stop: ${readFileSync(path,'utf8')}`);},
  };
}

/** Register one stable tool contract; current quotas and IDs live in inventory, not schema. */
export function registerCardReplayTools(sdk:any,runtime:CardReplayRuntime,stopPath:string) {
  const compact=runtime.config.modificationToolContract==='compact-v1';
  const blind=runtime.config.modificationToolContract==='blind-append-v1';
  const engineeringStop=createEngineeringStop(stopPath),pausePath=resolve(dirname(stopPath),'candidate-review-pause.json'),noChangePath=resolve(dirname(stopPath),'modification-no-change-receipt.json');
  const plannedPause=()=>runtime.config.generationOnly&&(existsSync(pausePath)||existsSync(noChangePath));
  const stop={reject(error:unknown){if(!plannedPause())engineeringStop.reject(error);},assertClear(){engineeringStop.assertClear();if(existsSync(pausePath))throw Error('Planned candidate review pause: '+readFileSync(pausePath,'utf8'));if(existsSync(noChangePath))throw Error('Planned no-change decision pause: '+readFileSync(noChangePath,'utf8'));}};
  const register=(definition:any)=>sdk.registerTool({...definition,execute:async(id:string,args:any)=>{
    stop.assertClear();try{if((compact||blind)&&!Check(definition.parameters,args))throw Error(`Invalid ${definition.name} fields`);return{content:[{type:'text',text:JSON.stringify(await definition.run(args))}],details:{}};}catch(error){stop.reject(error);throw error;}
  }});
  const role=Type.Optional(Type.Literal(ALIGNER_ROLE));
  const boundRole=(args:any)=>{const roleId=args.roleId??runtime.config.source.roleId;if(roleId!==ALIGNER_ROLE||runtime.config.source.roleId!==ALIGNER_ROLE)throw Error('Role is not allowed');return{...args,roleId};};
  const separatedReadHelp=runtime.config.separatedModificationDecision?` This stage exposes one parent Card. Read it with action=read and version=${runtime.config.separatedModificationDecision.parentVersion}.`:'';
  const defaultRead=(runtime.config.defaultCardVersion?'Read may omit version only to use declared defaultCardVersion from inventory.':'Read requires an existing version; no default Card is configured.')+separatedReadHelp;
  const draftHelp=runtime.config.storeOptions.allowUnstartedDraftCompletion?' An update creates an immutable candidate; submit the complete systemPrompt and skill together when both change. Only the latest parent with no trial records or freezes can be completed by a successor before sampling; any started trial keeps the complete-batch gate.':'';
  const structuredHelp=' fewShotCases stores structured synthetic inputs and explanations exactly as supplied. Omission inherits; [] clears; nonempty replaces. References use zero-based evidenceIndex and exact quotedText from that side. Structural validation does not certify prose, labels or independence. The shared renderer appends JSON without rewriting it; you must remove obsolete cases/rules from your own systemPrompt/skill.';
  const generationHelp=runtime.config.generationOnly?' This is a generation-only stage: no trial tool. Completion requires one effective expert_card_copy update followed by its matching durable candidate-review pause. A prose final without a verified action receipt is generation-incomplete. automaticRetry=false. A successful candidate update returns its result then durably pauses before any further tool/provider request for independent review.':'';
  const decisionHelp=runtime.config.separatedModificationDecision?' Available actions here are read, update, and no-change. For no-change, first read inventory and copy inventory.noChangeAction.decisionToken. Use exactly {"action":"no-change","decisionToken":"<copied token>","reason":"<evidence-based reason>"}. Do not add roleId or digest/version fields. A successful update or no-change writes its durable receipt and pauses; prose alone does not complete the stage.':'';
  const recordNoChange=async(args:any)=>{const binding=runtime.config.separatedModificationDecision;if(!binding)throw Error('No-change is outside this stage');const keys=Object.keys(args).sort();if(JSON.stringify(keys)!==JSON.stringify(['action','decisionToken','reason']))throw Error('Invalid no-change decision fields');if(args.action!=='no-change'||args.decisionToken!==separatedModificationDecisionToken(binding)||typeof args.reason!=='string'||!args.reason.trim())throw Error('No-change decision token does not match the prepared stage binding');await runtime.assertSeparatedAccountingClear();await runtime.evidence({kind:'artifact',id:'diagnosis'});const state=await runtime.store.snapshot();if(binding.startStateSha256&&cardDigest(state)!==binding.startStateSha256)throw Error('Separated modification state changed since preparation');const parent=await runtime.card({action:'read',roleId:runtime.config.source.roleId,version:binding.parentVersion});if(parent.digest!==binding.parentDigest)throw Error('No-change parent Card changed');const body={kind:'separated-modification-no-change',observationReceiptSha256:binding.observationReceiptSha256,parentVersion:binding.parentVersion,parentDigest:binding.parentDigest,reason:args.reason};if(existsSync(noChangePath)){const existing=JSON.parse(readFileSync(noChangePath,'utf8'));const {at:_,...prior}=existing;if(cardDigest(prior)!==cardDigest(body))throw Error('No-change receipt already differs');return existing;}mkdirSync(dirname(noChangePath),{recursive:true});const receipt={...body,at:new Date().toISOString()};writeFileSync(noChangePath,JSON.stringify(receipt,null,2),{flag:'wx'});return receipt;};
  const pauseForReview=(copy:CardCopy)=>{
    mkdirSync(dirname(pausePath),{recursive:true});
    writeFileSync(pausePath,JSON.stringify({kind:'planned-candidate-review-pause',version:copy.version,copyDigest:copy.digest,fewShotCasesSha256:cardDigest(copy.fewShotCases??[]),reason:'Candidate saved successfully. Stop before any further tool/provider request; operator review is required, not yet passed.',at:new Date().toISOString()},null,2),{flag:'wx'});
  };
  if(blind){
    register({name:'expert_card_append',label:'Append teaching increments',description:'仅提交两个增量字符串：promptAppend 写通用判断原则；badCaseAppend 以真实任务输入与示范作答为主体，遵守原业务输出合同，不写审查报告。依据仅支持局部时给明确的局部对照，不补造完整标签。运行时原样保留未展示的父 Card 与旧案例，保存后暂停，等待验收。',parameters:Type.Object({promptAppend:Type.String({minLength:1}),badCaseAppend:Type.String({minLength:1})},{additionalProperties:false}),run:async(args:{promptAppend:string;badCaseAppend:string})=>{
      const binding=runtime.config.blindAppendBinding!;
      const copy=await runtime.append(args);
      const parent=await runtime.store.card({action:'read',roleId:runtime.config.source.roleId,version:binding.parentVersion});
      const proof={parentVersion:parent.version,parentDigest:parent.digest,version:copy.version,copyDigest:copy.digest,parentPromptPreserved:copy.systemPrompt===parent.systemPrompt+'\n\n'+args.promptAppend+'\n\n'+args.badCaseAppend,skillPreserved:copy.skill===parent.skill,fewShotCasesPreserved:JSON.stringify(copy.fewShotCases)===JSON.stringify(parent.fewShotCases),reasonPreserved:copy.reason===parent.reason,promptAppendSha256:cardDigest(args.promptAppend),badCaseAppendSha256:cardDigest(args.badCaseAppend)};
      if(!proof.parentPromptPreserved||!proof.skillPreserved||!proof.fewShotCasesPreserved||!proof.reasonPreserved)throw Error('Blind append inheritance failed');
      const incrementPath=resolve(dirname(stopPath),'card-increments.json');
      writeFileSync(incrementPath,JSON.stringify(args,null,2),{flag:'wx'});
      const receiptPath=resolve(dirname(stopPath),'card-append-receipt.json');
      writeFileSync(receiptPath,JSON.stringify({...proof,incrementPath},null,2),{flag:'wx'});
      pauseForReview(copy);
      return{status:'candidate-saved-awaiting-review',version:copy.version,copyDigest:copy.digest,incrementPath,receiptPath};
    }});
  }else if(compact){
    const binding=runtime.config.separatedModificationDecision!;
    const boundParent=async()=>{
      await runtime.assertSeparatedAccountingClear();
      await runtime.evidence({kind:'artifact',id:'diagnosis'});
      const state=await runtime.store.snapshot();
      if(binding.startStateSha256&&cardDigest(state)!==binding.startStateSha256)throw Error('Separated modification state changed since preparation');
      const parent=await runtime.card(boundRole({action:'read',version:binding.parentVersion}));
      if(parent.digest!==binding.parentDigest)throw Error('Separated modification parent Card changed');
      return parent;
    };
    register({name:'expert_card_read',label:'Read parent Card',description:'Read the bound parent implementation and complete cases. Historical change reasons are omitted.',parameters:Type.Object({},{additionalProperties:false}),run:async()=>{
      const {systemPrompt,skill,fewShotCases}=await boundParent();
      return{systemPrompt,skill,...(fewShotCases!==undefined?{fewShotCases}:{})};
    }});
    register({name:'expert_card_update',label:'Submit candidate Card',description:'Save one immutable successor and pause for review. Provide a reason and changed content. Omitted fields inherit; empty cardSkill or cases clears them. cardSkill is Card text, not the task boundary Skill. Cases need full texts and exact same-side quotes.',parameters:Type.Object({systemPrompt:Type.Optional(Type.String()),cardSkill:Type.Optional(Type.String()),fewShotCases:Type.Optional(compactFewShotCasesSchema),reason:Type.String({minLength:1})},{additionalProperties:false}),run:async(args:any)=>{
      const parent=await boundParent();
      if(!args.reason.trim())throw Error('A nonempty change reason is required');
      const fields={...(args.systemPrompt!==undefined?{systemPrompt:args.systemPrompt}:{}),...(args.cardSkill!==undefined?{skill:args.cardSkill}:{}),...(args.fewShotCases!==undefined?{fewShotCases:expandCompactFewShotCases(args.fewShotCases)}:{})};
      if(!Object.keys(fields).length||Object.entries(fields).every(([key,value])=>cardDigest(value)===cardDigest((parent as any)[key]??(key==='fewShotCases'?[]:''))))throw Error('Update requires changed content');
      const copy=await runtime.card(boundRole({action:'update',parentVersion:binding.parentVersion,...fields,reason:args.reason,readyForTrial:true}));
      pauseForReview(copy);
      return{status:'candidate-saved-awaiting-review'};
    }});
    register({name:'expert_card_no_change',label:'Record no change',description:'Save the evidence-based reason for keeping the parent and end this stage.',parameters:Type.Object({reason:Type.String({minLength:1})},{additionalProperties:false}),run:async(args:any)=>{
      await recordNoChange({action:'no-change',decisionToken:separatedModificationDecisionToken(binding),reason:args.reason});
      return{status:'no-change-decision-recorded'};
    }});
  }else if(!runtime.config.observationOnly){
  const separatedParameters=runtime.config.separatedModificationDecision?Type.Union([
    Type.Object({action:Type.Literal('read'),roleId:role,version:Type.Optional(Type.String())},{additionalProperties:false}),
    Type.Object({action:Type.Literal('update'),roleId:role,parentVersion:Type.String(),systemPrompt:Type.Optional(Type.String()),skill:Type.Optional(Type.String()),reason:Type.String({minLength:1}),readyForTrial:runtime.config.storeOptions.trialAuthorization?.requireReadyForTrial?Type.Literal(true):Type.Optional(Type.Boolean()),fewShotCases:Type.Optional(fewShotCasesSchema)},{additionalProperties:false}),
    Type.Object({action:Type.Literal('no-change'),decisionToken:Type.String({pattern:'^[a-f0-9]{64}$'}),reason:Type.String({minLength:1})},{additionalProperties:false}),
  ],{type:'object'}):undefined;
  const generalParameters=Type.Object({action:Type.Union(['create','read','update'].map(x=>Type.Literal(x))),roleId:role,version:Type.Optional(Type.String()),parentVersion:Type.Optional(Type.String()),systemPrompt:Type.Optional(Type.String()),skill:Type.Optional(Type.String()),reason:Type.Optional(Type.String()),readyForTrial:Type.Optional(Type.Boolean()),fewShotCases:Type.Optional(fewShotCasesSchema)},{additionalProperties:false});
  const separatedDescription=`Separated modification stage. ${defaultRead} Update requires the authorized parentVersion, an evidence-based reason, and at least one changed field; omitted content fields inherit. If inventory requires readyForTrial, pass true with the complete candidate. fewShotCases, when used, must contain complete synthetic inputs and exact same-side quotes. The update is immutable and pauses for review.${decisionHelp}`;
  register({name:'expert_card_copy',label:runtime.config.separatedModificationDecision?'Read, update, or record no change':'Read or update experimental Card',description:runtime.config.separatedModificationDecision?separatedDescription:defaultRead+' Update requires an EXISTING immutable parentVersion, never the desired new version; the read default never supplies an update parent. Any existing version, including v0, may be named explicitly as parent; this creates a new version and does not modify or trial the parent. Prior-batch gates are global, not a requirement to use the latest parent: inventory.updatePrerequisites reports whether v0 and the latest version have complete settled batches. Quota, unresolved execution and authorization gates still apply. roleId may be omitted only for this runtime bound single role. Omitted systemPrompt or skill inherits; explicit empty skill clears it. Supply a reason and at least one field. Identical updates are idempotent. If inventory requires readyForTrial, explicitly submit true with the complete candidate in one update; omission/false creates an unsubmitted draft. Readiness is immutable and says nothing about quality; a draft needs a new successor, consuming another slot. Read inventory for live authority, quota and versions.'+draftHelp+structuredHelp+generationHelp,parameters:separatedParameters??generalParameters,run:async(args:any)=>{if(args.action==='no-change')return recordNoChange(args);if(runtime.config.readOnly&&args.action!=='read')throw Error('This session is read-only');const copy=await runtime.card(boundRole(args));if(runtime.config.generationOnly&&args.action==='update'&&runtime.config.storeOptions.trialAuthorization?.allowedNewVersions.includes(copy.version)){mkdirSync(dirname(pausePath),{recursive:true});if(!existsSync(pausePath))writeFileSync(pausePath,JSON.stringify({kind:'planned-candidate-review-pause',version:copy.version,copyDigest:copy.digest,fewShotCasesSha256:cardDigest(copy.fewShotCases??[]),reason:'Candidate saved successfully. Stop before any further tool/provider request; operator review is required, not yet passed.',at:new Date().toISOString()},null,2));}return copy;}});
  if(!runtime.config.generationOnly){
  register({name:'expert_trial',label:'Read or generate bound samples',description:'Sample completes only unexecuted identities in a version batch. New requests require the version and lineage allowed by inventory trialAuthorization and any required readyForTrial submission; superseded drafts cannot start trials. Already settled identities return cached results without new payment. roleId may be omitted only for this runtime bound single role. Settled parse failures count as attempted samples, not successful judgments, and are never rerun. Unknown/running accounting stops the batch. Confirm obeys the same authority, freezes selectionId to one version and allocates its own identities. Read inventory for remaining quota.',parameters:Type.Object({action:Type.Union([Type.Literal('sample'),Type.Literal('confirm')]),roleId:role,version:Type.String(),selectionId:Type.Optional(Type.String())},{additionalProperties:false}),run:async(args:any)=>{if(runtime.config.readOnly||runtime.config.feedbackOnly)throw Error('This session forbids new trials');args=boundRole(args);let result;if(args.action==='sample')result=await runtime.store.sample(args);else{if(!args.selectionId)throw Error('selectionId required for confirmation');result=await runtime.store.confirm(args);}if(result.some(r=>!r.status.startsWith('settled-')))stop.reject('Execution not settled; inspect checkpoint');return result;}});
  }
  }
  const policy=runtime.config.stageVisibility;
  const hasSessions=!runtime.config.observationOnly&&Object.keys(runtime.config.evidence.sessions).length>0&&(!policy||(policy.sessionIds?.length??0)>0);
  const hasVersions=!policy||(policy.versionIds?.length??0)>0;
  const hasArtifacts=!policy||(policy.artifactIds?.length??0)>0;
  const kinds=runtime.config.observationOnly?['inventory',...(hasArtifacts?['artifact']:[])]:['inventory',...(hasVersions?['version']:[]),...(hasSessions?['session']:[]),...(hasArtifacts?['artifact']:[])];
  const idOptionalKinds=['inventory',...(hasSessions&&runtime.config.evidence.defaultSession?['session']:[])];
  const sessionHelp=hasSessions?(runtime.config.evidence.defaultSession?'session may omit id only to read declared defaultSession.':'session requires an explicit inventory id; no default session is configured.'):'No session reading is available.';
  const cardRouteHelp=!runtime.config.observationOnly&&!hasVersions&&(runtime.config.stageVisibility?.cardReadVersions?.length??0)>0?' This stage intentionally does not support kind=version. Do not use expert_evidence to read a Card; use expert_card_copy with action=read and an allowed version from inventory.cardAccess.allowedReadVersions.':'';
  const description=compact?'Read inventory for artifact IDs, then read each artifact by id. The parent Card has its own read tool.':runtime.config.observationOnly?'Read only explicitly registered source artifacts. inventory lists exact IDs and defaults. artifact requires id. No Card, version, session or arbitrary filesystem access.':runtime.config.separatedModificationDecision?'Read this stage\'s registered evidence. Start with inventory: it lists exact artifact IDs, the parent-Card route, update authority, completion rules, and noChangeAction with the token required for no-change. Read an artifact with one exact inventory ID. Cards are read only through expert_card_copy; version, session, bundle, alias, and arbitrary-path reads are unavailable.':'inventory lists available IDs, explicit defaults and aliases. '+sessionHelp+' artifact and version require id. For artifact, use one complete inventory ID or an explicitly listed default/alias ID. To read two artifacts, make two separate calls. Do not append names or supply filesystem paths.'+cardRouteHelp+(hasVersions?' version returns immutable Card, raw results and accounting status.':'')+' Stored actual-request artifacts describe their recorded run only, not current tool or renderer capabilities; a field absent from an older version does not establish that it is unsupported now.';
  if(!blind)register({name:'expert_evidence',label:'Read registered experiment evidence',description,parameters:Type.Object({kind:Type.Union(kinds.map(x=>Type.Literal(x))),id:Type.Optional(Type.String({minLength:1}))},{additionalProperties:false,anyOf:[{properties:{kind:{enum:idOptionalKinds}}},{required:['id']}]}),run:runtime.evidence});
  // Includes schema-validation failures that happen before a tool's execute callback.
  sdk.on('tool_execution_end',(event:any)=>{if(event.isError)stop.reject(event.result??'Tool execution failed');});
  sdk.on('before_provider_request',(_event:any,ctx:any)=>{try{stop.assertClear();}catch(error){ctx.abort();throw error;}});
  sdk.on('session_start',()=>sdk.setActiveTools(blind?['expert_card_append']:compact?['expert_card_read','expert_card_update','expert_card_no_change','expert_evidence']:runtime.config.observationOnly?['expert_evidence']:runtime.config.readOnly||runtime.config.generationOnly?['expert_card_copy','expert_evidence']:['expert_card_copy','expert_trial','expert_evidence']));
  return stop;
}

/** Restore paid provider history once, rather than appending the original user a second time. */
export function mergeResumeMessages(prefix:any[],fresh:any[],system:string,runtime:string,authorizedContinuationMessage?:string):any[] {
  const text=(c:any)=>{if(typeof c==='string')return c;if(!Array.isArray(c)||c.some(b=>b.type!=='text'||typeof b.text!=='string'))throw Error('Unsupported resume content');return c.map(b=>b.text).join('');};
  const users=(m:any[])=>m.filter(x=>x.role==='user');
  const prefixUsers=users(prefix);
  if(prefixUsers.length!==(authorizedContinuationMessage?2:1)||text(prefixUsers[0]?.content)!==runtime)throw Error('Resume prefix must contain exactly the original user and any bound new authorization');
  if(authorizedContinuationMessage&&(authorizedContinuationMessage===runtime||text(prefixUsers[1].content)!==authorizedContinuationMessage))throw Error('Unbound or repeated continuation authorization');
  if(prefix.filter(x=>x.role==='system').length!==1||prefix[0]?.content!==system)throw Error('Resume system binding changed');
  if(fresh[0]?.role!=='system'||fresh[0]?.content!==system||fresh[1]?.role!=='user'||text(fresh[1].content)!==runtime||users(fresh).length!==1)throw Error('Fresh session input differs or duplicates user');
  return[...prefix,...fresh.slice(2)];
}
export function installReplayResume(sdk:any,options:{system:string;runtime:string;prefix?:any[];authorizedContinuationMessage?:string;pendingPath:string;stopPath:string}) {
  const stop=createEngineeringStop(options.stopPath);
  sdk.on('before_agent_start',()=>({systemPrompt:options.system}));
  // The runtime's @file transport may wrap the original prompt. Restore that single authorized input.
  sdk.on('context',(event:any)=>{if(event.messages.filter((m:any)=>m.role==='user').length!==1){stop.reject('Repeated user in fresh session');throw Error('Repeated user in fresh session');}return{messages:event.messages.map((m:any)=>m.role==='user'?{...m,content:[{type:'text',text:options.runtime}]}:m)};});
  sdk.on('before_provider_request',(event:any,ctx:any)=>{try{
    stop.assertClear();const payload=event.payload;
    const messages=options.prefix?mergeResumeMessages(options.prefix,payload.messages,options.system,options.runtime,options.authorizedContinuationMessage):mergeResumeMessages(payload.messages.slice(0,2),payload.messages,options.system,options.runtime);
    const result={...payload,messages};writeFileSync(options.pendingPath,JSON.stringify(result,null,2));return result;
  }catch(error){stop.reject(error);ctx.abort();throw error;}});
}

/** Copy-bound effective request is also the cache identity; don't reuse the original Card digest. */
export function bindCardReplayRequest<T extends {systemPrompt:string;prompt:string}>(original:T,sourcePrompt:string,copy:CardCopy) {
  const request={...original,systemPrompt:applyCardCopy(original.systemPrompt,sourcePrompt,copy)};
  const producer={version:copy.version,copyDigest:copy.digest,systemSha256:cardDigest(request.systemPrompt),promptSha256:cardDigest(request.prompt),requestSha256:cardDigest(request)};
  return{request,producer,cacheKey:producer.requestSha256};
}

/** Common real Agent entry: explicit tools, new session, no inherited CLI adapter. */
export async function runCardReplaySession(options:AgentTaskOptions,runner:(o:AgentTaskOptions)=>Promise<AgentTaskResult>=runAgentTask) {
  if(!options.session||options.session.requireExisting)throw Error('Replay restoration requires a new isolated session plus bound provider prefix');
  if(existsSync(options.session.dir))throw Error('Use a fresh session directory; do not append paid history');
  mkdirSync(options.session.dir,{recursive:true});
  return runner({...options,tools:options.tools==='card-replay-compact'?'card-replay-compact':options.tools==='card-replay-append'?'card-replay-append':'card-replay'});
}
