import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {installReplayResume} from './expert-card-replay-runtime.js';
export default async function(runtime:any){
  const config=JSON.parse(readFileSync(process.env.EXPERT_CARD_PAID_EXECUTION!,'utf8'));
  installReplayResume(runtime,{system:config.system,runtime:config.prompt,pendingPath:resolve(config.dir,'pending-payload.json'),stopPath:resolve(config.dir,'engineering-stop.json')});
  let count=0,admitted:number|undefined;
  const ledger=()=>JSON.parse(readFileSync(resolve(config.budgetRoot,'provider-budget.json'),'utf8'));
  runtime.on('before_provider_request',(e:any,ctx:any)=>{try{assert.equal(++count,1,'Exactly one request per independent sample');assert.deepEqual(JSON.parse(JSON.stringify(e.payload)),config.expected,'Effective sample differs beyond Card');writeFileSync(resolve(config.dir,'actual-request.json'),JSON.stringify(e.payload));}catch(error){writeFileSync(resolve(config.dir,'engineering-stop.json'),JSON.stringify({error:String(error)}));ctx.abort();throw error;}});
  const {guard}=await import(pathToFileURL(config.budgetGuardPath).href);guard({on(name:string,fn:any){runtime.on(name,(e:any,ctx:any)=>name==='before_provider_request'&&ctx.signal?.aborted?undefined:fn(e,ctx));}},config.budgetRoot,config.phase);
  runtime.on('before_provider_request',(_e:any,ctx:any)=>{const l=ledger();if(!ctx.signal?.aborted&&!l.blocked&&l.inFlight[l.requests])admitted=l.requests;});
  const fetch=globalThis.fetch;let used=false;
  globalThis.fetch=async(input:any,init:any)=>{const l=ledger(),url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(used||!admitted||!l.inFlight[admitted]||l.blocked||l.accountingUnknown||new URL(url).origin!==config.providerOrigin)throw Error('Unreserved Expert transport');used=true;return fetch(input,init);};
}
