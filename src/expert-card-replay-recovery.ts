import {existsSync, readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {cardDigest, receiptStatus, type CopyState, type ExecutionReceipt, type CardCopy} from './expert-card-copy-store.js';

/** Offline-only import. Original records remain evidence; unknown is never promoted by status text. */
export function importLegacyCopyState(input:{legacy:any;source:any;executionBinding:string;receipts:Record<string,ExecutionReceipt>;freezes:CopyState['freezes']}):CopyState {
  if(input.legacy.sourceBinding!==cardDigest(input.source))throw Error('Legacy source binding mismatch');
  const versions:Record<string,CardCopy>=structuredClone(input.legacy.versions);
  for(const copy of Object.values(versions)){const{digest,...body}=copy;if(cardDigest(body)!==digest)throw Error('Legacy copy digest mismatch');}
  const runs:CopyState['runs']={};
  for(const[id,old]of Object.entries<any>(input.legacy.runs)){
    const copy=versions[old.version];if(!copy||old.copyDigest!==copy.digest)throw Error('Legacy run copy binding mismatch');
    const receipt=input.receipts[id]??{status:'unknown'};
    runs[id]={...structuredClone(old),producerBinding:cardDigest({execution:input.executionBinding,copyDigest:copy.digest}),status:receiptStatus(receipt),receipt};
  }
  for(const frozen of Object.values(input.freezes)){if(versions[frozen.version]?.digest!==frozen.copyDigest)throw Error('Frozen version binding mismatch');for(const id of frozen.runIds){if(runs[id]&&runs[id]!.copyDigest!==frozen.copyDigest)throw Error('Confirmation identity rebound');}}
  return{sourceBinding:input.legacy.sourceBinding,versions,runs,updates:input.legacy.updates,freezes:structuredClone(input.freezes)};
}

/** Settled ledger row + a separate parse result are both required. */
export function receiptFromLegacyEvidence(events:any[],phase:string,parseStatus:'success'|'failure'|'unknown'):ExecutionReceipt {
  const rows=events.filter(e=>e.phase===phase),admitted=rows.filter(e=>e.type==='admit');
  const settled=rows.filter(e=>e.type==='settled');
  if(admitted.length!==1||settled.length!==1||admitted[0].id!==settled[0].id||parseStatus==='unknown')return{status:'unknown'};
  const e=settled[0],a=e.actual;
  if(!a||!Number.isSafeInteger(a.totalTokens)||a.totalTokens<=0||!Number.isFinite(a.costUsd)||a.costUsd<0)return{status:'unknown'};
  return{status:'settled',requestId:String(e.id),totalTokens:a.totalTokens,costUsd:a.costUsd,parsed:parseStatus==='success'};
}

/** Refuse to replace an existing recovery state; repeated preparation only verifies identical bytes. */
export function writeRecoveryState(root:string,state:CopyState) {
  const path=resolve(root,'copies/state.json'),text=JSON.stringify(state,null,2);mkdirSync(resolve(root,'copies'),{recursive:true});
  if(existsSync(path)){if(readFileSync(path,'utf8')!==text)throw Error('Recovery state already changed; do not reimport');}
  else writeFileSync(path,text,{flag:'wx'});
}
