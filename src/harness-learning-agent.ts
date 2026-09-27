import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { jsonrepair } from "jsonrepair";
import {
  renderRefineHarnessScope,
  resolveRefineHarnessProfile,
  validateRefineHarnessProfile,
  type EvolvableRefineRoleId,
  type RefineHarnessChangeSurface,
  type RefineHarnessProfile,
  type RefineHarnessRoleOverlay,
} from "./refine-harness-profile.js";
import { refineWorkflowCard, type PinnedRefineWorkflowCard } from "./refine-workflow-cards.js";
import { bundledProviderExtensionPath, requiredReadInstruction, runAgentTask, type AgentTaskResult } from "./agent-task-runner.js";

export type HarnessLearningTaskType = string;
export type EvolvedRoleId = EvolvableRefineRoleId;
const MAX_CONTRACT_ATTEMPTS = 3;

/** Compatibility view for the existing stage-replay experiment. The learned artifact is profile. */
export interface HarnessRoleVariant {
  roleId: EvolvedRoleId;
  enabled: boolean;
  systemPrompt: string;
  stagePrompt: string;
  operatingSkill: string;
  changes: Array<{ surface: "systemPrompt" | "stagePrompt" | "operatingSkill"; action: "add"; before: ""; after: string; reason: string }>;
  removedOrRewrittenContradictions: string[];
}

export interface HarnessVariantBundle {
  schemaVersion: "2.0";
  taskType: string;
  profile: RefineHarnessProfile;
  reviewer: HarnessRoleVariant;
  compiler: HarnessRoleVariant;
  excludedRecommendations: string[];
  readabilityNotes: string[];
}

export interface SelectedEvolutionTarget {
  proposalId: string;
  roleId: EvolvableRefineRoleId;
  surface: RefineHarnessChangeSurface;
  initialObservation: string;
  selfCorrection: string;
  residualFailure: string;
}

export interface HarnessLearningRunOptions {
  cwd: string;
  provider: string;
  model: string;
  timeoutMs: number;
  taskType: HarnessLearningTaskType;
  proposalPath: string;
  taskBoundaryPath: string;
  outputDirectory: string;
  runner?: typeof runAgentTask;
}

export interface HarnessLearningRunResult {
  bundle: HarnessVariantBundle;
  profile: RefineHarnessProfile;
  profilePath: string;
  bundlePath: string;
  reviewerCardPath: string;
  reviewerSkillPath: string;
  reviewerStagePromptPath: string;
  compilerCardPath: string;
  compilerSkillPath: string;
  compilerStagePromptPath: string;
  changeLogPath: string;
  agentCardPath: string;
  promptPaths: string[];
  eventsPath: string;
  attemptEventsPaths: string[];
  baseInputPaths: string[];
  result: AgentTaskResult;
}

export const HARNESS_LEARNING_AGENT_CARD = Object.freeze({
  schemaVersion: "2.0",
  roleId: "harness.learning",
  version: "v3",
  name: "Task-family Harness Learning Agent",
  description: "把真实 Refine Trace 中多轮修订后仍残留的角色能力缺口编译为单角色、单修改面的任务族 Harness Profile。",
  runtime: "pi-no-session",
  tools: ["read"] as const,
  systemPrompt: "你是 Harness Learning Agent。你优化的是特定文档任务族下 Refine 子 Agent 产生和评估 Writing Skill 的行为。只从 Trace 支持的 evolutionPaths 中选择一个多轮修订后仍残留的能力缺口，并在 proposal 指定的唯一 surface 编译最小 Profile overlay；基础 Card 与真实多轮协议保持不变。Draft、Expert 分数和 Gold 样本答案不是编辑目标。",
  inputContract: ["actualRuntimeCards", "actualWorkflowSource", "actualExpertSource", "actualWorkflowSkill", "selectedEvolutionProposal", "taskBoundary"] as const,
  outputContract: ["taskFamilyHarnessProfile", "excludedRecommendations", "readabilityNotes", "eventsPath"] as const,
});

const TARGET_TO_ROLE: Readonly<Record<string, EvolvableRefineRoleId>> = Object.freeze({
  reviewer: "refine.review",
  aspect_extractor: "refine.aspect-extractor",
  directional_matcher: "refine.aspect-matcher",
  evidence_aligner: "refine.evidence-aligner",
  policy_optimizer: "refine.policy-optimizer",
});

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be a string array`);
  return value.map((item) => item.trim()).filter(Boolean);
}

function extractJson(text: string): unknown {
  const end = text.lastIndexOf("<<<HARNESS_PROFILE_END>>>");
  const start = text.lastIndexOf("<<<HARNESS_PROFILE_START>>>", end);
  const body = start >= 0 && end > start ? text.slice(start + "<<<HARNESS_PROFILE_START>>>".length, end).trim() : text.trim();
  try { return JSON.parse(body); } catch { return JSON.parse(jsonrepair(body)); }
}

function overlayVariant(roleId: "refine.review" | "refine.policy-optimizer", profile: RefineHarnessProfile): HarnessRoleVariant {
  const card = refineWorkflowCard(roleId);
  const overlay = profile.roleOverlays.find((item) => item.roleId === roleId);
  const changes: HarnessRoleVariant["changes"] = [];
  const resolved = resolveRefineHarnessProfile(profile, profile.taskFamily);
  const scope = overlay && resolved ? renderRefineHarnessScope(resolved, overlay) : "";
  const mappedSurface = overlay?.surface === "agent_card" ? "systemPrompt" : overlay?.surface === "prompt" ? "stagePrompt" : "operatingSkill";
  if (overlay) changes.push({ surface: mappedSurface, action: "add", before: "", after: overlay.instruction, reason: overlay.capabilityGap });
  const scopedInstruction = overlay ? `${scope}\n执行指令：${overlay.instruction}` : "";
  const systemAddition = overlay?.surface === "agent_card" ? scopedInstruction : "";
  return {
    roleId,
    enabled: Boolean(overlay),
    systemPrompt: systemAddition ? `${card.systemPrompt}\n\n任务族 Harness Profile：\n${systemAddition}` : card.systemPrompt,
    stagePrompt: overlay?.surface === "prompt" ? scopedInstruction : "",
    operatingSkill: overlay?.surface === "skill" ? scopedInstruction : "",
    changes,
    removedOrRewrittenContradictions: [],
  };
}

export function validateHarnessVariant(value: unknown, taskType: HarnessLearningTaskType, proposalTargets?: readonly SelectedEvolutionTarget[]): HarnessVariantBundle {
  const root = object(value, "Harness profile envelope");
  const expected = ["schemaVersion", "profile", "excludedRecommendations", "readabilityNotes"].sort();
  if (Object.keys(root).sort().join("|") !== expected.join("|") || root.schemaVersion !== "2.0") throw new Error("Harness profile envelope is invalid");
  const profile = validateRefineHarnessProfile(root.profile);
  if (profile.taskFamily !== taskType) throw new Error("Harness profile task family does not match the requested task type");
  if (proposalTargets) {
    const overlay = profile.roleOverlays[0]!;
    const matching = proposalTargets.find((target) => target.proposalId === overlay.sourceProposalId && target.roleId === overlay.roleId && target.surface === overlay.surface);
    if (!matching) throw new Error(`Harness profile target ${overlay.sourceProposalId}/${overlay.roleId}/${overlay.surface} is not supported by the selected evolution paths`);
  }
  return {
    schemaVersion: "2.0", taskType, profile,
    reviewer: overlayVariant("refine.review", profile),
    compiler: overlayVariant("refine.policy-optimizer", profile),
    excludedRecommendations: stringArray(root.excludedRecommendations, "excludedRecommendations"),
    readabilityNotes: stringArray(root.readabilityNotes, "readabilityNotes"),
  };
}

async function writeSelectedProposal(sourcePath: string, taskType: HarnessLearningTaskType, outputPath: string): Promise<SelectedEvolutionTarget[]> {
  const source = JSON.parse(await readFile(sourcePath, "utf8")) as { schemaVersion?: unknown; taskType?: unknown; taskProfile?: unknown; evolutionPaths?: Array<{ targetAgent?: unknown; support?: unknown; observedTraceBehavior?: unknown; evolutionTarget?: { surface?: unknown }; validationPlan?: { sameTypeUnseen?: unknown; differentTypeNegativeHoldout?: unknown }; proposalAudit?: { proposalId?: unknown; observedExecution?: unknown; counterevidence?: unknown; genuinelyRemainingGap?: unknown } }> };
  if (String(source.taskType) !== taskType) throw new Error("Behavior Audit task type does not match the requested task family");
  const overlaySurfaces = new Set(["prompt", "skill", "agent_card"]);
  const selected = (source.evolutionPaths ?? []).filter((item) => item.support === "trace_supported" && TARGET_TO_ROLE[String(item.targetAgent)] && overlaySurfaces.has(String(item.evolutionTarget?.surface))
    && typeof item.proposalAudit?.proposalId === "string" && Boolean(item.proposalAudit.proposalId.trim())
    && typeof item.proposalAudit?.observedExecution === "string" && Boolean(item.proposalAudit.observedExecution.trim())
    && typeof item.proposalAudit?.counterevidence === "string" && Boolean(item.proposalAudit.counterevidence.trim())
    && typeof item.proposalAudit?.genuinelyRemainingGap === "string" && Boolean(item.proposalAudit.genuinelyRemainingGap.trim())
    && typeof item.validationPlan?.sameTypeUnseen === "string" && Boolean(item.validationPlan.sameTypeUnseen.trim())
    && typeof item.validationPlan?.differentTypeNegativeHoldout === "string" && Boolean(item.validationPlan.differentTypeNegativeHoldout.trim()));
  const excluded = (source.evolutionPaths ?? []).filter((item) => !selected.includes(item)).map((item) => ({
    targetAgent: item.targetAgent,
    reason: item.support !== "trace_supported"
      ? "not-trace-supported"
      : !TARGET_TO_ROLE[String(item.targetAgent)]
        ? "role-not-supported-by-demo"
        : !overlaySurfaces.has(String(item.evolutionTarget?.surface))
          ? "surface-not-representable-by-profile-overlay"
          : "missing-residual-trajectory-or-holdout-evidence",
  }));
  if (selected.length === 0) throw new Error("No trace-supported evolvable role proposal is available for this task family");
  await writeFile(outputPath, `${JSON.stringify({ sourcePath: resolve(sourcePath), sourceSchemaVersion: source.schemaVersion, taskType: source.taskType, taskProfile: source.taskProfile, selectedEvolutionPaths: selected, excludedEvolutionPaths: excluded }, null, 2)}\n`, "utf8");
  return selected.map((item) => ({
    proposalId: String(item.proposalAudit!.proposalId),
    roleId: TARGET_TO_ROLE[String(item.targetAgent)]!,
    surface: String(item.evolutionTarget!.surface) as RefineHarnessChangeSurface,
    initialObservation: String(item.proposalAudit!.observedExecution || item.observedTraceBehavior),
    selfCorrection: String(item.proposalAudit!.counterevidence),
    residualFailure: String(item.proposalAudit!.genuinelyRemainingGap),
  }));
}

function materializedCard(base: PinnedRefineWorkflowCard, overlay: RefineHarnessRoleOverlay | undefined): Record<string, unknown> {
  return { ...base, taskFamilyOverlay: overlay ?? null, note: "Audit copy only. Runtime starts from the current base Card and applies the append-only Profile through the shared resolver." };
}

export async function runHarnessLearningAgent(options: HarnessLearningRunOptions): Promise<HarnessLearningRunResult> {
  const outputDirectory = resolve(options.outputDirectory);
  const inputsDirectory = join(outputDirectory, "learning-inputs");
  await mkdir(inputsDirectory, { recursive: true });
  const selectedProposal = join(inputsDirectory, "selected-evolution-proposals.json");
  const proposalTargets = await writeSelectedProposal(resolve(options.proposalPath), options.taskType, selectedProposal);
  const targetedRoles = [...new Set(proposalTargets.map((target) => target.roleId))];
  const cardsPath = join(inputsDirectory, "actual-runtime-cards.json");
  await writeFile(cardsPath, `${JSON.stringify(targetedRoles.map((roleId) => refineWorkflowCard(roleId)), null, 2)}\n`, "utf8");
  const baseSkillPath = resolve(options.cwd, ".pi", "skills", "refine-workflow", "SKILL.md");
  const workflowSourcePath = resolve(options.cwd, "src", "refine-workflow-harness.ts");
  const expertSourcePath = resolve(options.cwd, "src", "refine-expert-pipeline.ts");
  const inputPaths = [cardsPath, workflowSourcePath, expertSourcePath, baseSkillPath, selectedProposal, resolve(options.taskBoundaryPath)];
  const example = {
    schemaVersion: "2.0",
    profile: {
      profileId: "TASK_FAMILY-SHORT_NAME", version: "v1", taskFamily: options.taskType,
      taskConditions: ["OBSERVABLE DESCRIPTION CONDITION"], negativeControls: ["DIFFERENT TASK CONDITION WHERE THIS MUST NOT APPLY"],
      sourceRun: "SOURCE RUN FROM SELECTED PROPOSAL", evidenceSummary: "WHY THE FINAL TRACE STILL SHOWS THIS CAPABILITY GAP",
      roleOverlays: [{ roleId: proposalTargets[0]!.roleId, sourceProposalId: proposalTargets[0]!.proposalId, surface: proposalTargets[0]!.surface, capabilityGap: "TRACE-SUPPORTED RESIDUAL GAP", expectedBehavior: "OBSERVABLE CHANGED BEHAVIOR", activationCondition: "CURRENT DESCRIPTION MATCHES THE TASK CONDITION", evidenceRefs: ["TRACE OR PROPOSAL REF"], revisionTrajectory: { initialObservation: proposalTargets[0]!.initialObservation, selfCorrection: proposalTargets[0]!.selfCorrection, residualFailure: proposalTargets[0]!.residualFailure }, instruction: "ONE MINIMAL EXECUTABLE INSTRUCTION" }],
    },
    excludedRecommendations: ["UNSUPPORTED OR NON-MINIMAL RECOMMENDATION"], readabilityNotes: ["WHY THE OVERLAY REMAINS UNDERSTANDABLE WITH THE BASE CARD"],
  };
  const prompt = [
    `Compile a task-family Harness Profile for ${options.taskType}. Proposal-supported roles: ${targetedRoles.join(", ")}.`,
    "Read every file. TypeScript sources and Card snapshots are runtime truth; the Workflow Skill is coordinator context, not a replacement Prompt.",
    "Select only roles whose final trace-supported path identifies a capability gap that remains after the role's later revision rounds. A first-round observation removed later proves self-correction and needs no overlay.",
    "Write append-only instructions. Never copy or replace a complete base Prompt. Preserve Reviewer discovery→adversarial revision→structured submission and existing Agent topology.",
    "Prefer Prompt/operating-skill changes that use the current Schema. Exclude a Schema change when existing fields can express the behavior. Do not modify Reducer, scoring, Draft, Judge, tools, runtime, retries, persistence, cache, lineage or validation infrastructure.",
    "The Demo output must select exactly one strongest surviving proposal, one role and the proposal's exact single surface. Do not combine coupled roles or edit another surface.",
    "Preserve sourceProposalId and faithfully summarize the selected proposal's initialObservation/selfCorrection/residualFailure trajectory. A first-round issue that the same Agent later removed is not a residual failure and must not be selected.",
    "The overlay must state its activation condition, capability gap, observable behavior and Trace evidence. Remove sample entities, formats, numbers, chapter names, Gold sentences and score-targeting language. It must apply to unseen content of the same family and stay inactive for the negative control.",
    `Return exactly this shape: ${JSON.stringify(example)}`,
    "Keep the single instruction short and executable; never add a role for completeness.",
    "Output one JSON object inside exactly one marker pair and no prose outside it.",
    "<<<HARNESS_PROFILE_START>>>", "{}", "<<<HARNESS_PROFILE_END>>>",
  ].join("\n");
  const runner = options.runner ?? runAgentTask;
  const agentCardPath = join(outputDirectory, "harness-learning-agent-card.json");
  await writeFile(agentCardPath, `${JSON.stringify(HARNESS_LEARNING_AGENT_CARD, null, 2)}\n`, "utf8");
  const attemptEventsPaths: string[] = [];
  const promptPaths: string[] = [];
  let result: AgentTaskResult | undefined;
  let bundle: HarnessVariantBundle | undefined;
  let lastError = "unknown";
  for (let attempt = 1; attempt <= MAX_CONTRACT_ATTEMPTS; attempt += 1) {
    const suffix = attempt === 1 ? "" : `-attempt-${attempt}`;
    const eventsPath = join(outputDirectory, `harness-learning-agent${suffix}.events.jsonl`);
    const promptPath = join(outputDirectory, `harness-learning-agent${suffix}.prompt.md`);
    const invocationPrompt = `${attempt > 1 ? `Previous output failed validation: ${lastError}. Correct the Profile contract without changing the learning hypothesis.\n` : ""}${prompt}`;
    attemptEventsPaths.push(eventsPath);
    promptPaths.push(promptPath);
    await writeFile(promptPath, `${invocationPrompt}\n`, "utf8");
    try {
      result = await runner({
        cwd: resolve(options.cwd), provider: options.provider, model: options.model, timeoutMs: options.timeoutMs,
        extensionPaths: options.provider === "deepseek" ? [bundledProviderExtensionPath()] : [], rawEventsPath: eventsPath, thinking: "off",
        systemPrompt: `${requiredReadInstruction(inputPaths)}\n\n${HARNESS_LEARNING_AGENT_CARD.systemPrompt}`,
        prompt: invocationPrompt,
        trace: { taskId: `harness-learning:${options.taskType}:${attempt}:${randomUUID()}`, name: HARNESS_LEARNING_AGENT_CARD.name, runId: options.taskType, stage: "harness-learning", inputRefs: inputPaths, outputRefs: [join(outputDirectory, "profile.json")] },
      });
      const expected = new Set(inputPaths.map((path) => resolve(path).toLowerCase()));
      const observed = new Set(result.readPaths.map((path) => resolve(path).toLowerCase()));
      if ([...expected].some((path) => !observed.has(path))) throw new Error("Harness Learning Agent did not read every runtime/proposal/boundary input");
      bundle = validateHarnessVariant(extractJson(result.finalText), options.taskType, proposalTargets);
      break;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
  }
  if (!result || !bundle) throw new Error(`Harness Learning Agent failed after ${MAX_CONTRACT_ATTEMPTS} attempts: ${lastError}`);

  const profilePath = join(outputDirectory, "profile.json");
  const bundlePath = join(outputDirectory, "variant.json");
  const reviewerCardPath = join(outputDirectory, "reviewer-card.variant.json");
  const reviewerSkillPath = join(outputDirectory, "reviewer-skill.variant.md");
  const reviewerStagePromptPath = join(outputDirectory, "reviewer-stage-prompt.variant.md");
  const compilerCardPath = join(outputDirectory, "compiler-card.variant.json");
  const compilerSkillPath = join(outputDirectory, "compiler-skill.variant.md");
  const compilerStagePromptPath = join(outputDirectory, "compiler-stage-prompt.variant.md");
  const changeLogPath = join(outputDirectory, "changes.json");
  const reviewerOverlay = bundle.profile.roleOverlays.find((item) => item.roleId === "refine.review");
  const optimizerOverlay = bundle.profile.roleOverlays.find((item) => item.roleId === "refine.policy-optimizer");
  await Promise.all([
    writeFile(profilePath, `${JSON.stringify(bundle.profile, null, 2)}\n`, "utf8"),
    writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8"),
    writeFile(reviewerCardPath, `${JSON.stringify(materializedCard(refineWorkflowCard("refine.review"), reviewerOverlay), null, 2)}\n`, "utf8"),
    writeFile(reviewerSkillPath, `${reviewerOverlay?.surface === "skill" ? reviewerOverlay.instruction : ""}\n`, "utf8"),
    writeFile(reviewerStagePromptPath, `${reviewerOverlay?.surface === "prompt" ? reviewerOverlay.instruction : ""}\n`, "utf8"),
    writeFile(compilerCardPath, `${JSON.stringify(materializedCard(refineWorkflowCard("refine.policy-optimizer"), optimizerOverlay), null, 2)}\n`, "utf8"),
    writeFile(compilerSkillPath, `${optimizerOverlay?.surface === "skill" ? optimizerOverlay.instruction : ""}\n`, "utf8"),
    writeFile(compilerStagePromptPath, `${optimizerOverlay?.surface === "prompt" ? optimizerOverlay.instruction : ""}\n`, "utf8"),
    writeFile(changeLogPath, `${JSON.stringify({ profileId: bundle.profile.profileId, taskFamily: bundle.profile.taskFamily, roleOverlays: bundle.profile.roleOverlays, excludedRecommendations: bundle.excludedRecommendations, readabilityNotes: bundle.readabilityNotes }, null, 2)}\n`, "utf8"),
  ]);
  return { bundle, profile: bundle.profile, profilePath, bundlePath, reviewerCardPath, reviewerSkillPath, reviewerStagePromptPath, compilerCardPath, compilerSkillPath, compilerStagePromptPath, changeLogPath, agentCardPath, promptPaths, eventsPath: result.rawEventsPath, attemptEventsPaths, baseInputPaths: inputPaths, result };
}

export const HARNESS_LEARNING_BASE_STAGE_PROMPTS = Object.freeze({ source: "actual runtime TypeScript sources supplied to the learning agent; no parallel stage-prompt copy" });
