import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AcontextClient } from "@acontext/acontext";
import {
  createAgentSession,
  DefaultPackageManager,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type SessionEntry,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import {
  applyDiscoveredAcontextEnvironment,
  parseEnvFile,
  resolveAcontextServiceConfig,
} from "./acontext-service-manager.js";
import { discoverGeneratedArtifacts, type ArtifactSelection } from "./artifact-discovery.js";
import { discoverCodexRollouts, type CodexRolloutCandidate } from "./codex-session-discovery.js";
import { writeCodexSessionProjection } from "./codex-session-projection.js";
import { loadConfig } from "./config.js";
import {
  runAutoDream,
  type AutoDreamOptions,
  type AutoDreamPhase,
  type AutoDreamResult,
} from "./auto-dream-runner.js";
import type { AcontextGateway } from "./contracts.js";
import { runProductionPipeline } from "./production-pipeline.js";
import { runFixedRefineWorkflow } from "./refine-workflow-agent.js";
import { bundledProviderExtensionPath } from "./agent-task-runner.js";
import { PRODUCTION_RULES } from "./production-rules.js";
import {
  PRODUCTION_RANGE_ENTRY_TYPE,
  restoreProductionRangeSelection,
  selectableEntries,
  sliceEntryRange,
  validateRange,
  type EntryRange,
  type ProductionRangeSelection,
} from "./session-range.js";
import {
  runAcontextRangeLearning,
  type AcontextLearningPhase,
} from "./web-acontext-learning.js";
import { findManagedSkill, listManagedSkills, readManagedSkillFile, writeManagedSkillFile } from "./web-skill-store.js";
import {ExpertDemoStore,DemoError} from './web-expert-demo.js';
import {ReasonSummaryCache,SUMMARY_PROMPT_VERSION,type SummaryRunner} from './expert-reason-summary.js';
import {HumanWorkflows,HumanWorkflowError} from './human-workflows.js';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");
const EXTENSION_ENTRY_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");
const MAX_BODY_BYTES = 1024 * 1024;
const FEEDBACK_ENTRY_TYPE = "pi-web-feedback-v1";

export interface WebDashboardOptions {
  expertSummary?: {cacheRoot:string;model:string;runner?:SummaryRunner};
  expertDemoRegistryPath?: string;
  expertFeedbackRoot?: string;
  cwd: string;
  host?: string;
  port?: number;
  sessionDir?: string;
  codexSessionRoot?: string;
  acontextClientFactory?: () => AcontextGateway;
  acontextSkillCacheDir?: string;
  autoDreamRunner?: (options: AutoDreamOptions) => Promise<AutoDreamResult>;
  refineWorkflowRunner?: WebRefineWorkflowRunner;
  harnessWorkflowRunner?: import('./human-workflows.js').HumanWorkflowOptions['harnessRunner'];
}

type ExistingRefineWorkflowOptions = Parameters<typeof runFixedRefineWorkflow>[0];
export type WebRefineWorkflowOptions = ExistingRefineWorkflowOptions;
export interface WebRefineWorkflowResult {
  runId: string;
  runDirectory: string;
  manifestPath: string;
  status: string;
  descriptionPath: string;
  draftPath: string;
  stageArtifacts: Record<string, string>;
}
export type WebRefineWorkflowRunner = (
  options: WebRefineWorkflowOptions,
) => Promise<WebRefineWorkflowResult>;

export interface WebDashboardHandle {
  url: string;
  close(): Promise<void>;
}

interface JsonRecord {
  [key: string]: unknown;
}

type AcontextTaskStatus = "queued" | AcontextLearningPhase | "completed" | "failed";

interface AcontextTaskRecord {
  id: string;
  sessionKey: string;
  status: AcontextTaskStatus;
  storedMessages: number;
  createdAt: string;
  updatedAt: string;
  result?: Awaited<ReturnType<typeof runAcontextRangeLearning>>;
  error?: string;
}

type AutoDreamTaskStatus = "queued" | AutoDreamPhase | "approved" | "rejected" | "skipped" | "failed";

interface AutoDreamTaskRecord {
  id: string;
  sessionKey: string;
  status: AutoDreamTaskStatus;
  sourceSkillPath: string;
  refinedPolicyPath: string;
  createdAt: string;
  updatedAt: string;
  result?: AutoDreamResult;
  error?: string;
}

interface RefineSignal {
  path: string;
  cwd: string;
  provider: string;
  model: string;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionKey(path: string): string {
  return createHash("sha256").update(resolve(path).toLowerCase()).digest("hex").slice(0, 20);
}

function stringsIn(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringsIn(item, output));
  else if (isRecord(value)) Object.values(value).forEach((item) => stringsIn(item, output));
  return output;
}

function compact(value: string, limit = 280): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function entryRole(entry: SessionEntry): string | undefined {
  return entry.type === "message" ? entry.message.role : undefined;
}

function entryText(entry: SessionEntry): string {
  if (entry.type === "message") {
    if (entry.message.role === "toolResult") {
      return compact(`${entry.message.toolName}: ${stringsIn(entry.message.content).join(" ")}`);
    }
    if (entry.message.role === "assistant" && Array.isArray(entry.message.content)) {
      return compact(entry.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(" "));
    }
    if ("content" in entry.message) return compact(stringsIn(entry.message.content).join(" "));
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") return compact(entry.summary);
  if (entry.type === "model_change") return `${entry.provider}/${entry.modelId}`;
  if (entry.type === "thinking_level_change") return `Thinking: ${entry.thinkingLevel}`;
  if (entry.type === "custom") return entry.customType;
  if (entry.type === "custom_message") return compact(stringsIn(entry.content).join(" "));
  if (entry.type === "label") return `${entry.label ?? "清除标签"} → ${entry.targetId}`;
  if (entry.type === "session_info") return entry.name ?? "";
  return entry.type;
}

function entryToolCalls(entry: SessionEntry): Array<{ id: string; name: string; arguments: string }> {
  if (entry.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) return [];
  return entry.message.content
    .filter((block) => block.type === "toolCall")
    .map((block) => ({
      id: block.id,
      name: block.name,
      arguments: compact(JSON.stringify(block.arguments), 320),
    }));
}

function restoreFeedback(branch: readonly SessionEntry[]): Record<string, "up" | "down"> {
  const feedback: Record<string, "up" | "down"> = {};
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== FEEDBACK_ENTRY_TYPE || !isRecord(entry.data)) continue;
    if (typeof entry.data.entryId !== "string") continue;
    if (entry.data.value === "up" || entry.data.value === "down") feedback[entry.data.entryId] = entry.data.value;
    else delete feedback[entry.data.entryId];
  }
  return feedback;
}

function configurePluginEnvironment(cwd: string): ReturnType<typeof resolveAcontextServiceConfig> {
  let config = resolveAcontextServiceConfig();
  if (!applyDiscoveredAcontextEnvironment(config)) {
    const candidates = [join(cwd, "acontext-local"), join(dirname(cwd), "acontext-local")];
    for (const home of candidates) {
      const candidate = resolveAcontextServiceConfig({ ...process.env, ACONTEXT_SIDECAR_HOME: home });
      if (!applyDiscoveredAcontextEnvironment(candidate)) continue;
      config = candidate;
      break;
    }
  }
  if (existsSync(config.envFile)) {
    const values = parseEnvFile(readFileSync(config.envFile, "utf8"));
    if (!process.env.DEEPSEEK_API_KEY && values.LLM_API_KEY?.trim()) process.env.DEEPSEEK_API_KEY = values.LLM_API_KEY.trim();
    if (!process.env.DEEPSEEK_BASE_URL && values.LLM_BASE_URL?.trim()) process.env.DEEPSEEK_BASE_URL = values.LLM_BASE_URL.trim();
  }
  return config;
}

function sessionSummary(info: SessionInfo): JsonRecord {
  return {
    key: sessionKey(info.path),
    id: info.id,
    name: info.name ?? (compact(info.firstMessage, 58) || "未命名会话"),
    cwd: info.cwd,
    path: info.path,
    created: info.created.toISOString(),
    modified: info.modified.toISOString(),
    messageCount: info.messageCount,
    firstMessage: compact(info.firstMessage, 160),
  };
}

function meaningfulBounds(branch: readonly SessionEntry[]): EntryRange {
  const messages = branch.filter((entry) => entry.type === "message");
  const first = messages[0] ?? branch[0];
  const last = messages.at(-1) ?? branch.at(-1);
  if (!first || !last) throw new HttpError(422, "该会话没有可选择的条目");
  return { startEntryId: first.id, endEntryId: last.id };
}

function findPreviousUserIndex(branch: readonly SessionEntry[], from: number): number {
  for (let index = from; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === "message" && entry.message.role === "user") return index;
  }
  return Math.max(0, from);
}

function findRefineEndIndex(branch: readonly SessionEntry[], artifacts: ArtifactSelection): number {
  const completionId = artifacts.gold.completionToolResultEntryId ?? artifacts.gold.toolResultEntryId;
  let end = completionId ? branch.findIndex((entry) => entry.id === completionId) : artifacts.gold.entryIndex;
  if (end < 0) end = artifacts.gold.entryIndex;
  for (let index = end + 1; index < branch.length; index += 1) {
    const entry = branch[index];
    if (entry?.type === "message" && entry.message.role === "user") break;
    if (entry?.type === "message") end = index;
  }
  return end;
}

export async function inferProductionRangeSelection(
  branch: readonly SessionEntry[],
  cwd: string,
): Promise<{ selection: ProductionRangeSelection; artifacts: ArtifactSelection | null; note: string }> {
  const acontext = meaningfulBounds(branch);
  try {
    const artifacts = await discoverGeneratedArtifacts(branch, cwd);
    const start = findPreviousUserIndex(branch, artifacts.baseline.entryIndex);
    const end = findRefineEndIndex(branch, artifacts);
    const startEntry = branch[start];
    const endEntry = branch[end];
    if (!startEntry || !endEntry) throw new Error("自动识别的区间端点不存在");
    return {
      selection: {
        version: 1,
        acontext,
        refine: { startEntryId: startEntry.id, endEntryId: endEntry.id },
        selectedAt: new Date().toISOString(),
      },
      artifacts,
      note: `已按 ${artifacts.candidates.length} 个生成文档证据识别 Refine 区间。`,
    };
  } catch (error) {
    return {
      selection: { version: 1, acontext, refine: acontext, selectedAt: new Date().toISOString() },
      artifacts: null,
      note: `未找到足够的生成文档证据，已回退到完整对话区间：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function parseRange(value: unknown, name: string): EntryRange {
  if (!isRecord(value) || typeof value.startEntryId !== "string" || typeof value.endEntryId !== "string") {
    throw new HttpError(400, `${name} 区间格式无效`);
  }
  return { startEntryId: value.startEntryId, endEntryId: value.endEntryId };
}

function parseSelection(value: unknown): ProductionRangeSelection {
  if (!isRecord(value)) throw new HttpError(400, "缺少区间选择");
  return {
    version: 1,
    acontext: parseRange(value.acontext, "Acontext"),
    refine: parseRange(value.refine, "Refine"),
    selectedAt: new Date().toISOString(),
  };
}

function persistSelection(manager: SessionManager, selection: ProductionRangeSelection): void {
  const branch = manager.getBranch();
  validateRange(branch, selection.acontext, "acontext");
  validateRange(branch, selection.refine, "refine");
  manager.appendCustomEntry(PRODUCTION_RANGE_ENTRY_TYPE, selection);
  manager.appendLabelChange(selection.acontext.startEntryId, "acontext-start");
  manager.appendLabelChange(selection.acontext.endEntryId, "acontext-end");
  manager.appendLabelChange(selection.refine.startEntryId, "refine-start");
  manager.appendLabelChange(selection.refine.endEntryId, "refine-end");
}

async function requestJson(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "请求内容过大");
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
    if (!isRecord(parsed)) throw new Error("body must be an object");
    return parsed;
  } catch {
    throw new HttpError(400, "请求 JSON 格式无效");
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function sendError(response: ServerResponse, error: unknown): void {
  const status = error instanceof HttpError || error instanceof DemoError || error instanceof HumanWorkflowError ? error.status : 500;
  const message = error instanceof Error ? error.message : String(error);
  sendJson(response, status, { error: message });
}

function mimeType(path: string): string {
  return ({
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
  } as Record<string, string>)[extname(path)] ?? "application/octet-stream";
}

async function sendStatic(response: ServerResponse, pathname: string): Promise<void> {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!new Set(["index.html", "styles.css", "app.js", "expert-workbench.js", "refine-flow.js", "human-workbench.js"]).has(requested)) {
    throw new HttpError(404, "页面不存在");
  }
  const body = await readFile(join(WEB_ROOT, requested));
  response.writeHead(200, {
    "Content-Type": mimeType(requested),
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  });
  response.end(body);
}

function packageVersion(path: string | undefined): Promise<string | undefined> {
  if (!path) return Promise.resolve(undefined);
  return readFile(join(path, "package.json"), "utf8")
    .then((content) => {
      const value = JSON.parse(content) as unknown;
      return isRecord(value) && typeof value.version === "string" ? value.version : undefined;
    })
    .catch(() => undefined);
}

async function createWebAgent(
  manager: SessionManager,
  provider?: string,
  modelId?: string,
  selectedSkill?: { name: string; directory: string },
): Promise<{ session: AgentSession; warning?: string }> {
  const cwd = manager.getCwd();
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [EXTENSION_ENTRY_PATH],
    ...(selectedSkill ? {
      additionalSkillPaths: [selectedSkill.directory],
      appendSystemPrompt: [`用户已为本轮明确选择 skill “${selectedSkill.name}”。必须先读取其 SKILL.md，再按其中指令完成用户请求。`],
    } : {}),
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create();
  const created = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    sessionManager: manager,
    resourceLoader,
    modelRuntime,
  });
  const requestedProvider = provider?.trim();
  const requestedModel = modelId?.trim();
  if (requestedProvider && requestedModel) {
    const requested = modelRuntime.getModel(requestedProvider, requestedModel);
    if (!requested) {
      created.session.dispose();
      throw new HttpError(422, `模型不可用：${requestedProvider}/${requestedModel}`);
    }
    await created.session.setModel(requested);
  } else if (!created.session.model) {
    const fallbackProvider = settingsManager.getDefaultProvider() ?? "deepseek";
    const fallbackModel = settingsManager.getDefaultModel() ?? "deepseek-v4-flash";
    const fallback = modelRuntime.getModel(fallbackProvider, fallbackModel);
    if (fallback) await created.session.setModel(fallback);
  }
  if (!created.session.model) {
    created.session.dispose();
    throw new HttpError(422, created.modelFallbackMessage ?? "没有可用模型，请先配置 Agent provider 凭据");
  }
  return { session: created.session, ...(created.modelFallbackMessage ? { warning: created.modelFallbackMessage } : {}) };
}

function writeStreamEvent(response: ServerResponse, value: unknown): void {
  if (!response.destroyed) response.write(`${JSON.stringify(value)}\n`);
}

function forwardAgentEvent(response: ServerResponse, event: AgentSessionEvent): void {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    writeStreamEvent(response, { type: "delta", delta: event.assistantMessageEvent.delta });
  } else if (event.type === "tool_execution_start") {
    writeStreamEvent(response, { type: "tool_start", id: event.toolCallId, name: event.toolName });
  } else if (event.type === "tool_execution_end") {
    writeStreamEvent(response, { type: "tool_end", id: event.toolCallId, name: event.toolName, isError: event.isError });
  } else if (event.type === "auto_retry_start") {
    writeStreamEvent(response, { type: "status", message: `请求重试 ${event.attempt}/${event.maxAttempts}` });
  }
}

function createDashboardServer(options: WebDashboardOptions): Server {
  const cwd = resolve(options.cwd);
  const humanWorkflows=new HumanWorkflows({cwd,root:join(cwd,'.refine-console','workflows'),...(options.refineWorkflowRunner?{refineRunner:options.refineWorkflowRunner}:{}),...(options.harnessWorkflowRunner?{harnessRunner:options.harnessWorkflowRunner}:{})});
  const expertDemo=new ExpertDemoStore({registryPath:options.expertDemoRegistryPath,feedbackRoot:options.expertFeedbackRoot??join(cwd,'.pi','expert-feedback')});
  const summaries=new ReasonSummaryCache({root:options.expertSummary?.cacheRoot??join(cwd,'.pi','expert-summary'),model:options.expertSummary?.model??'deepseek-v4-flash',runner:options.expertSummary?.runner});
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  configurePluginEnvironment(cwd);
  const sessionIndex = new Map<string, SessionInfo>();
  const pendingSessionInfo = new Map<string, SessionInfo>();
  const pendingSessionManagers = new Map<string, SessionManager>();
  const activeRuns = new Set<string>();
  const acontextTasks = new Map<string, AcontextTaskRecord>();
  const latestAcontextTaskBySession = new Map<string, string>();
  const autoDreamTasks = new Map<string, AutoDreamTaskRecord>();
  const latestAutoDreamTaskBySession = new Map<string, string>();
  const latestSkillBySession = new Map<string, string>();
  const latestRefineBySession = new Map<string, RefineSignal>();
  const activeAutoDreams = new Set<string>();
  const activeChats = new Set<string>();
  const codexRoot = resolve(options.codexSessionRoot ?? process.env.CODEX_SESSION_DIR?.trim() ?? join(homedir(), ".codex", "sessions"));
  const codexIndex = new Map<string, CodexRolloutCandidate>();

  const scheduleAutoDream = (key: string): AutoDreamTaskRecord | undefined => {
    const config = loadConfig();
    if (!config.autoDreamEnabled || activeAutoDreams.has(key)) {
      const existingId = latestAutoDreamTaskBySession.get(key);
      return existingId ? autoDreamTasks.get(existingId) : undefined;
    }
    const sourceSkillPath = latestSkillBySession.get(key);
    const refine = latestRefineBySession.get(key);
    if (!sourceSkillPath || !refine) return undefined;
    const now = new Date().toISOString();
    const task: AutoDreamTaskRecord = {
      id: randomUUID(),
      sessionKey: key,
      status: "queued",
      sourceSkillPath,
      refinedPolicyPath: refine.path,
      createdAt: now,
      updatedAt: now,
    };
    autoDreamTasks.set(task.id, task);
    latestAutoDreamTaskBySession.set(key, task.id);
    activeAutoDreams.add(key);
    const dreamRunner = options.autoDreamRunner ?? runAutoDream;
    void dreamRunner({
      cwd: refine.cwd,
      sourceSkillPath,
      refinedPolicyPath: refine.path,
      runRoot: process.env.AUTO_DREAM_RUN_ROOT?.trim()
        ? config.autoDreamRunRoot
        : resolve(refine.cwd, ".pi", "auto-dream"),
      publishRoot: config.autoDreamPublishRoot,
      provider: refine.provider,
      model: refine.model,
      timeoutMs: config.productionTimeoutMs,
      onProgress: (phase) => {
        task.status = phase;
        task.updatedAt = new Date().toISOString();
      },
    }).then((result) => {
      task.status = result.status;
      task.result = result;
      task.updatedAt = new Date().toISOString();
    }).catch((error: unknown) => {
      task.status = "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.updatedAt = new Date().toISOString();
    }).finally(() => activeAutoDreams.delete(key));
    return task;
  };

  const listSessions = async (): Promise<SessionInfo[]> => {
    const persisted = options.sessionDir
      ? await SessionManager.listAll(resolve(options.sessionDir))
      : await SessionManager.listAll();
    const persistedPaths = new Set(persisted.map((session) => resolve(session.path).toLowerCase()));
    const sessions = [
      ...persisted,
      ...[...pendingSessionInfo.values()].filter((session) => !persistedPaths.has(resolve(session.path).toLowerCase())),
    ];
    sessionIndex.clear();
    sessions.forEach((session) => sessionIndex.set(sessionKey(session.path), session));
    return sessions;
  };

  const findSession = async (key: string): Promise<SessionInfo> => {
    if (!sessionIndex.has(key)) await listSessions();
    const session = sessionIndex.get(key);
    if (!session) throw new HttpError(404, "会话不存在或已被移动");
    return session;
  };

  const listCodexSessions = async (): Promise<CodexRolloutCandidate[]> => {
    if (!existsSync(codexRoot)) return [];
    const sessions = await discoverCodexRollouts(codexRoot, cwd, 200);
    codexIndex.clear();
    sessions.forEach((session) => codexIndex.set(sessionKey(session.path), session));
    return sessions;
  };

  const findCodexSession = async (key: string): Promise<CodexRolloutCandidate> => {
    if (!codexIndex.has(key)) await listCodexSessions();
    const session = codexIndex.get(key);
    if (!session) throw new HttpError(404, "Codex 历史会话不存在或已被移动");
    return session;
  };

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      if(parts[0]==='api'&&parts[1]==='workflows') {
        if(!['127.0.0.1','localhost','[::1]'].includes(new URL(`http://${request.headers.host??''}`).hostname))throw new HttpError(403,'仅允许本机访问');
        if(request.headers.origin&&request.headers.origin!==`http://${request.headers.host}`)throw new HttpError(403,'跨来源工作流请求被拒绝');
        if(method==='GET'&&parts.length===2){sendJson(response,200,{tasks:humanWorkflows.list()});return;}
        if(method==='POST'&&parts.length===2){sendJson(response,201,{task:humanWorkflows.create(await requestJson(request))});return;}
        const id=parts[2];
        if(id&&method==='GET'&&parts.length===3){sendJson(response,200,{task:humanWorkflows.get(id)});return;}
        if(id&&method==='GET'&&parts[3]==='artifact'){sendJson(response,200,humanWorkflows.artifact(id,Number(url.searchParams.get('round')),url.searchParams.get('key')||''));return;}
        if(id&&method==='POST'&&parts.length===4){
          const body=await requestJson(request),action=parts[3];
          const task=action==='skill'?humanWorkflows.editSkill(id,body):action==='boundary'?humanWorkflows.boundary(id,body):action==='answer'?humanWorkflows.answer(id,body):action==='continue'?humanWorkflows.continue(id,body):action==='stop'?humanWorkflows.stop(id,body):null;
          if(!task)throw new HttpError(404,'操作不存在');sendJson(response,action==='continue'?202:200,{task});return;
        }
        throw new HttpError(404,'工作流接口不存在');
      }
      if(url.pathname.startsWith('/api/expert-demo')){
        if(!['127.0.0.1','localhost','[::1]'].includes(new URL(`http://${request.headers.host??''}`).hostname))throw new HttpError(403,'仅允许本机访问');
        if(method==='GET'&&url.pathname==='/api/expert-demo'){sendJson(response,200,await expertDemo.overview());return;}
        if(method==='GET'&&url.pathname==='/api/expert-demo/cases'){const view=await expertDemo.cases();const cases=await Promise.all(view.cases.map(async c=>{try{return{...c,summary:await summaries.status(await expertDemo.summaryInput(c.caseId))};}catch{return{...c,summary:{enabled:false,status:'blocked',cacheKey:'source-unavailable:'+c.caseId,promptVersion:SUMMARY_PROMPT_VERSION,model:options.expertSummary?.model??'deepseek-v4-flash',failureKind:'output-validation',message:'该案例来源暂不能安全投影为摘要；完整理由仍可查看。'}};}}));sendJson(response,200,{...view,cases});return;}
        if(method==='POST'&&parts.length===5&&parts[2]==='cases'&&parts[4]==='summary'){
          const origin=request.headers.origin;if(origin&&origin!==`http://${request.headers.host}`)throw new HttpError(403,'跨来源摘要请求被拒绝');
          sendJson(response,200,await summaries.request(await expertDemo.summaryInput(decodeURIComponent(parts[3]!))));return;
        }
        if(url.pathname==='/api/expert-demo/skill-feedback'){
          if(method==='GET'){sendJson(response,200,await expertDemo.feedback());return;}
          if(method==='POST'){
            const origin=request.headers.origin;
            if(origin&&origin!==`http://${request.headers.host}`)throw new HttpError(403,'跨来源反馈请求被拒绝');
            if(!request.headers['content-type']?.startsWith('application/json'))throw new HttpError(415,'需要 application/json');
            sendJson(response,201,await expertDemo.saveFeedback(await requestJson(request)));return;
          }
        }
        if(method==='GET'&&parts.length===4&&parts[2]==='artifacts'){sendJson(response,200,await expertDemo.artifact(decodeURIComponent(parts[3]!)));return;}
        throw new HttpError(404,'接口不存在');
      }

      if (!url.pathname.startsWith("/api/")) {
        if (method !== "GET") throw new HttpError(405, "不支持的请求方法");
        await sendStatic(response, url.pathname);
        return;
      }

      if (method === "GET" && url.pathname === "/api/status") {
        const config = loadConfig();
        let memory: JsonRecord = { configured: config.enabled, connected: false };
        if (config.apiKey) {
          try {
            const client = new AcontextClient({ apiKey: config.apiKey, ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}) });
            const pong = await client.ping();
            memory = { configured: true, connected: true, status: pong };
          } catch (error) {
            memory = { configured: true, connected: false, error: error instanceof Error ? error.message : String(error) };
          }
        }
        sendJson(response, 200, {
          cwd,
          memory,
          defaults: {
            provider: settingsManager.getDefaultProvider() ?? "deepseek",
            model: settingsManager.getDefaultModel() ?? "deepseek-v4-flash",
          },
        });
        return;
      }

      if (method === "GET" && parts[0] === "api" && parts[1] === "acontext-tasks" && parts[2]) {
        const task = acontextTasks.get(parts[2]);
        if (!task) throw new HttpError(404, "Acontext 后台任务不存在");
        sendJson(response, 200, { task });
        return;
      }

      if (method === "GET" && parts[0] === "api" && parts[1] === "auto-dream-tasks" && parts[2]) {
        const task = autoDreamTasks.get(parts[2]);
        if (!task) throw new HttpError(404, "Auto-Dream 后台任务不存在");
        sendJson(response, 200, { task });
        return;
      }

      if (method === "GET" && url.pathname === "/api/plugins") {
        const packages = packageManager.listConfiguredPackages();
        const enriched = await Promise.all(packages.map(async (item) => ({
          ...item,
          name: item.installedPath ? basename(item.installedPath) : item.source,
          version: await packageVersion(item.installedPath),
          installed: Boolean(item.installedPath),
        })));
        const global = settingsManager.getGlobalSettings();
        const project = settingsManager.getProjectSettings();
        sendJson(response, 200, {
          packages: enriched,
          localExtensions: [
            ...(global.extensions ?? []).map((path) => ({ path, scope: "user" })),
            ...(project.extensions ?? []).map((path) => ({ path, scope: "project" })),
          ],
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/skills") {
        const config = loadConfig();
        sendJson(response, 200, { root: config.skillCacheDir, skills: await listManagedSkills(config.skillCacheDir) });
        return;
      }

      if (parts[0] === "api" && parts[1] === "skills" && parts[2] && parts[3] === "file") {
        const config = loadConfig();
        const file = url.searchParams.get("path") ?? "SKILL.md";
        if (method === "GET") {
          sendJson(response, 200, await readManagedSkillFile(config.skillCacheDir, parts[2], file));
          return;
        }
        if (method === "PUT") {
          const body = await requestJson(request);
          if (typeof body.content !== "string") throw new HttpError(400, "Skill 文件内容无效");
          const expectedSha256 = typeof body.expectedSha256 === "string" ? body.expectedSha256 : "";
          sendJson(response, 200, await writeManagedSkillFile(config.skillCacheDir, parts[2], file, body.content, expectedSha256));
          return;
        }
      }

      if (method === "POST" && parts[0] === "api" && parts[1] === "plugins" && parts[2]) {
        const body = await requestJson(request);
        const source = typeof body.source === "string" ? body.source.trim() : "";
        const local = body.scope === "project";
        if (!source) throw new HttpError(400, "插件来源不能为空");
        if (parts[2] === "install") await packageManager.installAndPersist(source, { local });
        else if (parts[2] === "update") await packageManager.update(source);
        else if (parts[2] === "remove") await packageManager.removeAndPersist(source, { local });
        else throw new HttpError(404, "未知的插件操作");
        sendJson(response, 200, { ok: true });
        return;
      }

      if (method === "GET" && url.pathname === "/api/sessions") {
        const scope = url.searchParams.get("scope") ?? "project";
        const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
        const all = await listSessions();
        const filtered = all
          .filter((session) => scope === "all" || (Boolean(session.cwd) && resolve(session.cwd).toLowerCase() === cwd.toLowerCase()))
          .filter((session) => !query || `${session.name ?? ""} ${session.firstMessage} ${session.cwd} ${session.id}`.toLowerCase().includes(query))
          .slice(0, 200)
          .map(sessionSummary);
        sendJson(response, 200, { sessions: filtered, total: filtered.length, scope, cwd });
        return;
      }

      if (method === "GET" && url.pathname === "/api/codex-sessions") {
        const scope = url.searchParams.get("scope") ?? "project";
        const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
        const sessions = (await listCodexSessions())
          .filter((session) => scope === "all" || (session.cwd && resolve(session.cwd).toLowerCase() === cwd.toLowerCase()))
          .filter((session) => !query || `${session.title ?? ""} ${session.sessionId} ${session.cwd ?? ""} ${session.timestamp ?? ""}`.toLowerCase().includes(query))
          .map((session) => ({
            key: sessionKey(session.path),
            id: session.sessionId,
            name: session.title ?? `Codex ${session.timestamp ? new Date(session.timestamp).toLocaleString("zh-CN") : session.sessionId.slice(0, 8)}`,
            cwd: session.cwd ?? cwd,
            path: session.path,
            created: session.timestamp ?? new Date(session.modifiedAtMs).toISOString(),
            modified: new Date(session.modifiedAtMs).toISOString(),
            messageCount: 0,
            firstMessage: "点击后投影为 Agent 会话并打开",
            source: "codex",
          }));
        sendJson(response, 200, { sessions, total: sessions.length, root: codexRoot });
        return;
      }

      if (method === "POST" && parts[0] === "api" && parts[1] === "codex-sessions" && parts[2] && parts[3] === "project") {
        const source = await findCodexSession(parts[2]);
        const projectedId = `codex-${source.sessionId}`;
        const projectedName = source.title ?? `Codex 历史 · ${source.timestamp ? new Date(source.timestamp).toLocaleString("zh-CN") : source.sessionId}`;
        const existing = (await listSessions()).find((session) => session.id === projectedId);
        if (existing) {
          if (source.title && existing.name !== projectedName) {
            SessionManager.open(existing.path, dirname(existing.path)).appendSessionInfo(projectedName);
            const refreshed = (await listSessions()).find((session) => session.id === projectedId) ?? existing;
            sendJson(response, 200, { session: sessionSummary(refreshed), reused: true, titleUpdated: true });
            return;
          }
          sendJson(response, 200, { session: sessionSummary(existing), reused: true, titleUpdated: false });
          return;
        }
        const projectedCwd = source.cwd && existsSync(source.cwd) ? resolve(source.cwd) : cwd;
        const outputManager = SessionManager.create(projectedCwd, options.sessionDir ? resolve(options.sessionDir) : undefined);
        const outputPath = outputManager.getSessionFile();
        if (!outputPath) throw new HttpError(500, "无法创建 Agent session 投影路径");
        await writeCodexSessionProjection(source.path, outputPath, {
          cwd: projectedCwd,
          sessionId: projectedId,
          sessionName: projectedName,
        });
        const projected = (await listSessions()).find((session) => resolve(session.path).toLowerCase() === resolve(outputPath).toLowerCase());
        if (!projected) throw new HttpError(500, "Codex session 已投影，但 Agent 未能读取结果");
        sendJson(response, 201, { session: sessionSummary(projected), reused: false });
        return;
      }

      if (method === "POST" && url.pathname === "/api/sessions/new") {
        const manager = SessionManager.create(cwd, options.sessionDir ? resolve(options.sessionDir) : undefined);
        manager.appendSessionInfo("新会话");
        const path = manager.getSessionFile();
        if (!path) throw new HttpError(500, "新会话未创建持久化文件");
        const now = new Date();
        const created: SessionInfo = {
          path,
          id: manager.getSessionId(),
          cwd,
          created: now,
          modified: now,
          messageCount: 0,
          firstMessage: "",
          allMessagesText: "",
        };
        sessionIndex.set(sessionKey(path), created);
        pendingSessionInfo.set(sessionKey(path), created);
        pendingSessionManagers.set(sessionKey(path), manager);
        sendJson(response, 201, { session: sessionSummary(created) });
        return;
      }

      if (parts[0] === "api" && parts[1] === "sessions" && parts[2]) {
        const key = parts[2];
        const info = await findSession(key);
        const manager = pendingSessionManagers.get(key) ?? SessionManager.open(info.path, dirname(info.path));
        const branch = manager.getBranch();

        if (method === "GET" && parts.length === 3) {
          const inferred = branch.some((entry) => entry.type === "message")
            ? await inferProductionRangeSelection(branch, manager.getCwd())
            : null;
          const saved = restoreProductionRangeSelection(branch, PRODUCTION_RANGE_ENTRY_TYPE);
          sendJson(response, 200, {
            session: sessionSummary(info),
            entries: selectableEntries(branch).map((entry) => {
              const source = branch[entry.index]!;
              return {
                ...entry,
                type: source.type,
                role: entryRole(source),
                text: entryText(source),
                toolCalls: entryToolCalls(source),
              };
            }),
            selection: saved ?? inferred?.selection ?? null,
            selectionSource: saved ? "saved" : inferred ? "automatic" : "empty",
            feedback: restoreFeedback(branch),
            automatic: inferred ? {
              selection: inferred.selection,
              note: inferred.note,
              artifacts: inferred.artifacts ? {
                count: inferred.artifacts.candidates.length,
                baseline: basename(inferred.artifacts.baseline.path),
                gold: basename(inferred.artifacts.gold.path),
              } : null,
            } : null,
          });
          return;
        }

        if (method === "GET" && parts[3] === "acontext") {
          const taskId = latestAcontextTaskBySession.get(key);
          sendJson(response, 200, { task: taskId ? acontextTasks.get(taskId) ?? null : null });
          return;
        }

        if (method === "GET" && parts[3] === "dream") {
          const taskId = latestAutoDreamTaskBySession.get(key);
          sendJson(response, 200, { task: taskId ? autoDreamTasks.get(taskId) ?? null : null });
          return;
        }

        if (method === "POST" && parts[3] === "feedback") {
          const body = await requestJson(request);
          const entryId = typeof body.entryId === "string" ? body.entryId : "";
          const value = body.value === "up" || body.value === "down" ? body.value : null;
          if (!branch.some((entry) => entry.id === entryId && entry.type === "message")) {
            throw new HttpError(400, "反馈目标消息不存在");
          }
          manager.appendCustomEntry(FEEDBACK_ENTRY_TYPE, { entryId, value, recordedAt: new Date().toISOString() });
          sendJson(response, 200, { ok: true });
          return;
        }

        if (method === "POST" && parts[3] === "chat") {
          if (activeChats.has(key)) throw new HttpError(409, "该会话正在生成回复");
          const body = await requestJson(request);
          const message = typeof body.message === "string" ? body.message.trim() : "";
          if (!message) throw new HttpError(400, "消息不能为空");
          const provider = typeof body.provider === "string" ? body.provider : undefined;
          const model = typeof body.model === "string" ? body.model : undefined;
          const config = loadConfig();
          const skillKey = typeof body.skillKey === "string" ? body.skillKey : "";
          const selectedSkill = skillKey ? await findManagedSkill(config.skillCacheDir, skillKey) : undefined;
          response.writeHead(200, {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          });
          activeChats.add(key);
          let agent: AgentSession | undefined;
          let unsubscribe: (() => void) | undefined;
          let completed = false;
          response.once("close", () => {
            if (!completed && agent) void agent.abort();
          });
          try {
            const created = await createWebAgent(manager, provider, model, selectedSkill);
            agent = created.session;
            writeStreamEvent(response, {
              type: "start",
              sessionId: agent.sessionId,
              model: agent.model ? `${agent.model.provider}/${agent.model.id}` : null,
              warning: created.warning,
            });
            unsubscribe = agent.subscribe((event) => forwardAgentEvent(response, event));
            await agent.prompt(message);
            completed = true;
            if (existsSync(info.path)) {
              pendingSessionInfo.delete(key);
              pendingSessionManagers.delete(key);
            }
            writeStreamEvent(response, { type: "complete" });
          } catch (error) {
            writeStreamEvent(response, { type: "error", error: error instanceof Error ? error.message : String(error) });
          } finally {
            unsubscribe?.();
            agent?.dispose();
            activeChats.delete(key);
            response.end();
          }
          return;
        }

        if (method === "POST" && parts[3] === "ranges") {
          const body = await requestJson(request);
          const selection = parseSelection(body.selection);
          persistSelection(manager, selection);
          sendJson(response, 200, { ok: true, selection });
          return;
        }

        if (method === "POST" && parts[3] === "run") {
          if (activeRuns.has(key)) throw new HttpError(409, "该会话已有蒸馏任务正在运行");
          const body = await requestJson(request);
          const selection = parseSelection(body.selection);
          const provider = typeof body.provider === "string" && body.provider.trim() ? body.provider.trim() : "deepseek";
          const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "deepseek-v4-flash";
          validateRange(branch, selection.acontext, "acontext");
          validateRange(branch, selection.refine, "refine");
          const config = loadConfig();
          if (!config.apiKey) throw new HttpError(422, "Acontext 尚未配置，无法开始蒸馏");
          const client: AcontextGateway = new AcontextClient({
            apiKey: config.apiKey,
            ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
          });
          activeRuns.add(key);
          try {
            persistSelection(manager, selection);
            const result = await runProductionPipeline({
              client,
              piSessionId: manager.getSessionId(),
              piSessionFile: info.path,
              cwd: manager.getCwd(),
              branch: manager.getBranch(),
              selection,
              runRoot: process.env.ACONTEXT_PRODUCTION_RUN_ROOT?.trim()
                ? config.productionRunRoot
                : resolve(manager.getCwd(), ".pi", "acontext-production"),
              provider,
              model,
              captureToolResults: false,
              maxToolResultChars: config.maxToolResultChars,
              timeoutMs: config.productionTimeoutMs,
            });
            latestSkillBySession.set(key, result.skillPath);
            latestRefineBySession.set(key, { path: result.refinedPolicyPath, cwd: manager.getCwd(), provider, model });
            const dreamTask = scheduleAutoDream(key);
            sendJson(response, 200, { ok: true, result, dreamTask: dreamTask ?? null });
          } finally {
            activeRuns.delete(key);
          }
          return;
        }

        if (method === "POST" && parts[3] === "acontext") {
          if (activeRuns.has(key)) throw new HttpError(409, "该会话已有学习任务正在运行");
          const body = await requestJson(request);
          const range = parseRange(body.range, "Acontext");
          validateRange(branch, range, "acontext");
          const config = loadConfig();
          if (!config.apiKey && !options.acontextClientFactory) throw new HttpError(422, "Acontext 尚未配置，无法开始学习");
          const client: AcontextGateway = options.acontextClientFactory?.() ?? new AcontextClient({
            apiKey: config.apiKey!,
            ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
          });
          const now = new Date().toISOString();
          const task: AcontextTaskRecord = {
            id: randomUUID(),
            sessionKey: key,
            status: "queued",
            storedMessages: 0,
            createdAt: now,
            updatedAt: now,
          };
          activeRuns.add(key);
          acontextTasks.set(task.id, task);
          latestAcontextTaskBySession.set(key, task.id);
          const previous = restoreProductionRangeSelection(branch, PRODUCTION_RANGE_ENTRY_TYPE);
          persistSelection(manager, {
            version: 1,
            acontext: range,
            refine: previous?.refine ?? meaningfulBounds(branch),
            selectedAt: new Date().toISOString(),
          });
          void runAcontextRangeLearning({
              client,
              branch: manager.getBranch(),
              range,
              piSessionId: manager.getSessionId(),
              piSessionFile: info.path,
              cwd: manager.getCwd(),
              skillCacheDir: options.acontextSkillCacheDir ?? config.skillCacheDir,
              maxToolResultChars: config.maxToolResultChars,
              timeoutMs: config.productionTimeoutMs,
              onProgress: (progress) => {
                task.status = progress.phase;
                task.storedMessages = progress.storedMessages;
                task.updatedAt = new Date().toISOString();
              },
            })
            .then((result) => {
              task.status = "completed";
              task.storedMessages = result.storedMessages;
              task.result = result;
              task.updatedAt = new Date().toISOString();
              latestSkillBySession.set(key, result.skillPath);
              scheduleAutoDream(key);
            })
            .catch((error: unknown) => {
              task.status = "failed";
              task.error = error instanceof Error ? error.message : String(error);
              task.updatedAt = new Date().toISOString();
            })
            .finally(() => activeRuns.delete(key));
          sendJson(response, 202, { ok: true, task });
          return;
        }

        if (method === "POST" && parts[3] === "refine") {
          if (activeRuns.has(key)) throw new HttpError(409, "该会话已有提炼任务正在运行");
          const body = await requestJson(request);
          const range = parseRange(body.range, "Refine");
          validateRange(branch, range, "refine");
          const provider = typeof body.provider === "string" && body.provider.trim() ? body.provider.trim() : "deepseek";
          const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "deepseek-v4-flash";
          const goldInput = typeof body.goldPath === "string" ? body.goldPath.trim() : "";
          const activeSkillInput = typeof body.activeSkillPath === "string" ? body.activeSkillPath.trim() : "";
          if (!goldInput || !activeSkillInput) {
            throw new HttpError(422, "Refine Workflow 需要显式提供 goldPath 与 activeSkillPath");
          }
          const goldPath = resolve(manager.getCwd(), goldInput);
          const activeSkillPath = resolve(manager.getCwd(), activeSkillInput);
          const config = loadConfig();
          activeRuns.add(key);
          try {
            const previous = restoreProductionRangeSelection(branch, PRODUCTION_RANGE_ENTRY_TYPE);
            persistSelection(manager, {
              version: 1,
              acontext: previous?.acontext ?? meaningfulBounds(branch),
              refine: range,
              selectedAt: new Date().toISOString(),
            });
            const runRoot = process.env.REFINE_RUN_ROOT?.trim()
              ? resolve(process.env.REFINE_RUN_ROOT.trim())
              : resolve(manager.getCwd(), ".pi", "refine-workflow");
            const inputDirectory = resolve(runRoot, "frontend-inputs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
            const requirementsPath = join(inputDirectory, "selected-refine-trace.json");
            const rulesPath = join(inputDirectory, "production-rules.json");
            const selectedEntries = sliceEntryRange(manager.getBranch(), range, "refine");
            await mkdir(inputDirectory, { recursive: true });
            await Promise.all([
              writeFile(requirementsPath, `${JSON.stringify({
                schemaVersion: "1.0",
                source: "pi-web-refine-range",
                piSessionId: manager.getSessionId(),
                range,
                entries: selectedEntries,
              }, null, 2)}\n`, "utf8"),
              writeFile(rulesPath, `${JSON.stringify(PRODUCTION_RULES, null, 2)}\n`, "utf8"),
            ]);
            const task=humanWorkflows.create({kind:'refine',title:'会话文稿 Skill 优化',provider,model,requirementsPath,goldPath,activeSkillPath});
            sendJson(response, 202, { ok: true, task, dreamTask: null });
          } finally {
            activeRuns.delete(key);
          }
          return;
        }


        if (method === "POST" && parts[3] === "dream") {
          const task = scheduleAutoDream(key);
          if (!task) throw new HttpError(409, "Auto-Dream 需要同一会话已完成的 Skill 抽取和 Refine 结果");
          sendJson(response, 202, { ok: true, task });
          return;
        }
      }

      throw new HttpError(404, "接口不存在");
    } catch (error) {
      sendError(response, error);
    }
  };

  return createServer((request, response) => { void handler(request, response); });
}

export async function startWebDashboard(options: WebDashboardOptions): Promise<WebDashboardHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4318;
  const server = createDashboardServer(options);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Web dashboard did not bind to a TCP address");
  return {
    url: `http://${host}:${address.port}`,
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    }),
  };
}
