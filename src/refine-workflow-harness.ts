import { WorkflowControlError, type UnsentAttemptIdentity, type ResumeControlEvidence } from "./workflow-control.js";
import {importFrozenGoldAspects,type FrozenGoldAspectSet} from './refine-frozen-gold-aspects.js';
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, normalize, resolve } from "node:path";
import type { AgentTaskOptions, AgentTaskResult, AgentTaskUsage } from "./agent-task-runner.js";
import { parseAgentTaskEvents, readAgentEventProvenance, requiredReadInstruction, runAgentTask } from "./agent-task-runner.js";
import { pipelineRuleLeaks, stripPipelineOnlyLines } from "./refine-workflow.js";
import { refineWorkflowCard, type PinnedRefineWorkflowCard, type RefineWorkflowRoleId } from "./refine-workflow-cards.js";
import {
  runRefineExpertEvaluation,
  ExpertPipelineError,
  type ExpertAgentCallRecord,
  type ExpertGap,
  type RefineExpertScoreArtifact,
} from "./refine-expert-pipeline.js";
import { ACONTEXT_FAILURE_CARD_DIGEST, runHarnessSelfCheck, type AdapterProvenance, type HarnessSelfCheckSummary } from "./refine-harness-self-check.js";
import { runRefineTaskBehaviorAudit } from "./refine-behavior-audit.js";
import { readSourceProvenance } from "./source-provenance.js";
import {
  renderRefineHarnessScope,
  resolveRefineHarnessProfile,
  type EvolvableRefineRoleId,
  type RefineHarnessProfile,
} from "./refine-harness-profile.js";

export type RefineHarnessRunner = (options: AgentTaskOptions) => Promise<AgentTaskResult>;

export type RefineExpertReport = RefineExpertScoreArtifact;
export type { ExpertGap } from "./refine-expert-pipeline.js";

const INDEPENDENT_JUDGE_VERSION = "v4" as const;

export interface DocumentGap {
  id: string;
  summary: string;
  draftEvidence: string;
  draftCounterevidence: string;
  goldEvidence: string;
  expertRefs: string[];
  sourceAvailability: "description-provided" | "genre-convention" | "gold-observed-reusable-style" | "gold-evidence-only";
  activeSkillRelation: "new" | "refinement" | "duplicate" | "conflict";
  nearestActiveSkillRule: string;
  descriptionSupport: string;
  descriptionConflict: string;
  certainty: "supported" | "uncertain";
  descriptionCompatibility: "compatible" | "conflict";
}

export interface SkillFinding {
  id: string;
  summary: string;
  attribution: string;
  evidenceRefs: string[];
  activeSkillRelation: "new" | "refinement" | "duplicate" | "conflict";
  nearestActiveSkillRule: string;
  descriptionSupport: string;
  descriptionConflict: string;
}

export interface ReviewUncertainty { id: string; summary: string; reason: string; evidenceRefs: string[] }

export interface RefineReviewArtifact {
  schemaVersion: "1.0";
  sourceInputs: {
    descriptionSha256: string;
    draftSha256: string;
    goldSha256: string;
    activeSkillSha256: string;
    expertReportSha256: string;
  };
  /** Historical field name: this is the broad observation pool, including screened non-gap observations. */
  documentGaps: DocumentGap[];
  skillFindings: SkillFinding[];
  uncertainties: ReviewUncertainty[];
}

export interface RefineJudgeArtifact {
  schemaVersion: "1.0";
  evaluator: { id: "pi-independent-judge"; version: typeof INDEPENDENT_JUDGE_VERSION };
  sourceInputs: { descriptionSha256: string; goldSha256: string; draftSha256: string; candidateDraftSha256: string };
  verdict: "improved" | "regressed" | "inconclusive";
  currentScore: number;
  candidateScore: number;
  currentHardPass: boolean;
  candidateHardPass: boolean;
  slotChecks: Array<{
    id: string;
    scope: "opening" | "section" | "conclusion" | "cross-document";
    descriptionRequirement: string;
    currentEvidence: string;
    candidateEvidence: string;
    status: "preserved" | "improved" | "regressed" | "missing-both" | "not-required";
  }>;
  regressions: Array<{
    id: string;
    category: "description-slot" | "content-style" | "surface-quality" | "internal-consistency";
    slotCheckIds: string[];
    summary: string;
    descriptionEvidence: string;
    currentEvidence: string;
    candidateEvidence: string;
  }>;
  reason: string;
}

export interface PromotionDecision {
  schemaVersion: "1.0";
  decision: "promote" | "reject";
  activeSkillOverwritten: false;
  expertScoreMetric: "f1";
  expertScoreDelta: number;
  gates: {
    skillChanged: boolean;
    hasAttributedFindings: boolean;
    expertImproved: boolean;
    expertHardPassPreserved: boolean;
    judgeImproved: boolean;
    judgeHardPassPreserved: boolean;
  };
  requiredGates: Array<"skillChanged" | "hasAttributedFindings" | "expertImproved" | "expertHardPassPreserved">;
  judgeAdvisory: {
    blocking: false;
    artifactAvailable: boolean;
    verdict: RefineJudgeArtifact["verdict"] | null;
    scoreDelta: number | null;
    hardPassPreserved: boolean | null;
  };
  reasons: string[];
  evidence: {
    activeSkillSha256: string;
    candidateSkillSha256: string;
    draftExpertSha256: string;
    candidateExpertSha256: string;
    judgeSha256: string | null;
  };
  judgeFailure?: { status: "unavailable"; reason: string; sessionId: string | null; turns: number };
}

export interface RefineWorkflowOptions {
  cwd: string;
  provider: string;
  model: string;
  requirementsPath: string;
  goldPath: string;
  activeSkillPath: string;
  rulesPath: string;
  runRoot: string;
  timeoutMs: number;
  extensionPaths?: string[];
  runner?: RefineHarnessRunner;
  executionMode?: "workflow";
  taskType?: string;
  harnessProfile?: RefineHarnessProfile;
  resumeRunDirectory?: string;
  resumeUnsentAttempts?: UnsentAttemptIdentity[];
  resumeControlEvidence?: ResumeControlEvidence;
  frozenDescriptionPath?: string;
  frozenGoldAspectSet?: FrozenGoldAspectSet;
  auxiliaryDiagnostics?: "automatic" | "deferred-for-controlled-experiment";
}

export interface RefineWorkflowResult {
  runId: string;
  runDirectory: string;
  manifestPath: string;
  status: "promoted" | "rejected";
  descriptionPath: string;
  draftPath: string;
  reviewPath: string;
  candidateSkillPath: string;
  candidateDraftPath?: string;
  draftExpertReportPath: string;
  candidateExpertReportPath?: string;
  judgePath?: string;
  promotionDecisionPath: string;
  goldAspectSetPath: string;
  selfCheck: HarnessSelfCheckSummary;
  stageArtifacts: Record<string, string>;
}

export const REFINE_CANONICAL_STAGE_SEQUENCE = Object.freeze([
  "description-reconstruction",
  "current-draft-generation",
  "draft-expert-evaluation",
  "skill-review",
  "candidate-skill-compilation",
  "candidate-draft-generation",
  "candidate-expert-evaluation",
  "independent-judge",
  "promotion-decision",
] as const);

interface StageRecord {
  order: number;
  stage: string;
  kind: "agent" | "deterministic-tool";
  status: "completed" | "failed";
  taskId: string;
  parentTaskId: string;
  parentRunId: string;
  attempt: number;
  card: Pick<PinnedRefineWorkflowCard, "roleId" | "version" | "digest" | "runtime" | "embeddedSkill"> & { promptDigest: string; schemaDigest: string; toolDigest: string };
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
  adapterProvenance?: AdapterProvenance;
  attempts?: Array<{ attempt: number; taskId: string; eventsPath: string; status: "completed" | "failed"; phase?: "preparation" | "revision" | "submission"; error?: string; readPaths: string[]; usage: AgentTaskUsage | null; eventProvenance?: NonNullable<AgentTaskResult["eventProvenance"]>; adapterProvenance?: AdapterProvenance }>;
  session?: { id: string; dir: string };
  skippedReason?: "no-attributed-findings";
  subtasks?: ExpertAgentCallRecord[];
}

class WorkflowStageError extends Error {
  constructor(message: string, readonly stageRecord: StageRecord) {
    super(message);
    this.name = "WorkflowStageError";
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function cardEvidence(card: PinnedRefineWorkflowCard): StageRecord["card"] {
  return { roleId: card.roleId, version: card.version, digest: card.digest, runtime: card.runtime, embeddedSkill: card.embeddedSkill,
    promptDigest: sha256(card.systemPrompt), schemaDigest: sha256(JSON.stringify({ inputContract: card.inputContract, outputContract: card.outputContract })), toolDigest: sha256(JSON.stringify(card.tools)) };
}
const unavailableAdapter = (): AdapterProvenance => ({ availability: "unavailable", id: null, version: null, digest: null });
const outputAdapter = (stage: string): AdapterProvenance => { const id = `refine-workflow-output-boundary:${stage}`; const version = "v1"; return { availability: "available", id, version, digest: sha256(JSON.stringify({ id, version })) }; };
function completeAdapters(records: StageRecord[]): StageRecord[] { for (const record of records) { record.adapterProvenance ??= unavailableAdapter(); for (const attempt of record.attempts ?? []) attempt.adapterProvenance ??= record.adapterProvenance; } return records; }

async function artifactEvidence(paths: readonly string[]): Promise<Array<{ path: string; sha256: string }>> {
  return Promise.all(paths.map(async (path) => ({ path, sha256: sha256(await readFile(path)) })));
}

function assertExactReads(actual: readonly string[], expected: readonly string[], stage: string): void {
  const key = (path: string) => normalize(resolve(path)).toLowerCase();
  const got = new Set(actual.map(key));
  const wanted = new Set(expected.map(key));
  const missing = [...wanted].filter((path) => !got.has(path));
  const unexpected = [...got].filter((path) => !wanted.has(path));
  if (missing.length || unexpected.length) {
    throw new Error(`${stage} read contract failed; missing=${missing.map((path) => basename(path)).join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`);
  }
}

function marked(text: string, start: string, end: string, label: string): string {
  // Some providers expose their visible preamble in the same text block and
  // occasionally attach the opening sentinel to its final sentence. The
  // sentinels still unambiguously delimit the public artifact, so keep the
  // adapter strict about both tokens while discarding everything outside them.
  const from = text.indexOf(start);
  const to = from < 0 ? -1 : text.indexOf(end, from + start.length);
  if (from < 0 || to <= from) throw new Error(`${label} did not return complete standalone markers`);
  const value = text.slice(from + start.length, to).trim();
  if ([...value].length < 8) throw new Error(`${label} returned an empty or implausibly short artifact`);
  return value;
}

function sumUsage(target: AgentTaskUsage, source: AgentTaskUsage): void {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "costUsd"] as const) target[key] += source[key];
}

async function invokeArtifactAgent(options: {
  context: RefineWorkflowOptions;
  runner: RefineHarnessRunner;
  runId: string;
  runDirectory: string;
  parentTaskId: string;
  order: number;
  stage: string;
  roleId: Exclude<RefineWorkflowRoleId, "refine.workflow">;
  inputRefs: string[];
  outputPath: string;
  startMarker: string;
  endMarker: string;
  prompt: string;
  transform?: (text: string) => string;
  retries?: number;
}): Promise<{ value: string; record: StageRecord }> {
  const card = refineWorkflowCard(options.roleId);
  const adapterProvenance = outputAdapter(options.stage);
  const attempts: NonNullable<StageRecord["attempts"]> = [];
  const aggregate: AgentTaskUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 };
  let lastError = "unknown failure";
  let lastRun: AgentTaskResult | undefined;
  const maximum = options.retries ?? 1;
  for (let attempt = 1; attempt <= maximum; attempt += 1) {
    const taskId = `${options.runId}:${options.stage}:attempt-${attempt}`;
    const eventsPath = join(options.runDirectory, attempt === 1 ? `${options.stage}.events.jsonl` : `${options.stage}-attempt-${attempt}.events.jsonl`);
    let run: AgentTaskResult | undefined;
    try {
      run = await options.runner({
        cwd: options.context.cwd, provider: options.context.provider, model: options.context.model,
        ...(options.context.extensionPaths ? { extensionPaths: options.context.extensionPaths } : {}),
        timeoutMs: options.context.timeoutMs, rawEventsPath: eventsPath,
        trace: {
          taskId, name: card.name, runId: options.runId, stage: options.stage,
          inputRefs: options.inputRefs, outputRefs: [options.outputPath],
          attributes: {
            "agent.card.role_id": card.roleId, "agent.card.version": card.version,
            "agent.card.digest": card.digest, "agent.parent.task_id": options.parentTaskId, "agent.attempt": attempt,
          },
        },
        systemPrompt: `${requiredReadInstruction(options.inputRefs)}\n\n${effectiveSystemPrompt(options.context, card)}`,
        prompt: effectiveStagePrompt(options.context, card.roleId, `${attempt > 1 ? `上一次输出未通过校验：${lastError}。重新完整读取输入并纠正格式。\n` : ""}${options.prompt}`),
      });
      lastRun = run;
      sumUsage(aggregate, run.usage);
      if (run.stopReason === "length") throw new Error(`${card.roleId} output was truncated`);
      if (run.sessionId || run.sessionDir) throw new Error(`${card.roleId} must run as an independent --no-session task`);
      assertExactReads(run.readPaths, options.inputRefs, card.name);
      const raw = marked(run.finalText, options.startMarker, options.endMarker, card.name);
      const value = options.transform ? options.transform(raw) : raw;
      await writeFile(options.outputPath, `${value}\n`, "utf8");
      attempts.push({ attempt, taskId, eventsPath: run.rawEventsPath, status: "completed", readPaths: run.readPaths, usage: run.usage, ...(run.eventProvenance ? { eventProvenance: run.eventProvenance } : {}), adapterProvenance });
      return {
        value,
        record: {
          order: options.order, stage: options.stage, kind: "agent", status: "completed", taskId,
          parentTaskId: options.parentTaskId, parentRunId: options.runId, attempt,
          card: cardEvidence(card), provider: options.context.provider, model: options.context.model,
          toolAllowlist: ["read"], inputRefs: options.inputRefs, outputRefs: [options.outputPath],
          inputArtifacts: await artifactEvidence(options.inputRefs), outputArtifacts: await artifactEvidence([options.outputPath]),
          eventsPath: run.rawEventsPath, readPaths: run.readPaths, usage: aggregate, ...(run.eventProvenance ? { eventProvenance: run.eventProvenance } : {}), adapterProvenance,
          ...(maximum > 1 ? { attempts } : {}),
        },
      };
    } catch (error) {
    if (error instanceof WorkflowControlError) throw error;
      lastError = error instanceof Error ? error.message : String(error);
      const eventProvenance = run?.eventProvenance ?? await readAgentEventProvenance(eventsPath);
      attempts.push({ attempt, taskId, eventsPath: run?.rawEventsPath ?? eventsPath, status: "failed", error: lastError, readPaths: run?.readPaths ?? [], usage: run?.usage ?? null, ...(eventProvenance ? { eventProvenance } : {}), adapterProvenance });
    }
  }
  const message = `${card.name} failed after ${maximum} attempt(s): ${lastError}`;
  throw new WorkflowStageError(message, {
    order: options.order, stage: options.stage, kind: "agent", status: "failed", taskId: `${options.runId}:${options.stage}`,
    parentTaskId: options.parentTaskId, parentRunId: options.runId, attempt: attempts.length,
    card: cardEvidence(card), provider: options.context.provider, model: options.context.model, toolAllowlist: ["read"],
    inputRefs: options.inputRefs, outputRefs: [], inputArtifacts: await artifactEvidence(options.inputRefs), outputArtifacts: [],
    eventsPath: attempts.at(-1)?.eventsPath ?? null, readPaths: lastRun?.readPaths ?? [], usage: aggregate,
    ...(attempts.at(-1)?.eventProvenance ? { eventProvenance: attempts.at(-1)!.eventProvenance } : {}), attempts, adapterProvenance,
  });
}

function resolvedRoleOverlay(context: RefineWorkflowOptions, roleId: RefineWorkflowRoleId) {
  if (!context.harnessProfile || !context.taskType) return null;
  const profile = resolveRefineHarnessProfile(context.harnessProfile, context.taskType);
  if (!profile) return null;
  const overlay = profile.roles.find((item) => item.roleId === roleId as EvolvableRefineRoleId);
  return overlay ? { profile, overlay } : null;
}

function effectiveSystemPrompt(context: RefineWorkflowOptions, card: PinnedRefineWorkflowCard): string {
  const resolved = resolvedRoleOverlay(context, card.roleId);
  if (!resolved || resolved.overlay.surface === "prompt") return card.systemPrompt;
  const surfaceLabel = resolved.overlay.surface === "agent_card" ? "Agent Card" : "Role Skill";
  return `${card.systemPrompt}\n\n任务族 Harness Profile（${surfaceLabel} 单一修改面）：\n${renderRefineHarnessScope(resolved.profile, resolved.overlay)}\n执行指令：${resolved.overlay.instruction}`;
}

function effectiveStagePrompt(context: RefineWorkflowOptions, roleId: RefineWorkflowRoleId, prompt: string): string {
  const resolved = resolvedRoleOverlay(context, roleId);
  if (!resolved || resolved.overlay.surface !== "prompt") return prompt;
  return `${prompt}\n\n任务族 Prompt Overlay：\n${renderRefineHarnessScope(resolved.profile, resolved.overlay)}\n执行指令：${resolved.overlay.instruction}`;
}

function harnessProfileSummary(context: RefineWorkflowOptions): { profileId: string; version: string; taskFamily: string; appliedRoles: EvolvableRefineRoleId[] } | null {
  if (!context.harnessProfile || !context.taskType) return null;
  const resolved = resolveRefineHarnessProfile(context.harnessProfile, context.taskType);
  return resolved ? { profileId: resolved.profileId, version: resolved.version, taskFamily: resolved.taskFamily, appliedRoles: resolved.roles.map((role) => role.roleId) } : null;
}

async function invokeReviewAgent(options: {
  context: RefineWorkflowOptions;
  runner: RefineHarnessRunner;
  runId: string;
  runDirectory: string;
  parentTaskId: string;
  order: number;
  inputRefs: string[];
  outputPath: string;
  hashes: RefineReviewArtifact["sourceInputs"];
  expert: RefineExpertReport;
}): Promise<{ value: string; record: StageRecord }> {
  const stage = "skill-review";
  const card = refineWorkflowCard("refine.review");
  const adapterProvenance = outputAdapter(stage);
  const sessionDir = join(options.runDirectory, ".pi-sessions");
  const sessionId = randomUUID();
  await mkdir(sessionDir, { recursive: true });
  const session = { id: sessionId, dir: sessionDir, name: `refine-review-${options.runId.slice(0, 19)}` };
  const sessionReadInstruction = [
    "During the preparation phase, use the read tool to read every required reference file below before the Harness requests the final Review Artifact:",
    ...options.inputRefs.map((path) => `- ${path}`),
    "These are the only external files you may open with read in this session.",
    "If a read fails, report it during preparation instead of inventing evidence.",
    "Once all inputs have been read, semantic-revision, submission, and correction turns reuse this session context and must not mechanically reread the files.",
  ].join("\n");
  const attempts: NonNullable<StageRecord["attempts"]> = [];
  const aggregate: AgentTaskUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 };
  const observedReads = new Set<string>();
  let lastError = "unknown failure";
  let lastRun: AgentTaskResult | undefined;
  let turn = 0;

  const execute = async (phase: "preparation" | "revision" | "submission", prompt: string): Promise<AgentTaskResult> => {
    turn += 1;
    const taskId = `${options.runId}:${stage}:${phase}-turn-${turn}`;
    const eventsPath = join(options.runDirectory, `${stage}-${phase}-turn-${turn}.events.jsonl`);
    let run: AgentTaskResult | undefined;
    try {
      run = await options.runner({
        cwd: options.context.cwd, provider: options.context.provider, model: options.context.model,
        ...(options.context.extensionPaths ? { extensionPaths: options.context.extensionPaths } : {}),
        timeoutMs: options.context.timeoutMs, rawEventsPath: eventsPath, session,
        trace: {
          taskId, name: card.name, runId: options.runId, stage,
          inputRefs: options.inputRefs, outputRefs: phase === "submission" ? [options.outputPath] : [],
          attributes: {
            "agent.card.role_id": card.roleId, "agent.card.version": card.version,
            "agent.card.digest": card.digest, "agent.parent.task_id": options.parentTaskId,
            "agent.turn": turn, "agent.phase": phase, "agent.session_id": sessionId,
          },
        },
        systemPrompt: `${sessionReadInstruction}\n\n${effectiveSystemPrompt(options.context, card)}`,
        prompt: effectiveStagePrompt(options.context, card.roleId, prompt),
      });
      lastRun = run;
      sumUsage(aggregate, run.usage);
      for (const path of run.readPaths) observedReads.add(normalize(resolve(path)).toLowerCase());
      attempts.push({ attempt: turn, taskId, eventsPath: run.rawEventsPath, status: "completed", phase,
        readPaths: run.readPaths, usage: run.usage, ...(run.eventProvenance ? { eventProvenance: run.eventProvenance } : {}), adapterProvenance });
      return run;
    } catch (error) {
    if (error instanceof WorkflowControlError) throw error;
      lastError = error instanceof Error ? error.message : String(error);
      const eventProvenance = run?.eventProvenance ?? await readAgentEventProvenance(eventsPath);
      attempts.push({ attempt: turn, taskId, eventsPath: run?.rawEventsPath ?? eventsPath, status: "failed", phase, error: lastError,
        readPaths: run?.readPaths ?? [], usage: run?.usage ?? null, ...(eventProvenance ? { eventProvenance } : {}), adapterProvenance });
      throw error;
    }
  };

  let prepared = false;
  for (let preparationAttempt = 1; preparationAttempt <= 3 && !prepared; preparationAttempt += 1) {
    try {
      const run = await execute("preparation", preparationAttempt === 1
        ? `完整读取 Description ${options.inputRefs[0]}、Draft ${options.inputRefs[1]}、Gold ${options.inputRefs[2]}、Active Skill ${options.inputRefs[3]} 与私有 ExPerT ${options.inputRefs[4]}。这是第 1/3 轮语义审查，不提交最终 JSON。先从 Description 和文档体裁识别实际需要的功能清单，包括明定的内容槽位、分组、组织关系与交付语域。opening/结论先行、conclusion、跨章节组织只在任务要求或体裁适用时核对，不得向其他体裁强加报告结构。每个适用功能至少核对 Draft 与 Gold 的对应位置；delivered-register 必须实际搜索面向作者的“需说明、应写、按……组织、不得混同”等指令口吻，不能只凭整体印象判定。不要因为先发现两个局部问题就停止。形成不要求凑满的宽候选观察池（最多十条），每条简记位置、Draft 证据、Gold 差异以及可能属于 overall/content-style、surface-style 或 Gold-only。ExPerT 只作辅助。输出简短覆盖清单和第一版候选观察池，最后一行写 REVIEW_ROUND_1_READY。`
        : `继续第 1/3 轮语义审查。上一轮未完成全部指定读取或全文功能覆盖。补齐遗漏文件以及 Description 和体裁实际适用的内容槽位、组织关系与交付语域核对，不强加开篇结论、结尾或跨章节结构；不要提交最终 JSON。输出简短覆盖清单和第一版候选观察池，最后一行写 REVIEW_ROUND_1_READY。`);
      if (run.stopReason === "length") throw new Error(`${card.roleId} preparation was truncated`);
      assertExactReads([...observedReads], options.inputRefs, card.name);
      if (!run.finalText.includes("REVIEW_ROUND_1_READY")) throw new Error("Reviewer round 1 did not confirm whole-document observation coverage");
      prepared = true;
    } catch (error) {
    if (error instanceof WorkflowControlError) throw error;
      lastError = error instanceof Error ? error.message : String(error);
      const latest = attempts.at(-1);
      if (latest?.status === "completed" && latest.phase === "preparation") { latest.status = "failed"; latest.error = lastError; }
    }
  }

  let revised = false;
  if (prepared) {
    for (let revisionAttempt = 1; revisionAttempt <= 3 && !revised; revisionAttempt += 1) {
      try {
        const run = await execute("revision", revisionAttempt === 1
          ? `这是第 2/3 轮语义自我修订。不要重新机械读取文件，使用同一 Agent session 中已经读取的完整上下文，主动反驳并重写第 1 轮候选池，而不是确认原结论。逐条执行：1）回到 Draft 对应章节寻找最强反证，已有同义结构不得误报缺失；2）与 Active Skill 做语义而非字面近邻比较，执行不佳不能包装成 new，近义方法归 duplicate，已有规则缺少关键条件才归 refinement；3）对照 Description，区分任务履约问题与可复用写作方法，Description 冲突项不得编译；4）Gold 提供的产品名、格式名、章节名、事实和本任务枚举只能作为证据，把可迁移的方法改写为不含样本答案的条件化规则；5）证据不足的项改为 uncertain，不能同时保留为 Finding 候选；6）再次检查第一轮是否漏掉实际适用的内容槽位、组织关系或交付语域差异；不适用的开篇结论、结尾或跨章节功能不构成缺失。输出修订后的候选观察池、被删除/降级项及简短理由；不提交最终 JSON，不展示长篇思维过程。最后一行写 REVIEW_ROUND_2_READY。`
          : `继续第 2/3 轮语义自我修订。上一轮没有完成对第一版候选池的反驳、去重、Description 冲突检查、Gold 实例抽象和 uncertainty 降级。完成修订后输出精炼的第二版候选池及删除/降级理由，最后一行写 REVIEW_ROUND_2_READY。`);
        if (run.stopReason === "length") throw new Error(`${card.roleId} revision was truncated`);
        if (!run.finalText.includes("REVIEW_ROUND_2_READY")) throw new Error("Reviewer round 2 did not confirm semantic self-revision");
        revised = true;
      } catch (error) {
    if (error instanceof WorkflowControlError) throw error;
        lastError = error instanceof Error ? error.message : String(error);
        const latest = attempts.at(-1);
        if (latest?.status === "completed" && latest.phase === "revision") { latest.status = "failed"; latest.error = lastError; }
      }
    }
  }

  if (revised) {
    for (let submissionAttempt = 1; submissionAttempt <= 3; submissionAttempt += 1) {
      try {
        const run = await execute("submission", `${submissionAttempt > 1 ? `上一次结构化提交未通过：${lastError}。只纠正 JSON 结构或校验指出的内部一致性问题，不重新发散发现，也不得恢复第 2 轮已经删除或降级的建议；不要解释错误或复述旧输出。\n` : ""}这是第 3/3 轮。基于同一 Agent session 中两轮完整审查后的修订候选池，提交最终 Review；不得恢复第 2 轮已经删除或降级的建议。对每条保留观察写入 Draft 最强反证、Active Skill 语义最近规则以及 Description 支持/冲突。执行不佳不是 new；语义近义是 duplicate。Gold 中的具体产品名、格式名、章节名、事实或枚举只可出现在 evidence，不得进入通用 Finding summary。任务履约问题只有在暴露出 Active Skill 缺失或不完整的方法时才能成为 Finding。sourceAvailability、activeSkillRelation、certainty、descriptionCompatibility 是四个相互独立的判断轴，不能用一个互斥总分类覆盖它们；同一观察可以同时是 Gold-only、duplicate、uncertain。任何被 uncertainty 引用的观察都必须 certainty=uncertain，且不能被 skillFindings 引用。sourceAvailability=gold-evidence-only、activeSkillRelation=duplicate|conflict、descriptionCompatibility=conflict 或 certainty=uncertain 的观察只能留在 observation pool。只有非 Gold-only、activeSkillRelation=new|refinement、certainty=supported 且 descriptionCompatibility=compatible 的观察可收敛为最多五条安全 Finding。descriptionConflict 只记录 Description 明确禁止或无法兼容该方法的冲突：该字段非空时 descriptionCompatibility 必须为 conflict；一般限制、适用条件或反证应写入 draftCounterevidence 或 uncertainty.reason。Description 要求同一边界在正文、对比、结论承担不同功能时，不得收敛成一次定义。submission 不必重新读取文件。\n\n最终回复必须从 { 开始、以 } 结束，只包含一个裸 JSON 对象，不得输出 Markdown 围栏、Artifact 标记、解释、前言或第二个对象。documentGaps 是全部保留观察的池，既包含 supported 也包含 uncertain。已保留的不确定观察须在 documentGaps 中拥有独立 id 和 certainty=uncertain，再由 uncertainties.evidenceRefs 引用；不能为通过校验删除已有不确定观察或借用无关 supported gap。完整枚举：sourceAvailability=description-provided|genre-convention|gold-observed-reusable-style|gold-evidence-only；documentGaps.activeSkillRelation=new|refinement|duplicate|conflict；skillFindings.activeSkillRelation=new|refinement；certainty=supported|uncertain；descriptionCompatibility=compatible|conflict。以下示例只展示其中部分取值，不限制合法范围。完整且内部一致的字段示例（仅示合同，不是任务答案，不要求凑满这些数量；允许空数组；不确定项必须引用实际保留的uncertain观察，不能为了消除错误强改证据判断）：${JSON.stringify(REVIEW_CONTRACT_EXAMPLE)}。`);
        if (run.stopReason === "length") throw new Error(`${card.roleId} output was truncated`);
        const value = validateReviewModelJson(reviewJsonPayload(run.finalText), options.hashes, options.expert);
        await writeFile(options.outputPath, `${value}\n`, "utf8");
        return {
          value,
          record: {
            order: options.order, stage, kind: "agent", status: "completed", taskId: `${options.runId}:${stage}`,
            parentTaskId: options.parentTaskId, parentRunId: options.runId, attempt: turn,
            card: cardEvidence(card), provider: options.context.provider, model: options.context.model,
            toolAllowlist: ["read"], inputRefs: options.inputRefs, outputRefs: [options.outputPath],
            inputArtifacts: await artifactEvidence(options.inputRefs), outputArtifacts: await artifactEvidence([options.outputPath]),
            eventsPath: run.rawEventsPath, readPaths: [...observedReads], usage: aggregate,
            ...(run.eventProvenance ? { eventProvenance: run.eventProvenance } : {}), adapterProvenance, attempts,
            session: { id: sessionId, dir: sessionDir },
          },
        };
      } catch (error) {
    if (error instanceof WorkflowControlError) throw error;
        lastError = error instanceof Error ? error.message : String(error);
        const latest = attempts.at(-1);
        if (latest?.status === "completed" && latest.phase === "submission") { latest.status = "failed"; latest.error = lastError; }
      }
    }
  }

  throw new WorkflowStageError(`${card.name} session could not produce a valid Review Artifact after ${turn} turn(s): ${lastError}`, {
    order: options.order, stage, kind: "agent", status: "failed", taskId: `${options.runId}:${stage}`,
    parentTaskId: options.parentTaskId, parentRunId: options.runId, attempt: turn,
    card: cardEvidence(card), provider: options.context.provider, model: options.context.model, toolAllowlist: ["read"],
    inputRefs: options.inputRefs, outputRefs: [], inputArtifacts: await artifactEvidence(options.inputRefs), outputArtifacts: [],
    eventsPath: attempts.at(-1)?.eventsPath ?? null, readPaths: [...observedReads], usage: aggregate,
    ...(lastRun?.eventProvenance ? { eventProvenance: lastRun.eventProvenance } : {}), attempts, adapterProvenance,
    session: { id: sessionId, dir: sessionDir },
  });
}

function judgeJsonPayload(text: string): string {
  const start = "<<<JUDGE_START>>>";
  const end = "<<<JUDGE_END>>>";
  const from = text.indexOf(start);
  const to = from < 0 ? -1 : text.indexOf(end, from + start.length);
  if (from >= 0 && to > from) return text.slice(from + start.length, to).trim();
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  const objectStart = unfenced.indexOf("{");
  const objectEnd = unfenced.lastIndexOf("}");
  if (objectStart < 0 || objectEnd <= objectStart) throw new Error("Independent Refine Judge did not submit a JSON object");
  return unfenced.slice(objectStart, objectEnd + 1);
}

async function invokeJudgeAgent(options: {
  context: RefineWorkflowOptions;
  runner: RefineHarnessRunner;
  runId: string;
  runDirectory: string;
  parentTaskId: string;
  order: number;
  inputRefs: string[];
  outputPath: string;
  hashes: RefineJudgeArtifact["sourceInputs"];
}): Promise<{ value: string; record: StageRecord }> {
  const stage = "independent-judge";
  const card = refineWorkflowCard("refine.independent-judge");
  const adapterProvenance = outputAdapter(stage);
  const sessionDir = join(options.runDirectory, ".pi-sessions");
  const sessionId = randomUUID();
  await mkdir(sessionDir, { recursive: true });
  const session = { id: sessionId, dir: sessionDir, name: `refine-judge-${options.runId.slice(0, 19)}` };
  const sessionReadInstruction = [
    "During the preparation phase, use the read tool to read every required reference file below before the Harness requests the final Artifact:",
    ...options.inputRefs.map((path) => `- ${path}`),
    "These are the only external files you may open with read in this session.",
    "If a read fails, report it during preparation instead of inventing document evidence.",
    "Once all inputs have been read, later submission or format-correction turns may reuse this session context without mechanically rereading every file.",
  ].join("\n");
  const attempts: NonNullable<StageRecord["attempts"]> = [];
  const aggregate: AgentTaskUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 };
  const observedReads = new Set<string>();
  let lastError = "unknown failure";
  let lastRun: AgentTaskResult | undefined;
  let turn = 0;

  const execute = async (phase: "preparation" | "submission", prompt: string): Promise<AgentTaskResult> => {
    turn += 1;
    const taskId = `${options.runId}:${stage}:${phase}-turn-${turn}`;
    const eventsPath = join(options.runDirectory, phase === "preparation"
      ? `${stage}-preparation-turn-${turn}.events.jsonl`
      : `${stage}-submission-turn-${turn}.events.jsonl`);
    let run: AgentTaskResult | undefined;
    try {
      run = await options.runner({
        cwd: options.context.cwd, provider: options.context.provider, model: options.context.model,
        ...(options.context.extensionPaths ? { extensionPaths: options.context.extensionPaths } : {}),
        timeoutMs: options.context.timeoutMs, rawEventsPath: eventsPath, session,
        trace: {
          taskId, name: card.name, runId: options.runId, stage,
          inputRefs: options.inputRefs, outputRefs: phase === "submission" ? [options.outputPath] : [],
          attributes: {
            "agent.card.role_id": card.roleId, "agent.card.version": card.version,
            "agent.card.digest": card.digest, "agent.parent.task_id": options.parentTaskId,
            "agent.turn": turn, "agent.phase": phase, "agent.session_id": sessionId,
          },
        },
        systemPrompt: `${sessionReadInstruction}\n\n${card.systemPrompt}`,
        prompt,
      });
      lastRun = run;
      sumUsage(aggregate, run.usage);
      for (const path of run.readPaths) observedReads.add(normalize(resolve(path)).toLowerCase());
      attempts.push({ attempt: turn, taskId, eventsPath: run.rawEventsPath, status: "completed", phase,
        readPaths: run.readPaths, usage: run.usage, ...(run.eventProvenance ? { eventProvenance: run.eventProvenance } : {}), adapterProvenance });
      return run;
    } catch (error) {
    if (error instanceof WorkflowControlError) throw error;
      lastError = error instanceof Error ? error.message : String(error);
      const eventProvenance = run?.eventProvenance ?? await readAgentEventProvenance(eventsPath);
      attempts.push({ attempt: turn, taskId, eventsPath: run?.rawEventsPath ?? eventsPath, status: "failed", phase, error: lastError,
        readPaths: run?.readPaths ?? [], usage: run?.usage ?? null, ...(eventProvenance ? { eventProvenance } : {}), adapterProvenance });
      throw error;
    }
  };

  let prepared = false;
  for (let preparationAttempt = 1; preparationAttempt <= 3 && !prepared; preparationAttempt += 1) {
    try {
      await execute("preparation", preparationAttempt === 1
        ? `这是评估准备阶段。使用 read 工具完整读取 Description ${options.inputRefs[0]}、Gold ${options.inputRefs[1]}、Current Draft ${options.inputRefs[2]}、Candidate Draft ${options.inputRefs[3]}，比较两稿相对任务标准的事实、完整性、结构、简洁度、可操作性、边界和硬约束。Gold 独有、未由 Description 提供的事实差异只能作为背景；即使任务要求该内容槽位，也不能要求稿件凭空得知具体值。未知或明确占位与伪造事实分开判断，不以 Gold 独有事实缺失单独判定 Candidate 退化。先建立逐项核对表：覆盖 Description 明定的内容槽位/分组/枚举与已给具体值、交付语域和全篇一致性；opening 与 conclusion 仅按实际任务和体裁判断，不适用时标为 not-required，不强加报告结构，并为 Current 与 Candidate 分别摘录可见证据，不能凭印象写两稿均保留。再列 Candidate 特有 regressions。若 Current 与 Gold 都以开篇核心结论承担结论先行功能，而 Candidate 只在末章保留相同事实，仍记录开篇 content-style 功能丢失。若 Candidate 对同一对象或行为提出不兼容的条件，先核对两处的适用范围与显式限定；只有范围相同且不能同时成立才记录内部一致性退化，不把不同条件下的陈述强行视为矛盾。delivered-register 必须区分领域规范与面向作者的需说明/按某顺序组织/不得混同等写作指令，两稿共有问题也要留在 slot 与 reason 中。只根据四份文档定位差异；由于不读取 Review 或 Candidate Skill，不得推断差异由 Skill 规则本身还是 Draft 执行造成。此阶段不要提交 JSON 或最终分数；完成读取和比较后只简短回复 JUDGE_INPUTS_READY。`
        : `继续准备。上一轮尚未读取全部指定输入。请现在使用 read 工具读取遗漏文件并完成比较；不要提交最终 JSON，完成后回复 JUDGE_INPUTS_READY。`);
      assertExactReads([...observedReads], options.inputRefs, card.name);
      prepared = true;
    } catch (error) {
    if (error instanceof WorkflowControlError) throw error;
      lastError = error instanceof Error ? error.message : String(error);
      const latest = attempts.at(-1);
      if (latest?.status === "completed" && latest.phase === "preparation") { latest.status = "failed"; latest.error = lastError; }
    }
  }

  if (prepared) {
    for (let submissionAttempt = 1; submissionAttempt <= 3; submissionAttempt += 1) {
      try {
        const run = await execute("submission", `${submissionAttempt > 1 ? `上一次结构化提交未通过：${lastError}。只纠正提交格式和字段，不重新改变已经完成的文档判断。\n` : ""}基于本 Agent session 中已经完成的读取与比较，现在提交最终 Judge Artifact。总分范围 0..30；只有 Candidate 明确更好时 verdict=improved，否则使用 regressed 或 inconclusive。保持 verdict、总分和 Hard Pass 判定语义不变。slotChecks 至少包含 opening、conclusion、delivered-register 和 cross-document，并覆盖 Description 明定的内容槽位/分组/枚举与已给具体值；不适用的 opening/conclusion 标为 not-required，不得要求未提供的事实值；每项必须分别引用 Current/Candidate 可见证据并标注 preserved|improved|regressed|missing-both|not-required。不得把未逐项核对的内容概括成“两稿均保留”。\n\nregressions 只记录 Candidate 相对 Current 新增或加重的退化，并用 slotCheckIds 关联相关 slot；没有则输出空数组。若 Current 与 Gold 都以开篇核心结论承担结论先行功能，而 Candidate 只在末章保留相同事实，opening 必须标为 regressed 并列 content-style regression，不能以事实仍在末章豁免。若 Candidate 新增或加重同一适用范围内互不兼容的陈述，且原文限定无法消除矛盾，相关 slot 标为 regressed 并列 internal-consistency regression；不同条件下的陈述不能直接判为矛盾。delivered-register 必须引用两稿中面向作者的“需说明、按某顺序组织、不得混同”等写作指令：Candidate 新增或加重则列 surface-quality regression；两稿共有则 status=missing-both 并在 reason 明说，不得写成两稿均无语域问题。领域内真正的规范性要求不是写作指令口吻。category 只能是 description-slot|content-style|surface-quality|internal-consistency。任何 status=regressed 的 slot 必须至少被一条 regression.slotCheckIds 引用。\n\nreason 只摘要 Description structure/roster、overall/content-style、Description slots、surface quality 和综合判断，不能替代结构化列表。只陈述四份文档可见差异，不得推断 Skill 规则与 Draft 执行之间的因果。只输出一个最终 JSON 对象；可以直接输出 JSON，也可以放在唯一一组 <<<JUDGE_START>>> 与 <<<JUDGE_END>>> 之间，不要增加其他字段：{"verdict":"improved|regressed|inconclusive","currentScore":0,"candidateScore":0,"currentHardPass":false,"candidateHardPass":false,"slotChecks":[{"id":"opening","scope":"opening","descriptionRequirement":"...","currentEvidence":"...","candidateEvidence":"...","status":"preserved"},{"id":"delivered-register","scope":"section","descriptionRequirement":"交付文档采用陈述口吻","currentEvidence":"...","candidateEvidence":"...","status":"preserved"},{"id":"conclusion","scope":"conclusion","descriptionRequirement":"...","currentEvidence":"...","candidateEvidence":"...","status":"preserved"},{"id":"cross-document","scope":"cross-document","descriptionRequirement":"全篇陈述自洽","currentEvidence":"...","candidateEvidence":"...","status":"preserved"}],"regressions":[{"id":"regression-1","category":"content-style","slotCheckIds":["opening"],"summary":"...","descriptionEvidence":"...","currentEvidence":"...","candidateEvidence":"..."}],"reason":"Description structure/roster: ...；overall/content-style: ...；Description slots: ...；surface quality: ...；综合判断: ..."}`);
        if (run.stopReason === "length") throw new Error(`${card.roleId} output was truncated`);
        const value = validateJudgeModelJson(judgeJsonPayload(run.finalText), options.hashes);
        await writeFile(options.outputPath, `${value}\n`, "utf8");
        return {
          value,
          record: {
            order: options.order, stage, kind: "agent", status: "completed", taskId: `${options.runId}:${stage}`,
            parentTaskId: options.parentTaskId, parentRunId: options.runId, attempt: turn,
            card: cardEvidence(card), provider: options.context.provider, model: options.context.model,
            toolAllowlist: ["read"], inputRefs: options.inputRefs, outputRefs: [options.outputPath],
            inputArtifacts: await artifactEvidence(options.inputRefs), outputArtifacts: await artifactEvidence([options.outputPath]),
            eventsPath: run.rawEventsPath, readPaths: [...observedReads], usage: aggregate,
            ...(run.eventProvenance ? { eventProvenance: run.eventProvenance } : {}), adapterProvenance, attempts,
            session: { id: sessionId, dir: sessionDir },
          },
        };
      } catch (error) {
    if (error instanceof WorkflowControlError) throw error;
        lastError = error instanceof Error ? error.message : String(error);
        const latest = attempts.at(-1);
        if (latest?.status === "completed" && latest.phase === "submission") { latest.status = "failed"; latest.error = lastError; }
      }
    }
  }

  throw new WorkflowStageError(`${card.name} session could not produce a valid Judge Artifact after ${turn} turn(s): ${lastError}`, {
    order: options.order, stage, kind: "agent", status: "failed", taskId: `${options.runId}:${stage}`,
    parentTaskId: options.parentTaskId, parentRunId: options.runId, attempt: turn,
    card: cardEvidence(card), provider: options.context.provider, model: options.context.model, toolAllowlist: ["read"],
    inputRefs: options.inputRefs, outputRefs: [], inputArtifacts: await artifactEvidence(options.inputRefs), outputArtifacts: [],
    eventsPath: attempts.at(-1)?.eventsPath ?? null, readPaths: [...observedReads], usage: aggregate,
    ...(lastRun?.eventProvenance ? { eventProvenance: lastRun.eventProvenance } : {}), attempts, adapterProvenance,
    session: { id: sessionId, dir: sessionDir },
  });
}

/** Contract example only: independent supported and uncertain observations never share refs. */
export const REVIEW_CONTRACT_EXAMPLE = {
  documentGaps: [
    { id: "gap-1", summary: "示例：证据充分的观察", draftEvidence: "Draft证据", draftCounterevidence: "", goldEvidence: "Gold证据", expertRefs: [], sourceAvailability: "description-provided", activeSkillRelation: "refinement", nearestActiveSkillRule: "已有规则位置", descriptionSupport: "任务支持", descriptionConflict: "", certainty: "supported", descriptionCompatibility: "compatible" },
    { id: "gap-2", summary: "示例：证据不充分的另一观察", draftEvidence: "Draft证据", draftCounterevidence: "待判断的反证", goldEvidence: "Gold证据", expertRefs: [], sourceAvailability: "gold-observed-reusable-style", activeSkillRelation: "refinement", nearestActiveSkillRule: "已有规则位置", descriptionSupport: "", descriptionConflict: "", certainty: "uncertain", descriptionCompatibility: "compatible" },
  ],
  skillFindings: [{ id: "skill-finding-1", summary: "示例：条件化方法", attribution: "content-revision", evidenceRefs: ["gap-1"], activeSkillRelation: "refinement", nearestActiveSkillRule: "已有规则位置", descriptionSupport: "任务支持", descriptionConflict: "" }],
  uncertainties: [{ id: "uncertainty-1", summary: "示例：另一观察尚待判断", reason: "已有反证不足以判断", evidenceRefs: ["gap-2"] }],
};

function reviewJsonPayload(text: string): string {
  const trimmed = text.trim();
  const start = "<<<REVIEW_START>>>";
  const end = "<<<REVIEW_END>>>";
  const starts = trimmed.split(start).length - 1;
  const ends = trimmed.split(end).length - 1;
  if (starts || ends) {
    if (starts !== 1 || ends !== 1 || !trimmed.startsWith(start) || !trimmed.endsWith(end)) {
      throw new Error("Review output must contain exactly one Artifact and no prose outside it");
    }
    return trimmed.slice(start.length, -end.length).trim();
  }
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error("Review output must be one bare JSON object with no prose, Markdown, or duplicate Artifact");
  }
  return trimmed;
}

export function validateReviewModelJson(text: string, hashes: RefineReviewArtifact["sourceInputs"], expert: RefineExpertReport): string {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || !exactKeys(value, ["documentGaps", "skillFindings", "uncertainties"])) throw new Error("Review output schema is invalid");
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.documentGaps) || !Array.isArray(raw.skillFindings) || !Array.isArray(raw.uncertainties)) throw new Error("Review arrays are required");
  if (raw.documentGaps.length > 10) throw new Error("Reviewer observation pool may contain at most ten document gaps");
  if (raw.skillFindings.length > 5) throw new Error("Reviewer may return at most five strongest Skill findings");
  const expertIds = new Set(expert.gaps.map((gap) => gap.id));
  const gapIds = new Set<string>();
  for (const gap of raw.documentGaps) {
    if (!gap || typeof gap !== "object" || !exactKeys(gap, ["id", "summary", "draftEvidence", "draftCounterevidence", "goldEvidence", "expertRefs", "sourceAvailability", "activeSkillRelation", "nearestActiveSkillRule", "descriptionSupport", "descriptionConflict", "certainty", "descriptionCompatibility"])) throw new Error("Document gap schema is invalid");
    const item = gap as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id || gapIds.has(item.id) || typeof item.summary !== "string" || !item.summary
      || typeof item.draftEvidence !== "string" || typeof item.draftCounterevidence !== "string" || typeof item.goldEvidence !== "string" || !item.goldEvidence
      || !Array.isArray(item.expertRefs) || item.expertRefs.some((ref) => typeof ref !== "string" || !expertIds.has(ref))
      || !["description-provided", "genre-convention", "gold-observed-reusable-style", "gold-evidence-only"].includes(String(item.sourceAvailability))
      || !["new", "refinement", "duplicate", "conflict"].includes(String(item.activeSkillRelation))
      || typeof item.nearestActiveSkillRule !== "string" || !item.nearestActiveSkillRule
      || typeof item.descriptionSupport !== "string" || typeof item.descriptionConflict !== "string"
      || !["supported", "uncertain"].includes(String(item.certainty))
      || !["compatible", "conflict"].includes(String(item.descriptionCompatibility))) throw new Error("Document gap is not grounded in Draft/Gold/Description/Active Skill evidence");
    if (Boolean(item.descriptionConflict) !== (item.descriptionCompatibility === "conflict")) throw new Error("Description conflict evidence and compatibility axis must agree");
    gapIds.add(item.id);
  }
  const findingIds = new Set<string>();
  for (const finding of raw.skillFindings) {
    if (!finding || typeof finding !== "object" || !exactKeys(finding, ["id", "summary", "attribution", "evidenceRefs", "activeSkillRelation", "nearestActiveSkillRule", "descriptionSupport", "descriptionConflict"])) throw new Error("Skill finding schema is invalid");
    const item = finding as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id || findingIds.has(item.id) || typeof item.summary !== "string" || !item.summary
      || typeof item.attribution !== "string" || !item.attribution || !Array.isArray(item.evidenceRefs) || item.evidenceRefs.length === 0
      || item.evidenceRefs.some((ref) => typeof ref !== "string" || !gapIds.has(ref))
      || !["new", "refinement", "duplicate", "conflict"].includes(String(item.activeSkillRelation))
      || typeof item.nearestActiveSkillRule !== "string" || !item.nearestActiveSkillRule
      || typeof item.descriptionSupport !== "string" || typeof item.descriptionConflict !== "string") throw new Error("Skill finding is not attributable to a classified document gap");
    if (item.activeSkillRelation === "duplicate" || item.activeSkillRelation === "conflict") throw new Error("An Active Skill duplicate or conflict cannot become a Skill finding");
    if (item.descriptionConflict) throw new Error("A Description-conflicting observation cannot become a Skill finding");
    const referenced = (raw.documentGaps as Array<Record<string, unknown>>).filter((gap) => (item.evidenceRefs as string[]).includes(String(gap.id)));
    if (referenced.some((gap) => gap.sourceAvailability === "gold-evidence-only")) throw new Error("gold/evidence-only gaps cannot become Skill findings");
    if (referenced.some((gap) => gap.sourceAvailability === "gold-evidence-only" || gap.certainty !== "supported" || gap.descriptionCompatibility !== "compatible" || !["new", "refinement"].includes(String(gap.activeSkillRelation)))) throw new Error("Only supported, non-Gold-only, Description-compatible new/refinement observations may become Skill findings");
    if (!referenced.some((gap) => gap.activeSkillRelation === item.activeSkillRelation)) throw new Error("Skill finding Active Skill relation is not grounded in its observations");
    findingIds.add(item.id);
  }
  const uncertaintyIds = new Set<string>();
  const disposedGapIds = new Set<string>();
  for (const finding of raw.skillFindings as Array<Record<string, unknown>>) {
    for (const ref of finding.evidenceRefs as string[]) disposedGapIds.add(ref);
  }
  for (const [uncertaintyIndex, uncertainty] of raw.uncertainties.entries()) {
    if (!uncertainty || typeof uncertainty !== "object" || !exactKeys(uncertainty, ["id", "summary", "reason", "evidenceRefs"])) throw new Error("Uncertainty schema is invalid");
    const item = uncertainty as Record<string, unknown>;
    if (Array.isArray(item.evidenceRefs) && item.evidenceRefs.length === 0) throw new Error(`Uncertainty evidenceRefs must be nonempty: /uncertainties/${uncertaintyIndex}/evidenceRefs (id=${String(item.id)}). Reference an actually retained uncertain observation; do not invent evidence or relabel supported observations merely to satisfy the schema.`);
    if (typeof item.id !== "string" || !item.id || uncertaintyIds.has(item.id) || typeof item.summary !== "string" || !item.summary
      || typeof item.reason !== "string" || !item.reason || !Array.isArray(item.evidenceRefs) || item.evidenceRefs.length === 0
      || item.evidenceRefs.some((ref) => typeof ref !== "string" || !gapIds.has(ref))) throw new Error("Uncertainty is invalid");
    for (const [refIndex, ref] of (item.evidenceRefs as string[]).entries()) {
      if ((raw.skillFindings as Array<Record<string, unknown>>).some((finding) => (finding.evidenceRefs as string[]).includes(ref))) {
        const findingIndex = (raw.skillFindings as Array<Record<string, unknown>>).findIndex(finding => (finding.evidenceRefs as string[]).includes(ref));
        const finding = (raw.skillFindings as Array<Record<string, unknown>>)[findingIndex]!;
        const findingRefIndex = (finding.evidenceRefs as string[]).indexOf(ref);
        throw new Error(`An uncertain observation cannot also support a Skill finding: /uncertainties/${uncertaintyIndex}/evidenceRefs/${refIndex} (id=${item.id}, ref=${ref}) overlaps /skillFindings/${findingIndex}/evidenceRefs/${findingRefIndex} (id=${finding.id}). Resolve using your existing evidence judgments; this error does not choose which judgment to retain.`);
      }
      const referencedGap = (raw.documentGaps as Array<Record<string, unknown>>).find((gap) => gap.id === ref);
      if (referencedGap?.certainty !== "uncertain") throw new Error(`An uncertainty must reference an observation with uncertain certainty: /uncertainties/${uncertaintyIndex}/evidenceRefs/${refIndex} id=${item.id}, ref=${ref}; /documentGaps/${(raw.documentGaps as Array<Record<string, unknown>>).findIndex(gap => gap.id === ref)}/certainty=${String(referencedGap?.certainty)}`);
      disposedGapIds.add(ref);
    }
    uncertaintyIds.add(item.id);
  }
  for (const gap of raw.documentGaps as Array<Record<string, unknown>>) {
    if (gap.sourceAvailability === "gold-evidence-only" || ["duplicate", "conflict"].includes(String(gap.activeSkillRelation)) || gap.descriptionCompatibility === "conflict") disposedGapIds.add(String(gap.id));
  }
  const danglingGapIds = [...gapIds].filter((id) => !disposedGapIds.has(id));
  if (danglingGapIds.length) throw new Error(`Every document gap must be attributed or explained by an uncertainty; dangling=${danglingGapIds.join(",")}`);
  const artifact: RefineReviewArtifact = { schemaVersion: "1.0", sourceInputs: hashes, documentGaps: raw.documentGaps as DocumentGap[], skillFindings: raw.skillFindings as SkillFinding[], uncertainties: raw.uncertainties as ReviewUncertainty[] };
  return JSON.stringify(artifact, null, 2);
}

function validateJudgeModelJson(text: string, hashes: RefineJudgeArtifact["sourceInputs"]): string {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object") throw new Error("Judge output schema is invalid");
  const raw = value as Record<string, unknown>;
  if (!exactKeys(raw, ["verdict", "currentScore", "candidateScore", "currentHardPass", "candidateHardPass", "slotChecks", "regressions", "reason"])) throw new Error("Judge output schema is invalid");
  if (!["improved", "regressed", "inconclusive"].includes(String(raw.verdict)) || typeof raw.currentScore !== "number" || !Number.isFinite(raw.currentScore) || raw.currentScore < 0 || raw.currentScore > 30
    || typeof raw.candidateScore !== "number" || !Number.isFinite(raw.candidateScore) || raw.candidateScore < 0 || raw.candidateScore > 30
    || typeof raw.currentHardPass !== "boolean" || typeof raw.candidateHardPass !== "boolean" || !Array.isArray(raw.slotChecks) || !Array.isArray(raw.regressions)
    || typeof raw.reason !== "string" || !raw.reason) throw new Error("Judge output types are invalid");
  const slotIds = new Set<string>();
  for (const entry of raw.slotChecks) {
    if (!entry || typeof entry !== "object" || !exactKeys(entry, ["id", "scope", "descriptionRequirement", "currentEvidence", "candidateEvidence", "status"])) throw new Error("Judge slot check schema is invalid");
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id || slotIds.has(item.id)
      || !["opening", "section", "conclusion", "cross-document"].includes(String(item.scope))
      || typeof item.descriptionRequirement !== "string" || !item.descriptionRequirement
      || typeof item.currentEvidence !== "string" || typeof item.candidateEvidence !== "string"
      || !["preserved", "improved", "regressed", "missing-both", "not-required"].includes(String(item.status))) throw new Error("Judge slot check is invalid");
    slotIds.add(item.id);
  }
  if (![...raw.slotChecks as Array<Record<string, unknown>>].some((item) => item.scope === "opening")
    || ![...raw.slotChecks as Array<Record<string, unknown>>].some((item) => item.scope === "conclusion")
    || ![...raw.slotChecks as Array<Record<string, unknown>>].some((item) => item.scope === "cross-document")
    || !slotIds.has("delivered-register")) throw new Error("Judge must explicitly check opening, conclusion, delivered-register, and cross-document slots");
  const regressedSlotIds = new Set((raw.slotChecks as Array<Record<string, unknown>>).filter((item) => item.status === "regressed").map((item) => String(item.id)));
  const linkedRegressedSlotIds = new Set<string>();
  const regressionIds = new Set<string>();
  for (const entry of raw.regressions) {
    const allowedRegressionKeys = ["id", "category", "slotCheckIds", "summary", "descriptionEvidence", "currentEvidence", "candidateEvidence"];
    if (!entry || typeof entry !== "object") throw new Error("Judge regression schema is invalid");
    if (!exactKeys(entry, allowedRegressionKeys)) {
      const unknown = Object.keys(entry).filter((key) => !allowedRegressionKeys.includes(key));
      throw new Error(`Judge regression must contain only ${allowedRegressionKeys.join(", ")}; unknown fields must be removed: ${unknown.join(", ") || "none"}`);
    }
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id || regressionIds.has(item.id)
      || !["description-slot", "content-style", "surface-quality", "internal-consistency"].includes(String(item.category))
      || !Array.isArray(item.slotCheckIds) || item.slotCheckIds.some((id) => typeof id !== "string" || !slotIds.has(id))
      || typeof item.summary !== "string" || !item.summary || typeof item.descriptionEvidence !== "string"
      || typeof item.currentEvidence !== "string" || typeof item.candidateEvidence !== "string") throw new Error("Judge regression is invalid");
    for (const id of item.slotCheckIds as string[]) if (regressedSlotIds.has(id)) linkedRegressedSlotIds.add(id);
    regressionIds.add(item.id);
  }
  const unlinkedRegressedSlots = [...regressedSlotIds].filter((id) => !linkedRegressedSlotIds.has(id));
  if (unlinkedRegressedSlots.length) throw new Error(`Every regressed slot must be linked from a Candidate-specific regression; unlinked=${unlinkedRegressedSlots.join(",")}`);
  const artifact: RefineJudgeArtifact = {
    schemaVersion: "1.0", evaluator: { id: "pi-independent-judge", version: INDEPENDENT_JUDGE_VERSION }, sourceInputs: hashes,
    verdict: raw.verdict as RefineJudgeArtifact["verdict"], currentScore: raw.currentScore, candidateScore: raw.candidateScore,
    currentHardPass: raw.currentHardPass, candidateHardPass: raw.candidateHardPass,
    slotChecks: raw.slotChecks as RefineJudgeArtifact["slotChecks"], regressions: raw.regressions as RefineJudgeArtifact["regressions"], reason: raw.reason,
  };
  return JSON.stringify(artifact, null, 2);
}

function normalizeCandidateSkill(text: string): string {
  const value = text.trim();
  if (!value.startsWith("---") || !/^name\s*:/m.test(value) || !/^description\s*:/m.test(value)) throw new Error("Candidate Skill must be a complete SKILL.md with frontmatter");
  if ([...value].length < 80) throw new Error("Candidate Skill is implausibly short");
  return value;
}

export const REFINE_POLICY_OPTIMIZER_STAGE_PROMPT = (descriptionPath: string, activeSkillPath: string, reviewPath: string) => `完整读取冻结内容合同 Description ${descriptionPath}、Active Skill ${activeSkillPath} 与 Review ${reviewPath}，不得只信 Reviewer 转述。逐条复核 Finding 的 descriptionSupport/descriptionConflict、activeSkillRelation 和 nearestActiveSkillRule：duplicate 或与 Description 冲突的项一律跳过；refinement 必须在最近既有规则处做 line-local 合并；conflict 必须在同一规范落点改写或删除冲突规则；new 只有在整份 Skill 中没有语义近义规则时才可新增。若 Description 要求同一边界在正文、对比、结论等不同功能位置重复强调，不得编译成“只定义一次”或全局去重规则。只应用跨样本 overall/content-style 方法，跳过 Gold 独有事实。每一处新增、改写或删除都必须直接对应一条有效 Finding；一条方法只保留一个规范规则落点，不在多个位置重复追加。任何压缩、简洁或统一结构规则都必须保留 Description 明确要求的内容槽位、具体值及功能性重复。保留 frontmatter、来源注释、文件索引、无关章节和无冲突原文，不得顺手清理、泛化或重写。输出完整、可读、可执行且无冲突的 SKILL.md，不输出 patch、delta、分析、解释或 Gold 特有事实。读取完成后的下一条消息必须以 <<<CANDIDATE_SKILL_START>>> 开始，并且只输出唯一一组完整标记。\n<<<CANDIDATE_SKILL_START>>>\n（完整 SKILL.md）\n<<<CANDIDATE_SKILL_END>>>`;

export async function runRefineDraftAgent(options: {
  cwd: string; provider: string; model: string; timeoutMs: number; extensionPaths?: string[]; runner?: RefineHarnessRunner;
  descriptionPath: string; skillPath: string; outputPath: string; runId?: string; parentTaskId?: string; runDirectory?: string;
  stage?: "current-draft-generation" | "candidate-draft-generation"; order?: number;
}): Promise<{ draftPath: string; record: StageRecord }> {
  const runId = options.runId ?? `draft-${randomUUID()}`;
  const runDirectory = resolve(options.runDirectory ?? join(dirname(resolve(options.outputPath)), `.draft-${runId}`));
  await mkdir(runDirectory, { recursive: true });
  const context: RefineWorkflowOptions = {
    cwd: options.cwd, provider: options.provider, model: options.model, timeoutMs: options.timeoutMs,
    requirementsPath: "", goldPath: "", activeSkillPath: resolve(options.skillPath), rulesPath: "", runRoot: runDirectory,
    ...(options.extensionPaths ? { extensionPaths: options.extensionPaths } : {}), ...(options.runner ? { runner: options.runner } : {}),
  };
  const descriptionPath = resolve(options.descriptionPath);
  const skillPath = resolve(options.skillPath);
  const result = await invokeArtifactAgent({
    context, runner: options.runner ?? runAgentTask, runId, runDirectory,
    parentTaskId: options.parentTaskId ?? `${runId}:refine-workflow`, order: options.order ?? 2,
    stage: options.stage ?? "current-draft-generation", roleId: "refine.draft", inputRefs: [descriptionPath, skillPath],
    outputPath: resolve(options.outputPath), startMarker: "<<<DRAFT_START>>>", endMarker: "<<<DRAFT_END>>>",
    prompt: `完整读取 Description ${descriptionPath} 与完整 Skill ${skillPath}。动笔前提取 Description 明确要求的内容槽位及已给具体值，并冻结其明定的章节/分组、顺序、枚举成员与归属关系。严格应用 Skill 生成紧凑的完整 Markdown 文档，但凝练、压缩、统一结构或语域清理只能改变呈现层并删除重复与元叙述；不得新增、删除、合并、改挂这些结构或成员，也不能把确定取值改写成“等”或其他含混概括作泛化替代。Description 未提供的事实不得猜测、虚构或从 Skill 中当作本次事实继承；必要槽位缺少信息时明确标为未知或待补充。交付前逐项核对冻结结构与枚举仍完整，再单遍通读全文，确保同一术语、专名和实体只保留一种规范写法。禁止读取 Gold 或任何评测产物。只输出唯一一组标记。\n<<<DRAFT_START>>>\n（完整 Markdown）\n<<<DRAFT_END>>>`,
    retries: 3,
  });
  return { draftPath: resolve(options.outputPath), record: result.record };
}

export async function runRefineReviewerAgent(options: {
  cwd: string; provider: string; model: string; timeoutMs: number; extensionPaths?: string[]; runner?: RefineHarnessRunner;
  runId?: string; runDirectory: string; parentTaskId?: string; taskType?: string; harnessProfile?: RefineHarnessProfile;
  descriptionPath: string; draftPath: string; goldPath: string; activeSkillPath: string; draftExpertReportPath: string; outputPath: string;
}): Promise<{ reviewPath: string; record: StageRecord }> {
  const runId = options.runId ?? `review-${randomUUID()}`;
  const inputRefs = [options.descriptionPath, options.draftPath, options.goldPath, options.activeSkillPath, options.draftExpertReportPath].map((path) => resolve(path));
  const expert = JSON.parse(await readFile(inputRefs[4]!, "utf8")) as RefineExpertReport;
  const context: RefineWorkflowOptions = {
    cwd: options.cwd, provider: options.provider, model: options.model, timeoutMs: options.timeoutMs,
    requirementsPath: inputRefs[0]!, goldPath: inputRefs[2]!, activeSkillPath: inputRefs[3]!, rulesPath: inputRefs[0]!, runRoot: resolve(options.runDirectory),
    ...(options.extensionPaths ? { extensionPaths: options.extensionPaths } : {}), ...(options.runner ? { runner: options.runner } : {}),
    ...(options.taskType ? { taskType: options.taskType } : {}), ...(options.harnessProfile ? { harnessProfile: options.harnessProfile } : {}),
  };
  const hashes = {
    descriptionSha256: sha256(await readFile(inputRefs[0]!)), draftSha256: sha256(await readFile(inputRefs[1]!)),
    goldSha256: sha256(await readFile(inputRefs[2]!)), activeSkillSha256: sha256(await readFile(inputRefs[3]!)),
    expertReportSha256: sha256(await readFile(inputRefs[4]!)),
  };
  const result = await invokeReviewAgent({ context, runner: options.runner ?? runAgentTask, runId, runDirectory: resolve(options.runDirectory),
    parentTaskId: options.parentTaskId ?? `${runId}:refine-workflow`, order: 4, inputRefs, outputPath: resolve(options.outputPath), hashes, expert });
  return { reviewPath: resolve(options.outputPath), record: result.record };
}

export async function runRefinePolicyOptimizerAgent(options: {
  cwd: string; provider: string; model: string; timeoutMs: number; extensionPaths?: string[]; runner?: RefineHarnessRunner;
  runId?: string; runDirectory: string; parentTaskId?: string; taskType?: string; harnessProfile?: RefineHarnessProfile;
  descriptionPath: string; activeSkillPath: string; reviewPath: string; outputPath: string;
}): Promise<{ candidateSkillPath: string; record: StageRecord }> {
  const runId = options.runId ?? `optimizer-${randomUUID()}`;
  const descriptionPath = resolve(options.descriptionPath);
  const activeSkillPath = resolve(options.activeSkillPath);
  const reviewPath = resolve(options.reviewPath);
  await mkdir(dirname(resolve(options.outputPath)), { recursive: true });
  const context: RefineWorkflowOptions = {
    cwd: options.cwd, provider: options.provider, model: options.model, timeoutMs: options.timeoutMs,
    requirementsPath: descriptionPath, goldPath: "", activeSkillPath, rulesPath: descriptionPath, runRoot: resolve(options.runDirectory),
    ...(options.extensionPaths ? { extensionPaths: options.extensionPaths } : {}), ...(options.runner ? { runner: options.runner } : {}),
    ...(options.taskType ? { taskType: options.taskType } : {}), ...(options.harnessProfile ? { harnessProfile: options.harnessProfile } : {}),
  };
  const result = await invokeArtifactAgent({ context, runner: options.runner ?? runAgentTask, runId, runDirectory: resolve(options.runDirectory),
    parentTaskId: options.parentTaskId ?? `${runId}:refine-workflow`, order: 5, stage: "candidate-skill-compilation", roleId: "refine.policy-optimizer",
    inputRefs: [descriptionPath, activeSkillPath, reviewPath], outputPath: resolve(options.outputPath), startMarker: "<<<CANDIDATE_SKILL_START>>>", endMarker: "<<<CANDIDATE_SKILL_END>>>", retries: 3,
    prompt: REFINE_POLICY_OPTIMIZER_STAGE_PROMPT(descriptionPath, activeSkillPath, reviewPath), transform: normalizeCandidateSkill });
  return { candidateSkillPath: resolve(options.outputPath), record: result.record };
}

async function expertStage(context: RefineWorkflowOptions, runner: RefineHarnessRunner, runId: string, runDirectory: string, parentTaskId: string, order: number, stage: "draft-expert-evaluation" | "candidate-expert-evaluation", descriptionPath: string, candidatePath: string, goldPath: string, goldAspectSetPath: string, outputPath: string, expectedGoldAspectSetSha256?: string, resumeFailures?: Record<string, ExpertAgentCallRecord>, recoveredCalls?: ExpertAgentCallRecord[]) {
  const evaluationId = stage === "draft-expert-evaluation" ? "current" : "candidate";
  let result;
  try { result = await runRefineExpertEvaluation({
    cwd: context.cwd, provider: context.provider, model: context.model, timeoutMs: context.timeoutMs,
    ...(context.extensionPaths ? { extensionPaths: context.extensionPaths } : {}), runner,
    ...(context.harnessProfile ? { harnessProfile: context.harnessProfile, taskType: context.taskType ?? "" } : {}),
    runId, runDirectory, parentTaskId: `${runId}:${stage}`, evaluationId,
    descriptionPath, goldPath, documentPath: candidatePath, goldAspectSetPath, ...(expectedGoldAspectSetSha256 ? { expectedGoldAspectSetSha256 } : {}), outputPath,
    ...(resumeFailures ? { resumeFailures } : {}),
    ...(recoveredCalls ? { recoveredCalls } : {}),
  }); } catch (error) {
    const subtasks = error instanceof WorkflowControlError ? error.expertCalls as ExpertAgentCallRecord[] ?? [] : error instanceof ExpertPipelineError ? error.calls : [];
    const failedInputRefs = evaluationId === "current" ? [descriptionPath, goldPath, candidatePath] : [descriptionPath, candidatePath, goldAspectSetPath];
    const failure = new WorkflowStageError(error instanceof Error ? error.message : String(error), {
      order, stage, kind: "deterministic-tool", status: "failed", taskId: `${runId}:${stage}`, parentTaskId, parentRunId: runId, attempt: 1,
      card: cardEvidence(refineWorkflowCard("refine.workflow")), provider: null, model: null, toolAllowlist: [],
      inputRefs: failedInputRefs, outputRefs: [], inputArtifacts: await artifactEvidence(failedInputRefs),
      outputArtifacts: [], eventsPath: null, readPaths: [], usage: null, subtasks,
    });
    if (error instanceof WorkflowControlError) { error.workflowStageRecord = failure.stageRecord; throw error; }
    throw failure;
  }
  const inputRefs = evaluationId === "current" ? [descriptionPath, goldPath, candidatePath] : [descriptionPath, candidatePath, goldAspectSetPath];
  const outputRefs = [outputPath, ...(result.goldExtracted ? [result.goldAspectSetPath] : []), result.documentAspectSetPath, result.recallMatchesPath, result.precisionMatchesPath, result.evidenceAlignmentsPath];
  const record: StageRecord = {
    order, stage, kind: "deterministic-tool", status: "completed", taskId: `${runId}:${stage}`, parentTaskId, parentRunId: runId, attempt: 1,
    card: cardEvidence(refineWorkflowCard("refine.workflow")), provider: null, model: null, toolAllowlist: [],
    inputRefs, outputRefs, inputArtifacts: await artifactEvidence(inputRefs), outputArtifacts: await artifactEvidence(outputRefs),
    eventsPath: null, readPaths: [], usage: null, subtasks: result.calls,
  };
  return { artifact: result.report, record, result };
}

function promotionDecision(activeSkill: string, candidateSkill: string, review: RefineReviewArtifact, currentExpert: RefineExpertReport, candidateExpert: RefineExpertReport, judge: RefineJudgeArtifact, reportHashes: { currentExpert: string; candidateExpert: string; judge: string }): PromotionDecision {
  const expertScoreDelta = candidateExpert.f1 - currentExpert.f1;
  const gates = {
    skillChanged: sha256(activeSkill) !== sha256(candidateSkill),
    hasAttributedFindings: review.skillFindings.length > 0,
    expertImproved: expertScoreDelta > 0,
    expertHardPassPreserved: !currentExpert.hardPass || candidateExpert.hardPass,
    judgeImproved: judge.verdict === "improved" && judge.candidateScore > judge.currentScore,
    judgeHardPassPreserved: !judge.currentHardPass || judge.candidateHardPass,
  };
  const requiredGates: PromotionDecision["requiredGates"] = ["skillChanged", "hasAttributedFindings", "expertImproved", "expertHardPassPreserved"];
  const reasons: string[] = [];
  for (const gate of requiredGates) if (!gates[gate]) reasons.push(`gate-failed:${gate}`);
  const decision = requiredGates.every((gate) => gates[gate]) ? "promote" : "reject";
  if (decision === "promote") reasons.push("all-skill-and-expert-gates-passed");
  return {
    schemaVersion: "1.0", decision, activeSkillOverwritten: false, expertScoreMetric: "f1", expertScoreDelta, gates, requiredGates,
    judgeAdvisory: { blocking: false, artifactAvailable: true, verdict: judge.verdict, scoreDelta: judge.candidateScore - judge.currentScore,
      hardPassPreserved: gates.judgeHardPassPreserved }, reasons,
    evidence: { activeSkillSha256: sha256(activeSkill), candidateSkillSha256: sha256(candidateSkill), draftExpertSha256: reportHashes.currentExpert, candidateExpertSha256: reportHashes.candidateExpert, judgeSha256: reportHashes.judge },
  };
}

function promotionDecisionWithoutJudge(activeSkill: string, candidateSkill: string, review: RefineReviewArtifact, currentExpert: RefineExpertReport, candidateExpert: RefineExpertReport, reportHashes: { currentExpert: string; candidateExpert: string }, failure: WorkflowStageError): PromotionDecision {
  const expertScoreDelta = candidateExpert.f1 - currentExpert.f1;
  const gates = {
    skillChanged: sha256(activeSkill) !== sha256(candidateSkill),
    hasAttributedFindings: review.skillFindings.length > 0,
    expertImproved: expertScoreDelta > 0,
    expertHardPassPreserved: !currentExpert.hardPass || candidateExpert.hardPass,
    judgeImproved: false,
    judgeHardPassPreserved: false,
  };
  const requiredGates: PromotionDecision["requiredGates"] = ["skillChanged", "hasAttributedFindings", "expertImproved", "expertHardPassPreserved"];
  const decision = requiredGates.every((gate) => gates[gate]) ? "promote" : "reject";
  const reasons = requiredGates.filter((gate) => !gates[gate]).map((gate) => `gate-failed:${gate}`);
  if (decision === "promote") reasons.push("all-skill-and-expert-gates-passed");
  return {
    schemaVersion: "1.0", decision, activeSkillOverwritten: false, expertScoreMetric: "f1", expertScoreDelta,
    gates, requiredGates,
    judgeAdvisory: { blocking: false, artifactAvailable: false, verdict: null, scoreDelta: null, hardPassPreserved: null },
    reasons,
    evidence: {
      activeSkillSha256: sha256(activeSkill), candidateSkillSha256: sha256(candidateSkill),
      draftExpertSha256: reportHashes.currentExpert, candidateExpertSha256: reportHashes.candidateExpert, judgeSha256: null,
    },
    judgeFailure: {
      status: "unavailable", reason: failure.message,
      sessionId: failure.stageRecord.session?.id ?? null,
      turns: failure.stageRecord.attempts?.length ?? failure.stageRecord.attempt,
    },
  };
}

type BusinessRegressionReason = "expert-regression";
async function runWorkflowSelfChecks(options: RefineWorkflowOptions, runner: RefineHarnessRunner, runId: string, runDirectory: string, manifestPath: string,
  records: StageRecord[], artifacts: Record<string, string>, currentF1: number, candidateF1: number,
  eligibleForRegressionCheck: boolean): Promise<HarnessSelfCheckSummary> {
  const base = { nativeAcontextApi: false as const, executionPath: "trace-first-refine-business-audit-v4" as const,
    failureCardDigest: ACONTEXT_FAILURE_CARD_DIGEST, sourceKind: "current-refine-run" as const };
  if (!(candidateF1 < currentF1)) return { status: "not-triggered", reason: "no-candidate-expert-regression", ...base };
  if (options.auxiliaryDiagnostics === "deferred-for-controlled-experiment") {
    return { status: "not-triggered", reason: "auxiliary-diagnostics-deferred-for-controlled-experiment",
      ...base, businessTriggerReasons: ["expert-regression"] };
  }
  const engineeringFailureDiagnosis = await runHarnessSelfCheck({
    cwd: options.cwd, provider: options.provider, model: options.model, timeoutMs: options.timeoutMs,
    ...(options.extensionPaths ? { extensionPaths: options.extensionPaths } : {}), runner,
    runId, runDirectory, manifestPath, currentF1, candidateF1, stages: records, artifacts, eligibleForRegressionCheck, sourceKind: "current-refine-run",
  });
  const reasons: BusinessRegressionReason[] = ["expert-regression"];
  const triggeredBase = { ...base, engineeringFailureDiagnosis };
  try {
    const audit = await runRefineTaskBehaviorAudit({
      cwd: options.cwd, provider: options.provider, model: options.model, timeoutMs: options.timeoutMs,
      ...(options.extensionPaths ? { extensionPaths: options.extensionPaths } : {}), runner,
      runId, runDirectory, stages: records, taskType: options.taskType?.trim() || "document_refine",
      businessTrigger: { type: "refine-business-regression", reasons },
    });
    return { status: "triggered", reason: "refine-business-regression", ...triggeredBase, businessTriggerReasons: reasons,
      behaviorAuditPath: audit.resultPath, businessTaskStatePath: audit.businessTaskStatePath, businessRoleStatePaths: audit.businessRoleStatePaths,
      engineeringDiagnosticsPath: audit.engineeringDiagnosticsPath };
  } catch (error) {
    if (error instanceof WorkflowControlError) throw error;
    return { status: "failed", reason: "refine-business-regression-audit-failed", ...triggeredBase, businessTriggerReasons: reasons,
      error: error instanceof Error ? error.message : String(error) };
  }
}

/** Explicit, audited migration for historical pre-provider control attempts only. */
export async function applyUnsentControlEvidence(options: Pick<RefineWorkflowOptions, "resumeUnsentAttempts" | "resumeControlEvidence">, runId: string, calls: ExpertAgentCallRecord[]) {
  const identities = options.resumeUnsentAttempts ?? [];
  if (!identities.length) return;
  if (!options.resumeControlEvidence) throw new WorkflowControlError("accounting", "Unsent-attempt migration requires audited control evidence");
  const proofText = await readFile(options.resumeControlEvidence.path, "utf8");
  if (sha256(proofText) !== options.resumeControlEvidence.sha256) throw new WorkflowControlError("source", "Control evidence digest changed");
  const proof = JSON.parse(proofText);
  if (proof.runId !== runId || proof.preProviderGuardVerified !== true || JSON.stringify(proof.unsentAttempts) !== JSON.stringify(identities)) throw new WorkflowControlError("accounting", "Control evidence identities or verified pre-provider guard mismatch");
  const ledger = await readFile(proof.ledgerPath, "utf8");
  if (sha256(ledger) !== proof.ledgerSha256) throw new WorkflowControlError("accounting", "Control evidence ledger changed");
  const ledgerRows = ledger.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const normalized = (path: string) => normalize(resolve(path)).toLowerCase();
  for (const identity of identities) {
    const call = calls.find(call => call.stage === identity.stage);
    const attempt = call?.attempts?.find(attempt => attempt.attempt === identity.attempt && normalized(attempt.eventsPath) === normalized(identity.eventsPath));
    if (!attempt || attempt.status !== "failed") throw new WorkflowControlError("accounting", "Control migration does not identify a failed attempt");
    if (ledgerRows.some(row => row.taskId === attempt.taskId || (typeof row.eventsPath === "string" && normalized(row.eventsPath) === normalized(attempt.eventsPath)))) throw new WorkflowControlError("accounting", "Attempt appears in request ledger; cannot classify as not sent", true);
    if (attempt.usage && Object.values(attempt.usage).some(value => value !== 0)) throw new WorkflowControlError("accounting", "Attempt has usage; cannot classify as not sent", true);
    const raw = await readFile(attempt.eventsPath, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
    if (raw.trim() || attempt.readPaths?.length || attempt.eventProvenance) throw new WorkflowControlError("accounting", "Attempt has execution evidence; reconciliation required", true);
    attempt.controlStop = { reason: "source", providerStarted: false, evidencePath: options.resumeControlEvidence.path, evidenceSha256: options.resumeControlEvidence.sha256 };
  }
}

export async function runFixedRefineWorkflowHarness(options: RefineWorkflowOptions): Promise<RefineWorkflowResult> {
  if (options.auxiliaryDiagnostics !== undefined && options.auxiliaryDiagnostics !== "automatic"
    && options.auxiliaryDiagnostics !== "deferred-for-controlled-experiment") throw new Error("Invalid auxiliaryDiagnostics mode");
  const automaticAuxiliaryDiagnostics = options.auxiliaryDiagnostics !== "deferred-for-controlled-experiment";
  const auxiliaryDiagnosticsMetadata = automaticAuxiliaryDiagnostics ? {} : {
    auxiliaryDiagnostics: { mode: "deferred-for-controlled-experiment", engineeringDiagnosis: "deferred", behaviorAudit: "deferred",
      reason: "controlled-history-comparison-uses-explicit-diagnostics" },
  };
  const runner = options.runner ?? runAgentTask;
  const resumeRunDirectory = options.resumeRunDirectory ? resolve(options.resumeRunDirectory) : null;
  const priorManifest = resumeRunDirectory ? JSON.parse(await readFile(join(resumeRunDirectory, "manifest.json"), "utf8")) as Record<string, unknown> : null;
  const priorAuxiliaryMode = (priorManifest?.auxiliaryDiagnostics as { mode?: string } | undefined)?.mode ?? "automatic";
  if (resumeRunDirectory && priorAuxiliaryMode !== (options.auxiliaryDiagnostics ?? "automatic")) throw new Error("Resume input changed: auxiliaryDiagnostics");
  const startedAt = priorManifest && typeof priorManifest.startedAt === "string" ? priorManifest.startedAt : new Date().toISOString();
  const runId = priorManifest && typeof priorManifest.runId === "string" ? priorManifest.runId : `${startedAt.replace(/[:.]/g, "-")}-${randomUUID()}`;
  const runDirectory = resumeRunDirectory ?? resolve(options.runRoot, runId);
  await mkdir(resolve(options.runRoot), { recursive: true });
  if (!resumeRunDirectory) await mkdir(runDirectory, { recursive: false });
  const manifestPath = join(runDirectory, "manifest.json");
  const workflowCard = refineWorkflowCard("refine.workflow");
  const parentTaskId = `${runId}:refine-workflow`;
  const priorStages = priorManifest && Array.isArray(priorManifest.stages) ? priorManifest.stages as StageRecord[] : [];
  const records: StageRecord[] = resumeRunDirectory
    ? priorStages.filter((record) => record.status === "completed" && ["description-reconstruction", "current-draft-generation"].includes(record.stage))
    : [];
  const requirementsPath = resolve(options.requirementsPath);
  const rulesPath = resolve(options.rulesPath);
  const goldPath = resolve(options.goldPath);
  const activeSkillPath = resolve(options.activeSkillPath);
  const descriptionPath = join(runDirectory, "description.md");
  const priorFrozenDescription = (priorManifest?.inputs as { frozenDescriptionPath?: string } | undefined)?.frozenDescriptionPath;
  const frozenDescriptionPath = options.frozenDescriptionPath ? resolve(options.frozenDescriptionPath) : priorFrozenDescription ? resolve(priorFrozenDescription) : null;
  if (resumeRunDirectory && options.frozenDescriptionPath && (!priorFrozenDescription || normalize(resolve(priorFrozenDescription)).toLowerCase() !== normalize(frozenDescriptionPath!).toLowerCase())) throw new Error("Resume input changed: frozenDescriptionPath");
  const draftPath = join(runDirectory, "draft.md");
  const draftExpertReportPath = join(runDirectory, "draft-expert.json");
  const goldAspectSetPath = join(runDirectory, "gold-aspects.json");
  const priorFrozenGold = (priorManifest?.inputs as { frozenGoldAspectSet?: FrozenGoldAspectSet } | undefined)?.frozenGoldAspectSet;
  if (resumeRunDirectory && JSON.stringify(priorFrozenGold ?? null) !== JSON.stringify(options.frozenGoldAspectSet ?? null)) throw new Error("Resume input changed: frozenGoldAspectSet");
  if (options.frozenGoldAspectSet && !frozenDescriptionPath) throw new Error("Frozen Gold AspectSet import requires frozen Description");
  const goldAspectImport = options.frozenGoldAspectSet ? await importFrozenGoldAspects(options.frozenGoldAspectSet, goldPath, frozenDescriptionPath!, goldAspectSetPath) : null;
  const reviewPath = join(runDirectory, "review.json");
  const candidateSkillPath = join(runDirectory, "candidate-skill.md");
  const candidateDraftPath = join(runDirectory, "candidate-draft.md");
  const candidateExpertReportPath = join(runDirectory, "candidate-expert.json");
  const judgePath = join(runDirectory, "independent-judge.json");
  const promotionDecisionPath = join(runDirectory, "promotion-decision.json");
  const traceIndexPath = join(runDirectory, "trace-index.json");
  const resumeFailedStage = priorManifest?.failedStage === "candidate-expert-evaluation" ? "candidate-expert-evaluation" : "draft-expert-evaluation";
  const candidateExpertResume = Boolean(resumeRunDirectory && resumeFailedStage === "candidate-expert-evaluation");
  const failedExpertStage = resumeRunDirectory ? priorStages.find((record) => record.stage === resumeFailedStage && record.status === "failed") : undefined;
  const failedExpertCalls = failedExpertStage?.subtasks?.filter((call) => !call.recovery && call.attempts?.at(-1)?.status === "failed") ?? [];
  await applyUnsentControlEvidence(options, runId, failedExpertCalls);
  const resumeFailures = failedExpertCalls.length ? Object.fromEntries(failedExpertCalls.map((call) => [call.stage, call])) : undefined;
  const resumeSnapshotSuffix = new Date().toISOString().replace(/[:.]/g, "-");
  const resumeMetadata = resumeRunDirectory ? {
    resumedFromRunDirectory: resumeRunDirectory,
    resumedFailedStage: priorManifest?.failedStage ?? null,
    continuationMode: resumeFailures && Object.values(resumeFailures).every((call) => call.attempts?.every(attempt => attempt.controlStop?.providerStarted === false))
      ? "first-provider-request-after-control-stop"
      : resumeFailures && Object.values(resumeFailures).every((call) => call.session?.continuation === "native")
      ? "native-pi-session-resume"
      : "public-trace-fallback-for-historical-no-session-attempts",
    cacheReuse: candidateExpertResume
      ? [descriptionPath, draftPath, goldAspectSetPath, draftExpertReportPath, reviewPath, candidateSkillPath, candidateDraftPath]
      : [descriptionPath, draftPath, goldAspectSetPath],
    preservedPreResumeManifestPath: join(runDirectory, `manifest.pre-resume-${resumeSnapshotSuffix}.json`),
    preservedPreResumeTraceIndexPath: join(runDirectory, `trace-index.pre-resume-${resumeSnapshotSuffix}.json`),
  } : null;
  const recoveredExpertCalls: ExpertAgentCallRecord[] = failedExpertStage?.subtasks?.filter((call) => Boolean(call.recovery) || call.attempts?.at(-1)?.status === "completed") ?? [];
  const completedCurrentExpert = candidateExpertResume ? priorStages.find((record) => record.stage === "draft-expert-evaluation" && record.status === "completed") : undefined;
  if (resumeRunDirectory) {
    if (priorManifest?.status !== "failed" || !["draft-expert-evaluation", "candidate-expert-evaluation"].includes(String(priorManifest.failedStage))) throw new Error("Resume requires a failed Current or Candidate Expert manifest");
    const expectedPrefix = candidateExpertResume ? "candidate-" : "current-";
    if (failedExpertCalls.length !== 1 || !failedExpertCalls[0]!.stage.startsWith(expectedPrefix)) throw new Error(`Resume requires exactly one terminal failed ${candidateExpertResume ? "Candidate" : "Current"} Expert subtask`);
    if (candidateExpertResume && !completedCurrentExpert) throw new Error("Candidate Expert resume requires a completed Current Expert checkpoint");
    const priorInputs = priorManifest.inputs as Record<string, unknown> | undefined;
    for (const [name, actual] of [["requirementsPath", requirementsPath], ["rulesPath", rulesPath], ["goldPath", goldPath], ["activeSkillPath", activeSkillPath]] as const) {
      if (!priorInputs || normalize(resolve(String(priorInputs[name] ?? ""))).toLowerCase() !== normalize(actual).toLowerCase()) throw new Error(`Resume input changed: ${name}`);
    }
    const reusableRecords = candidateExpertResume
      ? priorStages.filter((record) => record.status === "completed" && record.order <= 6)
      : records;
    for (const record of reusableRecords) for (const artifact of [...record.inputArtifacts, ...record.outputArtifacts]) {
      const actual = (await artifactEvidence([artifact.path]))[0]!;
      if (actual.sha256 !== artifact.sha256) throw new Error(`Resume cache digest changed: ${artifact.path}`);
    }
    const goldAspectBytes = await readFile(goldAspectSetPath);
    const frozenGold = JSON.parse(goldAspectBytes.toString("utf8")) as { sourceSha256?: unknown; descriptionSha256?: unknown };
    if (frozenGold.sourceSha256 !== sha256(await readFile(goldPath)) || frozenGold.descriptionSha256 !== sha256(await readFile(descriptionPath))) throw new Error("Resume Gold Aspect cache is not bound to the frozen Gold and Description");
    const goldEventsPath = join(runDirectory, "gold-aspect-extraction.events.jsonl");
    const goldProvenance = await readAgentEventProvenance(goldEventsPath);
    if (!candidateExpertResume && goldProvenance && failedExpertCalls[0] && !recoveredExpertCalls.some((call) => call.stage === "gold-aspect-extraction")) {
      const parsed = parseAgentTaskEvents(await readFile(goldEventsPath, "utf8"));
      const priorCard = failedExpertCalls[0].card;
      const adapter: AdapterProvenance = { availability: "available", id: "refine-expert-json-boundary", version: "v1", digest: sha256(JSON.stringify({ id: "refine-expert-json-boundary", version: "v1" })) };
      recoveredExpertCalls.push({
        stage: "gold-aspect-extraction", taskId: `${runId}:gold-aspect-extraction`, parentTaskId: `${runId}:draft-expert-evaluation`, card: priorCard,
        provider: options.provider, model: options.model, inputRefs: [descriptionPath, goldPath], outputRefs: [goldAspectSetPath],
        inputArtifacts: await artifactEvidence([descriptionPath, goldPath]), outputArtifacts: await artifactEvidence([goldAspectSetPath]),
        eventsPath: goldEventsPath, readPaths: parsed.readPaths, usage: parsed.usage, eventProvenance: goldProvenance,
        attempts: [{ attempt: 1, taskId: `${runId}:gold-aspect-extraction:attempt-1`, eventsPath: goldEventsPath, status: "completed", phase: "initial", readPaths: parsed.readPaths, usage: parsed.usage, eventProvenance: goldProvenance, adapterProvenance: adapter }],
        adapterProvenance: adapter,
      });
    }
    await copyFile(manifestPath, resumeMetadata!.preservedPreResumeManifestPath);
    await copyFile(traceIndexPath, resumeMetadata!.preservedPreResumeTraceIndexPath);
  }
  const persistProgress = async (status: "running" | "failed", failedStage: string | null = null, error: string | null = null) => {
    completeAdapters(records);
    const progress = {
      schemaVersion: "2.0", harnessVersion: "refine-workflow-harness-v2", workflow: "gold-supervised-skill-refine", executionMode: "workflow",
    ...auxiliaryDiagnosticsMetadata,
      status, runId, startedAt, parentTask: { taskId: parentTaskId, card: cardEvidence(workflowCard), provider: options.provider, model: options.model },
      harnessProfile: harnessProfileSummary(options),
      inputs: { requirementsPath, goldPath, activeSkillPath, rulesPath, ...(frozenDescriptionPath ? { frozenDescriptionPath } : {}), ...(options.frozenGoldAspectSet ? { frozenGoldAspectSet: options.frozenGoldAspectSet, goldAspectImport } : {}) }, failedStage, error, stages: records,
      ...(resumeMetadata ? { resume: resumeMetadata } : {}),
      traceIndexPath, traceEvidence: "public JSONL events are primary; this manifest and index only locate attempts",
    };
    await writeFile(manifestPath, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
    await writeFile(traceIndexPath, `${JSON.stringify({ schemaVersion: "1.0", status, runId, manifestPath, failedStage, stages: records.map((record) => ({ stage: record.stage, status: record.status, eventsPath: record.eventsPath, attempts: record.attempts ?? [], subtasks: record.subtasks ?? [] })) }, null, 2)}\n`, "utf8");
  };
  const appendRecord = async (record: StageRecord) => { records.push(record); await persistProgress(record.status === "failed" ? "failed" : "running", record.status === "failed" ? record.stage : null); };
  await persistProgress("running");

  try {
  if (!resumeRunDirectory) {
  if (frozenDescriptionPath) {
    const frozenDescription = await readFile(frozenDescriptionPath);
    const text = frozenDescription.toString("utf8");
    if ([...text.trim()].length < 200 || pipelineRuleLeaks(text).length) throw new Error("Frozen Description must contain substantive task content without pipeline rules");
    await writeFile(descriptionPath, frozenDescription);
    await appendRecord({
      order: 1, stage: "description-reconstruction", kind: "deterministic-tool", status: "completed",
      taskId: `${runId}:description-reconstruction:frozen-input`, parentTaskId, parentRunId: runId, attempt: 1,
      card: cardEvidence(refineWorkflowCard("refine.description")), provider: null, model: null, toolAllowlist: [],
      inputRefs: [frozenDescriptionPath], outputRefs: [descriptionPath], inputArtifacts: await artifactEvidence([frozenDescriptionPath]),
      outputArtifacts: await artifactEvidence([descriptionPath]), eventsPath: null, readPaths: [], usage: null,
    });
  } else {
  const description = await invokeArtifactAgent({
    context: options, runner, runId, runDirectory, parentTaskId, order: 1, stage: "description-reconstruction", roleId: "refine.description",
    inputRefs: [requirementsPath, rulesPath], outputPath: descriptionPath, startMarker: "<<<DESCRIPTION_START>>>", endMarker: "<<<DESCRIPTION_END>>>",
    prompt: `完整读取 ${requirementsPath} 与 ${rulesPath}，重构冻结后的任务 Description。必须包含实质性任务内容，不得复制“（Markdown）”等示例占位符。\n<<<DESCRIPTION_START>>>\n（在这里输出完整实质内容）\n<<<DESCRIPTION_END>>>`,
    transform: (value) => {
      const stripped = stripPipelineOnlyLines(value);
      if ([...stripped.text].length < 200 || /^(?:（?Markdown）?|（?在这里输出完整实质内容）?)$/i.test(stripped.text)
        || pipelineRuleLeaks(stripped.text).length) throw new Error("Description filter could not produce a substantive safe artifact");
      return stripped.text;
    },
    retries: 3,
  });
  await appendRecord(description.record);
  }

  const draft = await runRefineDraftAgent({
    cwd: options.cwd, provider: options.provider, model: options.model, timeoutMs: options.timeoutMs,
    ...(options.extensionPaths ? { extensionPaths: options.extensionPaths } : {}), runner,
    descriptionPath, skillPath: activeSkillPath, outputPath: draftPath, runId, parentTaskId, runDirectory,
    stage: "current-draft-generation", order: 2,
  });
  await appendRecord(draft.record);
  }

  const currentExpert = candidateExpertResume ? {
    artifact: JSON.parse(await readFile(draftExpertReportPath, "utf8")) as RefineExpertReport,
    record: completedCurrentExpert!,
    result: {
      documentAspectSetPath: join(runDirectory, "current-expert", "document-aspects.json"),
      recallMatchesPath: join(runDirectory, "current-expert", "recall-matches.json"),
      precisionMatchesPath: join(runDirectory, "current-expert", "precision-matches.json"),
      evidenceAlignmentsPath: join(runDirectory, "current-expert", "evidence-alignments.json"),
      goldExtracted: completedCurrentExpert!.subtasks?.some(call => call.stage === "gold-aspect-extraction") ?? false,
      goldAspectSetSha256: sha256(await readFile(goldAspectSetPath)),
    },
  } : await expertStage(options, runner, runId, runDirectory, parentTaskId, 3, "draft-expert-evaluation", descriptionPath, draftPath, goldPath, goldAspectSetPath, draftExpertReportPath, options.frozenGoldAspectSet?.sha256, resumeFailures, recoveredExpertCalls);
  await appendRecord(currentExpert.record);

  const [descriptionText, draftText, goldText, activeSkillText, expertText] = await Promise.all([
    readFile(descriptionPath, "utf8"), readFile(draftPath, "utf8"), readFile(goldPath, "utf8"), readFile(activeSkillPath, "utf8"), readFile(draftExpertReportPath, "utf8"),
  ]);
  const reviewHashes = { descriptionSha256: sha256(descriptionText), draftSha256: sha256(draftText), goldSha256: sha256(goldText), activeSkillSha256: sha256(activeSkillText), expertReportSha256: sha256(expertText) };
  let reviewArtifact: RefineReviewArtifact;
  if (candidateExpertResume) {
    const cachedReview = priorStages.find((record) => record.stage === "skill-review" && record.status === "completed");
    if (!cachedReview) throw new Error("Candidate Expert resume requires a completed Review checkpoint");
    await appendRecord(cachedReview);
    reviewArtifact = JSON.parse(await readFile(reviewPath, "utf8")) as RefineReviewArtifact;
  } else {
  const review = await invokeReviewAgent({
    context: options, runner, runId, runDirectory, parentTaskId, order: 4,
    inputRefs: [descriptionPath, draftPath, goldPath, activeSkillPath, draftExpertReportPath], outputPath: reviewPath,
    hashes: reviewHashes, expert: currentExpert.artifact,
  });
  await appendRecord(review.record);
  reviewArtifact = JSON.parse(review.value) as RefineReviewArtifact;
  }

  if (reviewArtifact.skillFindings.length === 0) {
    await writeFile(candidateSkillPath, activeSkillText, "utf8");
    await appendRecord({
      order: 5, stage: "candidate-skill-compilation", kind: "deterministic-tool", status: "completed",
      taskId: `${runId}:candidate-skill-compilation:no-op`, parentTaskId, parentRunId: runId, attempt: 1,
      card: cardEvidence(refineWorkflowCard("refine.policy-optimizer")), provider: null, model: null, toolAllowlist: [],
      inputRefs: [descriptionPath, activeSkillPath, reviewPath], outputRefs: [candidateSkillPath], inputArtifacts: await artifactEvidence([descriptionPath, activeSkillPath, reviewPath]),
      outputArtifacts: await artifactEvidence([candidateSkillPath]), eventsPath: null, readPaths: [], usage: null, skippedReason: "no-attributed-findings",
    });
    const decision = {
      schemaVersion: "1.0",
      decision: "reject",
      activeSkillOverwritten: false,
      expertScoreDelta: null,
      gates: { skillChanged: false, hasAttributedFindings: false },
      reasons: ["no-attributed-findings"],
      evaluationSkipped: ["candidate-draft-generation", "candidate-expert-evaluation", "independent-judge"],
      evidence: {
        activeSkillSha256: sha256(activeSkillText), candidateSkillSha256: sha256(activeSkillText),
        draftExpertSha256: sha256(expertText),
      },
    };
    await writeFile(promotionDecisionPath, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
    await appendRecord({
      order: 6, stage: "promotion-decision", kind: "deterministic-tool", status: "completed",
      taskId: `${runId}:promotion-decision:no-op`, parentTaskId, parentRunId: runId, attempt: 1,
      card: cardEvidence(workflowCard), provider: null, model: null, toolAllowlist: [],
      inputRefs: [activeSkillPath, candidateSkillPath, reviewPath, draftExpertReportPath], outputRefs: [promotionDecisionPath],
      inputArtifacts: await artifactEvidence([activeSkillPath, candidateSkillPath, reviewPath, draftExpertReportPath]),
      outputArtifacts: await artifactEvidence([promotionDecisionPath]), eventsPath: null, readPaths: [], usage: null,
      skippedReason: "no-attributed-findings",
    });
    const manifestInputs = await artifactEvidence([requirementsPath, goldPath, activeSkillPath, rulesPath, ...(frozenDescriptionPath ? [frozenDescriptionPath] : []), ...(options.frozenGoldAspectSet ? [options.frozenGoldAspectSet.path] : [])]);
    const skillVersion = /^version\s*:\s*(.+)$/mi.exec(activeSkillText)?.[1]?.trim() ?? `sha256:${sha256(activeSkillText).slice(0, 12)}`;
    const artifacts = {
      descriptionPath, draftPath, goldAspectSetPath, draftExpertReportPath, reviewPath, candidateSkillPath, promotionDecisionPath,
      currentDocumentAspectSetPath: currentExpert.result.documentAspectSetPath,
      currentRecallMatchesPath: currentExpert.result.recallMatchesPath,
      currentPrecisionMatchesPath: currentExpert.result.precisionMatchesPath,
      currentEvidenceAlignmentsPath: currentExpert.result.evidenceAlignmentsPath,
    };
    completeAdapters(records);
    const pendingSelfCheck: HarnessSelfCheckSummary = {
      status: "not-triggered", reason: "no-attributed-findings", nativeAcontextApi: false,
      executionPath: "pinned-acontext-failure-card-prompt-compatibility", failureCardDigest: ACONTEXT_FAILURE_CARD_DIGEST,
      sourceKind: "current-refine-run",
    };
    const sourceProvenance = await readSourceProvenance(options.cwd, "refine-workflow-harness-v2");
    const manifest = {
      schemaVersion: "2.0", harnessVersion: "refine-workflow-harness-v2", workflow: "gold-supervised-skill-refine", executionMode: "workflow",
    ...auxiliaryDiagnosticsMetadata,
      sourceProvenance, status: "rejected", runId, startedAt, completedAt: new Date().toISOString(),
      ...(resumeMetadata ? { resume: resumeMetadata } : {}),
      parentTask: { taskId: parentTaskId, card: cardEvidence(workflowCard), provider: options.provider, model: options.model },
      harnessProfile: harnessProfileSummary(options),
      inputs: { requirementsPath, goldPath, activeSkillPath, activeSkillVersion: skillVersion, rulesPath, ...(frozenDescriptionPath ? { frozenDescriptionPath } : {}), ...(options.frozenGoldAspectSet ? { frozenGoldAspectSet: options.frozenGoldAspectSet, goldAspectImport } : {}), artifacts: manifestInputs },
      callableSubagents: workflowCard.callableSubagents.map((roleId) => cardEvidence(refineWorkflowCard(roleId))),
      fixedDag: REFINE_CANONICAL_STAGE_SEQUENCE, stages: records, traceIndexPath,
      traceEvidence: "public JSONL events are primary; this manifest and index only locate attempts",
      termination: { reason: "no-attributed-findings", evaluationSkipped: decision.evaluationSkipped },
      artifacts,
      expert: {
        goldExtractorCalls: currentExpert.result.goldExtracted ? 1 : 0,
        goldAspectSetSha256: currentExpert.artifact.sourceInputs.goldAspectSetSha256,
        currentGoldAspectSetSha256: currentExpert.artifact.sourceInputs.goldAspectSetSha256,
        candidateGoldAspectSetSha256: null,
        reducer: currentExpert.artifact.computedBy,
      },
      selfCheck: pendingSelfCheck,
      guarantees: { baselineBusinessInput: false, draftReadsGold: false, candidateDraftReadsGold: false, activeSkillOverwritten: false, expertRegressionTriggersHarnessEvolution: automaticAuxiliaryDiagnostics },
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const selfCheck = await runWorkflowSelfChecks(options, runner, runId, runDirectory, manifestPath, records, artifacts,
      currentExpert.artifact.f1, currentExpert.artifact.f1, false);
    manifest.selfCheck = selfCheck;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(traceIndexPath, `${JSON.stringify({ schemaVersion: "1.0", status: "rejected", runId, manifestPath, failedStage: null, terminationReason: "no-attributed-findings", stages: records.map((record) => ({ stage: record.stage, status: record.status, eventsPath: record.eventsPath, attempts: record.attempts ?? [], subtasks: record.subtasks ?? [] })) }, null, 2)}\n`, "utf8");
    return {
      runId, runDirectory, manifestPath, status: "rejected", descriptionPath, draftPath, reviewPath, candidateSkillPath,
      draftExpertReportPath, promotionDecisionPath, goldAspectSetPath, selfCheck, stageArtifacts: artifacts,
    };
  } else if (candidateExpertResume) {
    const cachedCandidateSkill = priorStages.find((record) => record.stage === "candidate-skill-compilation" && record.status === "completed");
    if (!cachedCandidateSkill) throw new Error("Candidate Expert resume requires a completed Candidate Skill checkpoint");
    await appendRecord(cachedCandidateSkill);
  } else {
    const candidateSkill = await runRefinePolicyOptimizerAgent({
      cwd: options.cwd, provider: options.provider, model: options.model, timeoutMs: options.timeoutMs,
      ...(options.extensionPaths ? { extensionPaths: options.extensionPaths } : {}), runner, runId, runDirectory, parentTaskId,
      ...(options.taskType ? { taskType: options.taskType } : {}), ...(options.harnessProfile ? { harnessProfile: options.harnessProfile } : {}),
      descriptionPath, activeSkillPath, reviewPath, outputPath: candidateSkillPath,
    });
    await appendRecord(candidateSkill.record);
  }

  if (candidateExpertResume) {
    const cachedCandidateDraft = priorStages.find((record) => record.stage === "candidate-draft-generation" && record.status === "completed");
    if (!cachedCandidateDraft) throw new Error("Candidate Expert resume requires a completed Candidate Draft checkpoint");
    await appendRecord(cachedCandidateDraft);
  } else {
  const candidateDraft = await runRefineDraftAgent({
    cwd: options.cwd, provider: options.provider, model: options.model, timeoutMs: options.timeoutMs,
    ...(options.extensionPaths ? { extensionPaths: options.extensionPaths } : {}), runner,
    descriptionPath, skillPath: candidateSkillPath, outputPath: candidateDraftPath, runId, parentTaskId, runDirectory,
    stage: "candidate-draft-generation", order: 6,
  });
  await appendRecord(candidateDraft.record);
  }

  const candidateExpert = await expertStage(options, runner, runId, runDirectory, parentTaskId, 7, "candidate-expert-evaluation", descriptionPath, candidateDraftPath, goldPath, goldAspectSetPath, candidateExpertReportPath, currentExpert.result.goldAspectSetSha256,
    candidateExpertResume ? resumeFailures : undefined,
    candidateExpertResume ? recoveredExpertCalls : undefined);
  await appendRecord(candidateExpert.record);

  const candidateDraftText = await readFile(candidateDraftPath, "utf8");
  const judgeHashes = { descriptionSha256: sha256(descriptionText), goldSha256: sha256(goldText), draftSha256: sha256(draftText), candidateDraftSha256: sha256(candidateDraftText) };
  let judgeArtifact: RefineJudgeArtifact | undefined;
  let judgeFailure: WorkflowStageError | undefined;
  try {
    const judge = await invokeJudgeAgent({
      context: options, runner, runId, runDirectory, parentTaskId, order: 8,
      inputRefs: [descriptionPath, goldPath, draftPath, candidateDraftPath], outputPath: judgePath, hashes: judgeHashes,
    });
    await appendRecord(judge.record);
    judgeArtifact = JSON.parse(judge.value) as RefineJudgeArtifact;
  } catch (error) {
    if (error instanceof WorkflowControlError) throw error;
    if (!(error instanceof WorkflowStageError) || error.stageRecord.stage !== "independent-judge") throw error;
    judgeFailure = error;
    await appendRecord(error.stageRecord);
  }

  const [candidateSkillText, currentExpertText, candidateExpertText] = await Promise.all([
    readFile(candidateSkillPath, "utf8"), readFile(draftExpertReportPath, "utf8"), readFile(candidateExpertReportPath, "utf8"),
  ]);
  const expertHashes = { currentExpert: sha256(currentExpertText), candidateExpert: sha256(candidateExpertText) };
  const decision = judgeArtifact
    ? promotionDecision(activeSkillText, candidateSkillText, reviewArtifact, currentExpert.artifact, candidateExpert.artifact, judgeArtifact,
      { ...expertHashes, judge: sha256(await readFile(judgePath, "utf8")) })
    : promotionDecisionWithoutJudge(activeSkillText, candidateSkillText, reviewArtifact, currentExpert.artifact, candidateExpert.artifact, expertHashes, judgeFailure!);
  await writeFile(promotionDecisionPath, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
  await appendRecord({
    order: 9, stage: "promotion-decision", kind: "deterministic-tool", status: "completed", taskId: `${runId}:promotion-decision`,
    parentTaskId, parentRunId: runId, attempt: 1, card: cardEvidence(workflowCard), provider: null, model: null, toolAllowlist: [],
    inputRefs: [activeSkillPath, candidateSkillPath, reviewPath, draftExpertReportPath, candidateExpertReportPath, ...(judgeArtifact ? [judgePath] : [])], outputRefs: [promotionDecisionPath],
    inputArtifacts: await artifactEvidence([activeSkillPath, candidateSkillPath, reviewPath, draftExpertReportPath, candidateExpertReportPath, ...(judgeArtifact ? [judgePath] : [])]),
    outputArtifacts: await artifactEvidence([promotionDecisionPath]), eventsPath: null, readPaths: [], usage: null,
  });

  const manifestInputs = await artifactEvidence([requirementsPath, goldPath, activeSkillPath, rulesPath, ...(frozenDescriptionPath ? [frozenDescriptionPath] : []), ...(options.frozenGoldAspectSet ? [options.frozenGoldAspectSet.path] : [])]);
  const skillVersion = /^version\s*:\s*(.+)$/mi.exec(activeSkillText)?.[1]?.trim() ?? `sha256:${sha256(activeSkillText).slice(0, 12)}`;
  const artifacts = { descriptionPath, draftPath, goldAspectSetPath, draftExpertReportPath, reviewPath, candidateSkillPath, candidateDraftPath, candidateExpertReportPath, ...(judgeArtifact ? { judgePath } : {}), promotionDecisionPath,
    currentDocumentAspectSetPath: currentExpert.result.documentAspectSetPath, currentRecallMatchesPath: currentExpert.result.recallMatchesPath,
    currentPrecisionMatchesPath: currentExpert.result.precisionMatchesPath, currentEvidenceAlignmentsPath: currentExpert.result.evidenceAlignmentsPath,
    candidateDocumentAspectSetPath: candidateExpert.result.documentAspectSetPath, candidateRecallMatchesPath: candidateExpert.result.recallMatchesPath,
    candidatePrecisionMatchesPath: candidateExpert.result.precisionMatchesPath, candidateEvidenceAlignmentsPath: candidateExpert.result.evidenceAlignmentsPath };
  completeAdapters(records);
  const sourceProvenance = await readSourceProvenance(options.cwd, "refine-workflow-harness-v2");
  const manifest = {
    schemaVersion: "2.0", harnessVersion: "refine-workflow-harness-v2", workflow: "gold-supervised-skill-refine", executionMode: "workflow",
    ...auxiliaryDiagnosticsMetadata,
    sourceProvenance,
    status: decision.decision === "promote" ? "promoted" : "rejected", runId, startedAt, completedAt: new Date().toISOString(),
    ...(resumeMetadata ? { resume: resumeMetadata } : {}),
    parentTask: { taskId: parentTaskId, card: cardEvidence(workflowCard), provider: options.provider, model: options.model },
    harnessProfile: harnessProfileSummary(options),
    inputs: { requirementsPath, goldPath, activeSkillPath, activeSkillVersion: skillVersion, rulesPath, ...(frozenDescriptionPath ? { frozenDescriptionPath } : {}), ...(options.frozenGoldAspectSet ? { frozenGoldAspectSet: options.frozenGoldAspectSet, goldAspectImport } : {}), artifacts: manifestInputs },
    callableSubagents: workflowCard.callableSubagents.map((roleId) => cardEvidence(refineWorkflowCard(roleId))),
    fixedDag: REFINE_CANONICAL_STAGE_SEQUENCE, stages: records, traceIndexPath,
    traceEvidence: "public JSONL events are primary; this manifest and index only locate attempts",
    ...(judgeFailure ? { judgeAdvisoryStatus: { status: "unavailable", promotionBlocking: false, detail: judgeFailure.message } } : {}),
    artifacts,
    expert: { goldExtractorCalls: currentExpert.result.goldExtracted ? 1 : 0, goldAspectSetSha256: currentExpert.artifact.sourceInputs.goldAspectSetSha256,
      currentGoldAspectSetSha256: currentExpert.artifact.sourceInputs.goldAspectSetSha256, candidateGoldAspectSetSha256: candidateExpert.artifact.sourceInputs.goldAspectSetSha256,
      reducer: currentExpert.artifact.computedBy },
    selfCheck: { status: "not-triggered", reason: "pending-evaluation", nativeAcontextApi: false,
      executionPath: "pinned-acontext-failure-card-prompt-compatibility", failureCardDigest: ACONTEXT_FAILURE_CARD_DIGEST },
    guarantees: { baselineBusinessInput: false, draftReadsGold: false, candidateDraftReadsGold: false, activeSkillOverwritten: false, expertRegressionTriggersHarnessEvolution: automaticAuxiliaryDiagnostics },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const selfCheck = await runWorkflowSelfChecks(options, runner, runId, runDirectory, manifestPath, records, artifacts,
    currentExpert.artifact.f1, candidateExpert.artifact.f1, reviewArtifact.skillFindings.length > 0);
  manifest.selfCheck = selfCheck;
  manifest.guarantees.expertRegressionTriggersHarnessEvolution = automaticAuxiliaryDiagnostics;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(traceIndexPath, `${JSON.stringify({ schemaVersion: "1.0", status: manifest.status, runId, manifestPath, failedStage: judgeFailure ? "independent-judge" : null, terminationReason: null, judgeAdvisoryStatus: judgeFailure ? "unavailable" : "available", stages: records.map((record) => ({ stage: record.stage, status: record.status, eventsPath: record.eventsPath, attempts: record.attempts ?? [], subtasks: record.subtasks ?? [] })) }, null, 2)}\n`, "utf8");
  return {
    runId, runDirectory, manifestPath, status: decision.decision === "promote" ? "promoted" : "rejected",
    descriptionPath, draftPath, reviewPath, candidateSkillPath, candidateDraftPath,
    draftExpertReportPath, candidateExpertReportPath, ...(judgeArtifact ? { judgePath } : {}), promotionDecisionPath, goldAspectSetPath, selfCheck,
    stageArtifacts: artifacts,
  };
  } catch (error) {
    if (error instanceof WorkflowControlError && error.workflowStageRecord) { const record = error.workflowStageRecord as StageRecord; records.push(record); await persistProgress("failed", record.stage, error.message); throw error; }
    if (error instanceof WorkflowControlError) { await persistProgress("failed", "workflow", error.message); throw error; }
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof WorkflowStageError && !records.some((record) => record.stage === error.stageRecord.stage && record.status === "failed")) {
      records.push(error.stageRecord);
    }
    const failedStage = error instanceof WorkflowStageError ? error.stageRecord.stage : "workflow";
    await persistProgress("failed", failedStage, message);
    throw error;
  }
}
