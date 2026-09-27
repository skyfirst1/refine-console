export const EVOLVABLE_REFINE_ROLE_IDS = [
  "refine.review",
  "refine.aspect-extractor",
  "refine.aspect-matcher",
  "refine.evidence-aligner",
  "refine.policy-optimizer",
] as const;

export type EvolvableRefineRoleId = typeof EVOLVABLE_REFINE_ROLE_IDS[number];
export type RefineHarnessChangeSurface = "agent_card" | "prompt" | "skill";

export interface RefineHarnessRevisionTrajectory {
  initialObservation: string;
  selfCorrection: string;
  residualFailure: string;
}

export interface RefineHarnessRoleOverlay {
  roleId: EvolvableRefineRoleId;
  sourceProposalId: string;
  surface: RefineHarnessChangeSurface;
  capabilityGap: string;
  expectedBehavior: string;
  activationCondition: string;
  evidenceRefs: string[];
  revisionTrajectory: RefineHarnessRevisionTrajectory;
  instruction: string;
}

export interface RefineHarnessProfile {
  profileId: string;
  version: string;
  taskFamily: string;
  taskConditions: string[];
  negativeControls: string[];
  sourceRun: string;
  evidenceSummary: string;
  roleOverlays: RefineHarnessRoleOverlay[];
}

export interface ResolvedRefineHarnessProfile {
  profileId: string;
  version: string;
  taskFamily: string;
  taskConditions: string[];
  negativeControls: string[];
  roles: RefineHarnessRoleOverlay[];
}

const PROFILE_KEYS = [
  "profileId",
  "version",
  "taskFamily",
  "taskConditions",
  "negativeControls",
  "sourceRun",
  "evidenceSummary",
  "roleOverlays",
] as const;

const OVERLAY_KEYS = [
  "roleId",
  "sourceProposalId",
  "surface",
  "capabilityGap",
  "expectedBehavior",
  "activationCondition",
  "evidenceRefs",
  "revisionTrajectory",
  "instruction",
] as const;

const TRAJECTORY_KEYS = ["initialObservation", "selfCorrection", "residualFailure"] as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains unsupported fields`);
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function stringArray(value: unknown, label: string, allowEmpty = true): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  if (!allowEmpty && value.length === 0) throw new Error(`${label} must not be empty`);
  return value.map((item) => item.trim());
}

function validateRoleOverlay(value: unknown, index: number): RefineHarnessRoleOverlay {
  const label = `roleOverlays[${index}]`;
  const item = record(value, label);
  requireExactKeys(item, OVERLAY_KEYS, label);
  const roleId = nonEmptyString(item.roleId, `${label}.roleId`);
  if (!(EVOLVABLE_REFINE_ROLE_IDS as readonly string[]).includes(roleId)) {
    throw new Error(`${label}.roleId is not evolvable`);
  }
  const surface = nonEmptyString(item.surface, `${label}.surface`);
  if (!["agent_card", "prompt", "skill"].includes(surface)) throw new Error(`${label}.surface is not supported`);
  const trajectory = record(item.revisionTrajectory, `${label}.revisionTrajectory`);
  requireExactKeys(trajectory, TRAJECTORY_KEYS, `${label}.revisionTrajectory`);
  return {
    roleId: roleId as EvolvableRefineRoleId,
    sourceProposalId: nonEmptyString(item.sourceProposalId, `${label}.sourceProposalId`),
    surface: surface as RefineHarnessChangeSurface,
    capabilityGap: nonEmptyString(item.capabilityGap, `${label}.capabilityGap`),
    expectedBehavior: nonEmptyString(item.expectedBehavior, `${label}.expectedBehavior`),
    activationCondition: nonEmptyString(item.activationCondition, `${label}.activationCondition`),
    evidenceRefs: stringArray(item.evidenceRefs, `${label}.evidenceRefs`, false),
    revisionTrajectory: {
      initialObservation: nonEmptyString(trajectory.initialObservation, `${label}.revisionTrajectory.initialObservation`),
      selfCorrection: nonEmptyString(trajectory.selfCorrection, `${label}.revisionTrajectory.selfCorrection`),
      residualFailure: nonEmptyString(trajectory.residualFailure, `${label}.revisionTrajectory.residualFailure`),
    },
    instruction: nonEmptyString(item.instruction, `${label}.instruction`),
  };
}

export function validateRefineHarnessProfile(value: unknown): RefineHarnessProfile {
  const root = record(value, "Refine Harness Profile");
  requireExactKeys(root, PROFILE_KEYS, "Refine Harness Profile");
  if (!Array.isArray(root.roleOverlays) || root.roleOverlays.length !== 1) {
    throw new Error("Demo Refine Harness Profile must isolate exactly one role and one change surface");
  }
  const roleOverlays = root.roleOverlays.map(validateRoleOverlay);
  return {
    profileId: nonEmptyString(root.profileId, "Refine Harness Profile.profileId"),
    version: nonEmptyString(root.version, "Refine Harness Profile.version"),
    taskFamily: nonEmptyString(root.taskFamily, "Refine Harness Profile.taskFamily"),
    taskConditions: stringArray(root.taskConditions, "Refine Harness Profile.taskConditions", false),
    negativeControls: stringArray(root.negativeControls, "Refine Harness Profile.negativeControls", false),
    sourceRun: nonEmptyString(root.sourceRun, "Refine Harness Profile.sourceRun"),
    evidenceSummary: nonEmptyString(root.evidenceSummary, "Refine Harness Profile.evidenceSummary"),
    roleOverlays,
  };
}

export function resolveRefineHarnessProfile(profile: RefineHarnessProfile, runtimeTaskType: string): ResolvedRefineHarnessProfile | null {
  if (runtimeTaskType !== profile.taskFamily) return null;
  return {
    profileId: profile.profileId,
    version: profile.version,
    taskFamily: profile.taskFamily,
    taskConditions: [...profile.taskConditions],
    negativeControls: [...profile.negativeControls],
    roles: profile.roleOverlays.map((overlay) => ({
      ...overlay,
      evidenceRefs: [...overlay.evidenceRefs],
      revisionTrajectory: { ...overlay.revisionTrajectory },
    })),
  };
}

export function renderRefineHarnessScope(profile: ResolvedRefineHarnessProfile, overlay: RefineHarnessRoleOverlay): string {
  return [
    `任务族：${profile.taskFamily}`,
    "仅当当前 Description 满足至少一个任务条件且不符合任何反向条件时应用下述指令；否则忽略该 Profile。",
    `任务条件：${profile.taskConditions.join("；")}`,
    `反向条件：${profile.negativeControls.join("；")}`,
    `当前 Overlay 激活条件：${overlay.activationCondition}`,
  ].join("\n");
}
