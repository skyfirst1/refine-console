import { WorkflowControlError } from "../src/workflow-control.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentTaskOptions, AgentTaskResult } from "../src/agent-task-runner.js";
import { ExpertPipelineError, reduceExpertScore, runRefineExpertEvaluation, type AspectSet, type RefineExpertRunner } from "../src/refine-expert-pipeline.js";
import { buildDiagnosisSeeds, compileHarnessDiagnosisAnnotations, normalizeHarnessDiagnosisAnnotationText, parseHarnessDiagnosisAnnotationText, projectRefineRunToTaskStates, runHarnessSelfCheck, validateHarnessDiagnosis, validateHarnessDiagnosisAnnotations, type DiagnosisSeed, type EvidenceRecord } from "../src/refine-harness-self-check.js";
import { REFINE_EXPERT_CARDS } from "../src/refine-expert-cards.js";
import { REFINE_AGENT_CARDS } from "../src/refine-agent-cards.js";
import { REFINE_WORKFLOW_CARDS } from "../src/refine-workflow-cards.js";
import { compareDiagnosisCapabilityExperiment, computeDiagnosisFrozenInputDigest, evaluateDiagnosisCapabilityRun, type DiagnosisCapabilityRun } from "../src/refine-diagnosis-evaluation.js";
import { readSourceProvenance } from "../src/source-provenance.js";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costUsd: 0 };

test("Agent and Workflow expose the exact same three shared Expert Cards", () => {
  assert.deepEqual(Object.keys(REFINE_EXPERT_CARDS).sort(), ["refine.aspect-extractor", "refine.aspect-matcher", "refine.evidence-aligner"]);
  for (const [roleId, card] of Object.entries(REFINE_EXPERT_CARDS)) {
    assert.equal(REFINE_AGENT_CARDS[roleId as keyof typeof REFINE_AGENT_CARDS].digest, card.digest);
    assert.equal(REFINE_WORKFLOW_CARDS[roleId as keyof typeof REFINE_WORKFLOW_CARDS].digest, card.digest);
  }
  assert.equal("refine.expert" in REFINE_AGENT_CARDS, false);
  assert.equal("refine.expert-evaluator" in REFINE_WORKFLOW_CARDS, false);
  assert.match(REFINE_EXPERT_CARDS["refine.aspect-extractor"].systemPrompt, /Description 只提供任务语境[\s\S]*Evidence quote 必须逐字来自 source document/);
  assert.match(REFINE_EXPERT_CARDS["refine.aspect-extractor"].systemPrompt, /不得流式输出未完成的草稿对象[\s\S]*唯一一个完整合法 JSON 对象/);
  assert.match(REFINE_EXPERT_CARDS["refine.aspect-extractor"].systemPrompt, /不得把标点写成正则或 Markdown 转义形式/);
  assert.match(REFINE_EXPERT_CARDS["refine.evidence-aligner"].systemPrompt, /mode=style[\s\S]*不得用事实是否相同、事实是否覆盖/);
  assert.match(REFINE_EXPERT_CARDS["refine.evidence-aligner"].systemPrompt, /必须包含 matched、rationale，可选 evidence_citation/);
});

function result(options: AgentTaskOptions, text: string): AgentTaskResult {
  return { finalText: text, rawEventsPath: options.rawEventsPath, readPaths: [...(options.trace?.inputRefs ?? [])], toolNames: ["read"], usage };
}

async function seedDiagnosisRunner(options: AgentTaskOptions): Promise<AgentTaskResult> {
  const shards = await Promise.all((options.trace?.inputRefs ?? []).map((path) => readFile(path, "utf8").then((text) => JSON.parse(text))));
  const allSeeds = shards.flatMap((shard) => shard.diagnosisSeeds ?? []) as DiagnosisSeed[];
  const batchSeedIds = new Set(String(options.trace?.attributes?.["self_check.batch_seed_ids"] ?? "").split(",").filter(Boolean));
  const seeds = allSeeds.filter((seed) => batchSeedIds.has(seed.seedId));
  const evidence = decodeCompactEvidence(shards); const states = decodeCompactStates(shards);
  const annotations = seeds.map((seed) => { const targetEvidence = evidence.find((record) => seed.evidenceIds.includes(record.evidenceId))!; const targetState = states.find((state) => state.stateId === targetEvidence.stateId)!; return ({ seedId: seed.seedId, symptom: `Observed ${seed.type}`,
    responsibilityCandidates: [{ category: "unknown", targetStateRefs: [targetState.stateRef], supportingEvidenceRefs: [targetEvidence.evidenceRef], counterEvidenceRefs: [],
      evidenceSufficiency: "insufficient", rationale: "Evidence locates failure, but cannot attribute responsibility." }],
    failureClass: seed.type === "candidate-expert-f1-regression" ? "evaluation" : seed.type === "contract-violation" ? "output_contract" : "provider",
    severity: "medium", reproducibility: "observed" }); });
  return result(options, JSON.stringify({ schemaVersion: "1.1", annotations }));
}

function decodeCompactStates(shards: any[]): Array<{ stateRef: number; stateId: string; stage: string }> {
  const dictionary = new Map<number, string>(shards.flatMap((shard) => shard.dictionaryEntries ?? []));
  return shards.flatMap((shard) => shard.taskStateDag?.stateTuples ?? []).map((tuple: any[]) => ({ stateRef: tuple[0], stateId: dictionary.get(tuple[1])!, stage: dictionary.get(tuple[9])! }));
}
function decodeCompactEvidence(shards: any[]): Array<{ evidenceRef: number; evidenceId: string; stateId: string; kind: string; provenanceId: string; relation: string; sourcePath: string | null }> {
  const dictionary = new Map<number, string>(shards.flatMap((shard) => shard.dictionaryEntries ?? []));
  return shards.flatMap((shard) => shard.evidenceTuples ?? []).map((tuple: any[]) => ({ evidenceRef: tuple[0], evidenceId: dictionary.get(tuple[1])!, kind: dictionary.get(tuple[2])!, stateId: dictionary.get(tuple[3])!,
    relation: dictionary.get(tuple[8])!, provenanceId: dictionary.get(tuple[9])!, sourcePath: tuple[10] === -1 ? null : dictionary.get(tuple[10])! }));
}
function decodeCompactContracts(shards: any[]): Array<{ validationId: string; check: string; status: string }> {
  const dictionary = new Map<number, string>(shards.flatMap((shard) => shard.dictionaryEntries ?? []));
  return shards.flatMap((shard) => shard.contractValidationTuples ?? []).map((tuple: any[]) => ({ validationId: dictionary.get(tuple[0])!, check: dictionary.get(tuple[1])!, status: dictionary.get(tuple[2])! }));
}
function decodeCompactPassSummaries(shards: any[]): Array<{ check: string; status: string; validationEntryCount: number }> {
  const dictionary = new Map<number, string>(shards.flatMap((shard) => shard.dictionaryEntries ?? []));
  return shards.flatMap((shard) => shard.passingContractSummaryTuples ?? []).map((tuple: any[]) => ({ check: dictionary.get(tuple[0])!, status: dictionary.get(tuple[1])!, validationEntryCount: tuple[5] }));
}

async function assertSeedGrounding(summary: any, expectedType: DiagnosisSeed["type"]) {
  const shards = await Promise.all(summary.diagnosisInputPaths.map((path: string) => readFile(path, "utf8").then((text) => JSON.parse(text))));
  const exposedSeeds = shards.flatMap((shard) => shard.diagnosisSeeds ?? []);
  const visibleStates = new Map(decodeCompactStates(shards).map((state) => [state.stateRef, state]));
  const visibleEvidence = new Map(decodeCompactEvidence(shards).map((record) => [record.evidenceRef, record]));
  const projection = JSON.parse(await readFile(summary.taskStatePath, "utf8"));
  const fullStates = projection.taskStateDag.states; const fullEvidence = projection.evidenceRecords;
  assert.ok(exposedSeeds.some((seed: any) => seed.type === expectedType));
  for (const seed of exposedSeeds) {
    assert.ok(Number.isInteger(seed.groundingStateRef) && seed.groundingEvidenceRefs.length > 0);
    const state = visibleStates.get(seed.groundingStateRef)!; assert.equal(state.stateId, fullStates[seed.groundingStateRef - 1].stateId);
    for (const ref of seed.groundingEvidenceRefs) {
      const record = visibleEvidence.get(ref)!; assert.equal(record.evidenceId, fullEvidence[ref - 1].evidenceId);
      assert.equal(record.stateId, state.stateId, `grounding Evidence ${ref} must be owned by grounding state ${seed.groundingStateRef}`);
    }
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "refine-expert-pipeline-"));
  const descriptionPath = join(root, "description.md");
  const goldPath = join(root, "gold.md");
  const currentPath = join(root, "current.md");
  const candidatePath = join(root, "candidate.md");
  await Promise.all([
    writeFile(descriptionPath, "写一份包含风险与回滚的迁移方案。\n"),
    writeFile(goldPath, "# Gold\n\n风险 A；回滚 B。\n"),
    writeFile(currentPath, "# Current\n\n风险 A。\n"),
    writeFile(candidatePath, "# Candidate\n\n风险 A；回滚 B。\n"),
  ]);
  return { root, descriptionPath, goldPath, currentPath, candidatePath };
}

function expertRunner(calls: AgentTaskOptions[], candidateRegresses = false): RefineExpertRunner {
  return async (options) => {
    calls.push(options);
    const stage = String(options.trace?.stage);
    if (stage.includes("aspect-extraction")) {
      const sourcePath = options.trace!.inputRefs![1]!;
      const source = await readFile(sourcePath, "utf8");
      const id = source.includes("Gold") ? "gold-risk" : source.includes("Candidate") ? "candidate-risk" : "current-risk";
      return result(options, `<<<ASPECT_SET_START>>>\n${JSON.stringify({ aspects: [{ id, title: "风险与回滚", description: "风险必须有回滚", evidences: [{ quote: source.trim(), location: "全文" }] }] })}\n<<<ASPECT_SET_END>>>`);
    }
    if (stage.includes("-match-")) {
      const input = JSON.parse(await readFile(options.trace!.inputRefs![0]!, "utf8")) as { direction: "recall" | "precision"; sourceAspect: { id: string } };
      const target = JSON.parse(await readFile(options.trace!.inputRefs![1]!, "utf8")) as AspectSet;
      return result(options, `<<<ASPECT_MATCH_START>>>\n${JSON.stringify({ direction: input.direction, sourceAspectId: input.sourceAspect.id, targetAspectId: target.aspects[0]!.id, matched: true, rationale: "语义对应" })}\n<<<ASPECT_MATCH_END>>>`);
    }
    if (stage.includes("-alignment-")) {
      const input = JSON.parse(await readFile(options.trace!.inputRefs![0]!, "utf8")) as { mode: "content" | "style" };
      const candidate = stage.startsWith("candidate-");
      const matched = candidateRegresses ? !candidate : candidate || input.mode === "content";
      return result(options, `<<<EVIDENCE_ALIGNMENT_START>>>\n${JSON.stringify({ matched, rationale: matched ? "对齐" : "未对齐" })}\n<<<EVIDENCE_ALIGNMENT_END>>>`);
    }
    throw new Error(`unexpected stage ${stage}`);
  };
}

test("shared Expert freezes Gold once, keeps extractor identity stable, and performs linear directional matching", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const runner = expertRunner(calls);
  const goldAspectSetPath = join(f.root, "gold-aspects.json");
  const current = await runRefineExpertEvaluation({ cwd: f.root, provider: "test", model: "same-model", timeoutMs: 1000,
    runner, runId: "run", runDirectory: f.root, parentTaskId: "current-expert", evaluationId: "current",
    descriptionPath: f.descriptionPath, goldPath: f.goldPath, documentPath: f.currentPath, goldAspectSetPath, outputPath: join(f.root, "current-expert.json") });
  const candidate = await runRefineExpertEvaluation({ cwd: f.root, provider: "test", model: "same-model", timeoutMs: 1000,
    runner, runId: "run", runDirectory: f.root, parentTaskId: "candidate-expert", evaluationId: "candidate",
    descriptionPath: f.descriptionPath, goldPath: f.goldPath, documentPath: f.candidatePath, goldAspectSetPath,
    expectedGoldAspectSetSha256: current.goldAspectSetSha256, outputPath: join(f.root, "candidate-expert.json") });

  assert.equal(calls.filter((call) => call.trace?.stage === "gold-aspect-extraction").length, 1);
  assert.equal(current.goldExtracted, true);
  assert.equal(candidate.goldExtracted, false);
  assert.equal(current.report.sourceInputs.goldAspectSetSha256, candidate.report.sourceInputs.goldAspectSetSha256);
  assert.equal(current.goldAspectSetSha256, createHash("sha256").update(await readFile(goldAspectSetPath)).digest("hex"));
  const extractors = calls.filter((call) => String(call.trace?.stage).includes("aspect-extraction"));
  assert.ok(extractors.every((call) => call.provider === "test" && call.model === "same-model"));
  assert.ok(extractors.every((call) => /Description 只提供任务语境，不是 Evidence 来源/.test(call.prompt)));
  assert.ok(extractors.every((call) => /Evidence quote 必须从 source document 原样复制连续文本/.test(call.prompt)));
  assert.ok(extractors.every((call) => /不得把标点写成正则或 Markdown 转义形式/.test(call.prompt)));
  assert.ok(extractors.every((call) => call.trace?.attributes?.["agent.card.digest"] === extractors[0]!.trace?.attributes?.["agent.card.digest"]));
  assert.ok(extractors.every((call) => call.systemPrompt === extractors[0]!.systemPrompt.replace(extractors[0]!.trace!.inputRefs![1]!, call.trace!.inputRefs![1]!)));
  assert.equal(calls.filter((call) => String(call.trace?.stage).includes("-match-")).length, 4, "one gold + one document source in each of two evaluations");
  assert.ok(calls.filter((call) => String(call.trace?.stage).includes("-alignment-")).every((call) => /不得以事实覆盖或事实相同替代 style 判断/.test(call.prompt)));
  assert.equal(current.report.f1, 0.5);
  assert.equal(candidate.report.f1, 1);
  await writeFile(goldAspectSetPath, `${await readFile(goldAspectSetPath, "utf8")}\n`, "utf8");
  await assert.rejects(runRefineExpertEvaluation({ cwd: f.root, provider: "test", model: "same-model", timeoutMs: 1000,
    runner, runId: "tampered", runDirectory: f.root, parentTaskId: "candidate-expert", evaluationId: "candidate",
    descriptionPath: f.descriptionPath, goldPath: f.goldPath, documentPath: f.candidatePath, goldAspectSetPath,
    expectedGoldAspectSetSha256: current.goldAspectSetSha256, outputPath: join(f.root, "tampered-expert.json") }), /artifact changed/);
});

test("recall and precision directions execute in parallel against frozen AspectSets", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const base = expertRunner(calls);
  let releasePrecision!: () => void;
  const precisionStarted = new Promise<void>((resolve) => { releasePrecision = resolve; });
  const runner: RefineExpertRunner = async (options) => {
    const stage = String(options.trace?.stage);
    if (stage === "current-recall-match-1") {
      await Promise.race([precisionStarted, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("precision direction did not start in parallel")), 500))]);
    }
    if (stage === "current-precision-match-1") releasePrecision();
    return base(options);
  };
  await runRefineExpertEvaluation({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000, runner,
    runId: "parallel", runDirectory: f.root, parentTaskId: "expert", evaluationId: "current",
    descriptionPath: f.descriptionPath, goldPath: f.goldPath, documentPath: f.currentPath,
    goldAspectSetPath: join(f.root, "parallel-gold.json"), outputPath: join(f.root, "parallel-expert.json") });
  assert.ok(calls.some((call) => call.trace?.stage === "current-recall-match-1"));
  assert.ok(calls.some((call) => call.trace?.stage === "current-precision-match-1"));
});

test("Expert records narrow fence, embedded-fence, bare-object, and invalid-escape normalization", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const base = expertRunner(calls);
  const runner: RefineExpertRunner = async (options) => {
    const stage = String(options.trace?.stage);
    if (stage.includes("aspect-extraction")) {
      calls.push(options);
      const malformed = '{"aspects":[{"id":"aspect-1","title":"格式","description":"保留 Markdown 路径文本","evidences":[{"quote":"\\.scad","location":"正文"}]}]}';
      return result(options, stage === "gold-aspect-extraction" ? `\`\`\`json\n${malformed}\n\`\`\``
        : stage.startsWith("current-") ? `已读取输入。\n\n\`\`\`json\n${malformed}\n\`\`\`` : malformed);
    }
    if (stage === "current-recall-match-1") {
      calls.push(options);
      const source = JSON.parse(await readFile(options.trace!.inputRefs![0]!, "utf8")) as { direction: string; sourceAspect: { id: string } };
      const target = JSON.parse(await readFile(options.trace!.inputRefs![1]!, "utf8")) as AspectSet;
      return result(options, `<<<ASPECT_MATCH_START>>>{"direction":"${source.direction}","sourceAspectId":"${source.sourceAspect.id}","targetAspectId":"${target.aspects[0]!.id}","matched":true,"rationale":"包含"未转义引用"但可修复"}<<<ASPECT_MATCH_END>>>`);
    }
    return base(options);
  };
  const output = await runRefineExpertEvaluation({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000, runner,
    runId: "normalize", runDirectory: f.root, parentTaskId: "expert", evaluationId: "current",
    descriptionPath: f.descriptionPath, goldPath: f.goldPath, documentPath: f.currentPath,
    goldAspectSetPath: join(f.root, "normalize-gold.json"), outputPath: join(f.root, "normalize-expert.json") });
  const candidate = await runRefineExpertEvaluation({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000, runner,
    runId: "normalize", runDirectory: f.root, parentTaskId: "candidate-expert", evaluationId: "candidate",
    descriptionPath: f.descriptionPath, goldPath: f.goldPath, documentPath: f.candidatePath,
    goldAspectSetPath: join(f.root, "normalize-gold.json"), expectedGoldAspectSetSha256: output.goldAspectSetSha256,
    outputPath: join(f.root, "normalize-candidate-expert.json") });
  const extractionCalls = [...output.calls, ...candidate.calls].filter((call) => call.card.roleId === "refine.aspect-extractor");
  assert.ok(extractionCalls.some((call) => call.normalizations?.includes("single-json-fence")));
  assert.ok(extractionCalls.some((call) => call.normalizations?.includes("bare-json")));
  assert.ok(extractionCalls.some((call) => call.normalizations?.includes("embedded-json-fence")));
  assert.ok(extractionCalls.every((call) => call.normalizations?.includes("invalid-json-escape")));
  assert.ok(output.calls.some((call) => call.normalizations?.includes("unescaped-rationale-quotes")));
  assert.ok(output.calls.some((call) => call.normalizations?.includes("inline-markers")));
});

test("Expert accepts the real matcher shape of prose plus one schema-valid JSON object and rejects multiple objects", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const base = expertRunner(calls);
  const runner: RefineExpertRunner = async (options) => {
    if (options.trace?.stage === "current-precision-match-1") {
      calls.push(options);
      const source = JSON.parse(await readFile(options.trace.inputRefs![0]!, "utf8")) as { direction: string; sourceAspect: { id: string } };
      const target = JSON.parse(await readFile(options.trace.inputRefs![1]!, "utf8")) as AspectSet;
      return result(options, `已比较所有候选，以下为唯一结果。\n\n${JSON.stringify({ direction: source.direction, sourceAspectId: source.sourceAspect.id, targetAspectId: target.aspects[0]!.id, matched: true, rationale: "主题和证据范围一致" })}`);
    }
    return base(options);
  };
  const output = await runRefineExpertEvaluation({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000, runner,
    runId: "real-shape", runDirectory: f.root, parentTaskId: "expert", evaluationId: "current",
    descriptionPath: f.descriptionPath, goldPath: f.goldPath, documentPath: f.currentPath,
    goldAspectSetPath: join(f.root, "real-shape-gold.json"), outputPath: join(f.root, "real-shape-expert.json") });
  assert.ok(output.calls.some((call) => call.stage === "current-precision-match-1" && call.normalizations?.includes("embedded-json-object")));

  const markerCalls: AgentTaskOptions[] = [];
  const markerBase = expertRunner(markerCalls);
  const markerOutput = await runRefineExpertEvaluation({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000,
    runner: async (options) => {
      if (options.trace?.stage === "current-precision-match-1") {
        markerCalls.push(options);
        const source = JSON.parse(await readFile(options.trace.inputRefs![0]!, "utf8")) as { direction: string; sourceAspect: { id: string } };
        const target = JSON.parse(await readFile(options.trace.inputRefs![1]!, "utf8")) as AspectSet;
        return result(options, `修正格式时不要输出占位对象 {...}。\n<<<ASPECT_MATCH_START>>>\n${JSON.stringify({ direction: source.direction, sourceAspectId: source.sourceAspect.id, targetAspectId: target.aspects[0]!.id, matched: true, rationale: "语义一致" })}\n<<<ASPECT_MATCH_END>>>`);
      }
      return markerBase(options);
    }, runId: "marked-artifact", runDirectory: f.root, parentTaskId: "expert", evaluationId: "current",
    descriptionPath: f.descriptionPath, goldPath: f.goldPath, documentPath: f.currentPath,
    goldAspectSetPath: join(f.root, "marked-artifact-gold.json"), outputPath: join(f.root, "marked-artifact-expert.json") });
  assert.ok(markerOutput.calls.some((call) => call.stage === "current-precision-match-1" && call.normalizations?.includes("inline-markers")));

  await assert.rejects(runRefineExpertEvaluation({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000,
    runner: async (options) => result(options, '{"aspects":[]}\n{"aspects":[]}'), runId: "two-objects", runDirectory: f.root,
    parentTaskId: "expert", evaluationId: "current", descriptionPath: f.descriptionPath, goldPath: f.goldPath,
    documentPath: f.currentPath, goldAspectSetPath: join(f.root, "two-objects-gold.json"), outputPath: join(f.root, "two-objects-expert.json") }), /exactly one JSON object; found 2/);
});

test("Expert terminal failure exposes all accumulated attempt metadata", async () => {
  const f = await fixture();
  const base = expertRunner([]);
  let caught: unknown;
  try {
    await runRefineExpertEvaluation({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000,
      runner: async (options) => options.trace?.stage === "current-precision-match-1" ? result(options, "no JSON result") : base(options),
      runId: "attempts", runDirectory: f.root, parentTaskId: "expert", evaluationId: "current",
      descriptionPath: f.descriptionPath, goldPath: f.goldPath, documentPath: f.currentPath,
      goldAspectSetPath: join(f.root, "attempts-gold.json"), outputPath: join(f.root, "attempts-expert.json") });
  } catch (error) { caught = error; }
  assert.ok(caught instanceof ExpertPipelineError);
  const failed = caught.calls.find((call) => call.stage === "current-precision-match-1")!;
  assert.deepEqual(failed.attempts?.map((attempt) => attempt.status), ["failed", "failed", "failed", "failed"]);
  assert.ok(failed.attempts?.every((attempt) => attempt.eventsPath.endsWith(".events.jsonl")));
});

test("Expert corrections continue one Agent session with public Trace, exact validation error, original goal, and completed reads", async () => {
  const f = await fixture();
  const goldBytes = await readFile(f.goldPath);
  const descriptionBytes = await readFile(f.descriptionPath);
  const goldAspectSetPath = join(f.root, "correction-gold.json");
  await writeFile(goldAspectSetPath, `${JSON.stringify({
    sourceSha256: createHash("sha256").update(goldBytes).digest("hex"),
    descriptionSha256: createHash("sha256").update(descriptionBytes).digest("hex"),
    aspects: [{ id: "gold-risk", title: "风险", description: "风险与回滚", evidences: [{ quote: "风险 A；回滚 B。", location: "正文" }] }],
  }, null, 2)}\n`);
  const calls: AgentTaskOptions[] = [];
  const base = expertRunner(calls);
  let extractionTurns = 0;
  const runner: RefineExpertRunner = async (options) => {
    if (options.trace?.stage !== "current-document-aspect-extraction") return base(options);
    calls.push(options);
    extractionTurns += 1;
    if (extractionTurns === 1) {
      const invalid = '<<<ASPECT_SET_START>>>\n{"aspects":[{"id":"broken","title":"broken"}]}\n<<<ASPECT_SET_END>>>';
      const publicTrace = [
        JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: options.prompt }] } }),
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: invalid }], stopReason: "stop", usage } }),
      ].join("\n") + "\n";
      await writeFile(options.rawEventsPath, publicTrace);
      return result(options, invalid);
    }
    const corrected = result(options, JSON.stringify({ aspects: [{ id: "current-risk", title: "风险", description: "风险条目", evidences: [{ quote: "风险 A。", location: "正文" }] }] }));
    corrected.readPaths = [...corrected.readPaths, f.descriptionPath, f.currentPath];
    return corrected;
  };
  const output = await runRefineExpertEvaluation({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000, runner,
    runId: "correction", runDirectory: f.root, parentTaskId: "expert", evaluationId: "current",
    descriptionPath: f.descriptionPath, goldPath: f.goldPath, documentPath: f.currentPath,
    goldAspectSetPath, outputPath: join(f.root, "correction-expert.json") });
  const extractionCalls = calls.filter((call) => call.trace?.stage === "current-document-aspect-extraction");
  assert.equal(extractionCalls.length, 2);
  assert.equal(extractionCalls[0]!.session!.id, extractionCalls[1]!.session!.id);
  assert.equal(extractionCalls[0]!.trace!.attributes!["agent.phase"], "initial");
  assert.equal(extractionCalls[1]!.trace!.attributes!["agent.phase"], "correction");
  assert.match(extractionCalls[1]!.prompt, /延续当前 Agent correction session[\s\S]*不要复述旧输出、从零重做/);
  assert.match(extractionCalls[1]!.prompt, /第一个非空白字符必须是 \{[\s\S]*最后一个非空白字符必须是 \}/);
  assert.match(extractionCalls[1]!.prompt, /先调用 read[\s\S]*下一条 assistant 消息的第一个非空白字符/);
  assert.match(extractionCalls[1]!.prompt, /校验器错误：/);
  assert.doesNotMatch(extractionCalls[1]!.systemPrompt, /只输出指定标记中的 JSON/);
  const correctionContextPath = extractionCalls[1]!.trace!.inputRefs![0]!;
  const correctionContext = JSON.parse(await readFile(correctionContextPath, "utf8"));
  assert.equal(correctionContext.originalTaskGoal.stage, "current-document-aspect-extraction");
  assert.match(correctionContext.originalTaskGoal.goalSha256, /^[a-f0-9]{64}$/);
  assert.match(correctionContext.exactValidationError, /schema is invalid/);
  assert.deepEqual(correctionContext.completedFileReads.map((path: string) => path.toLowerCase()).sort(), [f.descriptionPath, f.currentPath].map((path) => path.toLowerCase()).sort());
  assert.equal(correctionContext.missingInputRefs.length, 0);
  assert.match(correctionContext.failedPublicAttemptRefs[0].publicTraceSha256, /^[a-f0-9]{64}$/);
  assert.equal("publicTrace" in correctionContext.failedPublicAttemptRefs[0], false);
  assert.doesNotMatch(JSON.stringify(correctionContext), /<<<ASPECT_SET_(?:START|END)>>>/);
  assert.doesNotMatch(extractionCalls[1]!.prompt, /<<<ASPECT_SET_(?:START|END)>>>/);
  const extraction = output.calls.find((call) => call.stage === "current-document-aspect-extraction")!;
  assert.deepEqual(extraction.attempts!.map((attempt) => attempt.phase), ["initial", "correction"]);
  assert.equal(extraction.session!.continuation, "native");
  assert.equal(extraction.attempts![1]!.correctionProtocol, "raw-json-v2");
  assert.match(extraction.attempts![1]!.correctionContextPath!, /-correction-context\.json$/);
  assert.match(extraction.attempts![1]!.correctionContextSnapshotPath!, /-correction-1-context\.json$/);
  assert.equal(extraction.card.runtime, "pi-session");
});

test("raw-json-v2 correction rejects two unwrapped Artifacts", async () => {
  const f = await fixture();
  const base = expertRunner([]);
  await assert.rejects(runRefineExpertEvaluation({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000,
    runner: async (options) => options.trace?.stage === "current-document-aspect-extraction"
      ? result(options, options.trace.attributes?.["agent.phase"] === "correction"
        ? '{"aspects":[]}\n{"aspects":[]}'
        : '<<<ASPECT_SET_START>>>\n{"aspects":[]}\n<<<ASPECT_SET_END>>>')
      : base(options),
    runId: "raw-json-double", runDirectory: f.root, parentTaskId: "expert", evaluationId: "current",
    descriptionPath: f.descriptionPath, goldPath: f.goldPath, documentPath: f.currentPath,
    goldAspectSetPath: join(f.root, "raw-json-double-gold.json"), outputPath: join(f.root, "raw-json-double-expert.json")
  }), /exactly one JSON object; found 2/);
});

test("Matcher correction names missing identity fields and repeats the exact five-field contract", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const base = expertRunner(calls);
  let matcherTurns = 0;
  let sourceIdentity: { direction: string; sourceAspectId: string } | null = null;
  const runner: RefineExpertRunner = async (options) => {
    if (options.trace?.stage !== "current-recall-match-1") return base(options);
    calls.push(options); matcherTurns += 1;
    if (matcherTurns === 1) {
      const source = JSON.parse(await readFile(options.trace.inputRefs![0]!, "utf8")) as { direction: string; sourceAspect: { id: string } };
      sourceIdentity = { direction: source.direction, sourceAspectId: source.sourceAspect.id };
      return result(options, `<<<ASPECT_MATCH_START>>>\n${JSON.stringify({ targetAspectId: null, matched: false, rationale: "无匹配" })}\n<<<ASPECT_MATCH_END>>>`);
    }
    return result(options, JSON.stringify({ direction: sourceIdentity!.direction, sourceAspectId: sourceIdentity!.sourceAspectId, targetAspectId: null, matched: false, rationale: "无匹配" }));
  };
  await runRefineExpertEvaluation({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000, runner,
    runId: "matcher-fields", runDirectory: f.root, parentTaskId: "expert", evaluationId: "current",
    descriptionPath: f.descriptionPath, goldPath: f.goldPath, documentPath: f.currentPath,
    goldAspectSetPath: join(f.root, "matcher-fields-gold.json"), outputPath: join(f.root, "matcher-fields-expert.json") });
  const matcherCalls = calls.filter((call) => call.trace?.stage === "current-recall-match-1");
  assert.equal(matcherCalls.length, 2);
  assert.match(REFINE_EXPERT_CARDS["refine.aspect-matcher"].systemPrompt, /必须包含 direction、sourceAspectId、targetAspectId、matched、rationale 五个字段/);
  assert.match(matcherCalls[1]!.prompt, /only these fields are allowed: direction, sourceAspectId, targetAspectId, matched, rationale/);
  assert.match(matcherCalls[1]!.prompt, /required fields are missing: direction, sourceAspectId/);
  assert.match(matcherCalls[1]!.prompt, /必须包含 direction、sourceAspectId、targetAspectId、matched、rationale 五个字段/);
});

test("Alignment correction rejects unrelated score while keeping optional citations compatible", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const base = expertRunner(calls);
  let alignmentTurns = 0;
  const runner: RefineExpertRunner = async (options) => {
    if (options.trace?.stage !== "current-alignment-1-content") return base(options);
    calls.push(options);
    alignmentTurns += 1;
    if (alignmentTurns === 1) {
      return result(options, `<<<EVIDENCE_ALIGNMENT_START>>>\n${JSON.stringify({ matched: true, rationale: "对齐", score: 1 })}\n<<<EVIDENCE_ALIGNMENT_END>>>`);
    }
    return result(options, JSON.stringify({ matched: true, rationale: "对齐" }));
  };
  const output = await runRefineExpertEvaluation({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000, runner,
    runId: "alignment-fields", runDirectory: f.root, parentTaskId: "expert", evaluationId: "current",
    descriptionPath: f.descriptionPath, goldPath: f.goldPath, documentPath: f.currentPath,
    goldAspectSetPath: join(f.root, "alignment-fields-gold.json"), outputPath: join(f.root, "alignment-fields-expert.json") });
  const alignmentCalls = calls.filter((call) => call.trace?.stage === "current-alignment-1-content");
  assert.equal(alignmentCalls.length, 2);
  assert.equal(alignmentCalls[0]!.session!.id, alignmentCalls[1]!.session!.id);
  assert.match(alignmentCalls[0]!.prompt, /必须包含 matched、rationale，可选 evidence_citation/);
  const correctionContext = JSON.parse(await readFile(alignmentCalls[1]!.trace!.inputRefs![0]!, "utf8"));
  assert.match(correctionContext.exactValidationError, /only these fields are allowed: matched, rationale/);
  assert.match(correctionContext.exactValidationError, /unknown fields must be removed: score/);
  assert.match(alignmentCalls[1]!.prompt, /不要先说已读取、将要生成或解释修复/);
  assert.match(REFINE_EXPERT_CARDS["refine.evidence-aligner"].systemPrompt, /不得调用占位路径或任何其他路径/);
  const record = output.calls.find((call) => call.stage === "current-alignment-1-content")!;
  assert.equal(record.attempts![1]!.correctionProtocol, "raw-json-v2");
});

test("matcher call count is goldCount plus documentCount, not a Cartesian product", async () => {
  const f = await fixture();
  const calls: AgentTaskOptions[] = [];
  const runner: RefineExpertRunner = async (options) => {
    calls.push(options);
    const stage = String(options.trace?.stage);
    if (stage.includes("aspect-extraction")) {
      const count = stage === "gold-aspect-extraction" ? 2 : 3;
      return result(options, `<<<ASPECT_SET_START>>>\n${JSON.stringify({ aspects: Array.from({ length: count }, (_, index) => ({ id: `${stage}-${index + 1}`, title: `aspect ${index + 1}`, description: `aspect ${index + 1}`, evidences: [{ quote: `quote ${index + 1}`, location: `${index + 1}` }] })) })}\n<<<ASPECT_SET_END>>>`);
    }
    if (stage.includes("-match-")) {
      const source = JSON.parse(await readFile(options.trace!.inputRefs![0]!, "utf8")) as { direction: string; sourceAspect: { id: string } };
      const target = JSON.parse(await readFile(options.trace!.inputRefs![1]!, "utf8")) as AspectSet;
      return result(options, `<<<ASPECT_MATCH_START>>>\n${JSON.stringify({ direction: source.direction, sourceAspectId: source.sourceAspect.id, targetAspectId: target.aspects[0]!.id, matched: true, rationale: "best" })}\n<<<ASPECT_MATCH_END>>>`);
    }
    return result(options, `<<<EVIDENCE_ALIGNMENT_START>>>\n{"matched":true,"rationale":"aligned"}\n<<<EVIDENCE_ALIGNMENT_END>>>`);
  };
  await runRefineExpertEvaluation({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000, runner,
    runId: "linear", runDirectory: f.root, parentTaskId: "expert", evaluationId: "current",
    descriptionPath: f.descriptionPath, goldPath: f.goldPath, documentPath: f.currentPath,
    goldAspectSetPath: join(f.root, "linear-gold.json"), outputPath: join(f.root, "linear-expert.json") });
  assert.equal(calls.filter((call) => String(call.trace?.stage).includes("-match-")).length, 5);
});

test("Expert reducer uses Content/Style Average and handles zero denominators", () => {
  const gold: AspectSet = { sourceSha256: "g", descriptionSha256: "d", aspects: [
    { id: "g1", title: "one", description: "one", evidences: [{ quote: "one", location: "1" }] },
    { id: "g2", title: "two", description: "two", evidences: [{ quote: "two", location: "2" }] },
  ] };
  const doc: AspectSet = { sourceSha256: "x", descriptionSha256: "d", aspects: [{ id: "x1", title: "one", description: "one", evidences: [{ quote: "one", location: "1" }] }] };
  const score = reduceExpertScore({ descriptionSha256: "d", goldSha256: "g", documentSha256: "x", gold, document: doc,
    recallMatches: [{ direction: "recall", sourceAspectId: "g1", targetAspectId: "x1", matched: true, rationale: "yes" }, { direction: "recall", sourceAspectId: "g2", targetAspectId: null, matched: false, rationale: "none" }],
    precisionMatches: [{ direction: "precision", sourceAspectId: "x1", targetAspectId: "g1", matched: true, rationale: "yes" }],
    alignments: [
      { sourceAspectId: "g1", targetAspectId: "x1", contentMatched: true, styleMatched: false, contentRationale: "yes", styleRationale: "no" },
      { sourceAspectId: "x1", targetAspectId: "g1", contentMatched: true, styleMatched: false, contentRationale: "yes", styleRationale: "no" },
    ] });
  assert.equal(score.recall, 0.25);
  assert.equal(score.precision, 0.5);
  assert.equal(score.f1, 1 / 3);
  assert.equal(score.computedBy.id, "expert-score-reducer");
  assert.equal(reduceExpertScore({ descriptionSha256: "d", goldSha256: "g", documentSha256: "x",
    gold: { ...gold, aspects: [] }, document: { ...doc, aspects: [] }, recallMatches: [], precisionMatches: [], alignments: [] }).f1, 0);
  assert.throws(() => reduceExpertScore({ descriptionSha256: "d", goldSha256: "g", documentSha256: "x", gold, document: doc,
    recallMatches: [
      { direction: "recall", sourceAspectId: "g1", targetAspectId: "x1", matched: true, rationale: "yes" },
      { direction: "recall", sourceAspectId: "g1", targetAspectId: null, matched: false, rationale: "duplicate" },
    ], precisionMatches: [{ direction: "precision", sourceAspectId: "x1", targetAspectId: "g1", matched: true, rationale: "yes" }], alignments: [] }), /source coverage/);
});

test("Aspect model output cannot provide scores", async () => {
  const f = await fixture();
  await assert.rejects(runRefineExpertEvaluation({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000,
    runner: async (options) => result(options, `<<<ASPECT_SET_START>>>\n${JSON.stringify({ aspects: [{ id: "a", title: "a", description: "a", evidences: [{ quote: "a", location: "a" }] }], overallScore: 1 })}\n<<<ASPECT_SET_END>>>`),
    runId: "forbid-score", runDirectory: f.root, parentTaskId: "expert", evaluationId: "current", descriptionPath: f.descriptionPath,
    goldPath: f.goldPath, documentPath: f.currentPath, goldAspectSetPath: join(f.root, "forbid-gold.json"), outputPath: join(f.root, "forbid-report.json") }), /model scores are forbidden/);
});

test("self-check triggers only on deterministic F1 decrease and failures preserve artifacts", async () => {
  const f = await fixture();
  const manifestPath = join(f.root, "manifest.json");
  const artifactPath = join(f.root, "artifact.json");
  await Promise.all([writeFile(manifestPath, "{}\n"), writeFile(artifactPath, "{}\n")]);
  const artifactSha = createHash("sha256").update(await readFile(artifactPath)).digest("hex");
  const stages = [{ stage: "candidate-expert-evaluation", taskId: "candidate", kind: "deterministic-tool", inputArtifacts: [], outputArtifacts: [{ path: artifactPath, sha256: artifactSha }] },
    { stage: "promotion-decision", taskId: "decision", kind: "deterministic-tool", inputArtifacts: [], outputArtifacts: [{ path: artifactPath, sha256: artifactSha }] }];
  const calls: AgentTaskOptions[] = [];
  const notTriggered = await runHarnessSelfCheck({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000, runId: "same", runDirectory: f.root,
    manifestPath, currentF1: 0.5, candidateF1: 0.5, stages, artifacts: { artifactPath }, sourceKind: "current-refine-run", runner: async (options) => { calls.push(options); throw new Error("must not call"); } });
  assert.equal(notTriggered.status, "not-triggered");
  assert.equal(calls.length, 0);
  const replay = await runHarnessSelfCheck({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000, runId: "replay", runDirectory: f.root,
    manifestPath, currentF1: 0.5, candidateF1: 0.5, stages, artifacts: { artifactPath }, sourceKind: "historical-replay" });
  assert.equal(replay.sourceKind, "historical-replay");
  const failed = await runHarnessSelfCheck({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000, runId: "regressed", runDirectory: f.root,
    manifestPath, currentF1: 0.8, candidateF1: 0.3, stages, artifacts: { artifactPath }, sourceKind: "current-refine-run", runner: async () => { throw new Error("Acontext unavailable"); } });
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /Acontext unavailable/);
  await assertSeedGrounding(failed, "candidate-expert-f1-regression");
  assert.equal(await readFile(artifactPath, "utf8"), "{}\n");
  assert.equal(projectRefineRunToTaskStates(stages).states.length, 3, "root plus two logical stages");
  const preparationFailed = await runHarnessSelfCheck({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000,
    runId: "missing-manifest", runDirectory: join(f.root, "missing-manifest-run"), manifestPath: join(f.root, "does-not-exist.json"),
    currentF1: 0.8, candidateF1: 0.3, stages, artifacts: { artifactPath }, sourceKind: "current-refine-run" });
  assert.equal(preparationFailed.status, "failed");
  assert.match(preparationFailed.error!, /ENOENT/);
});

test("failed-attempt-only and contract-only seeds trigger while a clean non-regression does not", async () => {
  const f = await fixture(); const manifestPath = join(f.root, "manifest-seeds.json"); const artifactPath = join(f.root, "seed-artifact.json");
  await Promise.all([writeFile(manifestPath, "{}\n"), writeFile(artifactPath, "{}\n")]);
  const digest = createHash("sha256").update(await readFile(artifactPath)).digest("hex");
  const cleanStages = [{ stage: "skill-review", taskId: "review", provider: "test", model: "test", inputArtifacts: [], outputArtifacts: [{ path: artifactPath, sha256: digest }] }];
  const clean = await runHarnessSelfCheck({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000, runId: "clean", runDirectory: join(f.root, "clean"),
    manifestPath, currentF1: 0.5, candidateF1: 0.5, stages: cleanStages, artifacts: { artifactPath }, sourceKind: "current-refine-run", runner: seedDiagnosisRunner });
  assert.equal(clean.status, "not-triggered");

  const recoveredStages = [{ stage: "skill-review", taskId: "review-recovered", provider: "test", model: "test", inputArtifacts: [], outputArtifacts: [{ path: artifactPath, sha256: digest }],
    attempts: [{ attempt: 1, taskId: "review-attempt-1", status: "failed", error: "invalid structured output" }, { attempt: 2, taskId: "review-attempt-2", status: "completed" }] }];
  const recovered = await runHarnessSelfCheck({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000, runId: "recovered", runDirectory: join(f.root, "recovered"),
    manifestPath, currentF1: 0.5, candidateF1: 0.5, stages: recoveredStages, artifacts: { artifactPath }, sourceKind: "current-refine-run", runner: seedDiagnosisRunner });
  assert.equal(recovered.status, "triggered");
  await assertSeedGrounding(recovered, "failed-attempt");
  const recoveredTrigger = JSON.parse(await readFile(recovered.triggerPath!, "utf8"));
  assert.deepEqual(recoveredTrigger.diagnosisSeeds.map((seed: DiagnosisSeed) => seed.type), ["failed-attempt"]);
  assert.equal(recoveredTrigger.diagnosisSeeds[0].propagationPath.length, 2, "a recovered failure points through the explicit retry edge to its detection attempt");
  const statusOnly = await runHarnessSelfCheck({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000, runId: "status-only", runDirectory: join(f.root, "status-only"),
    manifestPath, currentF1: 0.5, candidateF1: 0.5, stages: [{ ...recoveredStages[0]!, taskId: "status-only-review",
      attempts: [{ attempt: 1, taskId: "status-only-attempt-1", status: "failed" }, { attempt: 2, taskId: "status-only-attempt-2", status: "completed" }] }],
    artifacts: { artifactPath }, sourceKind: "current-refine-run", runner: seedDiagnosisRunner });
  assert.equal(statusOnly.status, "triggered", "failed trace status alone remains eligible with deterministic insufficient evidence");

  const contract = await runHarnessSelfCheck({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000, runId: "contract", runDirectory: join(f.root, "contract"),
    manifestPath, currentF1: 0.5, candidateF1: 0.5, stages: [{ ...cleanStages[0]!, taskId: "bad-digest", outputArtifacts: [{ path: artifactPath, sha256: "0".repeat(64) }] }],
    artifacts: { artifactPath }, sourceKind: "current-refine-run", runner: seedDiagnosisRunner });
  assert.equal(contract.status, "triggered");
  await assertSeedGrounding(contract, "contract-violation");
  const contractTrigger = JSON.parse(await readFile(contract.triggerPath!, "utf8"));
  assert.ok(contractTrigger.diagnosisSeeds.every((seed: DiagnosisSeed) => seed.type === "contract-violation"));
});

test("diagnosis validator requires exact one-to-one seed coverage and singular endpoints", () => {
  const projection = projectRefineRunToTaskStates([{ stage: "skill-review", taskId: "review", inputArtifacts: [], outputArtifacts: [] }], "seed-validation");
  const state = projection.states.find((item) => item.taskId === "review")!;
  const evidence: EvidenceRecord[] = [{ evidenceId: "ev", kind: "validation", stateId: state.stateId, roleId: null, cardDigest: null,
    configDigests: state.configDigests, unavailableConfigKinds: state.unavailableConfigKinds, sourcePath: null, sha256: "a", relation: "observe", provenanceId: "contract-validation:v", content: "fail", truncated: false, redacted: false }];
  const seeds = buildDiagnosisSeeds({ dag: projection, evidence, validation: { schemaVersion: "1.0", valid: false,
    entries: [{ validationId: "v", check: "output", status: "fail", stateIds: [state.stateId], evidenceIds: [], observation: "fail" }] }, currentF1: 0.5, candidateF1: 0.5 });
  const seed = seeds[0]!; const finding = { id: "f", seedId: seed.seedId, trigger: { type: seed.type, stateIds: seed.stateIds, evidenceIds: seed.evidenceIds },
    symptom: "failure", occurrenceStateIds: [seed.occurrenceStateId], detectionStateIds: [seed.detectionStateId], propagationPath: seed.propagationPath,
    responsibilityCandidates: [{ category: "unknown", targetStateIds: [state.stateId], targetRoleId: null, targetCardDigest: null, targetConfigDigest: null,
      supportingEvidenceIds: seed.evidenceIds, counterEvidenceIds: [], confidence: 0.2, evidenceSufficiency: "insufficient", rationale: "insufficient" }],
    failureClass: "output_contract", severity: "medium", reproducibility: "observed", presentationGroups: ["review"], ambiguity: { status: "insufficient", explanation: "insufficient" } };
  assert.doesNotThrow(() => validateHarnessDiagnosis({ schemaVersion: "1.0", summary: "one", findings: [finding] }, projection.states, evidence, projection.edges, seeds));
  assert.throws(() => validateHarnessDiagnosis({ schemaVersion: "1.0", summary: "missing", findings: [] }, projection.states, evidence, projection.edges, seeds), /coverage must be exactly 100%/);
  assert.throws(() => validateHarnessDiagnosis({ schemaVersion: "1.0", summary: "duplicate", findings: [finding, { ...finding, id: "f2" }] }, projection.states, evidence, projection.edges, seeds), /coverage must be exactly 100%/);
  assert.throws(() => validateHarnessDiagnosis({ schemaVersion: "1.0", summary: "multi", findings: [{ ...finding, occurrenceStateIds: [state.stateId, state.stateId] }] }, projection.states, evidence, projection.edges, seeds), /exactly one occurrence/);
});

test("compact diagnosis annotations enforce raw budgets, stable compilation, exact keys, grounding, and visible numeric references", () => {
  for (const count of [10, 25]) {
    const projection = projectRefineRunToTaskStates(Array.from({ length: count }, (_, index) => ({ stage: `stage-${index + 1}`, taskId: `task-${index + 1}`,
      inputArtifacts: [], outputArtifacts: [], attempts: [{ attempt: 1, taskId: `attempt-${index + 1}`, status: "failed" }] })), `budget-${count}`);
    const failedStates = projection.states.filter((state) => state.kind === "attempt" && state.status === "failed");
    const evidence: EvidenceRecord[] = failedStates.map((state, index) => ({ evidenceId: `evidence-${index + 1}`, kind: "validation", stateId: state.stateId,
      roleId: state.roleId, cardDigest: state.cardDigest, configDigests: state.configDigests, unavailableConfigKinds: state.unavailableConfigKinds,
      sourcePath: null, sha256: `${index}`.padStart(64, "0"), relation: "observe", provenanceId: `budget:${index + 1}`,
      content: "failed", truncated: false, redacted: false }));
    const seeds = buildDiagnosisSeeds({ dag: projection, evidence, validation: { schemaVersion: "1.0", valid: true, entries: [] }, currentF1: 0.5, candidateF1: 0.6 });
    const annotations = seeds.map((seed, index) => ({ seedId: seed.seedId, symptom: count === 25 ? "s".repeat(600) : "结构化输出失败", responsibilityCandidates: [{ category: "unknown" as const,
      targetStateRefs: [projection.states.findIndex((state) => state.stateId === seed.occurrenceStateId) + 1],
      supportingEvidenceRefs: [index + 1], counterEvidenceRefs: [], evidenceSufficiency: "insufficient" as const,
      rationale: count === 25 ? "r".repeat(300) : "仅能定位失败尝试。" }],
      failureClass: "output_contract" as const, severity: "medium" as const, reproducibility: "observed" as const }));
    const compact = { schemaVersion: "1.1" as const, annotations };
    const raw = JSON.stringify(compact); const bytes = Buffer.byteLength(raw, "utf8");
    assert.ok(bytes <= 64_000, `${count}-seed worst-case merged compact output exceeded structural budget: ${bytes}`);
    assert.ok(compact.annotations.every((_, index) => index % 3 !== 0 || Buffer.byteLength(JSON.stringify({ schemaVersion: "1.1", annotations: compact.annotations.slice(index, index + 3) }), "utf8") <= 28_000), `${count}-seed batch exceeded provider output budget`);
    assert.doesNotMatch(JSON.stringify(compact), /propagationPath|occurrenceStateIds|detectionStateIds|"trigger"/);
    if (bytes <= 28_000) assert.deepEqual(parseHarnessDiagnosisAnnotationText(raw), compact);
    else assert.deepEqual(parseHarnessDiagnosisAnnotationText(JSON.stringify({ schemaVersion: "1.1", annotations: compact.annotations.slice(0, 3) })), { schemaVersion: "1.1", annotations: compact.annotations.slice(0, 3) });
    const visibility = { stateIds: new Set(projection.states.map((state) => state.stateId)), evidenceIds: new Set(evidence.map((record) => record.evidenceId)) };
    const mode = count > 3 ? "deterministic-merge" as const : "provider-batch" as const;
    const validated = validateHarnessDiagnosisAnnotations(compact, projection.states, evidence, projection.edges, seeds, visibility, mode);
    const compiled = compileHarnessDiagnosisAnnotations(validated, projection.states, evidence, projection.edges, seeds);
    assert.equal(compiled.findings.length, count); assert.ok(compiled.findings.every((finding, index) => finding.trigger.type === "failed-attempt" && finding.propagationPath[0] === seeds[index]!.occurrenceStateId));
    const reordered: any = structuredClone(compact); reordered.annotations.reverse();
    const reorderedCompiled = compileHarnessDiagnosisAnnotations(validateHarnessDiagnosisAnnotations(reordered, projection.states, evidence, projection.edges, seeds, visibility, mode), projection.states, evidence, projection.edges, seeds);
    assert.deepEqual(reorderedCompiled.findings.map((finding) => finding.seedId), seeds.map((seed) => seed.seedId));
    assert.deepEqual(Object.fromEntries(reorderedCompiled.findings.map((finding) => [finding.seedId, finding.id])), Object.fromEntries(compiled.findings.map((finding) => [finding.seedId, finding.id])));
    if (count === 10) {
      const tooManyCandidates: any = structuredClone(compact); tooManyCandidates.annotations[0].responsibilityCandidates.push(...structuredClone(tooManyCandidates.annotations[0].responsibilityCandidates), ...structuredClone(tooManyCandidates.annotations[0].responsibilityCandidates));
      assert.throws(() => validateHarnessDiagnosisAnnotations(tooManyCandidates, projection.states, evidence, projection.edges, seeds, visibility, mode), /annotation schema/);
      const unknownKey: any = structuredClone(compact); unknownKey.annotations[0].trigger = {};
      assert.throws(() => validateHarnessDiagnosisAnnotations(unknownKey, projection.states, evidence, projection.edges, seeds, visibility, mode), /annotation schema/);
      const modelConfidence: any = structuredClone(compact); modelConfidence.annotations[0].responsibilityCandidates[0].confidence = 0.9;
      assert.throws(() => validateHarnessDiagnosisAnnotations(modelConfidence, projection.states, evidence, projection.edges, seeds, visibility, mode), /output budget/);
      const unchangedTemplate: any = structuredClone(compact); unchangedTemplate.annotations[0].symptom = ""; unchangedTemplate.annotations[0].responsibilityCandidates[0].rationale = ""; unchangedTemplate.annotations[0].failureClass = "REPLACE_WITH_FAILURE_CLASS";
      assert.throws(() => validateHarnessDiagnosisAnnotations(unchangedTemplate, projection.states, evidence, projection.edges, seeds, visibility, mode), /non-empty text|classification/);
      const otherSeedFallback: any = structuredClone(compact); otherSeedFallback.annotations[0].responsibilityCandidates[0].targetStateRefs = [...compact.annotations[1]!.responsibilityCandidates[0]!.targetStateRefs]; otherSeedFallback.annotations[0].responsibilityCandidates[0].supportingEvidenceRefs = [...compact.annotations[1]!.responsibilityCandidates[0]!.supportingEvidenceRefs];
      assert.throws(() => validateHarnessDiagnosisAnnotations(otherSeedFallback, projection.states, evidence, projection.edges, seeds, visibility, mode), /exact deterministic grounding fallback/);
      const unknownCounterEvidence: any = structuredClone(compact); unknownCounterEvidence.annotations[0].responsibilityCandidates[0].counterEvidenceRefs = [1];
      assert.throws(() => validateHarnessDiagnosisAnnotations(unknownCounterEvidence, projection.states, evidence, projection.edges, seeds, visibility, mode), /exact deterministic grounding fallback/);
      const crossState: any = structuredClone(compact); crossState.annotations[0].responsibilityCandidates[0].supportingEvidenceRefs = [2];
      assert.throws(() => validateHarnessDiagnosisAnnotations(crossState, projection.states, evidence, projection.edges, seeds, visibility, mode), /not grounded/);
      const wrongType: any = structuredClone(compact); wrongType.annotations[0].responsibilityCandidates[0].targetStateRefs = ["1"];
      assert.throws(() => validateHarnessDiagnosisAnnotations(wrongType, projection.states, evidence, projection.edges, seeds, visibility, mode), /invalid or non-visible compact references/);
      const outOfRange: any = structuredClone(compact); outOfRange.annotations[0].responsibilityCandidates[0].supportingEvidenceRefs = [evidence.length + 1];
      assert.throws(() => validateHarnessDiagnosisAnnotations(outOfRange, projection.states, evidence, projection.edges, seeds, visibility, mode), /invalid or non-visible compact references/);
      const hiddenEvidence = new Set(visibility.evidenceIds); hiddenEvidence.delete(evidence[0]!.evidenceId);
      assert.throws(() => validateHarnessDiagnosisAnnotations(compact, projection.states, evidence, projection.edges, seeds, { stateIds: visibility.stateIds, evidenceIds: hiddenEvidence }, mode), /invalid or non-visible compact references/);
      const batchSeeds = seeds.slice(0, 3); const batch = { ...structuredClone(compact), annotations: structuredClone(compact.annotations.slice(0, 3)) };
      assert.doesNotThrow(() => validateHarnessDiagnosisAnnotations(batch, projection.states, evidence, projection.edges, batchSeeds, visibility));
      const missing: any = structuredClone(batch); missing.annotations.pop();
      assert.throws(() => validateHarnessDiagnosisAnnotations(missing, projection.states, evidence, projection.edges, batchSeeds, visibility), /coverage must be exactly 100%/);
      const duplicate: any = structuredClone(batch); duplicate.annotations.push(structuredClone(duplicate.annotations[0]));
      assert.throws(() => validateHarnessDiagnosisAnnotations(duplicate, projection.states, evidence, projection.edges, batchSeeds, visibility), /coverage must be exactly 100%/);
      const crossBatch: any = structuredClone(batch); crossBatch.annotations[2] = structuredClone(compact.annotations[3]);
      assert.throws(() => validateHarnessDiagnosisAnnotations(crossBatch, projection.states, evidence, projection.edges, batchSeeds, visibility), /unknown seed/);
    }
    if (count === 25) {
      const escapedWorst: any = structuredClone(compact);
      for (const annotation of escapedWorst.annotations) { annotation.symptom = "\u0000".repeat(600); annotation.responsibilityCandidates[0].rationale = "\u0000".repeat(800); }
      assert.ok(escapedWorst.annotations.every((_: unknown, index: number) => index % 3 !== 0 || Buffer.byteLength(JSON.stringify({ schemaVersion: "1.1", annotations: escapedWorst.annotations.slice(index, index + 3) }), "utf8") <= 28_000));
      assert.throws(() => validateHarnessDiagnosisAnnotations(escapedWorst, projection.states, evidence, projection.edges, seeds, visibility), /28000-byte structural budget/);
      assert.doesNotThrow(() => validateHarnessDiagnosisAnnotations(escapedWorst, projection.states, evidence, projection.edges, seeds, visibility, "deterministic-merge"));
    }
  }
  const embeddedJson = JSON.stringify({ schemaVersion: "1.1", annotations: [] });
  assert.throws(() => parseHarnessDiagnosisAnnotationText(' {"schemaVersion":"1.1"}'), /compact top-level signature/);
  assert.deepEqual(normalizeHarnessDiagnosisAnnotationText(embeddedJson).normalization, "none");
  assert.deepEqual(normalizeHarnessDiagnosisAnnotationText(`preface\n\`\`\`json\n${embeddedJson}\n\`\`\`\nend`).normalization, "json-fence");
  assert.deepEqual(normalizeHarnessDiagnosisAnnotationText(`note\n<<<HARNESS_DIAGNOSIS_START>>>\n${embeddedJson}\n<<<HARNESS_DIAGNOSIS_END>>>\ndone`).normalization, "marker-block");
  const embedded = normalizeHarnessDiagnosisAnnotationText(`分析文字不进入结果。\n${embeddedJson}\n诊断结束。`);
  assert.equal(embedded.normalization, "unique-embedded-json"); assert.deepEqual(embedded.value, JSON.parse(embeddedJson));
  assert.throws(() => normalizeHarnessDiagnosisAnnotationText('```json\n{}\n```\n```json\n{}\n```'), /unique marker\/fence/);
  assert.throws(() => normalizeHarnessDiagnosisAnnotationText('<<<HARNESS_DIAGNOSIS_START>>>\n{}'), /unique marker\/fence/);
  assert.deepEqual(normalizeHarnessDiagnosisAnnotationText(`analysis may mention {"seed":1}\n\`\`\`json\n${embeddedJson}\n\`\`\`\nend`).normalization, "json-fence");
  assert.deepEqual(normalizeHarnessDiagnosisAnnotationText(`analysis may mention [1]\n<<<HARNESS_DIAGNOSIS_START>>>\n${embeddedJson}\n<<<HARNESS_DIAGNOSIS_END>>>\nend`).normalization, "marker-block");
  assert.throws(() => normalizeHarnessDiagnosisAnnotationText(`<<<HARNESS_DIAGNOSIS_START>>>\n${embeddedJson}\n<<<HARNESS_DIAGNOSIS_END>>>\n<<<HARNESS_DIAGNOSIS_START>>>\n${embeddedJson}\n<<<HARNESS_DIAGNOSIS_END>>>`), /unique marker\/fence/);
  assert.throws(() => normalizeHarnessDiagnosisAnnotationText('{"schemaVersion":"1.1"}'), /exact compact top-level signature/);
  assert.throws(() => normalizeHarnessDiagnosisAnnotationText(`\`\`\`json\n{"schemaVersion":"1.1","summary":"x","annotations":[],"extra":true}\n\`\`\``), /exact compact top-level signature/);
  assert.throws(() => normalizeHarnessDiagnosisAnnotationText(`analysis {"metadata":true}\n${embeddedJson}`), /exactly one valid embedded JSON/);
  assert.throws(() => normalizeHarnessDiagnosisAnnotationText(`analysis []\n${embeddedJson}`), /exactly one valid embedded JSON/);
  assert.throws(() => normalizeHarnessDiagnosisAnnotationText(`${embeddedJson}\n${embeddedJson}`), /exactly one valid embedded JSON/);
  assert.throws(() => normalizeHarnessDiagnosisAnnotationText('analysis\n{"schemaVersion":"1.1","summary":"truncated","annotations":['), /incomplete top-level JSON/);
  assert.throws(() => normalizeHarnessDiagnosisAnnotationText(`${embeddedJson}\n{`), /incomplete top-level JSON/);
  assert.throws(() => normalizeHarnessDiagnosisAnnotationText(`prose { junk\n${embeddedJson}`), /incomplete top-level JSON/);
  assert.throws(() => normalizeHarnessDiagnosisAnnotationText(`{junk:${embeddedJson}}`), /malformed top-level JSON/);
  assert.throws(() => normalizeHarnessDiagnosisAnnotationText(`${embeddedJson}\n{bad}`), /malformed top-level JSON/);
  const escapedOverBudget = `{"value":"${"\\u0061".repeat(4_700)}"}`;
  assert.ok(Buffer.byteLength(escapedOverBudget, "utf8") > 28_000);
  assert.throws(() => parseHarnessDiagnosisAnnotationText(escapedOverBudget), /28000-byte limit before JSON parsing/);
  const rawOverBudget = `{"value":"${"a".repeat(34_001)}"}`;
  assert.throws(() => parseHarnessDiagnosisAnnotationText(rawOverBudget), /34000-byte wrapper limit/);
});

test("diagnosis runtime batches 16/25 frozen seeds, retries per batch, normalizes narrow wrappers, and merges global coverage", async () => {
  const f = await fixture(); const manifestPath = join(f.root, "batch-manifest.json"); await writeFile(manifestPath, "{}\n");
  const stagesFor = (count: number) => Array.from({ length: count }, (_, index) => ({ stage: `failed-stage-${index + 1}`, taskId: `failed-task-${count}-${index + 1}`,
    provider: "test", model: "test", inputArtifacts: [], outputArtifacts: [], attempts: [{ attempt: 1, taskId: `failed-attempt-${count}-${index + 1}`, status: "failed", error: "observable provider failure" }] }));
  const calls16: AgentTaskOptions[] = [];
  const output16 = await runHarnessSelfCheck({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000, runId: "batch-16",
    runDirectory: join(f.root, "batch-16"), manifestPath, currentF1: 0.5, candidateF1: 0.6, stages: stagesFor(16), artifacts: {}, sourceKind: "current-refine-run",
    runner: async (options) => {
      calls16.push(options); const valid = await seedDiagnosisRunner(options); const batchIndex = Number(options.trace!.attributes!["self_check.batch_index"]); const attempt = Number(options.trace!.attributes!["agent.attempt"]);
      const sessionId = `session-${batchIndex}-${attempt}`;
      if (batchIndex === 1 && attempt === 1) return { ...valid, stopReason: "length", sessionId };
      if (batchIndex === 1) return { ...valid, finalText: `preface\n\`\`\`json\n${valid.finalText}\n\`\`\`\nend`, sessionId };
      if (batchIndex === 2) return { ...valid, finalText: `note\n<<<HARNESS_DIAGNOSIS_START>>>\n${valid.finalText}\n<<<HARNESS_DIAGNOSIS_END>>>\ndone`, sessionId };
      return { ...valid, finalText: `analysis prose\n${valid.finalText}\nend`, sessionId };
    } });
  assert.equal(output16.status, "triggered", output16.error); assert.equal(calls16.length, 7, "six batches plus one retry");
  assert.ok(calls16.every((call) => call.trace!.inputRefs!.length === output16.diagnosisInputPaths!.length));
  assert.ok(calls16.every((call) => call.systemPrompt.includes("恰好一个 responsibilityCandidate")));
  assert.ok(calls16.every((call) =>
    call.systemPrompt.includes("digest 只证明身份，不证明因果")
    && call.systemPrompt.includes("相同配置下有成功与失败")
    && call.systemPrompt.includes("不表示实际输出含 score 字段")
    && call.systemPrompt.includes("跨 seed 证据")
    && call.systemPrompt.includes("单个 bare JSON 本身允许")
    && call.systemPrompt.includes("不得打开或重复读取")));
  assert.ok(calls16.every((call) => call.prompt.includes("EXACT TEMPLATE") && call.prompt.includes('"schemaVersion":"1.1"') && call.prompt.includes("REPLACE_WITH_FAILURE_CLASS") && call.prompt.includes('"symptom":""')));
  const diagnosisShards = await Promise.all(output16.diagnosisInputPaths!.map(async (path) => JSON.parse(await readFile(path, "utf8")) as any));
  const constraints = diagnosisShards[0].outputContract.constraints as string[];
  assert.ok(constraints.some((constraint) => constraint.includes("proves identity, not causation")));
  assert.ok(constraints.some((constraint) => constraint.includes("does not prove score fields were emitted")));
  const exposedSeeds = diagnosisShards
    .flatMap((shard) => shard.diagnosisSeeds);
  assert.equal(exposedSeeds.length, 16); assert.ok(exposedSeeds.every((seed: any) => Number.isInteger(seed.occurrenceStateRef)
    && Number.isInteger(seed.detectionStateRef) && Number.isInteger(seed.groundingStateRef) && seed.stateRefs.length > 0
    && seed.evidenceRefs.length > 0 && seed.groundingEvidenceRefs.length === 1));
  const diagnosis16 = JSON.parse(await readFile(output16.diagnosisPath!, "utf8")) as any;
  assert.equal(diagnosis16.findings.length, 16); assert.equal(diagnosis16.compactAnnotations.annotations.length, 16);
  assert.ok(diagnosis16.compactAnnotations.annotations.every((annotation: any) => !("presentationGroups" in annotation)));
  assert.ok(diagnosis16.findings.every((finding: any) => finding.presentationGroups.length === 1 && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(finding.presentationGroups[0])));
  assert.deepEqual(diagnosis16.diagnosisBatches.map((batch: any) => batch.seedIds.length), [3, 3, 3, 3, 3, 1]);
  assert.deepEqual(diagnosis16.diagnosisBatches.map((batch: any) => batch.normalization), ["json-fence", "marker-block", "unique-embedded-json", "unique-embedded-json", "unique-embedded-json", "unique-embedded-json"]);
  assert.deepEqual(diagnosis16.attempts.map((attempt: any) => attempt.status), ["failed", "completed", "completed", "completed", "completed", "completed", "completed"]);
  assert.match(diagnosis16.attempts[0].error, /truncated/);
  assert.equal(diagnosis16.attempts[1].providerSessionId, "session-1-2"); assert.equal(diagnosis16.attempts[1].batchId, "batch-01-of-06");
  assert.equal(new Set(diagnosis16.findings.map((finding: any) => finding.seedId)).size, 16);
  assert.ok(diagnosis16.compactAnnotations.annotations.every((annotation: any) => annotation.responsibilityCandidates.length === 1));
  assert.ok(diagnosis16.compactAnnotations.annotations.every((annotation: any) => Object.keys(annotation.responsibilityCandidates[0]).sort().join(",") ===
    ["category", "counterEvidenceRefs", "evidenceSufficiency", "rationale", "supportingEvidenceRefs", "targetStateRefs"].sort().join(",")));

  const calls25: AgentTaskOptions[] = [];
  const output25 = await runHarnessSelfCheck({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000, runId: "batch-25",
    runDirectory: join(f.root, "batch-25"), manifestPath, currentF1: 0.5, candidateF1: 0.6, stages: stagesFor(25), artifacts: {}, sourceKind: "current-refine-run",
    runner: async (options) => { calls25.push(options); return seedDiagnosisRunner(options); } });
  assert.equal(output25.status, "triggered", output25.error); assert.equal(calls25.length, 9);
  const diagnosis25 = JSON.parse(await readFile(output25.diagnosisPath!, "utf8")) as any;
  assert.deepEqual(diagnosis25.diagnosisBatches.map((batch: any) => batch.seedIds.length), [3, 3, 3, 3, 3, 3, 3, 3, 1]);
  assert.equal(diagnosis25.findings.length, 25); assert.equal(new Set(diagnosis25.findings.map((finding: any) => finding.seedId)).size, 25);

  let exhaustedCalls = 0;
  const exhausted = await runHarnessSelfCheck({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000, runId: "batch-exhausted",
    runDirectory: join(f.root, "batch-exhausted"), manifestPath, currentF1: 0.5, candidateF1: 0.6, stages: stagesFor(7), artifacts: {}, sourceKind: "current-refine-run",
    runner: async (options) => { exhaustedCalls += 1; return Number(options.trace!.attributes!["self_check.batch_index"]) === 1
      ? seedDiagnosisRunner(options) : result(options, "invalid unwrapped output"); } });
  assert.equal(exhausted.status, "failed"); assert.equal(exhaustedCalls, 4, "first batch completes and the second exhausts its three attempts");
  const failedAudit = JSON.parse(await readFile(join(f.root, "batch-exhausted", "harness-self-check", "failed.json"), "utf8")) as any;
  assert.equal(failedAudit.completedBatches.length, 1); assert.deepEqual(failedAudit.attempts.map((attempt: any) => attempt.status), ["completed", "failed", "failed", "failed"]);
  assert.ok(failedAudit.attempts.every((attempt: any) => attempt.batchId && Array.isArray(attempt.seedIds) && attempt.eventsPath));
});

test("deterministic presentation grouping uses Agent role but non-Agent stage", () => {
  const projection = projectRefineRunToTaskStates([
    { stage: "agent-step-a", taskId: "agent-a", provider: "p", model: "m", card: { roleId: "Unsafe Role / A", digest: "a" }, inputArtifacts: [], outputArtifacts: [] },
    { stage: "agent-step-b", taskId: "agent-b", provider: "p", model: "m", card: { roleId: "Unsafe Role / A", digest: "a" }, inputArtifacts: [], outputArtifacts: [] },
    { stage: "candidate-expert-evaluation", taskId: "deterministic", kind: "deterministic-tool", card: { roleId: "refine.workflow", digest: "d" }, inputArtifacts: [], outputArtifacts: [] },
  ], "presentation-groups");
  const targetStates = ["agent-a", "agent-b", "deterministic"].map((taskId) => projection.states.find((state) => state.taskId === taskId)!);
  for (const state of targetStates) state.status = "failed";
  const evidence: EvidenceRecord[] = targetStates.map((state, index) => ({ evidenceId: `group-evidence-${index + 1}`, kind: "validation", stateId: state.stateId,
    roleId: state.roleId, cardDigest: state.cardDigest, configDigests: state.configDigests, unavailableConfigKinds: state.unavailableConfigKinds,
    sourcePath: null, sha256: `${index + 1}`.repeat(64), relation: "observe", provenanceId: `group:${index + 1}`, content: "observed", truncated: false, redacted: false }));
  const seeds: DiagnosisSeed[] = targetStates.map((state, index) => ({ seedId: `group-seed-${index + 1}`, type: "contract-violation", stateIds: [state.stateId], evidenceIds: [evidence[index]!.evidenceId],
    occurrenceStateId: state.stateId, detectionStateId: state.stateId, propagationPath: [state.stateId], expectedCoverage: { minimumFindings: 1, maximumFindings: 1, referenceMode: "exactly-once" } }));
  const annotations = seeds.map((seed, index) => ({ seedId: seed.seedId, symptom: "observed", responsibilityCandidates: [{ category: index === 0 ? "unknown" as const : "orchestration" as const,
    targetStateRefs: [projection.states.indexOf(targetStates[index]!) + 1], supportingEvidenceRefs: [index + 1], counterEvidenceRefs: [],
    evidenceSufficiency: (index === 0 ? "insufficient" : index === 1 ? "partial" : "sufficient") as "insufficient" | "partial" | "sufficient", rationale: "observable evidence" }], failureClass: "provider" as const, severity: "medium" as const,
    reproducibility: "observed" as const }));
  const compiled = compileHarnessDiagnosisAnnotations({ schemaVersion: "1.1", annotations }, projection.states, evidence, projection.edges, seeds);
  assert.deepEqual(compiled.findings.map((finding) => finding.presentationGroups[0]), ["unsafe-role-a", "unsafe-role-a", "candidate-expert-evaluation"]);
  assert.deepEqual(compiled.findings.map((finding) => finding.ambiguity.status), ["insufficient", "ambiguous", "unambiguous"]);
});

test("frozen-trace capability experiment reports seed/reference/input coverage and three-run stability without a quality claim", async () => {
  const stateId = "state:review"; const evidenceId = "evidence:review"; const seed: DiagnosisSeed = { seedId: "seed:review", type: "failed-attempt",
    stateIds: [stateId], evidenceIds: [evidenceId], occurrenceStateId: stateId, detectionStateId: stateId, propagationPath: [stateId],
    expectedCoverage: { minimumFindings: 1, maximumFindings: 1, referenceMode: "exactly-once" } };
  const diagnosis: any = { schemaVersion: "1.0", summary: "diagnosis", findings: [{ id: "finding", seedId: seed.seedId,
    trigger: { type: seed.type, stateIds: seed.stateIds, evidenceIds: seed.evidenceIds }, symptom: "failure", occurrenceStateIds: [stateId], detectionStateIds: [stateId], propagationPath: [stateId],
    responsibilityCandidates: [{ category: "unknown", targetStateIds: [stateId], targetRoleId: null, targetCardDigest: null, targetConfigDigest: null,
      supportingEvidenceIds: [evidenceId], counterEvidenceIds: [], confidence: 0.2, evidenceSufficiency: "insufficient", rationale: "insufficient" }], failureClass: "provider",
    severity: "medium", reproducibility: "observed", presentationGroups: ["review"], ambiguity: { status: "insufficient", explanation: "insufficient" } }] };
  const frozenInput = { sourceRunId: "source-run", traceDigest: "frozen", shardSourceFingerprint: "source-shards-v1", seeds: [seed], allowedStateIds: [stateId], allowedEvidenceIds: [evidenceId], allowedEdgePairs: [],
    requiredCausalEvidenceIds: [evidenceId], requiredContractValidationIds: ["validation-1"],
    stateIdentities: [{ stateId, roleId: null, cardDigest: null, configDigests: { prompt: null, skill: null, schema: null, tool: null, model: null } }],
    evidenceOwners: [{ evidenceId, stateId }], attributionOracle: [{ seedId: seed.seedId, acceptedTargets: [{ category: "unknown", targetStateId: stateId, targetRoleId: null, targetCardDigest: null, targetConfigDigest: null }] }] };
  const candidate: DiagnosisCapabilityRun = { runId: "candidate", ...frozenInput, frozenInputDigest: computeDiagnosisFrozenInputDigest(frozenInput), diagnosis,
    requiredCausalEvidenceIds: [evidenceId], includedEvidenceIds: [evidenceId], requiredContractValidationIds: ["validation-1"], includedContractValidationIds: ["validation-1"],
    expectedShardPaths: ["A.json", "B.json"], readShardPaths: ["a.json", "b.json"] };
  const baseline: DiagnosisCapabilityRun = { ...candidate, runId: "baseline", diagnosis: null, includedEvidenceIds: [], includedContractValidationIds: [], readShardPaths: [] };
  const report = compareDiagnosisCapabilityExperiment({ frozenTraceDigest: "frozen", baseline, candidateRuns: [candidate, { ...candidate, runId: "candidate-2" }, { ...candidate, runId: "candidate-3" }] });
  assert.equal(report.baseline.seedCoverage.value, 0); assert.equal(report.candidateRuns[0]!.seedCoverage.value, 1); assert.equal(report.candidateRuns[0]!.referenceValidity, 1);
  assert.equal(report.candidateRuns[0]!.causalChainEvidenceInclusion.value, 1); assert.equal(report.candidateRuns[0]!.contractInclusion.value, 1); assert.equal(report.candidateRuns[0]!.shardReadCompleteness.value, 1);
  assert.equal(report.threeRunStability, 1); assert.equal(report.claimScope, "diagnosis-capability-and-self-evolution-readiness"); assert.match(report.guardrail, /does not claim/);
  const notApplicable = evaluateDiagnosisCapabilityRun({ ...candidate, requiredCausalEvidenceIds: [], requiredContractValidationIds: [], expectedShardPaths: [] });
  assert.equal(notApplicable.causalChainEvidenceInclusion.status, "notApplicable"); assert.equal(notApplicable.contractInclusion.status, "notApplicable"); assert.equal(notApplicable.shardReadCompleteness.status, "notApplicable");
  assert.equal(evaluateDiagnosisCapabilityRun({ ...candidate, seeds: [], diagnosis: null }).seedCoverage.status, "notApplicable");
  const splitState = "state:split"; const splitDiagnosis: any = structuredClone(diagnosis); splitDiagnosis.findings[0].responsibilityCandidates = [{ category: "agent_card",
    targetStateIds: [stateId, splitState], targetRoleId: "role-a", targetCardDigest: "card-b", targetConfigDigest: null,
    supportingEvidenceIds: [evidenceId], counterEvidenceIds: [], confidence: 0.9, evidenceSufficiency: "sufficient", rationale: "split" }];
  const splitMetrics = evaluateDiagnosisCapabilityRun({ ...candidate, diagnosis: splitDiagnosis,
    stateIdentities: [{ stateId, roleId: null, cardDigest: "card-b", configDigests: candidate.stateIdentities[0]!.configDigests },
      { stateId: splitState, roleId: "role-a", cardDigest: null, configDigests: candidate.stateIdentities[0]!.configDigests }],
    attributionOracle: [{ seedId: seed.seedId, acceptedTargets: [{ category: "unknown", targetStateId: stateId, targetRoleId: null, targetCardDigest: null, targetConfigDigest: null }] }] });
  assert.equal(splitMetrics.groundedLocalizationOrAbstention, 0); assert.equal(splitMetrics.wrongAttributionRate.value, 1);
  const extraTargetDiagnosis: any = structuredClone(diagnosis); extraTargetDiagnosis.findings[0].responsibilityCandidates[0].targetStateIds = [stateId, splitState];
  extraTargetDiagnosis.findings[0].responsibilityCandidates[0].supportingEvidenceIds = [evidenceId, "evidence:split"];
  const extraTargetMetrics = evaluateDiagnosisCapabilityRun({ ...candidate, diagnosis: extraTargetDiagnosis,
    allowedStateIds: [stateId, splitState], allowedEvidenceIds: [evidenceId, "evidence:split"],
    stateIdentities: [...candidate.stateIdentities, { stateId: splitState, roleId: null, cardDigest: null, configDigests: candidate.stateIdentities[0]!.configDigests }],
    evidenceOwners: [...candidate.evidenceOwners, { evidenceId: "evidence:split", stateId: splitState }] });
  assert.equal(extraTargetMetrics.groundedLocalizationOrAbstention, 1); assert.equal(extraTargetMetrics.wrongAttributionRate.value, 1,
    "an extra grounded but non-oracle target cannot hide beside the accepted target");
  const unstable = compareDiagnosisCapabilityExperiment({ frozenTraceDigest: "frozen", baseline, candidateRuns: [candidate, { ...candidate, runId: "candidate-2" }, { ...candidate, runId: "candidate-split", diagnosis: splitDiagnosis }] });
  assert.equal(unstable.threeRunStability, 2 / 3, "responsibility identity/evidence drift changes the stability signature");
  assert.throws(() => compareDiagnosisCapabilityExperiment({ frozenTraceDigest: "frozen", baseline, candidateRuns: [candidate, { ...candidate, runId: "mixed", traceDigest: "other" }, candidate] }), /MIXED_TRACE/);
  const changedAllowed = { ...candidate, runId: "changed-input", allowedStateIds: [...candidate.allowedStateIds, "state:extra"] };
  assert.throws(() => compareDiagnosisCapabilityExperiment({ frozenTraceDigest: "frozen", baseline, candidateRuns: [candidate, changedAllowed, candidate] }), /MIXED_TRACE/);
  const provenance = await readSourceProvenance(process.cwd(), "test-harness");
  assert.equal(provenance.availability, "available"); assert.match(provenance.gitCommit!, /^[a-f0-9]{40}$/); assert.equal(typeof provenance.gitDirty, "boolean");
  if (provenance.gitDirty) assert.match(provenance.gitDiffDigest!, /^[a-f0-9]{64}$/);
});

test("diagnosis validator rejects Agent/Card attribution that is not owned by one exact cited state identity", () => {
  const projection = projectRefineRunToTaskStates([{ stage: "skill-review", taskId: "review", provider: "test", model: "test",
    card: { roleId: "refine.review", digest: "review-card" }, inputArtifacts: [], outputArtifacts: [] },
  { stage: "candidate-skill-compilation", taskId: "optimizer", provider: "test", model: "test",
    card: { roleId: "refine.policy-optimizer", digest: "optimizer-card" }, inputArtifacts: [], outputArtifacts: [] }], "run");
  const review = projection.states.find((state) => state.taskId === "review")!;
  const evidence: EvidenceRecord[] = [{ evidenceId: "evidence-1", kind: "validation", stateId: review.stateId, roleId: review.roleId,
    cardDigest: review.cardDigest, configDigests: review.configDigests, unavailableConfigKinds: review.unavailableConfigKinds, sourcePath: null, sha256: "a".repeat(64), relation: "observe",
    provenanceId: "test:validation", content: "invalid JSON", truncated: false, redacted: false }];
  const seed: DiagnosisSeed = { seedId: "seed:test", type: "contract-violation", stateIds: [review.stateId], evidenceIds: ["evidence-1"],
    occurrenceStateId: review.stateId, detectionStateId: review.stateId, propagationPath: [review.stateId],
    expectedCoverage: { minimumFindings: 1, maximumFindings: 1, referenceMode: "exactly-once" } };
  const finding = { schemaVersion: "1.0", summary: "failure", findings: [{ id: "f1", seedId: seed.seedId,
    trigger: { type: "contract-violation", stateIds: [review.stateId], evidenceIds: ["evidence-1"] }, symptom: "invalid JSON",
    occurrenceStateIds: [review.stateId], detectionStateIds: [review.stateId], propagationPath: [review.stateId],
    responsibilityCandidates: [{ category: "agent_card", targetStateIds: [review.stateId], targetRoleId: "refine.policy-optimizer",
      targetCardDigest: "review-card", targetConfigDigest: null, supportingEvidenceIds: ["evidence-1"], counterEvidenceIds: [],
      confidence: 0.9, evidenceSufficiency: "sufficient", rationale: "wrong role" }], failureClass: "output_contract",
    severity: "medium", reproducibility: "observed", presentationGroups: ["review"], ambiguity: { status: "unambiguous", explanation: "claimed" } }] };
  assert.throws(() => validateHarnessDiagnosis(finding, projection.states, evidence, projection.edges, [seed]), /identity tuple.*exact target state/);
  const remediation: any = structuredClone(finding);
  remediation.findings[0]!.trigger.type = "contract-violation";
  remediation.findings[0]!.responsibilityCandidates = [{ category: "unknown", targetStateIds: [review.stateId], targetRoleId: null,
    targetCardDigest: null, targetConfigDigest: null, supportingEvidenceIds: ["evidence-1"], counterEvidenceIds: [], confidence: 0.2,
    evidenceSufficiency: "insufficient", rationale: "Retry failed because use 阶段需要的输入缺失，日志中提到修改。" }];
  remediation.findings[0]!.ambiguity = { status: "insufficient", explanation: "Evidence only identifies the observed state." };
  assert.doesNotThrow(() => validateHarnessDiagnosis(remediation, projection.states, evidence, projection.edges, [seed]));
  const optimizer = projection.states.find((state) => state.taskId === "optimizer")!;
  const extraUngrounded: any = structuredClone(remediation);
  extraUngrounded.findings[0].responsibilityCandidates[0].targetStateIds = [review.stateId, optimizer.stateId];
  assert.throws(() => validateHarnessDiagnosis(extraUngrounded, projection.states, evidence, projection.edges, [seed]), /Every responsibility target identity tuple.*exact target state/,
    "EXTRA_UNGROUNDED_TARGET must not be accepted merely because another target is grounded");
  const splitEvidence: EvidenceRecord = { ...evidence[0]!, evidenceId: "evidence-optimizer", stateId: optimizer.stateId, roleId: optimizer.roleId, cardDigest: optimizer.cardDigest };
  const splitSeed: DiagnosisSeed = { ...seed, seedId: "seed:split", stateIds: [optimizer.stateId], evidenceIds: [splitEvidence.evidenceId], occurrenceStateId: optimizer.stateId, detectionStateId: optimizer.stateId, propagationPath: [optimizer.stateId] };
  const split: any = structuredClone(remediation); split.findings[0].seedId = splitSeed.seedId; split.findings[0].trigger = { type: splitSeed.type, stateIds: splitSeed.stateIds, evidenceIds: splitSeed.evidenceIds }; split.findings[0].occurrenceStateIds = [optimizer.stateId]; split.findings[0].detectionStateIds = [optimizer.stateId]; split.findings[0].propagationPath = [optimizer.stateId];
  split.findings[0].responsibilityCandidates = [{ category: "agent_card", targetStateIds: [review.stateId, optimizer.stateId], targetRoleId: review.roleId,
    targetCardDigest: optimizer.cardDigest, targetConfigDigest: null, supportingEvidenceIds: [splitEvidence.evidenceId], counterEvidenceIds: [], confidence: 0.9,
    evidenceSufficiency: "sufficient", rationale: "cross-state splice" }]; split.findings[0].ambiguity = { status: "unambiguous", explanation: "claimed" };
  assert.throws(() => validateHarnessDiagnosis(split, projection.states, [...evidence, splitEvidence], projection.edges, [splitSeed]), /identity tuple.*exact target state/);
  remediation.findings[0]!.patchProposal = "extra field";
  assert.throws(() => validateHarnessDiagnosis(remediation, projection.states, evidence, projection.edges, [seed]), /identity or seed reference is invalid/);
});

test("task-state projection expands Expert subtasks and failed retry attempts", () => {
  const projection = projectRefineRunToTaskStates([{
    stage: "draft-expert-evaluation", taskId: "expert-stage", kind: "deterministic-tool", inputArtifacts: [], outputArtifacts: [],
    subtasks: [{ stage: "current-recall-match-1", taskId: "match-success", parentTaskId: "expert-stage", provider: "test", model: "test",
      card: { roleId: "refine.aspect-matcher" }, inputArtifacts: [], outputArtifacts: [],
      attempts: [{ attempt: 1, taskId: "match-failed", eventsPath: "failed.events.jsonl", status: "failed", error: "invalid JSON" }, { attempt: 2, taskId: "match-success", status: "completed" }] }],
  }]);
  const states = projection.states;
  assert.equal(states[0]!.kind, "root");
  const expert = states.find((state) => state.taskId === "expert-stage")!;
  const logical = states.find((state) => state.taskId === "match-success" && state.kind === "logical_task")!;
  const failed = states.find((state) => state.taskId === "match-failed")!;
  const completed = states.find((state) => state.kind === "attempt" && state.status === "completed")!;
  assert.equal(logical.parentStateId, expert.stateId);
  assert.equal(failed.parentStateId, logical.stateId);
  assert.equal(completed.parentStateId, logical.stateId, "retry attempts are siblings under their logical task");
  assert.equal(completed.retryOfStateId, failed.stateId);
  assert.equal(logical.status, "recovered", "a failed attempt followed by success is explicit at the logical task");
  assert.equal(expert.status, "mixed", "the deterministic parent exposes a recovered child instead of claiming a wholly clean completion");
  assert.equal(states[0]!.status, "mixed", "a recovered failed attempt makes the run mixed, not failed");
  assert.equal(failed.eventPath, "failed.events.jsonl");
  assert.equal(logical.parallelGroupId, "current-directional-matcher-parallel");
  assert.ok(projection.edges.some((edge) => edge.type === "retry" && edge.fromStateId === failed.stateId && edge.toStateId === completed.stateId));
  assert.ok(projection.edges.some((edge) => edge.type === "handoff" && edge.fromStateId === logical.stateId && edge.toStateId === expert.stateId), "subtask completes before reducer");
  assert.equal(projection.edges.some((edge) => edge.fromStateId === expert.stateId && edge.toStateId === logical.stateId), false);
  assert.ok(projection.edges.some((edge) => edge.fromStateId === states[0]!.stateId && edge.toStateId === failed.stateId), "entry reaches attempt 1 without bypassing it");
});

test("data edges use the finest subtask producer even when reducer repeats the digest", () => {
  const digest = "d".repeat(64); const artifact = { path: "shared.json", sha256: digest };
  const projection = projectRefineRunToTaskStates([{ stage: "candidate-expert-evaluation", taskId: "expert", kind: "deterministic-tool", inputArtifacts: [], outputArtifacts: [artifact],
    subtasks: [{ stage: "candidate-recall-match-1", taskId: "match", parentTaskId: "expert", provider: "test", model: "test", card: { roleId: "refine.aspect-matcher" }, inputArtifacts: [], outputArtifacts: [artifact] }] },
  { stage: "promotion-decision", taskId: "decision", kind: "deterministic-tool", inputArtifacts: [artifact], outputArtifacts: [] }], "producer-run");
  const producer = projection.states.find((state) => state.taskId === "match" && state.kind === "logical_task")!;
  const consumer = projection.states.find((state) => state.taskId === "decision")!;
  assert.ok(projection.edges.some((edge) => edge.type === "data" && edge.artifactDigest === digest && edge.fromStateId === producer.stateId && edge.toStateId === consumer.stateId));
});

test("projected tool config digest comes from the actual stage allowlist, not Card metadata", () => {
  const projection = projectRefineRunToTaskStates([{ stage: "skill-review", taskId: "review-tools", provider: "test", model: "test",
    card: { roleId: "refine.review", digest: "card", toolDigest: "card-tool-digest" } as any, toolAllowlist: ["read"], inputArtifacts: [], outputArtifacts: [] }]);
  const state = projection.states.find((item) => item.taskId === "review-tools")!;
  assert.equal(state.configDigests.tool, createHash("sha256").update(JSON.stringify(["read"])).digest("hex"));
  assert.notEqual(state.configDigests.tool, "card-tool-digest");
});

test("observable event projection drops private reasoning and redacts common credential forms", async () => {
  const f = await fixture(); const runDirectory = join(f.root, "event-safety"); await mkdir(runDirectory);
  const manifestPath = join(runDirectory, "manifest.json"); const artifactPath = join(runDirectory, "expert.json"); const eventsPath = join(runDirectory, "expert.events.jsonl");
  const eventLines = [
    JSON.stringify({ type: "message_end", providerRaw: "PRIVATE_PROVIDER_RAW", message: { role: "assistant", content: [
      { type: "thinking", thinking: "HIDDEN_COT" }, { type: "reasoning", text: "PRIVATE_REASONING" },
      { type: "text", text: "visible api_key=deepseek-secret-123456 Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature sk-abcdefghijklmnop" },
      { type: "toolCall", name: "read", arguments: { path: "safe.md", token: "tool-secret-value" } },
    ] } }),
    ...Array.from({ length: 120 }, (_, index) => JSON.stringify({ type: "reasoning", encrypted_content: `HIDDEN_PROVIDER_REASONING_${index}` })),
    JSON.stringify({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "PUBLIC_TOOL_RESULT" }] } }),
    JSON.stringify({ type: "error", message: "PUBLIC_TERMINAL_ERROR" }),
  ];
  await Promise.all([writeFile(manifestPath, "{}\n"), writeFile(artifactPath, "{\"f1\":0.2}\n"), writeFile(eventsPath, `${eventLines.join("\n")}\n`)]);
  const digest = createHash("sha256").update(await readFile(artifactPath)).digest("hex");
  const output = await runHarnessSelfCheck({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000, runId: "safe-events", runDirectory,
    manifestPath, currentF1: 0.8, candidateF1: 0.2, sourceKind: "historical-replay", artifacts: { artifactPath },
    stages: [{ stage: "candidate-expert-evaluation", taskId: "candidate", kind: "deterministic-tool", inputArtifacts: [], outputArtifacts: [{ path: artifactPath, sha256: digest }], eventsPath,
      attempts: [{ attempt: 1, taskId: "candidate-attempt", status: "failed", error: "observable failure", eventsPath }] }],
    runner: async () => { throw new Error("stop after projection"); } });
  const projectionText = await readFile(output.taskStatePath!, "utf8");
  assert.match(projectionText, /visible/);
  assert.match(projectionText, /PUBLIC_TOOL_RESULT/);
  assert.match(projectionText, /PUBLIC_TERMINAL_ERROR/);
  assert.doesNotMatch(projectionText, /HIDDEN_COT|PRIVATE_REASONING|PRIVATE_PROVIDER_RAW|HIDDEN_PROVIDER_REASONING|deepseek-secret-123456|tool-secret-value|sk-abcdefghijklmnop/);
  const projection = JSON.parse(projectionText) as { sourceKind: string; observableEvidencePolicy: { secretHandling: string; budget: { maxBytes: number; includedBytes: number }; eventProjectionStats: Array<{ scannedLines: number; selectedRecords: number; droppedRecords: number }> }; evidenceRecords: Array<{ kind: string; stateId: string; provenanceId: string }> };
  assert.equal(projection.sourceKind, "historical-replay");
  assert.equal(projection.observableEvidencePolicy.secretHandling, "best-effort-pattern-redaction");
  assert.ok(projection.observableEvidencePolicy.budget.includedBytes <= projection.observableEvidencePolicy.budget.maxBytes);
  assert.equal(projection.observableEvidencePolicy.eventProjectionStats[0]!.scannedLines, 123);
  assert.ok(projection.observableEvidencePolicy.eventProjectionStats[0]!.selectedRecords > 0);
  assert.ok(projection.evidenceRecords.some((record) => ["message", "tool", "event"].includes(record.kind) && record.stateId.includes("candidate:attempt-1")));
  assert.ok(projection.evidenceRecords.some((record) => record.kind === "validation" && record.stateId.includes("candidate:attempt-1") && !record.provenanceId.startsWith("contract-validation:")));
});

test("runtime source kind is asserted and large traces use read-safe deterministic diagnosis shards", async () => {
  const f = await fixture(); const runDirectory = join(f.root, "compact"); await mkdir(runDirectory); const manifestPath = join(runDirectory, "manifest.json"); await writeFile(manifestPath, "{}\n");
  const subtasks = Array.from({ length: 320 }, (_, index) => ({ stage: `current-recall-match-${index + 1}`, taskId: `match-${index + 1}`, parentTaskId: "expert", provider: "test", model: "test", card: { roleId: "refine.aspect-matcher", digest: "card" }, inputArtifacts: [], outputArtifacts: [] }));
  const options = { cwd: f.root, provider: "test", model: "test", timeoutMs: 1000, runId: "compact", runDirectory, manifestPath,
    currentF1: 0.8, candidateF1: 0.2, artifacts: {}, stages: [{ stage: "candidate-expert-evaluation", taskId: "expert", kind: "deterministic-tool", inputArtifacts: [], outputArtifacts: [], subtasks }, { stage: "promotion-decision", taskId: "decision", kind: "deterministic-tool", inputArtifacts: [], outputArtifacts: [] }], runner: async () => { throw new Error("projection only"); } };
  await assert.rejects(runHarnessSelfCheck({ ...options, sourceKind: "invalid" as any }), /sourceKind is invalid/);
  const output = await runHarnessSelfCheck({ ...options, sourceKind: "historical-replay" });
  const audit = JSON.parse(await readFile(output.taskStatePath!, "utf8")) as { projectionBudget: { droppedStates: number }; taskStateDag: { states: unknown[]; edges: unknown[] } };
  assert.equal(audit.projectionBudget.droppedStates, 0, "audit projection retains the complete DAG");
  assert.equal(audit.taskStateDag.states.length, 323);
  const shards = await Promise.all(output.diagnosisInputPaths!.map(async (path) => { const bytes = await readFile(path); assert.ok(bytes.length <= 45_000); return JSON.parse(bytes.toString()); }));
  assert.equal(output.diagnosisInputBytes, (await Promise.all(output.diagnosisInputPaths!.map((path) => readFile(path)))).reduce((sum, value) => sum + value.length, 0));
  assert.equal(shards[0]!.budget.droppedStates, 0);
  assert.equal(shards[0]!.budget.includedStates, shards[0]!.budget.rawStates);
  assert.equal(decodeCompactStates(shards).length, audit.taskStateDag.states.length);
  assert.equal(shards.flatMap((shard) => shard.taskStateDag.edgeTuples).length, audit.taskStateDag.edges.length);
  assert.equal(shards[0]!.budget.parallelGroupSummaries[0]!.memberCount, 320);
  const repeat = await runHarnessSelfCheck({ ...options, runDirectory: join(f.root, "compact-repeat"), sourceKind: "historical-replay" });
  const firstBytes = await Promise.all(output.diagnosisInputPaths!.map((path) => readFile(path, "utf8")));
  const repeatBytes = await Promise.all(repeat.diagnosisInputPaths!.map((path) => readFile(path, "utf8")));
  assert.deepEqual(repeatBytes, firstBytes, "the same frozen source produces byte-identical compact shards");
  const duplicateRead = await runHarnessSelfCheck({ ...options, runId: "duplicate-read", runDirectory: join(f.root, "duplicate-read"), sourceKind: "historical-replay",
    runner: async (runnerOptions) => { const valid = await seedDiagnosisRunner(runnerOptions); const inputs = runnerOptions.trace!.inputRefs!; return { ...valid, readPaths: [inputs[0]!, inputs[0]!, ...inputs.slice(2)] }; } });
  assert.equal(duplicateRead.status, "failed");
  assert.match(duplicateRead.error!, /read exactly every read-safe diagnosis input shard once/);
});

test("read-safe shards preserve the observable Refine causal chain, artifact summaries, and passing counter-contracts", async () => {
  const f = await fixture(); const runDirectory = join(f.root, "causal-chain"); await mkdir(runDirectory); const manifestPath = join(runDirectory, "manifest.json"); await writeFile(manifestPath, "{}\n");
  const names = ["skill-review", "candidate-skill-compilation", "candidate-draft-generation", "current-document-aspect-extraction", "current-recall-match-1",
    "current-alignment-1-content", "draft-expert-evaluation", "candidate-document-aspect-extraction", "candidate-recall-match-1", "candidate-alignment-1-content",
    "candidate-expert-evaluation", "promotion-decision"];
  const paths: string[] = []; const digests: string[] = [];
  for (const [index, name] of names.entries()) { const path = join(runDirectory, `${index}-${name}.json`); await writeFile(path, JSON.stringify({ stage: name })); paths.push(path); digests.push(createHash("sha256").update(await readFile(path)).digest("hex")); }
  const stages = names.map((stage, index) => ({ stage, taskId: `task-${index}`, ...(stage.includes("expert-evaluation") || stage === "promotion-decision" ? { kind: "deterministic-tool" } : {}),
    provider: "test", model: "test", card: { roleId: stage, digest: `card-${index}`, embeddedSkill: { id: stage, version: "v1" } }, toolAllowlist: ["read"],
    inputArtifacts: index === 0 ? [] : [{ path: paths[index - 1]!, sha256: digests[index - 1]! }], outputArtifacts: [{ path: paths[index]!, sha256: digests[index]! }] }));
  const unrelatedPath = join(runDirectory, "unrelated-cleanup.json"); await writeFile(unrelatedPath, "{\"unrelated\":true}\n");
  const unrelatedDigest = createHash("sha256").update(await readFile(unrelatedPath)).digest("hex");
  const allStages = [...stages, { stage: "legacy-cleanup", taskId: "unrelated-cleanup", provider: "test", model: "test", card: { roleId: "legacy-cleanup", digest: "unrelated-card", embeddedSkill: { id: "legacy", version: "v1" } }, toolAllowlist: ["read"], inputArtifacts: [], outputArtifacts: [{ path: unrelatedPath, sha256: unrelatedDigest }] }];
  const output = await runHarnessSelfCheck({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000, runId: "causal", runDirectory, manifestPath,
    currentF1: 0.8, candidateF1: 0.7, stages: allStages, artifacts: { ...Object.fromEntries(paths.map((path, index) => [`artifact${index}`, path])), unrelatedPath }, sourceKind: "current-refine-run", runner: async () => { throw new Error("projection only"); } });
  const shards = await Promise.all(output.diagnosisInputPaths!.map((path) => readFile(path, "utf8").then((text) => JSON.parse(text))));
  const shardStages = new Set(decodeCompactStates(shards).map((state) => state.stage));
  for (const name of names) assert.ok(shardStages.has(name), `missing causal stage ${name}`);
  const evidence = decodeCompactEvidence(shards); const contracts = decodeCompactContracts(shards);
  const passSummaries = decodeCompactPassSummaries(shards);
  assert.ok(evidence.filter((record: any) => record.kind === "artifact").length >= names.length);
  const unrelatedStateId = decodeCompactStates(shards).find((state) => state.stage === "legacy-cleanup")!.stateId;
  assert.equal(evidence.some((record) => record.stateId === unrelatedStateId), false, "ordinary evidence outside seeds and the designated causal chain is omitted from model input");
  assert.ok(passSummaries.length > 0, "passing contracts are compact deterministic counter-evidence summaries");
  assert.ok(contracts.every((entry: any) => entry.status !== "pass"));
  assert.equal(shards[0]!.budget.evidenceCoverage.seedRequiredIncluded, shards[0]!.budget.evidenceCoverage.seedRequired);
  assert.equal(shards[0]!.budget.evidenceCoverage.causalArtifactRecordsIncluded, shards[0]!.budget.evidenceCoverage.causalArtifactRecords);
  assert.ok(shards[0]!.budget.summarizedPassingContractEntries > 0);
  assert.ok(passSummaries.every((entry: any) => entry.status === "pass" && entry.validationEntryCount >= 1));
  assert.ok(shards.every((shard) => Buffer.byteLength(JSON.stringify(shard)) <= 45_000));
});

test("historical real-manifest projection preserves full audit data and uses compact bounded diagnosis shards when fixture is available", async (t) => {
  const manifestPath = process.env.REFINE_HISTORICAL_EXPERT_MANIFEST;
  if (!manifestPath) { t.skip("set REFINE_HISTORICAL_EXPERT_MANIFEST to opt into the private historical fixture"); return; }
  let manifest: any;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch { t.skip("historical validation manifest is not available on this host"); return; }
  const f = await fixture(); const runnerReadSets: string[][] = [];
  const output = await runHarnessSelfCheck({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000,
    runId: manifest.runId, runDirectory: join(f.root, "real-manifest-projection"), manifestPath,
    currentF1: 0.5537459283387622, candidateF1: 0.7058823529411765,
    stages: manifest.stages, artifacts: manifest.artifacts, sourceKind: "historical-replay",
    runner: async (options) => { runnerReadSets.push(options.trace!.inputRefs!); throw new Error("stub runner reached"); } });
  assert.equal(runnerReadSets.length, 3, "projection reached the runner after freezing its read-safe inputs");
  const taskStateBytes = await readFile(output.taskStatePath!); const contractBytes = await readFile(output.contractValidationPath!);
  assert.ok(taskStateBytes.length > 45_000, "the complete audit projection is intentionally not a model input");
  assert.ok(contractBytes.length > 0);
  assert.ok(output.diagnosisInputPaths!.length >= 1);
  const shards = await Promise.all(output.diagnosisInputPaths!.map(async (path) => { const bytes = await readFile(path); assert.ok(bytes.length <= 45_000); return JSON.parse(bytes.toString()); }));
  assert.ok(runnerReadSets.every((paths) => JSON.stringify(paths) === JSON.stringify(output.diagnosisInputPaths)));
  const projection = JSON.parse(taskStateBytes.toString()) as { taskStateDag: { states: Array<{ stateId: string; kind: string; status: string }> }; evidenceRecords: Array<{ stateId: string; kind: string; provenanceId: string }> };
  assert.equal(projection.taskStateDag.states.length, 291);
  assert.equal(decodeCompactStates(shards).length, 291, "all real-run states survive compact tuple encoding");
  assert.equal(shards.flatMap((shard) => shard.taskStateDag.edgeTuples).length, 439, "all real-run edges survive compact tuple encoding");
  const failedAttemptIds = new Set(projection.taskStateDag.states.filter((state) => state.kind === "attempt" && state.status === "failed").map((state) => state.stateId));
  assert.equal(failedAttemptIds.size, 25);
  const diagnosisSeeds = shards.flatMap((shard) => shard.diagnosisSeeds ?? []) as DiagnosisSeed[];
  assert.equal(diagnosisSeeds.length, 25);
  assert.ok(diagnosisSeeds.every((seed) => seed.type === "failed-attempt"));
  assert.equal(diagnosisSeeds.some((seed) => seed.type === "candidate-expert-f1-regression"), false);
  assert.ok(projection.evidenceRecords.some((record) => failedAttemptIds.has(record.stateId) && record.kind === "validation" && !record.provenanceId.startsWith("contract-validation:")));
  assert.ok(projection.evidenceRecords.some((record) => failedAttemptIds.has(record.stateId) && ["message", "tool", "event"].includes(record.kind)));
  const diagnosisEvidence = decodeCompactEvidence(shards);
  const diagnosisContracts = decodeCompactContracts(shards);
  const passSummaries = decodeCompactPassSummaries(shards);
  const stageByState = new Map(projection.taskStateDag.states.map((state: any) => [state.stateId, state.stage]));
  for (const key of ["currentDocumentAspectSetPath", "candidateDocumentAspectSetPath"] as const) {
    assert.ok(diagnosisEvidence.some((record) => record.kind === "artifact" && record.relation === "produce" && record.sourcePath?.toLowerCase() === String(manifest.artifacts[key]).toLowerCase()),
      `${key} must retain its producing artifact Evidence`);
  }
  for (const side of ["current", "candidate"] as const) {
    assert.ok(diagnosisEvidence.some((record) => record.kind === "artifact" && record.relation === "produce" && new RegExp(`^${side}-(?:recall|precision)-match-\\d+$`).test(String(stageByState.get(record.stateId)))), `${side} matcher artifact Evidence missing`);
    assert.ok(diagnosisEvidence.some((record) => record.kind === "artifact" && record.relation === "produce" && new RegExp(`^${side}-alignment-\\d+-(?:content|style)$`).test(String(stageByState.get(record.stateId)))), `${side} alignment artifact Evidence missing`);
  }
  assert.ok(diagnosisEvidence.some((record) => record.kind === "artifact" && record.relation === "aggregate" && stageByState.get(record.stateId) === "draft-expert-evaluation"), "current reducer aggregate Evidence missing");
  assert.ok(diagnosisEvidence.some((record) => record.kind === "artifact" && record.relation === "aggregate" && stageByState.get(record.stateId) === "candidate-expert-evaluation"), "candidate reducer aggregate Evidence missing");
  const fullContract = JSON.parse(contractBytes.toString()) as { entries: Array<{ status: string }> };
  assert.equal(diagnosisContracts.filter((entry) => entry.status !== "pass").length, fullContract.entries.filter((entry) => entry.status !== "pass").length, "fail/warning checks remain complete");
  assert.equal(shards[0]!.budget.summarizedPassingContractEntries, fullContract.entries.filter((entry) => entry.status === "pass").length, "pass checks are retained as compact grouped counter-evidence");
  assert.ok(output.diagnosisInputPaths!.length <= 12); assert.ok(output.diagnosisInputBytes! <= 524_288);
  assert.ok(diagnosisEvidence.some((record) => failedAttemptIds.has(record.stateId) && record.kind === "validation" && !record.provenanceId.startsWith("contract-validation:")));
  assert.ok(diagnosisEvidence.some((record) => failedAttemptIds.has(record.stateId) && ["message", "tool", "event"].includes(record.kind)));
});

test("Acontext compatibility retries frozen diagnostic inputs and emits evidence-backed failure findings only", async () => {
  const f = await fixture();
  const runDirectory = join(f.root, "successful-self-check");
  await mkdir(runDirectory);
  const manifestPath = join(runDirectory, "manifest.json");
  const artifactPath = join(runDirectory, "candidate-expert.json");
  await Promise.all([writeFile(manifestPath, "{}\n"), writeFile(artifactPath, "{\"f1\":0.2}\n")]);
  const artifactDigest = (await import("node:crypto")).createHash("sha256").update(await readFile(artifactPath)).digest("hex");
  const inspectionCalls: AgentTaskOptions[] = [];
  const output = await runHarnessSelfCheck({ cwd: f.root, provider: "test", model: "test", timeoutMs: 1000,
    runId: "successful", runDirectory, manifestPath, currentF1: 0.8, candidateF1: 0.2,
    stages: [
      { stage: "candidate-expert-evaluation", taskId: "candidate", kind: "deterministic-tool", inputArtifacts: [], outputArtifacts: [{ path: artifactPath, sha256: artifactDigest }] },
      { stage: "promotion-decision", taskId: "decision", kind: "deterministic-tool", inputArtifacts: [{ path: artifactPath, sha256: artifactDigest }], outputArtifacts: [] },
    ], artifacts: { candidateExpertReportPath: artifactPath }, sourceKind: "current-refine-run",
    runner: async (options) => {
      inspectionCalls.push(options);
      if (inspectionCalls.length === 1) return result(options, "not valid inspection JSON");
      const shards = await Promise.all(options.trace!.inputRefs!.map((path) => readFile(path, "utf8").then((text) => JSON.parse(text))));
      const seed = shards.flatMap((shard) => shard.diagnosisSeeds ?? [])[0]!;
      const evidence = decodeCompactEvidence(shards);
      const states = decodeCompactStates(shards); const targetEvidence = evidence.find((record) => seed.evidenceIds.includes(record.evidenceId))!;
      const targetState = states.find((state) => state.stateId === targetEvidence.stateId)!;
      return result(options, JSON.stringify({ schemaVersion: "1.1", annotations: [{
        seedId: seed.seedId, symptom: "Candidate F1 由 0.8 降至 0.2", responsibilityCandidates: [{ category: "unknown",
          targetStateRefs: [targetState.stateRef],
          supportingEvidenceRefs: [targetEvidence.evidenceRef], counterEvidenceRefs: [], evidenceSufficiency: "insufficient",
          rationale: "仅凭最终分数不足以归因到特定 Agent 或配置。" }], failureClass: "evaluation", severity: "high",
        reproducibility: "observed",
      }] }));
    },
  });
  assert.equal(output.status, "triggered", output.error);
  assert.equal(output.nativeAcontextApi, false);
  assert.equal(inspectionCalls.length, 2);
  assert.deepEqual(inspectionCalls.map((item) => item.trace?.inputRefs), [
    output.diagnosisInputPaths, output.diagnosisInputPaths,
  ]);
  for (const path of output.diagnosisInputPaths!) assert.ok((await readFile(path)).length <= 45_000);
  assert.ok(inspectionCalls.every((item) => !item.trace!.inputRefs!.includes(output.taskStatePath!) && !item.trace!.inputRefs!.includes(output.contractValidationPath!)));
  const diagnosisText = await readFile(output.diagnosisPath!, "utf8");
  assert.doesNotMatch(diagnosisText, /patchProposal|proposedPrompt|proposedSkill|autoApply|promotion/);
  const diagnosis = JSON.parse(diagnosisText) as { findings: Array<{ responsibilityCandidates: Array<{ category: string }> }> };
  assert.deepEqual(diagnosis.findings[0]!.responsibilityCandidates.map((item) => item.category), ["unknown"]);
  const projection = JSON.parse(await readFile(output.taskStatePath!, "utf8")) as { sourceKind: string; taskStateDag: { states: Array<{ kind: string }> }; evidenceRecords: Array<{ kind: string; relation: string; stateId: string; sourcePath: string | null; provenanceId: string }> };
  assert.equal(projection.sourceKind, "current-refine-run");
  assert.equal(projection.taskStateDag.states.filter((state) => state.kind === "root").length, 1);
  const artifactEvidence = projection.evidenceRecords.filter((item) => item.kind === "artifact" && item.sourcePath?.toLowerCase() === artifactPath.toLowerCase());
  assert.equal(artifactEvidence.length, 1, "artifact aliases do not create duplicate root ownership");
  assert.equal(artifactEvidence[0]!.relation, "produce");
  assert.equal(new Set(projection.evidenceRecords.map((item) => item.provenanceId)).size, projection.evidenceRecords.length);
  assert.ok(projection.evidenceRecords.some((item) => item.kind === "validation"));
});


test("typed pre-provider stop is not a model correction and resume starts an initial call", async () => {
  const f = await fixture(); const goldAspectSetPath = join(f.root, "gold-aspects.json");
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  await writeFile(goldAspectSetPath, JSON.stringify({ sourceSha256: digest(await readFile(f.goldPath, "utf8")), descriptionSha256: digest(await readFile(f.descriptionPath, "utf8")), aspects: [{ id: "gold-risk", title: "风险", description: "风险", evidences: [{ quote: "风险 A", location: "正文" }] }] }));
  const options = { cwd: f.root, provider: "test", model: "test", timeoutMs: 1000, runId: "control", runDirectory: f.root, parentTaskId: "expert", evaluationId: "current" as const, descriptionPath: f.descriptionPath, goldPath: f.goldPath, documentPath: f.currentPath, goldAspectSetPath, outputPath: join(f.root, "out.json") };
  let calls = 0; let stopped: WorkflowControlError | undefined;
  try { await runRefineExpertEvaluation({ ...options, runner: async () => { calls++; throw new WorkflowControlError("pause", "test pause", false); } }); } catch (error) { stopped = error as WorkflowControlError; }
  assert.ok(stopped instanceof WorkflowControlError); assert.equal(calls, 1);
  const previous = stopped.expertCalls![0] as any;
  assert.equal(previous.attempts.length, 1); assert.equal(previous.attempts[0].controlStop.providerStarted, false);
  const requested: AgentTaskOptions[] = []; const resumed = await runRefineExpertEvaluation({ ...options, resumeFailures: { [previous.stage]: previous }, runner: expertRunner(requested) });
  assert.equal(requested[0]!.trace!.stage, "current-document-aspect-extraction"); assert.doesNotMatch(requested[0]!.prompt, /exactValidationError|correction context/);
  assert.notEqual(requested[0]!.session!.id, previous.session.id);
  const record = resumed.calls.find(call => call.stage === previous.stage)!;
  assert.equal(record.attempts![0]!.error, "test pause"); assert.deepEqual(record.attempts!.map(attempt => attempt.phase), ["initial", "initial"]);
  assert.equal(record.attempts![1]!.correctionContractDigest, undefined);
  previous.attempts[0].controlStop.providerStarted = true;
  let forbidden = 0; await assert.rejects(runRefineExpertEvaluation({ ...options, resumeFailures: { [previous.stage]: previous }, runner: async () => { forbidden++; throw new Error("forbidden"); } }), error => error instanceof WorkflowControlError && error.reason === "accounting"); assert.equal(forbidden, 0);
});
