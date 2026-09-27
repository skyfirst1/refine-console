import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolveAcontextReplayChunkSize } from "./acontext-replay.js";
import { discoverGeneratedArtifacts } from "./artifact-discovery.js";
import type { AcontextGateway, StoredMessage } from "./contracts.js";
import { normalizeDocumentToMarkdown } from "./document-normalizer.js";
import { adaptSessionEntry } from "./message-adapter.js";
import { bundledProviderExtensionPath, runAgentTask } from "./agent-task-runner.js";
import { PRODUCTION_RULES } from "./production-rules.js";
import {
  pipelineRuleLeaks,
  runDescriptionReconstruction,
  runPolicyOptimizationStage,
  stripPipelineOnlyLines,
  stripPolicyPipelineOnlyLines,
} from "./refine-workflow.js";
import type { ProductionRangeSelection } from "./session-range.js";
import { sliceEntryRange } from "./session-range.js";
import { changedSkillFiles, fingerprintLearningSpace, SkillSynchronizer } from "./skill-sync.js";

export interface ProductionPipelineOptions {
  client: AcontextGateway;
  piSessionId: string;
  piSessionFile?: string;
  cwd: string;
  branch: SessionEntry[];
  selection: ProductionRangeSelection;
  runRoot: string;
  provider: string;
  model: string;
  captureToolResults: boolean;
  maxToolResultChars: number;
  timeoutMs: number;
}

export interface ProductionPipelineResult {
  runId: string;
  runDirectory: string;
  manifestPath: string;
  learningSpaceId: string;
  acontextSessionId: string;
  descriptionPath: string;
  baselinePath: string;
  goldPath: string;
  currentPolicyPath: string;
  refinedPolicyPath: string;
  skillPath: string;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sumPiUsage(results: Array<Awaited<ReturnType<typeof runAgentTask>> | undefined>) {
  return results.reduce((total, result) => {
    if (!result) return total;
    total.input += result.usage.input;
    total.output += result.usage.output;
    total.cacheRead += result.usage.cacheRead;
    total.cacheWrite += result.usage.cacheWrite;
    total.totalTokens += result.usage.totalTokens;
    total.costUsd += result.usage.costUsd;
    return total;
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 });
}

function textFromMessage(entry: SessionEntry): string | undefined {
  if (entry.type !== "message" || entry.message.role !== "user") return undefined;
  if (typeof entry.message.content === "string") return entry.message.content.trim() || undefined;
  const value = entry.message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return value || undefined;
}

function hasTrainingConversationText(entry: SessionEntry): boolean {
  if (entry.type !== "message") return false;
  if (entry.message.role === "user") return Boolean(textFromMessage(entry));
  if (entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) return false;
  return entry.message.content.some((block) => block.type === "text" && block.text.trim().length > 0);
}

export function projectProductionAcontextMessages(
  entries: readonly SessionEntry[],
  options: { sourceSessionId: string; sourceSessionFile?: string; maxToolResultChars: number },
): StoredMessage[] {
  const messages: StoredMessage[] = [];
  for (const entry of entries) {
    if (!hasTrainingConversationText(entry)) continue;
    const stored = adaptSessionEntry(entry, {
      captureToolCalls: false,
      captureToolResults: false,
      maxToolResultChars: options.maxToolResultChars,
      sourceSessionId: options.sourceSessionId,
      ...(options.sourceSessionFile ? { sourceSessionFile: options.sourceSessionFile } : {}),
    });
    if (!stored || typeof stored.blob.content !== "string" || !stored.blob.content.trim()) continue;
    messages.push(stored);
  }
  return messages;
}

async function markdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(path));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(path);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function compileSkillPolicy(skillRoot: string): Promise<string> {
  const files = await markdownFiles(skillRoot);
  if (files.length === 0) throw new Error(`Fresh Acontext learning produced no Markdown skill files: ${skillRoot}`);
  const sections: string[] = [];
  for (const path of files) {
    sections.push(`<!-- source: ${path} -->\n\n${(await readFile(path, "utf8")).trim()}`);
  }
  return sections.join("\n\n---\n\n");
}

export { pipelineRuleLeaks, stripPipelineOnlyLines, stripPolicyPipelineOnlyLines } from "./refine-workflow.js";

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

export async function waitForCompletedLearning(
  client: AcontextGateway,
  spaceId: string,
  sessionId: string,
  timeoutMs: number,
  graceMs: number = PRODUCTION_RULES.learningFailureGracePeriodMs,
  pollMs: number = 3_000,
): Promise<void> {
  let learning = await client.learningSpaces.waitForLearning({
    spaceId,
    sessionId,
    timeout: Math.ceil(timeoutMs / 1000),
    pollInterval: Math.max(1, Math.ceil(pollMs / 1000)),
  });
  if (learning.status === "completed") return;
  if (!client.learningSpaces.getSession) {
    throw new Error(`Acontext learning did not complete: ${learning.status}; SDK cannot poll the terminal record`);
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    learning = await client.learningSpaces.getSession({ spaceId, sessionId });
    if (learning.status === "completed") return;
  }
  throw new Error(`Acontext learning did not complete after ${graceMs}ms grace period: ${learning.status}`);
}

export async function runProductionPipeline(options: ProductionPipelineOptions): Promise<ProductionPipelineResult> {
  if (!options.client.learningSpaces.create) {
    throw new Error("Installed Acontext SDK does not support isolated learning-space creation");
  }
  const pipelineStartedAt = Date.now();
  const pipelineStartedAtIso = new Date(pipelineStartedAt).toISOString();
  const runId = `${pipelineStartedAtIso.replace(/[:.]/g, "-")}-${randomUUID()}`;
  const runDirectory = resolve(options.runRoot, runId);
  await mkdir(resolve(options.runRoot), { recursive: true });
  await mkdir(runDirectory, { recursive: false });
  const manifestPath = join(runDirectory, "manifest.json");
  const runStatePath = join(runDirectory, "run-state.json");
  await writeFile(runStatePath, `${JSON.stringify({ version: 1, status: "running", runId, startedAt: pipelineStartedAtIso }, null, 2)}\n`, "utf8");
  try {
  const acontextEntries = sliceEntryRange(options.branch, options.selection.acontext, "acontext");
  const refineEntries = sliceEntryRange(options.branch, options.selection.refine, "refine");
  const trainingMessages = projectProductionAcontextMessages(acontextEntries, {
    sourceSessionId: options.piSessionId,
    ...(options.piSessionFile ? { sourceSessionFile: options.piSessionFile } : {}),
    maxToolResultChars: options.maxToolResultChars,
  });
  if (trainingMessages.length === 0) throw new Error("Acontext range contains no learnable user or assistant text");
  const rulesPath = join(runDirectory, "production-rules.json");
  await writeFile(rulesPath, `${JSON.stringify(PRODUCTION_RULES, null, 2)}\n`, "utf8");

  const artifacts = await discoverGeneratedArtifacts(refineEntries, options.cwd);
  if (artifacts.baseline.path.toLowerCase() === artifacts.gold.path.toLowerCase()) {
    throw new Error("Refine range must contain at least two distinct generated document artifacts so the first can be compared with the final gold");
  }
  const baseline = await normalizeDocumentToMarkdown(artifacts.baseline.path);
  const gold = await normalizeDocumentToMarkdown(artifacts.gold.path);
  const baselinePath = join(runDirectory, "baseline.md");
  const goldPath = join(runDirectory, "gold.md");
  await Promise.all([
    writeFile(baselinePath, `${baseline.markdown}\n`, "utf8"),
    writeFile(goldPath, `${gold.markdown}\n`, "utf8"),
  ]);

  const acontextStartedAt = Date.now();
  const learningSpace = await options.client.learningSpaces.create!({
    meta: {
      purpose: "pi-acontext-production-refine",
      source: "pi-session-range",
      pi_session_id: options.piSessionId,
      run_id: runId,
    },
  });
  const skillsBeforeLearning = await fingerprintLearningSpace(options.client, learningSpace.id);
  const syncContext = {
    piSessionId: options.piSessionId,
    ...(options.piSessionFile ? { piSessionFile: options.piSessionFile } : {}),
    cwd: options.cwd,
  };
  const acontextSession = await options.client.sessions.create({
    configs: {
      source: "pi",
      pi_session_id: syncContext.piSessionId,
      ...(syncContext.piSessionFile ? { pi_session_file: syncContext.piSessionFile } : {}),
      cwd: syncContext.cwd,
      production_run_id: runId,
    },
  });
  await options.client.learningSpaces.learn({ spaceId: learningSpace.id, sessionId: acontextSession.id });
  const replayChunkSize = await resolveAcontextReplayChunkSize(options.client);
  let storedMessages = 0;
  for (const stored of trainingMessages) {
    await options.client.sessions.storeMessage(
      acontextSession.id,
      { role: stored.blob.role, content: stored.blob.content },
      { format: "openai", meta: stored.meta },
    );
    storedMessages += 1;
    if (storedMessages % replayChunkSize === 0) await options.client.sessions.flush(acontextSession.id);
  }
  await options.client.sessions.flush(acontextSession.id);
  await waitForCompletedLearning(options.client, learningSpace.id, acontextSession.id, options.timeoutMs);
  const skillsAfterLearning = await fingerprintLearningSpace(options.client, learningSpace.id);
  const learnedSkillFiles = changedSkillFiles(skillsBeforeLearning, skillsAfterLearning);
  if (learnedSkillFiles.length === 0) {
    throw new Error("Acontext reported completed but produced no new or changed downloadable skill content");
  }
  const skillRoot = join(runDirectory, "acontext-skills");
  const skillSnapshot = await new SkillSynchronizer(options.client, skillRoot).sync(learningSpace.id);
  const currentPolicyPath = join(runDirectory, "current-policy.md");
  const compiledPolicy = await compileSkillPolicy(skillSnapshot.path);
  await writeFile(currentPolicyPath, `${compiledPolicy}\n`, "utf8");
  const acontextDurationMs = Date.now() - acontextStartedAt;

  const userTurns = refineEntries.map(textFromMessage).filter((value): value is string => Boolean(value));
  if (userTurns.length === 0) throw new Error("Refine range contains no user messages");
  const refineTurnsPath = join(runDirectory, "refine-user-turns.md");
  await writeFile(
    refineTurnsPath,
    userTurns.map((turn, index) => `## User turn ${index + 1}\n\n${turn}`).join("\n\n"),
    "utf8",
  );
  const providerExtensions = options.provider === "deepseek" ? [bundledProviderExtensionPath()] : [];
  const descriptionPath = join(runDirectory, "description.md");
  const descriptionStage = await runDescriptionReconstruction({
    cwd: options.cwd,
    provider: options.provider,
    model: options.model,
    extensionPaths: providerExtensions,
    timeoutMs: options.timeoutMs,
    runId,
    runDirectory,
    runner: runAgentTask,
    turnsPath: refineTurnsPath,
    rulesPath,
    outputPath: descriptionPath,
    taskName: "P02 Refine task reconstruction",
  });
  const description = descriptionStage.description;
  const descriptionRun = descriptionStage.primary;
  const descriptionDurationMs = descriptionStage.primaryDurationMs;
  const initialDescriptionLeaks = descriptionStage.initialLeaks;
  const descriptionRemovedLines = descriptionStage.removedLines;

  const refinedPolicyPath = join(runDirectory, "refined-policy.md");
  const policyRequiredPaths = [descriptionPath, baselinePath, goldPath, currentPolicyPath, rulesPath];
  const policyStage = await runPolicyOptimizationStage({
    cwd: options.cwd,
    provider: options.provider,
    model: options.model,
    extensionPaths: providerExtensions,
    timeoutMs: options.timeoutMs,
    runId,
    runDirectory,
    runner: runAgentTask,
    requiredPaths: policyRequiredPaths,
    outputRefs: [refinedPolicyPath],
    outputPath: refinedPolicyPath,
    taskId: `${runId}:policy-optimization`,
    taskName: "P04 Refine policy optimization",
    eventsPath: join(runDirectory, "policy-refine.events.jsonl"),
    systemPrompt: "你是隔离运行的 Agent policy refiner。比较同一真实生产 session 的初稿与最终 gold，只提炼跨任务可复用的文档内容与写作规则。gold 是目标质量样本，但不是封闭事实库；不得把 gold 未提及的新事实直接判错。文件中转格式、DOCX/Markdown 转换、图片占位、skill、工具调用、subagent/并行安排由生产规则统一管理，禁止写入 policy。不得写入具体任务的软件名、格式清单或固定事实，也不得读取或依赖指定路径之外的历史缓存。",
    prompt: `必须使用 read 工具完整读取以下文件：\n- 任务 description：${descriptionPath}\n- 初稿：${baselinePath}\n- 最终 gold：${goldPath}\n- 本轮新生成的 Acontext policy：${currentPolicyPath}\n- 生产规则：${rulesPath}\n\n先识别初稿相对 gold 的稳定缺陷，再输出完整的新 policy。使用以下唯一标记：\n<<<POLICY_START>>>\n---\nname: refined-production-policy\ndescription: ...\n---\n（完整 policy）\n<<<POLICY_END>>>`,
    normalizePolicy: (policy) => policy.trim(),
    recoveryMode: "fail",
  });
  const policyRun = policyStage.primary;
  const policyDurationMs = policyStage.primaryDurationMs;
  let refinedPolicy = policyStage.policy;
  const initialPolicyLeaks = pipelineRuleLeaks(refinedPolicy);
  const policyStrip = stripPolicyPipelineOnlyLines(refinedPolicy);
  refinedPolicy = policyStrip.text;
  const remainingPolicyLeaks = pipelineRuleLeaks(refinedPolicy);
  if (remainingPolicyLeaks.length > 0) {
    throw new Error(`Refined policy still contains pipeline-only rules: ${remainingPolicyLeaks.join(", ")}`);
  }
  if (!refinedPolicy.includes("name:") || !refinedPolicy.includes("description:")) {
    throw new Error("Refined policy is missing required YAML metadata");
  }
  await writeFile(refinedPolicyPath, `${refinedPolicy}\n`, "utf8");
  const refineUsage = sumPiUsage([descriptionRun, policyRun]);

  const manifest = {
    version: 1,
    status: "completed",
    runId,
    createdAt: new Date().toISOString(),
    cachePolicy: "fresh-run-only",
    source: {
      piSessionId: options.piSessionId,
      piSessionFile: options.piSessionFile ?? null,
      ranges: options.selection,
    },
    acontext: {
      learningSpaceId: learningSpace.id,
      sessionId: acontextSession.id,
      storedMessages,
      trainingInput: PRODUCTION_RULES.acontextTrainingMessages,
      goldInjectionEnabled: PRODUCTION_RULES.injectNormalizedGoldIntoLearning,
      goldInjectionMode: PRODUCTION_RULES.acontextGoldInjectionMode,
      injectedGoldArtifacts: 0,
      injectedGoldChars: 0,
      fullGoldChars: gold.markdown.length,
      goldInjectionTruncated: null,
      skillSnapshotPath: skillSnapshot.path,
      skillCount: skillSnapshot.skillCount,
      skippedSkillFiles: skillSnapshot.skippedFiles,
      changedSkillFiles: learnedSkillFiles,
      skillsBeforeLearning,
      skillsAfterLearning,
    },
    artifacts: {
      discovered: artifacts.candidates,
      baseline: { source: baseline.sourcePath, normalized: baselinePath, sha256: sha256(baseline.markdown), imagesOmitted: baseline.imagesOmitted, generationEvidence: artifacts.baseline },
      gold: { source: gold.sourcePath, normalized: goldPath, sha256: sha256(gold.markdown), imagesOmitted: gold.imagesOmitted, generationEvidence: artifacts.gold },
    },
    outputs: {
      descriptionPath,
      currentPolicyPath,
      refinedPolicyPath,
      descriptionSha256: sha256(description),
      currentPolicySha256: sha256(compiledPolicy),
      refinedPolicySha256: sha256(refinedPolicy),
    },
    performance: {
      pipelineStartedAt: pipelineStartedAtIso,
      totalDurationMs: Date.now() - pipelineStartedAt,
      acontext: {
        durationMs: acontextDurationMs,
        storedMessages,
        tokenUsage: null,
        tokenUsageNote: "Acontext SDK does not return learner LLM usage; inspect Acontext core telemetry logs for internal token counts.",
      },
      refine: {
        totalUsage: refineUsage,
        taskReconstruction: { durationMs: descriptionDurationMs, usage: descriptionRun.usage },
        taskReconstructionCleanup: null,
        policyOptimization: { durationMs: policyDurationMs, usage: policyRun.usage },
        policyCleanup: null,
      },
    },
    evidence: {
      descriptionEvents: descriptionRun.rawEventsPath,
      descriptionReadPaths: descriptionRun.readPaths,
      descriptionInitialPipelineRuleLeaks: initialDescriptionLeaks,
      descriptionCleanupEvents: null,
      descriptionCleanupReadPaths: [],
      descriptionDeterministicallyRemovedLines: descriptionRemovedLines,
      policyEvents: policyRun.rawEventsPath,
      policyReadPaths: policyRun.readPaths,
      policyInitialPipelineRuleLeaks: initialPolicyLeaks,
      policyCleanupEvents: null,
      policyCleanupReadPaths: [],
      policyRepairedMetadataLines: policyStrip.repairedMetadataLines,
      policyDeterministicallyRemovedLines: policyStrip.removedLines,
    },
    rules: PRODUCTION_RULES,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(runStatePath, `${JSON.stringify({ version: 1, status: "completed", runId, startedAt: pipelineStartedAtIso, completedAt: new Date().toISOString(), manifestPath }, null, 2)}\n`, "utf8");
  return {
    runId,
    runDirectory,
    manifestPath,
    learningSpaceId: learningSpace.id,
    acontextSessionId: acontextSession.id,
    descriptionPath,
    baselinePath,
    goldPath,
    currentPolicyPath,
    refinedPolicyPath,
    skillPath: skillSnapshot.path,
  };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeFile(runStatePath, `${JSON.stringify({ version: 1, status: "failed", runId, startedAt: pipelineStartedAtIso, failedAt: new Date().toISOString(), error: message }, null, 2)}\n`, "utf8");
    throw error;
  }
}
