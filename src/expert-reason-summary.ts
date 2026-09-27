import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rmdir,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {runAgentTask,type AgentTaskOptions} from './agent-task-runner.js';
export const SUMMARY_PROMPT_VERSION='attributed-reasons-v1';
export const SUMMARY_SYSTEM='你只压缩转述给定的 Expert 公开理由，帮助读者比较各次说法。没有原 Evidence，不声称核实原文，不评判哪次正确，不产生新判断或评分。每条摘要明确归因“该次 Expert 认为/采用……”，不把其断言升级为事实；不得从措辞推断标签。变化说明仅比较理由关注点，不宣布正确性或效果。只输出 JSON：{"title":"短中文标题","samples":[{"sampleId":"原ID","text":"一句归因摘要"}],"change":"简短理由变化说明"}。逐条保留给定 sampleId 和顺序，每条摘要尽量不超过55字，变化说明不超过100字，标题不超过25字。';
export interface SummaryInput {caseId:string;scope:{roleId:string;axis:string|null;direction:string};samples:Array<{sampleId:string;kind:string;result:unknown;rationale:string;sourceHash:string}>}
export interface ReasonSummary {title:string;samples:Array<{sampleId:string;text:string}>;change:string}
export interface SummaryState {enabled:boolean;status:'disabled'|'idle'|'pending'|'ready'|'failed'|'blocked';cacheKey:string;promptVersion:string;model:string;output?:ReasonSummary;message?:string;failureKind?:'output-validation'|'budget'|'provider'}
export type SummaryRunner=(input:SummaryInput,dir:string)=>Promise<{text:string;usage?:unknown}>;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export const summaryPrompt=(input:SummaryInput)=>JSON.stringify({caseId:input.caseId,scope:input.scope,samples:input.samples.map(({sourceHash,...s})=>s)});
export function validateReasonSummary(raw:string,input:SummaryInput):ReasonSummary{
 const s=JSON.parse(raw.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
 if(!s||Object.keys(s).sort().join()!=='change,samples,title'||typeof s.title!=='string'||!s.title.trim()||s.title.length>100||typeof s.change!=='string'||s.change.length>500||!Array.isArray(s.samples)||s.samples.length!==input.samples.length)throw Error('Invalid summary schema');
 for(const [i,item]of s.samples.entries())if(Object.keys(item).sort().join()!=='sampleId,text'||item.sampleId!==input.samples[i]?.sampleId||typeof item.text!=='string'||!item.text.trim()||item.text.length>300)throw Error('Summary sample binding mismatch');
 return s;
}
/** Cache is keyed by source content, model and prompt version. Failed/pending records never retry automatically. */
export class ReasonSummaryCache {
 private pending=new Map<string,Promise<SummaryState>>();
 constructor(private options:{root:string;model:string;runner?:SummaryRunner|undefined}){}
 private key(input:SummaryInput){return hash(JSON.stringify({version:SUMMARY_PROMPT_VERSION,model:this.options.model,input}));}
 private base(input:SummaryInput){return{enabled:!!this.options.runner,cacheKey:this.key(input),promptVersion:SUMMARY_PROMPT_VERSION,model:this.options.model};}
 private async dir(input:SummaryInput){const root=resolve(this.options.root);await mkdir(root,{recursive:true});if((await realpath(root)).toLowerCase()!==root.toLowerCase())throw Error('Invalid summary cache directory');return resolve(root,this.key(input));}
 async status(input:SummaryInput):Promise<SummaryState>{const base=this.base(input),dir=await this.dir(input);try{const state=JSON.parse(await readFile(dir+'/state.json','utf8'));if(state.cacheKey!==base.cacheKey||state.model!==base.model||state.promptVersion!==base.promptVersion)throw Error('Summary cache binding mismatch');
  if(state.status==='pending'&&(state.ownerPid!==process.pid||!this.pending.has(base.cacheKey))){let alive=false;try{if(Number.isSafeInteger(state.ownerPid)){process.kill(state.ownerPid,0);alive=true;}}catch{}if(!alive||Date.now()-state.startedAt>600000)return{...base,status:'blocked',message:'摘要中断待核，原文可用；不会自动重试。'};}
  const {ownerPid,startedAt,...visible}=state;return {...visible,enabled:base.enabled};
 }catch(e:any){if(e.code!=='ENOENT')throw e;return{...base,status:this.options.runner?'idle':'disabled',...(!this.options.runner?{message:'摘要调用尚未启用；完整理由仍可查看。'}:{})};}}
 async request(input:SummaryInput):Promise<SummaryState>{const key=this.key(input),existing=this.pending.get(key);if(existing)return existing;const operation=this.perform(input);this.pending.set(key,operation);try{return await operation;}finally{this.pending.delete(key);}}
 private async perform(input:SummaryInput):Promise<SummaryState>{
  const current=await this.status(input);if(current.status!=='idle')return current;const dir=await this.dir(input);await mkdir(dir,{recursive:true});const lock=dir+'/request.lock';try{await mkdir(lock);}catch(e:any){if(e.code==='EEXIST')return{...this.base(input),status:'pending',message:'同一摘要已在运行；不会重复调用。'};throw e;}
  const save=async(state:SummaryState,owner=false)=>{const path=dir+'/state-'+randomUUID()+'.tmp';await writeFile(path,JSON.stringify({...state,...(owner?{ownerPid:process.pid,startedAt:Date.now()}:{})},null,2));await rename(path,dir+'/state.json');return state;};
  try{const prior=await this.status(input);if(prior.status!=='idle')return prior;await save({...this.base(input),status:'pending'},true);await writeFile(dir+'/source.json',JSON.stringify(input,null,2),{flag:'wx'});
   let failureKind:'output-validation'|'budget'|'provider'='provider';
   try{const result=await this.options.runner!(input,dir);await writeFile(dir+'/response.json',JSON.stringify(result,null,2),{flag:'wx'});failureKind='output-validation';return await save({...this.base(input),status:'ready',output:validateReasonSummary(result.text,input)});}catch(e){if(failureKind!=='output-validation'&&/budget|admission|scope|quota/i.test(String(e)))failureKind='budget';await writeFile(dir+'/failure.json',JSON.stringify({failureKind,error:String(e).replace(/(Bearer\s+|api[_-]?key[=: ]+)[^\s]+/gi,'$1[REDACTED]').slice(0,2000),at:new Date().toISOString()},null,2),{flag:'wx'});return await save({...this.base(input),status:'failed',failureKind,message:failureKind==='budget'?'摘要预算未准入；完整理由仍可查看。':failureKind==='output-validation'?'摘要格式未通过校验，已停止重试；完整理由仍可查看。':'摘要调用未完成，待核后再处理；完整理由仍可查看。'});}
  }finally{await rmdir(lock);}
 }
}
/** Uses the shared SDK runner; caller injects provider and budget guard extensions. No direct HTTP client. */
export function createSummaryRunner(config:{task:Pick<AgentTaskOptions,'cwd'|'provider'|'model'|'timeoutMs'>;maxOutputTokens:number;providerExtensions:string[];guardExtensions:string[]},runner=runAgentTask):SummaryRunner{
 if(!config.guardExtensions.length||!Number.isSafeInteger(config.maxOutputTokens)||config.maxOutputTokens<1||config.maxOutputTokens>8000)throw Error('Summary execution requires explicit guarded task configuration');
 return async(input,dir)=>{const options:AgentTaskOptions={...config.task,systemPrompt:SUMMARY_SYSTEM,prompt:summaryPrompt(input),tools:'none',thinking:'off',maxOutputTokens:config.maxOutputTokens,session:{id:randomUUID(),dir:dir+'/session'},rawEventsPath:dir+'/events.jsonl',extensionPaths:[...config.providerExtensions,...config.guardExtensions]};await writeFile(dir+'/actual-options.json',JSON.stringify(options,null,2),{flag:'wx'});const result=await runner(options);if(result.stopReason!=='stop'||result.toolNames.length)throw Error('Summary did not finish without tools');return{text:result.finalText,usage:result.usage};};
}
