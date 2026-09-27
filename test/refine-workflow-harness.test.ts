function selectedParagraphs(inputs: any[]) {
  const original: any[] = []; let serialized = "";
  for (const record of inputs.flatMap(input => input.publicRecords ?? [])) {
    if (record.kind.startsWith("serialized-record-json-part:")) {
      serialized += record.text;
      const [part, total] = record.kind.split(":")[1].split("/");
      if (part === total) { original.push(JSON.parse(serialized)); serialized = ""; }
    } else original.push(record);
  }
  const refs = original.flatMap((record: any) => {
    try { return JSON.parse(record.text).publicParagraphs?.map((paragraph: any) => paragraph.ref) ?? []; } catch { return []; }
  });
  return { selections: [...new Set<string>(refs)].map(anchorRef => ({ anchorRef, relatedRefs: [], purpose: "public-explanation" })) };
}
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { REFINE_WORKFLOW_CARDS } from "../src/refine-workflow-cards.js";
import { REVIEW_CONTRACT_EXAMPLE, validateReviewModelJson, runFixedRefineWorkflowHarness, runRefineDraftAgent, type RefineHarnessRunner } from "../src/refine-workflow-harness.js";
import type { AgentTaskOptions, AgentTaskResult } from "../src/agent-task-runner.js";
import { agentEventProvenance } from "../src/agent-task-runner.js";
import { auditRefineTraceIntegrity } from "../src/refine-trace-integrity.js";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, costUsd: 0 };

const validReviewGap = {
  id: "gap-1", summary: "缺少回滚策略", draftEvidence: "当前方案未覆盖", draftCounterevidence: "对应章节未找到同义回滚说明",
  goldEvidence: "Gold 回滚章节", expertRefs: ["recall-gold-risk"], sourceAvailability: "description-provided",
  activeSkillRelation: "refinement", nearestActiveSkillRule: "List risks.", descriptionSupport: "Description 要求风险与回滚",
  descriptionConflict: "", certainty: "supported", descriptionCompatibility: "compatible",
};

const validReviewFinding = {
  id: "skill-finding-1", summary: "要求风险与回滚成对输出，并保留 Description 内容合同", attribution: "Active Skill 只要求风险列表，未要求回滚",
  evidenceRefs: ["gap-1"], activeSkillRelation: "refinement", nearestActiveSkillRule: "List risks.",
  descriptionSupport: "Description 要求风险与回滚", descriptionConflict: "",
};

function judgePayload(verdict: "improved" | "regressed" = "improved") {
  const regressed = verdict === "regressed";
  return {
    verdict, currentScore: 18, candidateScore: regressed ? 16 : 24, currentHardPass: true, candidateHardPass: !regressed,
    slotChecks: [
      { id: "opening", scope: "opening", descriptionRequirement: "结论先行", currentEvidence: "当前稿开篇", candidateEvidence: regressed ? "候选删除" : "候选开篇", status: regressed ? "regressed" : "improved" },
      { id: "delivered-register", scope: "section", descriptionRequirement: "交付文档采用陈述口吻", currentEvidence: "当前使用陈述口吻", candidateEvidence: "候选使用陈述口吻", status: "preserved" },
      { id: "conclusion", scope: "conclusion", descriptionRequirement: "结论", currentEvidence: "当前结论", candidateEvidence: "候选结论", status: "preserved" },
      { id: "cross-document", scope: "cross-document", descriptionRequirement: "全篇自洽", currentEvidence: "当前一致", candidateEvidence: "候选一致", status: "preserved" },
    ],
    regressions: regressed ? [{ id: "regression-1", category: "description-slot", slotCheckIds: ["opening"], summary: "候选删除开篇结论", descriptionEvidence: "Description 要求结论先行", currentEvidence: "当前稿保留", candidateEvidence: "候选稿缺失" }] : [],
    reason: regressed ? "候选引入硬约束回归" : "候选补齐回滚且无回归",
  };
}

function result(options: AgentTaskOptions, finalText: string, includeReads = true): AgentTaskResult {
  const readsEnabled = includeReads && options.tools !== "none" && options.tools !== "trace";
  const inputRefs = readsEnabled ? options.trace?.inputRefs ?? [] : [];
  const events = [
    { type: "session" }, { type: "agent_start" }, { type: "turn_start" },
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: options.prompt }] } },
    ...inputRefs.flatMap((path, index) => [{ type: "tool_execution_start", toolCallId: `read-${index}`, toolName: "read", args: { path } }, { type: "tool_execution_end", toolCallId: `read-${index}`, toolName: "read", result: { content: [{ type: "text", text: `read ${path}` }] }, isError: false }]),
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText }], stopReason: "stop", usage } },
    { type: "turn_end" }, { type: "agent_end" }, { type: "agent_settled" },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
  writeFileSync(options.rawEventsPath, events, "utf8");
  return { finalText, rawEventsPath: options.rawEventsPath, readPaths: [...inputRefs], toolNames: readsEnabled ? ["read"] : [], usage, eventProvenance: agentEventProvenance(events) };
}

function runner(calls: AgentTaskOptions[], mode: "improved" | "regressed" | "equal" | "no-findings" = "improved"): RefineHarnessRunner {
  return async (options) => {
    calls.push(options);
    const stage = String(options.trace?.stage);
    if (stage.includes("aspect-extraction")) {
      const source = await readFile(options.trace!.inputRefs![1]!, "utf8");
      const id = source.includes("# Gold") ? "gold-risk" : source.includes("候选") ? "candidate-risk" : "current-risk";
      return result(options, `<<<ASPECT_SET_START>>>\n${JSON.stringify({ aspects: [{ id, title: "风险与回滚", description: "风险与回滚要求", evidences: [{ quote: source.trim(), location: "全文" }] }] })}\n<<<ASPECT_SET_END>>>`);
    }
    if (stage.includes("-match-")) {
      const source = JSON.parse(await readFile(options.trace!.inputRefs![0]!, "utf8")) as { direction: string; sourceAspect: { id: string } };
      const target = JSON.parse(await readFile(options.trace!.inputRefs![1]!, "utf8")) as { aspects: Array<{ id: string }> };
      return result(options, `<<<ASPECT_MATCH_START>>>\n${JSON.stringify({ direction: source.direction, sourceAspectId: source.sourceAspect.id, targetAspectId: target.aspects[0]!.id, matched: true, rationale: "语义对应" })}\n<<<ASPECT_MATCH_END>>>`);
    }
    if (stage.includes("-alignment-")) {
      const input = JSON.parse(await readFile(options.trace!.inputRefs![0]!, "utf8")) as { mode: string };
      const candidate = stage.startsWith("candidate-");
      const matched = candidate ? mode === "improved" || mode === "equal" && input.mode === "content" : input.mode === "content";
      return result(options, `<<<EVIDENCE_ALIGNMENT_START>>>\n${JSON.stringify({ matched, rationale: matched ? "对齐" : "未对齐" })}\n<<<EVIDENCE_ALIGNMENT_END>>>`);
    }
    if (stage === "refine-trace-semantic-compression") {
      const inputs = await Promise.all(options.trace!.inputRefs!.map(async (path) => JSON.parse(await readFile(path, "utf8")))); const input = inputs[0];
      return result(options, JSON.stringify(selectedParagraphs(inputs)));
    }
    if (stage === "refine-trace-semantic-reduction") {
      const input = JSON.parse(await readFile(options.trace!.inputRefs![0]!, "utf8")); const fragment = { stageFamily: input.stageFamily, roleId: input.roleId,
        attemptsConsidered: input.attemptsConsidered, sourcePublicRecords: input.sourcePublicRecords, taskAndInputs: "All fragment task inputs were combined.",
        events: input.semanticFragments.flatMap((fragment: any) => fragment.events),
        finalOutcome: "Terminal outcomes were retained.", limitations: "No private reasoning was inferred." };
      return result(options, `<<<TRACE_SUMMARY_START>>>\n${JSON.stringify(fragment)}\n<<<TRACE_SUMMARY_END>>>`);
    }
    if (stage === "trace-first-harness-evolution-audit") {
      if (["preparation", "proposal-revision"].includes(String(options.trace!.attributes?.["agent.phase"]))) {
        const ledger = { schemaVersion: "1.0", category: "refine_behavior_audit_proposal_ledger", proposals: [] };
        return result(options, `<<<AUDIT_LEDGER_START>>>\n${JSON.stringify(ledger)}\n<<<AUDIT_LEDGER_END>>>`);
      }
      const audit = { schemaVersion: "4.0", category: "trace_first_harness_evolution_paths", taskType: "document_refine",
        taskProfile: { documentTaskType: "document_refine", taskCharacteristics: ["document style refinement"] }, evolutionPaths: [], limitations: ["The unit fixture does not establish a task-specific remaining behavior failure."] };
      return result(options, `<<<REFINE_TASK_AUDIT_START>>>\n${JSON.stringify(audit)}\n<<<REFINE_TASK_AUDIT_END>>>`);
    }
    switch (stage) {
      case "description-reconstruction":
        return result(options, `<<<DESCRIPTION_START>>>\n# 迁移方案任务\n\n编写一份完整迁移方案，说明目标、范围、阶段、依赖、风险、回滚和验收。方案应区分当前状态与目标状态，保持事实准确，不能虚构外部能力。每项重大风险都要给出缓解措施和可执行的回滚条件；验收部分需要覆盖功能、数据一致性和可观测性。输出使用简洁中文 Markdown，先给结论，再给实施步骤，并明确本次 Demo 不包含数据库、消息队列或其他无关基础设施扩展。\n\n方案需要解释输入与输出边界、版本兼容关系、失败后的恢复方式以及验收负责人能够复核的证据。实施阶段按先验证、再迁移、后观察的顺序组织；每个阶段写清前置条件、产物与退出标准。不得为了篇幅完整加入无关平台或假设，也不能把一次性项目事实写成可复用规则。最终结论要指出仍未验证的风险，避免将候选状态误写为已经上线。\n<<<DESCRIPTION_END>>>`);
      case "current-draft-generation":
        return result(options, "<<<DRAFT_START>>>\n# 当前方案\n\n迁移步骤，但风险不完整。\n<<<DRAFT_END>>>");
      case "skill-review":
        if (options.trace?.attributes?.["agent.phase"] === "preparation") {
          return result(options, "覆盖：opening；Description 全部主要章节/分组；跨章节组织与边界重复；conclusion；delivered-register。\n第一版候选观察：风险与回滚的成对表达。\nREVIEW_ROUND_1_READY");
        }
        if (options.trace?.attributes?.["agent.phase"] === "revision") {
          return result(options, "第二轮主动反驳：检查 Draft 反证、Active Skill 语义近邻、Description 冲突与 Gold 实例泄漏；保留经修订的风险与回滚方法。\nREVIEW_ROUND_2_READY", false);
        }
        if (mode === "no-findings") return result(options, "<<<REVIEW_START>>>\n{\"documentGaps\":[],\"skillFindings\":[],\"uncertainties\":[]}\n<<<REVIEW_END>>>", false);
        return result(options, `<<<REVIEW_START>>>\n${JSON.stringify({ documentGaps: [validReviewGap], skillFindings: [validReviewFinding], uncertainties: [] })}\n<<<REVIEW_END>>>`, false);
      case "candidate-skill-compilation":
        return result(options, "<<<CANDIDATE_SKILL_START>>>\n---\nname: writing-policy\ndescription: Write migration reports with grounded risks.\nversion: v2\n---\n\n# Rules\n\nPreserve all existing rules. Pair every material risk with a rollback or mitigation.\n<<<CANDIDATE_SKILL_END>>>");
      case "candidate-draft-generation":
        return result(options, "<<<DRAFT_START>>>\n# 候选方案\n\n迁移步骤、风险与对应回滚策略。\n<<<DRAFT_END>>>");
      case "independent-judge":
        return result(options, `<<<JUDGE_START>>>\n${JSON.stringify(judgePayload(mode === "improved" ? "improved" : "regressed"))}\n<<<JUDGE_END>>>`);
      default:
        throw new Error(`unexpected stage ${options.trace?.stage}`);
    }
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "refine-gold-skill-"));
  const requirementsPath = join(root, "trace.json");
  const rulesPath = join(root, "rules.json");
  const goldPath = join(root, "gold.md");
  const activeSkillPath = join(root, "SKILL.md");
  await Promise.all([
    writeFile(requirementsPath, "用户要求迁移方案。\n", "utf8"),
    writeFile(rulesPath, "{}\n", "utf8"),
    writeFile(goldPath, "# Gold\n\n包含风险与回滚。\n", "utf8"),
    writeFile(activeSkillPath, "---\nname: writing-policy\ndescription: Write migration reports.\nversion: v1\n---\n\n# Rules\n\nList risks.\n", "utf8"),
  ]);
  return { root, requirementsPath, rulesPath, goldPath, activeSkillPath };
}

test("cards expose Gold + Active Skill workflow without Revision Agent", () => {
  const workflow = REFINE_WORKFLOW_CARDS["refine.workflow"];
  assert.deepEqual(workflow.inputContract, ["requirementsPath", "goldPath", "activeSkillPath", "rulesPath", "runRoot"]);
  assert.equal("refine.revision" in REFINE_WORKFLOW_CARDS, false);
  assert.deepEqual(REFINE_WORKFLOW_CARDS["refine.draft"].inputContract, ["descriptionPath", "skillPath"]);
  assert.match(REFINE_WORKFLOW_CARDS["refine.draft"].systemPrompt, /Description 提取明确要求的内容槽位[\s\S]*具体值[\s\S]*泛化替代/);
  assert.match(REFINE_WORKFLOW_CARDS["refine.draft"].systemPrompt, /章节\/分组、顺序、枚举成员及归属关系[\s\S]*不得新增、删除、合并、改挂/);
  assert.deepEqual(REFINE_WORKFLOW_CARDS["refine.review"].callableSubagents, []);
  assert.equal(REFINE_WORKFLOW_CARDS["refine.review"].runtime, "pi-session");
  assert.deepEqual(workflow.tools, ["refine_workflow", "refine_workflow_cards"]);
  assert.match(workflow.digest, /^[a-f0-9]{64}$/);
  assert.match(REFINE_WORKFLOW_CARDS["refine.review"].systemPrompt, /同一 Agent session[\s\S]*三轮[\s\S]*主动反驳[\s\S]*最多 5 条/);
  assert.match(REFINE_WORKFLOW_CARDS["refine.review"].systemPrompt, /对应章节原文并记录最强反证[\s\S]*类别总述不得误报/);
  assert.match(REFINE_WORKFLOW_CARDS["refine.review"].systemPrompt, /new、refinement、duplicate 或 conflict[\s\S]*语义近义算 duplicate[\s\S]*不得编译/);
  assert.match(REFINE_WORKFLOW_CARDS["refine.review"].systemPrompt, /正文、对比、结论[\s\S]*不得建议收敛为一次定义/);
  assert.match(REFINE_WORKFLOW_CARDS["refine.policy-optimizer"].systemPrompt, /完整读取 Description、Active Skill 与结构化 Review/);
  assert.match(REFINE_WORKFLOW_CARDS["refine.policy-optimizer"].systemPrompt, /duplicate[\s\S]*跳过[\s\S]*refinement[\s\S]*line-local/);
  assert.match(REFINE_WORKFLOW_CARDS["refine.policy-optimizer"].systemPrompt, /正文、对比、结论[\s\S]*不得编译成只允许一次定义/);
  assert.doesNotMatch(REFINE_WORKFLOW_CARDS["refine.policy-optimizer"].systemPrompt, /缺少下游可用来源/);
  assert.equal(REFINE_WORKFLOW_CARDS["refine.independent-judge"].runtime, "pi-session");
  assert.match(REFINE_WORKFLOW_CARDS["refine.independent-judge"].systemPrompt, /slotChecks[\s\S]*开篇[\s\S]*结论/);
  assert.match(REFINE_WORKFLOW_CARDS["refine.independent-judge"].systemPrompt, /regressions[\s\S]*Candidate 特有退化/);
  assert.match(REFINE_WORKFLOW_CARDS["refine.independent-judge"].systemPrompt, /不读取 Review 或 Candidate Skill[\s\S]*不推断因果/);
});

test("standalone Draft reads Description and Skill but never Gold", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const outputPath = join(f.root, "draft.md");
  await runRefineDraftAgent({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    descriptionPath: f.requirementsPath, skillPath: f.activeSkillPath, outputPath, runner: runner(calls) });
  assert.deepEqual(calls[0]!.trace?.inputRefs, [f.requirementsPath, f.activeSkillPath]);
  assert.equal(calls[0]!.trace?.inputRefs?.includes(f.goldPath), false);
  assert.match(await readFile(outputPath, "utf8"), /当前方案/);
});

test("frozen Description is copied byte-for-byte into two workflow fixtures without a fabricated model attempt", async () => {
  const f = await fixture();
  const frozenDescriptionPath = join(f.root, "frozen-description.md");
  const description = `# 迁移方案\r\n\r\n${"说明迁移背景、适用范围、上线顺序、风险分析和对应回滚策略。保留每个阶段的负责人、输入条件、检查项目和完成标准。".repeat(5)}\r\n`;
  await writeFile(frozenDescriptionPath, description, "utf8");
  for (let index = 0; index < 2; index += 1) {
    const calls: AgentTaskOptions[] = [];
    const workflow = await runFixedRefineWorkflowHarness({ ...f, cwd: f.root, provider: "test-provider", model: "test-model", timeoutMs: 1_000,
      runRoot: join(f.root, "runs"), frozenDescriptionPath, runner: runner(calls) });
    assert.equal(await readFile(workflow.descriptionPath, "utf8"), description);
    assert.equal(calls.some((call) => call.trace?.stage === "description-reconstruction"), false);
    const manifest = JSON.parse(await readFile(workflow.manifestPath, "utf8"));
    assert.equal(manifest.inputs.frozenDescriptionPath, frozenDescriptionPath);
    const stage = manifest.stages[0];
    assert.equal(stage.kind, "deterministic-tool");
    assert.equal(stage.eventsPath, null);
    assert.equal(stage.provider, null);
    assert.equal(stage.inputArtifacts[0].sha256, stage.outputArtifacts[0].sha256);
    assert.equal(stage.inputArtifacts[0].path, frozenDescriptionPath);
    const integrity = await auditRefineTraceIntegrity(manifest.stages);
    assert.equal(integrity.findings.length, 0);
  }
});

test("fixed Refine loop promotes on Skill and Expert gates while keeping Judge advisory", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const workflow = await runFixedRefineWorkflowHarness({
    cwd: f.root, provider: "test-provider", model: "test-model", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath,
    activeSkillPath: f.activeSkillPath, runRoot: join(f.root, "runs"), runner: runner(calls), executionMode: "workflow",
  });
  assert.equal(workflow.status, "promoted");
  assert.match(await readFile(workflow.candidateSkillPath, "utf8"), /name: writing-policy/);
  const manifest = JSON.parse(await readFile(workflow.manifestPath, "utf8")) as any;
  assert.equal(manifest.executionMode, "workflow");
  assert.equal(manifest.harnessVersion, "refine-workflow-harness-v2");
  assert.ok(["available", "unavailable"].includes(manifest.sourceProvenance.availability));
  assert.match(manifest.stages[0].card.promptDigest, /^[a-f0-9]{64}$/);
  assert.match(manifest.stages[0].card.schemaDigest, /^[a-f0-9]{64}$/);
  assert.match(manifest.stages[0].card.toolDigest, /^[a-f0-9]{64}$/);
  assert.ok(manifest.stages.every((stage: any) => stage.adapterProvenance?.availability));
  assert.ok(manifest.stages.flatMap((stage: any) => stage.attempts ?? []).every((attempt: any) => attempt.adapterProvenance?.availability));
  assert.ok(manifest.stages.flatMap((stage: any) => stage.subtasks ?? []).every((subtask: any) => subtask.adapterProvenance?.availability === "available" && /^[a-f0-9]{64}$/.test(subtask.adapterProvenance.digest)));
  assert.deepEqual(manifest.stages.map((stage: any) => stage.stage), [
    "description-reconstruction", "current-draft-generation", "draft-expert-evaluation", "skill-review",
    "candidate-skill-compilation", "candidate-draft-generation", "candidate-expert-evaluation", "independent-judge", "promotion-decision",
  ]);
  assert.equal(manifest.guarantees.baselineBusinessInput, false);
  assert.equal(manifest.guarantees.activeSkillOverwritten, false);
  assert.equal(manifest.guarantees.expertRegressionTriggersHarnessEvolution, true);
  assert.deepEqual(manifest.inputs.artifacts.map((entry: any) => entry.path), [f.requirementsPath, f.goldPath, f.activeSkillPath, f.rulesPath]);

  const byStage = new Map(calls.map((call) => [call.trace?.stage, call.trace?.inputRefs ?? []]));
  for (const stage of ["current-draft-generation", "candidate-draft-generation"]) {
    assert.equal(byStage.get(stage)?.includes(f.goldPath), false, `${stage} must not see Gold`);
    const call = calls.find((entry) => entry.trace?.stage === stage)!;
    assert.match(call.prompt, /内容槽位[\s\S]*具体值[\s\S]*泛化替代/);
  }
  assert.equal(byStage.get("skill-review")?.includes(f.goldPath), true);
  assert.deepEqual(byStage.get("candidate-skill-compilation"), [workflow.descriptionPath, f.activeSkillPath, workflow.reviewPath]);
  assert.equal(byStage.get("candidate-skill-compilation")?.includes(f.goldPath), false);
  const reviewCalls = calls.filter((call) => call.trace?.stage === "skill-review");
  assert.equal(reviewCalls.length, 3);
  assert.equal(new Set(reviewCalls.map((call) => call.session?.id)).size, 1);
  assert.equal(reviewCalls[0]!.trace?.attributes?.["agent.phase"], "preparation");
  assert.equal(reviewCalls[1]!.trace?.attributes?.["agent.phase"], "revision");
  assert.equal(reviewCalls[2]!.trace?.attributes?.["agent.phase"], "submission");
  assert.match(reviewCalls[0]!.prompt, /Description 和文档体裁[\s\S]*实际需要[\s\S]*只在任务要求或体裁适用时[\s\S]*不得向其他体裁强加报告结构/);
  assert.match(reviewCalls[0]!.prompt, /不要求凑满[\s\S]*最多十条/);
  assert.match(reviewCalls[0]!.prompt, /REVIEW_ROUND_1_READY/);
  assert.match(reviewCalls[1]!.prompt, /主动反驳[\s\S]*最强反证[\s\S]*语义而非字面[\s\S]*REVIEW_ROUND_2_READY/);
  assert.match(reviewCalls[1]!.prompt, /执行不佳不能包装成 new[\s\S]*近义方法归 duplicate[\s\S]*Gold 提供的产品名/);
  assert.match(reviewCalls[2]!.prompt, /执行不佳不是 new[\s\S]*语义近义是 duplicate/);
  assert.match(reviewCalls[2]!.prompt, /uncertainty[\s\S]*不能被 skillFindings 引用/);
  assert.match(reviewCalls[2]!.prompt, /正文、对比、结论[\s\S]*不得收敛成一次定义/);
  assert.match(reviewCalls[2]!.prompt, /从 \{ 开始、以 \} 结束[\s\S]*裸 JSON 对象[\s\S]*不得输出[\s\S]*Artifact 标记/);
  assert.doesNotMatch(reviewCalls[2]!.prompt, /每个数组最多 3 项|每段文字不超过 100 字/);
  const reviewStage = manifest.stages.find((stage: any) => stage.stage === "skill-review");
  assert.deepEqual(reviewStage.attempts.map((attempt: any) => attempt.phase), ["preparation", "revision", "submission"]);
  assert.equal(reviewStage.attempts[0].readPaths.length, 5);
  assert.deepEqual(reviewStage.attempts[1].readPaths, []);
  assert.deepEqual(reviewStage.attempts[2].readPaths, []);
  const optimizerCall = calls.find((call) => call.trace?.stage === "candidate-skill-compilation")!;
  assert.match(optimizerCall.prompt, /冻结内容合同 Description[\s\S]*不得只信 Reviewer 转述/);
  assert.match(optimizerCall.prompt, /duplicate[\s\S]*跳过[\s\S]*refinement[\s\S]*line-local/);
  assert.match(optimizerCall.prompt, /每一处新增、改写或删除[\s\S]*直接对应一条有效 Finding/);
  assert.match(optimizerCall.prompt, /保留 frontmatter[\s\S]*不得顺手清理、泛化或重写/);
  assert.match(optimizerCall.prompt, /正文、对比、结论[\s\S]*不得编译成“只定义一次”/);

  const judgeCalls = calls.filter((call) => call.trace?.stage === "independent-judge");
  assert.equal(judgeCalls.length, 2);
  assert.equal(judgeCalls[0]!.session?.id, judgeCalls[1]!.session?.id);
  assert.equal(judgeCalls[0]!.session?.dir, judgeCalls[1]!.session?.dir);
  assert.equal(judgeCalls[0]!.trace?.attributes?.["agent.phase"], "preparation");
  assert.equal(judgeCalls[1]!.trace?.attributes?.["agent.phase"], "submission");
  assert.match(judgeCalls[0]!.prompt, /Description 明定的内容槽位[\s\S]*已给具体值[\s\S]*opening 与 conclusion[\s\S]*not-required/);
  assert.match(judgeCalls[1]!.prompt, /开篇核心结论[\s\S]*同一适用范围[\s\S]*不同条件下的陈述不能直接判为矛盾[\s\S]*写作指令/);
  assert.match(judgeCalls[1]!.prompt, /不得推断 Skill 规则与 Draft 执行之间的因果/);
  assert.deepEqual(judgeCalls[0]!.trace?.outputRefs, []);
  const judgeStage = manifest.stages.find((stage: any) => stage.stage === "independent-judge");
  assert.equal(judgeStage.card.runtime, "pi-session");
  assert.equal(judgeStage.session.id, judgeCalls[0]!.session?.id);
  assert.deepEqual(judgeStage.attempts.map((attempt: any) => attempt.phase), ["preparation", "submission"]);

  const decision = JSON.parse(await readFile(workflow.promotionDecisionPath, "utf8")) as any;
  assert.equal(decision.decision, "promote");
  assert.equal(decision.activeSkillOverwritten, false);
  assert.equal(decision.expertScoreMetric, "f1");
  assert.deepEqual(decision.requiredGates, ["skillChanged", "hasAttributedFindings", "expertImproved", "expertHardPassPreserved"]);
  assert.ok(decision.requiredGates.every((gate: string) => decision.gates[gate]));
  assert.deepEqual(decision.judgeAdvisory, { blocking: false, artifactAvailable: true, verdict: "improved", scoreDelta: 6, hardPassPreserved: true });
  assert.match(await readFile(f.activeSkillPath, "utf8"), /version: v1/);
});

test("single-surface task-family Harness Profile reaches only its selected Reviewer prompt", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const profile = {
    profileId: "migration-report-style-v1", version: "v1", taskFamily: "migration_report",
    taskConditions: ["Description requests a staged migration report."],
    negativeControls: ["Do not apply to resume entries."], sourceRun: "trace/run-1",
    evidenceSummary: "Final role traces retain a task-conditioned style-method gap.",
    roleOverlays: [{ roleId: "refine.review" as const, sourceProposalId: "proposal-review-1", surface: "prompt" as const, capabilityGap: "review gap", expectedBehavior: "review behavior", activationCondition: "Description requests a staged migration report.", evidenceRefs: ["trace:review"], revisionTrajectory: { initialObservation: "Review missed the stage relation.", selfCorrection: "Review corrected labels only.", residualFailure: "Review still missed the reusable stage relation." }, instruction: "REVIEW_STAGE_OVERLAY" }],
  };
  const workflow = await runFixedRefineWorkflowHarness({
    cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath,
    activeSkillPath: f.activeSkillPath, runRoot: join(f.root, "profile-runs"), runner: runner(calls), executionMode: "workflow",
    taskType: "migration_report", harnessProfile: profile,
  });
  const reviewCalls = calls.filter((call) => call.trace?.stage === "skill-review");
  assert.equal(reviewCalls.length, 3);
  assert.ok(reviewCalls.every((call) => call.prompt.includes("REVIEW_STAGE_OVERLAY") && call.prompt.includes("Description requests a staged migration report") && call.prompt.includes("Do not apply to resume entries")));
  const extractCalls = calls.filter((call) => String(call.trace?.stage).includes("aspect-extraction"));
  assert.ok(extractCalls.length >= 2);
  assert.ok(extractCalls.every((call) => !call.systemPrompt.includes("REVIEW_STAGE_OVERLAY") && !call.prompt.includes("REVIEW_STAGE_OVERLAY")));
  const optimizer = calls.find((call) => call.trace?.stage === "candidate-skill-compilation")!;
  assert.doesNotMatch(`${optimizer.systemPrompt}\n${optimizer.prompt}`, /REVIEW_STAGE_OVERLAY/);
  for (const call of calls.filter((entry) => ["current-draft-generation", "candidate-draft-generation", "independent-judge"].includes(String(entry.trace?.stage)))) {
    assert.doesNotMatch(`${call.systemPrompt}\n${call.prompt}`, /REVIEW_STAGE_OVERLAY/);
  }
  const manifest = JSON.parse(await readFile(workflow.manifestPath, "utf8")) as any;
  assert.deepEqual(manifest.harnessProfile, { profileId: "migration-report-style-v1", version: "v1", taskFamily: "migration_report", appliedRoles: ["refine.review"] });
});

test("Expert improvement promotes despite Judge rejection and preserves the advisory Artifact without triggering Harness", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const base = runner(calls, "improved");
  const advisoryReject: RefineHarnessRunner = async (options) => {
    if (options.trace?.stage === "independent-judge" && options.trace.attributes?.["agent.phase"] === "submission") {
      calls.push(options);
      return result(options, `<<<JUDGE_START>>>\n${JSON.stringify({ ...judgePayload("regressed"), currentScore: 24, candidateScore: 18, reason: "advisory rejection" })}\n<<<JUDGE_END>>>`);
    }
    return base(options);
  };
  const workflow = await runFixedRefineWorkflowHarness({
    cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath,
    activeSkillPath: f.activeSkillPath, runRoot: join(f.root, "runs"), runner: advisoryReject, executionMode: "workflow",
  });
  assert.equal(workflow.status, "promoted");
  const decision = JSON.parse(await readFile(workflow.promotionDecisionPath, "utf8")) as any;
  assert.equal(decision.gates.expertImproved, true);
  assert.equal(decision.gates.judgeImproved, false);
  assert.equal(decision.judgeAdvisory.blocking, false);
  assert.equal(decision.judgeAdvisory.verdict, "regressed");
  const judge = JSON.parse(await readFile(workflow.judgePath!, "utf8")) as any;
  assert.equal(judge.verdict, "regressed");
  const manifest = JSON.parse(await readFile(workflow.manifestPath, "utf8")) as any;
  assert.equal(manifest.selfCheck.status, "not-triggered");
  assert.equal(manifest.selfCheck.reason, "no-candidate-expert-regression");
  assert.equal(calls.some((call) => call.trace?.stage === "trace-first-harness-evolution-audit"), false);
});

test("Expert regression triggers Harness even when Judge is positive", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const base = runner(calls, "regressed");
  const advisoryApprove: RefineHarnessRunner = async (options) => {
    if (options.trace?.stage === "independent-judge" && options.trace.attributes?.["agent.phase"] === "submission") {
      calls.push(options);
      return result(options, `<<<JUDGE_START>>>\n${JSON.stringify({ ...judgePayload("improved"), reason: "advisory approval" })}\n<<<JUDGE_END>>>`);
    }
    return base(options);
  };
  const workflow = await runFixedRefineWorkflowHarness({
    cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath,
    activeSkillPath: f.activeSkillPath, runRoot: join(f.root, "runs"), runner: advisoryApprove, executionMode: "workflow",
  });
  assert.equal(workflow.status, "rejected");
  const decision = JSON.parse(await readFile(workflow.promotionDecisionPath, "utf8")) as any;
  assert.equal(decision.gates.expertImproved, false);
  assert.equal(decision.judgeAdvisory.verdict, "improved");
  const manifest = JSON.parse(await readFile(workflow.manifestPath, "utf8")) as any;
  assert.equal(manifest.selfCheck.status, "triggered");
  assert.deepEqual(manifest.selfCheck.businessTriggerReasons, ["expert-regression"]);
  const summary = await readFile(join(dirname(manifest.selfCheck.behaviorAuditPath), "agent-configuration-snapshots", "audit-default-summary.json"), "utf8");
  assert.ok(Buffer.byteLength(summary) < 45_000, "configuration summary must fit the actual encoded read budget");
  const decoded = JSON.parse(summary);
  assert.ok(decoded.compactSnapshots.length > 0);
  assert.ok(decoded.compactSnapshots.every((snapshot: any) => snapshot.roleId && snapshot.snapshotPath && snapshot.evidencePolicy));
  assert.equal(summary, `${JSON.stringify(decoded)}\n`, "budget savings change whitespace, not payload fields");
});

test("controlled history experiment defers auxiliary diagnostics while preserving the real regression decision", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const originalSkill = await readFile(f.activeSkillPath, "utf8");
  const workflow = await runFixedRefineWorkflowHarness({
    cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath,
    activeSkillPath: f.activeSkillPath, runRoot: join(f.root, "runs"), runner: runner(calls, "regressed"),
    auxiliaryDiagnostics: "deferred-for-controlled-experiment",
  });
  const manifest = JSON.parse(await readFile(workflow.manifestPath, "utf8"));
  const decision = JSON.parse(await readFile(workflow.promotionDecisionPath, "utf8"));
  assert.equal(workflow.status, "rejected");
  assert.equal(decision.gates.expertImproved, false);
  assert.equal(decision.gates.judgeImproved, false);
  assert.equal(manifest.selfCheck.status, "not-triggered");
  assert.equal(manifest.selfCheck.reason, "auxiliary-diagnostics-deferred-for-controlled-experiment");
  assert.deepEqual(manifest.selfCheck.businessTriggerReasons, ["expert-regression"]);
  assert.equal(manifest.auxiliaryDiagnostics.mode, "deferred-for-controlled-experiment");
  assert.equal(manifest.auxiliaryDiagnostics.engineeringDiagnosis, "deferred");
  assert.equal(manifest.auxiliaryDiagnostics.behaviorAudit, "deferred");
  assert.equal(manifest.guarantees.expertRegressionTriggersHarnessEvolution, false);
  assert.equal(calls.some((call) => /harness|semantic-compression|semantic-reduction/.test(call.trace?.stage ?? "")), false);
  assert.ok(manifest.stages.some((stage: any) => stage.stage === "candidate-expert-evaluation" && stage.status === "completed"));
  assert.ok(manifest.stages.some((stage: any) => stage.stage === "independent-judge" && stage.status === "completed"));
  assert.equal(await readFile(f.activeSkillPath, "utf8"), originalSkill);
  assert.equal("engineeringFailureDiagnosis" in manifest.selfCheck, false);
  assert.equal("behaviorAuditPath" in manifest.selfCheck, false);
  const callsBeforeResume = calls.length;
  await assert.rejects(runFixedRefineWorkflowHarness({
    cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath,
    activeSkillPath: f.activeSkillPath, runRoot: join(f.root, "runs"), runner: runner(calls, "regressed"),
    resumeRunDirectory: workflow.runDirectory,
  }), /Resume input changed: auxiliaryDiagnostics/);
  assert.equal(calls.length, callsBeforeResume);
});

test("equal Expert f1 is not treated as a Harness regression trigger", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const workflow = await runFixedRefineWorkflowHarness({
    cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath,
    activeSkillPath: f.activeSkillPath, runRoot: join(f.root, "runs"), runner: runner(calls, "equal"), executionMode: "workflow",
  });
  const decision = JSON.parse(await readFile(workflow.promotionDecisionPath, "utf8")) as any;
  assert.equal(decision.expertScoreDelta, 0);
  const manifest = JSON.parse(await readFile(workflow.manifestPath, "utf8")) as any;
  assert.equal(manifest.selfCheck.status, "not-triggered");
  assert.equal(manifest.selfCheck.reason, "no-candidate-expert-regression");
  assert.equal(calls.some((call) => call.trace?.stage === "trace-first-harness-evolution-audit"), false);
});

test("Expert and Judge regression deterministically rejects the candidate", async () => {
  const f = await fixture();
  const workflow = await runFixedRefineWorkflowHarness({
    cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath,
    activeSkillPath: f.activeSkillPath, runRoot: join(f.root, "runs"), runner: runner([], "regressed"), executionMode: "workflow",
  });
  assert.equal(workflow.status, "rejected");
  const decision = JSON.parse(await readFile(workflow.promotionDecisionPath, "utf8")) as any;
  assert.equal(decision.gates.expertImproved, false);
  assert.equal(decision.gates.expertHardPassPreserved, true);
  assert.equal(decision.gates.judgeImproved, false);
  assert.equal(decision.gates.judgeHardPassPreserved, false);
  const manifest = JSON.parse(await readFile(workflow.manifestPath, "utf8")) as any;
  assert.equal(manifest.selfCheck.status, "triggered");
  assert.equal(manifest.selfCheck.reason, "refine-business-regression");
  assert.deepEqual(manifest.selfCheck.businessTriggerReasons, ["expert-regression"]);
  assert.equal(manifest.selfCheck.businessRoleStatePaths.length, 5);
  assert.ok(manifest.selfCheck.behaviorAuditPath.endsWith("behavior-audit-result.json"));
  assert.ok(manifest.selfCheck.engineeringDiagnosticsPath.endsWith("engineering-diagnostics.json"));
  assert.ok(manifest.selfCheck.engineeringFailureDiagnosis, "legacy V1 remains available only as nested engineering diagnostics");
});

test("Reviewer format correction reuses the prepared Agent session and only repairs structure", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const base = runner(calls);
  let first = true;
  const retrying: RefineHarnessRunner = async (options) => {
    if (options.trace?.stage === "skill-review" && options.trace.attributes?.["agent.phase"] === "submission" && first) {
      first = false;
      calls.push(options);
      const artifact = JSON.stringify({ documentGaps: [validReviewGap], skillFindings: [validReviewFinding], uncertainties: [] });
      return result(options, `${artifact}\n${artifact}`, false);
    }
    return base(options);
  };
  const workflow = await runFixedRefineWorkflowHarness({
    cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath,
    activeSkillPath: f.activeSkillPath, runRoot: join(f.root, "runs"), runner: retrying, executionMode: "workflow",
  });
  const manifest = JSON.parse(await readFile(workflow.manifestPath, "utf8")) as any;
  const review = manifest.stages.find((stage: any) => stage.stage === "skill-review");
  assert.deepEqual(review.attempts.map((attempt: any) => attempt.status), ["completed", "completed", "failed", "completed"]);
  assert.deepEqual(review.attempts.map((attempt: any) => attempt.phase), ["preparation", "revision", "submission", "submission"]);
  const reviewCalls = calls.filter((call) => call.trace?.stage === "skill-review");
  assert.equal(new Set(reviewCalls.map((call) => call.session?.id)).size, 1);
  assert.deepEqual(reviewCalls[0]!.trace?.inputRefs, reviewCalls[3]!.trace?.inputRefs);
  assert.match(review.attempts[2].error, /bare JSON object|exactly one Artifact|non-whitespace character after JSON/);
  assert.match(reviewCalls[3]!.prompt, /只纠正 JSON 结构或校验指出的内部一致性问题[\s\S]*不重新发散发现/);
  assert.deepEqual(review.attempts[1].readPaths, []);
  assert.deepEqual(review.attempts[2].readPaths, []);
  assert.deepEqual(review.attempts[3].readPaths, []);
});

test("no attributable Skill findings preserve the complete Active Skill and reject promotion", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const workflow = await runFixedRefineWorkflowHarness({
    cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath,
    activeSkillPath: f.activeSkillPath, runRoot: join(f.root, "runs"), runner: runner(calls, "no-findings"), executionMode: "workflow",
  });
  assert.equal(workflow.status, "rejected");
  assert.equal(await readFile(workflow.candidateSkillPath, "utf8"), await readFile(f.activeSkillPath, "utf8"));
  assert.equal(calls.some((call) => call.trace?.stage === "candidate-skill-compilation"), false);
  assert.equal(calls.some((call) => call.trace?.stage === "candidate-draft-generation"), false);
  assert.equal(calls.some((call) => call.trace?.stage === "candidate-expert-evaluation"), false);
  assert.equal(calls.some((call) => call.trace?.stage === "independent-judge"), false);
  assert.equal(workflow.candidateDraftPath, undefined);
  assert.equal(workflow.candidateExpertReportPath, undefined);
  assert.equal(workflow.judgePath, undefined);
  const manifest = JSON.parse(await readFile(workflow.manifestPath, "utf8")) as any;
  const compiler = manifest.stages.find((stage: any) => stage.stage === "candidate-skill-compilation");
  assert.equal(compiler.kind, "deterministic-tool");
  assert.equal(compiler.skippedReason, "no-attributed-findings");
  assert.deepEqual(manifest.stages.map((stage: any) => stage.stage), [
    "description-reconstruction", "current-draft-generation", "draft-expert-evaluation", "skill-review",
    "candidate-skill-compilation", "promotion-decision",
  ]);
  assert.equal(manifest.termination.reason, "no-attributed-findings");
  assert.deepEqual(manifest.termination.evaluationSkipped, ["candidate-draft-generation", "candidate-expert-evaluation", "independent-judge"]);
  assert.equal(manifest.selfCheck.status, "not-triggered");
  assert.equal(manifest.selfCheck.reason, "no-candidate-expert-regression");
  assert.equal("behaviorAuditPath" in manifest.selfCheck, false);
  const decision = JSON.parse(await readFile(workflow.promotionDecisionPath, "utf8")) as any;
  assert.equal(decision.gates.skillChanged, false);
  assert.equal(decision.gates.hasAttributedFindings, false);
  assert.deepEqual(decision.reasons, ["no-attributed-findings"]);
  assert.deepEqual(decision.evaluationSkipped, ["candidate-draft-generation", "candidate-expert-evaluation", "independent-judge"]);
});

test("Judge accepts a bare required-field JSON payload after a separate Agent session preparation turn", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const base = runner(calls);
  const custom: RefineHarnessRunner = async (options) => {
    if (options.trace?.stage === "independent-judge" && options.trace.attributes?.["agent.phase"] === "submission") {
      calls.push(options);
      return result(options, JSON.stringify({ ...judgePayload("improved"), reason: "候选更完整" }));
    }
    return base(options);
  };
  const workflow = await runFixedRefineWorkflowHarness({
    cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath,
    activeSkillPath: f.activeSkillPath, runRoot: join(f.root, "runs"), runner: custom, executionMode: "workflow",
  });
  assert.equal(workflow.status, "promoted");
  const judge = JSON.parse(await readFile(workflow.judgePath!, "utf8")) as any;
  assert.equal(judge.verdict, "improved");
  assert.equal(judge.evaluator.version, "v4");
});

test("Judge submission exhaustion preserves failure evidence but does not block Expert-qualified promotion", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const base = runner(calls);
  const custom: RefineHarnessRunner = async (options) => {
    if (options.trace?.stage === "independent-judge") {
      calls.push(options);
      if (options.trace.attributes?.["agent.phase"] === "preparation") return result(options, "JUDGE_INPUTS_READY");
      return result(options, "The comparison is complete, but this is not a structured submission.");
    }
    return base(options);
  };
  const workflow = await runFixedRefineWorkflowHarness({
    cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath,
    activeSkillPath: f.activeSkillPath, runRoot: join(f.root, "runs"), runner: custom, executionMode: "workflow",
  });
  assert.equal(workflow.status, "promoted");
  assert.equal(workflow.judgePath, undefined);
  const decision = JSON.parse(await readFile(workflow.promotionDecisionPath, "utf8")) as any;
  assert.equal(decision.decision, "promote");
  assert.equal(decision.evidence.judgeSha256, null);
  assert.equal(decision.judgeFailure.status, "unavailable");
  assert.equal(decision.judgeAdvisory.blocking, false);
  assert.equal(decision.judgeAdvisory.artifactAvailable, false);
  assert.deepEqual(decision.reasons, ["all-skill-and-expert-gates-passed"]);
  const manifest = JSON.parse(await readFile(workflow.manifestPath, "utf8")) as any;
  assert.equal(manifest.status, "promoted");
  assert.equal(manifest.judgeAdvisoryStatus.status, "unavailable");
  assert.equal(manifest.judgeAdvisoryStatus.promotionBlocking, false);
  assert.deepEqual(manifest.stages.slice(-2).map((stage: any) => [stage.stage, stage.status]), [
    ["independent-judge", "failed"], ["promotion-decision", "completed"],
  ]);
  const traceIndex = JSON.parse(await readFile(join(workflow.runDirectory, "trace-index.json"), "utf8")) as any;
  assert.equal(traceIndex.failedStage, "independent-judge");
  const judgeCalls = calls.filter((call) => call.trace?.stage === "independent-judge");
  assert.equal(judgeCalls.length, 4);
  assert.equal(new Set(judgeCalls.map((call) => call.session?.id)).size, 1);
});

test("Judge preparation read exhaustion remains auditable and non-blocking", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const base = runner(calls);
  const custom: RefineHarnessRunner = async (options) => {
    if (options.trace?.stage === "independent-judge") {
      calls.push(options);
      return { ...result(options, "JUDGE_INPUTS_NOT_READY"), readPaths: [], toolNames: [] };
    }
    return base(options);
  };
  const workflow = await runFixedRefineWorkflowHarness({
    cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath,
    activeSkillPath: f.activeSkillPath, runRoot: join(f.root, "runs"), runner: custom, executionMode: "workflow",
  });
  assert.equal(workflow.status, "promoted");
  const manifest = JSON.parse(await readFile(workflow.manifestPath, "utf8")) as any;
  const judgeStage = manifest.stages.find((stage: any) => stage.stage === "independent-judge");
  assert.deepEqual(judgeStage.attempts.map((attempt: any) => [attempt.phase, attempt.status]), [
    ["preparation", "failed"], ["preparation", "failed"], ["preparation", "failed"],
  ]);
  assert.match(judgeStage.attempts[0].error, /read contract failed/);
  assert.equal(manifest.stages.at(-1).stage, "promotion-decision");
});

test("Reviewer rejects a document gap that is neither attributed nor explained", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const base = runner(calls);
  let first = true;
  const retrying: RefineHarnessRunner = async (options) => {
    if (options.trace?.stage === "skill-review" && options.trace.attributes?.["agent.phase"] === "submission" && first) {
      first = false;
      calls.push(options);
      return result(options, `<<<REVIEW_START>>>\n${JSON.stringify({ documentGaps: [{ ...validReviewGap, summary: "未处置缺口" }], skillFindings: [], uncertainties: [] })}\n<<<REVIEW_END>>>`, false);
    }
    return base(options);
  };
  const workflow = await runFixedRefineWorkflowHarness({
    cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath,
    activeSkillPath: f.activeSkillPath, runRoot: join(f.root, "runs"), runner: retrying, executionMode: "workflow",
  });
  const manifest = JSON.parse(await readFile(workflow.manifestPath, "utf8")) as any;
  const review = manifest.stages.find((stage: any) => stage.stage === "skill-review");
  assert.deepEqual(review.attempts.map((attempt: any) => attempt.status), ["completed", "completed", "failed", "completed"]);
  assert.match(review.attempts[2].error, /must be attributed or explained/);
});

test("Review rejects ungrounded Skill findings and retries the same frozen inputs", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const base = runner(calls);
  let first = true;
  const retrying: RefineHarnessRunner = async (options) => {
    if (options.trace?.stage === "skill-review" && options.trace.attributes?.["agent.phase"] === "submission" && first) {
      first = false;
      calls.push(options);
      return result(options, `<<<REVIEW_START>>>\n${JSON.stringify({ documentGaps: [], skillFindings: [{ ...validReviewFinding, summary: "未绑定", evidenceRefs: ["missing-gap"] }], uncertainties: [] })}\n<<<REVIEW_END>>>`, false);
    }
    return base(options);
  };
  const workflow = await runFixedRefineWorkflowHarness({
    cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath,
    activeSkillPath: f.activeSkillPath, runRoot: join(f.root, "runs"), runner: retrying, executionMode: "workflow",
  });
  const manifest = JSON.parse(await readFile(workflow.manifestPath, "utf8")) as any;
  const review = manifest.stages.find((stage: any) => stage.stage === "skill-review");
  assert.deepEqual(review.attempts.map((attempt: any) => attempt.status), ["completed", "completed", "failed", "completed"]);
  assert.match(review.attempts[2].error, /not attributable|classified document gap/);
  const reviewCalls = calls.filter((call) => call.trace?.stage === "skill-review");
  assert.equal(new Set(reviewCalls.map((call) => call.session?.id)).size, 1);
  assert.deepEqual(reviewCalls[0]!.trace?.inputRefs, reviewCalls[3]!.trace?.inputRefs);
});

test("Workflow writes a running index immediately and preserves a failed stage with every attempt", async () => {
  const f = await fixture();
  const runRoot = join(f.root, "failed-runs");
  await assert.rejects(runFixedRefineWorkflowHarness({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath, activeSkillPath: f.activeSkillPath,
    runRoot, executionMode: "workflow", runner: async () => { throw new Error("provider unavailable"); } }), /provider unavailable/);
  const [runId] = await readdir(runRoot);
  const manifest = JSON.parse(await readFile(join(runRoot, runId!, "manifest.json"), "utf8")) as any;
  const index = JSON.parse(await readFile(join(runRoot, runId!, "trace-index.json"), "utf8")) as any;
  assert.equal(manifest.status, "failed");
  assert.equal(manifest.failedStage, "description-reconstruction");
  assert.deepEqual(manifest.stages[0].attempts.map((attempt: any) => attempt.status), ["failed", "failed", "failed"]);
  assert.equal(index.status, "failed");
  assert.equal(index.stages[0].stage, "description-reconstruction");
  assert.match(manifest.traceEvidence, /JSONL events are primary/);
});

test("failed Current Expert resumes from cached Description, Draft, and Gold Aspects through one evidence-carrying correction session", async () => {
  const f = await fixture();
  const runRoot = join(f.root, "resume-runs");
  const calls: AgentTaskOptions[] = [];
  const base = runner(calls, "improved");
  let failCurrentExtraction = true;
  const resumable: RefineHarnessRunner = async (options) => {
    if (options.trace?.stage === "current-document-aspect-extraction") {
      calls.push(options);
      if (failCurrentExtraction) return result(options, '<<<ASPECT_SET_START>>>\n{"aspects":[{"id":"broken"}]}\n<<<ASPECT_SET_END>>>');
      return result(options, JSON.stringify({ aspects: [{ id: "current-risk", title: "风险", description: "风险要求", evidences: [{ quote: "迁移步骤，但风险不完整。", location: "正文" }] }] }));
    }
    return base(options);
  };
  await assert.rejects(runFixedRefineWorkflowHarness({
    cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath,
    activeSkillPath: f.activeSkillPath, runRoot, runner: resumable, executionMode: "workflow",
  }), /current-document-aspect-extraction failed/);
  const runDirectory = join(runRoot, (await readdir(runRoot))[0]!);
  const failedManifestPath = join(runDirectory, "manifest.json");
  const failedManifest = JSON.parse(await readFile(failedManifestPath, "utf8")) as any;
  const failedCall = failedManifest.stages.find((stage: any) => stage.stage === "draft-expert-evaluation").subtasks.find((call: any) => call.stage === "current-document-aspect-extraction");
  assert.equal(failedCall.attempts.length, 4);
  delete failedCall.session;
  for (const attempt of failedCall.attempts) { delete attempt.sessionId; delete attempt.phase; delete attempt.correctionProtocol; }
  await writeFile(failedManifestPath, `${JSON.stringify(failedManifest, null, 2)}\n`);

  const originalSkill = await readFile(f.activeSkillPath, "utf8");
  await writeFile(f.activeSkillPath, `${originalSkill}\nmutated`, "utf8");
  await assert.rejects(runFixedRefineWorkflowHarness({
    cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath,
    activeSkillPath: f.activeSkillPath, runRoot, resumeRunDirectory: runDirectory, runner: resumable, executionMode: "workflow",
  }), /Resume cache digest changed/);
  await writeFile(f.activeSkillPath, originalSkill, "utf8");

  calls.length = 0;
  failCurrentExtraction = false;
  const resumed = await runFixedRefineWorkflowHarness({
    cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath,
    activeSkillPath: f.activeSkillPath, runRoot, resumeRunDirectory: runDirectory, runner: resumable, executionMode: "workflow",
  });
  assert.equal(resumed.status, "promoted");
  assert.equal(calls.some((call) => ["description-reconstruction", "current-draft-generation", "gold-aspect-extraction"].includes(String(call.trace?.stage))), false);
  const correction = calls.find((call) => call.trace?.stage === "current-document-aspect-extraction")!;
  assert.equal(correction.trace!.attributes!["agent.phase"], "correction");
  assert.equal(correction.trace!.attributes!["agent.continuation"], "public-trace-fallback");
  const context = JSON.parse(await readFile(correction.trace!.inputRefs![0]!, "utf8"));
  assert.equal(context.failedPublicAttemptRefs.length, 4);
  assert.ok(context.failedPublicAttemptRefs.every((attempt: any) => /^[a-f0-9]{64}$/.test(attempt.publicTraceSha256)));
  assert.match(context.exactValidationError, /schema is invalid|raw-json-v2 correction/);
  assert.equal(context.originalTaskGoal.stage, "current-document-aspect-extraction");
  const manifest = JSON.parse(await readFile(resumed.manifestPath, "utf8")) as any;
  assert.equal(manifest.resume.continuationMode, "public-trace-fallback-for-historical-no-session-attempts");
  assert.deepEqual(manifest.resume.cacheReuse, [resumed.descriptionPath, resumed.draftPath, resumed.goldAspectSetPath]);
  assert.equal(manifest.stages.filter((stage: any) => stage.stage === "description-reconstruction").length, 1);
  assert.equal(manifest.stages.filter((stage: any) => stage.stage === "current-draft-generation").length, 1);
  assert.equal(manifest.selfCheck.status, "not-triggered");
  assert.equal(manifest.selfCheck.reason, "no-candidate-expert-regression");
});

test("resume revalidates a schema-valid cached correction that the former exact read-set check rejected", async () => {
  const f = await fixture();
  const runRoot = join(f.root, "cached-correction-runs");
  const calls: AgentTaskOptions[] = [];
  const base = runner(calls, "improved");
  const invalidCurrent: RefineHarnessRunner = async (options) => {
    if (options.trace?.stage === "current-document-aspect-extraction") {
      calls.push(options);
      return result(options, '<<<ASPECT_SET_START>>>\n{"aspects":[{"id":"broken"}]}\n<<<ASPECT_SET_END>>>');
    }
    return base(options);
  };
  await assert.rejects(runFixedRefineWorkflowHarness({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath, activeSkillPath: f.activeSkillPath,
    runRoot, runner: invalidCurrent, executionMode: "workflow" }), /current-document-aspect-extraction failed/);
  const runDirectory = join(runRoot, (await readdir(runRoot))[0]!);
  const manifestPath = join(runDirectory, "manifest.json");
  const failedManifest = JSON.parse(await readFile(manifestPath, "utf8")) as any;
  const failedCall = failedManifest.stages.find((stage: any) => stage.stage === "draft-expert-evaluation").subtasks.find((call: any) => call.stage === "current-document-aspect-extraction");
  const cachedAttempt = failedCall.attempts.at(-1);
  cachedAttempt.error = "current-document-aspect-extraction correction read contract failed; required=context";
  const cachedText = JSON.stringify({ aspects: [{ id: "current-risk", title: "风险", description: "风险要求", evidences: [{ quote: "迁移步骤，但风险不完整。", location: "正文" }] }] });
  const cachedReads = [cachedAttempt.correctionContextPath, join(runDirectory, "description.md"), join(runDirectory, "draft.md")];
  const cachedEvents = [
    ...cachedReads.map((path, index) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: `cached-read-${index}`, name: "read", arguments: { path } }], stopReason: "toolUse", usage } })),
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: cachedText }], stopReason: "stop", usage } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
  await writeFile(cachedAttempt.eventsPath, cachedEvents, "utf8");
  await writeFile(manifestPath, `${JSON.stringify(failedManifest, null, 2)}\n`, "utf8");

  calls.length = 0;
  const resumed = await runFixedRefineWorkflowHarness({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath, activeSkillPath: f.activeSkillPath,
    runRoot, resumeRunDirectory: runDirectory, runner: base, executionMode: "workflow" });
  assert.equal(calls.some((call) => call.trace?.stage === "current-document-aspect-extraction"), false);
  const manifest = JSON.parse(await readFile(resumed.manifestPath, "utf8")) as any;
  const recovered = manifest.stages.find((stage: any) => stage.stage === "draft-expert-evaluation").subtasks.find((call: any) => call.stage === "current-document-aspect-extraction");
  assert.deepEqual(recovered.recovery, { type: "validated-cached-public-output", attempt: cachedAttempt.attempt,
    reason: "cached Artifact passed the current public-read boundary, correction wrapper, and unchanged schema validator" });
});

test("resume never salvages a prose-prefixed failed raw-json-v2 correction", async () => {
  const f = await fixture();
  const runRoot = join(f.root, "strict-cached-wrapper-runs");
  const calls: AgentTaskOptions[] = [];
  const base = runner(calls, "improved");
  const invalidCurrent: RefineHarnessRunner = async (options) => {
    if (options.trace?.stage === "current-document-aspect-extraction") {
      calls.push(options);
      return result(options, JSON.stringify({ aspects: [] }));
    }
    return base(options);
  };
  await assert.rejects(runFixedRefineWorkflowHarness({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath, activeSkillPath: f.activeSkillPath,
    runRoot, runner: invalidCurrent, executionMode: "workflow" }), /current-document-aspect-extraction failed/);
  const runDirectory = join(runRoot, (await readdir(runRoot))[0]!);
  const manifestPath = join(runDirectory, "manifest.json");
  const failedManifest = JSON.parse(await readFile(manifestPath, "utf8")) as any;
  const failedCall = failedManifest.stages.find((stage: any) => stage.stage === "draft-expert-evaluation").subtasks.find((call: any) => call.stage === "current-document-aspect-extraction");
  const cachedAttempt = failedCall.attempts.at(-1);
  cachedAttempt.error = "raw-json-v2 correction must return exactly one unwrapped JSON object";
  cachedAttempt.correctionContractDigest = "superseded-contract";
  const validObject = JSON.stringify({ aspects: [{ id: "current-risk", title: "风险", description: "风险要求", evidences: [{ quote: "迁移步骤，但风险不完整。", location: "正文" }] }] });
  const cachedReads = [cachedAttempt.correctionContextPath, join(runDirectory, "description.md"), join(runDirectory, "draft.md")];
  const cachedEvents = [
    ...cachedReads.map((path, index) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: `strict-read-${index}`, name: "read", arguments: { path } }], stopReason: "toolUse", usage } })),
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `I will now fix the artifact.\n${validObject}` }], stopReason: "stop", usage } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
  await writeFile(cachedAttempt.eventsPath, cachedEvents, "utf8");
  await writeFile(manifestPath, `${JSON.stringify(failedManifest, null, 2)}\n`, "utf8");

  calls.length = 0;
  const repaired: RefineHarnessRunner = async (options) => {
    if (options.trace?.stage === "current-document-aspect-extraction") {
      calls.push(options);
      return result(options, validObject);
    }
    return base(options);
  };
  const resumed = await runFixedRefineWorkflowHarness({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath, activeSkillPath: f.activeSkillPath,
    runRoot, resumeRunDirectory: runDirectory, runner: repaired, executionMode: "workflow" });
  assert.equal(resumed.status, "promoted");
  assert.equal(calls.filter((call) => call.trace?.stage === "current-document-aspect-extraction").length, 1, "a new strict correction must run instead of recovering prose-prefixed output");
});

test("failed Candidate Expert resumes only its failed Agent session after an Alignment contract revision", async () => {
  const f = await fixture();
  const runRoot = join(f.root, "candidate-resume-runs");
  const calls: AgentTaskOptions[] = [];
  const base = runner(calls, "improved");
  let rejectUnknownField = true;
  const resumable: RefineHarnessRunner = async (options) => {
    if (options.trace?.stage === "candidate-alignment-1-content") {
      calls.push(options);
      return result(options, JSON.stringify(rejectUnknownField
        ? { matched: true, rationale: "对齐", unexpected_field: "不允许的字段" }
        : { matched: true, rationale: "对齐" }));
    }
    return base(options);
  };
  await assert.rejects(runFixedRefineWorkflowHarness({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath, activeSkillPath: f.activeSkillPath,
    runRoot, runner: resumable, executionMode: "workflow" }), /unknown fields must be removed: unexpected_field/);
  const runDirectory = join(runRoot, (await readdir(runRoot))[0]!);
  const manifestPath = join(runDirectory, "manifest.json");
  const failedManifest = JSON.parse(await readFile(manifestPath, "utf8")) as any;
  assert.equal(failedManifest.failedStage, "candidate-expert-evaluation");
  const failedCall = failedManifest.stages.find((stage: any) => stage.stage === "candidate-expert-evaluation").subtasks.find((call: any) => call.stage === "candidate-alignment-1-content");
  assert.equal(failedCall.session.continuation, "native");
  for (const attempt of failedCall.attempts) delete attempt.correctionContractDigest;
  await writeFile(manifestPath, `${JSON.stringify(failedManifest, null, 2)}\n`);

  calls.length = 0;
  rejectUnknownField = false;
  const resumed = await runFixedRefineWorkflowHarness({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath, activeSkillPath: f.activeSkillPath,
    runRoot, resumeRunDirectory: runDirectory, runner: resumable, executionMode: "workflow" });
  assert.equal(resumed.status, "promoted");
  const forbiddenFreshStages = ["description-reconstruction", "current-draft-generation", "gold-aspect-extraction", "current-document-aspect-extraction", "skill-review", "candidate-skill-compilation", "candidate-draft-generation", "candidate-document-aspect-extraction"];
  assert.equal(calls.some((call) => forbiddenFreshStages.includes(String(call.trace?.stage))), false);
  const correction = calls.find((call) => call.trace?.stage === "candidate-alignment-1-content")!;
  assert.equal(correction.trace!.attributes!["agent.phase"], "correction");
  assert.equal(correction.trace!.attributes!["agent.continuation"], "native");
  assert.equal(correction.session!.id, failedCall.session.id);
  const manifest = JSON.parse(await readFile(resumed.manifestPath, "utf8")) as any;
  assert.equal(manifest.stages.filter((stage: any) => stage.stage === "candidate-draft-generation").length, 1);
  assert.equal(manifest.resume.cacheReuse.includes(resumed.candidateDraftPath), true);
});

test("Reviewer prevents gold/evidence-only gaps from becoming Skill findings", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const base = runner(calls);
  let first = true;
  const retrying: RefineHarnessRunner = async (options) => {
    if (options.trace?.stage === "skill-review" && options.trace.attributes?.["agent.phase"] === "submission" && first) {
      first = false;
      calls.push(options);
      const gap = { ...validReviewGap, summary: "仅 Gold 提供事实", goldEvidence: "Gold 独有事实", sourceAvailability: "gold-evidence-only", activeSkillRelation: "new" };
      return result(options, `<<<REVIEW_START>>>\n${JSON.stringify({ documentGaps: [gap], skillFindings: [{ ...validReviewFinding, summary: "错误写入事实", activeSkillRelation: "new" }], uncertainties: [] })}\n<<<REVIEW_END>>>`, false);
    }
    return base(options);
  };
  const workflow = await runFixedRefineWorkflowHarness({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath,
    activeSkillPath: f.activeSkillPath, runRoot: join(f.root, "runs"), runner: retrying, executionMode: "workflow" });
  const manifest = JSON.parse(await readFile(workflow.manifestPath, "utf8")) as any;
  const review = manifest.stages.find((stage: any) => stage.stage === "skill-review");
  assert.match(review.attempts[2].error, /gold\/evidence-only/);
});

test("Reviewer accepts Gold-observed reusable style without an ExPerT gap binding", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const base = runner(calls);
  const custom: RefineHarnessRunner = async (options) => {
    if (options.trace?.stage === "skill-review" && options.trace.attributes?.["agent.phase"] === "submission") {
      calls.push(options);
      const gap = { ...validReviewGap, id: "gap-style", summary: "结论先行再解释机制", draftEvidence: "当前稿直接罗列条目", draftCounterevidence: "未找到等价概括", goldEvidence: "参考稿先给结论再展开机制", expertRefs: [], sourceAvailability: "gold-observed-reusable-style", activeSkillRelation: "new", nearestActiveSkillRule: "未找到近义规则" };
      const finding = { ...validReviewFinding, id: "skill-finding-style", summary: "同类调研先概括判断，再按机制展开", attribution: "当前 Skill 未定义段落功能顺序", evidenceRefs: ["gap-style"], activeSkillRelation: "new", nearestActiveSkillRule: "未找到近义规则" };
      return result(options, JSON.stringify({ documentGaps: [gap], skillFindings: [finding], uncertainties: [] }), false);
    }
    return base(options);
  };
  const workflow = await runFixedRefineWorkflowHarness({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath,
    activeSkillPath: f.activeSkillPath, runRoot: join(f.root, "runs"), runner: custom, executionMode: "workflow" });
  const review = JSON.parse(await readFile(workflow.reviewPath, "utf8")) as any;
  assert.deepEqual(review.documentGaps[0].expertRefs, []);
  assert.equal(review.documentGaps[0].sourceAvailability, "gold-observed-reusable-style");
  assert.equal(review.skillFindings.length, 1);
});

test("Reviewer keeps at most five strongest Skill findings", async () => {
  const f = await fixture(); const calls: AgentTaskOptions[] = []; const base = runner(calls); let first = true;
  const custom: RefineHarnessRunner = async (options) => {
    if (options.trace?.stage === "skill-review" && options.trace.attributes?.["agent.phase"] === "submission" && first) {
      first = false; calls.push(options);
      const documentGaps = Array.from({ length: 6 }, (_, index) => ({ ...validReviewGap, id: `gap-${index}`, summary: `style ${index}`, draftEvidence: "draft", draftCounterevidence: "", goldEvidence: "gold style", expertRefs: [], sourceAvailability: "gold-observed-reusable-style", activeSkillRelation: "new", nearestActiveSkillRule: "none" }));
      const skillFindings = documentGaps.map((gap, index) => ({ ...validReviewFinding, id: `finding-${index}`, summary: `general style ${index}`, attribution: "missing style method", evidenceRefs: [gap.id], activeSkillRelation: "new", nearestActiveSkillRule: "none" }));
      return result(options, `<<<REVIEW_START>>>\n${JSON.stringify({ documentGaps, skillFindings, uncertainties: [] })}\n<<<REVIEW_END>>>`, false);
    }
    return base(options);
  };
  const workflow = await runFixedRefineWorkflowHarness({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath,
    activeSkillPath: f.activeSkillPath, runRoot: join(f.root, "runs"), runner: custom, executionMode: "workflow" });
  const manifest = JSON.parse(await readFile(workflow.manifestPath, "utf8")) as any;
  const review = manifest.stages.find((stage: any) => stage.stage === "skill-review");
  assert.match(review.attempts[2].error, /at most five strongest/);
});

test("Reviewer screens semantic duplicates and Description-conflicting centralization before compilation", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const base = runner(calls);
  const custom: RefineHarnessRunner = async (options) => {
    if (options.trace?.stage === "skill-review" && options.trace.attributes?.["agent.phase"] === "submission") {
      calls.push(options);
      const duplicate = { ...validReviewGap, id: "gap-duplicate", summary: "先总述再展开", draftEvidence: "Draft 已有类别总述", draftCounterevidence: "1.2 与 1.3 已先概括类别再展开", activeSkillRelation: "duplicate", nearestActiveSkillRule: "global first, drill into details" };
      const conflict = { ...validReviewGap, id: "gap-repeat", summary: "把边界集中定义一次", draftCounterevidence: "正文、对比和结论各自承担边界解释功能", activeSkillRelation: "new", descriptionSupport: "", descriptionConflict: "Description 要求正文、对比和结论重复强调边界", descriptionCompatibility: "conflict" };
      const activeConflict = { ...validReviewGap, id: "gap-active-conflict", summary: "与既有 Skill 规则方向冲突", activeSkillRelation: "conflict", nearestActiveSkillRule: "Keep the established order.", certainty: "uncertain" };
      const combined = { ...validReviewGap, id: "gap-combined", summary: "Gold-only 且已有近义规则但证据仍不确定", sourceAvailability: "gold-evidence-only", activeSkillRelation: "duplicate", nearestActiveSkillRule: "Existing method.", certainty: "uncertain" };
      const uncertainty = { id: "uncertainty-active-conflict", summary: "冲突观察不自动编译", reason: "需先解决与既有规则的冲突", evidenceRefs: ["gap-active-conflict"] };
      const combinedUncertainty = { id: "uncertainty-combined", summary: "多个筛选轴可以同时成立", reason: "事实来源和证据确定性是独立判断", evidenceRefs: ["gap-combined"] };
      return result(options, `<<<REVIEW_START>>>\n${JSON.stringify({ documentGaps: [duplicate, conflict, activeConflict, combined], skillFindings: [], uncertainties: [uncertainty, combinedUncertainty] })}\n<<<REVIEW_END>>>`, false);
    }
    return base(options);
  };
  const workflow = await runFixedRefineWorkflowHarness({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath, activeSkillPath: f.activeSkillPath,
    runRoot: join(f.root, "runs"), runner: custom, executionMode: "workflow" });
  assert.equal(workflow.status, "rejected");
  assert.equal(calls.some((call) => call.trace?.stage === "candidate-skill-compilation"), false);
  const review = JSON.parse(await readFile(workflow.reviewPath, "utf8")) as any;
  assert.deepEqual(review.documentGaps.map((gap: any) => [gap.sourceAvailability, gap.activeSkillRelation, gap.descriptionCompatibility, gap.certainty]), [
    ["description-provided", "duplicate", "compatible", "supported"],
    ["description-provided", "new", "conflict", "supported"],
    ["description-provided", "conflict", "compatible", "uncertain"],
    ["gold-evidence-only", "duplicate", "compatible", "uncertain"],
  ]);
  assert.deepEqual(review.skillFindings, []);
});

test("Reviewer validator rejects Active Skill conflicts from the compilable Finding set", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const base = runner(calls, "no-findings");
  let submission = 0;
  const custom: RefineHarnessRunner = async (options) => {
    if (options.trace?.stage === "skill-review" && options.trace.attributes?.["agent.phase"] === "submission") {
      submission += 1;
      calls.push(options);
      const conflict = { ...validReviewGap, id: "gap-active-conflict", summary: "与既有 Skill 冲突", activeSkillRelation: "conflict", nearestActiveSkillRule: "Keep the established order.", certainty: "uncertain" };
      const uncertainty = { id: "uncertainty-active-conflict", summary: "冲突待消解", reason: "不能直接编译", evidenceRefs: ["gap-active-conflict"] };
      const skillFindings = submission === 1 ? [{ ...validReviewFinding, id: "finding-active-conflict", evidenceRefs: ["gap-active-conflict"], activeSkillRelation: "conflict", nearestActiveSkillRule: "Keep the established order." }] : [];
      return result(options, JSON.stringify({ documentGaps: [conflict], skillFindings, uncertainties: [uncertainty] }), false);
    }
    return base(options);
  };
  const workflow = await runFixedRefineWorkflowHarness({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath, activeSkillPath: f.activeSkillPath,
    runRoot: join(f.root, "runs"), runner: custom, executionMode: "workflow" });
  assert.equal(workflow.status, "rejected");
  const manifest = JSON.parse(await readFile(workflow.manifestPath, "utf8")) as any;
  const review = manifest.stages.find((stage: any) => stage.stage === "skill-review");
  assert.match(review.attempts[2].error, /duplicate or conflict cannot become a Skill finding/);
  assert.equal(calls.some((call) => call.trace?.stage === "candidate-skill-compilation"), false);
});

test("Reviewer cannot compile an observation that its own revision leaves uncertain", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const base = runner(calls);
  let first = true;
  const retrying: RefineHarnessRunner = async (options) => {
    if (options.trace?.stage === "skill-review" && options.trace.attributes?.["agent.phase"] === "submission" && first) {
      first = false;
      calls.push(options);
      const uncertainty = { id: "uncertainty-1", summary: "证据不足", reason: "Description 未明确要求，且 Gold 可能只是实例", evidenceRefs: ["gap-1"] };
      return result(options, JSON.stringify({ documentGaps: [validReviewGap], skillFindings: [validReviewFinding], uncertainties: [uncertainty] }), false);
    }
    return base(options);
  };
  await runFixedRefineWorkflowHarness({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath, activeSkillPath: f.activeSkillPath,
    runRoot: join(f.root, "runs"), runner: retrying, executionMode: "workflow" });
  const reviewCalls = calls.filter((call) => call.trace?.stage === "skill-review");
  assert.equal(reviewCalls.length, 4);
  assert.equal(new Set(reviewCalls.map((call) => call.session?.id)).size, 1);
  assert.match(reviewCalls[3]!.prompt, /只纠正 JSON 结构或校验指出的内部一致性问题/);
});

test("Independent Judge preserves auditable Candidate regressions while remaining advisory", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const base = runner(calls);
  const custom: RefineHarnessRunner = async (options) => {
    if (options.trace?.stage === "independent-judge" && options.trace.attributes?.["agent.phase"] === "submission") {
      calls.push(options);
      const value = {
        verdict: "regressed", currentScore: 28, candidateScore: 25, currentHardPass: true, candidateHardPass: false,
        slotChecks: [
          { id: "opening", scope: "opening", descriptionRequirement: "开篇给出核心结论", currentEvidence: "Current 保留五条结论", candidateEvidence: "Candidate 直接进入背景", status: "regressed" },
          { id: "section-design-source", scope: "section", descriptionRequirement: "区分程序化设计源与 STEP 修改路径", currentEvidence: "Current 使用条件表达", candidateEvidence: "Candidate 写成外部修改普遍必须持有程序化源", status: "regressed" },
          { id: "delivered-register", scope: "section", descriptionRequirement: "交付文档使用陈述口吻", currentEvidence: "Current 为陈述句", candidateEvidence: "Candidate 残留需说明、不得混同等作者指令", status: "regressed" },
          { id: "conclusion", scope: "conclusion", descriptionRequirement: "结论重申边界", currentEvidence: "Current 有结论", candidateEvidence: "Candidate 有结论", status: "preserved" },
          { id: "cross-document", scope: "cross-document", descriptionRequirement: "全篇路径表述自洽", currentEvidence: "Current 自洽", candidateEvidence: "程序化源绝对化与后文 STEP 可直接修改冲突", status: "regressed" },
        ],
        regressions: [
          { id: "reg-opening", category: "description-slot", slotCheckIds: ["opening"], summary: "Candidate 删除开篇五条核心结论", descriptionEvidence: "Description 要求结论先行", currentEvidence: "Current 五条结论", candidateEvidence: "Candidate 缺失" },
          { id: "reg-consistency", category: "internal-consistency", slotCheckIds: ["section-design-source", "cross-document"], summary: "程序化设计源被泛化成必要条件但后文仍允许 STEP 直接修改", descriptionEvidence: "Description 要求区分路径", currentEvidence: "Current 使用条件限定", candidateEvidence: "Candidate 的绝对化陈述与后文冲突" },
          { id: "reg-register", category: "surface-quality", slotCheckIds: ["delivered-register"], summary: "Candidate 新增面向作者的指令口吻", descriptionEvidence: "Description 要求交付报告", currentEvidence: "Current 使用陈述口吻", candidateEvidence: "Candidate 写需说明、不得混同" },
        ],
        reason: "Candidate 有可审计的内容槽位、内部一致性和语域退化。",
      };
      return result(options, `<<<JUDGE_START>>>\n${JSON.stringify(value)}\n<<<JUDGE_END>>>`);
    }
    return base(options);
  };
  const workflow = await runFixedRefineWorkflowHarness({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    requirementsPath: f.requirementsPath, rulesPath: f.rulesPath, goldPath: f.goldPath, activeSkillPath: f.activeSkillPath,
    runRoot: join(f.root, "runs"), runner: custom, executionMode: "workflow" });
  assert.equal(workflow.status, "promoted", "Judge remains advisory when deterministic Expert gates pass");
  const judge = JSON.parse(await readFile(workflow.judgePath!, "utf8")) as any;
  assert.deepEqual(judge.regressions.map((item: any) => item.category), ["description-slot", "internal-consistency", "surface-quality"]);
  const decision = JSON.parse(await readFile(workflow.promotionDecisionPath, "utf8")) as any;
  assert.equal(decision.judgeAdvisory.blocking, false);
  assert.equal(decision.judgeAdvisory.verdict, "regressed");
});

test("Draft rejects missing standalone markers, implausibly short output, and truncation", async () => {
  const f = await fixture();
  const invoke = (finalText: string, stopReason?: string) => runRefineDraftAgent({
    cwd: f.root, provider: "test", model: "test", timeoutMs: 1_000,
    descriptionPath: f.requirementsPath, skillPath: f.activeSkillPath, outputPath: join(f.root, `${Math.random()}.md`),
    runner: async (options) => ({ ...result(options, finalText), ...(stopReason ? { stopReason } : {}) }),
  });
  await assert.rejects(invoke("Use markers around output"), /standalone markers/);
  await assert.rejects(invoke("<<<DRAFT_START>>>\n/\n<<<DRAFT_END>>>"), /implausibly short/);
  await assert.rejects(invoke("<<<DRAFT_START>>>\n# 足够长的初稿正文\n<<<DRAFT_END>>>", "length"), /truncated/);
});


test("Reviewer contract example validates and uncertainty errors locate exact refs without choosing semantics", () => {
  const hashes = { descriptionSha256: "d", goldSha256: "g", draftSha256: "r", activeSkillSha256: "s" } as any;
  const expert = { gaps: [] } as any;
  assert.doesNotThrow(() => validateReviewModelJson(JSON.stringify(REVIEW_CONTRACT_EXAMPLE), hashes, expert));
  const empty = structuredClone(REVIEW_CONTRACT_EXAMPLE); empty.uncertainties[0]!.evidenceRefs = [];
  assert.throws(() => validateReviewModelJson(JSON.stringify(empty), hashes, expert), /\/uncertainties\/0\/evidenceRefs.*id=uncertainty-1/);
  const overlapping = structuredClone(REVIEW_CONTRACT_EXAMPLE); overlapping.uncertainties[0]!.evidenceRefs = ["gap-1"];
  assert.throws(() => validateReviewModelJson(JSON.stringify(overlapping), hashes, expert), /\/uncertainties\/0\/evidenceRefs\/0.*ref=gap-1.*\/skillFindings\/0\/evidenceRefs\/0.*skill-finding-1/);
  const wrongCertainty = structuredClone(REVIEW_CONTRACT_EXAMPLE); wrongCertainty.documentGaps[1]!.certainty = "supported";
  assert.throws(() => validateReviewModelJson(JSON.stringify(wrongCertainty), hashes, expert), /\/documentGaps\/1\/certainty=supported/);
  assert.throws(() => validateReviewModelJson("{", hashes, expert));
  assert.deepEqual(REVIEW_CONTRACT_EXAMPLE.uncertainties[0]!.evidenceRefs, ["gap-2"]);
});
import { createHash } from "node:crypto";
import { applyUnsentControlEvidence } from "../src/refine-workflow-harness.js";
import { WorkflowControlError } from "../src/workflow-control.js";

test("unsent migration requires matching audited proof and rejects any execution evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "unsent-proof-"));
  const digest = (s: string) => createHash("sha256").update(s).digest("hex");
  const ledgerPath = join(root, "ledger.jsonl"), proofPath = join(root, "proof.json"), eventsPath = join(root, "absent.events.jsonl");
  const ids = [{ stage: "candidate-alignment-19-style", attempt: 1, eventsPath }];
  const baseline = () => [{ stage: ids[0]!.stage, attempts: [{ attempt: 1, taskId: "unsent", eventsPath, status: "failed", error: "retained", phase: "correction", correctionContractDigest: "retained-digest" }] }] as any;
  const config = async (ledger = "") => { await writeFile(ledgerPath, ledger); const text = JSON.stringify({ runId: "run", preProviderGuardVerified: true, unsentAttempts: ids, ledgerPath, ledgerSha256: digest(ledger) }); await writeFile(proofPath, text); return { resumeUnsentAttempts: ids, resumeControlEvidence: { path: proofPath, sha256: digest(text) } }; };
  const original = baseline(); const opts = await config(); await applyUnsentControlEvidence(opts, "run", original);
  assert.equal(original[0].attempts[0].controlStop.providerStarted, false);
  assert.equal(original[0].attempts[0].error, "retained"); assert.equal(original[0].attempts[0].correctionContractDigest, "retained-digest");
  await assert.rejects(applyUnsentControlEvidence({ resumeUnsentAttempts: ids }, "run", baseline()), WorkflowControlError);
  await assert.rejects(applyUnsentControlEvidence({ ...opts, resumeControlEvidence: { path: proofPath, sha256: "wrong" } }, "run", baseline()), WorkflowControlError);
  await assert.rejects(applyUnsentControlEvidence(await config(JSON.stringify({ taskId: "unsent" }) + "\n"), "run", baseline()), /request ledger/);
  const withUsage = baseline(); withUsage[0].attempts[0].usage = { totalTokens: 1 }; await assert.rejects(applyUnsentControlEvidence(await config(), "run", withUsage), /has usage/);
  await writeFile(eventsPath, "{\"type\":\"message_end\"}\n"); await assert.rejects(applyUnsentControlEvidence(await config(), "run", baseline()), /execution evidence/);
});
