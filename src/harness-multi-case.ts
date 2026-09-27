
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createExpertCardCopyStore,cardDigest,ALIGNER_ROLE,MATCHER_ROLE} from './expert-card-copy-store.js';
import type {ReplayRuntimeConfig} from './expert-card-replay-runtime.js';
import type {AgentTaskOptions} from './agent-task-runner.js';
import {REVIEW_SYSTEM} from './harness-multi-case-prompts.js';
import {askHuman,userBoundaries,waitForHumanAnswers} from './human-workflow-channel.js';
export interface ReviewCase {caseId:string;role:string;roleId:string;direction:string;axis:string|null;samples:any[];scope:any;catalog:Array<{id:string;quote:string;location:string;[key:string]:any}>}
export interface MultiCaseConfig {humanControlDirectory?:string;outputRoot:string;cases:ReviewCase[];materials:Array<{id:string;scope:string;text:string}>;runtimes:Record<string,ReplayRuntimeConfig>;prompt:string;task:Omit<AgentTaskOptions,'prompt'|'systemPrompt'|'rawEventsPath'>;providerExtensions:string[];boundaryGuardExtensions:string[];maxReviewRequests:number}
function validateMultiCaseConfig(c:MultiCaseConfig){
 if(!c.cases.length||new Set(c.cases.map(x=>x.caseId)).size!==c.cases.length||c.cases.some(x=>!/^[-a-zA-Z0-9_]+$/.test(x.caseId)||!Array.isArray(x.samples)||new Set(x.catalog.map(e=>e.id)).size!==x.catalog.length))throw Error('Invalid cases');
 const roles=Object.keys(c.runtimes);if(!roles.length||roles.some(r=>!['aligner','matcher'].includes(r))||!Number.isSafeInteger(c.maxReviewRequests)||c.maxReviewRequests<1)throw Error('Invalid review roles/limit');
 for(const role of roles){const expected=role==='aligner'?ALIGNER_ROLE:MATCHER_ROLE,r=c.runtimes[role]!;if(r.source.roleId!==expected||resolve(r.root)!==resolve(c.outputRoot,'roles',role)||!r.generationOnly||r.modificationToolContract!=='blind-append-v1'||!c.cases.some(x=>x.roleId===expected))throw Error('Role path or blind binding mismatch');}
 for(const item of c.cases)if(!roles.some(r=>c.runtimes[r]!.source.roleId===item.roleId))throw Error('Unbound case role');
}
export interface MultiCaseOptions {humanControlDirectory?:string;outputRoot:string;cases:ReviewCase[];materials:MultiCaseConfig['materials'];parents:Array<{roleId:typeof ALIGNER_ROLE|typeof MATCHER_ROLE;systemPrompt:string}>;task:MultiCaseConfig['task'];providerExtensions:string[];guardExtensions:{review:string[];boundary:string[]};maxReviewRequests?:number}
/** Prepare an isolated batch. Execution is opt-in and always requires injected guards. */
export async function runMultiCaseHarness(options:MultiCaseOptions,execute=false,runner=runAgentTask){
 const root=resolve(options.outputRoot);mkdirSync(dirname(root),{recursive:true});mkdirSync(root);
 const runtimes:Record<string,ReplayRuntimeConfig>={};
 for(const parent of options.parents){const role=parent.roleId===ALIGNER_ROLE?'aligner':parent.roleId===MATCHER_ROLE?'matcher':null;if(!role||runtimes[role])throw Error('Unique supported parent roles required');const dir=resolve(root,'roles',role);mkdirSync(dir,{recursive:true});const storeOptions={maxUpdates:1,sampleCount:0,confirmationCount:0,reviewedCopies:{},...(role==='matcher'?{candidateOnlyRole:MATCHER_ROLE}:{})};const store=createExpertCardCopyStore(resolve(dir,'copies'),parent,async()=>{throw Error('Expert execution is not installed');},storeOptions),p=await store.card({action:'create',roleId:parent.roleId});runtimes[role]={root:dir,source:parent,storeOptions,generationOnly:true,modificationToolContract:'blind-append-v1',blindAppendBinding:{parentVersion:'v0',parentDigest:p.digest,startStateSha256:cardDigest(await store.snapshot())},stageVisibility:{artifactIds:[],sessionIds:[],versionIds:[],cardReadVersions:[],updateParentVersions:['v0'],allowCreate:false,allowDynamicArtifacts:false,allowVersionBundles:false},evidence:{sessions:{},artifacts:{},defaultArtifacts:{}}};}
 const prompt='以下是本批局部调用的观察缓存，不是本轮执行 Expert 的结果。按需查原输入，保存审查后在本会话转换教学增量。\n'+JSON.stringify(options.cases.map(({scope,catalog,...visible})=>visible))+(options.humanControlDirectory?'\n用户参与已启用。用户边界是任务约束，不是 Evidence；不明确且会影响判断的问题可调用 ask_user 等待用户回答，不猜测用户意图。\n用户追加边界：'+JSON.stringify(userBoundaries(options.humanControlDirectory)):'');
 const config:MultiCaseConfig={outputRoot:root,cases:options.cases,materials:options.materials,runtimes,prompt,task:options.task,providerExtensions:options.providerExtensions,boundaryGuardExtensions:options.guardExtensions.boundary,maxReviewRequests:options.maxReviewRequests??Math.max(8,options.cases.length*3)};
 if(options.humanControlDirectory)config.humanControlDirectory=resolve(options.humanControlDirectory);
 validateMultiCaseConfig(config);save(root+'/config.json',config);
 const extension=root+'/extension.ts';writeFileSync(extension,'import {registerMultiCaseHarness} from '+JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)+';\nimport {readFileSync} from "node:fs";\nexport default pi=>registerMultiCaseHarness(pi,JSON.parse(readFileSync('+JSON.stringify(root+'/config.json')+',"utf8")));\n',{flag:'wx'});
 const task:AgentTaskOptions={...options.task,systemPrompt:REVIEW_SYSTEM,prompt,tools:'boundary-batch',session:{id:randomUUID(),dir:root+'/session'},rawEventsPath:root+'/events.jsonl',extensionPaths:[...options.providerExtensions,extension,...options.guardExtensions.review]};save(root+'/actual-options.json',task);
 if(!execute)return{status:'prepared',root,sessionId:task.session!.id};
 if(!options.guardExtensions.review.length||!options.guardExtensions.boundary.length)throw Error('Explicit provider guards required for execution');
 try{const result=await runner(task);save(root+'/result.json',result);}catch(error){
  if(!existsSync(root+'/batch-complete.json')||existsSync(root+'/failure.json')||!/(?:Pi|Agent) task emitted no final answer/.test(String(error)))throw error;
  save(root+'/planned-stop.json',{reason:'All role receipts saved; stopped before a completion acknowledgement',runnerMessage:String(error)});
 }
 return{status:existsSync(root+'/batch-complete.json')?'candidates-saved':'incomplete',root,sessionId:task.session!.id};
}
import {readFileSync,writeFileSync,mkdirSync,existsSync,appendFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Type} from 'typebox';
import {Check} from 'typebox/value';
import {runAgentTask} from './agent-task-runner.js';
import {createCardReplayRuntime,registerCardReplayTools} from './expert-card-replay-runtime.js';
import {COMPARISON_BOUNDARY_SYSTEM} from './harness-boundary-communication.js';
import {ALIGNMENT_CONTRACT,MATCH_CONTRACT,CONVERSION} from './harness-multi-case-prompts.js';
const read=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
const save=(p:string,v:any)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
export function registerMultiCaseHarness(sdk:any,config:MultiCaseConfig,boundaryRunner=runAgentTask){
 const out=config.outputRoot,cases=config.cases,materials=config.materials,runtimes=config.runtimes,roles=Object.keys(runtimes);validateMultiCaseConfig(config);
 const originalUser=config.prompt;
 sdk.on('context',(e:any)=>{if(e.messages.filter((m:any)=>m.role==='user').length!==1)throw Error('One native review user turn required');return{messages:e.messages.map((m:any)=>m.role==='user'?{...m,content:[{type:'text',text:originalUser}]}:m)};});
 const fail=(error:unknown)=>{if(!existsSync(out+'/failure.json'))save(out+'/failure.json',{error:String(error),at:new Date().toISOString()});};
 const clear=()=>{if(existsSync(out+'/failure.json'))throw Error('Batch stopped; inspect failure receipt');};
 let phase:'review'|'conversion'='review',requests=0,boundaryQueue:Promise<any>=Promise.resolve();
 const caseRead=new Set<string>(),evidenceRead=new Set<string>(),boundaryDone=new Set<string>(),boundaryStarted=new Set<string>(),submitted=new Set<string>();
 const getCase=(id:string)=>{const c=cases.find((x:any)=>x.caseId===id);if(!c)throw Error('Unknown caseId');return c;};
 const active=()=>sdk.setActiveTools(phase==='review'?['read_case','read_evidence','ask_boundary',...(config.humanControlDirectory?['ask_user']:[]),'finish_review']:roles.filter(r=>!submitted.has(r)).map(r=>'append_'+r));
 const add=(name:string,description:string,parameters:any,run:(args:any)=>Promise<any>|any)=>sdk.registerTool({name,label:name,description,parameters,execute:async(id:string,args:any)=>{clear();try{if(!Check(parameters,args))throw Error('Tool arguments do not match schema');const result=await run(args);appendFileSync(out+'/tool-records.jsonl',JSON.stringify({at:new Date().toISOString(),id,name,args,result})+'\n');return{content:[{type:'text',text:JSON.stringify(result)}],details:{}};}catch(e){fail(e);throw e;}}});
 const inReview=()=>{if(phase!=='review')throw Error('Review tools closed after finish_review');};
 if(config.humanControlDirectory)add('ask_user','把影响审查的具体疑问交给用户回答。用户回答是任务约束或说明，不等于文稿原 Evidence；一次问清一个问题。',Type.Object({question:Type.String({minLength:1,maxLength:12000}),caseId:Type.Optional(Type.String())},{additionalProperties:false}),async(args)=>{inReview();if(args.caseId)getCase(args.caseId);return askHuman(config.humanControlDirectory!,args.question,args.caseId?{caseId:args.caseId}:{});});
 add('read_case','读取一个缓存案例的原输入目录、Aspect 原始说明和 Evidence 位置；不执行 Expert。',Type.Object({caseId:Type.String()},{additionalProperties:false}),(args)=>{inReview();const c=getCase(args.caseId);caseRead.add(c.caseId);return{caseId:c.caseId,role:c.role,note:'以下目录来自该次 Expert 的冻结输入，不是完整文稿。说明与原句需区分，未展示的部分不能据此判为不存在。',input:c.scope};});
 add('read_evidence','按本例目录中的 ID 读取完整原 Evidence；来源可核不等于案例解释成立。',Type.Object({caseId:Type.String(),ids:Type.Array(Type.String(),{minItems:1})},{additionalProperties:false}),(args)=>{inReview();const c=getCase(args.caseId);if(!caseRead.has(c.caseId)||new Set(args.ids).size!==args.ids.length)throw Error('Read case directory first; IDs must be unique');const selected=args.ids.map((id:string)=>{const e=c.catalog.find((x:any)=>x.id===id);if(!e)throw Error('Unknown Evidence ID');evidenceRead.add(c.caseId+':'+id);return e;});return{caseId:c.caseId,note:'这是所选原局部 Evidence，不代表文稿全集；请结合原语境判断支持范围。',evidence:selected};});
 add('ask_boundary','就一个案例询问适用判据、依据及限度；传待核事实与必要原句，不传 Expert 当前结果或预设答案。每例最多一次。',Type.Object({caseId:Type.String(),case:Type.String({minLength:1}),evidence:Type.Array(Type.Object({id:Type.String(),quote:Type.String({minLength:1})},{additionalProperties:false}),{minItems:1}),question:Type.String({minLength:1})},{additionalProperties:false}),async(args)=>{
  inReview();const c=getCase(args.caseId);if(boundaryStarted.has(c.caseId))throw Error('One boundary call per case');
  const quotes=args.evidence.map((ref:any)=>{const e=c.catalog.find((x:any)=>x.id===ref.id);if(!e||!evidenceRead.has(c.caseId+':'+ref.id)||!e.quote.includes(ref.quote))throw Error('Boundary quote must be a previously read exact substring');return{...e,quote:ref.quote};});boundaryStarted.add(c.caseId);
  const operation=boundaryQueue.then(async()=>{
   if(config.humanControlDirectory)await waitForHumanAnswers(config.humanControlDirectory);
   clear();const dir=out+'/boundary-'+c.caseId;mkdirSync(dir);const question={caseId:c.caseId,role:c.role,direction:c.direction,axis:c.axis,case:args.case,evidence:quotes,question:args.question};save(dir+'/question.json',question);
   const boundaries=config.humanControlDirectory?userBoundaries(config.humanControlDirectory):[];
   save(dir+'/user-boundaries.json',{source:'user',boundaries});
   const prompt='## 用户要求与适用规范\n'+materials.map((m:any)=>`SOURCE ${m.id} (${m.scope})\n${m.text}\nEND SOURCE ${m.id}`).join('\n\n')+(boundaries.length?'\n\n## 用户追加的评价边界（任务约束，不是原文 Evidence）\n'+JSON.stringify(boundaries):'')+'\n\n## 审查方提出的待核案例与原文选摘\n'+JSON.stringify(question,null,2)+'\n\n这是本次局部选摘，不代表完整集合；审查方的案例描述是待核解释。';
   writeFileSync(dir+'/input.txt',prompt,{flag:'wx'});
   const options={...config.task,systemPrompt:COMPARISON_BOUNDARY_SYSTEM,prompt,tools:'none' as const,rawEventsPath:dir+'/events.jsonl',session:{id:randomUUID(),dir:dir+'/session'},extensionPaths:[...config.providerExtensions,...config.boundaryGuardExtensions]};save(dir+'/actual-options.json',options);
   const result=await boundaryRunner(options);if(result.stopReason!=='stop'||!result.finalText.trim())throw Error('Boundary did not finish');save(dir+'/result.json',result);save(dir+'/answer.json',{answer:result.finalText});boundaryDone.add(c.caseId);return{caseId:c.caseId,note:'这是边界方可能有误的解释；请回到原文核对依据与适用范围。',answer:result.finalText};
  });boundaryQueue=operation.catch(()=>{});return operation;
 });
 add('finish_review','完成本批审查后保存有来源、区分行为归属与待核范围的审查正文，并在本会话进入教学转换阶段。',Type.Object({review:Type.String({minLength:1})},{additionalProperties:false}),(args)=>{
  inReview();if(caseRead.size!==cases.length||boundaryDone.size===0||boundaryDone.size!==boundaryStarted.size)throw Error('Read all case directories and settle any requested boundary call before finishing');
  save(out+'/review.json',{review:args.review,caseIds:cases.map((c:any)=>c.caseId),boundaryCases:[...boundaryDone]});phase='conversion';active();
  return{status:'review-saved',nextStage:CONVERSION.replace('append_aligner、append_matcher',roles.map(r=>'append_'+r).join('、')),outputContracts:{Aligner:ALIGNMENT_CONTRACT,Matcher:MATCH_CONTRACT}};
 });
 for(const role of roles){
  const runtime=createCardReplayRuntime(runtimes[role]!,async()=>{throw Error('EXPERT EXECUTION IS NOT INSTALLED');});const definitions:any[]=[];
  // Keep the shared tool's validation, immutable append, receipt and role-local pause.
  // The batch owns active tools and the final pause after both isolated roles finish.
  registerCardReplayTools({registerTool:(d:any)=>definitions.push(d),on(){},setActiveTools(){}},runtime,runtimes[role]!.root+'/engineering-stop.json');
  if(definitions.length!==1||definitions[0].name!=='expert_card_append')throw Error('Expected one blind append tool only');const tool=definitions[0];
  sdk.registerTool({...tool,name:'append_'+role,label:'提交 '+role+' 教学增量',execute:async(id:string,args:any)=>{clear();try{if(phase!=='conversion'||submitted.has(role))throw Error('Append outside its one authorized role submission');const result=await tool.execute(id,args);submitted.add(role);appendFileSync(out+'/tool-records.jsonl',JSON.stringify({at:new Date().toISOString(),id,name:'append_'+role,args,result})+'\n');if(submitted.size===roles.length)save(out+'/batch-complete.json',{status:'candidates-saved-awaiting-review',roles:[...submitted],review:out+'/review.json',at:new Date().toISOString()});active();return result;}catch(e){fail(e);throw e;}}});
 }
 sdk.on('tool_execution_end',(e:any)=>{if(e.isError)fail(e.result??'Tool failed');});
 sdk.on('before_provider_request',(_e:any,ctx:any)=>{try{clear();if(submitted.size===roles.length)throw Error('PLANNED_BATCH_COMPLETE');if(++requests>config.maxReviewRequests)throw Error('Review session request limit reached');}catch(e){ctx.abort();if(String(e).includes('PLANNED_BATCH_COMPLETE'))return;fail(e);throw e;}});
 sdk.on('session_start',()=>active());
}
