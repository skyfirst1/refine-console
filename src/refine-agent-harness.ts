import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, normalize, resolve } from "node:path";
import type { AgentTaskOptions, AgentTaskResult, AgentTaskUsage } from "./agent-task-runner.js";
import { readAgentEventProvenance, requiredReadInstruction, runAgentTask } from "./agent-task-runner.js";
import { pipelineRuleLeaks, stripPipelineOnlyLines } from "./refine-workflow.js";
import { refineAgentCard, type PinnedRefineAgentCard, type RefineRoleId } from "./refine-agent-cards.js";
import { runRefineExpertEvaluation, type ExpertAgentCallRecord, type RefineExpertScoreArtifact } from "./refine-expert-pipeline.js";
import { ACONTEXT_FAILURE_CARD_DIGEST, runHarnessSelfCheck, type AdapterProvenance, type HarnessSelfCheckSummary, type HarnessSelfCheckRunner } from "./refine-harness-self-check.js";
import { readSourceProvenance } from "./source-provenance.js";

export type GoldSkillRunner = (options: AgentTaskOptions) => Promise<AgentTaskResult>;

export interface GoldSkillRefineOptions {
  cwd: string;
  provider: string;
  model: string;
  requirementsPath: string;
  goldPath: string;
  activeSkillPath: string;
  activeSkillVersion: string;
  rulesPath: string;
  runRoot: string;
  timeoutMs: number;
  extensionPaths?: string[];
  runner?: GoldSkillRunner;
}

export type ExpertReport = RefineExpertScoreArtifact;

export interface SkillFinding {
  id: string;
  type: "wrong" | "incomplete" | "over_simplified";
  skillSpan: string;
  effect: string;
  evidenceAspectIds: string[];
  patchAction: "delete" | "rewrite" | "add" | "narrow_scope";
  proposedText: string;
  confidence: "high" | "medium" | "low";
}

export interface SkillReview {
  schemaVersion: "1.0";
  documentGaps: Array<{ id: string; summary: string; expertAspectIds: string[] }>;
  skillFindings: SkillFinding[];
  uncertainties: string[];
}

export interface IndependentJudge {
  schemaVersion: "1.0";
  verdict: "improved" | "regressed" | "indistinguishable";
  hardPassCurrent: boolean;
  hardPassCandidate: boolean;
  reason: string;
}

export interface PromotionDecision {
  schemaVersion: "1.0";
  decision: "promote" | "reject";
  activeSkillMutated: false;
  expert: {
    scoreMetric: "f1";
    currentScore: number;
    candidateScore: number;
    scoreDelta: number;
    hardPassCurrent: boolean;
    hardPassCandidate: boolean;
    gatePassed: boolean;
  };
  judge: IndependentJudge | null;
  requiredConditions: Array<"hasAttributedFindings" | "expertScoreNotRegressed" | "expertHardPassPreserved" | "candidateExpertHardPass">;
  judgeAdvisory: { blocking: false; artifactAvailable: boolean; failure?: string };
  reasons: string[];
  selfEvolutionTrigger: "not-triggered" | "triggered" | "failed";
}

interface StageRecord {
  order: number;
  stage: string;
  kind: "agent" | "private-expert" | "deterministic-tool";
  status: "completed" | "failed";
  taskId: string;
  parentTaskId: string;
  parentRunId: string;
  attempt: number;
  card: Pick<PinnedRefineAgentCard, "roleId" | "version" | "digest" | "runtime" | "embeddedSkill"> & { promptDigest: string; schemaDigest: string; toolDigest: string };
  provider: string | null;
  model: string | null;
  toolAllowlist: readonly string[];
  inputRefs: string[];
  outputRefs: string[];
  inputArtifacts: Array<{ path: string; sha256: string }>;
  outputArtifacts: Array<{ path: string; sha256: string }>;
  eventsPath: string | null;
  readPaths: string[];
  usage: AgentTaskUsage | null;
  eventProvenance?: NonNullable<AgentTaskResult["eventProvenance"]>;
  attempts?: Array<{ attempt: number; taskId: string; eventsPath: string; status: "completed" | "failed"; error?: string; eventProvenance?: NonNullable<AgentTaskResult["eventProvenance"]>; adapterProvenance?: AdapterProvenance }>;
  error?: string;
  skippedReason?: "no-attributed-findings";
  adapter?: { id: string; version: string };
  adapterProvenance?: AdapterProvenance;
  subtasks?: ExpertAgentCallRecord[];
}

export interface GoldSkillRefineResult {
  runId: string;
  runDirectory: string;
  statePath: string;
  manifestPath: string;
  status: "waiting" | "promoted" | "rejected" | "failed";
  nextStage: GoldSkillAgentStage | null;
  completedStages: string[];
  artifacts: Record<string, string>;
  stageArtifacts: Record<string, string>;
  descriptionPath?: string;
  draftPath?: string;
  reviewPath?: string;
  candidateSkillPath?: string;
  candidateDraftPath?: string;
  expertCurrentPath?: string;
  expertCandidatePath?: string;
  judgePath?: string;
  promotionDecisionPath?: string;
  selfCheck?: HarnessSelfCheckSummary;
}

export const REFINE_AGENT_GOLD_SKILL_STAGES = Object.freeze([
  "description-reconstruction",
  "current-draft-generation",
  "reviewer-private-expert",
  "skill-attribution-review",
  "candidate-skill-compilation",
  "candidate-draft-generation",
  "candidate-private-expert",
  "independent-judge",
  "promotion-decision",
] as const);
export const REFINE_CANONICAL_STAGE_SEQUENCE = REFINE_AGENT_GOLD_SKILL_STAGES;

export type GoldSkillAgentStage = (typeof REFINE_AGENT_GOLD_SKILL_STAGES)[number];

interface GoldSkillAgentState {
  schemaVersion: "1.0";
  runId: string;
  runDirectory: string;
  manifestPath: string;
  statePath: string;
  startedAt: string;
  status: GoldSkillRefineResult["status"];
  nextStage: GoldSkillAgentStage | null;
  context: Omit<GoldSkillRefineOptions, "runner" | "extensionPaths"> & { extensionPaths?: string[] };
  parentTaskId: string;
  records: StageRecord[];
  artifacts: Record<string, string>;
  judgeFailure?: { status: "unavailable"; message: string; failedStage: "independent-judge" };
  selfCheck?: HarnessSelfCheckSummary;
}

export interface GoldSkillRefineStepOptions {
  runDirectory: string;
  stage: GoldSkillAgentStage;
  runner?: GoldSkillRunner;
  selfCheckRunner?: HarnessSelfCheckRunner;
}

function sha256(value: string | Uint8Array): string {
  const hash = createHash("sha256");
  return (typeof value === "string" ? hash.update(value, "utf8") : hash.update(value)).digest("hex");
}

function cardEvidence(card: PinnedRefineAgentCard): StageRecord["card"] {
  return {
    roleId: card.roleId,
    version: card.version,
    digest: card.digest,
    runtime: card.runtime,
    embeddedSkill: card.embeddedSkill,
    promptDigest: sha256(card.systemPrompt),
    schemaDigest: sha256(JSON.stringify({ inputContract: card.inputContract, outputContract: card.outputContract })),
    toolDigest: sha256(JSON.stringify(card.tools)),
  };
}

async function artifactEvidence(paths: readonly string[]): Promise<Array<{ path: string; sha256: string }>> {
  return Promise.all(paths.map(async (path) => ({ path, sha256: sha256(await readFile(path)) })));
}

function assertExactReads(actual: readonly string[], expected: readonly string[], stage: string): void {
  const key = (path: string) => normalize(resolve(path)).toLowerCase();
  const got = new Set(actual.map(key));
  const wanted = new Set(expected.map(key));
  const missing = [...wanted].filter((path) => !got.has(path));
  const unexpected = [...got].filter((path) => !wanted.has(path));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(stage + " read contract failed; missing=" + (missing.map((path) => basename(path)).join(",") || "none")
      + "; unexpected=" + (unexpected.join(",") || "none"));
  }
}

function marked(text: string, start: string, end: string, label: string): string {
  const lines = text.split(/\r?\n/);
  const standaloneStarts = lines.filter((line) => line.trim() === start).length;
  const standaloneEnds = lines.filter((line) => line.trim() === end).length;
  if (standaloneStarts > 1 || standaloneEnds > 1) {
    throw new Error(label + " returned duplicate standalone markers");
  }
  const from = lines.findIndex((line) => line.trim() === start);
  const to = lines.findIndex((line, index) => index > from && line.trim() === end);
  let value: string;
  if (from >= 0 && to > from) {
    value = lines.slice(from + 1, to).join("\n").trim();
  } else {
    const starts = text.split(start).length - 1;
    const ends = text.split(end).length - 1;
    const startIndex = text.indexOf(start);
    const endIndex = text.indexOf(end, startIndex + start.length);
    if (starts !== 1 || ends !== 1 || startIndex < 0 || endIndex <= startIndex) {
      throw new Error(label + " did not return complete standalone markers");
    }
    value = text.slice(startIndex + start.length, endIndex).trim();
  }
  if ([...value].length < 8) throw new Error(label + " returned an empty artifact");
  return value;
}

function structuredPayload(text: string, start: string, end: string, label: string): string {
  try {
    return marked(text, start, end, label);
  } catch (markerError) {
    const trimmed = text.trim();
    const fencedBlocks = [...trimmed.matchAll(/```json\s*([\s\S]*?)\s*```/gi)];
    if (fencedBlocks.length === 1 && fencedBlocks[0]?.[1]) return fencedBlocks[0][1].trim();
    const unfenced = trimmed.startsWith("```json") && trimmed.endsWith("```")
      ? trimmed.slice("```json".length, -3).trim()
      : trimmed;
    if (unfenced.startsWith("{") && unfenced.endsWith("}")) return unfenced;
    const objects: string[] = [];
    let startIndex = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < trimmed.length; index += 1) {
      const character = trimmed[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        if (depth === 0) startIndex = index;
        depth += 1;
      } else if (character === "}" && depth > 0) {
        depth -= 1;
        if (depth === 0 && startIndex >= 0) {
          const candidate = trimmed.slice(startIndex, index + 1);
          try {
            JSON.parse(candidate);
            objects.push(candidate);
          } catch {
            // A malformed object is not a structured payload candidate.
          }
          startIndex = -1;
        }
      }
    }
    if (objects.length === 1) return objects[0]!;
    throw markerError;
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + " must be an object");
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(label + " must be a non-empty string");
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(label + " must be boolean");
  return value;
}

function validateReview(value: unknown, expertIds: ReadonlySet<string>): SkillReview {
  const root = object(value, "Skill review");
  if (root.schemaVersion !== "1.0") throw new Error("Skill review schemaVersion is invalid");
  if (!Array.isArray(root.documentGaps) || !Array.isArray(root.skillFindings) || !Array.isArray(root.uncertainties)) {
    throw new Error("Skill review arrays are invalid");
  }
  if (root.skillFindings.length > 5) throw new Error("Reviewer may return at most five strongest Skill findings");
  const gaps = root.documentGaps.map((entry, index) => {
    const item = object(entry, "document gap " + index);
    if (!Array.isArray(item.expertAspectIds) || item.expertAspectIds.some((id) => !expertIds.has(String(id)))) {
      throw new Error("document gap contains unknown Expert aspect");
    }
    return { id: string(item.id, "gap id"), summary: string(item.summary, "gap summary"), expertAspectIds: [...item.expertAspectIds] as string[] };
  });
  const ids = new Set<string>();
  const findings = root.skillFindings.map((entry, index) => {
    const item = object(entry, "skill finding " + index);
    const id = string(item.id, "finding id");
    if (ids.has(id)) throw new Error("Skill finding ids must be unique");
    ids.add(id);
    if (!["wrong", "incomplete", "over_simplified"].includes(String(item.type))
      || !["delete", "rewrite", "add", "narrow_scope"].includes(String(item.patchAction))
      || !["high", "medium", "low"].includes(String(item.confidence))
      || !Array.isArray(item.evidenceAspectIds)
      || item.evidenceAspectIds.some((aspectId) => !expertIds.has(String(aspectId)))) {
      throw new Error("Skill finding is invalid or contains an unknown optional Expert reference");
    }
    return {
      id,
      type: item.type as SkillFinding["type"],
      skillSpan: string(item.skillSpan, "finding skillSpan"),
      effect: string(item.effect, "finding effect"),
      evidenceAspectIds: [...item.evidenceAspectIds] as string[],
      patchAction: item.patchAction as SkillFinding["patchAction"],
      proposedText: string(item.proposedText, "finding proposedText"),
      confidence: item.confidence as SkillFinding["confidence"],
    };
  });
  if (!root.uncertainties.every((item) => typeof item === "string")) throw new Error("uncertainties must be strings");
  return { schemaVersion: "1.0", documentGaps: gaps, skillFindings: findings, uncertainties: [...root.uncertainties] as string[] };
}

function parseReviewProtocol(text: string): unknown {
  const documentGaps: unknown[] = [];
  const skillFindings: unknown[] = [];
  const uncertainties: string[] = [];
  for (const sourceLine of text.split(/\r?\n/)) {
    const line = sourceLine.trim().replace(/^[-*]\s+/, "");
    if (line.startsWith("GAP|")) {
      const [, id, aspectList, ...summaryParts] = line.split("|");
      documentGaps.push({
        id,
        summary: summaryParts.join("|"),
        expertAspectIds: (aspectList ?? "").split(",").map((item) => item.trim()).filter(Boolean),
      });
    } else if (line.startsWith("FINDING|")) {
      const [, id, type, aspectList, patchAction, confidence, skillSpan, effect, ...proposedParts] = line.split("|");
      skillFindings.push({
        id,
        type,
        skillSpan,
        effect,
        evidenceAspectIds: (aspectList ?? "").split(",").map((item) => item.trim()).filter(Boolean),
        patchAction,
        proposedText: proposedParts.join("|"),
        confidence,
      });
    } else if (line.startsWith("UNCERTAINTY|")) {
      uncertainties.push(line.slice("UNCERTAINTY|".length).trim());
    }
  }
  if (documentGaps.length === 0 && skillFindings.length === 0 && uncertainties.length === 0) {
    throw new Error("Reviewer returned no GAP, FINDING, or UNCERTAINTY protocol lines");
  }
  return { schemaVersion: "1.0", documentGaps, skillFindings, uncertainties };
}

function validateJudge(value: unknown): IndependentJudge {
  const root = object(value, "Judge");
  if (root.schemaVersion !== "1.0" || !["improved", "regressed", "indistinguishable"].includes(String(root.verdict))) {
    throw new Error("Judge identity or verdict is invalid");
  }
  return {
    schemaVersion: "1.0",
    verdict: root.verdict as IndependentJudge["verdict"],
    hardPassCurrent: boolean(root.hardPassCurrent, "Judge hardPassCurrent"),
    hardPassCandidate: boolean(root.hardPassCandidate, "Judge hardPassCandidate"),
    reason: string(root.reason, "Judge reason"),
  };
}

class StructuredStageFailure extends Error {
  constructor(message: string, readonly record: StageRecord) { super(message); this.name = "StructuredStageFailure"; }
}

async function invokeTextAgent(options: {
  context: GoldSkillRefineOptions;
  runner: GoldSkillRunner;
  runId: string;
  runDirectory: string;
  parentTaskId: string;
  order: number;
  stage: string;
  roleId: RefineRoleId;
  kind?: StageRecord["kind"];
  inputRefs: string[];
  outputPath: string;
  startMarker: string;
  endMarker: string;
  prompt: string;
  transform?: (text: string) => string;
  allowBareJson?: boolean;
  adapter?: { id: string; version: string };
}): Promise<{ value: string; record: StageRecord }> {
  const card = refineAgentCard(options.roleId);
  const boundaryAdapter = outputAdapter(options.stage, options.adapter);
  const taskId = options.runId + ":" + options.stage + ":attempt-1";
  const eventsPath = join(options.runDirectory, options.stage + ".events.jsonl");
  let run: AgentTaskResult | undefined;
  try {
    run = await options.runner({
      cwd: options.context.cwd,
      provider: options.context.provider,
      model: options.context.model,
      ...(options.context.extensionPaths ? { extensionPaths: options.context.extensionPaths } : {}),
      timeoutMs: options.context.timeoutMs,
      rawEventsPath: eventsPath,
      trace: {
        taskId,
        name: card.name,
        runId: options.runId,
        stage: options.stage,
        inputRefs: options.inputRefs,
        outputRefs: [options.outputPath],
        attributes: {
          "agent.card.role_id": card.roleId,
          "agent.card.version": card.version,
          "agent.card.digest": card.digest,
          "agent.parent.task_id": options.parentTaskId,
          "agent.attempt": 1,
          ...(options.adapter ? { "review.adapter": options.adapter.id } : {}),
        },
      },
      systemPrompt: requiredReadInstruction(options.inputRefs) + "\n\n" + card.systemPrompt,
      prompt: options.prompt,
    });
    if (run.stopReason === "length") throw new Error(options.stage + " output was truncated");
    if (run.sessionId || run.sessionDir) throw new Error(options.stage + " must run as an independent no-session task");
    assertExactReads(run.readPaths, options.inputRefs, options.stage);
    const raw = options.allowBareJson
      ? structuredPayload(run.finalText, options.startMarker, options.endMarker, options.stage)
      : marked(run.finalText, options.startMarker, options.endMarker, options.stage);
    const value = options.transform ? options.transform(raw) : raw;
    await writeFile(options.outputPath, value + "\n", "utf8");
    return {
      value,
      record: {
        order: options.order,
        stage: options.stage,
        kind: options.kind ?? "agent",
        status: "completed",
        taskId,
        parentTaskId: options.parentTaskId,
        parentRunId: options.runId,
        attempt: 1,
        card: cardEvidence(card),
        provider: options.context.provider,
        model: options.context.model,
        toolAllowlist: ["read"],
        inputRefs: options.inputRefs,
        outputRefs: [options.outputPath],
        inputArtifacts: await artifactEvidence(options.inputRefs),
        outputArtifacts: await artifactEvidence([options.outputPath]),
        eventsPath: run.rawEventsPath,
        readPaths: run.readPaths,
        usage: run.usage,
        ...(run.eventProvenance ? { eventProvenance: run.eventProvenance } : {}),
        adapterProvenance: boundaryAdapter,
        ...(options.adapter ? { adapter: options.adapter } : {}),
      },
    };
  } catch (error) {
    if (error instanceof StructuredStageFailure) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const provenance = run?.eventProvenance ?? await readAgentEventProvenance(eventsPath);
    const failedEventsPath = run?.rawEventsPath ?? eventsPath;
    throw new StructuredStageFailure(message, {
      order: options.order,
      stage: options.stage,
      kind: options.kind ?? "agent",
      status: "failed",
      taskId,
      parentTaskId: options.parentTaskId,
      parentRunId: options.runId,
      attempt: 1,
      card: cardEvidence(card),
      provider: options.context.provider,
      model: options.context.model,
      toolAllowlist: ["read"],
      inputRefs: options.inputRefs,
      outputRefs: [options.outputPath],
      inputArtifacts: await artifactEvidence(options.inputRefs),
      outputArtifacts: [],
      eventsPath: failedEventsPath,
      readPaths: run?.readPaths ?? [],
      usage: run?.usage ?? null,
      ...(provenance ? { eventProvenance: provenance } : {}),
      attempts: [{
        attempt: 1,
        taskId,
        eventsPath: failedEventsPath,
        status: "failed",
        error: message,
        ...(provenance ? { eventProvenance: provenance } : {}),
        adapterProvenance: boundaryAdapter,
      }],
      error: message,
      adapterProvenance: boundaryAdapter,
      ...(options.adapter ? { adapter: options.adapter } : {}),
    });
  }
}

async function invokeJsonAgent<T>(options: Parameters<typeof invokeTextAgent>[0] & {
  validate: (value: unknown) => T;
  parseText?: (text: string) => unknown;
}): Promise<{ value: T; record: StageRecord }> {
  let lastError = "unknown validation error";
  let lastFailedRecord: StageRecord | undefined;
  const attempts: NonNullable<StageRecord["attempts"]> = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const suffix = attempt === 1 ? "" : "-attempt-" + attempt;
    const outputPath = options.outputPath;
    try {
      const result = await invokeTextAgent({
        ...options,
        allowBareJson: !options.parseText,
        stage: options.stage + suffix,
        prompt: (attempt > 1 ? "上次输出未通过结构校验：" + lastError + "。重新完整读取相同输入并返回合法 JSON。\n" : "") + options.prompt,
        transform: (raw) => JSON.stringify(options.validate(
          options.parseText ? options.parseText(raw) : JSON.parse(raw),
        ), null, 2),
      });
      attempts.push({ attempt, taskId: result.record.taskId, eventsPath: result.record.eventsPath ?? "", status: "completed", ...(result.record.eventProvenance ? { eventProvenance: result.record.eventProvenance } : {}), adapterProvenance: result.record.adapterProvenance ?? outputAdapter(options.stage, options.adapter) });
      result.record.stage = options.stage;
      result.record.attempt = attempt;
      result.record.attempts = attempts;
      return { value: JSON.parse(result.value) as T, record: result.record };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      const structuredRecord = error instanceof StructuredStageFailure ? error.record : undefined;
      lastFailedRecord = structuredRecord;
      const failedEventsPath = structuredRecord?.eventsPath ?? join(options.runDirectory, options.stage + suffix + ".events.jsonl");
      const eventProvenance = structuredRecord?.eventProvenance ?? await readAgentEventProvenance(failedEventsPath);
      attempts.push({
        attempt,
        taskId: structuredRecord?.taskId ?? options.runId + ":" + options.stage + suffix + ":attempt-1",
        eventsPath: failedEventsPath,
        status: "failed",
        error: lastError,
        ...(eventProvenance ? { eventProvenance } : {}),
        adapterProvenance: outputAdapter(options.stage, options.adapter),
      });
    }
  }
  const card = refineAgentCard(options.roleId); const terminal = attempts.at(-1)!; const adapterProvenance = outputAdapter(options.stage, options.adapter);
  throw new StructuredStageFailure(options.stage + " failed after 3 attempts: " + lastError, {
    order: options.order, stage: options.stage, kind: options.kind ?? "agent", status: "failed", taskId: options.runId + ":" + options.stage,
    parentTaskId: options.parentTaskId, parentRunId: options.runId, attempt: terminal.attempt, card: cardEvidence(card), provider: options.context.provider, model: options.context.model,
    toolAllowlist: ["read"], inputRefs: options.inputRefs, outputRefs: [options.outputPath], inputArtifacts: await artifactEvidence(options.inputRefs), outputArtifacts: [],
    eventsPath: terminal.eventsPath, readPaths: lastFailedRecord?.readPaths ?? [], usage: lastFailedRecord?.usage ?? null, ...(terminal.eventProvenance ? { eventProvenance: terminal.eventProvenance } : {}), attempts, error: lastError,
    adapterProvenance, ...(options.adapter ? { adapter: options.adapter } : {}),
  });
}

async function runExpert(options: {
  context: GoldSkillRefineOptions;
  runner: GoldSkillRunner;
  runId: string;
  runDirectory: string;
  parentTaskId: string;
  order: number;
  stage: string;
  descriptionPath: string;
  goldPath: string;
  candidatePath: string;
  goldAspectSetPath: string;
  evaluationId: "current" | "candidate";
  expectedGoldAspectSetSha256?: string;
  outputPath: string;
}): Promise<{ report: ExpertReport; record: StageRecord; artifacts: Record<string, string> }> {
  const result = await runRefineExpertEvaluation({
    cwd: options.context.cwd, provider: options.context.provider, model: options.context.model, timeoutMs: options.context.timeoutMs,
    ...(options.context.extensionPaths ? { extensionPaths: options.context.extensionPaths } : {}), runner: options.runner,
    runId: options.runId, runDirectory: options.runDirectory, parentTaskId: `${options.runId}:${options.stage}`,
    evaluationId: options.evaluationId, descriptionPath: options.descriptionPath, goldPath: options.goldPath,
    documentPath: options.candidatePath, goldAspectSetPath: options.goldAspectSetPath,
    ...(options.expectedGoldAspectSetSha256 ? { expectedGoldAspectSetSha256: options.expectedGoldAspectSetSha256 } : {}), outputPath: options.outputPath,
  });
  const inputRefs = options.evaluationId === "current"
    ? [options.descriptionPath, options.goldPath, options.candidatePath]
    : [options.descriptionPath, options.candidatePath, options.goldAspectSetPath];
  const outputRefs = [options.outputPath, ...(result.goldExtracted ? [result.goldAspectSetPath] : []), result.documentAspectSetPath, result.recallMatchesPath, result.precisionMatchesPath, result.evidenceAlignmentsPath];
  return {
    report: result.report,
    record: {
      order: options.order, stage: options.stage, kind: "deterministic-tool", status: "completed",
      taskId: `${options.runId}:${options.stage}`, parentTaskId: options.parentTaskId, parentRunId: options.runId, attempt: 1,
      card: cardEvidence(refineAgentCard("refine.agent")), provider: null, model: null, toolAllowlist: [],
      inputRefs, outputRefs, inputArtifacts: await artifactEvidence(inputRefs), outputArtifacts: await artifactEvidence(outputRefs),
      eventsPath: null, readPaths: [], usage: null, subtasks: result.calls,
    },
    artifacts: {
      goldAspectSetPath: result.goldAspectSetPath,
      [`${options.evaluationId}DocumentAspectSetPath`]: result.documentAspectSetPath,
      [`${options.evaluationId}RecallMatchesPath`]: result.recallMatchesPath,
      [`${options.evaluationId}PrecisionMatchesPath`]: result.precisionMatchesPath,
      [`${options.evaluationId}EvidenceAlignmentsPath`]: result.evidenceAlignmentsPath,
    },
  };
}
const unavailableAdapter = (): AdapterProvenance => ({ availability: "unavailable", id: null, version: null, digest: null });
const outputAdapter = (stage: string, adapter?: { id: string; version: string }): AdapterProvenance => { const id = adapter?.id ?? `refine-agent-output-boundary:${stage}`; const version = adapter?.version ?? "v1"; return { availability: "available", id, version, digest: sha256(JSON.stringify({ id, version })) }; };
function completeAdapters(records: StageRecord[]): StageRecord[] { for (const record of records) { record.adapterProvenance ??= unavailableAdapter(); for (const attempt of record.attempts ?? []) attempt.adapterProvenance ??= record.adapterProvenance; } return records; }

export async function runRefineDraftAgent(options: {
  cwd: string;
  provider: string;
  model: string;
  timeoutMs: number;
  extensionPaths?: string[];
  runner?: GoldSkillRunner;
  descriptionPath: string;
  skillPath: string;
  outputPath: string;
  runDirectory?: string;
  traceStage?: string;
}): Promise<{ draftPath: string; record: StageRecord }> {
  const runId = "draft-" + randomUUID();
  const runDirectory = resolve(options.runDirectory ?? join(dirname(resolve(options.outputPath)), ".draft-" + runId));
  await mkdir(runDirectory, { recursive: true });
  const descriptionPath = resolve(options.descriptionPath);
  const skillPath = resolve(options.skillPath);
  const outputPath = resolve(options.outputPath);
  const context: GoldSkillRefineOptions = {
    cwd: resolve(options.cwd), provider: options.provider, model: options.model, timeoutMs: options.timeoutMs,
    requirementsPath: "", goldPath: "", activeSkillPath: skillPath, activeSkillVersion: "standalone",
    rulesPath: "", runRoot: runDirectory,
    ...(options.extensionPaths ? { extensionPaths: options.extensionPaths } : {}),
    ...(options.runner ? { runner: options.runner } : {}),
  };
  const output = await invokeTextAgent({
    context, runner: options.runner ?? runAgentTask, runId, runDirectory, parentTaskId: runId + ":current-pi-session", order: 1,
    stage: options.traceStage ?? "current-draft-generation", roleId: "refine.draft", inputRefs: [descriptionPath, skillPath], outputPath,
    startMarker: "<<<DRAFT_START>>>", endMarker: "<<<DRAFT_END>>>",
    prompt: "完整读取 Description " + descriptionPath + " 与 Skill " + skillPath
      + "。动笔前提取 Description 明确要求的内容槽位及已给具体值，并冻结其明定的章节/分组、顺序、枚举成员和归属。严格使用该 Skill 生成完整 Draft，但凝练、压缩、统一结构或语域清理只能改变呈现层并删除重复与元叙述，不得新增、删除、合并、改挂这些结构或成员，也不得用‘等’‘相关格式’‘中性输出’等泛化表达替代。交付前逐项核对内容合同，再检查术语、专名和实体的全文规范写法。禁止读取 Gold 或其他文件。只输出唯一一组标记。\n<<<DRAFT_START>>>\n（完整 Markdown）\n<<<DRAFT_END>>>",
  });
  return { draftPath: outputPath, record: output.record };
}

function coordinatorResult(state: GoldSkillAgentState): GoldSkillRefineResult {
  const artifact = (name: string): string | undefined => state.artifacts[name];
  const descriptionPath = artifact("descriptionPath");
  const draftPath = artifact("draftPath");
  const reviewPath = artifact("reviewPath");
  const candidateSkillPath = artifact("candidateSkillPath");
  const candidateDraftPath = artifact("candidateDraftPath");
  const expertCurrentPath = artifact("expertCurrentPath");
  const expertCandidatePath = artifact("expertCandidatePath");
  const judgePath = artifact("judgePath");
  const promotionDecisionPath = artifact("promotionDecisionPath");
  return {
    runId: state.runId,
    runDirectory: state.runDirectory,
    statePath: state.statePath,
    manifestPath: state.manifestPath,
    status: state.status,
    nextStage: state.nextStage,
    completedStages: state.records.filter((record) => record.status === "completed").map((record) => record.stage),
    artifacts: { ...state.artifacts },
    stageArtifacts: { ...state.artifacts },
    ...(descriptionPath ? { descriptionPath } : {}),
    ...(draftPath ? { draftPath } : {}),
    ...(reviewPath ? { reviewPath } : {}),
    ...(candidateSkillPath ? { candidateSkillPath } : {}),
    ...(candidateDraftPath ? { candidateDraftPath } : {}),
    ...(expertCurrentPath ? { expertCurrentPath } : {}),
    ...(expertCandidatePath ? { expertCandidatePath } : {}),
    ...(judgePath ? { judgePath } : {}),
    ...(promotionDecisionPath ? { promotionDecisionPath } : {}),
    ...(state.selfCheck ? { selfCheck: state.selfCheck } : {}),
  };
}

async function persistCoordinator(state: GoldSkillAgentState): Promise<void> {
  const context = state.context;
  const externalInputs = await artifactEvidence([
    context.requirementsPath,
    context.rulesPath,
    context.goldPath,
    context.activeSkillPath,
  ]);
  completeAdapters(state.records);
  const parentCard = refineAgentCard("refine.agent");
  const sourceProvenance = await readSourceProvenance(context.cwd, "refine-agent-harness-v1");
  const manifest = {
    schemaVersion: "1.0",
    harnessVersion: "refine-agent-harness-v1",
    sourceProvenance,
    workflow: "gold-supervised-skill-refine-agent",
    executionMode: "agent",
    coordinationMode: "current-pi-session-step-tools",
    status: state.status,
    nextStage: state.nextStage,
    runId: state.runId,
    startedAt: state.startedAt,
    completedAt: state.status === "waiting" ? null : new Date().toISOString(),
    parentTask: {
      taskId: state.parentTaskId,
      ownership: "current-pi-session",
      card: cardEvidence(parentCard),
      provider: context.provider,
      model: context.model,
    },
    inputContract: {
      requirementsPath: context.requirementsPath,
      rulesPath: context.rulesPath,
      goldPath: context.goldPath,
      activeSkillPath: context.activeSkillPath,
      activeSkillVersion: context.activeSkillVersion,
      digests: Object.fromEntries(externalInputs.map((item) => [item.path, item.sha256])),
    },
    callableSubagents: parentCard.callableSubagents.map((roleId) => cardEvidence(refineAgentCard(roleId))),
    callableTools: parentCard.tools,
    stages: state.records,
    artifacts: state.artifacts,
    ...(state.judgeFailure ? { judgeAdvisoryStatus: { ...state.judgeFailure, promotionBlocking: false } } : {}),
    activeSkillWrite: { attempted: false, reason: "Candidate remains isolated; this demo never overwrites Active Skill." },
    selfEvolution: state.selfCheck ?? { status: "not-triggered", reason: "candidate-expert-score-not-available", nativeAcontextApi: false, executionPath: "pinned-acontext-failure-card-prompt-compatibility", failureCardDigest: ACONTEXT_FAILURE_CARD_DIGEST },
    baselineBusinessInput: false,
  };
  await writeFile(state.statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  await writeFile(state.manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

export async function initializeGoldSkillRefineAgent(options: GoldSkillRefineOptions): Promise<GoldSkillRefineResult> {
  const startedAt = new Date().toISOString();
  const runId = startedAt.replace(/[:.]/g, "-") + "-" + randomUUID();
  const runRoot = resolve(options.runRoot);
  const runDirectory = join(runRoot, runId);
  await mkdir(runRoot, { recursive: true });
  await mkdir(runDirectory, { recursive: false });
  const state: GoldSkillAgentState = {
    schemaVersion: "1.0",
    runId,
    runDirectory,
    statePath: join(runDirectory, "agent-state.json"),
    manifestPath: join(runDirectory, "manifest.json"),
    startedAt,
    status: "waiting",
    nextStage: "description-reconstruction",
    context: {
      cwd: resolve(options.cwd),
      provider: options.provider,
      model: options.model,
      requirementsPath: resolve(options.requirementsPath),
      goldPath: resolve(options.goldPath),
      activeSkillPath: resolve(options.activeSkillPath),
      activeSkillVersion: options.activeSkillVersion,
      rulesPath: resolve(options.rulesPath),
      runRoot,
      timeoutMs: options.timeoutMs,
      ...(options.extensionPaths ? { extensionPaths: options.extensionPaths.map((path) => resolve(path)) } : {}),
    },
    parentTaskId: runId + ":refine-agent-session",
    records: [],
    artifacts: {},
  };
  await persistCoordinator(state);
  return coordinatorResult(state);
}
async function rejectNoOp(state: GoldSkillAgentState, reviewPath: string, expertCurrentPath: string): Promise<void> {
  const promotionDecisionPath = join(state.runDirectory, "promotion-decision.json");
  const decision = {
    schemaVersion: "1.0",
    decision: "reject",
    activeSkillMutated: false,
    reasons: ["no-attributed-skill-findings"],
    evaluationSkipped: ["candidate-skill-compilation", "candidate-draft-generation", "candidate-private-expert", "independent-judge"],
    selfEvolutionTrigger: "not-triggered",
  };
  await writeFile(promotionDecisionPath, JSON.stringify(decision, null, 2) + "\n", "utf8");
  state.records.push({
    order: state.records.length + 1,
    stage: "promotion-decision",
    kind: "deterministic-tool",
    status: "completed",
    taskId: state.runId + ":promotion-decision:no-op",
    parentTaskId: state.parentTaskId,
    parentRunId: state.runId,
    attempt: 1,
    card: cardEvidence(refineAgentCard("refine.agent")),
    provider: null,
    model: null,
    toolAllowlist: [],
    inputRefs: [reviewPath, expertCurrentPath],
    outputRefs: [promotionDecisionPath],
    inputArtifacts: await artifactEvidence([reviewPath, expertCurrentPath]),
    outputArtifacts: await artifactEvidence([promotionDecisionPath]),
    eventsPath: null,
    readPaths: [],
    usage: null,
    skippedReason: "no-attributed-findings",
  });
  state.artifacts.promotionDecisionPath = promotionDecisionPath;
  state.selfCheck = { status: "not-triggered", reason: "candidate-expert-score-not-available", nativeAcontextApi: false, executionPath: "pinned-acontext-failure-card-prompt-compatibility", failureCardDigest: ACONTEXT_FAILURE_CARD_DIGEST };
  state.status = "rejected";
  state.nextStage = null;
}

export async function advanceGoldSkillRefineAgent(options: GoldSkillRefineStepOptions): Promise<GoldSkillRefineResult> {
  const runDirectory = resolve(options.runDirectory);
  const statePath = join(runDirectory, "agent-state.json");
  const state = JSON.parse(await readFile(statePath, "utf8")) as GoldSkillAgentState;
  if (state.runDirectory !== runDirectory || state.statePath !== statePath) throw new Error("Refine Agent state is not bound to this run directory");
  if (state.status !== "waiting" || !state.nextStage) throw new Error("Refine Agent run is already complete");
  if (options.stage !== state.nextStage) throw new Error("Expected next Refine Agent stage " + state.nextStage + ", received " + options.stage);
  const context: GoldSkillRefineOptions = { ...state.context, ...(options.runner ? { runner: options.runner } : {}) };
  const runner = options.runner ?? runAgentTask;
  const order = state.records.length + 1;
  const descriptionPath = state.artifacts.descriptionPath ?? join(runDirectory, "description.md");
  const draftPath = state.artifacts.draftPath ?? join(runDirectory, "draft.md");
  const expertCurrentPath = state.artifacts.expertCurrentPath ?? join(runDirectory, "expert-current.json");
  const reviewPath = state.artifacts.reviewPath ?? join(runDirectory, "skill-review.json");
  const candidateSkillPath = state.artifacts.candidateSkillPath ?? join(runDirectory, "candidate-skill", "SKILL.md");
  const candidateDraftPath = state.artifacts.candidateDraftPath ?? join(runDirectory, "candidate-draft.md");
  const expertCandidatePath = state.artifacts.expertCandidatePath ?? join(runDirectory, "expert-candidate.json");
  const goldAspectSetPath = state.artifacts.goldAspectSetPath ?? join(runDirectory, "gold-aspects.json");
  const judgePath = state.artifacts.judgePath ?? join(runDirectory, "independent-judge.json");

  try { switch (options.stage) {
    case "description-reconstruction": { const output = await invokeTextAgent({
      context, runner, runId: state.runId, runDirectory, parentTaskId: state.parentTaskId, order,
      stage: options.stage, roleId: "refine.description", inputRefs: [context.requirementsPath, context.rulesPath],
      outputPath: descriptionPath, startMarker: "<<<DESCRIPTION_START>>>", endMarker: "<<<DESCRIPTION_END>>>",
      prompt: "完整读取 requirements/trace " + context.requirementsPath + " 与 rules " + context.rulesPath
        + "，重构最终任务 Description。只在标记内输出 Markdown。\n<<<DESCRIPTION_START>>>\n（Markdown）\n<<<DESCRIPTION_END>>>",
      transform: (value) => { const stripped = stripPipelineOnlyLines(value); if (!stripped.text || pipelineRuleLeaks(stripped.text).length > 0) throw new Error("Description contains pipeline-only rules"); return stripped.text; },
    }); state.records.push(output.record); state.artifacts.descriptionPath = descriptionPath; state.nextStage = "current-draft-generation"; break; }
    case "current-draft-generation": { const output = await invokeTextAgent({
      context, runner, runId: state.runId, runDirectory, parentTaskId: state.parentTaskId, order,
      stage: options.stage, roleId: "refine.draft", inputRefs: [descriptionPath, context.activeSkillPath],
      outputPath: draftPath, startMarker: "<<<DRAFT_START>>>", endMarker: "<<<DRAFT_END>>>",
      prompt: "完整读取 Description " + descriptionPath + " 与 Active Skill " + context.activeSkillPath
        + "。动笔前提取 Description 明确要求的内容槽位及已给具体值，并冻结其明定的章节/分组、顺序、枚举成员和归属。严格使用该 Skill 生成完整 Draft，但凝练、压缩、统一结构或语域清理只能改变呈现层并删除重复与元叙述，不得新增、删除、合并、改挂这些结构或成员，也不得用‘等’‘相关格式’‘中性输出’等泛化表达替代。交付前逐项核对内容合同，再检查术语、专名和实体的全文规范写法。禁止读取 Gold 或其他文件。只输出唯一一组标记内的 Markdown。\n<<<DRAFT_START>>>\n（完整 Markdown）\n<<<DRAFT_END>>>",
    }); state.records.push(output.record); state.artifacts.draftPath = draftPath; state.nextStage = "reviewer-private-expert"; break; }
    case "reviewer-private-expert": { const output = await runExpert({
      context, runner, runId: state.runId, runDirectory, parentTaskId: state.parentTaskId, order,
      stage: options.stage, descriptionPath, goldPath: context.goldPath, candidatePath: draftPath, goldAspectSetPath, evaluationId: "current", outputPath: expertCurrentPath,
    }); state.records.push(output.record); state.artifacts.expertCurrentPath = expertCurrentPath; Object.assign(state.artifacts, output.artifacts); state.nextStage = "skill-attribution-review"; break; }
    case "skill-attribution-review": {
      const currentExpert = JSON.parse(await readFile(expertCurrentPath, "utf8")) as ExpertReport;
      const expertIds = new Set(currentExpert.gaps.map((gap) => gap.id));
      const output = await invokeJsonAgent({
        context, runner, runId: state.runId, runDirectory, parentTaskId: state.parentTaskId, order,
        stage: options.stage, roleId: "refine.review",
        inputRefs: [descriptionPath, draftPath, context.goldPath, context.activeSkillPath, expertCurrentPath], outputPath: reviewPath,
        startMarker: "<<<SKILL_REVIEW_START>>>", endMarker: "<<<SKILL_REVIEW_END>>>",
        prompt: "完整读取 Description、Draft、Gold、Active Skill 与私有 ExPerT 报告："
          + [descriptionPath, draftPath, context.goldPath, context.activeSkillPath, expertCurrentPath].join(" | ")
          + "。先完整观察 Draft↔Gold 的整体 overall style 与 content style，再从全部观察中筛选最多 5 条最强 Finding，不先用 ExPerT gap 缩小观察池。ExPerT 只作可选辅助证据，不是准入门；GAP 与 FINDING 的 aspect-ids 可留空。content style 包括段落功能、信息选择顺序、组织顺序、展开粒度、信息密度、论证/证据呈现方式和前后呼应；surface style 包括语气、句式、格式、标题和术语。允许把 Gold 展示的方法抽象为 gold-observed reusable style/content-style pattern，但只有 Description 明确要求的字段才可成为当前任务内容槽位，不能把 Gold 独有的具体输出格式、产品属性、专业事实、几何机制或事实清单抽象为 Skill。即使 Description 给出具体领域分类或判据值，Finding 也只能保留“从 Description 提炼统一判据并复用”的方法，不能固化具体值。提交 Finding 前做盲执行检查：不知道 Gold 专有事实、只持有 Description 与通用写作方法时仍可执行，并且删去具体领域示例和判据值后方法仍完整，才可保留；否则进入 UNCERTAINTY。每条 Finding 的 effect/proposedText 必须写明适用条件与非回归边界：Description 明定的章节/分组、顺序、枚举成员和归属只能改变呈现层，不能新增、删除、合并或改挂；没有此类合同的任务不强行冻结结构。Skill Finding 不要求 Active Skill 中已有一条直接反向规则：如果 style/content-style gap 是跨样本可复用、可由写作流程预防的行为，而 Active Skill 缺少该保障，应归因为 incomplete + add，并用 skillSpan 明确标为缺失规则及建议插入位置。"
          + "Gold 独有实体、数字、日期、专名、产品事实、具体事实值、原句及其缺失必须忽略或进入 uncertainty，绝不能写入 proposedText；仍禁止臆造事实。Finding 的 effect 与 proposedText 必须描述可用于同类型未见样本的通用方法，而非复制、近似改写或编码 Gold 内容。证据不足时可以少于 3 条或没有 Finding，不得凑数。不要输出 JSON；不要在字段内使用竖线。只按单行协议输出："
          + "GAP|gap-id|可选aspect-ids|差异摘要；FINDING|finding-id|wrong或incomplete或over_simplified|可选aspect-ids|delete或rewrite或add或narrow_scope|high或medium或low|Skill原文定位或缺失规则插入点|跨任务影响|通用候选指令；UNCERTAINTY|无法归因说明。"
          + "标记内只能放协议行。\n<<<SKILL_REVIEW_START>>>\nGAP|gap-1|aspect-1|摘要\nUNCERTAINTY|说明\n<<<SKILL_REVIEW_END>>>",
        validate: (value) => validateReview(value, expertIds), parseText: parseReviewProtocol,
        adapter: { id: "gold-skill-attribution-reviewer", version: "v1" },
      });
      state.records.push(output.record); state.artifacts.reviewPath = reviewPath;
      if (output.value.skillFindings.length === 0) await rejectNoOp(state, reviewPath, expertCurrentPath);
      else state.nextStage = "candidate-skill-compilation";
      break;
    }
    case "candidate-skill-compilation": {
      const activeSkill = await readFile(context.activeSkillPath, "utf8");
      await mkdir(join(runDirectory, "candidate-skill"), { recursive: true });
      const output = await invokeTextAgent({
        context, runner, runId: state.runId, runDirectory, parentTaskId: state.parentTaskId, order,
        stage: options.stage, roleId: "refine.policy-optimizer", inputRefs: [context.activeSkillPath, reviewPath], outputPath: candidateSkillPath,
        startMarker: "<<<CANDIDATE_SKILL_START>>>", endMarker: "<<<CANDIDATE_SKILL_END>>>",
        prompt: "完整读取 Active Skill " + context.activeSkillPath + " 与 Skill Review " + reviewPath
          + "。仅应用 skillFindings 中跨样本可复用的 style/content-style 方法，生成最小且连贯的 Candidate Skill；跳过任何样本事实或具体句子。编译前扫描整份 Skill 中与每条 Finding 等价、冲突或存在优先级关系的规则，为该方法选择唯一规范落点；优先在最接近的既有原则做 line-local 合并，必要时改写或删除旧冲突，其他章节不得近义重复追加。每一处变更都必须直接对应某条 Finding。任何压缩、简洁或统一结构规则必须保留 Description 明确要求的内容槽位及其已给具体值。保留 frontmatter、来源注释、文件索引、无关章节和无冲突原文，不得顺手清理、泛化或重写；只有确无合适位置时才新增一条紧凑规则。不能机械 append-only，也不能为每条 Finding 追加长章节；不得把多条 Finding 挤进一个难读的超长句，必要时在同一既有原则下使用少量短子项。禁止读取 Gold，禁止只输出 delta。"
          + "只在唯一一组标记内输出完整 Candidate SKILL.md。\n<<<CANDIDATE_SKILL_START>>>\n（完整 SKILL.md）\n<<<CANDIDATE_SKILL_END>>>",
        transform: (candidate) => { if ([...candidate].length < Math.floor([...activeSkill].length * 0.5)) throw new Error("Candidate Skill is not a complete Skill"); return candidate; },
      }); state.records.push(output.record); state.artifacts.candidateSkillPath = candidateSkillPath; state.nextStage = "candidate-draft-generation"; break;
    }
    case "candidate-draft-generation": { const output = await invokeTextAgent({
      context, runner, runId: state.runId, runDirectory, parentTaskId: state.parentTaskId, order,
      stage: options.stage, roleId: "refine.draft", inputRefs: [descriptionPath, candidateSkillPath], outputPath: candidateDraftPath,
      startMarker: "<<<CANDIDATE_DRAFT_START>>>", endMarker: "<<<CANDIDATE_DRAFT_END>>>",
      prompt: "完整读取 Description " + descriptionPath + " 与 Candidate Skill " + candidateSkillPath
        + "。先提取 Description 明确要求的内容槽位及已给具体值，并冻结其明定的章节/分组、顺序、枚举成员和归属。严格使用 Candidate Skill 重新生成完整文档，但凝练、压缩、统一结构或语域清理只能改变呈现层并删除重复与元叙述，不得新增、删除、合并、改挂这些结构或成员，也不得用‘等’‘相关格式’‘中性输出’等泛化表达替代。交付前逐项核对内容合同，再检查术语、专名和实体的全文规范写法。禁止读取 Gold、原 Draft、Review 或 Expert。只在唯一一组标记内输出 Markdown。\n<<<CANDIDATE_DRAFT_START>>>\n（完整 Markdown）\n<<<CANDIDATE_DRAFT_END>>>",
    }); state.records.push(output.record); state.artifacts.candidateDraftPath = candidateDraftPath; state.nextStage = "candidate-private-expert"; break; }
    case "candidate-private-expert": { const currentExpert = JSON.parse(await readFile(expertCurrentPath, "utf8")) as ExpertReport; const output = await runExpert({
      context, runner, runId: state.runId, runDirectory, parentTaskId: state.parentTaskId, order,
      stage: options.stage, descriptionPath, goldPath: context.goldPath, candidatePath: candidateDraftPath, goldAspectSetPath, evaluationId: "candidate", expectedGoldAspectSetSha256: currentExpert.sourceInputs.goldAspectSetSha256, outputPath: expertCandidatePath,
    }); state.records.push(output.record); state.artifacts.expertCandidatePath = expertCandidatePath; Object.assign(state.artifacts, output.artifacts); state.nextStage = "independent-judge"; break; }
    case "independent-judge": {
      try {
        const output = await invokeJsonAgent({
          context, runner, runId: state.runId, runDirectory, parentTaskId: state.parentTaskId, order,
          stage: options.stage, roleId: "refine.judge", inputRefs: [descriptionPath, context.goldPath, draftPath, candidateDraftPath], outputPath: judgePath,
          startMarker: "<<<JUDGE_START>>>", endMarker: "<<<JUDGE_END>>>",
          prompt: "完整读取 Description " + descriptionPath + "、Gold " + context.goldPath + "、Current Draft " + draftPath + "、Candidate Draft " + candidateDraftPath
            + "。独立判断 Candidate 相对 Current 是 improved、regressed 或 indistinguishable，并分别判断硬性要求是否通过；Gold 独有、未被 Description 要求的事实差异只能作为背景，不能单独判定 Candidate 退化；保持 verdict 与 hard-pass 判定语义不变。reason 依次简洁写明 Description 明定结构/枚举归属是否保持、overall/content-style 收益或退化、强制槽位及已给具体值的保持或退化、surface quality 问题、最终综合判断。只陈述四份文档可见差异；不读取 Review 或 Candidate Skill，不得推断 Skill 规则与 Draft 执行的因果。只在唯一一组标记内输出一个 JSON：{\"schemaVersion\":\"1.0\",\"verdict\":\"improved|regressed|indistinguishable\",\"hardPassCurrent\":false,\"hardPassCandidate\":false,\"reason\":\"Description structure/roster: ...；overall/content-style: ...；Description slots: ...；surface quality: ...；综合判断: ...\"}。\n<<<JUDGE_START>>>\n{}\n<<<JUDGE_END>>>",
          validate: validateJudge,
        });
        state.records.push(output.record); state.artifacts.judgePath = judgePath;
      } catch (error) {
        if (!(error instanceof StructuredStageFailure)) throw error;
        state.records.push(error.record);
        state.judgeFailure = { status: "unavailable", message: error.message, failedStage: "independent-judge" };
      }
      state.nextStage = "promotion-decision";
      break;
    }
    case "promotion-decision": {
      const [review, currentExpert, candidateExpert, judge] = await Promise.all([
        readFile(reviewPath, "utf8").then((value) => JSON.parse(value) as SkillReview),
        readFile(expertCurrentPath, "utf8").then((value) => JSON.parse(value) as ExpertReport),
        readFile(expertCandidatePath, "utf8").then((value) => JSON.parse(value) as ExpertReport),
        state.judgeFailure ? Promise.resolve(null) : readFile(judgePath, "utf8").then((value) => JSON.parse(value) as IndependentJudge),
      ]);
      const scoreDelta = candidateExpert.f1 - currentExpert.f1;
      const expertGate = scoreDelta >= 0 && !(currentExpert.hardPass && !candidateExpert.hardPass) && candidateExpert.hardPass;
      const reasons: string[] = [];
      if (review.skillFindings.length === 0) reasons.push("no-attributed-skill-findings");
      if (scoreDelta < 0) reasons.push("expert-score-regressed");
      if (currentExpert.hardPass && !candidateExpert.hardPass) reasons.push("expert-hard-pass-regressed");
      if (!candidateExpert.hardPass) reasons.push("expert-candidate-hard-pass-failed");
      const decision: PromotionDecision = {
        schemaVersion: "1.0", decision: review.skillFindings.length > 0 && expertGate ? "promote" : "reject",
        activeSkillMutated: false,
        expert: { scoreMetric: "f1", currentScore: currentExpert.f1, candidateScore: candidateExpert.f1, scoreDelta, hardPassCurrent: currentExpert.hardPass, hardPassCandidate: candidateExpert.hardPass, gatePassed: expertGate },
        judge,
        requiredConditions: ["hasAttributedFindings", "expertScoreNotRegressed", "expertHardPassPreserved", "candidateExpertHardPass"],
        judgeAdvisory: { blocking: false, artifactAvailable: judge !== null, ...(state.judgeFailure ? { failure: state.judgeFailure.message } : {}) },
        reasons, selfEvolutionTrigger: scoreDelta < 0 ? "triggered" : "not-triggered",
      };
      const promotionDecisionPath = join(runDirectory, "promotion-decision.json");
      await writeFile(promotionDecisionPath, JSON.stringify(decision, null, 2) + "\n", "utf8");
      const promotionInputPaths = [reviewPath, candidateSkillPath, expertCurrentPath, expertCandidatePath, ...(judge ? [judgePath] : [])];
      state.records.push({ order, stage: options.stage, kind: "deterministic-tool", status: "completed", taskId: state.runId + ":promotion-decision", parentTaskId: state.parentTaskId, parentRunId: state.runId, attempt: 1,
        card: cardEvidence(refineAgentCard("refine.agent")), provider: null, model: null, toolAllowlist: [],
        inputRefs: promotionInputPaths, outputRefs: [promotionDecisionPath],
        inputArtifacts: await artifactEvidence(promotionInputPaths), outputArtifacts: await artifactEvidence([promotionDecisionPath]), eventsPath: null, readPaths: [], usage: null });
      state.artifacts.promotionDecisionPath = promotionDecisionPath;
      state.status = decision.decision === "promote" ? "promoted" : "rejected";
      state.nextStage = null;
      state.selfCheck = { status: "not-triggered", reason: "pending-score-comparison", nativeAcontextApi: false, executionPath: "pinned-acontext-failure-card-prompt-compatibility", failureCardDigest: ACONTEXT_FAILURE_CARD_DIGEST };
      await persistCoordinator(state);
      state.selfCheck = scoreDelta < 0
        ? await runHarnessSelfCheck({
          cwd: context.cwd, provider: context.provider, model: context.model, timeoutMs: context.timeoutMs,
          ...(context.extensionPaths ? { extensionPaths: context.extensionPaths } : {}),
          runner: options.selfCheckRunner ?? runner, runId: state.runId, runDirectory, manifestPath: state.manifestPath,
          currentF1: currentExpert.f1, candidateF1: candidateExpert.f1, stages: state.records, artifacts: state.artifacts,
          sourceKind: "current-refine-run",
        })
        : { status: "not-triggered", reason: "no-candidate-expert-regression", nativeAcontextApi: false, executionPath: "pinned-acontext-failure-card-prompt-compatibility", failureCardDigest: ACONTEXT_FAILURE_CARD_DIGEST };
      break;
    }
  } } catch (error) {
    if (!(error instanceof StructuredStageFailure)) throw error;
    state.records.push(error.record); state.status = "failed"; state.nextStage = null; await persistCoordinator(state); throw error;
  }
  await persistCoordinator(state);
  return coordinatorResult(state);
}
