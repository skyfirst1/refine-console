import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extract, matchDirection, runEvidenceAlignmentMode, type RefineExpertEvaluationOptions } from "../src/refine-expert-pipeline.js";
import { WorkflowControlError } from "../src/workflow-control.js";

test("optional evaluation contract reaches every Expert role without becoming source evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "expert-contract-"));
  try {
    const descriptionPath = join(root, "description.md"), documentPath = join(root, "document.md"), contractPath = join(root, "task-evaluation-contract.md");
    await Promise.all([writeFile(descriptionPath, "task"), writeFile(documentPath, "Visible fact."), writeFile(contractPath, "A public task comparison contract.")]);
    const aspect = {id:"aspect-1",title:"fact",description:"Visible fact.",evidences:[{quote:"Visible fact.",location:"paragraph 1"}]};
    const set = {sourceSha256:"frozen-document",descriptionSha256:"frozen-description",aspects:[aspect]};
    const match = {direction:"recall" as const,sourceAspectId:"aspect-1",targetAspectId:"aspect-1",matched:true,rationale:"historical"};
    const captured: any[] = [];
    const options: RefineExpertEvaluationOptions = {cwd:root,provider:"offline",model:"offline",timeoutMs:1000,runId:"contract",runDirectory:root,parentTaskId:"contract",evaluationId:"current",descriptionPath,goldPath:documentPath,documentPath,goldAspectSetPath:join(root,"unused.json"),outputPath:join(root,"unused-score.json"),runner:async invocation=>{captured.push(invocation);throw new WorkflowControlError("pause","Offline request capture");}};
    for (const withContract of [false,true]) {
      const context = {...options,...(withContract ? {taskEvaluationContractPath:contractPath} : {})};
      for (const invoke of [()=>extract(context,documentPath,join(root,"aspects.json"),"isolated-extraction",0),()=>matchDirection(context,"recall",set,set,root,["aspect-1"]),()=>runEvidenceAlignmentMode(context,match,set,set,root,0,"content"),()=>runEvidenceAlignmentMode(context,match,set,set,root,0,"style")]) {
        await assert.rejects(invoke, /Offline request capture/);
        const actual = captured.at(-1);
        assert.equal(actual.trace.inputRefs.includes(contractPath),withContract);
        assert.equal(actual.systemPrompt.includes("显式任务评价合同"),withContract);
        if(withContract) assert.match(actual.systemPrompt,/合同不是被比较文档的事实来源/);
      }
    }
    for(let i=0;i<4;i++) assert.equal(captured[i].prompt,captured[i+4].prompt);
  } finally { await rm(root,{recursive:true,force:true}); }
});
