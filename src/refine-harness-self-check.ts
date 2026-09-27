import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { AgentEventProvenance, AgentTaskOptions, AgentTaskResult } from "./agent-task-runner.js";
import { requiredReadInstruction, runAgentTask } from "./agent-task-runner.js";

export type HarnessSourceKind = "current-refine-run" | "historical-replay";
export type ResponsibilitySurface = "agent_card" | "prompt" | "skill" | "schema" | "tool" | "orchestration" | "integration" | "model" | "unknown";
type ConfigDigests = { prompt: string | null; skill: string | null; schema: string | null; tool: string | null; model: string | null };
export type AdapterProvenance = { availability: "available"; id: string; version: string; digest: string } | { availability: "unavailable"; id: null; version: null; digest: null };
export interface HarnessTaskState {
  stateId: string; sequence: number; kind: "root" | "logical_task" | "attempt" | "deterministic";
  status: "completed" | "failed" | "recovered" | "mixed" | "unknown"; logicalTaskId: string; taskId: string; attempt: number | null;
  retryOfStateId: string | null; stage: string; parentStateId: string | null; roleId: string | null; cardDigest: string | null;
  provider: string | null; model: string | null; configDigests: ConfigDigests; unavailableConfigKinds: Array<keyof ConfigDigests>; inputArtifactDigests: string[];
  outputArtifactDigests: string[]; eventPath: string | null; parallelGroupId: string | null; adapterProvenance: AdapterProvenance;
}
export interface HarnessTaskEdge { edgeId: string; type: "control" | "data" | "handoff" | "retry"; fromStateId: string; toStateId: string; artifactDigest: string | null }
export interface EvidenceRecord {
  evidenceId: string; kind: "message" | "tool" | "artifact" | "event" | "validation" | "score" | "digest";
  stateId: string; roleId: string | null; cardDigest: string | null; configDigests: ConfigDigests; unavailableConfigKinds: Array<keyof ConfigDigests>; sourcePath: string | null;
  sha256: string; relation: "produce" | "consume" | "aggregate" | "observe"; provenanceId: string;
  content: string | null; truncated: boolean; redacted: boolean;
}
export interface EvidenceBudget { maxRecords: number; maxBytes: number; includedRecords: number; includedBytes: number; droppedRecords: number; truncatedRecords: number }
export interface ContractValidationEntry { validationId: string; check: string; status: "pass" | "fail" | "warning"; stateIds: string[]; evidenceIds: string[]; observation: string }
export interface ContractValidationLog { schemaVersion: "1.0"; valid: boolean; entries: ContractValidationEntry[] }
export type DiagnosisSeedType = "candidate-expert-f1-regression" | "failed-attempt" | "contract-violation";
export interface DiagnosisSeed {
  seedId: string; type: DiagnosisSeedType; stateIds: string[]; evidenceIds: string[];
  occurrenceStateId: string; detectionStateId: string; propagationPath: string[];
  expectedCoverage: { minimumFindings: 1; maximumFindings: 1; referenceMode: "exactly-once" };
}
export interface ResponsibilityCandidate {
  category: ResponsibilitySurface; targetStateIds: string[]; targetRoleId: string | null; targetCardDigest: string | null;
  targetConfigDigest: string | null; supportingEvidenceIds: string[]; counterEvidenceIds: string[]; confidence: number;
  evidenceSufficiency: "sufficient" | "partial" | "insufficient"; rationale: string;
}
export interface FailureFinding {
  id: string; seedId: string; trigger: { type: DiagnosisSeedType; stateIds: string[]; evidenceIds: string[] };
  symptom: string; occurrenceStateIds: string[]; detectionStateIds: string[]; propagationPath: string[];
  responsibilityCandidates: ResponsibilityCandidate[];
  failureClass: "output_contract" | "input_contract" | "evaluation" | "orchestration" | "provider" | "data_lineage" | "unknown";
  severity: "low" | "medium" | "high" | "critical"; reproducibility: "observed" | "intermittent" | "unknown";
  presentationGroups: string[]; ambiguity: { status: "unambiguous" | "ambiguous" | "insufficient"; explanation: string };
}
export interface HarnessDiagnosisResult { schemaVersion: "1.0"; summary: string; findings: FailureFinding[] }
export interface CompactResponsibilityCandidate extends Omit<ResponsibilityCandidate, "targetStateIds" | "targetRoleId" | "targetCardDigest" | "targetConfigDigest" | "supportingEvidenceIds" | "counterEvidenceIds" | "confidence"> {
  targetStateRefs: number[]; supportingEvidenceRefs: number[]; counterEvidenceRefs: number[];
}
export type FailureFindingAnnotation = Pick<FailureFinding, "seedId" | "symptom" | "failureClass" | "severity" | "reproducibility"> & { responsibilityCandidates: CompactResponsibilityCandidate[] };
export interface HarnessDiagnosisAnnotationResult { schemaVersion: "1.1"; annotations: FailureFindingAnnotation[] }
export type HarnessDiagnosisNormalization = "none" | "marker-block" | "json-fence" | "unique-embedded-json";
export interface HarnessSelfCheckSummary {
  status: "triggered" | "not-triggered" | "failed"; reason: string; nativeAcontextApi: false;
  executionPath: "pinned-acontext-failure-card-prompt-compatibility" | "trace-first-refine-business-audit-v4"; failureCardDigest: string; sourceKind?: HarnessSourceKind;
  triggerPath?: string; taskStatePath?: string; contractValidationPath?: string; diagnosisInputPath?: string; diagnosisInputPaths?: string[];
  diagnosisInputBytes?: number; diagnosisInputShardCount?: number; diagnosisPath?: string; traceDigest?: string; error?: string;
  businessTriggerReasons?: string[]; behaviorAuditPath?: string; businessTaskStatePath?: string; businessRoleStatePaths?: string[]; engineeringDiagnosticsPath?: string;
  engineeringFailureDiagnosis?: HarnessSelfCheckSummary;
}
interface DiagnosisBatchAttempt {
  batchId: string; seedIds: string[]; attempt: number; taskId: string; eventsPath: string; providerSessionId: string | null;
  readShardPaths: string[]; status: "completed" | "failed"; normalization?: HarnessDiagnosisNormalization; error?: string;
}
interface CompletedDiagnosisBatch {
  batchId: string; seedIds: string[]; annotations: FailureFindingAnnotation[]; normalization: HarnessDiagnosisNormalization;
  readShardPaths: string[]; eventsPath: string; providerSessionId: string | null;
}
interface TraceCard { roleId?: string; version?: string; runtime?: string; digest?: string; embeddedSkill?: unknown; promptDigest?: string; schemaDigest?: string; toolDigest?: string }
interface TraceAttempt { attempt: number; taskId: string; eventsPath?: string; status: string; error?: string; eventProvenance?: AgentEventProvenance; adapterProvenance?: AdapterProvenance }
interface TraceArtifact { path: string; sha256: string }
export interface HarnessTraceStage {
  stage: string; taskId: string; parentTaskId?: string; kind?: string; status?: string; provider?: string | null; model?: string | null;
  card?: TraceCard; toolAllowlist?: readonly string[]; inputArtifacts?: TraceArtifact[]; outputArtifacts?: TraceArtifact[];
  attempts?: TraceAttempt[]; eventsPath?: string | null; eventProvenance?: AgentEventProvenance; adapterProvenance?: AdapterProvenance;
  subtasks?: Array<{ stage: string; taskId: string; parentTaskId: string; provider: string; model: string; card: TraceCard;
    toolAllowlist?: readonly string[]; inputArtifacts: TraceArtifact[]; outputArtifacts: TraceArtifact[]; attempts?: TraceAttempt[]; eventsPath?: string | null; eventProvenance?: AgentEventProvenance; adapterProvenance?: AdapterProvenance }>;
}
export type HarnessSelfCheckRunner = (options: AgentTaskOptions) => Promise<AgentTaskResult>;
export interface RunHarnessSelfCheckOptions {
  cwd: string; provider: string; model: string; timeoutMs: number; extensionPaths?: string[]; runner?: HarnessSelfCheckRunner;
  runId: string; runDirectory: string; manifestPath: string; currentF1: number; candidateF1: number; stages: HarnessTraceStage[];
  artifacts: Record<string, string>; eligibleForRegressionCheck?: boolean; sourceKind: HarnessSourceKind;
}

const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const MAX_EVIDENCE_BYTES = 16_384;
const MAX_EVIDENCE_TOTAL_BYTES = 262_144;
const MAX_EVIDENCE_RECORDS = 400;
const MAX_DIAGNOSIS_INPUT_FILE_BYTES = 45_000;
const MAX_DIAGNOSIS_SEEDS_PER_BATCH = 3;
const ACONTEXT_FAILURE_CARD_PROMPT = "Diagnose only from observable task states, messages, tools, artifacts, validations, scores, and digests. Separate trigger, symptom, occurrence, propagation, and responsibility candidates. Never infer hidden chain-of-thought and never propose, apply, or promote a change.";
export const ACONTEXT_FAILURE_CARD_DIGEST = sha(JSON.stringify({ version: "failure-diagnosis-v1.3-batched-compact-annotations", prompt: ACONTEXT_FAILURE_CARD_PROMPT, outputContract: diagnosisOutputContract() }));
const emptyConfig = (): ConfigDigests => ({ prompt: null, skill: null, schema: null, tool: null, model: null });
const unavailableConfigs = (value: ConfigDigests): Array<keyof ConfigDigests> => (Object.keys(value) as Array<keyof ConfigDigests>).filter((kind) => value[kind] === null);
const unavailableAdapter = (): AdapterProvenance => ({ availability: "unavailable", id: null, version: null, digest: null });
function configs(card: TraceCard | undefined, tools: readonly string[] | undefined, provider: string | null | undefined, model: string | null | undefined): ConfigDigests {
  return { prompt: card?.promptDigest ?? null, skill: card?.embeddedSkill === undefined ? null : sha(JSON.stringify(card.embeddedSkill)), schema: card?.schemaDigest ?? null,
    tool: tools === undefined ? null : sha(JSON.stringify([...tools])), model: provider || model ? sha(JSON.stringify({ provider: provider ?? null, model: model ?? null })) : null };
}
function matcherGroup(stage: string): string | null { const m = /^(current|candidate)-(recall|precision)-match-/.exec(stage); return m ? `${m[1]}-directional-matcher-parallel` : null; }
function artifactDigests(items: readonly TraceArtifact[] | undefined): string[] { return [...new Set((items ?? []).map((item) => item.sha256.trim()).filter(Boolean))]; }

export function projectRefineRunToTaskStates(stages: readonly HarnessTraceStage[], rootTaskId = "refine-run"): { states: HarnessTaskState[]; edges: HarnessTaskEdge[] } {
  const states: HarnessTaskState[] = []; const edges: HarnessTaskEdge[] = []; const used = new Set<string>(); const producers = new Map<string, { stateId: string; digest: string }>();
  const add = (raw: Omit<HarnessTaskState, "sequence">) => { let stateId = raw.stateId; for (let n = 2; used.has(stateId); n += 1) stateId = `${raw.stateId}:${n}`; used.add(stateId); const state = { ...raw, stateId, sequence: states.length + 1 }; states.push(state); return state; };
  const link = (type: HarnessTaskEdge["type"], from: string, to: string, artifactDigest: string | null = null) => edges.push({ edgeId: `edge-${edges.length + 1}`, type, fromStateId: from, toStateId: to, artifactDigest });
  const root = add({ stateId: `state:${rootTaskId}:root`, kind: "root", status: "completed", logicalTaskId: rootTaskId, taskId: rootTaskId,
    attempt: null, retryOfStateId: null, stage: "refine-root", parentStateId: null, roleId: null, cardDigest: null, provider: null,
    model: null, configDigests: emptyConfig(), unavailableConfigKinds: ["prompt", "skill", "schema", "tool", "model"], inputArtifactDigests: [], outputArtifactDigests: [], eventPath: null, parallelGroupId: null, adapterProvenance: unavailableAdapter() });
  const addLogical = (item: HarnessTraceStage | NonNullable<HarnessTraceStage["subtasks"]>[number], parentStateId: string, deterministic: boolean, logicalTaskId: string) => {
    const attempts = [...(item.attempts ?? [])].sort((a, b) => a.attempt - b.attempt);
    if (attempts.some((a) => !Number.isInteger(a.attempt) || a.attempt < 1 || !a.taskId.trim())) throw new Error(`Invalid attempt identity for ${item.stage}`);
    if (new Set(attempts.map((a) => a.attempt)).size !== attempts.length || new Set(attempts.map((a) => a.taskId)).size !== attempts.length) throw new Error(`Duplicate attempt identity for ${item.stage}`);
    const failed = attempts.some((a) => a.status === "failed"); const passed = attempts.some((a) => a.status === "completed");
    const explicitFailed = "status" in item && item.status === "failed";
    const itemConfigs = configs(item.card, item.toolAllowlist, item.provider, item.model);
    const finalAttempt = attempts.at(-1); const finalStatus: HarnessTaskState["status"] = finalAttempt
      ? finalAttempt.status === "completed" ? failed ? "recovered" : "completed" : passed ? "mixed" : "failed"
      : failed && passed ? "mixed" : failed ? "failed" : "completed";
    const logical = add({ stateId: `state:${item.taskId}:logical`, kind: deterministic ? "deterministic" : "logical_task", status: finalStatus,
      logicalTaskId, taskId: item.taskId, attempt: null, retryOfStateId: null, stage: item.stage, parentStateId,
      roleId: item.card?.roleId ?? null, cardDigest: item.card?.digest ?? null, provider: item.provider ?? null, model: item.model ?? null,
      configDigests: itemConfigs, unavailableConfigKinds: unavailableConfigs(itemConfigs), inputArtifactDigests: artifactDigests(item.inputArtifacts),
      outputArtifactDigests: artifactDigests(item.outputArtifacts), eventPath: item.eventsPath ?? null, parallelGroupId: matcherGroup(item.stage), adapterProvenance: item.adapterProvenance ?? unavailableAdapter() });
    let prior: HarnessTaskState | undefined; const attemptStates: HarnessTaskState[] = [];
    for (const attempt of attempts) { const attemptState = add({ stateId: `state:${item.taskId}:attempt-${attempt.attempt}`, kind: "attempt", status: attempt.status === "failed" ? "failed" : "completed",
      logicalTaskId, taskId: attempt.taskId, attempt: attempt.attempt, retryOfStateId: prior?.stateId ?? null, stage: item.stage,
      parentStateId: logical.stateId, roleId: logical.roleId, cardDigest: logical.cardDigest, provider: logical.provider, model: logical.model,
      configDigests: logical.configDigests, unavailableConfigKinds: logical.unavailableConfigKinds, inputArtifactDigests: logical.inputArtifactDigests, outputArtifactDigests: attempt.status === "completed" ? logical.outputArtifactDigests : [],
      eventPath: attempt.eventsPath ?? null, parallelGroupId: logical.parallelGroupId, adapterProvenance: attempt.adapterProvenance ?? logical.adapterProvenance }); if (prior) link("retry", prior.stateId, attemptState.stateId); prior = attemptState; attemptStates.push(attemptState); }
    if (explicitFailed) logical.status = "failed";
    return { logical, attemptStates };
  };
  let priorStage: HarnessTaskState | undefined;
  const canonicalCounts = new Map<string, number>();
  for (const stage of stages) {
    const ordinal = (canonicalCounts.get(stage.stage) ?? 0) + 1; canonicalCounts.set(stage.stage, ordinal);
    const stageLogicalId = `${rootTaskId}:${stage.stage}:${ordinal}`;
    const stageNode = addLogical(stage, root.stateId, stage.kind === "deterministic-tool", stageLogicalId); const logical = stageNode.logical;
    const entry = priorStage?.stateId ?? root.stateId;
    if ((stage.subtasks ?? []).length === 0) { if (stageNode.attemptStates.length) { link(priorStage ? "control" : "handoff", entry, stageNode.attemptStates[0]!.stateId); link("handoff", stageNode.attemptStates.at(-1)!.stateId, logical.stateId); } else link(priorStage ? "control" : "handoff", entry, logical.stateId); }
    else {
      const subCounts = new Map<string, number>(); const subtasks: HarnessTaskState[] = [];
      for (const subtask of stage.subtasks ?? []) { const subOrdinal = (subCounts.get(subtask.stage) ?? 0) + 1; subCounts.set(subtask.stage, subOrdinal); const subNode = addLogical(subtask, logical.stateId, false, `${stageLogicalId}:${subtask.stage}:${subOrdinal}`); const sub = subNode.logical; subtasks.push(sub); if (subNode.attemptStates.length) { link(priorStage ? "control" : "handoff", entry, subNode.attemptStates[0]!.stateId); link("handoff", subNode.attemptStates.at(-1)!.stateId, sub.stateId); } else link(priorStage ? "control" : "handoff", entry, sub.stateId); }
      for (const sub of subtasks) link("handoff", sub.stateId, logical.stateId);
      if (logical.status === "completed" && subtasks.some((sub) => sub.status === "recovered" || sub.status === "mixed")) logical.status = "mixed";
      if (subtasks.some((sub) => sub.status === "failed")) logical.status = "failed";
    }
    priorStage = logical;
  }
  const byTask = new Map(states.filter((state) => state.kind !== "attempt").map((state) => [state.taskId, state]));
  for (const stage of stages) for (const subtask of stage.subtasks ?? []) for (const artifact of subtask.outputArtifacts ?? []) if (artifact.sha256) producers.set(resolve(artifact.path).toLowerCase(), { stateId: byTask.get(subtask.taskId)!.stateId, digest: artifact.sha256 });
  for (const stage of stages) for (const artifact of stage.outputArtifacts ?? []) { const key = resolve(artifact.path).toLowerCase(); if (artifact.sha256 && !producers.has(key)) producers.set(key, { stateId: byTask.get(stage.taskId)!.stateId, digest: artifact.sha256 }); }
  for (const stage of stages) for (const item of [stage, ...(stage.subtasks ?? [])]) { const consumer = byTask.get(item.taskId)!; for (const artifact of item.inputArtifacts ?? []) { const producer = producers.get(resolve(artifact.path).toLowerCase()); if (producer && producer.stateId !== consumer.stateId) link("data", producer.stateId, consumer.stateId, producer.digest); } }
  const finalStages = stages.map((stage) => byTask.get(stage.taskId)!).filter(Boolean); root.status = finalStages.some((state) => state.status === "failed") ? "failed" : states.some((state) => state.kind === "attempt" && state.status === "failed") || finalStages.some((state) => state.status === "mixed" || state.status === "recovered") ? "mixed" : "completed";
  return { states, edges };
}

function truncateUtf8(raw: string, maxBytes: number): string { let bytes = 0; let result = ""; for (const character of raw) { const width = Buffer.byteLength(character); if (bytes + width > maxBytes) break; result += character; bytes += width; } return result; }
function sanitized(raw: string) {
  let safe = raw; let redacted = false;
  const replace = (pattern: RegExp, replacement: string) => { const next = safe.replace(pattern, replacement); if (next !== safe) redacted = true; safe = next; };
  replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]");
  replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_KEY]");
  replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED_KEY]");
  replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_TOKEN]");
  replace(/"(api[_-]?key|x-api-key|authorization|password|secret|token|access[_-]?token|refresh[_-]?token)"\s*:\s*"[^"]*"/gi, '"$1":"[REDACTED]"');
  replace(/([?&](?:api[_-]?key|access[_-]?token|token)=)[^&#\s]+/gi, "$1[REDACTED]");
  replace(/((?:api[_-]?key|x-api-key|authorization|password|secret|access[_-]?token|refresh[_-]?token)["'\s:=]+)[^\s,"'}]+/gi, "$1[REDACTED]");
  const truncated = Buffer.byteLength(safe) > MAX_EVIDENCE_BYTES;
  return { content: truncated ? truncateUtf8(safe, MAX_EVIDENCE_BYTES) : safe, truncated, redacted };
}
function textPath(path: string) { return [".json", ".jsonl", ".md", ".txt", ".yaml", ".yml", ".log", ".csv"].includes(extname(path).toLowerCase()); }
function evId(kind: EvidenceRecord["kind"], stateId: string, digest: string, relation: EvidenceRecord["relation"], index = 0) { return `evidence:${kind}:${sha(`${stateId}:${digest}:${relation}:${index}`).slice(0, 20)}`; }
function publicToolArguments(value: unknown): Record<string, string> | null { if (!value || typeof value !== "object") return null; const raw = value as Record<string, unknown>; const projected: Record<string, string> = {}; for (const key of ["path", "filePath", "file_path"]) if (typeof raw[key] === "string") projected[key] = raw[key]; return Object.keys(projected).length ? projected : null; }
function publicEvent(line: string): { kind: "message" | "tool" | "event"; content: string } | null {
  let raw: unknown; try { raw = JSON.parse(line); } catch { return null; }
  if (!raw || typeof raw !== "object") return null; const event = raw as Record<string, unknown>; const type = String(event.type ?? "");
  if (/thinking|reasoning|private|hidden/i.test(type)) return null;
  if (type === "message_end" && event.message && typeof event.message === "object") {
    const message = event.message as Record<string, unknown>; const role = String(message.role ?? ""); if (!["user", "assistant", "tool", "toolResult"].includes(role) || !Array.isArray(message.content)) return null;
    const content: Array<Record<string, unknown>> = []; for (const rawBlock of message.content) { if (!rawBlock || typeof rawBlock !== "object") continue; const block = rawBlock as Record<string, unknown>; const blockType = String(block.type ?? ""); if (/thinking|reasoning|private|hidden/i.test(blockType)) continue; if (blockType === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text }); else if (blockType === "toolCall" && typeof block.name === "string") content.push({ type: "toolCall", name: block.name, arguments: publicToolArguments(block.arguments) }); else if (/toolResult/i.test(blockType)) content.push({ type: "toolResult", name: typeof block.name === "string" ? block.name : null, content: typeof block.content === "string" ? block.content : null }); }
    if (!content.length) return null; return { kind: content.some((block) => block.type !== "text") ? "tool" : "message", content: JSON.stringify({ type: "message", role, content }) };
  }
  if (/^tool_/i.test(type) || /^toolExecution/i.test(type)) { const projected: Record<string, unknown> = { type }; for (const key of ["toolName", "name"]) if (typeof event[key] === "string") projected[key] = event[key]; projected.arguments = publicToolArguments(event.arguments); if (typeof event.result === "string") projected.result = event.result; if (typeof event.error === "string") projected.error = event.error; return { kind: "tool", content: JSON.stringify(projected) }; }
  if (/error|fail/i.test(type)) { const message = typeof event.error === "string" ? event.error : typeof event.message === "string" ? event.message : null; return message ? { kind: "event", content: JSON.stringify({ type, error: message }) } : null; }
  return null;
}
async function collectEvidence(states: HarnessTaskState[], stages: readonly HarnessTraceStage[], artifacts: Record<string, string>, manifestPath: string, currentF1: number, candidateF1: number) {
  const out: EvidenceRecord[] = []; const logical = new Map(states.filter((s) => s.kind !== "attempt").map((s) => [s.taskId, s])); const attempt = new Map(states.filter((s) => s.kind === "attempt").map((s) => [s.taskId, s])); const root = states[0]!;
  const budget: EvidenceBudget = { maxRecords: MAX_EVIDENCE_RECORDS, maxBytes: MAX_EVIDENCE_TOTAL_BYTES, includedRecords: 0, includedBytes: 0, droppedRecords: 0, truncatedRecords: 0 };
  const add = (kind: EvidenceRecord["kind"], relation: EvidenceRecord["relation"], state: HarnessTaskState, path: string | null, digest: string, raw: string | null, index = 0) => {
    const ordinaryRecordLimit = budget.maxRecords - 40; const ordinaryByteLimit = budget.maxBytes - 42_000;
    if (budget.includedRecords >= ordinaryRecordLimit || budget.includedBytes >= ordinaryByteLimit) { budget.droppedRecords += 1; return; }
    const remaining = ordinaryByteLimit - budget.includedBytes; const safe = raw === null ? { content: null, truncated: false, redacted: false } : sanitized(raw);
    if (safe.content !== null && Buffer.byteLength(safe.content) > remaining) { safe.content = truncateUtf8(safe.content, remaining); safe.truncated = true; }
    const bytes = safe.content === null ? 0 : Buffer.byteLength(safe.content); if (raw !== null && bytes === 0 && raw.length > 0) { budget.droppedRecords += 1; return; }
    const id = evId(kind, state.stateId, digest, relation, index); out.push({ evidenceId: id, kind, relation, provenanceId: `${state.stateId}:${relation}:${path ?? digest}:${id}`, stateId: state.stateId, roleId: state.roleId, cardDigest: state.cardDigest, configDigests: state.configDigests, unavailableConfigKinds: state.unavailableConfigKinds, sourcePath: path, sha256: digest, ...safe }); budget.includedRecords += 1; budget.includedBytes += bytes; if (safe.truncated) budget.truncatedRecords += 1;
  };
  const detection = states.find((s) => s.stage === "promotion-decision") ?? root; add("score", "observe", detection, null, sha(`${currentF1}:${candidateF1}`), JSON.stringify({ currentF1, candidateF1, delta: candidateF1 - currentF1 }));
  const events = new Map<string, HarnessTaskState>(); const producers = new Map<string, { state: HarnessTaskState; relation: "produce" | "aggregate"; digest: string }>(); const consumers: Array<{ path: string; state: HarnessTaskState; digest: string }> = [];
  const visit = (item: HarnessTraceStage | NonNullable<HarnessTraceStage["subtasks"]>[number], fallback: HarnessTaskState, isAggregate: boolean) => { const state = logical.get(item.taskId) ?? fallback; for (const artifact of item.outputArtifacts ?? []) producers.set(resolve(artifact.path).toLowerCase(), { state, relation: isAggregate ? "aggregate" : "produce", digest: artifact.sha256 }); for (const artifact of item.inputArtifacts ?? []) consumers.push({ path: artifact.path, state, digest: artifact.sha256 }); if (item.eventsPath) events.set(resolve(item.eventsPath).toLowerCase(), state); for (const a of item.attempts ?? []) { const owner = attempt.get(a.taskId) ?? state; if (a.eventsPath) events.set(resolve(a.eventsPath).toLowerCase(), owner); if (a.error) add("validation", "observe", owner, a.eventsPath ?? null, sha(a.error), a.error); } return state; };
  for (const stage of stages) { const stageState = visit(stage, root, Boolean(stage.subtasks?.length)); for (const sub of stage.subtasks ?? []) visit(sub, stageState, false); }
  const manifest = await readFile(manifestPath); add("digest", "observe", root, manifestPath, sha(manifest), `Manifest SHA-256: ${sha(manifest)}`);
  for (const path of Object.values(artifacts)) { const key = resolve(path).toLowerCase(); if (!producers.has(key)) producers.set(key, { state: root, relation: "aggregate", digest: "" }); }
  const failedEventPaths = new Set(states.filter((s) => s.status === "failed" && s.eventPath).map((s) => resolve(s.eventPath!).toLowerCase())); const orderedEvents = [...events.entries()].sort(([a], [b]) => Number(failedEventPaths.has(b)) - Number(failedEventPaths.has(a)) || a.localeCompare(b));
  const eventProjectionStats: Array<{ path: string; stateId: string; scannedLines: number; publicRecords: number; selectedRecords: number; droppedRecords: number }> = [];
  const addEvents = async (items: Array<[string, HarnessTaskState]>) => { for (const [path, state] of items) try { const lines = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean); const projected = lines.map((line, index) => ({ index, value: publicEvent(line) })).filter((item): item is { index: number; value: NonNullable<ReturnType<typeof publicEvent>> } => item.value !== null); let chosen = projected.slice(-20); if (failedEventPaths.has(path)) { const terminal = [projected.filter((item) => item.value.content.includes('"role":"assistant"')).at(-1), projected.filter((item) => item.value.content.includes('"role":"toolResult"')).at(-1), projected.filter((item) => item.value.kind === "event").at(-1)].filter((item): item is { index: number; value: NonNullable<ReturnType<typeof publicEvent>> } => Boolean(item)); chosen = [...new Map(terminal.map((item) => [item.index, item])).values()].sort((a, b) => a.index - b.index); } for (const item of chosen) add(item.value.kind, "observe", state, state.eventPath, sha(item.value.content), item.value.content, item.index); eventProjectionStats.push({ path, stateId: state.stateId, scannedLines: lines.length, publicRecords: projected.length, selectedRecords: chosen.length, droppedRecords: projected.length - chosen.length }); } catch { eventProjectionStats.push({ path, stateId: state.stateId, scannedLines: 0, publicRecords: 0, selectedRecords: 0, droppedRecords: 0 }); } };
  await addEvents(orderedEvents.filter(([path]) => failedEventPaths.has(path)));
  const orderedProducers = [...producers.entries()].sort(([, a], [, b]) => Number(b.state.status === "failed" || b.state.status === "mixed") - Number(a.state.status === "failed" || a.state.status === "mixed") || a.state.sequence - b.state.sequence);
  for (const [path, provenance] of orderedProducers) try { const bytes = await readFile(path); const digest = sha(bytes); const summary = textPath(path) ? `Artifact ${provenance.relation}; bytes=${bytes.length}; sha256=${digest}; preview=${truncateUtf8(bytes.toString(), provenance.state.status === "failed" || provenance.state.status === "mixed" ? 2048 : 256)}` : null; add("artifact", provenance.relation, provenance.state, path, digest, summary); } catch { /* validation records absence */ }
  await addEvents(orderedEvents.filter(([path]) => !failedEventPaths.has(path)));
  const uniqueConsumers = new Map(consumers.map((item) => [`${item.state.stateId}:${resolve(item.path).toLowerCase()}`, item]));
  for (const item of [...uniqueConsumers.values()].sort((a, b) => a.path.localeCompare(b.path) || a.state.sequence - b.state.sequence)) add("digest", "consume", item.state, item.path, item.digest, `Consumed artifact SHA-256: ${item.digest}`);
  return { records: out, budget, eventProjectionStats };
}

async function contractLog(states: HarnessTaskState[], edges: HarnessTaskEdge[], stages: readonly HarnessTraceStage[], evidence: EvidenceRecord[], currentF1: number, candidateF1: number): Promise<ContractValidationLog> {
  const entries: ContractValidationEntry[] = []; const add = (check: string, status: ContractValidationEntry["status"], stateIds: string[], evidenceIds: string[], observation: string) => entries.push({ validationId: `validation-${entries.length + 1}`, check, status, stateIds, evidenceIds, observation }); const ids = new Set(states.map((s) => s.stateId));
  const dangling = edges.filter((e) => !ids.has(e.fromStateId) || !ids.has(e.toStateId)); add("dag-edge-references", dangling.length ? "fail" : "pass", [], [], dangling.length ? `${dangling.length} dangling edges.` : "All edges reference observed states.");
  const roots = states.filter((s) => s.kind === "root"); add("single-root-logical-task", roots.length === 1 ? "pass" : "fail", roots.map((s) => s.stateId), [], `Observed ${roots.length} root state(s).`);
  const parents = states.filter((s) => s.parentStateId !== null && !ids.has(s.parentStateId)); add("parent-state-references", parents.length ? "fail" : "pass", parents.map((s) => s.stateId), [], parents.length ? "State has a missing parent." : "Every non-root parent exists.");
  const broken = states.filter((s) => s.kind === "attempt" && (s.attempt ?? 0) > 1 && !s.retryOfStateId); add("attempt-retry-lineage", broken.length ? "fail" : "pass", broken.map((s) => s.stateId), [], broken.length ? "Retry lacks retryOfStateId." : "Attempts are siblings with explicit retry lineage.");
  const matchers = states.filter((s) => /-(recall|precision)-match-/.test(s.stage)); add("directional-matcher-parallel-groups", matchers.some((s) => !s.parallelGroupId) ? "fail" : "pass", matchers.map((s) => s.stateId), [], "Directional matcher parallel groups checked.");
  const scoreIds = evidence.filter((e) => e.kind === "score").map((e) => e.evidenceId); const scoreOk = Number.isFinite(currentF1) && Number.isFinite(candidateF1) && currentF1 >= 0 && currentF1 <= 1 && candidateF1 >= 0 && candidateF1 <= 1; add("score-input-range", scoreOk ? "pass" : "fail", states.filter((s) => /candidate.*expert|promotion-decision/.test(s.stage)).map((s) => s.stateId), scoreIds, scoreOk ? `Scores are in range; observed delta ${candidateF1 - currentF1}.` : "A score is non-finite or outside [0,1].");
  const adjacency = new Map(states.map((s) => [s.stateId, [] as string[]])); for (const edge of edges) adjacency.get(edge.fromStateId)?.push(edge.toStateId);
  const visiting = new Set<string>(); const visited = new Set<string>(); let cyclic = false; const dfs = (id: string) => { if (visiting.has(id)) { cyclic = true; return; } if (visited.has(id)) return; visiting.add(id); for (const next of adjacency.get(id) ?? []) dfs(next); visiting.delete(id); visited.add(id); }; for (const state of states) dfs(state.stateId);
  add("dag-acyclic", cyclic ? "fail" : "pass", [], [], cyclic ? "Cycle detected in task-state DAG." : "Task-state DAG is acyclic.");
  const reachable = new Set<string>(); const walk = (id: string) => { if (reachable.has(id)) return; reachable.add(id); for (const next of adjacency.get(id) ?? []) walk(next); }; if (roots[0]) walk(roots[0].stateId); const disconnected = states.filter((s) => !reachable.has(s.stateId)); add("dag-root-connectivity", disconnected.length ? "fail" : "pass", disconnected.map((s) => s.stateId), [], disconnected.length ? "States are disconnected from root." : "All states are reachable from root.");
  const reducers = states.filter((s) => s.kind === "deterministic" && stages.find((stage) => stage.taskId === s.taskId)?.subtasks?.length); const badHandoffs = reducers.filter((reducer) => states.filter((s) => s.parentStateId === reducer.stateId).some((sub) => !edges.some((edge) => edge.type === "handoff" && edge.fromStateId === sub.stateId && edge.toStateId === reducer.stateId))); add("subtask-before-reducer-handoff", badHandoffs.length ? "fail" : "pass", badHandoffs.map((s) => s.stateId), [], badHandoffs.length ? "Reducer lacks a subtask-to-reducer handoff." : "Expert subtasks hand off before their deterministic reducer.");
  const produced = evidence.filter((e) => e.kind === "artifact" && ["produce", "aggregate"].includes(e.relation)); const missingProducer = edges.filter((edge) => edge.type === "data" && edge.artifactDigest && !produced.some((record) => record.sha256 === edge.artifactDigest && record.stateId === edge.fromStateId)); add("data-edge-producer", missingProducer.length ? "fail" : "pass", missingProducer.flatMap((e) => [e.fromStateId, e.toStateId]), [], missingProducer.length ? "A data edge source lacks matching artifact producer evidence." : "Every data edge source has matching artifact producer evidence.");
  const stateByTask = new Map(states.map((s) => [s.taskId, s])); const flattened = stages.flatMap((stage) => [stage, ...(stage.subtasks ?? [])]);
  for (const item of flattened) {
    const state = stateByTask.get(item.taskId); for (const artifact of [...(item.inputArtifacts ?? []), ...(item.outputArtifacts ?? [])].sort((a, b) => a.path.localeCompare(b.path))) {
      try { const actual = sha(await readFile(artifact.path)); add("artifact-digest", actual === artifact.sha256 ? "pass" : "fail", state ? [state.stateId] : [], evidence.filter((e) => e.sourcePath === artifact.path && e.stateId === state?.stateId).map((e) => e.evidenceId), actual === artifact.sha256 ? `Digest verified: ${artifact.path}` : `Digest mismatch: ${artifact.path}`); }
      catch { add("artifact-availability", "fail", state ? [state.stateId] : [], [], `Artifact unavailable: ${artifact.path}`); }
    }
    const eventOwners = [{ path: item.eventsPath, state }, ...(item.attempts ?? []).map((attempt) => ({ path: attempt.eventsPath, state: stateByTask.get(attempt.taskId) }))]
      .filter((entry): entry is { path: string; state: HarnessTaskState | undefined } => Boolean(entry.path)).sort((a, b) => a.path.localeCompare(b.path));
    for (const event of eventOwners) { try { await readFile(event.path); add("event-availability", "pass", event.state ? [event.state.stateId] : [], evidence.filter((e) => e.sourcePath === event.path).map((e) => e.evidenceId), `Event stream available: ${event.path}`); } catch { add("event-availability", "warning", event.state ? [event.state.stateId] : [], [], `Event stream unavailable: ${event.path}`); } }
    add("state-config-provenance", state && (state.cardDigest || Object.values(state.configDigests).some(Boolean)) ? "pass" : "warning", state ? [state.stateId] : [], [], state ? "Available Card/config digests recorded; null values mean unavailable." : "State missing for config validation.");
  }
  return { schemaVersion: "1.0", valid: entries.every((e) => e.status !== "fail"), entries };
}

function validationEvidence(log: ContractValidationLog, states: HarnessTaskState[]): EvidenceRecord[] {
  const stateMap = new Map(states.map((state) => [state.stateId, state])); const root = states[0]!;
  return log.entries.map((entry) => { const state = stateMap.get(entry.stateIds[0] ?? "") ?? root; const content = JSON.stringify({ check: entry.check, status: entry.status, observation: entry.observation }); const digest = sha(content); return { evidenceId: `evidence:validation:${sha(entry.validationId).slice(0, 20)}`, kind: "validation", relation: "observe", provenanceId: `contract-validation:${entry.validationId}`, stateId: state.stateId, roleId: state.roleId, cardDigest: state.cardDigest, configDigests: state.configDigests, unavailableConfigKinds: state.unavailableConfigKinds, sourcePath: null, sha256: digest, content, truncated: false, redacted: false }; });
}
function failedStatusEvidence(states: HarnessTaskState[]): EvidenceRecord[] { return states.filter((state) => state.kind === "attempt" && state.status === "failed").map((state) => { const content = JSON.stringify({ status: "failed", source: "trace-attempt-status" }); const digest = sha(`${state.stateId}:${content}`); return { evidenceId: evId("validation", state.stateId, digest, "observe"), kind: "validation", relation: "observe", provenanceId: `trace-status:${state.stateId}`, stateId: state.stateId, roleId: state.roleId, cardDigest: state.cardDigest, configDigests: state.configDigests, unavailableConfigKinds: state.unavailableConfigKinds, sourcePath: state.eventPath, sha256: digest, content, truncated: false, redacted: false }; }); }

function directedPath(edges: readonly HarnessTaskEdge[], from: string, to: string): string[] | null {
  if (from === to) return [from];
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) outgoing.set(edge.fromStateId, [...(outgoing.get(edge.fromStateId) ?? []), edge.toStateId]);
  const queue: string[][] = [[from]]; const visited = new Set([from]);
  while (queue.length) {
    const path = queue.shift()!;
    for (const next of outgoing.get(path.at(-1)!) ?? []) {
      if (visited.has(next)) continue;
      const candidate = [...path, next]; if (next === to) return candidate;
      visited.add(next); queue.push(candidate);
    }
  }
  return null;
}

export function buildDiagnosisSeeds(options: { dag: { states: HarnessTaskState[]; edges: HarnessTaskEdge[] }; evidence: readonly EvidenceRecord[];
  validation: ContractValidationLog; currentF1: number; candidateF1: number; eligibleForRegressionCheck?: boolean }): DiagnosisSeed[] {
  const { dag, evidence, validation } = options; const root = dag.states.find((state) => state.kind === "root")!;
  const result: DiagnosisSeed[] = []; const used = new Set<string>();
  const add = (type: DiagnosisSeedType, stateIds: string[], evidenceIds: string[], occurrenceStateId: string, detectionStateId: string, propagationPath: string[]) => {
    const base = `seed:${type}:${sha(JSON.stringify({ stateIds, evidenceIds, occurrenceStateId, detectionStateId })).slice(0, 16)}`;
    if (used.has(base)) return; used.add(base);
    result.push({ seedId: base, type, stateIds, evidenceIds, occurrenceStateId, detectionStateId, propagationPath,
      expectedCoverage: { minimumFindings: 1, maximumFindings: 1, referenceMode: "exactly-once" } });
  };
  const scoreEvidence = evidence.filter((record) => record.kind === "score");
  if (options.eligibleForRegressionCheck !== false && options.candidateF1 < options.currentF1 && scoreEvidence.length) {
    const occurrence = dag.states.find((state) => state.stage === "candidate-expert-evaluation" && state.kind !== "attempt")
      ?? dag.states.find((state) => /candidate.*expert/.test(state.stage)) ?? root;
    const detection = dag.states.find((state) => state.stage === "promotion-decision" && state.kind !== "attempt") ?? occurrence;
    const path = directedPath(dag.edges, occurrence.stateId, detection.stateId);
    const observedDetection = path ? detection : occurrence;
    add("candidate-expert-f1-regression", [...new Set([occurrence.stateId, observedDetection.stateId])], scoreEvidence.map((record) => record.evidenceId),
      occurrence.stateId, observedDetection.stateId, path ?? [occurrence.stateId]);
  }
  for (const state of dag.states.filter((item) => item.kind === "attempt" && item.status === "failed")) {
    const owned = evidence.filter((record) => record.stateId === state.stateId && (record.kind === "validation" || record.kind === "event" || record.kind === "message" || record.kind === "tool"));
    const retry = dag.edges.find((edge) => edge.type === "retry" && edge.fromStateId === state.stateId)?.toStateId;
    if (owned.length) add("failed-attempt", [state.stateId], owned.map((record) => record.evidenceId), state.stateId, retry ?? state.stateId, retry ? [state.stateId, retry] : [state.stateId]);
  }
  const validationEvidenceById = new Map(evidence.filter((record) => record.provenanceId.startsWith("contract-validation:"))
    .map((record) => [record.provenanceId.slice("contract-validation:".length), record]));
  for (const entry of validation.entries.filter((item) => item.status === "fail")) {
    const validationRecord = validationEvidenceById.get(entry.validationId); if (!validationRecord) continue;
    const stateIds = entry.stateIds.length ? [...new Set(entry.stateIds)] : [validationRecord.stateId];
    const occurrence = stateIds[0] ?? root.stateId;
    add("contract-violation", stateIds, [validationRecord.evidenceId], occurrence, occurrence, [occurrence]);
  }
  return result;
}

function diagnosisOutputContract() {
  return {
    schemaVersion: "1.1",
    exactTopLevelKeys: ["schemaVersion", "annotations"],
    exactAnnotationKeys: ["seedId", "symptom", "responsibilityCandidates", "failureClass", "severity", "reproducibility"],
    exactResponsibilityKeys: ["category", "targetStateRefs", "supportingEvidenceRefs", "counterEvidenceRefs", "evidenceSufficiency", "rationale"],
    enums: {
      triggerType: ["candidate-expert-f1-regression", "failed-attempt", "contract-violation"],
      responsibilityCategory: ["agent_card", "prompt", "skill", "schema", "tool", "orchestration", "integration", "model", "unknown"],
      evidenceSufficiency: ["sufficient", "partial", "insufficient"],
      failureClass: ["output_contract", "input_contract", "evaluation", "orchestration", "provider", "data_lineage", "unknown"],
      severity: ["low", "medium", "high", "critical"], reproducibility: ["observed", "intermittent", "unknown"],
    },
    constraints: [
      "Use only numeric stateRef/evidenceRef values present in the union of all diagnosis-input shards; these stable refs resolve to decoded stateId/evidenceId values.",
      "Return compact JSON only. In a batched call, each seed explicitly named by the current batch is referenced by exactly one annotation; seeds outside that batch are forbidden.",
      "Do not repeat trigger, occurrenceStateIds, detectionStateIds, propagationPath, or finding id; the deterministic compiler restores them from the referenced seed.",
      "UTF-8 budgets: symptom <= 600; rationale <= 900; exactly 1 responsibilityCandidate per seed. Summary, confidence, ambiguity, and presentation groups are added deterministically and are not model output.",
      "targetStateRefs and Evidence refs are the numeric stateRef/evidenceRef values in decoded tuples; do not repeat long IDs.",
      "unknown responsibility has evidenceSufficiency=insufficient; role/Card/config identity and confidence are never emitted and are derived by the Compiler.",
      "Use at most 2 targetStateRefs, at most 3 supportingEvidenceRefs, and at most 2 counterEvidenceRefs. For unknown responsibility use exactly the Seed's groundingStateRef and its single groundingEvidenceRefs entry.",
      "Every targetStateRef must own at least one supportingEvidenceRef. For each non-unknown responsibility, all targets must share the Compiler-derived role, Card, and category-compatible config digest; extra ungrounded targets are forbidden.",
      "A role/Card/config digest proves identity, not causation. Keep unknown/insufficient unless observable content or a controlled contrast distinguishes one responsibility category from plausible alternatives. Repeated mixed pass/fail outputs under the same config are not proof of a Prompt or Schema defect.",
      "Describe the exact observed output shape and validation message. A generic validator phrase such as 'score fields are forbidden' does not prove score fields were emitted; one bare JSON object is allowed, while prose plus JSON is not a single bare object.",
      "Do not add patch, recommendation, proposedPrompt, proposedSkill, autoApply, or promotion fields.",
    ],
  };
}

function diagnosisSeedInputs(seeds: readonly DiagnosisSeed[], states: readonly HarnessTaskState[], evidence: readonly EvidenceRecord[]) {
  const stateRefs = new Map(states.map((state, index) => [state.stateId, index + 1]));
  const evidenceRefs = new Map(evidence.map((record, index) => [record.evidenceId, index + 1]));
  const evidenceById = new Map(evidence.map((record) => [record.evidenceId, record]));
  return seeds.map((seed) => {
    const seedEvidence = seed.evidenceIds.map((id) => evidenceById.get(id)).filter((record): record is EvidenceRecord => Boolean(record));
    const preferredStateId = [seed.occurrenceStateId, seed.detectionStateId, ...seed.stateIds]
      .find((stateId) => seedEvidence.some((record) => record.stateId === stateId)) ?? seedEvidence[0]?.stateId;
    const groundingEvidenceRefs = seedEvidence.filter((record) => record.stateId === preferredStateId)
      .map((record) => evidenceRefs.get(record.evidenceId)).filter((ref): ref is number => ref !== undefined).slice(0, 1);
    const groundingStateRef = preferredStateId ? stateRefs.get(preferredStateId) ?? null : null;
    if (groundingStateRef === null || !groundingEvidenceRefs.length) throw new Error(`Diagnosis seed ${seed.seedId} has no exact-state grounding pair`);
    return { ...seed,
      stateRefs: seed.stateIds.map((id) => stateRefs.get(id)).filter((ref): ref is number => ref !== undefined),
      evidenceRefs: seed.evidenceIds.map((id) => evidenceRefs.get(id)).filter((ref): ref is number => ref !== undefined),
      occurrenceStateRef: stateRefs.get(seed.occurrenceStateId) ?? null,
      detectionStateRef: stateRefs.get(seed.detectionStateId) ?? null,
      groundingStateRef, groundingEvidenceRefs };
  });
}

function buildDiagnosisInputShards(options: { sourceKind: HarnessSourceKind; runId: string; traceDigest: string; seeds: DiagnosisSeed[];
  fullDag: { states: HarnessTaskState[]; edges: HarnessTaskEdge[] }; fullEvidence: EvidenceRecord[]; fullValidation: ContractValidationLog; collectionBudget: EvidenceBudget }) {
  const states = options.fullDag.states; const edges = options.fullDag.edges;
  const validationById = new Map(validationEvidence(options.fullValidation, options.fullDag.states).map((record) => [record.provenanceId.slice("contract-validation:".length), record]));
  const contractEntries = options.fullValidation.entries.filter((entry) => entry.status !== "pass")
    .map((entry) => ({ ...entry, validationEvidenceId: validationById.get(entry.validationId)?.evidenceId ?? null }));
  const stateMap = new Map(states.map((state) => [state.stateId, state]));
  const passGroups = new Map<string, { check: string; status: "pass"; stage: string | null; roleId: string | null; parallelGroupId: string | null; validationEntryCount: number; ownerStateCount: number }>();
  for (const entry of options.fullValidation.entries.filter((item) => item.status === "pass")) {
    const owners = entry.stateIds.length ? entry.stateIds.map((id) => stateMap.get(id)).filter(Boolean) as HarnessTaskState[] : [undefined];
    const seen = new Set<string>();
    for (const owner of owners) {
      const key = JSON.stringify([entry.check, owner?.stage ?? null, owner?.roleId ?? null, owner?.parallelGroupId ?? null]);
      if (seen.has(key)) continue; seen.add(key);
      const current = passGroups.get(key); if (current) { current.validationEntryCount += 1; current.ownerStateCount += owner ? 1 : 0; }
      else passGroups.set(key, { check: entry.check, status: "pass", stage: owner?.stage ?? null, roleId: owner?.roleId ?? null,
        parallelGroupId: owner?.parallelGroupId ?? null, validationEntryCount: 1, ownerStateCount: owner ? 1 : 0 });
    }
  }
  const passingContractSummaries = [...passGroups.values()].sort((a, b) => a.check.localeCompare(b.check)
    || String(a.stage).localeCompare(String(b.stage)) || String(a.roleId).localeCompare(String(b.roleId)));
  const seedEvidenceIds = new Set(options.seeds.flatMap((seed) => seed.evidenceIds));
  const causalStage = (stage: string) => /^(?:skill-review|candidate-skill-compilation|candidate-draft-generation|gold-aspect-extraction|(?:current|candidate)-(?:document-)?aspect-extraction|(?:current|candidate)-(?:recall|precision)-match-\d+|(?:current|candidate)-(?:(?:content|style)-alignment-\d+|alignment-\d+-(?:content|style))|(?:draft|current|candidate)-expert-evaluation|promotion-decision)$/.test(stage);
  const causalStateIds = new Set(states.filter((state) => causalStage(state.stage)).map((state) => state.stateId));
  const failedStateIds = new Set(states.filter((state) => state.status === "failed" || state.status === "recovered" || state.status === "mixed").map((state) => state.stateId));
  const evidence = options.fullEvidence.filter((record) => seedEvidenceIds.has(record.evidenceId)
    || causalStateIds.has(record.stateId) && (record.kind === "artifact" || record.kind === "digest" && record.relation === "consume"));
  const priority = (record: EvidenceRecord) => seedEvidenceIds.has(record.evidenceId) ? 0 : record.kind === "score" ? 1
    : record.kind === "validation" ? 2 : ["message", "tool", "event"].includes(record.kind) ? 3 : 4;
  evidence.sort((a, b) => priority(a) - priority(b) || a.provenanceId.localeCompare(b.provenanceId));
  const dictionaryValues = new Map<string, number>(); const dictionary: string[] = [];
  const intern = (value: string | null): number => { if (value === null) return -1; const known = dictionaryValues.get(value); if (known !== undefined) return known; const index = dictionary.length; dictionary.push(value); dictionaryValues.set(value, index); return index; };
  const configTuple = (value: ConfigDigests) => [intern(value.prompt), intern(value.skill), intern(value.schema), intern(value.tool), intern(value.model)];
  const stateTuples = states.map((state, index) => [index + 1, intern(state.stateId), state.sequence, intern(state.kind), intern(state.status), intern(state.logicalTaskId), intern(state.taskId), state.attempt,
    intern(state.retryOfStateId), intern(state.stage), intern(state.parentStateId), intern(state.roleId), intern(state.cardDigest), intern(state.provider), intern(state.model), configTuple(state.configDigests),
    state.unavailableConfigKinds.map(intern), state.inputArtifactDigests.map(intern), state.outputArtifactDigests.map(intern), intern(state.eventPath), intern(state.parallelGroupId),
    state.adapterProvenance.availability === "available" ? [intern(state.adapterProvenance.availability), intern(state.adapterProvenance.id), intern(state.adapterProvenance.version), intern(state.adapterProvenance.digest)] : [intern("unavailable"), -1, -1, -1]]);
  const edgeTuples = edges.map((edge) => [intern(edge.edgeId), intern(edge.type), intern(edge.fromStateId), intern(edge.toStateId), intern(edge.artifactDigest)]);
  const fullEvidenceRefs = new Map(options.fullEvidence.map((record, index) => [record.evidenceId, index + 1]));
  const diagnosisSeeds = diagnosisSeedInputs(options.seeds, states, options.fullEvidence);
  const evidenceTuples = evidence.map((record) => { const max = record.kind === "artifact" ? 512 : 1536; const content = record.content && Buffer.byteLength(record.content) > max ? truncateUtf8(record.content, max) : record.content;
    return [fullEvidenceRefs.get(record.evidenceId)!, intern(record.evidenceId), intern(record.kind), intern(record.stateId), intern(record.roleId), intern(record.cardDigest), configTuple(record.configDigests),
      record.unavailableConfigKinds.map(intern), intern(record.relation), intern(record.provenanceId), intern(record.sourcePath), intern(record.sha256), intern(content),
      record.truncated || content !== record.content, record.redacted]; });
  const contractTuples = contractEntries.map((entry) => [intern(entry.validationId), intern(entry.check), intern(entry.status), entry.stateIds.map(intern),
    entry.evidenceIds.map(intern), intern(entry.observation), intern(entry.validationEvidenceId)]);
  const passingContractSummaryTuples = passingContractSummaries.map((entry) => [intern(entry.check), intern(entry.status), intern(entry.stage), intern(entry.roleId),
    intern(entry.parallelGroupId), entry.validationEntryCount, entry.ownerStateCount]);
  const dictionaryEntries = dictionary.map((value, index) => [index, value]);
  type Item = { section: "dictionaryEntries" | "diagnosisSeeds" | "stateTuples" | "edgeTuples" | "evidenceTuples" | "contractValidationTuples" | "passingContractSummaryTuples"; value: unknown };
  const items: Item[] = [
    ...dictionaryEntries.map((value) => ({ section: "dictionaryEntries" as const, value })),
    ...diagnosisSeeds.map((value) => ({ section: "diagnosisSeeds" as const, value })),
    ...stateTuples.map((value) => ({ section: "stateTuples" as const, value })),
    ...edgeTuples.map((value) => ({ section: "edgeTuples" as const, value })),
    ...evidenceTuples.map((value) => ({ section: "evidenceTuples" as const, value })),
    ...contractTuples.map((value) => ({ section: "contractValidationTuples" as const, value })),
    ...passingContractSummaryTuples.map((value) => ({ section: "passingContractSummaryTuples" as const, value })),
  ];
  const groupMap = new Map<string, HarnessTaskState[]>(); for (const state of states) if (state.parallelGroupId) groupMap.set(state.parallelGroupId, [...(groupMap.get(state.parallelGroupId) ?? []), state]);
  const parallelGroupSummaries = [...groupMap].map(([parallelGroupId, members]) => ({ parallelGroupId, memberCount: members.filter((state) => state.kind !== "attempt").length, failedCount: members.filter((state) => state.status === "failed").length, roleIds: [...new Set(members.flatMap((state) => state.roleId ? [state.roleId] : []))] }));
  const diagnosisTruncatedEvidence = evidence.filter((record) => record.content !== null && Buffer.byteLength(record.content) > (record.kind === "artifact" ? 512 : 1536)).length;
  const budget = { maxBytesPerShard: MAX_DIAGNOSIS_INPUT_FILE_BYTES, rawStates: options.fullDag.states.length, originalStates: options.fullDag.states.length, includedStates: states.length,
    droppedStates: options.fullDag.states.length - states.length, rawEdges: options.fullDag.edges.length, originalEdges: options.fullDag.edges.length, includedEdges: edges.length,
    droppedEdges: options.fullDag.edges.length - edges.length, rawEvidence: options.fullEvidence.length + options.collectionBudget.droppedRecords, originalEvidence: options.fullEvidence.length + options.collectionBudget.droppedRecords, includedEvidence: evidence.length,
    droppedEvidence: options.collectionBudget.droppedRecords + options.fullEvidence.length - evidence.length,
    truncatedEvidence: options.collectionBudget.truncatedRecords + diagnosisTruncatedEvidence, originalContractEntries: options.fullValidation.entries.length,
    rawContractEntries: options.fullValidation.entries.length, includedContractEntries: options.fullValidation.entries.length,
    includedFullContractEntries: contractEntries.length,
    summarizedPassingContractEntries: options.fullValidation.entries.filter((entry) => entry.status === "pass").length,
    passingContractSummaryGroups: passingContractSummaries.length,
    droppedContractEntries: 0, droppedPassingContractEntries: 0,
    collectedEvidenceRecords: options.fullEvidence.length, omittedDiagnosisEvidence: options.fullEvidence.length - evidence.length,
    upstreamDroppedEvidence: options.collectionBudget.droppedRecords,
    evidenceCoverage: { seedRequired: seedEvidenceIds.size, seedRequiredIncluded: [...seedEvidenceIds].filter((id) => evidence.some((record) => record.evidenceId === id)).length,
      causalArtifactRecords: options.fullEvidence.filter((record) => record.kind === "artifact" && causalStateIds.has(record.stateId)).length,
      causalArtifactRecordsIncluded: evidence.filter((record) => record.kind === "artifact" && causalStateIds.has(record.stateId)).length,
      failureTerminalRecords: options.fullEvidence.filter((record) => ["message", "tool", "event", "validation"].includes(record.kind) && failedStateIds.has(record.stateId)).length,
      failureTerminalRecordsIncluded: evidence.filter((record) => ["message", "tool", "event", "validation"].includes(record.kind) && failedStateIds.has(record.stateId)).length },
    rawSeeds: options.seeds.length, includedSeeds: options.seeds.length, droppedSeeds: 0, parallelGroupSummaries };
  const make = (index: number) => ({ schemaVersion: "1.0", sourceKind: options.sourceKind, runId: options.runId, traceDigest: options.traceDigest,
    shardIndex: index, shardCount: 9999, outputContract: index === 1 ? diagnosisOutputContract() : null, budget: index === 1 ? budget : null,
    compactEncoding: index === 1 ? { dictionaryEntry: "[index,string]", stateTuple: ["stateRef", "stateId", "sequence", "kind", "status", "logicalTaskId", "taskId", "attempt", "retryOfStateId", "stage", "parentStateId", "roleId", "cardDigest", "provider", "model", "configDigests[prompt,skill,schema,tool,model]", "unavailableConfigKinds", "inputArtifactDigests", "outputArtifactDigests", "eventPath", "parallelGroupId", "adapter[availability,id,version,digest]"], edgeTuple: ["edgeId", "type", "fromStateId", "toStateId", "artifactDigest"],
      evidenceTuple: ["evidenceRef", "evidenceId", "kind", "stateId", "roleId", "cardDigest", "configDigests[prompt,skill,schema,tool,model]", "unavailableConfigKinds", "relation", "provenanceId", "sourcePath", "sha256", "content", "truncated", "redacted"],
      contractValidationTuple: ["validationId", "check", "status", "stateIds", "evidenceIds", "observation", "validationEvidenceId"],
      passingContractSummaryTuple: ["check", "status", "stage", "roleId", "parallelGroupId", "validationEntryCount", "ownerStateCount"],
      referenceRule: "stateRef/evidenceRef are stable positive ordinals into the frozen audit arrays. All string-valued tuple cells are shared-dictionary indexes; -1 means null. Dictionary entries may be located in any shard." } : null,
    dictionaryEntries: [] as unknown[],
    diagnosisSeeds: [] as unknown[],
    taskStateDag: { stateTuples: [] as unknown[], edgeTuples: [] as unknown[] }, evidenceTuples: [] as unknown[], contractValidationTuples: [] as unknown[], passingContractSummaryTuples: [] as unknown[] });
  const shards: ReturnType<typeof make>[] = []; let current = make(1); shards.push(current);
  const targetFor = (shard: ReturnType<typeof make>, section: Item["section"]): unknown[] => section === "stateTuples" ? shard.taskStateDag.stateTuples : section === "edgeTuples" ? shard.taskStateDag.edgeTuples : shard[section];
  for (const item of items) { const target = targetFor(current, item.section); target.push(item.value);
    if (Buffer.byteLength(JSON.stringify(current)) > MAX_DIAGNOSIS_INPUT_FILE_BYTES - 512) { target.pop(); current = make(shards.length + 1); shards.push(current); const retryTarget = targetFor(current, item.section); retryTarget.push(item.value); if (Buffer.byteLength(JSON.stringify(current)) > MAX_DIAGNOSIS_INPUT_FILE_BYTES - 512) throw new Error(`Diagnosis input item exceeds ${MAX_DIAGNOSIS_INPUT_FILE_BYTES} byte read limit`); } }
  for (const shard of shards) shard.shardCount = shards.length;
  const serialized = shards.map((shard) => `${JSON.stringify(shard)}\n`); const totalBytes = serialized.reduce((sum, value) => sum + Buffer.byteLength(value), 0);
  if (serialized.some((value) => Buffer.byteLength(value) > MAX_DIAGNOSIS_INPUT_FILE_BYTES)) throw new Error("Diagnosis input shard exceeds Agent read-safe limit");
  if (shards.length > 12 || totalBytes > 524_288) throw new Error(`Diagnosis input compact budget exceeded: shards=${shards.length}/12 bytes=${totalBytes}/524288; model invocation refused`);
  return { serialized, budget, visibleStateIds: new Set(states.map((state) => state.stateId)),
    visibleEvidenceIds: new Set(evidence.map((record) => record.evidenceId)),
    visibleEdgePairs: new Set(edges.map((edge) => `${edge.fromStateId}\0${edge.toStateId}`)), visibleSeedIds: new Set(options.seeds.map((seed) => seed.seedId)) };
}

function object(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; }
function exact(value: object, keys: readonly string[]) { const a = Object.keys(value).sort(); const b = [...keys].sort(); return a.length === b.length && a.every((x, i) => x === b[i]); }
function refs(value: unknown, label: string, allowed?: ReadonlySet<string>) { if (!Array.isArray(value) || value.some((x) => typeof x !== "string" || !x || (allowed && !allowed.has(x)))) throw new Error(`${label} contains invalid references`); return value as string[]; }

function diagnosticText(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty text`); return value.trim(); }

export function validateHarnessDiagnosis(value: unknown, states: readonly HarnessTaskState[], evidence: readonly EvidenceRecord[], edges: readonly HarnessTaskEdge[], seeds: readonly DiagnosisSeed[]): HarnessDiagnosisResult {
  const root = object(value, "diagnosis"); if (!exact(root, ["schemaVersion", "summary", "findings"]) || root.schemaVersion !== "1.0" || typeof root.summary !== "string" || !root.summary.trim() || !Array.isArray(root.findings)) throw new Error("Harness diagnosis schema is invalid");
  diagnosticText(root.summary, "summary");
  const stateMap = new Map(states.map((s) => [s.stateId, s])); const evidenceMap = new Map(evidence.map((e) => [e.evidenceId, e])); const stateIds = new Set(stateMap.keys()); const evidenceIds = new Set(evidenceMap.keys()); const findingIds = new Set<string>(); const seedMap = new Map(seeds.map((seed) => [seed.seedId, seed])); const seedReferences = new Map<string, number>(); const categories: ResponsibilitySurface[] = ["agent_card", "prompt", "skill", "schema", "tool", "orchestration", "integration", "model", "unknown"]; const edgePairs = new Set(edges.map((edge) => `${edge.fromStateId}\0${edge.toStateId}`));
  const findings = root.findings.map((raw, index) => { const item = object(raw, `finding ${index}`); const keys = ["id", "seedId", "trigger", "symptom", "occurrenceStateIds", "detectionStateIds", "propagationPath", "responsibilityCandidates", "failureClass", "severity", "reproducibility", "presentationGroups", "ambiguity"]; if (!exact(item, keys) || typeof item.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(item.id) || findingIds.has(item.id) || typeof item.seedId !== "string" || !seedMap.has(item.seedId) || typeof item.symptom !== "string" || !item.symptom.trim()) throw new Error("Failure finding identity or seed reference is invalid"); findingIds.add(item.id); seedReferences.set(item.seedId, (seedReferences.get(item.seedId) ?? 0) + 1); const seed = seedMap.get(item.seedId)!;
    diagnosticText(item.symptom, "symptom");
    const trigger = object(item.trigger, "trigger"); if (!exact(trigger, ["type", "stateIds", "evidenceIds"]) || !["candidate-expert-f1-regression", "failed-attempt", "contract-violation"].includes(String(trigger.type))) throw new Error("Failure trigger is invalid"); const triggerStates = refs(trigger.stateIds, "trigger states", stateIds); const triggerEvidence = refs(trigger.evidenceIds, "trigger evidence", evidenceIds); const occurrence = refs(item.occurrenceStateIds, "occurrence states", stateIds); const detection = refs(item.detectionStateIds, "detection states", stateIds); const path = refs(item.propagationPath, "propagation path", stateIds); const groups = refs(item.presentationGroups, "presentation groups"); if (groups.some((group) => !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(group))) throw new Error("presentationGroups contains unsafe ID");
    if (!triggerStates.length || !triggerEvidence.length || occurrence.length !== 1 || detection.length !== 1 || !path.length) throw new Error("Finding must have trigger evidence and exactly one occurrence/detection endpoint");
    if (trigger.type !== seed.type || JSON.stringify(triggerStates) !== JSON.stringify(seed.stateIds) || JSON.stringify(triggerEvidence) !== JSON.stringify(seed.evidenceIds)) throw new Error("Finding trigger does not exactly match its diagnosis seed");
    if (occurrence[0] !== seed.occurrenceStateId || detection[0] !== seed.detectionStateId || JSON.stringify(path) !== JSON.stringify(seed.propagationPath)) throw new Error("Finding occurrence, detection, or propagation differs from its diagnosis seed");
    if (path[0] !== occurrence[0] || path.at(-1) !== detection[0] || path.slice(1).some((stateId, i) => !edgePairs.has(`${path[i]}\0${stateId}`))) throw new Error("Propagation path is not an adjacent directed DAG path from occurrence to detection");
    if (triggerEvidence.some((id) => !triggerStates.includes(evidenceMap.get(id)!.stateId))) throw new Error("Trigger evidence is not owned by its trigger states");
    if (trigger.type === "failed-attempt" && !triggerStates.some((id) => stateMap.get(id)!.kind === "attempt" && stateMap.get(id)!.status === "failed")) throw new Error("failed-attempt trigger does not cite a failed attempt");
    if (trigger.type === "contract-violation" && !triggerEvidence.some((id) => evidenceMap.get(id)!.kind === "validation")) throw new Error("contract-violation trigger lacks validation evidence");
    if (trigger.type === "candidate-expert-f1-regression" && !triggerEvidence.some((id) => evidenceMap.get(id)!.kind === "score")) throw new Error("score-regression trigger lacks score evidence");
    if (!Array.isArray(item.responsibilityCandidates) || !item.responsibilityCandidates.length) throw new Error("Responsibility candidates are required"); const candidates = item.responsibilityCandidates.map((rawCandidate) => { const c = object(rawCandidate, "responsibility candidate"); const ckeys = ["category", "targetStateIds", "targetRoleId", "targetCardDigest", "targetConfigDigest", "supportingEvidenceIds", "counterEvidenceIds", "confidence", "evidenceSufficiency", "rationale"]; if (!exact(c, ckeys) || !categories.includes(c.category as ResponsibilitySurface) || typeof c.confidence !== "number" || c.confidence < 0 || c.confidence > 1 || typeof c.rationale !== "string" || !c.rationale.trim() || !["sufficient", "partial", "insufficient"].includes(String(c.evidenceSufficiency))) throw new Error("Responsibility candidate schema is invalid"); diagnosticText(c.rationale, "responsibility rationale"); const targets = refs(c.targetStateIds, "target states", stateIds); const supports = refs(c.supportingEvidenceIds, "supporting evidence", evidenceIds); refs(c.counterEvidenceIds, "counter evidence", evidenceIds); if (c.targetRoleId !== null && typeof c.targetRoleId !== "string" || c.targetCardDigest !== null && typeof c.targetCardDigest !== "string" || c.targetConfigDigest !== null && typeof c.targetConfigDigest !== "string") throw new Error("Responsibility target is invalid"); const targetStates = targets.map((id) => stateMap.get(id)!); const configKind = ({ prompt: "prompt", skill: "skill", schema: "schema", tool: "tool", model: "model" } as const)[c.category as "prompt" | "skill" | "schema" | "tool" | "model"]; if (configKind && c.targetConfigDigest === null) throw new Error("Responsibility config digest kind is incompatible with category"); if (c.category === "agent_card" && c.targetCardDigest === null) throw new Error("Agent Card responsibility requires its Card digest"); const allTargetsGrounded = targets.length > 0 && supports.length > 0 && targetStates.every((state) => supports.some((id) => evidenceMap.get(id)!.stateId === state.stateId)
      && (c.category === "unknown" || (c.targetRoleId === null || state.roleId === c.targetRoleId)
        && (c.targetCardDigest === null || state.cardDigest === c.targetCardDigest)
        && (!configKind || state.configDigests[configKind] === c.targetConfigDigest)));
    if (c.category === "unknown") { if (c.targetRoleId !== null || c.targetCardDigest !== null || c.targetConfigDigest !== null || c.evidenceSufficiency !== "insufficient" || c.confidence > 0.5) throw new Error("Unknown responsibility must remain untargeted, low-confidence, and insufficient"); } if (!allTargetsGrounded) throw new Error("Every responsibility target identity tuple and supporting evidence must be grounded in that exact target state"); if (c.evidenceSufficiency === "sufficient" && c.confidence < 0.67 || c.evidenceSufficiency === "insufficient" && c.confidence > 0.5) throw new Error("Responsibility confidence and sufficiency are incompatible"); return c as unknown as ResponsibilityCandidate; });
    const ambiguity = object(item.ambiguity, "ambiguity"); if (!exact(ambiguity, ["status", "explanation"]) || !["unambiguous", "ambiguous", "insufficient"].includes(String(ambiguity.status)) || typeof ambiguity.explanation !== "string" || !ambiguity.explanation.trim()) throw new Error("Ambiguity is invalid"); diagnosticText(ambiguity.explanation, "ambiguity explanation"); if (candidates.every((c) => c.evidenceSufficiency === "insufficient") && ambiguity.status !== "insufficient" || ambiguity.status === "unambiguous" && !candidates.some((c) => c.evidenceSufficiency === "sufficient" && c.confidence >= 0.67)) throw new Error("Ambiguity is incompatible with evidence sufficiency"); if (!["output_contract", "input_contract", "evaluation", "orchestration", "provider", "data_lineage", "unknown"].includes(String(item.failureClass)) || !["low", "medium", "high", "critical"].includes(String(item.severity)) || !["observed", "intermittent", "unknown"].includes(String(item.reproducibility))) throw new Error("Failure classification is invalid"); return item as unknown as FailureFinding; });
  if (seeds.some((seed) => seedReferences.get(seed.seedId) !== 1) || [...seedReferences].some(([seedId, count]) => !seedMap.has(seedId) || count !== 1)) throw new Error("Diagnosis seed coverage must be exactly 100% with one finding per seed");
  return { schemaVersion: "1.0", summary: root.summary.trim(), findings };
}

function compileAnnotationFields(value: HarnessDiagnosisAnnotationResult, states: readonly HarnessTaskState[], evidence: readonly EvidenceRecord[], seeds: readonly DiagnosisSeed[]): HarnessDiagnosisResult {
  const annotationMap = new Map(value.annotations.map((annotation) => [annotation.seedId, annotation]));
  const stateById = new Map(states.map((state) => [state.stateId, state]));
  const presentationGroup = (seed: DiagnosisSeed) => { const state = stateById.get(seed.occurrenceStateId); const agentOwned = state?.kind === "logical_task" || state?.kind === "attempt";
    const source = agentOwned && state?.provider && state.model && state.roleId ? state.roleId : state?.stage ?? "harness-diagnosis";
    const safe = source.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 80); return safe || "harness-diagnosis"; };
  return { schemaVersion: "1.0", summary: `Diagnosed ${seeds.length} observable failure seeds.`, findings: seeds.map((seed) => {
    const annotation = annotationMap.get(seed.seedId); if (!annotation) throw new Error("Compact diagnosis annotation references an unknown seed");
    const responsibilityCandidates: ResponsibilityCandidate[] = annotation.responsibilityCandidates.map((candidate) => { const targetStates = candidate.targetStateRefs.map((ref) => states[ref - 1]!);
      const configKind = ({ prompt: "prompt", skill: "skill", schema: "schema", tool: "tool", model: "model" } as const)[candidate.category as "prompt" | "skill" | "schema" | "tool" | "model"];
      const sharedRole = targetStates.length && targetStates.every((state) => state.roleId === targetStates[0]!.roleId) ? targetStates[0]!.roleId : null;
      const targetCardDigest = candidate.category === "agent_card" ? targetStates[0]!.cardDigest : null;
      const targetConfigDigest = configKind ? targetStates[0]!.configDigests[configKind] : null;
      return { category: candidate.category, targetStateIds: targetStates.map((state) => state.stateId), targetRoleId: candidate.category === "unknown" ? null : sharedRole,
      targetCardDigest, targetConfigDigest,
      supportingEvidenceIds: candidate.supportingEvidenceRefs.map((ref) => evidence[ref - 1]!.evidenceId),
      counterEvidenceIds: candidate.counterEvidenceRefs.map((ref) => evidence[ref - 1]!.evidenceId),
      confidence: candidate.evidenceSufficiency === "sufficient" ? 0.8 : candidate.evidenceSufficiency === "partial" ? 0.6 : candidate.category === "unknown" ? 0.2 : 0.4,
      evidenceSufficiency: candidate.evidenceSufficiency, rationale: candidate.rationale }; });
    const primary = responsibilityCandidates[0]!; const ambiguity = primary.evidenceSufficiency === "insufficient"
      ? { status: "insufficient" as const, explanation: "Observable evidence is insufficient for responsibility attribution." }
      : primary.evidenceSufficiency === "partial"
        ? { status: "ambiguous" as const, explanation: "Observable evidence supports more than one responsibility interpretation." }
        : { status: "unambiguous" as const, explanation: "The cited observable evidence sufficiently grounds this responsibility." };
    return { id: `finding-${sha(seed.seedId).slice(0, 20)}`, seedId: annotation.seedId, symptom: annotation.symptom, responsibilityCandidates,
      failureClass: annotation.failureClass, severity: annotation.severity, reproducibility: annotation.reproducibility,
      presentationGroups: [presentationGroup(seed)], ambiguity,
      trigger: { type: seed.type, stateIds: [...seed.stateIds], evidenceIds: [...seed.evidenceIds] },
      occurrenceStateIds: [seed.occurrenceStateId], detectionStateIds: [seed.detectionStateId], propagationPath: [...seed.propagationPath] };
  }) };
}

export function normalizeHarnessDiagnosisAnnotationText(raw: string): { value: unknown; normalization: HarnessDiagnosisNormalization } {
  if (Buffer.byteLength(raw, "utf8") > 34_000) throw new Error("Raw compact diagnosis output exceeds the 34000-byte wrapper limit before JSON parsing");
  if (!raw) throw new Error("Compact diagnosis output is empty");
  const matchesSignature = (value: unknown) => { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const record = value as Record<string, unknown>;
    return exact(record, ["schemaVersion", "annotations"]) && record.schemaVersion === "1.1" && Array.isArray(record.annotations); };
  const parseExtracted = (json: string, normalization: HarnessDiagnosisNormalization) => {
    const extracted = json.trim();
    if (Buffer.byteLength(extracted, "utf8") > 28_000) throw new Error("Extracted compact diagnosis JSON exceeds the 28000-byte limit before JSON parsing");
    const value: unknown = JSON.parse(extracted);
    if (!matchesSignature(value)) throw new Error("Compact diagnosis JSON must have the exact compact top-level signature");
    return { value, normalization };
  };
  if (raw === raw.trim()) {
    if ((raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("[") && raw.endsWith("]"))) {
      if (Buffer.byteLength(raw, "utf8") > 28_000) throw new Error("Extracted compact diagnosis JSON exceeds the 28000-byte limit before JSON parsing");
      let bareValue: unknown; let parsedBare = false;
      try { bareValue = JSON.parse(raw); parsedBare = true; } catch { /* scan wrappers and embedded JSON below */ }
      if (parsedBare) {
        if (!matchesSignature(bareValue)) throw new Error("Compact diagnosis JSON must have the exact compact top-level signature");
        return { value: bareValue, normalization: "none" };
      }
    }
  }
  const markerStart = "<<<HARNESS_DIAGNOSIS_START>>>"; const markerEnd = "<<<HARNESS_DIAGNOSIS_END>>>";
  const markerStarts = raw.split(markerStart).length - 1; const markerEnds = raw.split(markerEnd).length - 1;
  const fences = [...raw.matchAll(/```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```/gi)];
  let body: string | null = null; let outside = ""; let normalization: HarnessDiagnosisNormalization | null = null;
  if (markerStarts === 1 && markerEnds === 1 && fences.length === 0) {
    const from = raw.indexOf(markerStart); const to = raw.indexOf(markerEnd, from + markerStart.length);
    if (to > from) { body = raw.slice(from + markerStart.length, to); outside = `${raw.slice(0, from)}${raw.slice(to + markerEnd.length)}`; normalization = "marker-block"; }
  } else if (markerStarts === 0 && markerEnds === 0 && fences.length === 1) {
    const match = fences[0]!; body = match[1]!; outside = `${raw.slice(0, match.index!)}${raw.slice(match.index! + match[0].length)}`; normalization = "json-fence";
  }
  if (body && normalization) {
    if (outside.includes("```") || outside.includes(markerStart) || outside.includes(markerEnd)) throw new Error("Compact diagnosis wrapper contains another wrapper");
    return parseExtracted(body, normalization);
  }
  if (markerStarts || markerEnds || raw.includes("```")) throw new Error("Compact diagnosis output contains an incomplete or non-unique marker/fence wrapper");
  const parsedCandidates: Array<{ start: number; end: number; value: unknown }> = [];
  let candidateStart: number | null = null; const stack: string[] = []; let inString = false; let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (candidateStart === null) {
      if (character === "{" || character === "[") { candidateStart = index; stack.push(character); inString = false; escaped = false; }
      else if (character === "}" || character === "]") throw new Error("Compact diagnosis prose contains an unmatched top-level JSON closer");
      continue;
    }
    if (inString) { if (escaped) escaped = false; else if (character === "\\") escaped = true; else if (character === "\"") inString = false; continue; }
    if (character === "\"") { inString = true; continue; }
    if (character === "{" || character === "[") { stack.push(character); continue; }
    if (character === "}" || character === "]") {
      const expected = character === "}" ? "{" : "[";
      if (stack.at(-1) !== expected) throw new Error("Compact diagnosis prose contains mismatched JSON brackets");
      stack.pop();
      if (!stack.length) {
        const candidate = raw.slice(candidateStart, index + 1);
        if (Buffer.byteLength(candidate, "utf8") > 28_000) throw new Error("Extracted compact diagnosis JSON exceeds the 28000-byte limit before JSON parsing");
        let value: unknown; try { value = JSON.parse(candidate); } catch { throw new Error("Compact diagnosis prose contains a malformed top-level JSON candidate"); }
        parsedCandidates.push({ start: candidateStart, end: index + 1, value }); candidateStart = null;
      }
    }
  }
  if (candidateStart !== null || stack.length || inString || escaped) throw new Error("Compact diagnosis prose contains an incomplete top-level JSON candidate");
  if (parsedCandidates.length !== 1 || !matchesSignature(parsedCandidates[0]!.value)) throw new Error("Compact diagnosis prose must contain exactly one valid embedded JSON object with the compact top-level signature and no other valid JSON object or array");
  const selected = raw.slice(parsedCandidates[0]!.start, parsedCandidates[0]!.end);
  return parseExtracted(selected, "unique-embedded-json");
}

export function parseHarnessDiagnosisAnnotationText(raw: string): unknown {
  return normalizeHarnessDiagnosisAnnotationText(raw).value;
}

export function validateHarnessDiagnosisAnnotations(value: unknown, states: readonly HarnessTaskState[], evidence: readonly EvidenceRecord[], edges: readonly HarnessTaskEdge[], seeds: readonly DiagnosisSeed[], visibility?: { stateIds: ReadonlySet<string>; evidenceIds: ReadonlySet<string> }, mode: "provider-batch" | "deterministic-merge" = "provider-batch"): HarnessDiagnosisAnnotationResult {
  const structuralBudget = mode === "provider-batch" ? 28_000 : Math.min(512_000, 28_000 * Math.ceil(seeds.length / MAX_DIAGNOSIS_SEEDS_PER_BATCH));
  if (Buffer.byteLength(JSON.stringify(value)) > structuralBudget) throw new Error(`Compact diagnosis annotations exceed the ${structuralBudget}-byte structural budget`);
  const root = object(value, "compact diagnosis");
  if (!exact(root, ["schemaVersion", "annotations"]) || root.schemaVersion !== "1.1" || !Array.isArray(root.annotations)) throw new Error("Compact diagnosis schema is invalid");
  const bounded = (input: unknown, label: string, maximum: number) => { const text = diagnosticText(input, label); if (Buffer.byteLength(text, "utf8") > maximum) throw new Error(`${label} exceeds ${maximum} UTF-8 bytes`); return text; };
  const seedIds = new Set(seeds.map((seed) => seed.seedId)); const seedReferences = new Map<string, number>();
  const seedInputsById = new Map(diagnosisSeedInputs(seeds, states, evidence).map((seed) => [seed.seedId, seed]));
  const visibleStateRefs = new Set(states.flatMap((state, index) => !visibility || visibility.stateIds.has(state.stateId) ? [index + 1] : []));
  const visibleEvidenceRefs = new Set(evidence.flatMap((record, index) => !visibility || visibility.evidenceIds.has(record.evidenceId) ? [index + 1] : []));
  const ordinalRefs = (input: unknown, label: string, available: number, maximum: number, allowed: ReadonlySet<number>, allowEmpty = false) => {
    if (!Array.isArray(input) || (!allowEmpty && input.length < 1) || input.length > maximum || input.some((ref) => !Number.isInteger(ref) || ref < 1 || ref > available)
      || input.some((ref) => !allowed.has(ref)) || new Set(input).size !== input.length) throw new Error(`${label} contains invalid or non-visible compact references`); return input as number[];
  };
  const categories: ResponsibilitySurface[] = ["agent_card", "prompt", "skill", "schema", "tool", "orchestration", "integration", "model", "unknown"];
  const annotations = root.annotations.map((raw, index) => {
    const annotation = object(raw, `annotation ${index}`); const keys = ["seedId", "symptom", "responsibilityCandidates", "failureClass", "severity", "reproducibility"];
    if (!exact(annotation, keys) || typeof annotation.seedId !== "string" || !Array.isArray(annotation.responsibilityCandidates)
      || annotation.responsibilityCandidates.length !== 1) throw new Error("Compact diagnosis annotation schema is invalid");
    if (!seedIds.has(annotation.seedId)) throw new Error("Compact diagnosis annotation references an unknown seed"); seedReferences.set(annotation.seedId, (seedReferences.get(annotation.seedId) ?? 0) + 1);
    bounded(annotation.symptom, "symptom", 600);
    if (!["output_contract", "input_contract", "evaluation", "orchestration", "provider", "data_lineage", "unknown"].includes(String(annotation.failureClass))
      || !["low", "medium", "high", "critical"].includes(String(annotation.severity)) || !["observed", "intermittent", "unknown"].includes(String(annotation.reproducibility))) throw new Error("Compact failure classification is invalid");
    for (const rawCandidate of annotation.responsibilityCandidates) {
      const candidate = object(rawCandidate, "responsibility candidate");
      const candidateKeys = ["category", "targetStateRefs", "supportingEvidenceRefs", "counterEvidenceRefs", "evidenceSufficiency", "rationale"];
      if (!exact(candidate, candidateKeys) || !categories.includes(candidate.category as ResponsibilitySurface)
        || !["sufficient", "partial", "insufficient"].includes(String(candidate.evidenceSufficiency)) || typeof candidate.rationale !== "string"
        || !Array.isArray(candidate.targetStateRefs) || !Array.isArray(candidate.supportingEvidenceRefs) || !Array.isArray(candidate.counterEvidenceRefs)) throw new Error("Compact responsibility candidate exceeds its output budget");
      bounded(candidate.rationale, "responsibility rationale", 900); const targets = ordinalRefs(candidate.targetStateRefs, "target states", states.length, 2, visibleStateRefs); const supports = ordinalRefs(candidate.supportingEvidenceRefs, "supporting evidence", evidence.length, 3, visibleEvidenceRefs); ordinalRefs(candidate.counterEvidenceRefs, "counter evidence", evidence.length, 2, visibleEvidenceRefs, true);
      const configKind = ({ prompt: "prompt", skill: "skill", schema: "schema", tool: "tool", model: "model" } as const)[candidate.category as "prompt" | "skill" | "schema" | "tool" | "model"];
      const targetStates = targets.map((ref) => states[ref - 1]!); const everyTargetGrounded = targetStates.every((state) => supports.some((evidenceRef) => evidence[evidenceRef - 1]!.stateId === state.stateId));
      if (!everyTargetGrounded) throw new Error("Compact responsibility target is not grounded in its exact state");
      if (candidate.category === "agent_card" && (!targetStates[0]!.cardDigest || targetStates.some((state) => state.cardDigest !== targetStates[0]!.cardDigest))
        || configKind && (!targetStates[0]!.configDigests[configKind] || targetStates.some((state) => state.configDigests[configKind] !== targetStates[0]!.configDigests[configKind]))) throw new Error("Compact responsibility identity digest is unavailable or inconsistent");
      if (candidate.category === "unknown") {
        const fallback = seedInputsById.get(String(annotation.seedId));
        if (candidate.evidenceSufficiency !== "insufficient" || !fallback
          || candidate.targetStateRefs.length !== 1 || candidate.targetStateRefs[0] !== fallback.groundingStateRef
          || candidate.supportingEvidenceRefs.length !== 1 || candidate.supportingEvidenceRefs[0] !== fallback.groundingEvidenceRefs[0]
          || candidate.counterEvidenceRefs.length !== 0) throw new Error("Compact unknown responsibility must use the exact deterministic grounding fallback");
      }
    }
    return annotation as unknown as FailureFindingAnnotation;
  });
  if (seeds.some((seed) => seedReferences.get(seed.seedId) !== 1) || [...seedReferences.values()].some((count) => count !== 1)) throw new Error("Compact diagnosis seed coverage must be exactly 100% with one annotation per seed");
  const compact: HarnessDiagnosisAnnotationResult = { schemaVersion: "1.1", annotations };
  validateHarnessDiagnosis(compileAnnotationFields(compact, states, evidence, seeds), states, evidence, edges, seeds);
  return compact;
}

export function compileHarnessDiagnosisAnnotations(value: HarnessDiagnosisAnnotationResult, states: readonly HarnessTaskState[], evidence: readonly EvidenceRecord[], edges: readonly HarnessTaskEdge[], seeds: readonly DiagnosisSeed[]): HarnessDiagnosisResult {
  return validateHarnessDiagnosis(compileAnnotationFields(value, states, evidence, seeds), states, evidence, edges, seeds);
}

function validateDiagnosisInputVisibility(diagnosis: HarnessDiagnosisResult, visibleStateIds: ReadonlySet<string>, visibleEvidenceIds: ReadonlySet<string>, visibleEdgePairs: ReadonlySet<string>, visibleSeedIds: ReadonlySet<string>) {
  for (const finding of diagnosis.findings) {
    if (!visibleSeedIds.has(finding.seedId)) throw new Error("Harness diagnosis cites a seed that was not present in the read-safe diagnosis input");
    const stateRefs = [...finding.trigger.stateIds, ...finding.occurrenceStateIds, ...finding.detectionStateIds, ...finding.propagationPath,
      ...finding.responsibilityCandidates.flatMap((candidate) => candidate.targetStateIds)];
    const evidenceRefs = [...finding.trigger.evidenceIds, ...finding.responsibilityCandidates.flatMap((candidate) => [...candidate.supportingEvidenceIds, ...candidate.counterEvidenceIds])];
    if (stateRefs.some((id) => !visibleStateIds.has(id)) || evidenceRefs.some((id) => !visibleEvidenceIds.has(id))) throw new Error("Harness diagnosis cites an ID that was not present in the read-safe diagnosis input");
    if (finding.propagationPath.slice(1).some((id, index) => !visibleEdgePairs.has(`${finding.propagationPath[index]}\0${id}`))) throw new Error("Harness diagnosis propagation cites an edge that was not present in the read-safe diagnosis input");
  }
}

export async function runHarnessSelfCheck(options: RunHarnessSelfCheckOptions): Promise<HarnessSelfCheckSummary> {
  const executionPath = "pinned-acontext-failure-card-prompt-compatibility" as const; const sourceKind = options.sourceKind; const base = { nativeAcontextApi: false as const, executionPath, failureCardDigest: ACONTEXT_FAILURE_CARD_DIGEST, sourceKind };
  if (!["current-refine-run", "historical-replay"].includes(sourceKind)) throw new Error("Harness self-check sourceKind is invalid");
  if (!Number.isFinite(options.currentF1) || !Number.isFinite(options.candidateF1)) throw new Error("Harness self-check scores must be finite numbers");
  const directory = join(resolve(options.runDirectory), "harness-self-check"); const triggerPath = join(directory, "trigger.json"); const taskStatePath = join(directory, "task-state-projection.json"); const contractValidationPath = join(directory, "contract-validation-log.json"); const diagnosisPath = join(directory, "failure-findings.json"); let traceDigest: string | undefined; let frozen = false; let diagnosisInputPaths: string[] = []; let diagnosisInputBytes = 0; const diagnosisAttempts: DiagnosisBatchAttempt[] = []; const completedDiagnosisBatches: CompletedDiagnosisBatch[] = [];
  try {
    await mkdir(directory, { recursive: true });
    const fullDag = projectRefineRunToTaskStates(options.stages, options.runId);
    const collected = await collectEvidence(fullDag.states, options.stages, options.artifacts, options.manifestPath, options.currentF1, options.candidateF1);
    const fullValidation = await contractLog(fullDag.states, fullDag.edges, options.stages, collected.records, options.currentF1, options.candidateF1);
    const auditEvidence = [...collected.records, ...failedStatusEvidence(fullDag.states), ...validationEvidence(fullValidation, fullDag.states)];
    const diagnosisSeeds = buildDiagnosisSeeds({ dag: fullDag, evidence: auditEvidence, validation: fullValidation,
      currentF1: options.currentF1, candidateF1: options.candidateF1,
      ...(options.eligibleForRegressionCheck === undefined ? {} : { eligibleForRegressionCheck: options.eligibleForRegressionCheck }) });
    if (!diagnosisSeeds.length) return { status: "not-triggered", reason: options.eligibleForRegressionCheck === false ? "no-attributed-findings-or-observed-failures" : "no-diagnosis-seeds", ...base };
    const auditEnvelope = { schemaVersion: "2.0", sourceKind, runId: options.runId, hiddenChainOfThoughtAvailable: false,
      observableEvidencePolicy: { allowed: ["message", "tool", "artifact", "event", "validation", "score", "digest"], eventProjection: "public-message-tool-terminal-allowlist", eventProjectionStats: collected.eventProjectionStats, secretHandling: "best-effort-pattern-redaction", maxContentBytesPerRecord: MAX_EVIDENCE_BYTES, budget: collected.budget },
      projectionBudget: { originalStates: fullDag.states.length, includedStates: fullDag.states.length, droppedStates: 0, originalEdges: fullDag.edges.length, includedEdges: fullDag.edges.length, droppedEdges: 0,
        originalValidationEntries: fullValidation.entries.length, includedValidationEntries: fullValidation.entries.length, droppedValidationEntries: 0 },
      scoreRegression: { currentF1: options.currentF1, candidateF1: options.candidateF1, delta: options.candidateF1 - options.currentF1 }, diagnosisSeeds, taskStateDag: fullDag, evidenceRecords: auditEvidence };
    const validationJson = `${JSON.stringify(fullValidation, null, 2)}\n`; const taskStateJson = `${JSON.stringify(auditEnvelope, null, 2)}\n`;
    traceDigest = sha(JSON.stringify({ envelope: auditEnvelope, validation: fullValidation, diagnosisSeeds }));
    const diagnosisInputs = buildDiagnosisInputShards({ sourceKind, runId: options.runId, traceDigest, seeds: diagnosisSeeds, fullDag, fullEvidence: auditEvidence, fullValidation, collectionBudget: collected.budget });
    diagnosisInputPaths = diagnosisInputs.serialized.map((_, index) => diagnosisInputs.serialized.length === 1 ? join(directory, "diagnosis-input.json") : join(directory, `diagnosis-input-${index + 1}-of-${diagnosisInputs.serialized.length}.json`));
    diagnosisInputBytes = diagnosisInputs.serialized.reduce((sum, value) => sum + Buffer.byteLength(value), 0);
    const trigger = { schemaVersion: "2.0", trigger: "diagnosis-seeds-observed", sourceKind, currentF1: options.currentF1, candidateF1: options.candidateF1, delta: options.candidateF1 - options.currentF1, diagnosisSeeds, refineManifestPath: options.manifestPath, traceDigest,
      diagnosisInputPaths, diagnosisInputBytes, diagnosisInputShardCount: diagnosisInputPaths.length, diagnosisInputMaxFileBytes: MAX_DIAGNOSIS_INPUT_FILE_BYTES };
    await Promise.all([writeFile(triggerPath, `${JSON.stringify(trigger, null, 2)}\n`), writeFile(taskStatePath, taskStateJson), writeFile(contractValidationPath, validationJson),
      ...diagnosisInputPaths.map((path, index) => writeFile(path, diagnosisInputs.serialized[index]!))]); frozen = true;
    const inputSummary = { diagnosisInputPath: diagnosisInputPaths[0]!, diagnosisInputPaths, diagnosisInputBytes, diagnosisInputShardCount: diagnosisInputPaths.length };
    const runner = options.runner ?? runAgentTask;
    const seedBatches = Array.from({ length: Math.ceil(diagnosisSeeds.length / MAX_DIAGNOSIS_SEEDS_PER_BATCH) }, (_, index) => diagnosisSeeds.slice(index * MAX_DIAGNOSIS_SEEDS_PER_BATCH, (index + 1) * MAX_DIAGNOSIS_SEEDS_PER_BATCH));
    const expectedReads = new Set(diagnosisInputPaths.map((path) => resolve(path).toLowerCase()));
    const seedInputById = new Map(diagnosisSeedInputs(diagnosisSeeds, fullDag.states, auditEvidence).map((seed) => [seed.seedId, seed]));
    for (const [batchIndex, batchSeeds] of seedBatches.entries()) {
      const batchId = `batch-${String(batchIndex + 1).padStart(2, "0")}-of-${String(seedBatches.length).padStart(2, "0")}`; const batchSeedIds = batchSeeds.map((seed) => seed.seedId);
      const batchGroundingHints = batchSeedIds.map((seedId) => { const seed = seedInputById.get(seedId)!; return { seedId, groundingStateRef: seed.groundingStateRef, groundingEvidenceRefs: seed.groundingEvidenceRefs }; });
      const batchTemplate = { schemaVersion: "1.1", annotations: batchGroundingHints.map((seed) => ({ seedId: seed.seedId, symptom: "",
        responsibilityCandidates: [{ category: "unknown", targetStateRefs: [seed.groundingStateRef], supportingEvidenceRefs: [...seed.groundingEvidenceRefs], counterEvidenceRefs: [], evidenceSufficiency: "insufficient", rationale: "" }],
        failureClass: "REPLACE_WITH_FAILURE_CLASS", severity: "REPLACE_WITH_SEVERITY", reproducibility: "REPLACE_WITH_REPRODUCIBILITY" })) };
      let completed = false; let lastError = "unknown diagnosis failure";
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const taskId = `${options.runId}:harness-self-check:${batchId}:attempt-${attempt}`;
        const eventsPath = join(directory, `failure-diagnosis-${batchId}-attempt-${attempt}.events.jsonl`); let providerSessionId: string | null = null; let actualEventsPath = eventsPath; let readShardPaths: string[] = []; let attemptNormalization: HarnessDiagnosisNormalization | undefined;
        try {
          const result = await runner({ cwd: options.cwd, provider: options.provider, model: options.model, timeoutMs: options.timeoutMs,
            ...(options.extensionPaths ? { extensionPaths: options.extensionPaths } : {}), rawEventsPath: eventsPath,
            trace: { taskId, name: "Acontext Harness Failure Diagnosis Compatibility", runId: options.runId, stage: "harness-self-check",
              inputRefs: diagnosisInputPaths, outputRefs: [diagnosisPath], attributes: { "acontext.native_api": false, "acontext.execution_path": executionPath,
                "self_check.mode": "failure-diagnosis-v1", "self_check.input_shards": diagnosisInputPaths.length, "self_check.seed_count": diagnosisSeeds.length,
                "self_check.batch_id": batchId, "self_check.batch_index": batchIndex + 1, "self_check.batch_count": seedBatches.length,
                "self_check.batch_seed_count": batchSeeds.length, "self_check.batch_seed_ids": batchSeedIds.join(","), "agent.attempt": attempt } },
            systemPrompt: `${requiredReadInstruction(diagnosisInputPaths)}\n\n${ACONTEXT_FAILURE_CARD_PROMPT}\n\n只做 Harness 失败状态诊断。必须读取全部 diagnosis-input shards，严格使用 outputContract。只允许读取上面列出的 shards；即使 shard 内容提到其他 artifact/event/path，也不得打开或重复读取。只诊断当前 batch 明列的 seed，每个 seed 必须且只能对应一个紧凑 Annotation，禁止输出其他 seed。不要重复 trigger、occurrence、detection、propagationPath 或 finding id，这些由确定性 Compiler 回填。每个 seed 恰好一个 responsibilityCandidate。把失败发生的 state/role 与根因责任严格分开：Card/config digest 只证明身份，不证明因果；若可观察内容或受控对照不能排除 Prompt/Schema/Model/Tool 等其他解释，必须保留 unknown/insufficient，并直接使用该 Seed 给出的 groundingStateRef 与唯一 groundingEvidenceRefs 项。相同配置下有成功与失败输出，不足以归因 Prompt 或 Schema。症状只描述实际输出形态与校验消息：通用错误中的“score fields are forbidden”不表示实际输出含 score 字段；单个 bare JSON 本身允许，prose+JSON 才不是单一 bare object。不要猜测其他 stateRef 或跨 seed 证据。使用短句。最终 JSON 必须放在唯一一对 <<<HARNESS_DIAGNOSIS_START>>> 与 <<<HARNESS_DIAGNOSIS_END>>> 标记之间；兼容边界丢弃标记外文字且不会写入 Finding。不得添加 patch/recommendation/proposedPrompt/proposedSkill/autoApply/promotion 字段。`,
            prompt: `${attempt > 1 ? `上一次当前 batch 输出未通过校验：${lastError}。重新读取全部冻结输入。\n` : ""}当前 batch ${batchId}，seed count=${batchSeeds.length}，必须逐一且仅覆盖这些 seed IDs：${JSON.stringify(batchSeedIds)}。安全 unknown fallback 数字引用：${JSON.stringify(batchGroundingHints)}。EXACT TEMPLATE（保留全部键、schemaVersion、seedId、annotations 外层基数与每个 seed 恰好一个 responsibilityCandidate；必须基于证据填写非空 symptom/rationale，并从 outputContract 枚举判断 failureClass/severity/reproducibility；证据充分时可在 2/3/2 上限内修改责任类别以及 target/support/counter 引用数组；不得原样返回空值或 REPLACE 值，不要添加、删除或重复键）：${JSON.stringify(batchTemplate)}。最终只在唯一标记对内输出该 exact-key JSON。` });
          providerSessionId = result.sessionId ?? null; actualEventsPath = result.rawEventsPath; readShardPaths = result.readPaths;
          if (result.stopReason === "length") throw new Error("Acontext diagnosis was truncated");
          const normalizedReads = result.readPaths.map((path) => resolve(path).toLowerCase()); const actualReads = new Set(normalizedReads);
          if (normalizedReads.length !== actualReads.size || actualReads.size !== expectedReads.size || [...expectedReads].some((path) => !actualReads.has(path))) throw new Error("Acontext diagnosis did not read exactly every read-safe diagnosis input shard once");
          const normalized = normalizeHarnessDiagnosisAnnotationText(result.finalText); attemptNormalization = normalized.normalization;
          const batchAnnotations = validateHarnessDiagnosisAnnotations(normalized.value, fullDag.states, auditEvidence, fullDag.edges, batchSeeds,
            { stateIds: diagnosisInputs.visibleStateIds, evidenceIds: diagnosisInputs.visibleEvidenceIds });
          if (batchAnnotations.annotations.some((annotation) => annotation.responsibilityCandidates.length !== 1)) throw new Error("Each batched diagnosis annotation must contain exactly one responsibility candidate");
          diagnosisAttempts.push({ batchId, seedIds: batchSeedIds, attempt, taskId, eventsPath: actualEventsPath, providerSessionId, readShardPaths, status: "completed", normalization: normalized.normalization });
          completedDiagnosisBatches.push({ batchId, seedIds: batchSeedIds, annotations: batchAnnotations.annotations,
            normalization: normalized.normalization, readShardPaths: result.readPaths, eventsPath: actualEventsPath, providerSessionId });
          completed = true; break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          diagnosisAttempts.push({ batchId, seedIds: batchSeedIds, attempt, taskId, eventsPath: actualEventsPath, providerSessionId, readShardPaths,
            status: "failed", ...(attemptNormalization ? { normalization: attemptNormalization } : {}), error: lastError });
        }
      }
      if (!completed) throw new Error(`Acontext diagnosis ${batchId} failed after 3 attempts: ${lastError}`);
    }
    const mergedValue = { schemaVersion: "1.1", annotations: completedDiagnosisBatches.flatMap((batch) => batch.annotations) } satisfies HarnessDiagnosisAnnotationResult;
    const annotations = validateHarnessDiagnosisAnnotations(mergedValue, fullDag.states, auditEvidence, fullDag.edges, diagnosisSeeds,
      { stateIds: diagnosisInputs.visibleStateIds, evidenceIds: diagnosisInputs.visibleEvidenceIds }, "deterministic-merge");
    const diagnosis = compileHarnessDiagnosisAnnotations(annotations, fullDag.states, auditEvidence, fullDag.edges, diagnosisSeeds);
    validateDiagnosisInputVisibility(diagnosis, diagnosisInputs.visibleStateIds, diagnosisInputs.visibleEvidenceIds, diagnosisInputs.visibleEdgePairs, diagnosisInputs.visibleSeedIds);
    const readShardPaths = [...new Set(completedDiagnosisBatches.flatMap((batch) => batch.readShardPaths))];
    await writeFile(diagnosisPath, `${JSON.stringify({ ...diagnosis, compactAnnotations: annotations, provenance: "acontext-failure-card-compatibility", nativeAcontextApi: false,
      sourceKind, traceDigest, diagnosisSeeds, diagnosisInputPaths, diagnosisInputBytes, diagnosisInputShardCount: diagnosisInputPaths.length, readShardPaths,
      diagnosisBatches: completedDiagnosisBatches.map((batch) => ({ ...batch, annotations: undefined, attempts: diagnosisAttempts.filter((item) => item.batchId === batch.batchId) })), attempts: diagnosisAttempts }, null, 2)}\n`);
    return { status: "triggered", reason: "diagnosis-seeds-observed", ...base, triggerPath, taskStatePath, contractValidationPath, ...inputSummary, diagnosisPath, traceDigest };
  } catch (error) { const message = error instanceof Error ? error.message : String(error); try { await mkdir(directory, { recursive: true }); await writeFile(join(directory, "failed.json"), `${JSON.stringify({ status: "failed", error: message, ...(traceDigest ? { traceDigest } : {}), ...(diagnosisInputPaths.length ? { diagnosisInputPaths, diagnosisInputBytes, diagnosisInputShardCount: diagnosisInputPaths.length } : {}), attempts: diagnosisAttempts,
      completedBatches: completedDiagnosisBatches.map((batch) => ({ ...batch, annotations: undefined })) }, null, 2)}\n`); } catch { /* never replace Refine result */ } return { status: "failed", reason: "diagnosis-seeds-observed-but-diagnosis-failed", ...base, ...(frozen ? { triggerPath, taskStatePath, contractValidationPath, diagnosisInputPath: diagnosisInputPaths[0]!, diagnosisInputPaths, diagnosisInputBytes, diagnosisInputShardCount: diagnosisInputPaths.length } : {}), ...(traceDigest ? { traceDigest } : {}), error: message }; }
}
