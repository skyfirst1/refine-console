import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { runHarnessLearningExperiment, type HarnessExperimentCase } from "../src/harness-learning-experiment.js";
import type { HarnessLearningTaskType } from "../src/harness-learning-agent.js";

const values = (name: string): string[] => process.argv.flatMap((value, index, all) => value === name && all[index + 1] ? [all[index + 1]!] : []);
const required = (name: string): string => {
  const value = values(name)[0]?.trim();
  if (!value) throw new Error(`${name} is required; historical runs and proposals are never selected implicitly`);
  return value;
};

const cwd = resolve(process.cwd());
const workflowManifestPath = resolve(required("--workflow-manifest"));
const proposalPath = resolve(required("--proposal"));
const taskType = required("--task-type") as HarnessLearningTaskType;
const taskBoundaryPath = resolve(required("--task-boundary"));
const workflow = JSON.parse(await readFile(workflowManifestPath, "utf8")) as any;
if (workflow.executionMode !== "workflow" || !["promoted", "rejected"].includes(String(workflow.status))) {
  throw new Error("--workflow-manifest must identify a completed current Workflow v2 run");
}
if (!workflow.artifacts?.descriptionPath || !workflow.inputs?.goldPath || !workflow.inputs?.activeSkillPath || !workflow.artifacts?.goldAspectSetPath || !workflow.artifacts?.reviewPath) {
  throw new Error("Workflow manifest does not expose the required Description/Gold/Active Skill/Gold AspectSet/Review artifacts");
}

const definition: HarnessExperimentCase = {
  id: values("--case-id")[0]?.trim() || basename(dirname(workflowManifestPath)),
  taskType,
  descriptionPath: resolve(workflow.artifacts.descriptionPath),
  activeSkillPath: resolve(workflow.inputs.activeSkillPath),
  goldPath: resolve(workflow.inputs.goldPath),
  goldAspectSetPath: resolve(workflow.artifacts.goldAspectSetPath),
  oldReviewPath: resolve(workflow.artifacts.reviewPath),
  proposalPath,
  taskBoundaryPath,
  rerunReviewer: true,
};

const result = await runHarnessLearningExperiment({
  cwd,
  provider: values("--provider")[0]?.trim() || process.env.PIPELINE_PROVIDER_ID?.trim() || "deepseek",
  model: values("--model")[0]?.trim() || process.env.PIPELINE_MODEL_ID?.trim() || "deepseek-v4-flash",
  timeoutMs: Number.parseInt(values("--timeout-ms")[0]?.trim() || process.env.HARNESS_EXPERIMENT_TIMEOUT_MS?.trim() || "900000", 10),
  outputRoot: resolve(values("--output")[0]?.trim() || process.env.HARNESS_EXPERIMENT_OUTPUT?.trim() || ".refine-console/harness-learning-experiments"),
  cases: [definition],
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
