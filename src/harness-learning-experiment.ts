import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { runHarnessLearningAgent, type HarnessLearningTaskType, type HarnessRoleVariant } from "./harness-learning-agent.js";
import type { RefineHarnessProfile } from "./refine-harness-profile.js";
import { refineWorkflowCard } from "./refine-workflow-cards.js";
import { runRefineDraftAgent, runRefinePolicyOptimizerAgent, runRefineReviewerAgent, type RefineReviewArtifact } from "./refine-workflow-harness.js";
import { runRefineExpertEvaluation } from "./refine-expert-pipeline.js";
import { bundledProviderExtensionPath, requiredReadInstruction, runAgentTask, type AgentTaskResult } from "./agent-task-runner.js";

export interface HarnessExperimentCase {
  id: string;
  taskType: HarnessLearningTaskType;
  descriptionPath: string;
  activeSkillPath: string;
  goldPath: string;
  goldAspectSetPath: string;
  oldReviewPath: string;
  proposalPath: string;
  taskBoundaryPath?: string;
  rerunReviewer: boolean;
}

export interface HarnessLearningExperimentOptions {
  cwd: string;
  provider: string;
  model: string;
  timeoutMs: number;
  outputRoot: string;
  cases: HarnessExperimentCase[];
  runner?: typeof runAgentTask;
}

const extensionPaths = (provider: string): string[] => provider === "deepseek" ? [bundledProviderExtensionPath()] : [];
const MAX_CONTRACT_ATTEMPTS = 5;

function extractMarked(text: string, start: string, end: string): string {
  const to = text.lastIndexOf(end);
  const from = text.lastIndexOf(start, to);
  if (from < 0 || to <= from) throw new Error(`Missing ${start}/${end} markers`);
  return text.slice(from + start.length, to).trim();
}

function extractJsonPayload(text: string, start: string, end: string): string {
  try {
    return extractMarked(text, start, end);
  } catch {
    const fenced = [...text.matchAll(/```json\s*([\s\S]*?)\s*```/gi)];
    if (fenced.length === 1 && fenced[0]?.[1]) return fenced[0][1].trim();
    const from = text.indexOf("{");
    const to = text.lastIndexOf("}");
    if (from >= 0 && to > from) return text.slice(from, to + 1);
    throw new Error(`Missing ${start}/${end} markers and no single JSON object found`);
  }
}

async function invokeVariant(options: {
  cwd: string;
  provider: string;
  model: string;
  timeoutMs: number;
  runner: typeof runAgentTask;
  runDirectory: string;
  stage: string;
  role: Pick<HarnessRoleVariant, "systemPrompt" | "stagePrompt" | "operatingSkill"> & { roleId: string };
  inputPaths: string[];
  outputPath: string;
  startMarker: string;
  endMarker: string;
  prompt: string;
  transform?: (raw: string) => string;
  allowBareJson?: boolean;
}): Promise<{ eventsPath: string; result: AgentTaskResult }> {
  let lastError = "unknown";
  for (let attempt = 1; attempt <= MAX_CONTRACT_ATTEMPTS; attempt += 1) {
    const suffix = attempt === 1 ? "" : `-attempt-${attempt}`;
    const eventsPath = join(options.runDirectory, `${options.stage}${suffix}.events.jsonl`);
    try {
      const result = await options.runner({
        cwd: options.cwd, provider: options.provider, model: options.model, timeoutMs: options.timeoutMs,
        extensionPaths: extensionPaths(options.provider), rawEventsPath: eventsPath,
        systemPrompt: `${requiredReadInstruction(options.inputPaths)}\n\n${options.role.systemPrompt}\n\n${options.role.operatingSkill}`,
        prompt: `${attempt > 1 ? `Previous output failed validation: ${lastError}. Re-read the same inputs and correct only the contract.\n` : ""}${options.role.stagePrompt}\n\n${options.prompt}`,
        trace: { taskId: `${options.stage}:${attempt}:${randomUUID()}`, name: options.role.roleId, runId: basename(options.runDirectory), stage: options.stage, inputRefs: options.inputPaths, outputRefs: [options.outputPath] },
      });
      if (result.stopReason === "length") throw new Error("output truncated");
      const expected = new Set(options.inputPaths.map((path) => resolve(path).toLowerCase()));
      const observed = new Set(result.readPaths.map((path) => resolve(path).toLowerCase()));
      if ([...expected].some((path) => !observed.has(path))) throw new Error("not all required inputs were read");
      const raw = options.allowBareJson
        ? extractJsonPayload(result.finalText, options.startMarker, options.endMarker)
        : extractMarked(result.finalText, options.startMarker, options.endMarker);
      const transformed = options.transform ? options.transform(raw) : raw;
      await mkdir(dirname(options.outputPath), { recursive: true });
      await writeFile(options.outputPath, `${transformed}\n`, "utf8");
      return { eventsPath, result };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`${options.stage} failed after ${MAX_CONTRACT_ATTEMPTS} attempts: ${lastError}`);
}

async function runReviewer(options: {
  experiment: HarnessLearningExperimentOptions;
  runDirectory: string;
  profile?: RefineHarnessProfile;
  taskType: HarnessLearningTaskType;
  descriptionPath: string;
  baselineEvaluationDraftPath: string;
  goldPath: string;
  activeSkillPath: string;
  baselineProxyExpertPath: string;
  outputPath: string;
}): Promise<{ eventsPath: string; review: RefineReviewArtifact }> {
  const reviewed = await runRefineReviewerAgent({
    cwd: options.experiment.cwd, provider: options.experiment.provider, model: options.experiment.model, timeoutMs: options.experiment.timeoutMs,
    ...(options.experiment.runner ? { runner: options.experiment.runner } : {}), runDirectory: options.runDirectory,
    taskType: options.taskType,
    ...(options.profile ? { harnessProfile: options.profile } : {}), descriptionPath: options.descriptionPath, draftPath: options.baselineEvaluationDraftPath,
    goldPath: options.goldPath, activeSkillPath: options.activeSkillPath, draftExpertReportPath: options.baselineProxyExpertPath, outputPath: options.outputPath,
  });
  return { eventsPath: reviewed.record.eventsPath ?? "", review: JSON.parse(await readFile(options.outputPath, "utf8")) as RefineReviewArtifact };
}

export async function runHarnessVariantCompiler(options: {
  experiment: HarnessLearningExperimentOptions;
  runDirectory: string;
  profile?: RefineHarnessProfile;
  descriptionPath: string;
  activeSkillPath: string;
  reviewPath: string;
  outputPath: string;
  taskType: HarnessLearningTaskType;
}): Promise<{ eventsPath: string }> {
  const compiled = await runRefinePolicyOptimizerAgent({
    cwd: options.experiment.cwd, provider: options.experiment.provider, model: options.experiment.model, timeoutMs: options.experiment.timeoutMs,
    ...(options.experiment.runner ? { runner: options.experiment.runner } : {}), runDirectory: options.runDirectory,
    taskType: options.taskType, ...(options.profile ? { harnessProfile: options.profile } : {}), descriptionPath: options.descriptionPath,
    activeSkillPath: options.activeSkillPath, reviewPath: options.reviewPath, outputPath: options.outputPath,
  });
  return { eventsPath: compiled.record.eventsPath ?? "" };
}

export async function runHarnessExperimentJudge(options: {
  experiment: HarnessLearningExperimentOptions;
  runDirectory: string;
  descriptionPath: string;
  goldPath: string;
  baselineEvaluationDraftPath: string;
  candidateEvaluationDraftPath: string;
  outputPath: string;
}): Promise<{ eventsPath: string; verdict: Record<string, unknown> }> {
  const card = refineWorkflowCard("refine.independent-judge");
  const role = { roleId: "refine.independent-judge", systemPrompt: card.systemPrompt, stagePrompt: "Independently compare the Baseline and Candidate Evaluation Drafts against Description and Gold.", operatingSkill: "Do not inspect any Skill or evolution proposal. This document comparison is proxy evidence only." };
  const inputPaths = [options.descriptionPath, options.goldPath, options.baselineEvaluationDraftPath, options.candidateEvaluationDraftPath];
  const invoked = await invokeVariant({
    cwd: options.experiment.cwd, provider: options.experiment.provider, model: options.experiment.model, timeoutMs: options.experiment.timeoutMs,
    runner: options.experiment.runner ?? runAgentTask, runDirectory: options.runDirectory, stage: "independent-judge", role,
    inputPaths, outputPath: options.outputPath, startMarker: "<<<JUDGE_START>>>", endMarker: "<<<JUDGE_END>>>",
    allowBareJson: true,
    prompt: `Read Description ${options.descriptionPath}, Gold ${options.goldPath}, Baseline Evaluation Draft ${options.baselineEvaluationDraftPath}, Candidate Evaluation Draft ${options.candidateEvaluationDraftPath}. These drafts are proxy samples for comparing the Active and Candidate Writing Skills, not the optimization target. Return JSON only: {"verdict":"improved|regressed|indistinguishable","baselineScore":0,"candidateScore":0,"baselineHardPass":false,"candidateHardPass":false,"reason":"..."}.\n<<<JUDGE_START>>>\n{}\n<<<JUDGE_END>>>`,
    transform: (raw) => {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (!["improved", "regressed", "indistinguishable"].includes(String(value.verdict)) || typeof value.baselineScore !== "number" || typeof value.candidateScore !== "number" || typeof value.baselineHardPass !== "boolean" || typeof value.candidateHardPass !== "boolean" || typeof value.reason !== "string") throw new Error("Judge contract invalid");
      return JSON.stringify(value, null, 2);
    },
  });
  return { eventsPath: invoked.eventsPath, verdict: JSON.parse(await readFile(options.outputPath, "utf8")) as Record<string, unknown> };
}

export async function runHarnessLearningExperiment(options: HarnessLearningExperimentOptions): Promise<{ reportPath: string; caseManifests: string[] }> {
  const outputRoot = resolve(options.outputRoot);
  await mkdir(outputRoot, { recursive: true });
  const experimentRunDirectory = join(outputRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
  await mkdir(experimentRunDirectory, { recursive: false });
  const caseManifests: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  for (const definition of options.cases) {
    const runDirectory = join(experimentRunDirectory, definition.id);
    await mkdir(runDirectory, { recursive: true });
    const manifestPath = join(runDirectory, "experiment-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: "3.0", experiment: "task-family-harness-profile-ab-and-writing-skill-proxy", status: "running", caseId: definition.id, taskType: definition.taskType, optimizationTarget: "task-family-harness-profile", downstreamArtifact: "profile-harness-candidate-writing-skill", startedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
    caseManifests.push(manifestPath);
    try {
    const boundaryPath = definition.taskBoundaryPath ? resolve(definition.taskBoundaryPath) : join(runDirectory, "task-boundary.md");
    if (!definition.taskBoundaryPath) await writeFile(boundaryPath, `Task family: ${definition.taskType}. Apply only trace-supported role capability changes and state an explicit different-family negative control.\n`, "utf8");
    const learning = await runHarnessLearningAgent({
      cwd: options.cwd, provider: options.provider, model: options.model, timeoutMs: options.timeoutMs,
      taskType: definition.taskType, proposalPath: definition.proposalPath, taskBoundaryPath: boundaryPath,
      outputDirectory: join(runDirectory, "learned-harness"), ...(options.runner ? { runner: options.runner } : {}),
    });

    const descriptionPath = resolve(definition.descriptionPath);
    const activeSkillPath = resolve(definition.activeSkillPath);
    const goldPath = resolve(definition.goldPath);
    const baseHarnessDirectory = join(runDirectory, "base-harness");
    const profileHarnessDirectory = join(runDirectory, "profile-harness");
    const baseProxyDirectory = join(runDirectory, "base-writing-skill-proxy");
    const profileProxyDirectory = join(runDirectory, "profile-writing-skill-proxy");
    await Promise.all([baseHarnessDirectory, profileHarnessDirectory, baseProxyDirectory, profileProxyDirectory].map((path) => mkdir(path, { recursive: true })));
    const baseGoldAspectSetPath = join(runDirectory, "base-harness-gold-aspects.frozen.json");
    await copyFile(resolve(definition.goldAspectSetPath), baseGoldAspectSetPath);
    const baselineEvaluationDraftPath = join(runDirectory, "active-writing-skill-draft.md");
    const baselineDraft = await runRefineDraftAgent({
      cwd: options.cwd, provider: options.provider, model: options.model, timeoutMs: options.timeoutMs,
      extensionPaths: extensionPaths(options.provider), runner: options.runner ?? runAgentTask,
      descriptionPath, skillPath: activeSkillPath, outputPath: baselineEvaluationDraftPath, runDirectory, stage: "current-draft-generation",
    });

    // Harness A/B: hold Description, Draft, Gold and Active Skill fixed; vary only the learned Profile.
    const baseHarnessExpertPath = join(runDirectory, "base-harness-expert.json");
    const baseHarnessExpert = await runRefineExpertEvaluation({
      cwd: options.cwd, provider: options.provider, model: options.model, timeoutMs: options.timeoutMs,
      extensionPaths: extensionPaths(options.provider), runner: options.runner ?? runAgentTask,
      taskType: definition.taskType, runId: definition.id, runDirectory: baseHarnessDirectory, parentTaskId: `${definition.id}:base-harness-expert`, evaluationId: "current",
      descriptionPath, goldPath, documentPath: baselineEvaluationDraftPath, goldAspectSetPath: baseGoldAspectSetPath, outputPath: baseHarnessExpertPath,
    });
    const targetRole = learning.profile.roleOverlays[0]!.roleId;
    const expertOverlayActive = ["refine.aspect-extractor", "refine.aspect-matcher", "refine.evidence-aligner"].includes(targetRole);
    const profileGoldAspectSetPath = expertOverlayActive ? join(runDirectory, "profile-harness-gold-aspects.frozen.json") : baseGoldAspectSetPath;
    const profileHarnessExpertPath = join(runDirectory, "profile-harness-expert.json");
    const profileHarnessExpert = expertOverlayActive
      ? await runRefineExpertEvaluation({
        cwd: options.cwd, provider: options.provider, model: options.model, timeoutMs: options.timeoutMs,
        extensionPaths: extensionPaths(options.provider), runner: options.runner ?? runAgentTask,
        taskType: definition.taskType, harnessProfile: learning.profile,
        runId: definition.id, runDirectory: profileHarnessDirectory, parentTaskId: `${definition.id}:profile-harness-expert`, evaluationId: "current",
        descriptionPath, goldPath, documentPath: baselineEvaluationDraftPath, goldAspectSetPath: profileGoldAspectSetPath, outputPath: profileHarnessExpertPath,
      })
      : (await copyFile(baseHarnessExpertPath, profileHarnessExpertPath), baseHarnessExpert);
    if (profileHarnessExpert.goldExtracted !== expertOverlayActive) throw new Error("Profile Harness Gold AspectSet extraction did not match the selected Expert surface");

    const baseReviewPath = join(runDirectory, "base-harness-review.json");
    const profileReviewPath = join(runDirectory, "profile-harness-review.json");
    let baseReviewerEventsPath: string | null = null;
    let profileReviewerEventsPath: string | null = null;
    const reviewerMustDiffer = targetRole === "refine.review" || expertOverlayActive;
    if (reviewerMustDiffer && !definition.rerunReviewer) throw new Error("Reviewer replay is required when the selected Profile changes Reviewer or an upstream Expert role");
    if (definition.rerunReviewer && reviewerMustDiffer) {
      const baseReviewed = await runReviewer({ experiment: options, runDirectory: baseHarnessDirectory, taskType: definition.taskType, descriptionPath, baselineEvaluationDraftPath, goldPath, activeSkillPath, baselineProxyExpertPath: baseHarnessExpertPath, outputPath: baseReviewPath });
      baseReviewerEventsPath = baseReviewed.eventsPath;
      const profileReviewed = await runReviewer({ experiment: options, runDirectory: profileHarnessDirectory, profile: learning.profile, taskType: definition.taskType, descriptionPath, baselineEvaluationDraftPath, goldPath, activeSkillPath, baselineProxyExpertPath: profileHarnessExpertPath, outputPath: profileReviewPath });
      profileReviewerEventsPath = profileReviewed.eventsPath;
    } else if (definition.rerunReviewer) {
      const baseReviewed = await runReviewer({ experiment: options, runDirectory: baseHarnessDirectory, taskType: definition.taskType, descriptionPath, baselineEvaluationDraftPath, goldPath, activeSkillPath, baselineProxyExpertPath: baseHarnessExpertPath, outputPath: baseReviewPath });
      baseReviewerEventsPath = baseReviewed.eventsPath;
      await copyFile(baseReviewPath, profileReviewPath);
    } else {
      await copyFile(definition.oldReviewPath, baseReviewPath);
      await copyFile(definition.oldReviewPath, profileReviewPath);
    }

    const baseCandidateWritingSkillPath = join(runDirectory, "base-harness-candidate-writing-skill", "SKILL.md");
    const baseCompiled = await runHarnessVariantCompiler({ experiment: options, runDirectory: baseHarnessDirectory, descriptionPath, activeSkillPath, reviewPath: baseReviewPath, outputPath: baseCandidateWritingSkillPath, taskType: definition.taskType });
    const profileCandidateWritingSkillPath = join(runDirectory, "profile-harness-candidate-writing-skill", "SKILL.md");
    const profileCompiled = await runHarnessVariantCompiler({ experiment: options, runDirectory: profileHarnessDirectory, profile: learning.profile, descriptionPath, activeSkillPath, reviewPath: profileReviewPath, outputPath: profileCandidateWritingSkillPath, taskType: definition.taskType });

    // Downstream proxy: hold the Draft Agent and evaluation Harness fixed; vary only the Writing Skill emitted by A/B.
    const baseCandidateDraftPath = join(runDirectory, "base-harness-candidate-draft.md");
    const baseCandidateDraft = await runRefineDraftAgent({
      cwd: options.cwd, provider: options.provider, model: options.model, timeoutMs: options.timeoutMs,
      extensionPaths: extensionPaths(options.provider), runner: options.runner ?? runAgentTask,
      descriptionPath, skillPath: baseCandidateWritingSkillPath, outputPath: baseCandidateDraftPath, runDirectory: baseProxyDirectory, stage: "candidate-draft-generation",
    });
    const profileCandidateDraftPath = join(runDirectory, "profile-harness-candidate-draft.md");
    const profileCandidateDraft = await runRefineDraftAgent({
      cwd: options.cwd, provider: options.provider, model: options.model, timeoutMs: options.timeoutMs,
      extensionPaths: extensionPaths(options.provider), runner: options.runner ?? runAgentTask,
      descriptionPath, skillPath: profileCandidateWritingSkillPath, outputPath: profileCandidateDraftPath, runDirectory: profileProxyDirectory, stage: "candidate-draft-generation",
    });
    const draftCardsMatch = baselineDraft.record.card.digest === baseCandidateDraft.record.card.digest && baseCandidateDraft.record.card.digest === profileCandidateDraft.record.card.digest;
    if (!draftCardsMatch) throw new Error("Downstream proxy drafts were not generated by the same frozen Draft Agent Card");

    const baseWritingProxyExpertPath = join(runDirectory, "base-writing-skill-proxy-expert.json");
    const baseWritingProxyExpert = await runRefineExpertEvaluation({
      cwd: options.cwd, provider: options.provider, model: options.model, timeoutMs: options.timeoutMs,
      extensionPaths: extensionPaths(options.provider), runner: options.runner ?? runAgentTask,
      taskType: definition.taskType, runId: definition.id, runDirectory: baseProxyDirectory, parentTaskId: `${definition.id}:base-writing-proxy`, evaluationId: "candidate",
      descriptionPath, goldPath, documentPath: baseCandidateDraftPath, goldAspectSetPath: baseGoldAspectSetPath,
      expectedGoldAspectSetSha256: baseHarnessExpert.goldAspectSetSha256, outputPath: baseWritingProxyExpertPath,
    });
    const profileWritingProxyExpertPath = join(runDirectory, "profile-writing-skill-proxy-expert.json");
    const profileWritingProxyExpert = await runRefineExpertEvaluation({
      cwd: options.cwd, provider: options.provider, model: options.model, timeoutMs: options.timeoutMs,
      extensionPaths: extensionPaths(options.provider), runner: options.runner ?? runAgentTask,
      taskType: definition.taskType, runId: definition.id, runDirectory: profileProxyDirectory, parentTaskId: `${definition.id}:profile-writing-proxy`, evaluationId: "candidate",
      descriptionPath, goldPath, documentPath: profileCandidateDraftPath, goldAspectSetPath: baseGoldAspectSetPath,
      expectedGoldAspectSetSha256: baseHarnessExpert.goldAspectSetSha256, outputPath: profileWritingProxyExpertPath,
    });
    const judgePath = join(runDirectory, "downstream-writing-skill-judge.json");
    const judge = await runHarnessExperimentJudge({ experiment: options, runDirectory, descriptionPath, goldPath, baselineEvaluationDraftPath: baseCandidateDraftPath, candidateEvaluationDraftPath: profileCandidateDraftPath, outputPath: judgePath });
    const activeWritingSkillText = await readFile(activeSkillPath, "utf8");
    const baseCandidateWritingSkillText = await readFile(baseCandidateWritingSkillPath, "utf8");
    const profileCandidateWritingSkillText = await readFile(profileCandidateWritingSkillPath, "utf8");
    const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
    const harnessBehaviorComparison = {
      controlledInputs: { descriptionPath, draftPath: baselineEvaluationDraftPath, goldPath, activeSkillPath },
      selectedTarget: learning.profile.roleOverlays[0],
      baseHarness: { expertPath: baseHarnessExpertPath, expertF1: baseHarnessExpert.report.f1, reviewPath: baseReviewPath, reviewerEventsPath: baseReviewerEventsPath, candidateWritingSkillPath: baseCandidateWritingSkillPath, compilerEventsPath: baseCompiled.eventsPath },
      profileHarness: { expertPath: profileHarnessExpertPath, expertF1: profileHarnessExpert.report.f1, expertRecomputed: expertOverlayActive, reviewPath: profileReviewPath, reviewerEventsPath: profileReviewerEventsPath, reviewerRecomputed: reviewerMustDiffer, candidateWritingSkillPath: profileCandidateWritingSkillPath, compilerEventsPath: profileCompiled.eventsPath },
    };
    const downstreamProxyEvaluation = {
      purpose: "Compare Writing Skills produced by base/profile Harnesses while freezing the Draft Agent and using the base evaluation Harness for both outputs.",
      expert: {
        baseHarnessWritingSkillDraft: { f1: baseWritingProxyExpert.report.f1, hardPass: baseWritingProxyExpert.report.hardPass },
        profileHarnessWritingSkillDraft: { f1: profileWritingProxyExpert.report.f1, hardPass: profileWritingProxyExpert.report.hardPass, deltaFromBaseHarness: profileWritingProxyExpert.report.f1 - baseWritingProxyExpert.report.f1 },
      },
      independentJudge: judge.verdict,
    };
    const manifest = {
      schemaVersion: "3.0", experiment: "task-family-harness-profile-ab-and-writing-skill-proxy", caseId: definition.id, taskType: definition.taskType,
      provider: options.provider, model: options.model, maxOutputTokens: Number.parseInt(process.env.PIPELINE_MAX_TOKENS?.trim() || "8000", 10), credentialSource: "process-environment",
      optimizationTarget: "task-family-harness-profile", downstreamArtifact: "profile-harness-candidate-writing-skill",
      harnessEvolution: { agentCardPath: learning.agentCardPath, promptPaths: learning.promptPaths, inputPaths: learning.baseInputPaths, bundlePath: learning.bundlePath, profilePath: learning.profilePath, changeLogPath: learning.changeLogPath, eventsPath: learning.eventsPath, attemptEventsPaths: learning.attemptEventsPaths },
      harnessBehaviorComparison,
      downstreamWritingSkills: {
        base: { path: baseCandidateWritingSkillPath, sha256: sha256(baseCandidateWritingSkillText), characterCount: [...baseCandidateWritingSkillText].length },
        profile: { path: profileCandidateWritingSkillPath, sha256: sha256(profileCandidateWritingSkillText), characterCount: [...profileCandidateWritingSkillText].length },
        active: { path: activeSkillPath, sha256: sha256(activeWritingSkillText) },
      },
      downstreamProxyEvaluation,
      artifacts: { descriptionPath, goldPath, activeSkillPath, baseGoldAspectSetPath, profileGoldAspectSetPath, baselineEvaluationDraftPath, baseCandidateDraftPath, profileCandidateDraftPath, baseWritingProxyExpertPath, profileWritingProxyExpertPath, judgePath, judgeEventsPath: judge.eventsPath },
      guarantees: { oneRoleOneSurface: learning.profile.roleOverlays.length === 1, harnessABUsesSameInputs: true, sameFrozenDraftAgentCard: draftCardsMatch, downstreamProxyUsesBaseExpertHarnessForBothDrafts: true, deterministicExpertReducerModified: false, proxyEvaluationFedBackIntoHarnessLearning: false },
    };
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, status: "completed" }, null, 2)}\n`, "utf8");
    rows.push({ caseId: definition.id, taskType: definition.taskType, profileCandidateWritingSkillPath, harnessBehaviorComparison, downstreamProxyEvaluation });
    } catch (error) {
      await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: "3.0", experiment: "task-family-harness-profile-ab-and-writing-skill-proxy", status: "failed", caseId: definition.id, taskType: definition.taskType, optimizationTarget: "task-family-harness-profile", downstreamArtifact: "profile-harness-candidate-writing-skill", failedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`, "utf8");
      throw error;
    }
  }
  const reportPath = join(experimentRunDirectory, "experiment-summary.json");
  await writeFile(reportPath, `${JSON.stringify({ schemaVersion: "3.0", experiment: "task-family-harness-profile-ab-and-writing-skill-proxy", optimizationTarget: "task-family-harness-profile", downstreamArtifact: "profile-harness-candidate-writing-skill", rows, limitations: ["Harness A/B is role-stage evidence on identical inputs; downstream drafts separately proxy the quality of the emitted Writing Skills.", "The replay shares product role runners and Profile resolution but does not invoke the complete Workflow coordinator.", "One run per task family does not establish generalization; same-type unseen and different-type negative-control cases remain required.", "The experiment does not promote either Candidate Writing Skill or alter the deterministic Expert Reducer."] }, null, 2)}\n`, "utf8");
  return { reportPath, caseManifests };
}
