import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { bundledProviderExtensionPath, runAgentTask, type AgentTaskOptions, type AgentTaskResult } from "./agent-task-runner.js";

const DREAM_SOURCE_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".json", ".yaml", ".yml"]);
const DEFAULT_MAX_SOURCE_BYTES = 1_000_000;
const DEFAULT_LOCK_STALE_MS = 60 * 60 * 1_000;

export type AutoDreamPhase = "orienting" | "consolidating" | "validating" | "publishing";
export type AutoDreamStatus = "approved" | "rejected" | "skipped";

type TaskRunner = (options: AgentTaskOptions) => Promise<AgentTaskResult>;

export interface AutoDreamOptions {
  cwd: string;
  sourceSkillPath: string;
  refinedPolicyPath: string;
  runRoot: string;
  publishRoot: string;
  provider: string;
  model: string;
  timeoutMs: number;
  taskRunner?: TaskRunner;
  maxSourceBytes?: number;
  lockStaleMs?: number;
  onProgress?: (phase: AutoDreamPhase) => void;
}

export interface AutoDreamValidation {
  approved: boolean;
  candidate_sha256: string;
  checks: {
    source_grounded: boolean;
    preserves_refined_policy: boolean;
    no_contradictions: boolean;
    no_task_specific_facts: boolean;
    no_pipeline_leak: boolean;
    actionable: boolean;
  };
  reason: string;
}

export interface AutoDreamResult {
  runId: string;
  status: AutoDreamStatus;
  inputFingerprint: string;
  runDirectory?: string;
  manifestPath?: string;
  candidatePath?: string;
  validationPath?: string;
  activeSkillPath?: string;
  previousSkillPath?: string;
  reason?: string;
}

interface DreamPointer {
  version: 1;
  path: string;
  previousPath?: string;
  runId: string;
  candidateSha256: string;
  inputFingerprint: string;
  updatedAt: string;
  rollbackAt?: string;
}

interface SourceFile {
  path: string;
  content: string;
  sha256: string;
  bytes: number;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function containedPath(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const child = relative(resolvedRoot, resolvedCandidate);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`Auto-Dream path escapes its root: ${resolvedCandidate}`);
  }
  return resolvedCandidate;
}

async function readPointer(publishRoot: string): Promise<DreamPointer | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(resolve(publishRoot), "active.json"), "utf8")) as Partial<DreamPointer>;
    if (parsed.version !== 1 || typeof parsed.path !== "string" || typeof parsed.runId !== "string"
      || typeof parsed.candidateSha256 !== "string" || typeof parsed.inputFingerprint !== "string"
      || typeof parsed.updatedAt !== "string") return undefined;
    const path = containedPath(publishRoot, parsed.path);
    const previousPath = typeof parsed.previousPath === "string"
      ? containedPath(publishRoot, parsed.previousPath)
      : undefined;
    return { ...parsed, path, ...(previousPath ? { previousPath } : {}) } as DreamPointer;
  } catch {
    return undefined;
  }
}

async function writePointer(publishRoot: string, pointer: DreamPointer): Promise<void> {
  const root = resolve(publishRoot);
  await mkdir(root, { recursive: true });
  containedPath(root, pointer.path);
  if (pointer.previousPath) containedPath(root, pointer.previousPath);
  const destination = join(root, "active.json");
  const temporary = join(root, `.active.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(pointer, null, 2)}\n`, "utf8");
  await rm(destination, { force: true });
  await rename(temporary, destination);
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(root: string, staleMs: number): Promise<() => Promise<void>> {
  const lockRoot = resolve(root);
  const lockPath = join(lockRoot, ".auto-dream.lock");
  await mkdir(lockRoot, { recursive: true });
  let handle: FileHandle | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, "utf8");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw error;
      const info = await stat(lockPath);
      let pid = 0;
      try {
        const parsed = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
        if (typeof parsed.pid === "number") pid = parsed.pid;
      } catch {
        // A malformed old lock can only be reclaimed after the stale threshold.
      }
      const stale = Date.now() - info.mtimeMs > staleMs;
      if (!stale || processAlive(pid)) throw new Error("Auto-Dream is already running");
      await rm(lockPath, { force: true });
    }
  }
  if (!handle) throw new Error("Unable to acquire Auto-Dream lock");
  return async () => {
    await handle!.close();
    await rm(lockPath, { force: true });
  };
}

async function collectSourceFiles(sourceRoot: string, maxBytes: number): Promise<SourceFile[]> {
  const root = resolve(sourceRoot);
  if (!(await stat(root)).isDirectory()) throw new Error("Auto-Dream skill source must be a directory");
  const files: SourceFile[] = [];
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".")) continue;
      const path = containedPath(root, join(directory, entry.name));
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && DREAM_SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        const info = await stat(path);
        totalBytes += info.size;
        if (totalBytes > maxBytes) throw new Error(`Auto-Dream sources exceed ${maxBytes} bytes`);
        const content = await readFile(path, "utf8");
        files.push({
          path: relative(root, path).replace(/\\/g, "/"),
          content,
          sha256: sha256(content),
          bytes: info.size,
        });
      }
    }
  };
  await visit(root);
  if (files.length === 0) throw new Error("Auto-Dream found no readable skill files");
  return files;
}

function buildSourceBundle(files: SourceFile[]): string {
  return files.map((file) => [
    `## Skill source: ${file.path}`,
    "",
    `SHA256: ${file.sha256}`,
    "",
    "```text",
    file.content.replace(/```/g, "``​`"),
    "```",
  ].join("\n")).join("\n\n");
}

function extractMarked(text: string, start: string, end: string, label: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) throw new Error(`Auto-Dream ${label} is missing output markers`);
  const value = text.slice(startIndex + start.length, endIndex).trim();
  if (!value) throw new Error(`Auto-Dream ${label} is empty`);
  return value;
}

function requireReads(actual: string[], required: string[]): void {
  const reads = new Set(actual.map((path) => resolve(path).toLowerCase()));
  const allowed = new Set(required.map((path) => resolve(path).toLowerCase()));
  const missing = [...allowed].filter((path) => !reads.has(path));
  if (missing.length > 0) throw new Error(`Auto-Dream agent did not read: ${missing.map((path) => basename(path)).join(", ")}`);
  const unexpected = [...reads].filter((path) => !allowed.has(path));
  if (unexpected.length > 0) throw new Error(`Auto-Dream agent read outside its evidence set: ${unexpected.join(", ")}`);
}

function validateCandidate(candidate: string): void {
  if (Buffer.byteLength(candidate, "utf8") > 128_000) throw new Error("Auto-Dream candidate exceeds 128 KB");
  if (!/^---\s*[\s\S]*?^name:\s*[^\r\n]+[\s\S]*?^description:\s*[^\r\n]+[\s\S]*?^---/m.test(candidate)) {
    throw new Error("Auto-Dream candidate must contain name and description frontmatter");
  }
}

export function parseAutoDreamValidation(text: string, expectedSha256: string): AutoDreamValidation {
  const raw = extractMarked(text, "<<<DREAM_VALIDATION_START>>>", "<<<DREAM_VALIDATION_END>>>", "validation");
  const parsed = JSON.parse(raw) as Partial<AutoDreamValidation>;
  const checks = parsed.checks as Partial<AutoDreamValidation["checks"]> | undefined;
  const keys: Array<keyof AutoDreamValidation["checks"]> = [
    "source_grounded",
    "preserves_refined_policy",
    "no_contradictions",
    "no_task_specific_facts",
    "no_pipeline_leak",
    "actionable",
  ];
  if (typeof parsed.approved !== "boolean" || parsed.candidate_sha256 !== expectedSha256 || !checks
    || keys.some((key) => typeof checks[key] !== "boolean")) {
    throw new Error("Auto-Dream validator returned an invalid contract");
  }
  const normalizedChecks = Object.fromEntries(keys.map((key) => [key, checks[key]])) as AutoDreamValidation["checks"];
  const allChecksPass = keys.every((key) => normalizedChecks[key]);
  return {
    approved: parsed.approved && allChecksPass,
    candidate_sha256: parsed.candidate_sha256,
    checks: normalizedChecks,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
  };
}

export async function loadActiveAutoDreamPath(publishRoot: string): Promise<string | undefined> {
  const pointer = await readPointer(publishRoot);
  if (!pointer) return undefined;
  try {
    return (await stat(pointer.path)).isDirectory() ? pointer.path : undefined;
  } catch {
    return undefined;
  }
}

export async function rollbackAutoDream(publishRoot: string): Promise<string> {
  const pointer = await readPointer(publishRoot);
  if (!pointer?.previousPath) throw new Error("Auto-Dream has no previous snapshot to restore");
  if (!(await stat(pointer.previousPath)).isDirectory()) throw new Error("Auto-Dream previous snapshot is unavailable");
  await writePointer(publishRoot, {
    ...pointer,
    path: pointer.previousPath,
    previousPath: pointer.path,
    updatedAt: new Date().toISOString(),
    rollbackAt: new Date().toISOString(),
  });
  return pointer.previousPath;
}

export async function runAutoDream(options: AutoDreamOptions): Promise<AutoDreamResult> {
  const publishRoot = resolve(options.publishRoot);
  const release = await acquireLock(publishRoot, options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS);
  let failedRunId: string | undefined;
  let failedRunStatePath: string | undefined;
  try {
    options.onProgress?.("orienting");
    const sourceFiles = await collectSourceFiles(options.sourceSkillPath, options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES);
    const refinedPolicy = await readFile(resolve(options.refinedPolicyPath), "utf8");
    const inputFingerprint = sha256(JSON.stringify({
      sources: sourceFiles.map(({ path, sha256: hash }) => ({ path, sha256: hash })),
      refinedPolicySha256: sha256(refinedPolicy),
    }));
    const active = await readPointer(publishRoot);
    if (active?.inputFingerprint === inputFingerprint) {
      return {
        runId: active.runId,
        status: "skipped",
        inputFingerprint,
        activeSkillPath: active.path,
        ...(active.previousPath ? { previousSkillPath: active.previousPath } : {}),
        reason: "The same skill and Refine evidence is already active.",
      };
    }

    const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
    const runDirectory = resolve(options.runRoot, runId);
    await mkdir(resolve(options.runRoot), { recursive: true });
    await mkdir(runDirectory, { recursive: false });
    const runStatePath = join(runDirectory, "run-state.json");
    failedRunId = runId;
    failedRunStatePath = runStatePath;
    const manifestPath = join(runDirectory, "manifest.json");
    const sourceBundlePath = join(runDirectory, "skill-sources.md");
    const policyPath = join(runDirectory, "refined-policy.md");
    const candidatePath = join(runDirectory, "candidate-skill.md");
    const validationPath = join(runDirectory, "validation.json");
    await writeFile(runStatePath, `${JSON.stringify({ version: 1, status: "running", runId, startedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
    await Promise.all([
      writeFile(sourceBundlePath, `${buildSourceBundle(sourceFiles)}\n`, "utf8"),
      writeFile(policyPath, refinedPolicy, "utf8"),
    ]);

    const runner = options.taskRunner ?? runAgentTask;
    options.onProgress?.("consolidating");
    const synthesis = await runner({
      cwd: options.cwd,
      provider: options.provider,
      model: options.model,
      extensionPaths: options.provider === "deepseek" ? [bundledProviderExtensionPath()] : [],
      timeoutMs: options.timeoutMs,
      rawEventsPath: join(runDirectory, "consolidation.events.jsonl"),
      systemPrompt: "你是后台 Auto-Dream consolidation agent。严格执行 Orient、Gather、Consolidate、Prune 四阶段：理解现有 skill 结构；收集 refined policy 中有证据的新增规则；合并重复或冲突规则；压缩索引并输出一个完整可复用 skill。不得编造未在输入中出现的事实，不得保留具体 session、文件路径、失败故事或生产管线元叙事。只允许读取指定文件，不得修改任何源文件。",
      prompt: `必须使用 read 工具完整读取：\n- 已抽取 skill：${sourceBundlePath}\n- 三轮 Refine 最终策略：${policyPath}\n\n输出合并后的完整 SKILL.md。Refine 只用于校正文档质量规则；skill 中与任务执行、用户偏好和可复用工作流有关且不冲突的规则必须保留。使用唯一标记：\n<<<DREAM_SKILL_START>>>\n---\nname: consolidated-document-agent\ndescription: ...\n---\n（完整 skill）\n<<<DREAM_SKILL_END>>>`,
    });
    requireReads(synthesis.readPaths, [sourceBundlePath, policyPath]);
    const candidate = extractMarked(synthesis.finalText, "<<<DREAM_SKILL_START>>>", "<<<DREAM_SKILL_END>>>", "candidate");
    validateCandidate(candidate);
    await writeFile(candidatePath, `${candidate}\n`, "utf8");
    const candidateSha256 = sha256(candidate);

    options.onProgress?.("validating");
    const validationRun = await runner({
      cwd: options.cwd,
      provider: options.provider,
      model: options.model,
      extensionPaths: options.provider === "deepseek" ? [bundledProviderExtensionPath()] : [],
      timeoutMs: options.timeoutMs,
      rawEventsPath: join(runDirectory, "validation.events.jsonl"),
      systemPrompt: "你是新上下文中独立运行的 Auto-Dream validator。默认拒绝。逐项核对候选 skill 是否忠于全部输入、完整保留有证据的 Refine 规则、没有矛盾、没有具体任务事实、没有生产管线泄漏且规则可执行。不得采信 consolidation agent 的自我评价，不得修改文件。",
      prompt: `必须使用 read 工具完整读取：\n- 原始 skill 证据：${sourceBundlePath}\n- Refine 策略：${policyPath}\n- 候选 skill：${candidatePath}\n\n候选 SHA256 为 ${candidateSha256}。只输出以下唯一标记内的 JSON：\n<<<DREAM_VALIDATION_START>>>\n{"approved":false,"candidate_sha256":"${candidateSha256}","checks":{"source_grounded":false,"preserves_refined_policy":false,"no_contradictions":false,"no_task_specific_facts":false,"no_pipeline_leak":false,"actionable":false},"reason":"..."}\n<<<DREAM_VALIDATION_END>>>`,
    });
    requireReads(validationRun.readPaths, [sourceBundlePath, policyPath, candidatePath]);
    const validation = parseAutoDreamValidation(validationRun.finalText, candidateSha256);
    await writeFile(validationPath, `${JSON.stringify(validation, null, 2)}\n`, "utf8");

    let activeSkillPath: string | undefined;
    let previousSkillPath = active?.path;
    if (validation.approved) {
      options.onProgress?.("publishing");
      const snapshotRoot = join(publishRoot, `snapshot-${candidateSha256.slice(0, 16)}`);
      if (previousSkillPath === snapshotRoot) previousSkillPath = undefined;
      const skillDirectory = join(snapshotRoot, "consolidated-document-agent");
      try {
        if (!(await stat(skillDirectory)).isDirectory()) throw new Error("not a directory");
      } catch {
        const stagingRoot = join(publishRoot, `.staging-${randomUUID()}`);
        const stagingSkill = join(stagingRoot, "consolidated-document-agent");
        await mkdir(stagingSkill, { recursive: true });
        await writeFile(join(stagingSkill, "SKILL.md"), `${candidate}\n`, "utf8");
        await rename(stagingRoot, snapshotRoot);
      }
      await writePointer(publishRoot, {
        version: 1,
        path: snapshotRoot,
        ...(previousSkillPath ? { previousPath: previousSkillPath } : {}),
        runId,
        candidateSha256,
        inputFingerprint,
        updatedAt: new Date().toISOString(),
      });
      activeSkillPath = snapshotRoot;
    }

    const status: AutoDreamStatus = validation.approved ? "approved" : "rejected";
    const manifest = {
      version: 1,
      status,
      runId,
      createdAt: new Date().toISOString(),
      inputFingerprint,
      inputs: {
        sourceSkillPath: resolve(options.sourceSkillPath),
        sourceFiles: sourceFiles.map(({ path, sha256: hash, bytes }) => ({ path, sha256: hash, bytes })),
        refinedPolicyPath: resolve(options.refinedPolicyPath),
        refinedPolicySha256: sha256(refinedPolicy),
      },
      candidate: { path: candidatePath, sha256: candidateSha256 },
      validation: { path: validationPath, ...validation },
      publication: { activeSkillPath: activeSkillPath ?? null, previousSkillPath: previousSkillPath ?? null },
      evidence: {
        consolidationEvents: synthesis.rawEventsPath,
        consolidationReadPaths: synthesis.readPaths,
        validationEvents: validationRun.rawEventsPath,
        validationReadPaths: validationRun.readPaths,
      },
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(runStatePath, `${JSON.stringify({ version: 1, status, runId, completedAt: new Date().toISOString(), manifestPath }, null, 2)}\n`, "utf8");
    return {
      runId,
      status,
      inputFingerprint,
      runDirectory,
      manifestPath,
      candidatePath,
      validationPath,
      ...(activeSkillPath ? { activeSkillPath } : {}),
      ...(previousSkillPath ? { previousSkillPath } : {}),
      reason: validation.reason,
    };
  } catch (error) {
    if (failedRunId && failedRunStatePath) {
      await writeFile(failedRunStatePath, `${JSON.stringify({
        version: 1,
        status: "failed",
        runId: failedRunId,
        failedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }, null, 2)}\n`, "utf8").catch(() => undefined);
    }
    throw error;
  } finally {
    await release();
  }
}
