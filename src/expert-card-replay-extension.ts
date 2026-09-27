import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {cardDigest} from './expert-card-copy-store.js';
import {createCardReplayRuntime,registerCardReplayTools,installReplayResume} from './expert-card-replay-runtime.js';
import {createPaidCardExecutor} from './expert-card-paid-executor.js';

/** Prepared recovery extension. No historical extension or private copy store is loaded. */
export default async function(sdk:any) {
  let ready=false;
  sdk.on('before_provider_request',(_event:any,ctx:any)=>{if(!ready)ctx.abort();});
  const path=process.env.EXPERT_CARD_REPLAY_CONFIG;
  if(!path)throw Error('Missing prepared replay config');
  const raw=readFileSync(path,'utf8');if(cardDigest(raw)!==process.env.EXPERT_CARD_REPLAY_CONFIG_SHA256)throw Error('Prepared replay config changed');
  const config=JSON.parse(raw),root=config.sessionOutputRoot??config.runtime.root;
  for(const item of config.bindings)if(cardDigest(readFileSync(item.path,'utf8'))!==item.sha256)throw Error('Recovery source changed: '+item.path);
  const ledger=()=>JSON.parse(readFileSync(resolve(config.budgetRoot,'provider-budget.json'),'utf8'));
  const initial=ledger();if(initial.accountingUnknown||initial.blocked||Object.keys(initial.inFlight).length)throw Error('Budget unresolved');
  if(!config.allowPaidProvider)throw Error('Paid experiments are paused');
  if(config.runtime.generationOnly&&config.runtime.storeOptions?.trialAuthorization&&!config.expertExecution)throw Error('Trial-authorized generation requires bound expertExecution accounting evidence');
  if(!config.runtime.readOnly&&!config.runtime.generationOnly&&!config.expertExecution)throw Error('Writable recovery requires a bound Expert executor');
  const paid=config.runtime.readOnly||config.runtime.feedbackOnly||config.runtime.generationOnly?undefined:createPaidCardExecutor(config.expertExecution);
  const runtime=createCardReplayRuntime({...config.runtime,...(config.expertExecution?{settledTrialEvidence:config.expertExecution}:{}),storeOptions:{...config.runtime.storeOptions,...(paid?{receipt:paid.receipt}:{})}},paid?.execute??(async()=>{throw Error('This recovery is read-only; no new Expert execution');}));
  const stopPath=resolve(root,'engineering-stop.json');
  const stop=registerCardReplayTools(sdk,runtime,stopPath);
  installReplayResume(sdk,{system:config.system,runtime:config.prompt,prefix:config.prefix,...(config.authorizedContinuationMessage?{authorizedContinuationMessage:config.authorizedContinuationMessage}:{}),pendingPath:resolve(root,'next-pending-payload.json'),stopPath});
  let count=0,admitted:number|undefined;
  sdk.on('before_provider_request',(e:any,ctx:any)=>{admitted=undefined;try{stop.assertClear();if(++count>config.maxRequests)throw Error('Recovery request limit');if(e.payload.model!==config.model||(e.payload.max_tokens??e.payload.max_completion_tokens)!==config.maxOutputTokens)throw Error('Provider configuration changed');}catch(error){stop.reject(error);ctx.abort();throw error;}});
  const {guard}=await import(pathToFileURL(config.budgetGuardPath).href);
  // The historical guard's calculations are unchanged. Never admit after a tool/runtime stop.
  guard({on(name:string,fn:any){sdk.on(name,(e:any,ctx:any)=>{if(name==='before_provider_request'&&ctx.signal?.aborted)return;return fn(e,ctx);});}},config.budgetRoot,config.phase);
  sdk.on('before_provider_request',(_e:any,ctx:any)=>{const l=ledger();if(!ctx.signal?.aborted&&!l.blocked&&!l.accountingUnknown&&l.inFlight[l.requests])admitted=l.requests;});
  const originalFetch=globalThis.fetch,used=new Set<number>();
  globalThis.fetch=async(input:any,init:any)=>{stop.assertClear();const l=ledger(),url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
    if(!admitted||used.has(admitted)||!l.inFlight[admitted]||l.blocked||l.accountingUnknown||new URL(url).origin!==config.providerOrigin)throw Error('Unreserved or repeated provider transport');
    used.add(admitted);return originalFetch(input,init);
  };
  ready=true;
}
