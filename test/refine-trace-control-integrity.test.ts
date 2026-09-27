import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { auditRefineTraceIntegrity } from "../src/refine-trace-integrity.js";
test("integrity separates only authenticated unsent controls and retains their original error", async () => {
 const root=await mkdtemp(join(tmpdir(),"integrity-control-"));const eventsPath=join(root,"absent.jsonl"),ledgerPath=join(root,"ledger.jsonl"),evidencePath=join(root,"proof.json");
 const sha=(s:string)=>createHash("sha256").update(s).digest("hex"); await writeFile(ledgerPath,"");
 const proof=JSON.stringify({runId:"run",preProviderGuardVerified:true,unsentAttempts:[{stage:"align",attempt:1,eventsPath}],ledgerPath,ledgerSha256:sha("")});await writeFile(evidencePath,proof);
 const attempt:any={attempt:1,taskId:"run:align:attempt-1",status:"failed",eventsPath,error:"source stopped",controlStop:{reason:"source",providerStarted:false,evidencePath,evidenceSha256:sha(proof)}};
 const stage:any={stage:"align",taskId:"run:align",provider:"test",status:"failed",inputArtifacts:[],outputArtifacts:[],eventsPath,attempts:[attempt]};
 let r=await auditRefineTraceIntegrity([stage]);assert.equal(r.completenessMatrix.length,0);assert.equal(r.controlStops?.length,1);assert.equal(r.controlStops![0]!.error,"source stopped");assert.equal(r.findings.length,0);assert.equal(r.valid,false,"controls alone do not constitute a model trace");
 for(const field of ["missing-proof","started","usage","events"]){const a=structuredClone(attempt);if(field==="missing-proof")delete a.controlStop.evidenceSha256;if(field==="started")a.controlStop.providerStarted=true;if(field==="usage")a.usage={totalTokens:1};if(field==="events")await writeFile(eventsPath,"{}\n");r=await auditRefineTraceIntegrity([{...stage,attempts:[a]}]);assert.equal(r.controlStops?.length,0);assert.ok(r.findings.some(f=>f.code==="TRACE_CONTROL_EVIDENCE_INVALID"));}
});
