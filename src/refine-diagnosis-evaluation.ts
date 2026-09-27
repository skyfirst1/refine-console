import { createHash } from "node:crypto";
import type { DiagnosisSeed, HarnessDiagnosisResult } from "./refine-harness-self-check.js";

export interface DiagnosisCapabilityRun {
  runId: string;
  sourceRunId: string;
  traceDigest: string;
  shardSourceFingerprint: string;
  frozenInputDigest: string;
  seeds: DiagnosisSeed[];
  diagnosis: HarnessDiagnosisResult | null;
  allowedStateIds: string[];
  allowedEvidenceIds: string[];
  allowedEdgePairs: string[];
  requiredCausalEvidenceIds: string[];
  includedEvidenceIds: string[];
  requiredContractValidationIds: string[];
  includedContractValidationIds: string[];
  expectedShardPaths: string[];
  readShardPaths: string[];
  stateIdentities: Array<{ stateId: string; roleId: string | null; cardDigest: string | null; configDigests: Record<"prompt" | "skill" | "schema" | "tool" | "model", string | null> }>;
  evidenceOwners: Array<{ evidenceId: string; stateId: string }>;
  attributionOracle: Array<{ seedId: string; acceptedTargets: Array<{ category: string; targetStateId: string; targetRoleId: string | null; targetCardDigest: string | null; targetConfigDigest: string | null }> }>;
}

type FrozenDiagnosisInput = Pick<DiagnosisCapabilityRun, "sourceRunId" | "traceDigest" | "shardSourceFingerprint" | "seeds" | "allowedStateIds" | "allowedEvidenceIds" | "allowedEdgePairs" | "requiredCausalEvidenceIds" | "requiredContractValidationIds" | "stateIdentities" | "evidenceOwners" | "attributionOracle">;
const sorted = (values: readonly string[]) => [...new Set(values)].sort();
export function computeDiagnosisFrozenInputDigest(run: FrozenDiagnosisInput): string {
  const normalized = { sourceRunId: run.sourceRunId, traceDigest: run.traceDigest, shardSourceFingerprint: run.shardSourceFingerprint,
    seeds: [...run.seeds].sort((a, b) => a.seedId.localeCompare(b.seedId)), allowedStateIds: sorted(run.allowedStateIds),
    allowedEvidenceIds: sorted(run.allowedEvidenceIds), allowedEdgePairs: sorted(run.allowedEdgePairs),
    requiredCausalEvidenceIds: sorted(run.requiredCausalEvidenceIds), requiredContractValidationIds: sorted(run.requiredContractValidationIds),
    stateIdentities: [...run.stateIdentities].sort((a, b) => a.stateId.localeCompare(b.stateId)),
    evidenceOwners: [...run.evidenceOwners].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId) || a.stateId.localeCompare(b.stateId)),
    attributionOracle: [...run.attributionOracle].map((entry) => ({ ...entry, acceptedTargets: [...entry.acceptedTargets].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) })).sort((a, b) => a.seedId.localeCompare(b.seedId)) };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export type ApplicabilityMetric = { status: "applicable"; value: number; numerator: number; denominator: number } | { status: "notApplicable"; value: null; numerator: 0; denominator: 0 };

export interface DiagnosisCapabilityMetrics {
  seedCoverage: ApplicabilityMetric;
  referenceValidity: number;
  wrongAttributionRate: ApplicabilityMetric;
  groundedLocalizationOrAbstention: number;
  causalChainEvidenceInclusion: ApplicabilityMetric;
  contractInclusion: ApplicabilityMetric;
  shardReadCompleteness: ApplicabilityMetric;
}

const metric = (numerator: number, denominator: number): ApplicabilityMetric => denominator === 0
  ? { status: "notApplicable", value: null, numerator: 0, denominator: 0 }
  : { status: "applicable", value: numerator / denominator, numerator, denominator };
const membershipRatio = (required: readonly string[], included: readonly string[]): ApplicabilityMetric => {
  const available = new Set(included); return metric(required.filter((id) => available.has(id)).length, required.length);
};

export function evaluateDiagnosisCapabilityRun(run: DiagnosisCapabilityRun): DiagnosisCapabilityMetrics {
  const findings = run.diagnosis?.findings ?? []; const seedIds = new Set(run.seeds.map((seed) => seed.seedId));
  const counts = new Map<string, number>(); for (const finding of findings) counts.set(finding.seedId, (counts.get(finding.seedId) ?? 0) + 1);
  const seedCoverage = metric(run.seeds.filter((seed) => counts.get(seed.seedId) === 1).length, run.seeds.length);
  const states = new Set(run.allowedStateIds); const evidence = new Set(run.allowedEvidenceIds); const edges = new Set(run.allowedEdgePairs);
  let validRefs = 0; let totalRefs = 0;
  for (const finding of findings) {
    totalRefs += 1; if (seedIds.has(finding.seedId)) validRefs += 1;
    const stateRefs = [...finding.trigger.stateIds, ...finding.occurrenceStateIds, ...finding.detectionStateIds, ...finding.propagationPath,
      ...finding.responsibilityCandidates.flatMap((candidate) => candidate.targetStateIds)];
    for (const id of stateRefs) { totalRefs += 1; if (states.has(id)) validRefs += 1; }
    const evidenceRefs = [...finding.trigger.evidenceIds, ...finding.responsibilityCandidates.flatMap((candidate) => [...candidate.supportingEvidenceIds, ...candidate.counterEvidenceIds])];
    for (const id of evidenceRefs) { totalRefs += 1; if (evidence.has(id)) validRefs += 1; }
    for (let index = 1; index < finding.propagationPath.length; index += 1) { totalRefs += 1; if (edges.has(`${finding.propagationPath[index - 1]}\0${finding.propagationPath[index]}`)) validRefs += 1; }
  }
  const identities = new Map(run.stateIdentities.map((state) => [state.stateId, state])); const owners = new Map(run.evidenceOwners.map((item) => [item.evidenceId, item.stateId]));
  const configKind = (category: string) => ({ prompt: "prompt", skill: "skill", schema: "schema", tool: "tool", model: "model" } as const)[category as "prompt" | "skill" | "schema" | "tool" | "model"];
  const groundedOrAbstained = findings.filter((finding) => finding.responsibilityCandidates.every((candidate) => candidate.targetStateIds.length > 0
    && candidate.supportingEvidenceIds.length > 0 && candidate.targetStateIds.every((stateId) => { const state = identities.get(stateId); const kind = configKind(candidate.category); return Boolean(state)
      && candidate.supportingEvidenceIds.some((id) => owners.get(id) === stateId)
      && (candidate.category === "unknown"
        ? candidate.targetRoleId === null && candidate.targetCardDigest === null && candidate.targetConfigDigest === null && candidate.evidenceSufficiency === "insufficient" && candidate.confidence <= 0.5
        : (!kind || candidate.targetConfigDigest !== null) && (candidate.category !== "agent_card" || candidate.targetCardDigest !== null)
          && (candidate.targetRoleId === null || state!.roleId === candidate.targetRoleId) && (candidate.targetCardDigest === null || state!.cardDigest === candidate.targetCardDigest)
          && (!kind || state!.configDigests[kind] === candidate.targetConfigDigest)); }))).length;
  const oracle = new Map(run.attributionOracle.map((entry) => [entry.seedId, entry.acceptedTargets])); let judged = 0; let wrong = 0;
  for (const finding of findings) { const accepted = oracle.get(finding.seedId); if (!accepted) continue; for (const candidate of finding.responsibilityCandidates) { judged += 1;
    const compatible = accepted.filter((target) => target.category === candidate.category && target.targetRoleId === candidate.targetRoleId
      && target.targetCardDigest === candidate.targetCardDigest && target.targetConfigDigest === candidate.targetConfigDigest).map((target) => target.targetStateId);
    const actualTargets = sorted(candidate.targetStateIds); const acceptedTargets = sorted(compatible);
    const matches = actualTargets.length === acceptedTargets.length && actualTargets.every((target, index) => target === acceptedTargets[index]); if (!matches) wrong += 1; } }
  const expected = new Set(run.expectedShardPaths.map((path) => path.toLowerCase())); const read = new Set(run.readShardPaths.map((path) => path.toLowerCase()));
  return { seedCoverage, referenceValidity: totalRefs ? validRefs / totalRefs : 0, wrongAttributionRate: metric(wrong, judged),
    groundedLocalizationOrAbstention: findings.length ? groundedOrAbstained / findings.length : 0,
    causalChainEvidenceInclusion: membershipRatio(run.requiredCausalEvidenceIds, run.includedEvidenceIds),
    contractInclusion: membershipRatio(run.requiredContractValidationIds, run.includedContractValidationIds),
    shardReadCompleteness: metric([...expected].filter((path) => read.has(path)).length, expected.size) };
}

function semanticSignature(run: DiagnosisCapabilityRun): string {
  return JSON.stringify((run.diagnosis?.findings ?? []).map((finding) => ({ seedId: finding.seedId, occurrenceStateIds: finding.occurrenceStateIds,
    detectionStateIds: finding.detectionStateIds, propagationPath: finding.propagationPath, failureClass: finding.failureClass, severity: finding.severity,
    ambiguity: finding.ambiguity, responsibilityCandidates: finding.responsibilityCandidates.map((candidate) => ({ category: candidate.category,
      targetStateIds: candidate.targetStateIds, targetRoleId: candidate.targetRoleId, targetCardDigest: candidate.targetCardDigest,
      targetConfigDigest: candidate.targetConfigDigest, supportingEvidenceIds: candidate.supportingEvidenceIds,
      counterEvidenceIds: candidate.counterEvidenceIds, evidenceSufficiency: candidate.evidenceSufficiency,
      confidenceBucket: Math.floor(candidate.confidence * 10) / 10 })) })).sort((a, b) => a.seedId.localeCompare(b.seedId)));
}

export function compareDiagnosisCapabilityExperiment(options: { frozenTraceDigest: string; baseline: DiagnosisCapabilityRun; candidateRuns: [DiagnosisCapabilityRun, DiagnosisCapabilityRun, DiagnosisCapabilityRun] }) {
  if (!options.frozenTraceDigest.trim()) throw new Error("A frozen trace digest is required");
  const runs = [options.baseline, ...options.candidateRuns]; const sourceRunId = runs[0]!.sourceRunId; const frozenInputDigest = runs[0]!.frozenInputDigest;
  for (const run of runs) {
    if (!run.sourceRunId?.trim() || !run.traceDigest?.trim() || !run.shardSourceFingerprint?.trim() || !run.frozenInputDigest?.trim()) throw new Error("Every experiment run requires frozen trace/run source identity");
    if (run.traceDigest !== options.frozenTraceDigest || run.sourceRunId !== sourceRunId) throw new Error("MIXED_TRACE: baseline and candidate runs must use one frozen trace/run source identity");
    const computed = computeDiagnosisFrozenInputDigest(run); if (run.frozenInputDigest !== computed || run.frozenInputDigest !== frozenInputDigest) throw new Error("MIXED_TRACE: seeds, allowed references, required evidence/contracts, oracle, or shard source differ from the frozen input");
  }
  const signatures = options.candidateRuns.map(semanticSignature); const frequencies = new Map<string, number>(); for (const signature of signatures) frequencies.set(signature, (frequencies.get(signature) ?? 0) + 1);
  return { schemaVersion: "1.0", claimScope: "diagnosis-capability-and-self-evolution-readiness" as const, frozenTraceDigest: options.frozenTraceDigest,
    baseline: evaluateDiagnosisCapabilityRun(options.baseline), candidateRuns: options.candidateRuns.map(evaluateDiagnosisCapabilityRun),
    threeRunStability: Math.max(...frequencies.values()) / 3,
    guardrail: "This experiment does not claim that Harness quality improved." };
}
