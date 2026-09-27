import assert from "node:assert/strict";
import test from "node:test";
import { runHarnessFindingRevision, type HarnessFindingRevisionInput } from "../src/harness-finding-revision.js";
import type { AgentTaskOptions, AgentTaskResult } from "../src/agent-task-runner.js";
const input: HarnessFindingRevisionInput={taskId:"test",firstAudit:{rawText:'Finding in prose quotes {"matched":true}; qualification remains outside JSON.',sessionId:"first-session",source:"frozen-first-output.md"},publicEvidence:{eventId:"actual-event",allCandidates:["A","B"]},artifacts:[{id:"card:test",kind:"agent_card",path:"actual-card.ts",roleId:"refine.aspect-matcher",content:{systemPrompt:"Current behavior"}}]};
const options={cwd:process.cwd(),rawEventsPath:"unused.events.jsonl",timeoutMs:1,provider:"fixture",model:"fixture",tools:"none" as const,systemPrompt:"Caller instruction",taskPurposes:[{taskId:"test",content:"Explicit purpose",style:null,authority:["User"]}],generatedEvaluationSkills:[{taskId:"test",content:"Fallible generated method"}]};
test("second H uses independent session and sends original prose/pool/artifact/criteria once without applying changes",async()=>{
 let sent:AgentTaskOptions|undefined,calls=0;const raw={finalText:"Prose with no candidate JSON",stopReason:"stop"} as AgentTaskResult;
 const out=await runHarnessFindingRevision(input,options,async o=>{calls++;sent=o;return raw;});
 assert.equal(calls,1);assert.equal(out.result,raw);assert.notEqual(sent?.session?.id,input.firstAudit.sessionId);
 assert.ok(sent?.prompt.includes(JSON.stringify(input)));assert.ok(sent?.systemPrompt?.includes("Explicit purpose"));assert.ok(sent?.systemPrompt?.includes("Fallible generated method"));assert.equal(sent?.tools,"none");
});
test("second H rejects source-task mismatch, duplicate artifact and reused first session before calls",async()=>{
 const never=async()=>{throw new Error("Provider must not run");};
 await assert.rejects(runHarnessFindingRevision({...input,taskId:"other"},options,never),/binding/);
 await assert.rejects(runHarnessFindingRevision({...input,artifacts:[input.artifacts[0]!,input.artifacts[0]!]},options,never),/unique/);
 await assert.rejects(runHarnessFindingRevision(input,{...options,session:{id:"first-session",dir:"unused"}},never),/independent/);
});
test("development method is opt-in and preserves explicit selected scope and original first audit",async()=>{
 const prompts:string[]=[];const runner=async(o:AgentTaskOptions)=>{prompts.push(o.prompt);return {finalText:'No candidates',stopReason:'stop'} as AgentTaskResult;};
 const scoped={...input,reviewEventIds:['actual-event']};await runHarnessFindingRevision(scoped,options,runner);
 await runHarnessFindingRevision(scoped,{...options,revisionMethod:'mechanism-candidate-v2'},runner);
 assert.ok(!prompts[0]!.includes('Candidate development method:'));assert.ok(prompts[1]!.includes('Candidate development method:'));
 for(const p of prompts){assert.ok(p.includes(JSON.stringify(scoped)));assert.ok(p.includes('other events are out of scope'));}
});
