import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runHarnessLearningAgent, validateHarnessVariant } from "../src/harness-learning-agent.js";
import { runHarnessLearningExperiment, runHarnessVariantCompiler } from "../src/harness-learning-experiment.js";
import { runRefineDraftAgent } from "../src/refine-workflow-harness.js";
import { refineWorkflowCard } from "../src/refine-workflow-cards.js";
import type { AgentTaskOptions, AgentTaskResult } from "../src/agent-task-runner.js";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costUsd: 0 };

function evolutionPath(targetAgent: string, surface: "agent_card" | "prompt" | "skill" | "schema", proposalId: string) {
  return {
    targetAgent,
    support: "trace_supported",
    observedTraceBehavior: "The role missed the signal.",
    evolutionTarget: { surface },
    validationPlan: { sameTypeUnseen: "Replay unseen content from this task family.", differentTypeNegativeHoldout: "Confirm a different task family stays unchanged." },
    proposalAudit: {
      proposalId,
      observedExecution: "The role missed the signal.",
      counterevidence: "The role corrected a nearby issue only.",
      genuinelyRemainingGap: "The task-conditioned signal remained absent.",
    },
  };
}

function bundle(taskType: "technical_research_report" | "agent_engineering_resume_project_entry", roleId = taskType === "technical_research_report" ? "refine.aspect-extractor" : "refine.review", surface: "agent_card" | "prompt" | "skill" = "prompt") {
  const proposalId = `proposal-${roleId}`;
  return {
    schemaVersion: "2.0",
    profile: {
      profileId: `${taskType}-v1`, version: "v1", taskFamily: taskType,
      taskConditions: ["The Description identifies this document family."],
      negativeControls: ["A different task family must not activate this profile."],
      sourceRun: "validation/run-1", evidenceSummary: "The final public Trace retains a task-conditioned capability gap.",
      roleOverlays: [{
        roleId,
        sourceProposalId: proposalId,
        surface,
        capabilityGap: "The role misses a task-conditioned content-style signal.",
        expectedBehavior: "The role uses the observable task-family signal without sample facts.",
        activationCondition: "The Description identifies this document family.",
        evidenceRefs: [`trace:${roleId}:final`],
        revisionTrajectory: { initialObservation: "The role missed the signal.", selfCorrection: "The role corrected a nearby issue only.", residualFailure: "The task-conditioned signal remained absent." },
        instruction: "Inspect the task-family content-style signal using only observable structural evidence supplied by the current task.",
      }],
    },
    excludedRecommendations: ["Expert roles are outside this experiment"],
    readabilityNotes: ["每条规则仅表达一个动作"],
  };
}

test("technical profile can target the trace-supported Aspect Extractor only", () => {
  const value = validateHarnessVariant(bundle("technical_research_report"), "technical_research_report");
  assert.equal(value.reviewer.enabled, false);
  assert.equal(value.compiler.enabled, false);
  assert.equal(value.profile.roleOverlays[0]?.roleId, "refine.aspect-extractor");
});

test("resume variant changes only the selected reviewer surface", () => {
  const value = validateHarnessVariant(bundle("agent_engineering_resume_project_entry"), "agent_engineering_resume_project_entry");
  assert.equal(value.reviewer.enabled, true);
  assert.match(value.reviewer.stagePrompt, /observable structural evidence/);
  assert.equal(value.compiler.enabled, false);
});

test("profile cannot target a role absent from the selected trace-supported paths", () => {
  assert.throws(
    () => validateHarnessVariant(bundle("agent_engineering_resume_project_entry"), "agent_engineering_resume_project_entry", [{ proposalId: "another", roleId: "refine.review", surface: "prompt", initialObservation: "x", selfCorrection: "y", residualFailure: "z" }]),
    /is not supported/,
  );
});

test("learning agent reads real cards, workflow skill, proposal and boundary then materializes variants", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-learning-"));
  const proposalPath = join(root, "proposal.json");
  const boundaryPath = join(root, "boundary.md");
  await writeFile(proposalPath, `${JSON.stringify({ schemaVersion: "4.0", taskType: "agent_engineering_resume_project_entry", taskProfile: {}, evolutionPaths: [evolutionPath("reviewer", "prompt", "proposal-refine.review"), { targetAgent: "independent_judge", support: "trace_supported", evolutionTarget: { surface: "prompt" } }] })}\n`, "utf8");
  await writeFile(boundaryPath, "resume task\n", "utf8");
  const calls: AgentTaskOptions[] = [];
  const runner = async (options: AgentTaskOptions): Promise<AgentTaskResult> => {
    calls.push(options);
    const value = bundle("agent_engineering_resume_project_entry");
    return { finalText: `<<<HARNESS_PROFILE_START>>>\n${JSON.stringify(value)}\n<<<HARNESS_PROFILE_END>>>`, rawEventsPath: options.rawEventsPath, readPaths: (options.trace?.inputRefs ?? []).map((path) => resolve(path)), toolNames: ["read"], usage };
  };
  const output = await runHarnessLearningAgent({
    cwd: resolve("."), provider: "test", model: "test", timeoutMs: 1000,
    taskType: "agent_engineering_resume_project_entry", proposalPath, taskBoundaryPath: boundaryPath,
    outputDirectory: join(root, "output"), runner,
  });
  assert.equal(calls.length, 1);
  assert.equal(output.baseInputPaths.length, 6);
  assert.match(await readFile(output.agentCardPath, "utf8"), /Task-family Harness Learning Agent/);
  assert.equal(output.promptPaths.length, 1);
  assert.match(await readFile(output.promptPaths[0]!, "utf8"), /HARNESS_PROFILE_START/);
  assert.match(await readFile(output.profilePath, "utf8"), /taskFamily/);
  assert.match(await readFile(output.reviewerCardPath, "utf8"), /taskFamilyOverlay/);
  assert.equal((await readFile(output.compilerSkillPath, "utf8")).trim(), "");
});

test("learning agent does not turn a schema proposal into a Prompt overlay", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-learning-surface-"));
  const proposalPath = join(root, "proposal.json");
  const boundaryPath = join(root, "boundary.md");
  await writeFile(proposalPath, JSON.stringify({ schemaVersion: "4.0", taskType: "technical_research_report", taskProfile: {}, evolutionPaths: [{ targetAgent: "aspect_extractor", support: "trace_supported", evolutionTarget: { surface: "schema" } }] }));
  await writeFile(boundaryPath, "technical research task family\n");
  await assert.rejects(runHarnessLearningAgent({ cwd: resolve("."), provider: "test", model: "test", timeoutMs: 1000, taskType: "technical_research_report", proposalPath, taskBoundaryPath: boundaryPath, outputDirectory: join(root, "output") }), /No trace-supported evolvable role proposal/);
});

test("product Policy Optimizer receives the task-family Profile overlay at runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-compiler-binding-"));
  const descriptionPath = join(root, "description.md");
  const activeSkillPath = join(root, "active-writing-skill.md");
  const reviewPath = join(root, "review.json");
  const outputPath = join(root, "candidate-writing-skill", "SKILL.md");
  await writeFile(descriptionPath, "resume entry\n", "utf8");
  await writeFile(activeSkillPath, "# Writing Skill\n\nBase instruction.\n", "utf8");
  await writeFile(reviewPath, "{}\n", "utf8");
  const calls: AgentTaskOptions[] = [];
  const runner = async (options: AgentTaskOptions): Promise<AgentTaskResult> => {
    calls.push(options);
    return { finalText: "<<<CANDIDATE_SKILL_START>>>\n---\nname: writing-skill\ndescription: Test a complete task-family writing policy.\nversion: v2\n---\n\n# Writing Skill\n\nBase instruction with a direct-input fact boundary and a reusable content-style method.\n<<<CANDIDATE_SKILL_END>>>", rawEventsPath: options.rawEventsPath, readPaths: [...(options.trace?.inputRefs ?? [])], toolNames: ["read"], usage };
  };
  await runHarnessVariantCompiler({
    experiment: { cwd: resolve("."), provider: "test", model: "test", timeoutMs: 1000, outputRoot: root, cases: [], runner },
    runDirectory: root, profile: validateHarnessVariant(bundle("agent_engineering_resume_project_entry", "refine.policy-optimizer", "skill"), "agent_engineering_resume_project_entry").profile,
    descriptionPath, activeSkillPath, reviewPath, outputPath, taskType: "agent_engineering_resume_project_entry",
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.systemPrompt, /observable structural evidence/);
  assert.match(calls[0]!.systemPrompt, /Inspect the task-family content-style signal/);
  assert.match(calls[0]!.systemPrompt, /different task family must not activate/i);
  assert.deepEqual(calls[0]!.trace?.inputRefs, [descriptionPath, activeSkillPath, reviewPath]);
  assert.match(calls[0]!.prompt, /冻结内容合同 Description/);
  assert.match(calls[0]!.prompt, /只应用跨样本 overall\/content-style 方法/);
});

test("frozen Draft Agent can label baseline and candidate proxy samples without changing its Card", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-draft-proxy-"));
  const descriptionPath = join(root, "description.md");
  const activeSkillPath = join(root, "active-writing-skill.md");
  const candidateSkillPath = join(root, "candidate-writing-skill.md");
  await writeFile(descriptionPath, "write one line\n", "utf8");
  await writeFile(activeSkillPath, "active\n", "utf8");
  await writeFile(candidateSkillPath, "candidate\n", "utf8");
  const calls: AgentTaskOptions[] = [];
  const runner = async (options: AgentTaskOptions): Promise<AgentTaskResult> => {
    calls.push(options);
    return { finalText: "<<<DRAFT_START>>>\nproxy draft\n<<<DRAFT_END>>>", rawEventsPath: options.rawEventsPath, readPaths: [...(options.trace?.inputRefs ?? [])], toolNames: ["read"], usage };
  };
  const baseline = await runRefineDraftAgent({ cwd: resolve("."), provider: "test", model: "test", timeoutMs: 1000, runner, descriptionPath, skillPath: activeSkillPath, outputPath: join(root, "baseline-evaluation-draft.md"), runDirectory: root, stage: "current-draft-generation" });
  const candidate = await runRefineDraftAgent({ cwd: resolve("."), provider: "test", model: "test", timeoutMs: 1000, runner, descriptionPath, skillPath: candidateSkillPath, outputPath: join(root, "candidate-evaluation-draft.md"), runDirectory: root, stage: "candidate-draft-generation" });
  assert.deepEqual(calls.map((call) => call.trace?.stage), ["current-draft-generation", "candidate-draft-generation"]);
  assert.equal(baseline.record.card.digest, candidate.record.card.digest);
  assert.deepEqual(calls[0]!.trace?.inputRefs, [resolve(descriptionPath), resolve(activeSkillPath)]);
  assert.deepEqual(calls[1]!.trace?.inputRefs, [resolve(descriptionPath), resolve(candidateSkillPath)]);
});

test("Harness Learning experiment preserves a failed manifest when an intermediate Agent fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-experiment-failure-"));
  const proposalPath = join(root, "proposal.json");
  await writeFile(proposalPath, JSON.stringify({ schemaVersion: "4.0", taskType: "agent_engineering_resume_project_entry", taskProfile: {}, evolutionPaths: [evolutionPath("reviewer", "prompt", "proposal-refine.review")] }));
  const outputRoot = join(root, "output");
  await assert.rejects(runHarnessLearningExperiment({ cwd: resolve("."), provider: "test", model: "test", timeoutMs: 1000, outputRoot,
    cases: [{ id: "case", taskType: "agent_engineering_resume_project_entry", descriptionPath: proposalPath, activeSkillPath: proposalPath, goldPath: proposalPath,
      goldAspectSetPath: proposalPath, oldReviewPath: proposalPath, proposalPath, rerunReviewer: true }],
    runner: async () => { throw new Error("model unavailable"); } }), /model unavailable/);
  const [experimentDirectory] = await readdir(outputRoot);
  const manifest = JSON.parse(await readFile(join(outputRoot, experimentDirectory!, "case", "experiment-manifest.json"), "utf8")) as any;
  assert.equal(manifest.status, "failed");
  assert.equal(manifest.optimizationTarget, "task-family-harness-profile");
  assert.equal(manifest.downstreamArtifact, "profile-harness-candidate-writing-skill");
  assert.match(manifest.error, /model unavailable/);
});
