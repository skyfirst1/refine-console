import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {bindCardReplayRequest} from './expert-card-replay-runtime.js';
import {cardDigest,type CardCopy,type ExecutionReceipt} from './expert-card-copy-store.js';
import {runAgentTask,type AgentTaskOptions} from './agent-task-runner.js';
import {parseAlignmentOutput} from './refine-expert-pipeline.js';

export interface PaidExecutorConfig {root:string;sourcePrompt:string;baselineOptionsPath:string;baselineRequestPath:string;budgetRoot:string;budgetGuardPath:string;providerExtension:string;providerOrigin:string;phasePrefix:string;}
const read=(p:string)=>readFileSync(p,'utf8'),json=(p:string)=>JSON.parse(read(p));
export function createPaidCardExecutor(config:PaidExecutorConfig) {
  const baseline=json(config.baselineOptionsPath) as AgentTaskOptions,baselinePayload=json(config.baselineRequestPath);
  const events=()=>read(resolve(config.budgetRoot,'provider-events.jsonl')).trim().split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));
  const phase=(id:string)=>config.phasePrefix+'-'+id;
  const receipt=async(id:string):Promise<ExecutionReceipt>=>{
    const dir=resolve(config.root,'trials',id),settled=events().filter(x=>x.type==='settled'&&x.phase===phase(id));
    assert(settled.length<=1,'Sample has multiple settlements');
    if(settled.length){const e=settled[0];return{status:'settled',requestId:String(e.id),costUsd:e.actual.costUsd,totalTokens:e.actual.totalTokens,parsed:existsSync(resolve(dir,'trial-result.json'))};}
    if(events().some(x=>x.type==='admit'&&x.phase===phase(id)))return{status:'unknown'};
    return{status:'pre-send-blocked'};
  };
  const execute=async(copy:CardCopy,id:string)=>{
    assert(/^[A-Za-z0-9_-]+$/.test(id));const dir=resolve(config.root,'trials',id);mkdirSync(dir,{recursive:true});
    assert(!events().some(x=>x.phase===phase(id)&&x.type==='admit'),'Existing sent identity cannot execute again');
    const bound=bindCardReplayRequest(baseline,config.sourcePrompt,copy);
    const {trace:_oldTrace,...request}=bound.request;
    const actual:AgentTaskOptions={...request,tools:'none',extensionPaths:[config.providerExtension,resolve('src/expert-card-paid-extension.ts')],rawEventsPath:resolve(dir,'events.jsonl'),session:{id:randomUUID(),dir:resolve(dir,'session-'+randomUUID())}};
    const expected={...baselinePayload,messages:baselinePayload.messages.map((m:any)=>m.role==='system'?{...m,content:actual.systemPrompt}:m)};
    writeFileSync(resolve(dir,'actual-options.json'),JSON.stringify(actual,null,2));writeFileSync(resolve(dir,'producer.json'),JSON.stringify(bound.producer,null,2));
    const setup={...config,dir,phase:phase(id),expected,system:actual.systemPrompt,prompt:actual.prompt};const setupPath=resolve(dir,'execution-config.json');writeFileSync(setupPath,JSON.stringify(setup));
    const old=process.env.EXPERT_CARD_PAID_EXECUTION;process.env.EXPERT_CARD_PAID_EXECUTION=setupPath;
    try{const result=await runAgentTask(actual);writeFileSync(resolve(dir,'result.json'),JSON.stringify(result,null,2));writeFileSync(resolve(dir,'public-output.md'),result.finalText);
      const value={alignment:parseAlignmentOutput(result.finalText),raw:result.finalText,producer:bound.producer};writeFileSync(resolve(dir,'trial-result.json'),JSON.stringify(value,null,2));return value;
    }catch(error){writeFileSync(resolve(dir,'error.json'),JSON.stringify({error:String(error)}));throw error;}finally{if(old===undefined)delete process.env.EXPERT_CARD_PAID_EXECUTION;else process.env.EXPERT_CARD_PAID_EXECUTION=old;}
  };
  return{execute,receipt};
}
