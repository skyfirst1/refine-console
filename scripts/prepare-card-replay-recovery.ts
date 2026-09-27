import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {applyCardCopy,cardDigest,type ExecutionReceipt} from '../src/expert-card-copy-store.js';
import {importLegacyCopyState,receiptFromLegacyEvidence,writeRecoveryState} from '../src/expert-card-replay-recovery.js';
import {createCardReplayRuntime,mergeResumeMessages,runCardReplaySession} from '../src/expert-card-replay-runtime.js';
import {beginReplayAssessment,finishReplayAssessment} from '../src/expert-card-replay-completion.js';
import {parseAgentTaskEvents,type AgentTaskResult} from '../src/agent-task-runner.js';
import {writeObservationReceipt,type ObservationReceiptInput} from '../src/expert-card-trial-evidence.js';

const read=(p:string)=>readFileSync(p,'utf8'),json=(p:string)=>JSON.parse(read(p));
const text=(c:any)=>typeof c==='string'?c:c.map((x:any)=>{assert.equal(x.type,'text');return x.text;}).join('');

export interface SeparatedStageArtifact {path:string;sha256:string;scope:string}
export interface SeparatedStageCommon {baseConfig:any;outputRoot:string;system:string;prompt:string;allowProvider?:boolean}

const separatedStageGuidance={
  diagnosis:`## 输入与视野

- 先读 inventory；第一轮并行读取完成任务所需的全部注册材料。
- 完整文稿只给 Harness 提供诊断背景。已结算 Expert 投影只表示该次局部调用实际收到的输入；不得用 Harness 的全文视野替 Expert 补足输入。

## 职责与依据

- 分开记录：材料直接证明的局部问题、材料直接证明的正常行为、证据不足而不能定性的事项。
- 每项引用任务边界和实际读取来源。Skill 中的例子不是穷尽条件；信息不足保持 unknown。
- Description 的全篇写作目标只有在能说明其适用于当前局部单位时才参与判断，不能自动扩成局部硬否决条件。

## 交付边界

只冻结可核查观察与不确定性。不要产出 Gold、Card 补丁、当前 pair 的预期答案、few-shot 或修复案例。`,
  modification:`## 输入与视野

- 先读 inventory，再读取任务所需的注册材料；expert_card_read 返回本阶段唯一 parent 的实现和完整案例。
- Harness 可读的全文不等于原 Expert 的视野；冻结观察不是 Gold。

## 职责与依据

- 先从任务边界和可见材料独立列出 task-derived requirements 与 unknown，再核对 parent。
- 将影响决定的 parent 规则标为 supported、unsupported 或 unknown，并给外部依据。parent 文字、parent few-shot、未找到反例都不能证明 parent 正确。
- Skill 的例子不是穷尽条件。信息不足保持 unknown，不得推出当前 pair 标签或宣称 parent 合规。
- Description 的全篇写作目标不能自动扩成当前局部单位的硬否决条件。

## 可用动作与完成条件

- expert_card_update：提交有任务依据的完整修改及理由。cardSkill 是待改 Card 的辅助文字，与任务边界 Skill 不同。
- expert_card_no_change：是正常决定；理由说明为何现有依据不足以支持修改，保留未决项，不据此推出当前 pair 标签或 parent 合规。
- 两种提交成功后均保存决定并结束本阶段；纯文字 final 不算完成。

仅在边界有正面依据时生成少量独立合成 few-shot；不得写入当前 pair 答案、操作方补丁、上一轮具体案例或诊断措辞。`
} as const;

function separatedSystem(system:string,name:keyof typeof separatedStageGuidance,compact:boolean){
  let guidance=separatedStageGuidance[name] as string;
  if(name==='modification'&&!compact)guidance=guidance.replace('expert_card_read','expert_card_copy action=read').replace('expert_card_update','expert_card_copy action=update').replace('cardSkill','skill').replace('expert_card_no_change','expert_card_copy action=no-change')+'\n旧版接口：从 inventory.noChangeAction.decisionToken 复制 token；no-change 只传 action、decisionToken 和 reason。';
  return `${system.trim()}\n\n${guidance}`;
}
function separatedPrompt(prompt:string,name:keyof typeof separatedStageGuidance){return `## 本阶段任务\n\n${prompt.trim()}\n\n## 成功条件\n\n${name==='diagnosis'?'完成必要读取后，提交带来源的三类观察与不确定性。':'完成必要读取与 parent 核对，提交修改或保持原样的决定。'}`;}

function bindSeparatedAccounting(baseConfig:any,runtime:any) {
  if(!runtime.storeOptions?.trialAuthorization)return{baseConfig,runtime};
  const execution=baseConfig.expertExecution;
  assert(execution,'Trial-authorized separated modification requires bound expertExecution accounting evidence');
  assert.equal(resolve(execution.root),resolve(runtime.root),'Separated expertExecution root mismatch');
  assert.equal(resolve(execution.budgetRoot),resolve(baseConfig.budgetRoot),'Separated expertExecution budget root mismatch');
  assert.equal(execution.sourcePrompt,runtime.source.systemPrompt,'Separated expertExecution source Card mismatch');
  assert.equal(resolve(execution.budgetGuardPath),resolve(baseConfig.budgetGuardPath),'Separated budget guard mismatch');
  assert.equal(resolve(execution.providerExtension),resolve(baseConfig.providerExtension),'Separated provider extension mismatch');
  assert.equal(execution.providerOrigin,baseConfig.providerOrigin,'Separated provider origin mismatch');
  const statePath=resolve(runtime.root,'copies/state.json'),ledgerPath=resolve(execution.budgetRoot,'provider-budget.json'),eventsPath=resolve(execution.budgetRoot,'provider-events.jsonl');
  const state=json(statePath),ledger=json(ledgerPath),events=read(eventsPath).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  assert(!ledger.blocked&&!ledger.accountingUnknown&&!Object.keys(ledger.inFlight??{}).length,'Separated accounting is unresolved');
  const baseline=Object.values<any>(state.runs).find(run=>run.version==='v0'&&run.status==='settled-success'&&run.receipt?.status==='settled');
  assert(baseline,'Separated modification requires an existing settled v0 baseline');
  const requestId=Number(baseline.receipt.requestId),phase=`${execution.phasePrefix}-${baseline.runId}`;
  assert(Number.isSafeInteger(requestId)&&requestId>0,'Invalid settled baseline request identity');
  assert.equal(events.filter((event:any)=>event.type==='admit'&&event.id===requestId&&event.phase===phase).length,1,'Missing unique baseline admission');
  const settlements=events.filter((event:any)=>event.type==='settled'&&event.id===requestId&&event.phase===phase);assert.equal(settlements.length,1,'Missing unique baseline settlement');
  assert.equal(settlements[0].actual.costUsd,baseline.receipt.costUsd);assert.equal(settlements[0].actual.totalTokens,baseline.receipt.totalTokens);
  const providerRequestPath=resolve(execution.budgetRoot,`provider-request-${String(requestId).padStart(6,'0')}.json`),trialRequestPath=resolve(execution.root,'trials',baseline.runId,'actual-request.json');
  assert.deepEqual(json(providerRequestPath),json(trialRequestPath),'Settled baseline request binding changed');
  const baselineOptions=json(execution.baselineOptionsPath),baselineRequest=json(execution.baselineRequestPath);
  assert(baselineOptions.systemPrompt.startsWith(execution.sourcePrompt),'Baseline options do not begin with the source Card');
  assert.equal(baselineRequest.messages?.[0]?.role,'system');assert.equal(baselineRequest.messages[0].content,baselineOptions.systemPrompt);
  const paths=[statePath,ledgerPath,eventsPath,execution.baselineOptionsPath,execution.baselineRequestPath,providerRequestPath,trialRequestPath,execution.budgetGuardPath,execution.providerExtension];
  const bindings=new Map<string,string>((baseConfig.bindings??[]).map((item:any)=>[resolve(item.path),item.sha256]));
  for(const path of paths)bindings.set(resolve(path),cardDigest(read(path)));
  const evidence={kind:'settled-v0-baseline-accounting-binding',runId:baseline.runId,requestId:String(requestId),phase,copyDigest:baseline.copyDigest,providerRequestPath,providerRequestSha256:cardDigest(read(providerRequestPath)),ledgerPath,ledgerSha256:cardDigest(read(ledgerPath)),eventsPath,eventsSha256:cardDigest(read(eventsPath))};
  return{baseConfig:{...baseConfig,expertExecution:execution,separatedAccountingEvidence:evidence,bindings:[...bindings].map(([path,sha256])=>({path,sha256}))},runtime:{...runtime,settledTrialEvidence:execution}};
}

function freshStageConfig(common:SeparatedStageCommon,runtime:any,name:keyof typeof separatedStageGuidance) {
  if(common.baseConfig.prefix||common.baseConfig.authorizedContinuationMessage)throw Error('Separated stages require a fresh session without paid/history prefix');
  const config={...common.baseConfig,runtime,system:separatedSystem(common.system,name,runtime.modificationToolContract==='compact-v1'),prompt:separatedPrompt(common.prompt,name),sessionOutputRoot:resolve(common.outputRoot,name),prefix:undefined,authorizedContinuationMessage:undefined,allowPaidProvider:common.allowProvider===true};
  mkdirSync(common.outputRoot,{recursive:true});const path=resolve(common.outputRoot,`${name}-config.json`);writeFileSync(path,JSON.stringify(config,null,2));return{config,path,sha256:cardDigest(read(path))};
}

/** Prepare an observation-only S1 session. The Card remains bound locally but no Card tool or state view exists. */
export function prepareSeparatedObservationStage(common:SeparatedStageCommon,artifacts:Record<string,SeparatedStageArtifact>) {
  const catalog=Object.fromEntries(Object.entries(artifacts).map(([id,item])=>[id,{path:item.path,sha256:item.sha256}]));
  const runtime={root:resolve(common.outputRoot,'diagnosis-shadow'),source:common.baseConfig.runtime.source,storeOptions:{},readOnly:true,observationOnly:true,evidence:{sessions:{},artifacts:catalog,defaultArtifacts:{}},stageVisibility:{artifactIds:Object.keys(catalog),sessionIds:[],versionIds:[],cardReadVersions:[],updateParentVersions:[],allowDynamicArtifacts:false,allowVersionBundles:false}};
  return freshStageConfig(common,runtime,'diagnosis');
}

function evidenceArtifactReads(eventsPath:string):string[] {
  const ids:string[]=[];
  for(const line of read(eventsPath).split(/\r?\n/).filter(Boolean)){const event=JSON.parse(line);if(event.type!=='message_end'||event.message?.role!=='assistant')continue;for(const part of event.message.content??[])if(part.type==='toolCall'&&part.name==='expert_evidence'&&part.arguments?.kind==='artifact'&&typeof part.arguments.id==='string'&&!ids.includes(part.arguments.id))ids.push(part.arguments.id);}
  return ids;
}

/** Freeze the exact public S1 text plus the evidence IDs actually read from its event stream. */
export function freezeSeparatedObservation(configPath:string,result:Pick<AgentTaskResult,'finalText'|'rawEventsPath'>,citations:ObservationReceiptInput['citations'],uncertainties:ObservationReceiptInput['uncertainties']) {
  const config=json(configPath),registered=config.runtime.evidence.artifacts as Record<string,{path:string;sha256:string}>,actualReadIds=evidenceArtifactReads(result.rawEventsPath);
  const sources=Object.fromEntries(actualReadIds.map(id=>{const item=registered[id];if(!item)throw Error('Diagnosis read an artifact outside its frozen catalog');const raw=read(item.path);if(cardDigest(raw)!==item.sha256)throw Error('Diagnosis source changed');return[id,{raw,sha256:item.sha256,scope:`registered diagnosis artifact ${id}`}];}));
  return writeObservationReceipt(resolve(dirname(configPath),'diagnosis-receipt.json'),{observationText:result.finalText,sources,actualReadIds,citations,uncertainties});
}

/** Prepare a new S2 session that sees only the receipt, current sources and one authorized parent Card. */
export function prepareSeparatedModificationStage(common:SeparatedStageCommon,input:{artifacts:Record<string,SeparatedStageArtifact>;receiptPath:string;receiptSha256:string;parentVersion:string}) {
  const receiptRaw=read(input.receiptPath);assert.equal(cardDigest(receiptRaw),input.receiptSha256,'Observation receipt changed');const receipt=JSON.parse(receiptRaw);assert.equal(receipt.kind,'frozen-observation-receipt');assert.equal(receipt.epistemicStatus,'model-observation-not-gold');
  const catalog={...Object.fromEntries(Object.entries(input.artifacts).map(([id,item])=>[id,{path:item.path,sha256:item.sha256}])),diagnosis:{path:input.receiptPath,sha256:input.receiptSha256}};
  const base=common.baseConfig.runtime;
  const state=json(resolve(base.root,'copies/state.json')),parent=state.versions?.[input.parentVersion];assert(parent&&parent.digest,'Unknown separated modification parent');const {digest,...parentBody}=parent;assert.equal(cardDigest(parentBody),digest,'Separated modification parent digest mismatch');
  const runtime={...base,readOnly:false,observationOnly:false,feedbackOnly:false,generationOnly:true,defaultCardVersion:input.parentVersion,settledTrialEvidence:undefined,evidence:{sessions:{},artifacts:catalog,defaultArtifacts:{}},stageVisibility:{artifactIds:Object.keys(catalog),sessionIds:[],versionIds:[],cardReadVersions:[input.parentVersion],updateParentVersions:[input.parentVersion],allowDynamicArtifacts:false,allowVersionBundles:false,allowCreate:false},separatedModificationDecision:{observationReceiptSha256:input.receiptSha256,parentVersion:input.parentVersion,parentDigest:digest,startStateSha256:cardDigest(state)}};
  const bound=bindSeparatedAccounting(common.baseConfig,runtime);
  bound.runtime.modificationToolContract=base.modificationToolContract??'compact-v1';
  return freshStageConfig({...common,baseConfig:bound.baseConfig},bound.runtime,'modification');
}

/** Current checkpoint adapter. Offline preparation validates real delivery and never invokes a model. */
export async function prepareCardReplayRecovery(validationRoot:string,outputRoot:string,harnessSkillPath?:string) {
  const clean=resolve(validationRoot,'card-feedback-clean-state-2026-09-19'),quality=resolve(validationRoot,'card-feedback-quality-continuation-2026-09-19'),multi=resolve(validationRoot,'card-feedback-multiround-2026-09-19');
  const budgetRoot=resolve(validationRoot,'boundary-skill-template-two-stage-2026-09-17/budget'),ledgerPath=resolve(budgetRoot,'provider-budget.json');
  const bindings:Record<string,string>={};const bind=(p:string)=>{bindings[p]=cardDigest(read(p));return json(p);};
  const ledger=bind(ledgerPath);assert(!ledger.accountingUnknown&&!Object.keys(ledger.inFlight).length,'Unresolved accounting');
  const state=bind(resolve(quality,'copies/state.json')),source=bind(resolve(quality,'original-card.json'));
  const eventsPath=resolve(budgetRoot,'provider-events.jsonl');bindings[eventsPath]=cardDigest(read(eventsPath));const events=read(eventsPath).trim().split(/\r?\n/).map(line=>JSON.parse(line));
  const receipts:Record<string,ExecutionReceipt>={},artifacts:Record<string,{path:string;sha256:string}>={},defaults:Record<string,string>={},delivery:any[]=[];
  let common:any;
  for(const[id,run]of Object.entries<any>(state.runs)){
    assert(/^[A-Za-z0-9_-]+$/.test(id));const dir=[quality,multi].map(r=>resolve(r,'trials',id)).find(p=>existsSync(resolve(p,'actual-options.json')));assert(dir,'Missing actual producer for '+id);
    const options=bind(resolve(dir,'actual-options.json')),original=bind(resolve(dir,'original-runner-options.json')),actual=bind(resolve(dir,'actual-request-1.json')),copyBinding=bind(resolve(dir,'copy-binding.json'));
    const copy=state.versions[run.version];assert.equal(copy.digest,run.copyDigest);assert.equal(copyBinding.copyDigest,copy.digest);assert.equal(copyBinding.systemSha256,cardDigest(options.systemPrompt));assert.equal(copyBinding.promptSha256,cardDigest(options.prompt));
    assert.equal(applyCardCopy(original.systemPrompt,source.systemPrompt,copy),options.systemPrompt);
    assert.equal(actual.messages.filter((m:any)=>m.role==='system').length,1);assert.equal(actual.messages[0].content,options.systemPrompt);assert.equal(actual.messages.filter((m:any)=>m.role==='user').length,1);assert.equal(text(actual.messages.find((m:any)=>m.role==='user').content),options.prompt);
    const{messages,...parameters}=actual;const nonCard={parameters,prompt:options.prompt,systemSuffix:original.systemPrompt.slice(source.systemPrompt.length),provider:options.provider};
    if(common)assert.deepEqual(nonCard,common,'Non-Card inputs changed for '+id);else common=nonCard;
    const transport=read(resolve(dir,'transport.jsonl')).trim().split(/\r?\n/).map(line=>JSON.parse(line));assert.equal(transport.length,1);const sent=transport[0].request;
    const event=events.find(e=>e.type==='settled'&&e.id===sent);assert(event,'Missing settled request '+id);assert.deepEqual(actual,bind(resolve(budgetRoot,`provider-request-${String(sent).padStart(6,'0')}.json`)));
    let parseStatus:'success'|'failure'|'unknown'='unknown';
    const resultPath=resolve(dir,'trial-result.json');if(existsSync(resultPath)){const result=bind(resultPath);if(typeof result.alignment?.matched==='boolean'&&result.raw===read(resolve(dir,'public-output.md')))parseStatus='success';}
    const verification=resolve(dir,'verified-effective-producer.json');if(parseStatus==='unknown'&&existsSync(verification)){const proof=bind(verification);if(proof.parseStatus==='failed'&&proof.digest===copy.digest&&proof.systemSha256===cardDigest(options.systemPrompt)&&run.error?.startsWith('ExpertPipelineError:'))parseStatus='failure';}
    receipts[id]=receiptFromLegacyEvidence(events,event.phase,parseStatus);
    for(const name of ['public-output.md','result.json','trial-result.json','copy-binding.json','effective-producer-call.json']){const path=resolve(dir,name);if(existsSync(path)){const sha256=cardDigest(read(path));artifacts[`${id}/${name}`]={path,sha256};bindings[path]=sha256;}}
    if(artifacts[`${id}/public-output.md`])defaults[id]=`${id}/public-output.md`;
    delivery.push({runId:id,requestId:sent,copyDigest:copy.digest,status:receipts[id]!.status,parseStatus,actualProducerVerified:true});
  }
  const freezes:any={};for(const[name,file,runIds]of [['original','prior-frozen-selection.json',['confirm1','confirm2']],['quality','frozen-selection.json',['qualityconfirm1','qualityconfirm2']]] as const){const f=bind(resolve(quality,file));freezes[name]={version:f.version,copyDigest:state.versions[f.version].digest,runIds:[...runIds]};}
  const executionBinding=cardDigest(common),imported=importLegacyCopyState({legacy:state,source,executionBinding,receipts,freezes});
  writeRecoveryState(outputRoot,imported);
  const prior=bind(resolve(clean,'prior-session-outputs.json')),sessions:Record<string,string>={};for(const[id,value]of Object.entries(prior))sessions[id]=typeof value==='string'?value:JSON.stringify(value);
  sessions.priorSessionOutputs=JSON.stringify(prior);
  const options=bind(resolve(clean,'harness-final/actual-options.json')),pending=bind(resolve(clean,'harness-final/pending-payload.json'));
  const prefix=pending.messages;
  assert.deepEqual(mergeResumeMessages(prefix,prefix.slice(0,2),options.systemPrompt,options.prompt),prefix);
  const runtime={root:outputRoot,source,storeOptions:{maxUpdates:6,sampleCount:3,confirmationCount:2,requirePriorBatch:true,executionBinding},evidence:{sessions,defaultSession:'priorSessionOutputs',artifacts,defaultArtifacts:defaults},readOnly:true};
  const tools=createCardReplayRuntime(runtime,async()=>{throw Error('Offline preparation cannot execute Expert');});
  // The exact previously failing parameter shape now resolves to its explicit registered default.
  const artifact=await tools.evidence({kind:'artifact',id:'v5s1'});assert.equal(artifact.raw,read(artifacts['v5s1/public-output.md']!.path));
  const guardPath=resolve(clean,'budget-guard.ts');bindings[guardPath]=cardDigest(read(guardPath));
  const providerExtension=resolve(clean,'provider.ts');bindings[providerExtension]=cardDigest(read(providerExtension));
  const config={allowPaidProvider:false,runtime,system:options.systemPrompt,prompt:options.prompt,prefix,provider:options.provider,model:options.model,maxOutputTokens:options.maxOutputTokens,thinking:options.thinking,budgetRoot,budgetGuardPath:guardPath,phase:'shared-card-replay-recovery',providerOrigin:'https://api.deepseek.com',maxRequests:6,providerExtension,bindings:Object.entries(bindings).map(([path,sha256])=>({path,sha256}))};
  if(harnessSkillPath){
    const path=resolve(harnessSkillPath),content=read(path);assert(content.trim(),'Harness operating Skill is empty');
    config.system += `\n\n<harness_operating_skill>\n${content}\n</harness_operating_skill>`;
    // Only the operating instructions change; preserve the original user and paid evidence.
    config.prefix=[{...config.prefix[0],content:config.system},...config.prefix.slice(1)];
    config.bindings.push({path,sha256:cardDigest(content)});
  }
  mkdirSync(outputRoot,{recursive:true});writeFileSync(resolve(outputRoot,'recovery-config.json'),JSON.stringify(config,null,2));
  const proof={realProviderRequests:0,costUsd:0,ledgerUnchanged:bindings[ledgerPath]===cardDigest(read(ledgerPath)),spentUsd:ledger.usage.costUsd,remainingUsd:ledger.limits.costUsd-ledger.usage.costUsd,sourceBindings:config.bindings,delivery,importedStatuses:Object.fromEntries(Object.entries(imported.runs).map(([id,r])=>[id,r.status])),sameNonCardInputs:true,restoredUserCount:prefix.filter((m:any)=>m.role==='user').length,artifactDefaultVerified:true,readOnly:true};
  assert(proof.ledgerUnchanged);writeFileSync(resolve(outputRoot,'offline-proof.json'),JSON.stringify(proof,null,2));return proof;
}

/** Explicit future entry; preparation leaves paid execution disabled. */
export async function runPreparedCardReplayRecovery(configPath:string,sessionRunner:typeof runCardReplaySession=runCardReplaySession) {
  const raw=read(configPath),config=JSON.parse(raw);if(!config.allowPaidProvider)throw Error('Paid experiments paused; explicit new authorization required');
  process.env.EXPERT_CARD_REPLAY_CONFIG=configPath;process.env.EXPERT_CARD_REPLAY_CONFIG_SHA256=cardDigest(raw);
  const root=config.sessionOutputRoot??config.runtime.root,sessionId=randomUUID(),eventsPath=resolve(root,'resumed-events.jsonl');
  const checkpoint=beginReplayAssessment(config,sessionId);
  try {
    const result=await sessionRunner({cwd:resolve('.'),tools:config.runtime.modificationToolContract==='compact-v1'?'card-replay-compact':'card-replay',provider:config.provider,model:config.model,thinking:config.thinking,maxOutputTokens:config.maxOutputTokens,systemPrompt:config.system,prompt:config.prompt,rawEventsPath:eventsPath,timeoutMs:1200000,extensionPaths:[config.providerExtension,resolve('src/expert-card-replay-extension.ts')],session:{id:sessionId,dir:resolve(root,'sessions-'+sessionId)}});
    const completion=finishReplayAssessment(config,checkpoint,eventsPath);
    const delivered={...result,completion,terminalStatus:config.runtime.generationOnly?completion.executionStatus:'completed',automaticRetry:false};
    writeFileSync(resolve(root,'resumed-result.json'),JSON.stringify(delivered,null,2));return delivered;
  } catch(error) {
    if(!existsSync(resolve(checkpoint.dir,'assessment.json'))){
      const completion=finishReplayAssessment(config,checkpoint,eventsPath,error);
      if(config.runtime.generationOnly&&['candidate-saved-awaiting-review','no-change-decision-recorded'].includes(completion.executionStatus)){
        const parsed=existsSync(eventsPath)?parseAgentTaskEvents(read(eventsPath)):{finalText:'',readPaths:[],toolNames:[],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,costUsd:0}};
        const delivered={...parsed,rawEventsPath:eventsPath,sessionId,sessionDir:resolve(root,'sessions-'+sessionId),completion,terminalStatus:completion.executionStatus,automaticRetry:false};
        writeFileSync(resolve(root,'resumed-result.json'),JSON.stringify(delivered,null,2));return delivered as AgentTaskResult&{completion:any;terminalStatus:string;automaticRetry:false};
      }
    }
    throw error;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv[2]==='--run')await runPreparedCardReplayRecovery(resolve(process.argv[3]??''));
  else{if(!process.argv[2]||!process.argv[3])throw Error('Usage: prepare-card-replay-recovery <archive-root> <new-output-root> [options]');const root=resolve(process.argv[2]),out=resolve(process.argv[3]);const p=await prepareCardReplayRecovery(root,out,process.argv[4]);console.log(JSON.stringify({output:out,realProviderRequests:p.realProviderRequests,costUsd:p.costUsd,statuses:p.importedStatuses,remainingUsd:p.remainingUsd}));}
}
