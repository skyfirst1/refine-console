import { readTraceDisclosure } from "../src/refine-trace-disclosure.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { runAgentTask, existingAgentTaskSessionPath, agentEventProvenance, projectPublicAgentEvents, type AgentTaskOptions, type AgentTaskResult } from "../src/agent-task-runner.js";
import { orderSemanticEvents, writeReadSafeJsonPackage, runStructuredSemanticTask, parseTraceSemanticFragment, buildInlineTraceDelivery, runDeliveredSemanticTask, splitTraceRecords, buildRefineEngineeringDiagnostics, buildRefineRoleStateShards, buildRefineRoleStates, buildRefineTraceSemanticSummary, canReuseBehaviorAuditCache, isCacheableTraceSemanticFragment, normalizeBehaviorAuditText, normalizeProposalLedgerText, runRefineTaskBehaviorAudit, validateRefineTaskBehaviorAuditResult, type BehaviorAuditCacheBinding, type RefineBehaviorAuditProposalLedger } from "../src/refine-behavior-audit.js";
import { auditRefineTraceIntegrity } from "../src/refine-trace-integrity.js";
import type { HarnessTraceStage } from "../src/refine-harness-self-check.js";
import { buildModelTraceSemanticSummary } from "../src/refine-behavior-audit.js";

async function readCompleteJson(path: string): Promise<any> {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (value.category !== "lossless_json_package_index") return value;
  const collect = async (entryPath: string): Promise<string> => {
    const part = JSON.parse(await readFile(entryPath, "utf8"));
    if (typeof part.payload === "string") return part.payload;
    return (await Promise.all(part.entries.map((entry: any) => collect(entry.path)))).join("");
  };
  const raw = (await Promise.all(value.entries.map((entry: any) => collect(entry.path)))).join("");
  assert.equal(digest(raw), value.completeJsonSha256);
  return JSON.parse(raw);
}

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

function fixtureSemanticEvents(publicReasoning: string, inputs?: any[]) {
  const sourceRefs = inputs?.flatMap(input => input.publicRecords?.flatMap((record: any) => record.sources.map((source: any) => source.eventRef)) ?? input.semanticFragments?.flatMap((fragment: any) => fragment.events.flatMap((event: any) => event.sourceRefs)) ?? []) ?? ["event:fixture:L1"];
  return sourceRefs.length ? [{ sourceRefs: [sourceRefs[0]], kind: "decision" as const, tool: null, outcome: "Observed decision.", publicReasoning }] : [];
}

test("semantic events retain public reasons, sort by actual sources, and reject unknown sources or tool payload fields", () => {
  const fragment = { stageFamily: "review", roleId: "refine.review", attemptsConsidered: 1, sourcePublicRecords: 2, taskAndInputs: "Compare a rule and two claims.", events: [
    { sourceRefs: ["event:test:L20", "event:test:L10"], kind: "decision" as const, tool: null, outcome: "Rejected second claim.", publicReasoning: "The explicit rule already covers the proposed condition; the earlier claim used a different interpretation." },
    { sourceRefs: ["event:test:L10"], kind: "decision" as const, tool: null, outcome: "Kept first claim.", publicReasoning: "The proposed condition differs from the quoted rule." },
    { sourceRefs: ["event:test:L20"], kind: "output" as const, tool: null, outcome: "First claim submitted.", publicReasoning: null },
  ], finalOutcome: "First claim submitted.", limitations: "Whether the interpretation is correct remains open." };
  const records = [10, 20].map(line => ({ stage: "review", attempt: 1, status: "completed", kind: "assistant_stop", text: "public reply", invocationId: "review", sources: [{ eventRef: `event:test:L${line}`, eventType: "message_end", metadata: {} }] }));
  const ordered = orderSemanticEvents(fragment, records);
  assert.deepEqual(ordered.events, [fragment.events[1], fragment.events[0], fragment.events[2]]);
  assert.throws(() => orderSemanticEvents(fragment, records.slice(0, 1)), /outside its delivered records/);
  const render = (value: unknown) => `<<<TRACE_SUMMARY_START>>>${JSON.stringify(value)}<<<TRACE_SUMMARY_END>>>`;
  assert.deepEqual(parseTraceSemanticFragment(render(ordered)).fragment, ordered);
  const tool = { sourceRefs: ["event:test:L10"], kind: "tool", tool: "read", outcome: "Loaded the rule.", publicReasoning: null };
  assert.equal(isCacheableTraceSemanticFragment(render({ ...fragment, events: [tool] })), true);
  for (const bad of [{ ...tool, arguments: { path: "repeated-path" } }, { ...tool, publicReasoning: "Repeated full return" }, { ...tool, sourceRefs: [] }]) assert.equal(isCacheableTraceSemanticFragment(render({ ...fragment, events: [bad] })), false);
});

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costUsd: 0 };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function recomputeReducerRecord(record: any) {
  const inputs = record.data.recomputableInputs as Record<string, any[]>; const recallMatches = inputs["recall-matches.json"] ?? []; const precisionMatches = inputs["precision-matches.json"] ?? []; const alignments = inputs["evidence-alignments.json"] ?? []; let alignmentIndex = 0;
  const contribution = (match: any) => { if (!match.matched || !match.targetAspectId) return 0; const alignment = alignments[alignmentIndex++]; assert.equal(alignment.sourceAspectId, match.sourceAspectId); assert.equal(alignment.targetAspectId, match.targetAspectId); return (Number(alignment.contentMatched) + Number(alignment.styleMatched)) / 2; };
  const recall = recallMatches.reduce((sum, match) => sum + contribution(match), 0) / recallMatches.length; const precision = precisionMatches.reduce((sum, match) => sum + contribution(match), 0) / precisionMatches.length; assert.equal(alignmentIndex, alignments.length); return { recall, precision, f1: recall + precision === 0 ? 0 : 2 * recall * precision / (recall + precision) };
}

async function fixture(extraPublicText = "") {
  const root = await mkdtemp(join(tmpdir(), "refine-role-audit-"));
  const content: Record<string, string> = {
    description: "# 技术调研报告\nBuild a complete answer.", gold: "Gold\nA B C D", draft: "Draft\nA", candidate: "Candidate\nA B", activeSkill: "# Active Writing Skill\n- preserve facts",
    expertCurrent: JSON.stringify({ f1: 0.5, gaps: [{ id: "gap-1" }, { id: "gap-2" }] }),
    review: JSON.stringify({ documentGaps: [{ id: "gap-1" }], skillFindings: [{ id: "finding-1", evidenceAspectIds: ["aspect-1"] }] }),
    goldAspects: JSON.stringify({ aspects: [{ id: "aspect-9", description: "requires C", evidences: [{ quote: "C", location: "Gold" }] }, { id: "aspect-10", description: "requires D", evidences: [{ quote: "D", location: "Gold" }] }] }),
    currentAspects: JSON.stringify({ aspects: [{ id: "aspect-4", description: "only A", evidences: [{ quote: "A", location: "Draft" }] }, { id: "aspect-5", description: "only B", evidences: [{ quote: "B", location: "Draft" }] }] }),
    candidateAspects: JSON.stringify({ aspects: [{ id: "aspect-4", description: "A and B", evidences: [{ quote: "A B", location: "Candidate" }] }, { id: "aspect-5", description: "candidate D", evidences: [{ quote: "D", location: "Candidate" }] }] }),
    matchInput: JSON.stringify({ direction: "recall", sourceAspect: { id: "aspect-9" }, targetAspects: [{ id: "aspect-4" }] }),
    match: JSON.stringify({ direction: "recall", sourceAspectId: "aspect-9", targetAspectId: "aspect-4", matched: true, rationale: "claimed match" }),
    matchInput2: JSON.stringify({ direction: "recall", sourceAspect: { id: "aspect-10" }, targetAspects: [{ id: "aspect-5" }] }),
    match2: JSON.stringify({ direction: "recall", sourceAspectId: "aspect-10", targetAspectId: "aspect-5", matched: true, rationale: "second claimed match" }),
    alignInput: JSON.stringify({ direction: "recall", mode: "content", sourceAspect: { id: "aspect-9", evidence: "C" }, targetAspect: { id: "aspect-4", evidence: "A" } }),
    align: JSON.stringify({ matched: false, rationale: "no corresponding support" }),
    "recall-matches": JSON.stringify([{ direction: "recall", sourceAspectId: "aspect-9", targetAspectId: "aspect-4", matched: true, rationale: "not retained by reducer" }]),
    "precision-matches": JSON.stringify([{ direction: "precision", sourceAspectId: "aspect-4", targetAspectId: null, matched: false, rationale: "not retained by reducer" }]),
    "evidence-alignments": JSON.stringify([{ direction: "recall", mode: "content", sourceAspectId: "aspect-9", targetAspectId: "aspect-4", contentMatched: false, styleMatched: true, rationale: "not retained by reducer" }]),
    reducerCurrent: JSON.stringify({ sourceInputs: { gold: "g", document: "d" }, f1: 0.5 }),
    reducerCandidate: JSON.stringify({ sourceInputs: { gold: "g", document: "c" }, f1: 0.4 }),
    expertCandidate: JSON.stringify({ sourceInputs: { gold: "g", document: "c" }, f1: 0.4, gaps: [{ id: "gap-2" }] }),
    judge: JSON.stringify({ schemaVersion: "1.0", verdict: "regressed", currentScore: 24, candidateScore: 19, currentHardPass: true, candidateHardPass: false, reason: "Candidate removed Description-required details." }),
    candidateSkill: "# Candidate skill",
    promotion: JSON.stringify({ schemaVersion: "1.0", decision: "reject", activeSkillOverwritten: false, expertScoreDelta: -0.1,
      gates: { skillChanged: true, hasAttributedFindings: true, expertImproved: false, expertHardPassPreserved: true, judgeImproved: false, judgeHardPassPreserved: false },
      reasons: ["gate-failed:expertImproved", "gate-failed:judgeImproved"], evidence: { activeSkillSha256: "a", candidateSkillSha256: "b", draftExpertSha256: "c", candidateExpertSha256: "d", judgeSha256: "e" } }),
  };
  const paths: Record<string, string> = {};
  const names: Record<string, string> = { description: "description.md", gold: "historical-final.md", draft: "draft.md", candidate: "candidate-draft.md", activeSkill: "active-skill.md", candidateSkill: "SKILL.md", expertCurrent: "expert-current.json", expertCandidate: "expert-candidate.json", review: "skill-review.json", judge: "independent-judge.json", promotion: "promotion-decision.json" };
  for (const [name, value] of Object.entries(content)) { paths[name] = join(root, names[name] ?? `${name}.json`); await writeFile(paths[name]!, value); }
  const events = join(root, "review.events.jsonl");
  await writeFile(events, [
    JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Compare Draft and Gold; return all documentGaps and supported skillFindings." }] } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "review complete" }] } }),
  ].join("\n"));
  const artifact = (name: string) => ({ path: paths[name]!, sha256: digest(content[name]!) });
  const card = (roleId: string) => ({ roleId, version: "v-test", digest: `card-${roleId}`, embeddedSkill: { id: roleId, version: "v-test" }, promptDigest: `prompt-${roleId}`, schemaDigest: `schema-${roleId}`, toolDigest: `tool-${roleId}` });
  const stages: HarnessTraceStage[] = [
    { stage: "description-reconstruction", taskId: "description", status: "completed", provider: "test", model: "test", card: card("refine.description"), inputArtifacts: [], outputArtifacts: [artifact("description")] },
    { stage: "current-draft-generation", taskId: "current-draft", status: "completed", provider: "test", model: "test", card: card("refine.draft"), inputArtifacts: [artifact("description"), artifact("activeSkill")], outputArtifacts: [artifact("draft")] },
    { stage: "reviewer-private-expert", taskId: "current-expert", status: "completed", provider: "test", model: "test", card: card("refine.agent"), inputArtifacts: [artifact("description"), artifact("gold"), artifact("draft")], outputArtifacts: [artifact("expertCurrent")] },
    { stage: "skill-attribution-review", taskId: "review", status: "completed", provider: "test", model: "test", card: card("refine.review"), inputArtifacts: [artifact("description"), artifact("gold"), artifact("draft"), artifact("activeSkill"), artifact("expertCurrent")], outputArtifacts: [artifact("review")], eventsPath: events,
      attempts: [{ attempt: 1, taskId: "review:attempt-1", eventsPath: events, status: "completed" }] },
    { stage: "candidate-skill-compilation", taskId: "compiler", status: "completed", provider: "test", model: "test", card: card("refine.policy-optimizer"), inputArtifacts: [artifact("activeSkill"), artifact("review")], outputArtifacts: [artifact("candidateSkill")] },
    { stage: "candidate-draft-generation", taskId: "candidate-draft", status: "completed", provider: "test", model: "test", card: card("refine.draft"), inputArtifacts: [artifact("description"), artifact("candidateSkill")], outputArtifacts: [artifact("candidate")] },
    { stage: "candidate-private-expert", taskId: "candidate-expert", status: "completed", provider: "test", model: "test", card: card("refine.agent"), inputArtifacts: [artifact("description"), artifact("candidate"), artifact("goldAspects")], outputArtifacts: [artifact("expertCandidate")] },
    { stage: "independent-judge", taskId: "judge", status: "completed", provider: "test", model: "test", card: card("refine.judge"), inputArtifacts: [artifact("description"), artifact("gold"), artifact("draft"), artifact("candidate")], outputArtifacts: [artifact("judge")] },
    { stage: "gold-aspect-extraction", taskId: "gold-aspects", status: "completed", provider: "test", model: "test", card: card("refine.aspect-extractor"), inputArtifacts: [artifact("description"), artifact("gold")], outputArtifacts: [artifact("goldAspects")] },
    { stage: "current-document-aspect-extraction", taskId: "current-aspects", status: "completed", provider: "test", model: "test", card: card("refine.aspect-extractor"), inputArtifacts: [artifact("description"), artifact("draft")], outputArtifacts: [artifact("currentAspects")] },
    { stage: "candidate-document-aspect-extraction", taskId: "candidate-aspects", status: "completed", provider: "test", model: "test", card: card("refine.aspect-extractor"), inputArtifacts: [artifact("description"), artifact("candidate")], outputArtifacts: [artifact("candidateAspects")] },
    { stage: "current-recall-match-9", taskId: "match-9", status: "completed", provider: "test", model: "test", card: card("refine.aspect-matcher"), inputArtifacts: [artifact("matchInput"), artifact("currentAspects")], outputArtifacts: [artifact("match")] },
    { stage: "candidate-recall-match-10", taskId: "match-10", status: "completed", provider: "test", model: "test", card: card("refine.aspect-matcher"), inputArtifacts: [artifact("matchInput2"), artifact("candidateAspects")], outputArtifacts: [artifact("match2")] },
    { stage: "current-alignment-8-content", taskId: "align-8-content", status: "completed", provider: "test", model: "test", card: card("refine.evidence-aligner"), inputArtifacts: [artifact("alignInput")], outputArtifacts: [artifact("align")] },
    { stage: "current-expert-evaluation", taskId: "current-reducer", kind: "deterministic-tool", status: "completed", inputArtifacts: [artifact("goldAspects"), artifact("currentAspects")], outputArtifacts: [artifact("reducerCurrent"), artifact("recall-matches"), artifact("precision-matches"), artifact("evidence-alignments")] },
    { stage: "candidate-expert-evaluation", taskId: "candidate-reducer", kind: "deterministic-tool", status: "completed", inputArtifacts: [artifact("goldAspects"), artifact("candidateAspects")], outputArtifacts: [artifact("reducerCandidate"), artifact("recall-matches"), artifact("precision-matches"), artifact("evidence-alignments")] },
    { stage: "promotion-decision", taskId: "promotion", kind: "deterministic-tool", status: "completed", inputArtifacts: [artifact("review"), artifact("candidateSkill"), artifact("expertCurrent"), artifact("expertCandidate"), artifact("judge")], outputArtifacts: [artifact("promotion")] },
  ];
  for (const stage of stages.filter((item) => item.kind !== "deterministic-tool")) {
    stage.toolAllowlist = ["read"];
    const path = stage.eventsPath ?? join(root, `${stage.stage}.events.jsonl`);
    const eventText = [
      JSON.stringify({ type: "session", version: 3, id: stage.taskId }),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "turn_start" }),
      JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: `Contract for ${stage.stage}` }] } }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: extraPublicText || `Completed ${stage.stage}` }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } } } }),
      JSON.stringify({ type: "turn_end" }),
      JSON.stringify({ type: "agent_end" }),
      JSON.stringify({ type: "agent_settled" }),
    ].join("\n") + "\n"; await writeFile(path, eventText);
    stage.eventsPath = path;
    stage.eventProvenance = agentEventProvenance(eventText);
    stage.attempts = [{ attempt: 1, taskId: `${stage.taskId}:attempt-1`, eventsPath: path, status: "completed", eventProvenance: stage.eventProvenance }];
  }
  return { root, paths, stages };
}

test("trace integrity traverses every JSONL record and refuses malformed or incomplete model attempts", async () => {
  const { root, stages } = await fixture(); const valid = await auditRefineTraceIntegrity(stages);
  assert.equal(valid.valid, true); assert.equal(valid.completenessMatrix.length, stages.filter((stage) => stage.kind !== "deterministic-tool").length); assert.ok(valid.completenessMatrix.every((row) => row.complete && row.records === 8));
  assert.ok(valid.raw.events.files > 1); assert.ok(valid.raw.events.records > valid.completenessMatrix.length); assert.ok(valid.raw.artifacts.files > 1); assert.equal(valid.raw.private.records, 0); assert.equal(valid.raw.parseFailures.records, 0);
  const toolPath = join(root, "tool.events.jsonl"); const toolCallId = "call-1"; const toolSource = [
    { type: "session" }, { type: "agent_start" }, { type: "turn_start" }, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "Read input", apiKey: "fixture-sensitive-value" }] } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: join(root, "description.md") } }], stopReason: "toolUse" } }, { type: "tool_execution_start", toolCallId, toolName: "read" }, { type: "tool_execution_end", toolCallId, toolName: "read", result: { content: [] } }, { type: "message_end", message: { role: "toolResult", toolCallId, toolName: "read", content: [] } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: { totalTokens: 2 } } }, { type: "turn_end" }, { type: "agent_end" }, { type: "agent_settled" },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n"; const toolProjection = projectPublicAgentEvents(toolSource); await writeFile(toolPath, toolProjection.jsonl); stages[0]!.eventsPath = toolPath; stages[0]!.eventProvenance = toolProjection.provenance; stages[0]!.attempts![0]!.eventsPath = toolPath; stages[0]!.attempts![0]!.eventProvenance = toolProjection.provenance; const withTool = await auditRefineTraceIntegrity(stages); assert.equal(withTool.valid, true); assert.equal(withTool.completenessMatrix[0]!.toolPairsConsistent, true); assert.deepEqual(withTool.completenessMatrix[0]!.toolNames, ["read"]); assert.ok(withTool.raw.redacted.records > 0); assert.match(JSON.stringify(withTool.completenessMatrix[0]!.publicEvidence), /description\.md/); assert.doesNotMatch(JSON.stringify(withTool), /fixture-sensitive-value/);
  const projectedStates = await buildRefineRoleStates(stages, "technical_research_report", withTool); const observable = projectedStates[0]!.dictionaries.observableTrace as any; assert.match(JSON.stringify(observable.stageAgentSummaries), /description\.md/); assert.match(JSON.stringify(observable.stageAgentSummaryTupleFields), /assistantFinalSummaryStatusRef.*toolCallArgsStatusRef.*toolResultSummaryStatusRef/); assert.equal(observable.evidenceProjection.source, observable.evidenceProjection.included + observable.evidenceProjection.omitted); assert.ok(projectedStates.every((state) => Buffer.byteLength(JSON.stringify(state)) < 45_000));
  const brokenPath = join(root, "broken.events.jsonl"); await writeFile(brokenPath, `${await readFile(stages[0]!.eventsPath!, "utf8")}{not-json}\n`); stages[0]!.eventsPath = brokenPath; stages[0]!.attempts![0]!.eventsPath = brokenPath;
  const broken = await auditRefineTraceIntegrity(stages); assert.equal(broken.valid, false); assert.ok(broken.findings.some((finding) => finding.code === "GT-TRACE-001" && finding.eventRef)); assert.equal(broken.raw.parseFailures.records, 1);
  let called = false; await assert.rejects(runRefineTaskBehaviorAudit({ cwd: root, provider: "test", model: "test", timeoutMs: 1_000, runner: async () => { called = true; throw new Error("must not run"); }, runId: "broken", runDirectory: join(root, "broken-run"), stages, taskType: "technical_research_report" }), /integrity failed/); assert.equal(called, false);
  const report = JSON.parse(await readFile(join(root, "broken-run", "harness-self-check", "behavior-audit", "trace-integrity.json"), "utf8")); assert.equal(report.valid, false);
});

test("trace integrity requires provenance, unique attempts, and accepts an explicit failed terminal without a final", async () => {
  const missing = await fixture(); delete missing.stages[0]!.attempts![0]!.eventProvenance;
  const strict = await auditRefineTraceIntegrity(missing.stages); assert.equal(strict.valid, false); assert.ok(strict.findings.some((finding) => finding.code === "TRACE_EVENTS_PROVENANCE_MISSING"));
  const legacy = await auditRefineTraceIntegrity(missing.stages, { allowLegacyMissingEventProvenance: true }); assert.equal(legacy.valid, true);

  const failed = await fixture(); const failedStage = failed.stages[0]!; const failedPath = join(failed.root, "explicit-failed.events.jsonl"); const failedText = [
    { type: "session" }, { type: "agent_start" }, { type: "turn_start" },
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "Public failed-attempt input" }] } },
    { type: "turn_end" }, { type: "agent_end" }, { type: "agent_settled" },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n"; await writeFile(failedPath, failedText); const failedProvenance = agentEventProvenance(failedText);
  failedStage.status = "failed"; failedStage.eventsPath = failedPath; failedStage.eventProvenance = failedProvenance; failedStage.attempts = [{ attempt: 1, taskId: "description:failed-attempt-1", eventsPath: failedPath, status: "failed", error: "provider terminated after input", eventProvenance: failedProvenance }];
  const failedReport = await auditRefineTraceIntegrity(failed.stages); assert.equal(failedReport.valid, true); assert.equal(failedReport.completenessMatrix[0]!.outputObserved, false); assert.equal(failedReport.completenessMatrix[0]!.complete, true);

  const reused = await fixture(); const reusedPath = reused.stages[0]!.eventsPath!; const reusedProvenance = reused.stages[0]!.eventProvenance!; reused.stages[1]!.eventsPath = reusedPath; reused.stages[1]!.eventProvenance = reusedProvenance; reused.stages[1]!.attempts![0] = { ...reused.stages[0]!.attempts![0]! };
  const reusedReport = await auditRefineTraceIntegrity(reused.stages); assert.equal(reusedReport.valid, false); assert.ok(reusedReport.findings.some((finding) => finding.code === "TRACE_ATTEMPT_IDENTITY_REUSED"));
});

test("one Refine task becomes exactly five learning-chain state files", async () => {
  const { stages } = await fixture(); const defaultStates = await buildRefineRoleStates(stages); assert.ok(defaultStates.every((state) => state.taskType === "unclassified_document_task")); const states = await buildRefineRoleStates(stages, "technical_research_report");
  assert.deepEqual(states.map((state) => state.roleState), ["task_expectations", "active_skill_and_review", "candidate_skill_delta", "draft_comparison", "expert_promotion_consequence"]);
  assert.ok(states.every((state) => state.taskType === "technical_research_report")); const physical = states.flatMap((state) => buildRefineRoleStateShards(state).serialized); assert.equal(physical.length, 5); assert.ok(physical.every((value) => Buffer.byteLength(value) < 45_000));
  assert.match(JSON.stringify(states[0]), /Build a complete answer/); assert.match(JSON.stringify(states[0]), /A B C D/);
  assert.match(JSON.stringify(states[1]), /Active Writing Skill/); assert.match(JSON.stringify(states[1]), /skillFindings/);
  const activeCurrent = states[1]!.records.find((record) => record.ref === "active-review:current-draft")!; assert.equal((activeCurrent.data as any).text, "Draft\nA"); assert.deepEqual(states[1]!.compression.projections.find((item) => item.ref === "active-review:current-draft"), { ref: "active-review:current-draft", unit: "segments", source: 1, selected: 1, omitted: 0 }); assert.equal(states[1]!.dictionaries.currentDraftProjection, "complete actual artifact");
  assert.ok(states[2]!.records.some((record) => record.ref === "candidate-skill:delta")); assert.match(JSON.stringify(states[2]), /Candidate skill/);
  assert.ok(states[3]!.records.some((record) => record.ref === "draft:candidate")); assert.match(JSON.stringify(states[3]), /A B/);
  assert.ok(states[3]!.compression.projections.some((item) => item.ref === "draft:current" && item.unit === "segments" && item.source === item.selected + item.omitted)); assert.ok(states[3]!.compression.projections.some((item) => item.ref === "draft:delta" && item.unit === "delta_changes" && item.source === item.selected + item.omitted));
  assert.ok(states[4]!.records.some((record) => record.kind === "promotion")); assert.ok(Array.isArray(states[4]!.dictionaries.semanticAggregates)); assert.ok(Array.isArray(states[4]!.dictionaries.semanticRepresentatives)); assert.ok(!states[4]!.records.some((record) => record.kind === "diagnostic"));
  assert.ok(states.every((state) => !state.records.some((record) => record.kind === "attempt")), "retry/attempt engineering details stay out of all five model states"); assert.ok(states.flatMap((state) => state.records).filter((record) => record.executionStatus).every((record) => record.executionStatus === "completed" || record.executionStatus === "unknown")); assert.ok((states[4]!.dictionaries.semanticSubjects as unknown[][]).every((tuple) => tuple.length === 3)); assert.doesNotMatch(JSON.stringify(states[4]!.dictionaries.semanticRepresentatives), /recovered|failed|retry/i);
});

test("observable trace keeps attempt boundaries, terminal finals, retry links, configuration, and artifact provenance", async () => {
  const { root, stages } = await fixture(); const review = stages.find((stage) => stage.stage === "skill-attribution-review")!; const failedPath = join(root, "review-attempt-1.events.jsonl"); const succeededPath = join(root, "review-attempt-2.events.jsonl");
  const events = (assistant: Array<Record<string, unknown>>) => [{ type: "session" }, { type: "agent_start" }, { type: "turn_start" }, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "Reviewer contract" }] } }, ...assistant, { type: "turn_end" }, { type: "agent_end" }, { type: "agent_settled" }].map((event) => JSON.stringify(event)).join("\n") + "\n";
  const failedText = events([{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "intermediate tool-use text" }], stopReason: "toolUse" } }]);
  const succeededText = events([{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "intermediate tool-use text" }], stopReason: "toolUse" } }, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "actual terminal review" }], stopReason: "stop", usage: { totalTokens: 2 } } }]);
  await writeFile(failedPath, failedText); await writeFile(succeededPath, succeededText); review.status = "recovered"; review.eventsPath = succeededPath; review.eventProvenance = agentEventProvenance(succeededText); review.attempts = [{ attempt: 1, taskId: "review:attempt-1", eventsPath: failedPath, status: "failed", error: "invalid reviewer output", eventProvenance: agentEventProvenance(failedText) }, { attempt: 2, taskId: "review:attempt-2", eventsPath: succeededPath, status: "completed", eventProvenance: agentEventProvenance(succeededText) }];
  const integrity = await auditRefineTraceIntegrity(stages); assert.equal(integrity.valid, true); const rows = integrity.completenessMatrix.filter((row) => row.stage === "skill-attribution-review"); assert.equal(rows.length, 2); assert.equal(rows[0]!.publicEvidence.some((item) => item.kind === "assistant_final"), false); assert.equal(rows[0]!.outputArtifactTerminals.length, 0); assert.equal(rows[1]!.publicEvidence.filter((item) => item.kind === "assistant_final").length, 1); assert.equal(rows[1]!.publicEvidence.find((item) => item.kind === "assistant_final")!.summary, "actual terminal review"); assert.equal(rows[1]!.outputArtifactTerminals.length, 1); assert.equal(rows[1]!.outputArtifactTerminals[0]!.terminalEventRef, rows[1]!.publicEvidence.find((item) => item.kind === "assistant_final")!.eventRef);
  const states = await buildRefineRoleStates(stages, "technical_research_report", integrity); const observable = states[1]!.dictionaries.observableTrace as any; assert.equal(observable.attemptExecutions.length, 2); assert.equal(observable.attemptExecutions[0][5], observable.attemptExecutions[1][0]); assert.equal(observable.attemptExecutions[1][4], observable.attemptExecutions[0][0]); assert.doesNotMatch(JSON.stringify(observable.attemptExecutions), /intermediate tool-use text/); assert.match(JSON.stringify(observable.attemptExecutions), /actual terminal review/);
  const configFields = observable.agentConfigurationFields as string[]; const config = observable.agentConfigurations[0] as unknown[]; assert.equal(config[configFields.indexOf("cardVersion")], "v-test"); assert.match(String(config[configFields.indexOf("embeddedSkillDigest")]), /^[0-9a-f]{64}$/); assert.match(String(config[configFields.indexOf("promptDigest")]), /^prompt-/); assert.match(String(config[configFields.indexOf("schemaDigest")]), /^schema-/); assert.match(String(config[configFields.indexOf("toolDigest")]), /^tool-/); assert.equal(config[configFields.indexOf("provider")], "test"); assert.equal(config[configFields.indexOf("model")], "test"); assert.deepEqual(config[configFields.indexOf("toolAllowlist")], ["read"]); assert.equal(observable.evidenceProjection.source, observable.evidenceProjection.included + observable.evidenceProjection.omitted);
});

function v4Result(taskType = "technical_research_report") {
  return { schemaVersion: "4.0", category: "trace_first_harness_evolution_paths", taskType, taskProfile: { documentTaskType: taskType, taskCharacteristics: ["技术调研报告用先结论后机制的段落功能组织高密度信息"] }, evolutionPaths: [{ targetAgent: "reviewer", secondaryAffectedRoles: ["policy_optimizer"], propagationChain: "Reviewer 的 style Finding 会由 Policy Optimizer 编译进 Writing Skill。", basis: "trace_with_task_standard", observedTraceBehavior: "Reviewer 在公开 Trace 中把章节存在与否直接写成样本要求，没有抽象段落功能与展开顺序。", artifactSymptom: "Candidate Skill 的规则仍绑定当前章节名称。", observedFailure: "Reviewer 没有把 Gold 展示的先结论、后机制、再边界的内容组织方式泛化为同类报告可复用的方法。", taskConditionedCapabilityGap: "技术调研 Reviewer 缺少从样本章节抽象段落功能、组织顺序与信息密度的方法。", evolutionTarget: { agentRole: "refine.review", surface: "prompt" }, specializedEvolutionPath: "比较段落承担的功能和展开顺序，将差异表达为先给结论、再解释机制、最后说明边界的条件化组织方法，不复制章节名或句子。", expectedBehaviorChange: "Reviewer 输出不含样本答案、可用于同类型未见内容的 content-style Finding。", validationPlan: { sameTaskReplay: "回放当前任务并确认 Finding 只描述段落功能与组织方法。", sameTypeUnseen: "用未见内容的技术调研报告确认同一方法仍可应用。", differentTypeNegativeHoldout: "用简历条目验证该报告组织方法不会被无条件套用。" }, support: "trace_supported", proposalAudit: { proposalId: "proposal-reviewer-1", candidateProposal: "比较段落承担的功能和展开顺序，将差异表达为先给结论、再解释机制、最后说明边界的条件化组织方法，不复制章节名或句子。", existingConstraintAssessment: "Current readable Reviewer configuration does not express this organization abstraction.", observedExecution: "The Reviewer emitted a sample-bound chapter rule.", supportingBehavior: "skill-attribution-review candidate-phase public output supports the gap.", counterevidence: "The strongest contrary configuration and Trace evidence was considered and does not show this method already implemented.", phaseOwner: "shared", supportingStageFamilies: ["skill-attribution-review"], judgeClaimCrossCheck: { status: "not_applicable", claim: null, documentEvidence: null }, genuinelyRemainingGap: "The Reviewer still lacks a reusable paragraph-function abstraction." } }], limitations: ["单次 Demo 不能证明跨任务泛化或实际文档质量提升。"] };
}

test("trace semantic inventory consumes every attempt without first-attempt selection", async () => {
  const { root, stages } = await fixture(); const review = stages.find((stage) => stage.stage === "skill-attribution-review")!; const failedPath = join(root, "semantic-failed.events.jsonl"); const succeededPath = join(root, "semantic-succeeded.events.jsonl");
  const events = (text: string, stopReason: string) => [{ type: "agent_start" }, { type: "turn_start" }, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "Compare Draft with Gold" }] } }, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason } }, { type: "turn_end" }, { type: "agent_end" }, { type: "agent_settled" }].map((event) => JSON.stringify(event)).join("\n") + "\n";
  const failedText = events("intermediate first attempt", "toolUse"); const succeededText = events("terminal recovered output", "stop"); await writeFile(failedPath, failedText); await writeFile(succeededPath, succeededText); review.status = "recovered"; review.eventsPath = succeededPath; review.eventProvenance = agentEventProvenance(succeededText); review.attempts = [{ attempt: 1, taskId: "review:semantic-1", eventsPath: failedPath, status: "failed", error: "first failed", eventProvenance: agentEventProvenance(failedText) }, { attempt: 2, taskId: "review:semantic-2", eventsPath: succeededPath, status: "completed", eventProvenance: agentEventProvenance(succeededText) }];
  const integrity = await auditRefineTraceIntegrity(stages); const summary = buildRefineTraceSemanticSummary(integrity, "technical_research_report"); const reviewer = summary.agentExecutions.find((item) => item.stageFamily === "skill-attribution-review")!; assert.equal(reviewer.attemptsConsidered, 2); assert.match(reviewer.executionSummary, /2 attempt/); assert.match(reviewer.failuresRetriesAndRecovery.join(" "), /attempt 1:failed.*attempt 2:completed/); assert.match(JSON.stringify(reviewer.publicOutputPatterns), /terminal recovered output/); assert.doesNotMatch(JSON.stringify(reviewer.publicOutputPatterns), /intermediate first attempt/);
});

test("v4 audit uses model semantic compression first and keeps five states out of the model input", async () => {
  const longPublicEvolution = "Public comparison explains the distinct condition. ".repeat(900);
  const { root, stages } = await fixture(longPublicEvolution); const calls: AgentTaskOptions[] = [];
  const judgeStage = stages.find((stage) => stage.stage === "independent-judge")!; const judgeLines = (await readFile(judgeStage.eventsPath!, "utf8")).trimEnd().split(/\r?\n/); judgeLines.splice(4, 0, JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Submit the structured Judge decision after preparation." }] } })); const judgeEvents = `${judgeLines.join("\n")}\n`; await writeFile(judgeStage.eventsPath!, judgeEvents); judgeStage.eventProvenance = agentEventProvenance(judgeEvents); judgeStage.attempts![0]!.eventProvenance = judgeStage.eventProvenance;

  const runner = async (options: AgentTaskOptions): Promise<AgentTaskResult> => { calls.push(options); const inputs = await Promise.all(options.trace!.inputRefs!.map(async (path) => JSON.parse(await readFile(path, "utf8")))); const input = inputs[0]; if (options.trace!.stage === "refine-trace-semantic-compression") { const fragment = selectedParagraphs(inputs); await writeFile(options.rawEventsPath, JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(fragment) }], stopReason: "stop", usage } }) + "\n"); return { finalText: JSON.stringify(fragment), rawEventsPath: options.rawEventsPath, readPaths: options.tools === "none" ? [] : [...options.trace!.inputRefs!], toolNames: options.tools === "none" ? [] : [options.tools === "trace" ? "trace_read" : "read"], usage, sessionId: "compress" }; } if (["preparation", "proposal-revision"].includes(String(options.trace!.attributes?.["agent.phase"]))) { const audit = v4Result().evolutionPaths[0]!.proposalAudit; const ledger = { schemaVersion: "1.0", category: "refine_behavior_audit_proposal_ledger", proposals: [{ proposalId: audit.proposalId, targetAgent: "reviewer", candidateProposal: audit.candidateProposal, existingConstraintAssessment: audit.existingConstraintAssessment, observedExecution: audit.observedExecution, supportingBehavior: audit.supportingBehavior, counterevidence: audit.counterevidence, phaseOwner: audit.phaseOwner, supportingStageFamilies: audit.supportingStageFamilies, judgeClaimCrossCheck: audit.judgeClaimCrossCheck, genuinelyRemainingGap: audit.genuinelyRemainingGap }] }; return { finalText: `<<<AUDIT_LEDGER_START>>>\n${JSON.stringify(ledger)}\n<<<AUDIT_LEDGER_END>>>`, rawEventsPath: options.rawEventsPath, readPaths: options.tools === "none" ? [] : [...options.trace!.inputRefs!], toolNames: options.tools === "none" ? [] : [options.tools === "trace" ? "trace_read" : "read"], usage, sessionId: options.session!.id, sessionDir: options.session!.dir }; } const value = v4Result(); return { finalText: `<<<REFINE_TASK_AUDIT_START>>>\n${JSON.stringify(value)}\n<<<REFINE_TASK_AUDIT_END>>>`, rawEventsPath: options.rawEventsPath, readPaths: options.tools === "none" ? [] : [...options.trace!.inputRefs!], toolNames: options.tools === "none" ? [] : [options.tools === "trace" ? "trace_read" : "read"], usage, sessionId: options.session!.id, sessionDir: options.session!.dir }; };
  const output = await runRefineTaskBehaviorAudit({ cwd: root, provider: "test", model: "test", timeoutMs: 1_000, runner, runId: "run", runDirectory: root, stages, taskType: "technical_research_report", diagnosticContext: { invocation: "manual-diagnostic", purpose: "success-trace-audit", automaticTrigger: false } });
  assert.equal(output.historicalTraceSummaryPath, null);
  const auditCall = calls.at(-1)!;
  const auditCalls = calls.filter((call) => call.trace!.stage === "trace-first-harness-evolution-audit");
  const preparationCall = auditCalls[0]!;
  assert.equal(preparationCall.maxOutputTokens, 16_000);
  assert.match(preparationCall.prompt, /最多 5 个 proposal/);
  assert.match(preparationCall.prompt, /不超过 16,000 字符/);
  assert.match(preparationCall.prompt, /judgeClaimCrossCheck[^\n]+status[^\n]+documentEvidence/);
  assert.match(preparationCall.prompt, /公开给出简短、可核验的审查说明/);
  const compressionCalls = calls.filter((call) => call.trace!.stage === "refine-trace-semantic-compression");
  assert.ok(compressionCalls.length > 0);
  for (const call of compressionCalls) {
    assert.equal(call.tools, "none");
    for (const path of call.trace!.inputRefs!) assert.ok(call.prompt.includes(await readFile(path, "utf8")), "every complete input is embedded");
    const delivery = JSON.parse(await readFile(`${call.rawEventsPath}.delivery.json`, "utf8"));
    assert.equal(delivery.mode, "inline-no-tools-v1");
    assert.equal(delivery.promptSha256, digest(call.prompt));
  }
  assert.equal(auditCall.trace!.stage, "trace-first-harness-evolution-audit");
  assert.equal(auditCalls.length, 3);
  assert.equal(auditCalls[0]!.trace!.attributes!["agent.phase"], "preparation");
  assert.equal(auditCalls[1]!.trace!.attributes!["agent.phase"], "proposal-revision");
  assert.equal(auditCalls[2]!.trace!.attributes!["agent.phase"], "submission");
  assert.equal(auditCalls[1]!.tools, "none");
  assert.equal(auditCalls[2]!.session!.id, auditCalls[0]!.session!.id);
  assert.deepEqual(JSON.parse(await readFile(join(output.proposalLedgerPath, "..", "preparation-proposal-ledger.json"), "utf8")), JSON.parse(await readFile(output.proposalLedgerPath, "utf8")));
  assert.equal(auditCalls[0]!.session!.id, auditCalls[1]!.session!.id);
  assert.equal(auditCalls[0]!.thinking, "off");
  assert.equal(auditCalls[1]!.thinking, "off");
  assert.match(auditCalls[1]!.systemPrompt, /reuse this session context without mechanically rereading/);
  assert.doesNotMatch(auditCalls[1]!.systemPrompt, /Before producing any task output, use the read tool/);
  assert.deepEqual(auditCall.trace!.inputRefs, [output.proposalLedgerPath], "submission reuses the persistent session and only supplies the short ledger");
  assert.equal(preparationCall.trace!.inputRefs!.length, 1);
  assert.equal(basename(preparationCall.trace!.inputRefs![0]!), "audit-preparation-context.json");
  const preparationContext = JSON.parse(await readFile(preparationCall.trace!.inputRefs![0]!, "utf8"));
  assert.equal(preparationContext.version, "progressive-public-trace-v1");
  assert.equal(preparationContext.discovery[0].source, "current");
  assert.ok(preparationContext.resources.some((item: any) => item.handle === "configuration"));
  assert.equal(preparationCall.tools, "trace");
  assert.match(preparationCall.prompt, /BOUNDED_DEFAULT_CONTEXT/);
  assert.equal(output.businessRoleStatePaths.length, 5);
  assert.ok(output.businessRoleStatePaths.every((path) => !preparationCall.prompt.includes(path)));
  const businessTaskState = JSON.parse(await readFile(output.businessTaskStatePath, "utf8"));
  assert.equal(businessTaskState.task.id, "refine-business-regression");
  assert.deepEqual(businessTaskState.task.triggerReasons, ["expert-regression"]);
  assert.equal(businessTaskState.roleStatePaths.length, 5);
  assert.ok(businessTaskState.evidencePartPaths.length > 0);
  for (const path of businessTaskState.evidencePartPaths) assert.ok((await readFile(path, "utf8")).length > 0);
  const businessRoles = await Promise.all(output.businessRoleStatePaths.map(readCompleteJson));
  assert.ok(!preparationCall.prompt.includes(longPublicEvolution), "full reasons are now progressively disclosed");
  const disclosureRegistry = JSON.parse(await readFile(preparationCall.traceDisclosure!.registryPath, "utf8"));
  const longEntry = disclosureRegistry.entries.find((entry: any) => entry.text === longPublicEvolution); assert.ok(longEntry);
  let recovered = "", pageQuery: any = { level: "excerpt", handle: longEntry.handle, source: longEntry.source };
  while (pageQuery) { const page: any = await readTraceDisclosure(preparationCall.traceDisclosure!.registryPath, preparationCall.traceDisclosure!.registrySha256, pageQuery); recovered += page.text; pageQuery = page.next; }
  assert.equal(recovered, longPublicEvolution);
  assert.deepEqual(businessRoles.map((state) => state.role), ["reviewer_learning_signal", "policy_optimizer_skill_compilation", "candidate_draft_skill_execution", "expert_evaluation", "judge_promotion_outcome"]);
  const draftRole = businessRoles.find((state) => state.role === "candidate_draft_skill_execution"); assert.ok(draftRole.executionScopes); assert.ok(draftRole.executionScopes.currentExecution.every((execution: any) => execution.stageFamily.startsWith("current-"))); assert.ok(draftRole.executionScopes.candidateExecution.every((execution: any) => execution.stageFamily.startsWith("candidate-")));
  assert.ok(businessRoles.every((state) => !state.agentExecutions.some((execution: any) => execution.stageFamily === "description-reconstruction")));
  const allBusinessExecutions = businessRoles.flatMap((state) => [...(state.agentExecutions ?? []), ...Object.values(state.executionScopes ?? {}).flat()]);
  const persistedTraceSummary = JSON.parse(await readFile(output.traceSummaryPath, "utf8"));
  const persistedTraceExecutions = persistedTraceSummary.agentExecutions ?? (await Promise.all(persistedTraceSummary.semanticSummaryParts.map(async (path: string) => JSON.parse(await readFile(path, "utf8"))))).flatMap((part: any) => part.agentExecutions);
  assert.equal(allBusinessExecutions.length, persistedTraceSummary.coverage.reducedStageFamilies - 1);
  const byIdentity = (executions: any[]) => [...executions].sort((left, right) => `${left.stageFamily}:${left.roleId}`.localeCompare(`${right.stageFamily}:${right.roleId}`));
  assert.deepEqual(byIdentity(allBusinessExecutions), byIdentity(persistedTraceExecutions.filter((execution: any) => execution.stageFamily !== "description-reconstruction")));
  assert.ok(output.roleStatePaths.every((path) => !auditCall.trace!.inputRefs!.includes(path)));
  assert.match(auditCall.systemPrompt, /只能依据公开 Trace/);
  assert.match(auditCall.systemPrompt, /overall style\/content-style/);
  assert.match(auditCall.systemPrompt, /每条路径只有一个 primary owner\/surface/);
  assert.match(auditCall.systemPrompt, /Prompt\/Skill\/Card 优先/);
  assert.match(auditCall.systemPrompt, /工程格式、JSON、marker、retry、接线问题[\s\S]*不得进入任何业务输出字段/);
  assert.match(auditCall.systemPrompt, /genuinelyRemainingGap[\s\S]*0—5/);
  assert.match(auditCall.systemPrompt, /语义判断[\s\S]*禁止关键词黑名单/);
  assert.match(auditCall.systemPrompt, /Current-only 证据不能证明 Candidate failure/);
  assert.match(auditCall.systemPrompt, /被原文反驳的 claim[\s\S]*Independent Judge/);
  assert.doesNotMatch(auditCall.systemPrompt, /以三至五条/);
  assert.ok(auditCall.trace!.inputRefs!.includes(output.proposalLedgerPath));
  assert.ok(output.configurationSnapshotPaths.every((path) => !auditCall.systemPrompt.includes(path)));
  const snapshots = await Promise.all(output.configurationSnapshotPaths.map(async (path) => JSON.parse(await readFile(path, "utf8")))); assert.ok(snapshots.every((snapshot) => Array.isArray(snapshot.exactPublicStagePromptSamples))); assert.ok(snapshots.some((snapshot) => snapshot.exactPublicStagePromptSamples.some((sample: any) => sample.text.length > 0))); assert.ok(snapshots.every((snapshot) => "runCard" in snapshot && "currentRegistryCard" in snapshot && Array.isArray(snapshot.parentHarnessSkills))); const judgeSnapshot = snapshots.find((snapshot) => snapshot.roleId === "refine.judge"); assert.deepEqual(judgeSnapshot.exactPublicStagePromptSamples.map((sample: any) => sample.publicUserTurn), [1, 2]);
  const auditBinding = JSON.parse(await readFile(output.auditBindingPath, "utf8")); for (const key of ["inputDigest", "traceDigest", "artifactDigest", "runId", "provider", "model", "promptDigest", "configDigest", "eventsSha256"]) assert.ok(key in auditBinding);
  const tokenUsage = JSON.parse(await readFile(output.tokenUsagePath, "utf8")); assert.equal(tokenUsage.status, "completed"); assert.ok(tokenUsage.calls.some((call: any) => call.layer === "audit-preparation")); assert.ok(tokenUsage.calls.some((call: any) => call.layer === "audit-submission")); assert.ok(tokenUsage.defaultAuditContextBytes < tokenUsage.onDemandEvidenceBytes);
  assert.deepEqual(tokenUsage.diagnosticContext, { invocation: "manual-diagnostic", purpose: "success-trace-audit", automaticTrigger: false });
  assert.ok(output.diagnosticMetadataPath); const diagnosticMetadata = JSON.parse(await readFile(output.diagnosticMetadataPath!, "utf8")); assert.equal(diagnosticMetadata.invocation, "manual-diagnostic"); assert.equal(diagnosticMetadata.purpose, "success-trace-audit"); assert.equal(diagnosticMetadata.automaticTrigger, false);
  assert.equal(output.result.evolutionPaths.length, 1);
  assert.deepEqual(output.result.evolutionPaths[0]!.secondaryAffectedRoles, ["policy_optimizer"]);
  assert.equal(JSON.parse(await readFile(output.traceSummaryPath, "utf8")).compressionMethod, "llm-public-span-selection-program-union");
  const traceIndex = JSON.parse(await readFile(output.traceSummaryPath, "utf8"));
  const factIndex = JSON.parse(await readFile(traceIndex.observedFacts.indexPath, "utf8"));
  const factEntries = (await Promise.all(factIndex.pages.map(async (path: string) => JSON.parse(await readFile(path, "utf8"))))).flatMap((page: any) => page.invocations);
  assert.equal(factEntries.length, traceIndex.observedFacts.invocationCount);
  const projected = await Promise.all(factEntries.map(async (entry: any) => { const parts = await Promise.all(entry.paths.map(async (path: string) => JSON.parse(await readFile(path, "utf8")))); return JSON.parse(parts.map((part: any) => part.payload).join("")); }));
  assert.ok(projected.every(item => item.outputs.every((candidate: any) => candidate.businessSelection === "not-inferred")));
  const factPreparationCall = calls.find(call => call.trace?.attributes?.["agent.phase"] === "preparation")!;
  assert.match(factPreparationCall.systemPrompt, /Observed facts/);
  assert.ok(!factPreparationCall.prompt.includes(JSON.stringify(traceIndex.observedFacts.indexPath).slice(1, -1)), "local index stays out of default prompt");
  const invocationPage: any = await readTraceDisclosure(factPreparationCall.traceDisclosure!.registryPath, factPreparationCall.traceDisclosure!.registrySha256, { level: "invocations", source: "current" });
  assert.ok(invocationPage.invocations.length > 0);
  const rawPage: any = await readTraceDisclosure(factPreparationCall.traceDisclosure!.registryPath, factPreparationCall.traceDisclosure!.registrySha256, { level: "raw", handle: invocationPage.invocations[0].rawHandle });
  assert.ok(rawPage.text.includes("inputAndToolRecords"));

  const taskStandardPath = join(root, "harness-self-check", "behavior-audit", "task-standard.json");
  const taskStandard = JSON.parse(await readFile(taskStandardPath, "utf8"));
  assert.match(taskStandard.learningObjective.primary, /paragraph function/);
  assert.ok(taskStandard.learningObjective.excludedFailureSignals.some((value: string) => /no attributable findings/i.test(value)));
  const outcomePath = join(root, "harness-self-check", "behavior-audit", "artifact-outcome-symptoms.json");
  const outcomes = JSON.parse(await readFile(outcomePath, "utf8")).outcomeSymptoms;
  assert.ok(outcomes.some((item: any) => item.kind === "judge" && item.data.currentScore === 24 && item.data.candidateScore === 19 && item.data.currentHardPass === true && item.data.candidateHardPass === false));
  assert.ok(outcomes.some((item: any) => item.kind === "promotion" && item.data.activeSkillOverwritten === false && item.data.expertScoreDelta === -0.1 && item.data.gates.judgeImproved === false && item.data.evidence.judgeSha256 === "e"));
});

test("v4 validator accepts complete trace-first paths and blocks artifact-only evolution claims", async () => {
  const { stages } = await fixture(); const states = await buildRefineRoleStates(stages, "technical_research_report"); const value: any = v4Result(); assert.equal(validateRefineTaskBehaviorAuditResult(value, states).evolutionPaths[0]!.support, "trace_supported");
  const inventedRole = structuredClone(value); inventedRole.evolutionPaths[0].targetAgent = "candidate_skill_compiler"; assert.throws(() => validateRefineTaskBehaviorAuditResult(inventedRole, states), /current Refine role/);
  const incompleteValidation = structuredClone(value); delete incompleteValidation.evolutionPaths[0].validationPlan.sameTypeUnseen; assert.throws(() => validateRefineTaskBehaviorAuditResult(incompleteValidation, states), /validationPlan/);
  value.evolutionPaths[0].basis = "artifact_only"; value.evolutionPaths[0].support = "insufficient"; assert.throws(() => validateRefineTaskBehaviorAuditResult(value, states), /Artifact-only/); value.evolutionPaths[0].taskConditionedCapabilityGap = null; value.evolutionPaths[0].evolutionTarget = null; value.evolutionPaths[0].specializedEvolutionPath = null; value.evolutionPaths[0].expectedBehaviorChange = null; value.evolutionPaths[0].validationPlan = null; value.evolutionPaths[0].secondaryAffectedRoles = []; value.evolutionPaths[0].propagationChain = null; assert.equal(validateRefineTaskBehaviorAuditResult(value, states).evolutionPaths[0]!.basis, "artifact_only");
  const legacy = v4Result(); delete (legacy.evolutionPaths[0] as any).secondaryAffectedRoles; delete (legacy.evolutionPaths[0] as any).propagationChain; assert.throws(() => validateRefineTaskBehaviorAuditResult(legacy, states), /schema is invalid/);
  const draft = v4Result(); draft.evolutionPaths[0]!.targetAgent = "candidate_draft" as any; draft.evolutionPaths[0]!.secondaryAffectedRoles = ["independent_judge"] as any; draft.evolutionPaths[0]!.proposalAudit.phaseOwner = "candidate"; draft.evolutionPaths[0]!.proposalAudit.supportingStageFamilies = ["candidate-draft-generation"]; assert.equal(validateRefineTaskBehaviorAuditResult(draft, states).evolutionPaths[0]!.targetAgent, "candidate_draft");
  const crossPhase = structuredClone(draft); crossPhase.evolutionPaths[0]!.proposalAudit.supportingStageFamilies = ["current-draft-generation"]; assert.throws(() => validateRefineTaskBehaviorAuditResult(crossPhase, states), /Current-only/);
  const contradicted: any = structuredClone(draft); contradicted.evolutionPaths[0]!.proposalAudit.judgeClaimCrossCheck = { status: "contradicted", claim: "STL appears after JT", documentEvidence: "Candidate places STL before JT." }; assert.throws(() => validateRefineTaskBehaviorAuditResult(contradicted, states), /cannot propagate/);
  const judge = v4Result(); judge.evolutionPaths[0]!.targetAgent = "independent_judge" as any; assert.equal(validateRefineTaskBehaviorAuditResult(judge, states).evolutionPaths[0]!.targetAgent, "independent_judge");
});

test("proposal ledger eliminates implemented semantic equivalents but preserves pre-fix counterfactual gaps", async () => {
  const { stages } = await fixture(); const states = await buildRefineRoleStates(stages, "technical_research_report");
  const result: any = v4Result(); result.evolutionPaths[0].targetAgent = "policy_optimizer"; result.evolutionPaths[0].secondaryAffectedRoles = []; result.evolutionPaths[0].proposalAudit.proposalId = "optimizer-novelty"; result.evolutionPaths[0].proposalAudit.genuinelyRemainingGap = "Conflicting rules still survive in two locations.";
  const ledger = (gap: string | null, wording: string): RefineBehaviorAuditProposalLedger => ({ schemaVersion: "1.0", category: "refine_behavior_audit_proposal_ledger", proposals: [{ proposalId: "optimizer-novelty", targetAgent: "policy_optimizer", candidateProposal: wording, existingConstraintAssessment: "The current Card already requires one canonical location and conflict removal, expressed with different wording.", observedExecution: "The public candidate-skill compilation consolidated the method and removed the old conflict.", supportingBehavior: "The pre-fix fixture either retains or removes duplicate rules as stated by its public output.", counterevidence: "The complete current Skill diff and compilation summary were checked before deciding novelty.", phaseOwner: "shared", supportingStageFamilies: ["candidate-skill-compilation"], judgeClaimCrossCheck: { status: "not_applicable", claim: null, documentEvidence: null }, genuinelyRemainingGap: gap }] });
  assert.throws(() => validateRefineTaskBehaviorAuditResult(result, states, ledger(null, "Consolidate equivalent guidance into one authoritative rule.")), /surviving proposal ledger/);
  const surviving = ledger("Conflicting rules still survive in two locations.", "Remove the restored conflicts and multi-location additions."); const { targetAgent: _target, ...survivingAudit } = surviving.proposals[0]!; result.evolutionPaths[0].proposalAudit = survivingAudit; result.evolutionPaths[0].specializedEvolutionPath = survivingAudit.candidateProposal;
  assert.equal(validateRefineTaskBehaviorAuditResult(result, states, surviving).evolutionPaths.length, 1);
  for (const field of ["candidateProposal", "existingConstraintAssessment", "observedExecution", "supportingBehavior", "counterevidence"] as const) { const tampered = structuredClone(result); tampered.evolutionPaths[0].proposalAudit[field] += " tampered"; assert.throws(() => validateRefineTaskBehaviorAuditResult(tampered, states, surviving), /deeply match/); }
  const replacedSuggestion = structuredClone(result); replacedSuggestion.evolutionPaths[0].specializedEvolutionPath = "A different already-implemented suggestion."; assert.throws(() => validateRefineTaskBehaviorAuditResult(replacedSuggestion, states, surviving), /exactly reuse/);
  const tamperedCrossCheck = structuredClone(result); tamperedCrossCheck.evolutionPaths[0].proposalAudit.judgeClaimCrossCheck.status = "insufficient"; assert.throws(() => validateRefineTaskBehaviorAuditResult(tamperedCrossCheck, states, surviving), /deeply match/);
  const tamperedStages = structuredClone(result); tamperedStages.evolutionPaths[0].proposalAudit.supportingStageFamilies = ["policy-optimizer"]; assert.throws(() => validateRefineTaskBehaviorAuditResult(tamperedStages, states, surviving), /deeply match/);
  const noPaths = { ...v4Result(), evolutionPaths: [] }; assert.equal(validateRefineTaskBehaviorAuditResult(noPaths, states, ledger(null, "Express one governing rule rather than repeating equivalent constraints." )).evolutionPaths.length, 0, "a semantically equivalent paraphrase may be eliminated without a keyword gate");
});

test("proposal ledger rejects cross-phase or wrong-role evidence before submission", () => {
  const base = { schemaVersion: "1.0", category: "refine_behavior_audit_proposal_ledger", proposals: [{ proposalId: "draft-1", targetAgent: "candidate_draft", candidateProposal: "Improve candidate execution.", existingConstraintAssessment: "The current Card was inspected.", observedExecution: "Only Current failed.", supportingBehavior: "Current output failed.", counterevidence: "Candidate completed cleanly.", phaseOwner: "current", supportingStageFamilies: ["current-draft-generation"], judgeClaimCrossCheck: { status: "not_applicable", claim: null, documentEvidence: null }, genuinelyRemainingGap: "Candidate needs a change." }] };
  const marked = (value: unknown) => `<<<AUDIT_LEDGER_START>>>\n${JSON.stringify(value)}\n<<<AUDIT_LEDGER_END>>>`;
  assert.throws(() => normalizeProposalLedgerText(marked(base)), /Candidate-only/);
  const wrongRole: any = structuredClone(base); wrongRole.proposals[0].targetAgent = "independent_judge"; wrongRole.proposals[0].phaseOwner = "shared"; assert.throws(() => normalizeProposalLedgerText(marked(wrongRole)), /target Agent role/);
  const optimizer: any = structuredClone(base); optimizer.proposals[0] = { ...optimizer.proposals[0], targetAgent: "policy_optimizer", phaseOwner: "shared", supportingStageFamilies: ["candidate-skill-compilation"], genuinelyRemainingGap: "A pre-fix conflict remains." }; const inventory: any = { all: new Set(["candidate-skill-compilation"]), byTarget: new Map([["policy_optimizer", new Set(["candidate-skill-compilation"]) ]]) }; assert.equal(normalizeProposalLedgerText(marked(optimizer), inventory).proposals[0]!.targetAgent, "policy_optimizer"); const fictional = structuredClone(optimizer); fictional.proposals[0].supportingStageFamilies = ["invented-policy-optimizer"]; assert.throws(() => normalizeProposalLedgerText(marked(fictional), inventory), /exist in the audited Trace/);
});

test("proposal ledger keeps Judge document contradictions with Judge and never propagates them to Candidate", async () => {
  const { stages } = await fixture(); const states = await buildRefineRoleStates(stages, "technical_research_report"); const value: any = v4Result();
  value.evolutionPaths[0].targetAgent = "independent_judge"; value.evolutionPaths[0].specializedEvolutionPath = "Ground concrete comparison claims in source text."; value.evolutionPaths[0].proposalAudit = { proposalId: "judge-source-check", candidateProposal: "Ground concrete comparison claims in source text.", existingConstraintAssessment: "The current Judge already decomposes five dimensions, so decomposition is not novel.", observedExecution: "The Judge used all five labels but asserted an ordering contradicted by Candidate text.", supportingBehavior: "The public Judge reason says STL follows JT.", counterevidence: "Candidate original text was checked and places STL before JT.", phaseOwner: "shared", supportingStageFamilies: ["independent-judge"], judgeClaimCrossCheck: { status: "contradicted", claim: "STL follows JT", documentEvidence: "Candidate places STL before JT." }, genuinelyRemainingGap: "Judge must ground concrete ordering claims in the supplied documents before using them." };
  const ledger: RefineBehaviorAuditProposalLedger = { schemaVersion: "1.0", category: "refine_behavior_audit_proposal_ledger", proposals: [{ proposalId: "judge-source-check", targetAgent: "independent_judge", candidateProposal: "Ground concrete comparison claims in source text.", existingConstraintAssessment: value.evolutionPaths[0].proposalAudit.existingConstraintAssessment, observedExecution: value.evolutionPaths[0].proposalAudit.observedExecution, supportingBehavior: value.evolutionPaths[0].proposalAudit.supportingBehavior, counterevidence: value.evolutionPaths[0].proposalAudit.counterevidence, phaseOwner: "shared", supportingStageFamilies: ["independent-judge"], judgeClaimCrossCheck: value.evolutionPaths[0].proposalAudit.judgeClaimCrossCheck, genuinelyRemainingGap: value.evolutionPaths[0].proposalAudit.genuinelyRemainingGap }] };
  assert.equal(validateRefineTaskBehaviorAuditResult(value, states, ledger).evolutionPaths[0]!.targetAgent, "independent_judge");
  value.evolutionPaths[0].targetAgent = "candidate_draft"; value.evolutionPaths[0].proposalAudit.phaseOwner = "candidate"; value.evolutionPaths[0].proposalAudit.supportingStageFamilies = ["candidate-draft-generation"]; assert.throws(() => validateRefineTaskBehaviorAuditResult(value, states), /cannot propagate/);
});

test("Judge decomposition advice is suppressed when executed and survives only for a pre-fix mixed reason", async () => {
  const { stages } = await fixture(); const states = await buildRefineRoleStates(stages, "technical_research_report"); const value: any = v4Result();
  value.evolutionPaths[0].targetAgent = "independent_judge"; value.evolutionPaths[0].secondaryAffectedRoles = []; value.evolutionPaths[0].specializedEvolutionPath = "Separate the evaluation dimensions."; value.evolutionPaths[0].proposalAudit = { proposalId: "judge-decomposition", candidateProposal: "Separate the evaluation dimensions.", existingConstraintAssessment: "The current Card already asks for five dimensions.", observedExecution: "The current reason uses all five labeled dimensions.", supportingBehavior: "The pre-fix fixture has one mixed paragraph only.", counterevidence: "The current output is already decomposed.", phaseOwner: "shared", supportingStageFamilies: ["independent-judge"], judgeClaimCrossCheck: { status: "verified", claim: "The current Judge reason is decomposed.", documentEvidence: "The five labels are present in the Judge artifact." }, genuinelyRemainingGap: "The pre-fix Judge reason still mixes all dimensions in one unlabeled paragraph." };
  const makeLedger = (gap: string | null, observed: string): RefineBehaviorAuditProposalLedger => ({ schemaVersion: "1.0", category: "refine_behavior_audit_proposal_ledger", proposals: [{ proposalId: "judge-decomposition", targetAgent: "independent_judge", candidateProposal: "Separate the evaluation dimensions.", existingConstraintAssessment: "The current Card semantically requires separate dimensions.", observedExecution: observed, supportingBehavior: "The relevant public Judge reason was inspected.", counterevidence: "The strongest opposing output was considered.", phaseOwner: "shared", supportingStageFamilies: ["independent-judge"], judgeClaimCrossCheck: { status: "verified", claim: "The reason shape was inspected.", documentEvidence: "Judge artifact text." }, genuinelyRemainingGap: gap }] });
  assert.throws(() => validateRefineTaskBehaviorAuditResult(value, states, makeLedger(null, "Current output uses the requested dimensions.")), /surviving proposal ledger/);
  const surviving = makeLedger("The pre-fix Judge reason still mixes all dimensions in one unlabeled paragraph.", "Pre-fix output has one unlabeled mixed paragraph."); const { targetAgent: _target, ...survivingAudit } = surviving.proposals[0]!; value.evolutionPaths[0].proposalAudit = survivingAudit; value.evolutionPaths[0].specializedEvolutionPath = survivingAudit.candidateProposal;
  assert.equal(validateRefineTaskBehaviorAuditResult(value, states, surviving).evolutionPaths.length, 1);
});

test("compression cache reuse requires exact trace, artifacts, model, prompt, configuration, run, input, and events bindings", () => {
  const expected: BehaviorAuditCacheBinding = { schemaVersion: "1.0", inputDigest: "input", traceDigest: "trace", artifactDigest: "artifacts", runId: "run", provider: "provider", model: "model", promptDigest: "prompt", configDigest: "config", eventsSha256: null };
  const metadata = { ...expected, eventsSha256: "events" };
  assert.equal(canReuseBehaviorAuditCache(metadata, expected, "events"), true);
  for (const key of ["inputDigest", "traceDigest", "artifactDigest", "runId", "provider", "model", "promptDigest", "configDigest"] as const) assert.equal(canReuseBehaviorAuditCache({ ...metadata, [key]: `${metadata[key]}-changed` }, expected, "events"), false, `${key} changes must invalidate cache reuse`);
  assert.equal(canReuseBehaviorAuditCache(metadata, expected, "different-events"), false);
  assert.equal(canReuseBehaviorAuditCache({ ...metadata, unexpected: true }, expected, "events"), false);
});

test("only strictly normalized semantic fragments are eligible for safe cache reuse", () => {
  const strict = { stageFamily: "candidate-skill-compilation", roleId: "refine.policy-optimizer", attemptsConsidered: 1, sourcePublicRecords: 3, taskAndInputs: "Read current Skill and findings.", events: fixtureSemanticEvents("Merged one surviving rule."), finalOutcome: "Candidate Skill emitted.", limitations: "Public behavior only." };
  assert.equal(isCacheableTraceSemanticFragment(`<<<TRACE_SUMMARY_START>>>\n${JSON.stringify(strict)}\n<<<TRACE_SUMMARY_END>>>`), true);
  assert.equal(isCacheableTraceSemanticFragment(`brief public preface\n<<<TRACE_SUMMARY_START>>>\n${JSON.stringify(strict)}\n<<<TRACE_SUMMARY_END>>>`), true, "a complete exact structured block remains cacheable even when public prose surrounds it");
  assert.equal(isCacheableTraceSemanticFragment("Combined narrative fallback without the exact semantic schema."), false);
  assert.equal(isCacheableTraceSemanticFragment(`<<<TRACE_SUMMARY_START>>>\n${JSON.stringify({ ...strict, finalOutcome: "" })}\n<<<TRACE_SUMMARY_END>>>`), false);
  assert.equal(isCacheableTraceSemanticFragment(`Agent read files.\n<<<TRACE_SUMMARY_START>>>\n${JSON.stringify({ ...strict, actionsAndToolUse: "", finalOutcome: "" })}\n<<<TRACE_SUMMARY_END>>>`), false, "wide prose recovery must never make a partial structured response cacheable");
});

test("semantic parser distinguishes marker examples, ambiguity, extra keys and literal marker text", () => {
  const value = { stageFamily: "stage", roleId: null, attemptsConsidered: 1, sourcePublicRecords: 1, taskAndInputs: "Input", events: fixtureSemanticEvents("Output"), finalOutcome: "Observed", limitations: "Public only" };
  const wrap = (value: unknown) => `<<<TRACE_SUMMARY_START>>>${JSON.stringify(value)}<<<TRACE_SUMMARY_END>>>`;
  const parsed = parseTraceSemanticFragment(`Use <<<TRACE_SUMMARY_START>>> and <<<TRACE_SUMMARY_END>>>.\n${wrap(value)}`);
  assert.deepEqual(parsed.fragment, value); assert.ok(parsed.rejectedCandidates.length > 0);
  assert.throws(() => parseTraceSemanticFragment(wrap(value) + wrap(value)), /Multiple contract-valid/);
  assert.throws(() => parseTraceSemanticFragment(wrap(value).repeat(17)), error => (error as { code: string }).code === "parser_candidate_limit");
  assert.throws(() => parseTraceSemanticFragment(wrap({ ...value, sourceFileNote: "extra" })), error => (error as { code: string }).code === "extra_keys");
  assert.throws(() => parseTraceSemanticFragment(wrap({ ...value, finalOutcome: "" })), /nonempty/);
  assert.deepEqual(parseTraceSemanticFragment(wrap({ ...value, limitations: "Literal <<<TRACE_SUMMARY_START>>> and <<<TRACE_SUMMARY_END>>> names" })).fragment.limitations, "Literal <<<TRACE_SUMMARY_START>>> and <<<TRACE_SUMMARY_END>>> names");
  assert.throws(() => parseTraceSemanticFragment(wrap(value).replace('"roleId":null', '"roleId":null,"roleId":"changed"')), /malformed JSON/);
});

test("invalid semantic output stops before audit and preserves full diagnostics without cache", async () => {
  const { root, stages } = await fixture(); const runDirectory = join(root, "fallback-cache-run"); let semanticCalls = 0;
  const runner = async (options: AgentTaskOptions): Promise<AgentTaskResult> => {
    const preparation = ["preparation", "proposal-revision"].includes(String(options.trace!.attributes?.["agent.phase"])); const semantic = options.trace!.stage === "refine-trace-semantic-compression" || options.trace!.stage === "refine-trace-semantic-reduction"; if (semantic) semanticCalls += 1;
    const finalText = semantic ? "One combined public semantic narrative without the exact schema." : preparation ? `<<<AUDIT_LEDGER_START>>>\n${JSON.stringify({ schemaVersion: "1.0", category: "refine_behavior_audit_proposal_ledger", proposals: [] })}\n<<<AUDIT_LEDGER_END>>>` : `<<<REFINE_TASK_AUDIT_START>>>\n${JSON.stringify({ ...v4Result(), evolutionPaths: [] })}\n<<<REFINE_TASK_AUDIT_END>>>`;
    await writeFile(options.rawEventsPath, `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText }], stopReason: "stop", usage } })}\n`);
    return { finalText, rawEventsPath: options.rawEventsPath, readPaths: options.tools === "none" ? [] : [...(options.trace!.inputRefs ?? [])], toolNames: options.tools === "none" ? [] : [options.tools === "trace" ? "trace_read" : "read"], usage, ...(options.session ? { sessionId: options.session.id, sessionDir: options.session.dir } : {}) };
  };
  const input = { cwd: root, provider: "test", model: "test", timeoutMs: 1_000, runner, runId: "fallback-cache", runDirectory, stages, taskType: "technical_research_report" };
  await assert.rejects(runRefineTaskBehaviorAudit(input), /Semantic output invalid/); assert.equal(semanticCalls, 3);
  const outputRoot = join(runDirectory, "harness-self-check", "behavior-audit");
  const status = JSON.parse(await readFile(join(outputRoot, "trace-compression-status.json"), "utf8")); assert.equal(status.status, "invalid"); assert.equal(status.usableForAudit, false);
  const diagnostic = JSON.parse(await readFile(status.diagnosticPath, "utf8")); assert.equal(await readFile(diagnostic.rawOutputPath, "utf8"), "One combined public semantic narrative without the exact schema.");
  await assert.rejects(readFile(join(outputRoot, "current-summary-snapshot.json"), "utf8"));
  await assert.rejects(readFile(join(outputRoot, "trace-compression", "events", "001.events.jsonl.cache.json"), "utf8"));
});

test("strict semantic cache hits skip every matching model compression call", async () => {
  const { root, stages } = await fixture(); const runDirectory = join(root, "strict-cache-run"); let semanticCalls = 0;
  const runner = async (options: AgentTaskOptions): Promise<AgentTaskResult> => {
    const preparation = ["preparation", "proposal-revision"].includes(String(options.trace!.attributes?.["agent.phase"])); const semantic = options.trace!.stage === "refine-trace-semantic-compression" || options.trace!.stage === "refine-trace-semantic-reduction"; if (semantic) semanticCalls += 1;
    let finalText: string;
    if (semantic) { const inputs = await Promise.all((options.trace!.inputRefs ?? []).map(async (path) => JSON.parse(await readFile(path, "utf8")))); const first = inputs[0]; const fragment = selectedParagraphs(inputs); finalText = JSON.stringify(fragment); }
    else if (preparation) finalText = `<<<AUDIT_LEDGER_START>>>\n${JSON.stringify({ schemaVersion: "1.0", category: "refine_behavior_audit_proposal_ledger", proposals: [] })}\n<<<AUDIT_LEDGER_END>>>`;
    else finalText = `<<<REFINE_TASK_AUDIT_START>>>\n${JSON.stringify({ ...v4Result(), evolutionPaths: [] })}\n<<<REFINE_TASK_AUDIT_END>>>`;
    await writeFile(options.rawEventsPath, `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText }], stopReason: "stop", usage } })}\n`);
    return { finalText, rawEventsPath: options.rawEventsPath, readPaths: options.tools === "none" ? [] : [...(options.trace!.inputRefs ?? [])], toolNames: options.tools === "none" ? [] : [options.tools === "trace" ? "trace_read" : "read"], usage, ...(options.session ? { sessionId: options.session.id, sessionDir: options.session.dir } : {}) };
  };
  const input = { cwd: root, provider: "test", model: "test", timeoutMs: 1_000, runner, runId: "strict-cache", runDirectory, stages, taskType: "technical_research_report" };
  const initial = await runRefineTaskBehaviorAudit(input); const firstSemanticCalls = semanticCalls; assert.ok(firstSemanticCalls > 0);
  await runRefineTaskBehaviorAudit(input); assert.equal(semanticCalls, firstSemanticCalls, "valid bound caches must avoid every duplicate semantic model call");
  const resumed = await runRefineTaskBehaviorAudit({ ...input, runDirectory: join(root, "snapshot-resume"), currentSummarySnapshot: initial.currentSummarySnapshot });
  assert.equal(semanticCalls, firstSemanticCalls, "a new output directory restores the v6 snapshot without recompression");
  const produced = JSON.parse(await readFile(initial.currentSummarySnapshot.path, "utf8")).summary.selectionComponentProvenance;
  const componentReferences = await Promise.all(produced.map(async (component: any) => { const path = `${component.eventsPath}.selection-component.json`; return { path, sha256: digest(await readFile(path, "utf8")) }; }));
  const subsetStages = stages.filter(stage => stage.stage === produced[0].stageFamily);
  const subset = await buildModelTraceSemanticSummary({ ...input, stages: subsetStages, selectionComponentCheckpoints: componentReferences }, await auditRefineTraceIntegrity(subsetStages), join(root, "subset-restore"), runner);
  assert.equal(subset.agentExecutions.length, 1); assert.equal(semanticCalls, firstSemanticCalls, "component reuse is independent of report scope and input directory");
  await runRefineTaskBehaviorAudit({ ...input, runDirectory: join(root, "component-resume"), selectionComponentCheckpoints: componentReferences });
  assert.equal(semanticCalls, firstSemanticCalls, "full consumer imports original components without provider calls");
  const old = JSON.parse(await readFile(initial.currentSummarySnapshot.path, "utf8")); old.compressionVersion = "inline-no-tools-v5-ordered-public-events";
  const oldPath = join(root, "old-version-snapshot.json"), oldRaw = JSON.stringify(old); await writeFile(oldPath, oldRaw);
  await assert.rejects(runRefineTaskBehaviorAudit({ ...input, currentSummarySnapshot: { path: oldPath, sha256: digest(oldRaw) } }), /snapshot binding mismatch/);
  if (process.env.TRACE_SELECTION_TEST_EVIDENCE_DIR) await writeFile(join(process.env.TRACE_SELECTION_TEST_EVIDENCE_DIR, "snapshot-resume.json"), JSON.stringify({ fixtureOnly: true, sourceSnapshot: initial.currentSummarySnapshot, resumed, compressionCallsBefore: firstSemanticCalls, compressionCallsAfter: semanticCalls }, null, 2));
});

test("accepted structural corrections resume from cache without overwriting failed initial evidence", async () => {
  const { root, stages } = await fixture(); const runDirectory = join(root, "corrected-cache-run"); let semanticCalls = 0;
  const runner = async (options: AgentTaskOptions): Promise<AgentTaskResult> => {
    const preparation = ["preparation", "proposal-revision"].includes(String(options.trace!.attributes?.["agent.phase"])); const semantic = options.trace!.stage === "refine-trace-semantic-compression" || options.trace!.stage === "refine-trace-semantic-reduction"; if (semantic) semanticCalls += 1;
    let finalText: string;
    if (semantic) { const inputs = await Promise.all((options.trace!.inputRefs ?? []).map(async (path) => JSON.parse(await readFile(path, "utf8")))); const first = inputs[0]; const fragment = selectedParagraphs(inputs); finalText = JSON.stringify(fragment); }
    else if (preparation) finalText = `<<<AUDIT_LEDGER_START>>>\n${JSON.stringify({ schemaVersion: "1.0", category: "refine_behavior_audit_proposal_ledger", proposals: [] })}\n<<<AUDIT_LEDGER_END>>>`;
    else finalText = `<<<REFINE_TASK_AUDIT_START>>>\n${JSON.stringify({ ...v4Result(), evolutionPaths: [] })}\n<<<REFINE_TASK_AUDIT_END>>>`;
    if (semantic && options.trace!.attributes?.["trace.structure_correction"] === 0) finalText = "{malformed initial output";
    await writeFile(options.rawEventsPath, `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText }], stopReason: "stop", usage } })}\n`);
    return { finalText, rawEventsPath: options.rawEventsPath, readPaths: options.tools === "none" ? [] : [...(options.trace!.inputRefs ?? [])], toolNames: options.tools === "none" ? [] : [options.tools === "trace" ? "trace_read" : "read"], usage, ...(options.session ? { sessionId: options.session.id, sessionDir: options.session.dir } : {}) };
  };
  const input = { cwd: root, provider: "test", model: "test", timeoutMs: 1_000, runner, runId: "corrected-cache", runDirectory, stages, taskType: "technical_research_report" };
  await runRefineTaskBehaviorAudit(input); const firstSemanticCalls = semanticCalls; assert.ok(firstSemanticCalls > 1);
  await runRefineTaskBehaviorAudit(input); assert.equal(semanticCalls, firstSemanticCalls, "valid bound caches must avoid every duplicate semantic model call");
});

test("proposal ledger is bounded to five compact candidates", () => {
  const proposal = { proposalId: "p", targetAgent: "reviewer", candidateProposal: "Improve a task-conditioned style method.", existingConstraintAssessment: "config-ref: absent", observedExecution: "stage-ref: omitted", supportingBehavior: "trace-ref: supports", counterevidence: "config-ref: checked", phaseOwner: "shared", supportingStageFamilies: ["skill-attribution-review"], judgeClaimCrossCheck: { status: "not_applicable", claim: null, documentEvidence: null }, genuinelyRemainingGap: "A specific method remains absent." };
  const marked = (proposals: unknown[]) => `<<<AUDIT_LEDGER_START>>>\n${JSON.stringify({ schemaVersion: "1.0", category: "refine_behavior_audit_proposal_ledger", proposals })}\n<<<AUDIT_LEDGER_END>>>`;
  assert.equal(normalizeProposalLedgerText(marked(Array.from({ length: 5 }, (_, index) => ({ ...proposal, proposalId: `p-${index}` })))).proposals.length, 5);
  assert.throws(() => normalizeProposalLedgerText(marked(Array.from({ length: 6 }, (_, index) => ({ ...proposal, proposalId: `p-${index}` })))), /root is invalid/);
  assert.throws(() => normalizeProposalLedgerText(marked([{ ...proposal, candidateProposal: "x".repeat(481) }])), /compact proposal-ledger limit/);
  assert.equal(normalizeProposalLedgerText(`Checked evidence; no actionable gap.\n${marked([])}`).proposals.length, 0);
  assert.throws(() => normalizeProposalLedgerText(`${marked([])}\ntrailing text`), /must end with/);
});

async function historicalAuditFixture(extraPublicText = "") {
  const current = await fixture(extraPublicText); const historical = await fixture(extraPublicText);
  const oldSkill = "# Earlier Writing Skill\n- use compact paragraphs";
  await writeFile(historical.paths.activeSkill!, oldSkill);
  for (const stage of historical.stages) for (const artifact of stage.inputArtifacts ?? []) if (artifact.path === historical.paths.activeSkill) artifact.sha256 = digest(oldSkill);
  // Production uses these names, while older standalone traces use their aliases.
  historical.stages.find((stage) => stage.stage === "skill-attribution-review")!.stage = "skill-review";
  historical.stages.find((stage) => stage.stage === "current-expert-evaluation")!.stage = "draft-expert-evaluation";
  const sourceManifestPath = join(historical.root, "manifest.json");
  const persist = () => writeFile(sourceManifestPath, JSON.stringify({ workflow: "gold-supervised-skill-refine", status: "rejected", runId: "prior-run", stages: historical.stages }));
  await persist();
  const options = { cwd: current.root, provider: "test", model: "test", timeoutMs: 1_000, runId: "current-run", runDirectory: current.root, stages: current.stages, taskType: "technical_research_report", currentTraceIdentity: { batchId: "verified-batch", round: 2 }, historicalTrace: { batchId: "verified-batch", round: 1, runId: "prior-run", stages: historical.stages, sourceManifestPath } };
  return { current, historical, options, persist };
}

test("one earlier complete trace is compressed identically and scoped as comparison in both audit turns", async () => {
  const longHistoricalReason = "Public comparison survives the archived-role page boundary. ".repeat(900);
  const { options } = await historicalAuditFixture(longHistoricalReason); const calls: AgentTaskOptions[] = [];
  let injectHistoricalSupport = false;
  const runner = async (call: AgentTaskOptions): Promise<AgentTaskResult> => {
    calls.push(call);
    const semantic = call.trace!.stage?.startsWith("refine-trace-semantic-");
    let finalText: string;
    if (semantic) {
      const inputs = await Promise.all(call.trace!.inputRefs!.map(async (path) => JSON.parse(await readFile(path, "utf8")))); const first = inputs[0];
      const fragment = selectedParagraphs(inputs);
      finalText = JSON.stringify(fragment);
    } else if (["preparation", "proposal-revision"].includes(String(call.trace!.attributes?.["agent.phase"]))) {
      const audit = v4Result().evolutionPaths[0]!.proposalAudit;
      finalText = `<<<AUDIT_LEDGER_START>>>\n${JSON.stringify({ schemaVersion: "1.0", category: "refine_behavior_audit_proposal_ledger", proposals: injectHistoricalSupport ? [{ ...audit, targetAgent: "reviewer", supportingBehavior: "historical:skill-review supplies the alleged failure" }] : [] })}\n<<<AUDIT_LEDGER_END>>>`;
    }
    else finalText = `<<<REFINE_TASK_AUDIT_START>>>\n${JSON.stringify({ ...v4Result(), evolutionPaths: [] })}\n<<<REFINE_TASK_AUDIT_END>>>`;
    await writeFile(call.rawEventsPath, `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText }], stopReason: "stop", usage } })}\n`);
    return { finalText, rawEventsPath: call.rawEventsPath, readPaths: call.tools === "none" ? [] : [...call.trace!.inputRefs!], toolNames: call.tools === "none" ? [] : [call.tools === "trace" ? "trace_read" : "read"], usage, ...(call.session ? { sessionId: call.session.id, sessionDir: call.session.dir } : {}) };
  };
  const output = await runRefineTaskBehaviorAudit({ ...options, runner });
  assert.ok(output.historicalTraceSummaryPath?.includes("historical-comparison"));
  assert.deepEqual(output.result.evolutionPaths, []);
  const auditCalls = calls.filter((call) => call.trace!.stage === "trace-first-harness-evolution-audit");
  assert.equal(auditCalls.length, 3);
  for (const call of auditCalls) assert.match(call.systemPrompt, /历史观察不得作为本轮缺陷的支持证据/);
  const context = JSON.parse(await readFile(auditCalls[0]!.trace!.inputRefs![0]!, "utf8"));
  assert.deepEqual(context.discovery.map((item: any) => item.source), ["current", "historical"]);
  for (const ref of ["task:gold-expectations", "draft:current", "draft:candidate"]) {
    assert.ok(context.resources.some((item: any) => item.handle === ref));
    const resource: any = await readTraceDisclosure(auditCalls[0]!.traceDisclosure!.registryPath, auditCalls[0]!.traceDisclosure!.registrySha256, { level: "resource", handle: ref });
    assert.ok(resource.text.length > 0);
  }
  assert.ok(!auditCalls[0]!.prompt.includes(longHistoricalReason));
  const registry = JSON.parse(await readFile(auditCalls[0]!.traceDisclosure!.registryPath, "utf8"));
  const historicalEntry = registry.entries.find((entry: any) => entry.source === "historical" && entry.text === longHistoricalReason); assert.ok(historicalEntry);
  let restored = "", nextQuery: any = { source: "historical", level: "excerpt", handle: historicalEntry.handle };
  while (nextQuery) { const page: any = await readTraceDisclosure(auditCalls[0]!.traceDisclosure!.registryPath, auditCalls[0]!.traceDisclosure!.registrySha256, nextQuery); restored += page.text; nextQuery = page.next; }
  assert.equal(restored, longHistoricalReason);
  assert.equal(auditCalls[0]!.session!.id, auditCalls[1]!.session!.id);
  assert.ok(calls.some((call) => call.trace!.runId === "prior-run" && call.trace!.stage === "refine-trace-semantic-compression"));
  const tokens = JSON.parse(await readFile(output.tokenUsagePath, "utf8"));
  assert.ok(tokens.calls.some((call: any) => call.callId.startsWith("historical:")));
  const { historicalTrace: omittedHistory, ...withoutHistory } = options;
  await assert.rejects(runRefineTaskBehaviorAudit({ ...withoutHistory, runner, historicalSummarySnapshot: output.currentSummarySnapshot }), /requires a historical Trace/);
  const beforeReuse = calls.length;
  await runRefineTaskBehaviorAudit({ ...options, runner, runDirectory: join(options.runDirectory, "fixed-summary-arm"), currentSummarySnapshot: output.currentSummarySnapshot });
  assert.equal(calls.slice(beforeReuse).filter(call => call.trace?.runId === "current-run" && call.trace.stage?.startsWith("refine-trace-semantic-")).length, 0);
  await assert.rejects(runRefineTaskBehaviorAudit({ ...options, runner, currentSummarySnapshot: { ...output.currentSummarySnapshot, sha256: "wrong" } }), /snapshot hash mismatch/);
  await assert.rejects(runRefineTaskBehaviorAudit({ ...options, runner, model: "different-model", currentSummarySnapshot: output.currentSummarySnapshot }), /snapshot binding mismatch/);
  const fewerExecutedRoles = await runRefineTaskBehaviorAudit({ ...options, stages: options.stages.filter((stage) => stage.stage !== "candidate-skill-compilation"), runner });
  assert.deepEqual(fewerExecutedRoles.result.evolutionPaths, [], "an uninvoked current role is not a configuration mismatch");
  injectHistoricalSupport = true;
  await assert.rejects(runRefineTaskBehaviorAudit({ ...options, runner }), /Historical comparison references cannot support/);
});

test("history rejects mismatched batch, order, Description, Skill, configuration and incomplete workflow before model calls", async () => {
  const cases: Array<{ change: (f: Awaited<ReturnType<typeof historicalAuditFixture>>) => void; error: RegExp }> = [
    { change: (f) => { f.options.historicalTrace.batchId = "other"; }, error: /verified batch/ },
    { change: (f) => { f.options.historicalTrace.round = 2; }, error: /earlier distinct/ },
    { change: (f) => { f.historical.stages.find((s) => s.stage === "current-draft-generation")!.inputArtifacts![0]!.sha256 = "different"; }, error: /Description differs/ },
    { change: (f) => { f.historical.stages.find((s) => s.stage === "current-draft-generation")!.inputArtifacts![1]!.sha256 = f.current.stages.find((s) => s.stage === "current-draft-generation")!.inputArtifacts![1]!.sha256; }, error: /different earlier active/ },
    { change: (f) => { f.historical.stages.find((s) => s.stage === "skill-review")!.card!.digest = "old-configuration"; }, error: /role configurations differ/ },
    { change: (f) => { f.historical.stages.find((s) => s.stage === "candidate-draft-generation")!.status = "skipped"; }, error: /complete Refine/ },
  ];
  for (const entry of cases) {
    const f = await historicalAuditFixture(); entry.change(f); await f.persist();
    await assert.rejects(runRefineTaskBehaviorAudit({ ...f.options, runner: async () => { throw new Error("model must not run"); } }), entry.error);
  }
  const f = await historicalAuditFixture(); await writeFile(f.options.historicalTrace.sourceManifestPath, "{}");
  await assert.rejects(runRefineTaskBehaviorAudit({ ...f.options, runner: async () => { throw new Error("model must not run"); } }), /completed source Refine manifest/);
});

test("behavior audit normalization is narrow", () => {
  const json = JSON.stringify({ ...v4Result(), evolutionPaths: [] });
  assert.equal(normalizeBehaviorAuditText(json).normalization, "bare-json"); assert.equal(normalizeBehaviorAuditText(`\`\`\`json\n${json}\n\`\`\``).normalization, "json-fence"); assert.equal(normalizeBehaviorAuditText(`analysis\n${json}\ndone`).normalization, "unique-embedded-json"); assert.equal(normalizeBehaviorAuditText(`<<<REFINE_TASK_AUDIT_START>>>\n${json}\n<<<REFINE_TASK_AUDIT_END>>>`).normalization, "marker-block"); assert.throws(() => normalizeBehaviorAuditText(`${json}\n${json}`), /exactly one/);
});

test("current Agent trace projects the learning chain and deterministic engineering sidecar", async (t) => {
  const manifestPath = process.env.REFINE_HISTORICAL_AGENT_MANIFEST;
  if (!manifestPath) { t.skip("set REFINE_HISTORICAL_AGENT_MANIFEST and REFINE_HISTORICAL_WORKFLOW_MANIFEST to opt into private traces"); return; }
  let manifest: { stages: HarnessTraceStage[] }; try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch { t.skip("current Agent trace fixture is unavailable"); return; }
  const states = await buildRefineRoleStates(manifest.stages, "technical_research_report"); assert.equal(states.length, 5); assert.deepEqual(states.map((state) => state.roleState), ["task_expectations", "active_skill_and_review", "candidate_skill_delta", "draft_comparison", "expert_promotion_consequence"]); assert.ok(states.every((state) => state.taskType === "technical_research_report"));
  const physical = states.flatMap((state) => buildRefineRoleStateShards(state).serialized); assert.equal(physical.length, 5); assert.ok(physical.every((value) => Buffer.byteLength(value) < 45_000)); assert.ok(physical.reduce((sum, value) => sum + Buffer.byteLength(value), 0) < 194_000);
  assert.ok(states[0]!.records.some((record) => record.ref === "task:gold-expectations")); assert.ok(states[1]!.records.some((record) => record.ref === "active-review:active-skill")); assert.ok(states[2]!.records.some((record) => record.ref === "candidate-skill:delta")); assert.ok(states[3]!.records.some((record) => record.ref === "draft:candidate")); assert.ok(states[4]!.records.some((record) => record.ref === "expert:promotion"));
  const activeCurrent = states[1]!.records.find((record) => record.ref === "active-review:current-draft")!; const currentDraftPath = manifest.stages.find((stage) => stage.stage === "skill-attribution-review")!.inputArtifacts!.find((artifact) => artifact.sha256 === activeCurrent.source!.sha256)!.path; assert.equal((activeCurrent.data as any).text, await readFile(currentDraftPath, "utf8")); assert.deepEqual(states[1]!.compression.projections.find((item) => item.ref === "active-review:current-draft"), { ref: "active-review:current-draft", unit: "segments", source: 1, selected: 1, omitted: 0 }); assert.equal(states[1]!.dictionaries.currentDraftProjection, "complete actual artifact");
  const diagnostics = await buildRefineEngineeringDiagnostics(manifest.stages); assert.equal(diagnostics.invocationCount, 126); assert.equal(diagnostics.category, "engineering_diagnostics"); assert.equal(diagnostics.excludedFromRoleFindings, true); assert.ok(diagnostics.providers.some((entry) => entry.provider === "deepseek")); assert.ok(diagnostics.reads.observedInvocations > 0); assert.ok(diagnostics.outputContracts.rationaleOver80Chars > 0); assert.ok(diagnostics.retries.failedAttempts > 0); assert.ok(diagnostics.retries.recoveredInvocations > 0);
  assert.doesNotMatch(JSON.stringify(states.map((state) => state.roleState)), /directional_matching|evidence_alignment/); assert.ok(Buffer.byteLength(serializeState(states[4]!)) < 45_000); assert.ok((states[4]!.dictionaries.semanticAggregates as unknown[]).length >= 8); assert.ok((states[4]!.dictionaries.semanticRepresentatives as unknown[]).length > 1); assert.ok((states[4]!.dictionaries.aspects as unknown[]).length >= 30); assert.equal(states[4]!.dictionaries.engineeringDiagnosticsLocation, "sidecar-only");
  assert.ok(states.every((state) => !state.records.some((record) => record.kind === "attempt"))); assert.ok(states.flatMap((state) => state.records).filter((record) => record.executionStatus).every((record) => record.executionStatus === "completed" || record.executionStatus === "unknown")); assert.ok((states[4]!.dictionaries.semanticSubjects as unknown[][]).every((tuple) => tuple.length === 3)); assert.doesNotMatch(JSON.stringify(states[4]!.dictionaries.semanticRepresentatives), /recovered|failed|retry/i); assert.ok(Array.isArray(states[4]!.dictionaries.semanticSubjects));
  const semanticDecisions = states[4]!.dictionaries.semanticDecisions as unknown[][]; const semanticSubjects = states[4]!.dictionaries.semanticSubjects as unknown[][]; assert.equal(semanticDecisions.length, 126); assert.equal(semanticSubjects.length, 126); const decisionRefs = new Set(semanticDecisions.map((tuple) => tuple[0])); assert.ok(semanticSubjects.every((tuple) => decisionRefs.has(tuple[0]))); const aspectRefs = new Set((states[4]!.dictionaries.aspects as unknown[][]).map((tuple) => tuple[0])); assert.ok(semanticDecisions.every((tuple) => (tuple[2] === null || aspectRefs.has(tuple[2])) && (tuple[3] === null || aspectRefs.has(tuple[3])))); assert.ok((states[4]!.dictionaries.semanticRepresentatives as unknown[][]).every((tuple) => decisionRefs.has(tuple[0])));
  const workflowPath = process.env.REFINE_HISTORICAL_WORKFLOW_MANIFEST;
  if (!workflowPath) { t.skip("REFINE_HISTORICAL_WORKFLOW_MANIFEST is not configured"); return; }
  const workflow = JSON.parse(await readFile(workflowPath, "utf8")) as { stages: HarnessTraceStage[] }; const workflowStates = await buildRefineRoleStates(workflow.stages, "technical_research_report");
  assert.deepEqual(workflowStates.map((state) => state.roleState), states.map((state) => state.roleState), "Workflow and Agent traces share the same five learning-chain states");
  const workflowPhysical = workflowStates.map(serializeState); assert.ok(workflowPhysical.every((value) => Buffer.byteLength(value) < 45_000));
  const workflowReview = workflowStates[1]!; const workflowDraft = workflowReview.records.find((record) => record.ref === "active-review:current-draft")!; const workflowReviewStage = workflow.stages.find((stage) => stage.stage === "skill-review")!; const workflowDraftPath = workflowReviewStage.inputArtifacts!.find((artifact) => artifact.sha256 === workflowDraft.source!.sha256)!.path; assert.equal((workflowDraft.data as any).text, await readFile(workflowDraftPath, "utf8")); assert.ok(workflowReview.records.some((record) => record.kind === "review_item")); assert.ok(workflowReview.records.some((record) => record.ref === "active-review:invocation"));
  const workflowConsequence = workflowStates[4]!; for (const ref of ["expert:current", "expert:candidate", "expert:promotion"]) assert.ok(workflowConsequence.records.some((record) => record.ref === ref), `Workflow alias must retain ${ref}`);
  assert.equal((workflowConsequence.dictionaries.semanticDecisions as unknown[][]).length, 126); assert.equal((workflowConsequence.dictionaries.semanticSubjects as unknown[][]).length, 126);
});

function serializeState(state: Awaited<ReturnType<typeof buildRefineRoleStates>>[number]) { return `${JSON.stringify(state)}\n`; }

test("CLI defaults to the whole Refine task and obsoletes per-invocation target selection", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")); const script = await readFile(new URL("../scripts/run-refine-behavior-audit.ts", import.meta.url), "utf8");
  assert.equal(packageJson.scripts["audit-refine-behavior"], "tsx scripts/run-refine-behavior-audit.ts"); assert.match(script, /runRefineTaskBehaviorAudit/); assert.match(script, /audit-target-id is obsolete/); assert.doesNotMatch(script, /auditTargetIds/); assert.match(script, /deepseek-v4-flash/);
  assert.match(script, /required\("--task-type"\)/);
});


test("inline delivery preserves long source bytes and rejects tools or changed sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "inline-delivery-"));
  const input = join(root, "source.json");
  const content = JSON.stringify({body:"大段公开trace😀".repeat(12000), tail:"LAST_RECORD_SENTINEL"});
  await writeFile(input, content);
  const delivery = await buildInlineTraceDelivery([input], "Summarize all records.");
  assert.ok(delivery.prompt.includes(content));
  assert.equal(delivery.files[0]!.sha256, digest(content));
  const options: AgentTaskOptions = { cwd:root,provider:"test",model:"test",timeoutMs:1000,systemPrompt:"",prompt:delivery.prompt,rawEventsPath:join(root,"events.jsonl"),tools:"none" };
  await assert.rejects(runDeliveredSemanticTask(async()=>({finalText:"ok",readPaths:[input],toolNames:["read"],rawEventsPath:options.rawEventsPath,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,costUsd:0}}),delivery,options), /emitted tools/);
  await writeFile(input, content + "changed");
  let called=false;
  await assert.rejects(runDeliveredSemanticTask(async()=>{called=true;throw new Error("must not run");},delivery,options), /changed before delivery/);
  assert.equal(called,false);
});


test("oversized text and metadata are split losslessly into bounded ordered JSON parts", () => {
  const record = {stage:"tool-stage",attempt:1,status:"completed",kind:"tool_result",invocationId:"inv-1",text:"尾部😀".repeat(18000),sources:[{eventRef:"event:test:L1",eventType:"tool_execution_end",metadata:{detail:'"\\\n'.repeat(15000)}}]};
  const chunks = splitTraceRecords([record]);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => Buffer.byteLength(JSON.stringify(chunk)) <= 36000));
  const parts = chunks.flat();
  assert.ok(parts.every(part => part.kind.startsWith("serialized-record-json-part:")));
  assert.deepEqual(JSON.parse(parts.map(part => part.text).join("")), record);
});


test("structure correction preserves failures and same-session full delivery; execution errors are not retried", async () => {
  const root = await mkdtemp(join(tmpdir(), "structure-correction-"));
  const input = join(root, "input.txt"); await writeFile(input, "unchanged original evidence");
  const delivery = await buildInlineTraceDelivery([input], "Summarize JSON");
  const options: AgentTaskOptions = { cwd: root, provider: "test", model: "test", timeoutMs: 1000, rawEventsPath: join(root, "events.jsonl"), systemPrompt: "Fixed contract", prompt: delivery.prompt, tools: "none" };
  const value = { stageFamily: "stage", roleId: null, attemptsConsidered: 1, sourcePublicRecords: 1, taskAndInputs: "Input", events: fixtureSemanticEvents("Output"), finalOutcome: "Observed", limitations: "Public only" };
  const calls: AgentTaskOptions[] = []; const usages: number[] = [];
  const runner = async (call: AgentTaskOptions): Promise<AgentTaskResult> => {
    calls.push(call); const finalText = calls.length === 1 ? '{"broken":' : JSON.stringify(value);
    await writeFile(call.rawEventsPath, finalText);
    return { finalText, rawEventsPath: call.rawEventsPath, readPaths: [], toolNames: [], usage };
  };
  const result = await runStructuredSemanticTask(runner, delivery, options, (_, attempt) => usages.push(attempt));
  assert.equal(calls.length, 2); assert.deepEqual(usages, [0, 1]);
  assert.equal(calls[0]!.session!.id, calls[1]!.session!.id); assert.equal(calls[1]!.session!.requireExisting, true);
  for (const call of calls) { assert.equal(call.tools, "none"); assert.ok(call.prompt.includes(delivery.prompt)); assert.equal(call.systemPrompt, options.systemPrompt); }
  assert.match(calls[1]!.prompt, /STRUCTURE-ONLY/); assert.notEqual(result.rawEventsPath, options.rawEventsPath);
  assert.equal(await readFile(`${options.rawEventsPath}.public-output.txt`, "utf8"), '{"broken":');
  const chain = JSON.parse(await readFile(`${options.rawEventsPath}.structure-chain.json`, "utf8"));
  assert.deepEqual(chain.attempts.map((a: any) => a.status), ["failed", "valid"]); assert.equal(chain.maxCorrections, 2);
  let failedCalls = 0;
  await assert.rejects(runStructuredSemanticTask(async () => { failedCalls++; throw new Error("budget stop"); }, delivery, { ...options, rawEventsPath: join(root, "budget.events.jsonl") }), /budget stop/);
  assert.equal(failedCalls, 1);
});


test("correction session lookup rejects missing, wrong assistant, and ambiguous persisted sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "structure-session-"));
  const session = { id: "session-test", dir: root, requireExisting: true, expectedAssistantSha256: digest("failed raw") };
  await assert.rejects(existingAgentTaskSessionPath(session), /exactly one persisted/);
  await assert.rejects(runAgentTask({ cwd: root, provider: "unused", model: "unused", timeoutMs: 1000, systemPrompt: "unused", prompt: "unused", tools: "none", rawEventsPath: join(root, "not-created.events.jsonl"), session }), /exactly one persisted/);
  await assert.rejects(readFile(join(root, "not-created.events.jsonl")));
  const path = join(root, "session.jsonl");
  const header = JSON.stringify({ type: "session", id: session.id });
  await writeFile(path, header); await assert.rejects(existingAgentTaskSessionPath(session), /exactly one persisted/);
  const output = (text: string) => `${header}\n${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;
  await writeFile(path, output("wrong raw")); await assert.rejects(existingAgentTaskSessionPath(session), /exactly one persisted/);
  await writeFile(path, output("failed raw")); assert.equal(await existingAgentTaskSessionPath(session), path);
  await writeFile(join(root, "duplicate.jsonl"), output("failed raw")); await assert.rejects(existingAgentTaskSessionPath(session), /exactly one persisted/);
});


test("read-safe JSON package reconstructs all Unicode and metadata with bounded indexed parts", async () => {
  const root = await mkdtemp(join(tmpdir(), "outcome-package-")); const path = join(root, "outcome.json");
  const value = { category: "outcomes", observations: [{ text: 'Evidence\n"quoted" 😀 中文'.repeat(70000), matched: false, target: null }], metadata: { final: "retain" } };
  const packet = await writeReadSafeJsonPackage(path, value, "Outcome observations only");
  assert.ok(packet.evidencePaths.length > 2);
  const whitelist = new Set([packet.indexPath, ...packet.evidencePaths]);
  const collect = async (p: string): Promise<string> => {
    assert.ok(whitelist.has(p)); const body = await readFile(p, "utf8"); assert.ok(Buffer.byteLength(body) < 45000);
    const node = JSON.parse(body); if (typeof node.payload === "string") return node.payload;
    let result = ""; for (const entry of node.entries) { assert.equal(digest(await readFile(entry.path, "utf8")), entry.sha256); result += await collect(entry.path); } return result;
  };
  const restored = await collect(path); assert.equal(digest(restored), packet.completeJsonSha256); assert.deepEqual(JSON.parse(restored), value);
  await writeFile(packet.evidencePaths[0]!, "corrupted"); await assert.rejects(collect(path));
  const small = join(root, "small.json"); assert.deepEqual((await writeReadSafeJsonPackage(small, { literal: null }, "small")).evidencePaths, []); assert.deepEqual(JSON.parse(await readFile(small, "utf8")), { literal: null });
  await assert.rejects(writeReadSafeJsonPackage(join(root, "oversize-metadata.json"), value, "x".repeat(50000)), /metadata exceeds/);
});
