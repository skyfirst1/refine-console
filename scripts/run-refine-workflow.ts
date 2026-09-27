import { resolve } from "node:path";
import { access, readFile } from "node:fs/promises";
import { bundledProviderExtensionPath } from "../src/agent-task-runner.js";
import { runFixedRefineWorkflow } from "../src/refine-workflow-agent.js";
import { validateRefineHarnessProfile } from "../src/refine-harness-profile.js";

function values(name: string): string[] {
  return process.argv.flatMap((value, index, all) => value === name && all[index + 1] ? [all[index + 1]!] : []);
}

function required(name: string): string {
  const value = values(name)[0]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const cwd = resolve(values("--cwd")[0]?.trim() || process.cwd());
const provider = values("--provider")[0]?.trim() || "deepseek";
const timeoutMs = Number.parseInt(values("--timeout-ms")[0]?.trim() || "900000", 10);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be a positive integer");

const requirementsPath = resolve(required("--requirements"));
const rulesPath = resolve(required("--rules"));
const goldPath = resolve(required("--gold"));
const activeSkillPath = resolve(required("--active-skill"));
const runRoot = resolve(required("--run-root"));
const resumeRunDirectory = values("--resume-run")[0]?.trim();
const harnessProfilePath = values("--harness-profile")[0]?.trim();
const frozenDescriptionPath = values("--frozen-description")[0]?.trim();
await Promise.all([requirementsPath, rulesPath, goldPath, activeSkillPath].map((path) => access(path)));
if (resumeRunDirectory) await access(resolve(resumeRunDirectory));
if (harnessProfilePath) await access(resolve(harnessProfilePath));
if (frozenDescriptionPath) await access(resolve(frozenDescriptionPath));
const harnessProfile = harnessProfilePath
  ? validateRefineHarnessProfile(JSON.parse(await readFile(resolve(harnessProfilePath), "utf8")))
  : undefined;

const result = await runFixedRefineWorkflow({
  cwd,
  provider,
  model: required("--model"),
  timeoutMs,
  requirementsPath,
  rulesPath,
  goldPath,
  activeSkillPath,
  runRoot,
  taskType: values("--task-type")[0]?.trim() || "document_refine",
  executionMode: "workflow",
  ...(resumeRunDirectory ? { resumeRunDirectory: resolve(resumeRunDirectory) } : {}),
  ...(harnessProfile ? { harnessProfile } : {}),
  ...(frozenDescriptionPath ? { frozenDescriptionPath: resolve(frozenDescriptionPath) } : {}),
  extensionPaths: provider === "deepseek" ? [bundledProviderExtensionPath()] : [],
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
