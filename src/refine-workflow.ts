import { basename, join, normalize, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { PhoenixAgentTaskContext } from "./phoenix-tracing.js";
import {
  requiredReadInstruction,
  type AgentTaskOptions,
  type AgentTaskResult,
} from "./agent-task-runner.js";
import { PRODUCTION_RULES } from "./production-rules.js";

export type RefineTaskRunner = (options: AgentTaskOptions) => Promise<AgentTaskResult>;

export interface RefineTaskContext {
  cwd: string;
  provider: string;
  model: string;
  extensionPaths: string[];
  timeoutMs: number;
  runId: string;
  runDirectory: string;
  runner: RefineTaskRunner;
}

export interface DescriptionReconstructionResult {
  description: string;
  primary: AgentTaskResult;
  initialLeaks: string[];
  removedLines: string[];
  primaryDurationMs: number;
}

export type PolicyRecovery = "primary-output" | "written-output" | "format-repair";

export interface PolicyStageResult {
  policy: string;
  primary: AgentTaskResult;
  recovery: PolicyRecovery;
  formatRepair?: {
    run: AgentTaskResult;
    incompleteOutputPath: string;
  };
  primaryDurationMs: number;
  repairDurationMs: number | null;
}

export class IncompleteRefineOutputError extends Error {
  constructor(label: string) {
    super(`Refine agent 未返回完整 ${label} 标记`);
    this.name = "IncompleteRefineOutputError";
  }
}

export function extractRefineMarkedOutput(
  text: string,
  startMarker: string,
  endMarker: string,
  label: string,
): string {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end <= start) throw new IncompleteRefineOutputError(label);
  const value = text.slice(start + startMarker.length, end).trim();
  if (!value) throw new Error(`Refine agent 返回了空 ${label}`);
  return value;
}

export function assertRefineReadEvidence(
  actual: readonly string[],
  required: readonly string[],
  stage = "Refine agent",
): void {
  const reads = new Set(actual.map((path) => normalize(resolve(path)).toLowerCase()));
  const allowed = new Set(required.map((path) => normalize(resolve(path)).toLowerCase()));
  const missing = [...allowed].filter((path) => !reads.has(path));
  if (missing.length > 0) {
    throw new Error(`${stage} 未读取必需输入：${missing.map((path) => basename(path)).join(", ")}`);
  }
  const unexpected = [...reads].filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    throw new Error(`${stage} 读取了本轮允许范围之外的文件：${unexpected.join(", ")}`);
  }
}

export function pipelineRuleLeaks(text: string): string[] {
  const leaks: string[] = [];
  for (const unit of text.split(/\r?\n/)) {
    const lowered = unit.toLowerCase();
    leaks.push(...PRODUCTION_RULES.pipelineOnlySignals.filter((signal) => lowered.includes(signal.toLowerCase())));
    const mentionsWorkflowFormat = PRODUCTION_RULES.pipelineDocumentWorkflowFormats.some((format) => lowered.includes(format));
    const mentionsWorkflowVerb = PRODUCTION_RULES.pipelineDocumentWorkflowVerbs.some((verb) => lowered.includes(verb));
    if (mentionsWorkflowFormat && mentionsWorkflowVerb) leaks.push("document-format-workflow");
    const mentionsSkillWorkflow = lowered.includes("skill")
      && PRODUCTION_RULES.pipelineSkillWorkflowVerbs.some((verb) => lowered.includes(verb));
    if (mentionsSkillWorkflow) leaks.push("skill-workflow");
  }
  return [...new Set(leaks)];
}

export function stripPipelineOnlyLines(text: string): { text: string; removedLines: string[] } {
  const removedLines: string[] = [];
  const kept = text.split(/\r?\n/).filter((line) => {
    if (pipelineRuleLeaks(line).length === 0) return true;
    removedLines.push(line);
    return false;
  });
  return {
    text: kept.join("\n").replace(/(?:\r?\n){3,}/g, "\n\n").trim(),
    removedLines,
  };
}

export function stripPolicyPipelineOnlyLines(text: string): {
  text: string;
  removedLines: string[];
  repairedMetadataLines: string[];
} {
  const lines = text.split(/\r?\n/);
  const repairedMetadataLines: string[] = [];
  if (lines[0]?.trim() === "---") {
    const frontmatterEnd = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (frontmatterEnd > 0) {
      for (let index = 1; index < frontmatterEnd; index += 1) {
        const line = lines[index];
        if (line && /^description\s*:/i.test(line) && pipelineRuleLeaks(line).length > 0) {
          repairedMetadataLines.push(line);
          lines[index] = "description: 从本轮真实生产 session 提炼的文档内容与写作规则。";
        }
      }
    }
  }
  const stripped = stripPipelineOnlyLines(lines.join("\n"));
  return { ...stripped, repairedMetadataLines };
}

export function normalizeRefinePolicy(text: string): string {
  let policy = stripPolicyPipelineOnlyLines(text.trim()).text;
  if (pipelineRuleLeaks(policy).length > 0) throw new Error("Refine policy 包含生产管线规则，已拒绝保存");
  if (!policy.startsWith("---") || !/^name:/m.test(policy) || !/^description:/m.test(policy)) {
    policy = `---\nname: refined-document-policy\ndescription: 从 baseline 与 gold 的差异提炼出的可复用文档质量规则\n---\n\n${policy}`;
  }
  return policy;
}

export async function runDescriptionReconstruction(options: RefineTaskContext & {
  turnsPath: string;
  rulesPath: string;
  outputPath: string;
  taskName: string;
}): Promise<DescriptionReconstructionResult> {
  const requiredPaths = [options.turnsPath, options.rulesPath];
  const primaryStartedAt = Date.now();
  const primary = await options.runner({
    cwd: options.cwd,
    provider: options.provider,
    model: options.model,
    extensionPaths: options.extensionPaths,
    trace: {
      taskId: `${options.runId}:task-reconstruction`,
      name: options.taskName,
      runId: options.runId,
      stage: "task-reconstruction",
      inputRefs: requiredPaths,
      outputRefs: [options.outputPath],
    },
    timeoutMs: options.timeoutMs,
    rawEventsPath: join(options.runDirectory, "description.events.jsonl"),
    systemPrompt: `${requiredReadInstruction(requiredPaths)}\n\n你是隔离运行的 Refine description agent。只整合用户明确提出的最终文档内容要求；后续要求覆盖冲突的早期要求。保留内容、范围、结构、语言、版式和参考资料约束。所有工具、文件中转格式、DOCX/Markdown 转换、图片占位、skill 加载、subagent/并行执行等都属于生产管线规则，禁止写入任务 description。不得读取或依赖其他历史缓存。`,
    prompt: `必须使用 read 工具完整读取 ${options.turnsPath} 和 ${options.rulesPath}。按 User turn 编号的时序整合要求；仅当后续要求明确修正或冲突时，才以其覆盖早期要求。输出一份可独立交给文档 agent 的中文任务描述，使用以下唯一标记：\n<<<DESCRIPTION_START>>>\n（Markdown）\n<<<DESCRIPTION_END>>>`,
  });
  const primaryDurationMs = Date.now() - primaryStartedAt;
  assertRefineReadEvidence(primary.readPaths, requiredPaths, "Description agent");
  const description = extractRefineMarkedOutput(
    primary.finalText,
    "<<<DESCRIPTION_START>>>",
    "<<<DESCRIPTION_END>>>",
    "description",
  );
  const initialLeaks = pipelineRuleLeaks(description);
  const stripped = stripPipelineOnlyLines(description);
  if (!stripped.text) {
    throw new Error("Refine description 清除生产管线规则后为空，已拒绝保存");
  }
  const remainingLeaks = pipelineRuleLeaks(stripped.text);
  if (remainingLeaks.length > 0) {
    throw new Error(`Refine description 包含生产管线规则，已拒绝保存：${remainingLeaks.join(", ")}`);
  }
  await writeFile(options.outputPath, `${stripped.text}\n`, "utf8");
  return {
    description: stripped.text,
    primary,
    initialLeaks,
    removedLines: stripped.removedLines,
    primaryDurationMs,
  };
}

async function readCompletedPolicy(
  path: string,
  normalizePolicy: (text: string) => string,
): Promise<string | undefined> {
  try {
    const written = (await readFile(path, "utf8")).trim();
    if (!written.startsWith("---") || !/^name:/m.test(written) || !/^description:/m.test(written)) return undefined;
    return normalizePolicy(written);
  } catch {
    return undefined;
  }
}

interface PolicyStageBaseOptions {
  requiredPaths: string[];
  outputRefs: string[];
  outputPath: string;
  taskId: string;
  taskName: string;
  eventsPath: string;
  traceAttributes?: PhoenixAgentTaskContext["attributes"];
  systemPrompt: string;
  prompt: string;
  normalizePolicy?: (text: string) => string;
}

type PolicyStageRecoveryOptions =
  | { recoveryMode: "fail" }
  | {
      recoveryMode?: "repair";
      incompleteOutputPath: string;
      repairTaskId: string;
      repairTaskName: string;
      repairEventsPath: string;
      repairTraceAttributes?: PhoenixAgentTaskContext["attributes"];
      repairSystemPrompt: string;
      repairPrompt: (repairRequiredPaths: string[]) => string;
    };

export async function runPolicyOptimizationStage(
  options: RefineTaskContext & PolicyStageBaseOptions & PolicyStageRecoveryOptions,
): Promise<PolicyStageResult> {
  const normalizePolicy = options.normalizePolicy ?? normalizeRefinePolicy;
  const primaryStartedAt = Date.now();
  const primary = await options.runner({
    cwd: options.cwd,
    provider: options.provider,
    model: options.model,
    extensionPaths: options.extensionPaths,
    trace: {
      taskId: options.taskId,
      name: options.taskName,
      runId: options.runId,
      stage: "policy-optimization",
      inputRefs: options.requiredPaths,
      outputRefs: options.outputRefs,
      ...(options.traceAttributes ? { attributes: options.traceAttributes } : {}),
    },
    timeoutMs: options.timeoutMs,
    rawEventsPath: options.eventsPath,
    systemPrompt: `${requiredReadInstruction(options.requiredPaths)}\n\n${options.systemPrompt}`,
    prompt: options.prompt,
  });
  const primaryDurationMs = Date.now() - primaryStartedAt;
  assertRefineReadEvidence(primary.readPaths, options.requiredPaths, "Policy refiner");
  let recovery: PolicyRecovery = "primary-output";
  try {
    return {
      policy: normalizePolicy(extractRefineMarkedOutput(primary.finalText, "<<<POLICY_START>>>", "<<<POLICY_END>>>", "policy")),
      primary,
      recovery,
      primaryDurationMs,
      repairDurationMs: null,
    };
  } catch (error) {
    if (!(error instanceof IncompleteRefineOutputError)) throw error;
    if (options.recoveryMode === "fail") throw error;
  }

  const writtenPolicy = await readCompletedPolicy(options.outputPath, normalizePolicy);
  if (writtenPolicy) {
    recovery = "written-output";
    return { policy: writtenPolicy, primary, recovery, primaryDurationMs, repairDurationMs: null };
  }

  await writeFile(options.incompleteOutputPath, `${primary.finalText}\n`, "utf8");
  const repairRequiredPaths = [...options.requiredPaths, options.incompleteOutputPath];
  const repairStartedAt = Date.now();
  const repaired = await options.runner({
    cwd: options.cwd,
    provider: options.provider,
    model: options.model,
    extensionPaths: options.extensionPaths,
    trace: {
      taskId: options.repairTaskId,
      name: options.repairTaskName,
      runId: options.runId,
      stage: "policy-format-repair",
      inputRefs: repairRequiredPaths,
      outputRefs: options.outputRefs,
      ...(options.repairTraceAttributes ? { attributes: options.repairTraceAttributes } : {}),
    },
    timeoutMs: options.timeoutMs,
    rawEventsPath: options.repairEventsPath,
    systemPrompt: `${requiredReadInstruction(repairRequiredPaths)}\n\n${options.repairSystemPrompt}`,
    prompt: options.repairPrompt(repairRequiredPaths),
  });
  const repairDurationMs = Date.now() - repairStartedAt;
  assertRefineReadEvidence(repaired.readPaths, repairRequiredPaths, "Policy format repair agent");
  recovery = "format-repair";
  return {
    policy: normalizePolicy(extractRefineMarkedOutput(repaired.finalText, "<<<POLICY_START>>>", "<<<POLICY_END>>>", "policy")),
    primary,
    recovery,
    formatRepair: { run: repaired, incompleteOutputPath: options.incompleteOutputPath },
    primaryDurationMs,
    repairDurationMs,
  };
}
