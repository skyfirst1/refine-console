import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { REFINE_AGENT_CARDS } from "../src/refine-agent-cards.js";
import {
  advanceGoldSkillRefineAgent,
  initializeGoldSkillRefineAgent,
  REFINE_AGENT_GOLD_SKILL_STAGES,
  type GoldSkillRunner,
  type GoldSkillRefineOptions,
  type GoldSkillRefineResult,
} from "../src/refine-agent-harness.js";
import { agentEventProvenance, type AgentTaskOptions, type AgentTaskResult } from "../src/agent-task-runner.js";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costUsd: 0 };

test("Agent cards expose only the step-coordinated Agent surface", () => {
  assert.equal("refine.workflow" in REFINE_AGENT_CARDS, false);
  assert.deepEqual(REFINE_AGENT_CARDS["refine.agent"].callableSubagents, []);
  assert.deepEqual(REFINE_AGENT_CARDS["refine.agent"].tools, ["refine_agent", "refine_agent_step", "refine_agent_cards"]);
  assert.equal(REFINE_AGENT_CARDS["refine.agent"].embeddedSkill.id, "refine-agent");
});

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function result(options: AgentTaskOptions, finalText: string): AgentTaskResult {
  return {
    finalText,
    rawEventsPath: options.rawEventsPath,
    readPaths: [...(options.trace?.inputRefs ?? [])],
    toolNames: (options.trace?.inputRefs ?? []).map(() => "read"),
    usage,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "refine-agent-gold-skill-"));
  const requirementsPath = join(root, "trace.json");
  const rulesPath = join(root, "rules.json");
  const goldPath = join(root, "gold.md");
  const activeSkillPath = join(root, "SKILL.md");
  await writeFile(requirementsPath, "{\"task\":\"写迁移方案\"}\n", "utf8");
  await writeFile(rulesPath, "{}\n", "utf8");
  await writeFile(goldPath, "# 迁移方案\n\n包含风险与回滚方案。\n", "utf8");
  await writeFile(activeSkillPath, "# Writing Skill\n\n生成结构化方案，并保持内容简洁。\n", "utf8");
  return { root, requirementsPath, rulesPath, goldPath, activeSkillPath };
}

function scriptedRunner(calls: AgentTaskOptions[], candidateScore = 0.9, withFinding = true): GoldSkillRunner {
  return async (options) => {
    calls.push(options);
    const stage = String(options.trace?.stage);
    if (stage.includes("aspect-extraction")) {
      const sourcePath = options.trace!.inputRefs![1]!;
      const source = await readFile(sourcePath, "utf8");
      const id = sourcePath.endsWith("gold.md") ? "gold-risk" : sourcePath.endsWith("candidate-draft.md") ? "candidate-risk" : "current-risk";
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
      const matched = candidate ? candidateScore >= 0.5 : input.mode === "content";
      return result(options, `<<<EVIDENCE_ALIGNMENT_START>>>\n${JSON.stringify({ matched, rationale: matched ? "对齐" : "未对齐" })}\n<<<EVIDENCE_ALIGNMENT_END>>>`);
    }
    if (stage === "description-reconstruction") {
      return result(options, "说明前言与起始标记意外同一行。<<<DESCRIPTION_START>>>\n写一份含风险与回滚的迁移方案。\n<<<DESCRIPTION_END>>>");
    }
    if (stage === "current-draft-generation") {
      return result(options, "<<<DRAFT_START>>>\n# 迁移方案\n\n迁移步骤。\n<<<DRAFT_END>>>");
    }
    if (stage === "skill-attribution-review") {
      return result(options, `marker 外长分析不属于协议。${"外部推理段落。".repeat(3_000)}\nFINDING|outside-invalid|wrong|not-an-expert-id|rewrite|high|outside|outside|outside\n`
        + "<<<SKILL_REVIEW_START>>>\nGAP|gap-1|recall-gold-risk|Draft 缺少风险与回滚\n"
        + (withFinding
          ? "FINDING|finding-1|incomplete|recall-gold-risk|add|high|结构化方案规则之后缺少风险处理保障|跨任务方案可能遗漏风险控制|方案类文档必须覆盖主要风险、触发条件与回滚方式。\n"
          : "UNCERTAINTY|该差异是任务特有事实，无法抽象为通用写作规则。\n")
        + "<<<SKILL_REVIEW_END>>>\nmarker 外内容忽略。" );
    }
    if (stage === "candidate-skill-compilation") {
      return result(options, "<<<CANDIDATE_SKILL_START>>>\n# Writing Skill\n\n生成结构化方案，并覆盖主要风险与回滚条件，同时保持内容简洁。\n<<<CANDIDATE_SKILL_END>>>");
    }
    if (stage === "candidate-draft-generation") {
      return result(options, "<<<CANDIDATE_DRAFT_START>>>\n# 迁移方案\n\n迁移步骤、风险与回滚。\n<<<CANDIDATE_DRAFT_END>>>");
    }
    if (stage === "independent-judge") {
      return result(options, "<<<JUDGE_START>>>\n"
        + JSON.stringify({
          schemaVersion: "1.0",
          verdict: candidateScore >= 0.5 ? "improved" : "regressed",
          hardPassCurrent: false,
          hardPassCandidate: candidateScore >= 0.5,
          reason: candidateScore >= 0.5 ? "候选补齐了关键要求" : "候选未补齐关键要求",
        })
        + "\n<<<JUDGE_END>>>");
    }
    throw new Error("Unexpected stage " + stage);
  };
}

async function driveAgent(options: GoldSkillRefineOptions): Promise<GoldSkillRefineResult> {
  let output = await initializeGoldSkillRefineAgent(options);
  assert.equal(output.status, "waiting");
  assert.equal(output.completedStages.length, 0);
  while (output.status === "waiting" && output.nextStage) {
    output = await advanceGoldSkillRefineAgent({
      runDirectory: output.runDirectory,
      stage: output.nextStage,
      ...(options.runner ? { runner: options.runner } : {}),
    });
  }
  return output;
}

test("Agent main path restores the Gold-supervised full Skill loop without a baseline or Revision Agent", async () => {
  const input = await fixture();
  const calls: AgentTaskOptions[] = [];
  const output = await driveAgent({
    ...input,
    cwd: input.root,
    provider: "test-provider",
    model: "test-model",
    activeSkillVersion: "v1",
    runRoot: join(input.root, "runs"),
    timeoutMs: 1_000,
    runner: scriptedRunner(calls),
  });
  assert.equal(output.status, "promoted");
  const manifest = JSON.parse(await readFile(output.manifestPath, "utf8")) as any;
  assert.equal(manifest.executionMode, "agent");
  assert.equal(manifest.harnessVersion, "refine-agent-harness-v1");
  assert.ok(["available", "unavailable"].includes(manifest.sourceProvenance.availability));
  assert.match(manifest.stages[0].card.promptDigest, /^[a-f0-9]{64}$/);
  assert.match(manifest.stages[0].card.schemaDigest, /^[a-f0-9]{64}$/);
  assert.match(manifest.stages[0].card.toolDigest, /^[a-f0-9]{64}$/);
  assert.ok(manifest.stages.every((stage: any) => stage.adapterProvenance?.availability));
  assert.ok(manifest.stages.flatMap((stage: any) => stage.attempts ?? []).every((attempt: any) => attempt.adapterProvenance?.availability));
  assert.ok(manifest.stages.flatMap((stage: any) => stage.subtasks ?? []).every((subtask: any) => subtask.adapterProvenance?.availability === "available"));
  assert.equal(manifest.coordinationMode, "current-pi-session-step-tools");
  assert.equal(manifest.parentTask.card.roleId, "refine.agent");
  assert.deepEqual(manifest.stages.map((stage: any) => stage.stage), [...REFINE_AGENT_GOLD_SKILL_STAGES]);
  assert.equal(manifest.stages.some((stage: any) => stage.stage.includes("revision")), false);
  assert.equal(manifest.baselineBusinessInput, false);
  assert.equal(manifest.inputContract.activeSkillVersion, "v1");
  assert.match(manifest.inputContract.digests[input.goldPath], /^[a-f0-9]{64}$/);
  assert.match(manifest.inputContract.digests[input.activeSkillPath], /^[a-f0-9]{64}$/);
  const currentDraftCall = calls.find((call) => call.trace?.stage === "current-draft-generation")!;
  const candidateDraftCall = calls.find((call) => call.trace?.stage === "candidate-draft-generation")!;
  assert.deepEqual(currentDraftCall.trace?.inputRefs, [output.descriptionPath!, input.activeSkillPath]);
  assert.deepEqual(candidateDraftCall.trace?.inputRefs, [output.descriptionPath!, output.candidateSkillPath!]);
  assert.equal(currentDraftCall.trace?.inputRefs.includes(input.goldPath), false);
  assert.equal(candidateDraftCall.trace?.inputRefs.includes(input.goldPath), false);
  assert.match(currentDraftCall.prompt, /内容槽位[\s\S]*具体值[\s\S]*泛化表达替代/);
  assert.match(candidateDraftCall.prompt, /内容槽位[\s\S]*具体值[\s\S]*泛化表达替代/);
  const reviewCall = calls.find((call) => call.trace?.stage === "skill-attribution-review")!;
  assert.equal(reviewCall.trace?.inputRefs?.includes(input.goldPath), true);
  assert.equal(reviewCall.trace?.inputRefs?.includes(input.activeSkillPath), true);
  assert.match(reviewCall.prompt, /适用条件与非回归边界[\s\S]*没有此类合同的任务不强行冻结结构/);
  const optimizerCall = calls.find((call) => call.trace?.stage === "candidate-skill-compilation")!;
  assert.match(optimizerCall.prompt, /等价、冲突或存在优先级关系[\s\S]*唯一规范落点/);
  const judgeCall = calls.find((call) => call.trace?.stage === "independent-judge")!;
  assert.match(judgeCall.prompt, /Gold 独有[\s\S]*Description 明定结构[\s\S]*overall\/content-style[\s\S]*surface quality/);
  assert.match(judgeCall.prompt, /不得推断 Skill 规则与 Draft 执行的因果/);
  assert.equal(await readFile(input.activeSkillPath, "utf8"), "# Writing Skill\n\n生成结构化方案，并保持内容简洁。\n");
  const decision = JSON.parse(await readFile(output.promotionDecisionPath!, "utf8")) as any;
  assert.equal(decision.decision, "promote");
  assert.equal(decision.activeSkillMutated, false);
  assert.equal(decision.expert.scoreMetric, "f1");
  assert.deepEqual(decision.requiredConditions, ["hasAttributedFindings", "expertScoreNotRegressed", "expertHardPassPreserved", "candidateExpertHardPass"]);
  assert.deepEqual(decision.judgeAdvisory, { blocking: false, artifactAvailable: true });
  assert.equal(decision.selfEvolutionTrigger, "not-triggered");
});

test("Agent promotes on Expert gates despite a rejecting advisory Judge and preserves its Artifact", async () => {
  const input = await fixture();
  const calls: AgentTaskOptions[] = [];
  const base = scriptedRunner(calls, 0.9);
  const advisoryReject: GoldSkillRunner = async (options) => {
    if (options.trace?.stage === "independent-judge") {
      calls.push(options);
      return result(options, '<<<JUDGE_START>>>\n{"schemaVersion":"1.0","verdict":"regressed","hardPassCurrent":true,"hardPassCandidate":false,"reason":"advisory rejection"}\n<<<JUDGE_END>>>');
    }
    return base(options);
  };
  const output = await driveAgent({
    ...input, cwd: input.root, provider: "test-provider", model: "test-model", activeSkillVersion: "v1",
    runRoot: join(input.root, "runs"), timeoutMs: 1_000, runner: advisoryReject,
  });
  assert.equal(output.status, "promoted");
  const decision = JSON.parse(await readFile(output.promotionDecisionPath!, "utf8")) as any;
  assert.equal(decision.judge.verdict, "regressed");
  assert.equal(decision.judgeAdvisory.blocking, false);
  assert.equal(decision.reasons.some((reason: string) => reason.startsWith("judge-")), false);
  assert.equal(output.selfCheck?.status, "not-triggered");
  assert.equal(output.selfCheck?.reason, "no-candidate-expert-regression");
  const judge = JSON.parse(await readFile(output.judgePath!, "utf8")) as any;
  assert.equal(judge.verdict, "regressed");
});

test("Agent preserves exhausted Judge attempts as advisory failure evidence and still promotes on Expert gates", async () => {
  const input = await fixture();
  const calls: AgentTaskOptions[] = [];
  const base = scriptedRunner(calls, 0.9);
  const unavailableJudge: GoldSkillRunner = async (options) => {
    if (options.trace?.stage === "independent-judge") {
      calls.push(options);
      return result(options, "Judge could not produce the required structured Artifact.");
    }
    return base(options);
  };
  const output = await driveAgent({
    ...input, cwd: input.root, provider: "test-provider", model: "test-model", activeSkillVersion: "v1",
    runRoot: join(input.root, "runs"), timeoutMs: 1_000, runner: unavailableJudge,
  });
  assert.equal(output.status, "promoted");
  assert.equal(output.judgePath, undefined);
  const decision = JSON.parse(await readFile(output.promotionDecisionPath!, "utf8")) as any;
  assert.equal(decision.decision, "promote");
  assert.equal(decision.judge, null);
  assert.equal(decision.judgeAdvisory.blocking, false);
  assert.equal(decision.judgeAdvisory.artifactAvailable, false);
  assert.match(decision.judgeAdvisory.failure, /failed after 3 attempts/);
  const manifest = JSON.parse(await readFile(output.manifestPath, "utf8")) as any;
  assert.equal(manifest.judgeAdvisoryStatus.status, "unavailable");
  assert.equal(manifest.judgeAdvisoryStatus.promotionBlocking, false);
  assert.deepEqual(manifest.stages.slice(-2).map((stage: any) => [stage.stage, stage.status]), [
    ["independent-judge", "failed"], ["promotion-decision", "completed"],
  ]);
  assert.equal(output.selfCheck?.status, "not-triggered");
});

test("Agent promotion gate rejects an Expert score and hard-pass regression", async () => {
  const input = await fixture();
  const calls: AgentTaskOptions[] = [];
  const output = await driveAgent({
    ...input,
    cwd: input.root,
    provider: "test-provider",
    model: "test-model",
    activeSkillVersion: "v1",
    runRoot: join(input.root, "runs"),
    timeoutMs: 1_000,
    runner: scriptedRunner(calls, 0.3),
  });
  assert.equal(output.status, "rejected");
  const decision = JSON.parse(await readFile(output.promotionDecisionPath!, "utf8")) as any;
  assert.equal(decision.expert.gatePassed, false);
  assert.equal(decision.reasons.includes("expert-score-regressed"), true);
  assert.equal(decision.reasons.includes("expert-candidate-hard-pass-failed"), true);
  assert.equal(decision.reasons.some((reason: string) => reason.startsWith("judge-")), false);
  assert.equal(decision.judgeAdvisory.blocking, false);
  assert.equal(decision.selfEvolutionTrigger, "triggered");
  assert.equal(output.selfCheck?.status, "failed");
});

test("Agent stops after a no-Finding review instead of sampling an identical Candidate Draft", async () => {
  const input = await fixture();
  const calls: AgentTaskOptions[] = [];
  const output = await driveAgent({
    ...input,
    cwd: input.root,
    provider: "test-provider",
    model: "test-model",
    activeSkillVersion: "v1",
    runRoot: join(input.root, "runs"),
    timeoutMs: 1_000,
    runner: scriptedRunner(calls, 0.9, false),
  });
  assert.equal(output.status, "rejected");
  assert.deepEqual(output.completedStages, [
    "description-reconstruction",
    "current-draft-generation",
    "reviewer-private-expert",
    "skill-attribution-review",
    "promotion-decision",
  ]);
  assert.equal(calls.some((call) => call.trace?.stage === "candidate-draft-generation"), false);
  assert.equal(output.candidateSkillPath, undefined);
  assert.equal(output.candidateDraftPath, undefined);
  const decision = JSON.parse(await readFile(output.promotionDecisionPath!, "utf8")) as any;
  assert.equal(decision.decision, "reject");
  assert.deepEqual(decision.reasons, ["no-attributed-skill-findings"]);
});

test("Reviewer parses only marker body and persists three terminal failures before throwing", async () => {
  const input = await fixture(); const calls: AgentTaskOptions[] = []; const base = scriptedRunner(calls);
  const runner: GoldSkillRunner = async (options) => {
    const stage = String(options.trace?.stage); if (!stage.startsWith("skill-attribution-review")) return base(options); calls.push(options);
    const finalText = `${"marker 外分析。".repeat(2_000)}\n<<<SKILL_REVIEW_START>>>\nINVALID|inside-marker\n<<<SKILL_REVIEW_END>>>\nFINDING|outside|incomplete|recall-gold-risk|add|high|span|effect|text`;
    const events = [{ type: "session" }, { type: "agent_start" }, { type: "turn_start" }, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "review contract" }] } }, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText }], stopReason: "stop", usage: { totalTokens: 2 } } }, { type: "turn_end" }, { type: "agent_end" }, { type: "agent_settled" }].map((event) => JSON.stringify(event)).join("\n") + "\n";
    const provenance = agentEventProvenance(events); await writeFile(options.rawEventsPath, events); await writeFile(`${options.rawEventsPath}.provenance.json`, `${JSON.stringify(provenance)}\n`);
    return { ...result(options, finalText), eventProvenance: provenance };
  };
  let output = await initializeGoldSkillRefineAgent({ ...input, cwd: input.root, provider: "test-provider", model: "test-model", activeSkillVersion: "v1", runRoot: join(input.root, "failed-runs"), timeoutMs: 1_000, runner });
  for (const stage of ["description-reconstruction", "current-draft-generation", "reviewer-private-expert"] as const) output = await advanceGoldSkillRefineAgent({ runDirectory: output.runDirectory, stage, runner });
  assert.equal(output.nextStage, "skill-attribution-review"); await assert.rejects(advanceGoldSkillRefineAgent({ runDirectory: output.runDirectory, stage: "skill-attribution-review", runner }), /failed after 3 attempts/);
  const manifest = JSON.parse(await readFile(output.manifestPath, "utf8")) as any; const state = JSON.parse(await readFile(output.statePath, "utf8")) as any; const failed = manifest.stages.at(-1);
  assert.equal(manifest.status, "failed"); assert.equal(manifest.nextStage, null); assert.equal(state.status, "failed"); assert.equal(state.nextStage, null); assert.equal(failed.stage, "skill-attribution-review"); assert.equal(failed.status, "failed"); assert.equal(failed.attempts.length, 3); assert.ok(failed.attempts.every((attempt: any) => attempt.status === "failed" && attempt.error && attempt.eventProvenance?.format === "public-jsonl")); assert.equal(failed.eventsPath, failed.attempts[2].eventsPath); assert.deepEqual(failed.outputArtifacts, []); assert.equal(failed.inputRefs.length, 5); assert.match(failed.card.digest, /^[a-f0-9]{64}$/); assert.equal(failed.provider, "test-provider"); assert.equal(failed.model, "test-model");
});

test("Candidate Draft read-contract failure persists its direct text Agent attempt", async () => {
  const input = await fixture(); const calls: AgentTaskOptions[] = []; const base = scriptedRunner(calls);
  const runner: GoldSkillRunner = async (options) => {
    if (options.trace?.stage !== "candidate-draft-generation") return base(options);
    calls.push(options);
    const finalText = "<<<CANDIDATE_DRAFT_START>>>\n# 候选方案\n\n包含风险与回滚。\n<<<CANDIDATE_DRAFT_END>>>";
    const events = [{ type: "session" }, { type: "agent_start" }, { type: "turn_start" }, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "candidate contract" }] } }, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText }], stopReason: "stop", usage: { totalTokens: 9 } } }, { type: "turn_end" }, { type: "agent_end" }, { type: "agent_settled" }].map((event) => JSON.stringify(event)).join("\n") + "\n";
    const provenance = agentEventProvenance(events); await writeFile(options.rawEventsPath, events); await writeFile(`${options.rawEventsPath}.provenance.json`, `${JSON.stringify(provenance)}\n`);
    return { ...result(options, finalText), stopReason: "stop", readPaths: [options.trace!.inputRefs![0]!], usage: { ...usage, totalTokens: 9 }, eventProvenance: provenance };
  };
  let output = await initializeGoldSkillRefineAgent({ ...input, cwd: input.root, provider: "test-provider", model: "test-model", activeSkillVersion: "v1", runRoot: join(input.root, "failed-candidate-runs"), timeoutMs: 1_000, runner });
  while (output.nextStage && output.nextStage !== "candidate-draft-generation") output = await advanceGoldSkillRefineAgent({ runDirectory: output.runDirectory, stage: output.nextStage, runner });
  assert.equal(output.nextStage, "candidate-draft-generation");
  await assert.rejects(advanceGoldSkillRefineAgent({ runDirectory: output.runDirectory, stage: "candidate-draft-generation", runner }), /read contract/i);
  const manifest = JSON.parse(await readFile(output.manifestPath, "utf8")) as any; const state = JSON.parse(await readFile(output.statePath, "utf8")) as any; const failed = manifest.stages.at(-1);
  assert.equal(manifest.status, "failed"); assert.equal(manifest.nextStage, null); assert.equal(state.status, "failed"); assert.equal(state.nextStage, null);
  assert.equal(failed.stage, "candidate-draft-generation"); assert.equal(failed.status, "failed"); assert.equal(failed.attempts.length, 1); assert.equal(failed.attempts[0].status, "failed");
  assert.equal(failed.eventsPath, calls.find((call) => call.trace?.stage === "candidate-draft-generation")!.rawEventsPath); assert.equal(failed.eventProvenance.format, "public-jsonl"); assert.equal(failed.attempts[0].eventProvenance.format, "public-jsonl");
  assert.deepEqual(failed.readPaths, [failed.inputRefs[0]]); assert.equal(failed.usage.totalTokens, 9); assert.deepEqual(failed.outputArtifacts, []); assert.equal(failed.inputArtifacts.length, 2);
  assert.equal(failed.card.roleId, "refine.draft"); assert.equal(failed.provider, "test-provider"); assert.equal(failed.model, "test-model"); assert.match(failed.error, /read contract/i);
  await assert.rejects(readFile(join(output.runDirectory, "candidate-draft.md"), "utf8"));
});
