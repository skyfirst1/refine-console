import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { humanWaitPending } from './human-workflow-channel.js';
import {
  encodePhoenixAgentTaskContext,
  PHOENIX_AGENT_TASK_ENV,
  phoenixTracingRequested,
  type PhoenixAgentTaskContext,
} from "./phoenix-tracing.js";

export interface AgentTaskOptions {
  /** User reply time is excluded from the execution timeout. */
  humanControlDirectory?: string;
  cwd: string;
  provider: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  rawEventsPath: string;
  timeoutMs: number;
  extensionPaths?: string[];
  /** Omit to keep the historical isolated-task default of disabled model thinking. */
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Default read-only tools; none also disables extension tools in the runtime. */
  tools?: "read" | "none" | "trace" | "replay" | "card-replay" | "card-replay-compact" | "card-replay-append" | "boundary-review" | "boundary-comparison" | "boundary-batch";
  /** Local-only evidence routing; never interpolated into model messages. */
  traceDisclosure?: { registryPath: string; registrySha256: string };
  /** Safe telemetry metadata. Prompts and generated content must never be placed here. */
  trace?: PhoenixAgentTaskContext;
  /** Per-call provider output ceiling. Omit to retain the provider's normal environment/default. */
  maxOutputTokens?: number;
  /** Omit to preserve the historical ephemeral --no-session behavior. */
  session?: {
    id: string;
    dir: string;
    name?: string;
    /** Refuse to silently create a fresh session for a contract correction. */
    requireExisting?: boolean;
    expectedAssistantSha256?: string;
    /** Exact persisted-session binding for a pre-provider stop with no assistant text. */
    expectedSessionSha256?: string;
  };
}

export interface AgentTaskResult {
  finalText: string;
  stopReason?: string;
  rawEventsPath: string;
  readPaths: string[];
  toolNames: string[];
  usage: AgentTaskUsage;
  sessionId?: string;
  sessionDir?: string;
  eventProvenance?: AgentEventProvenance;
  inputDelivery?: { mode: "inline-no-tools-v1"; promptSha256: string; promptBytes: number; verifiedInPublicUserMessage: true };
}

export interface AgentEventProvenance { format: "public-jsonl"; sha256: string; bytes: number; records: number; sourceRecords: number; sourceBytes: number; omittedPrivate: { records: number; bytes: number }; redacted: { records: number; bytes: number } }

export interface AgentTaskUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
}

/**
 * Makes an external-reference requirement explicit for every isolated Agent
 * attempt. Context Pack URIs are provenance, not invitations to read files.
 */
export function requiredReadInstruction(paths: readonly string[] = []): string {
  const required = [...new Set(paths.map((entry) => entry.trim()).filter(Boolean))];
  if (required.length === 0) return "";
  return [
    "Before producing any task output, use the read tool to read every required reference file below, including on retries and review/editor attempts:",
    ...required.map((entry) => `- ${entry}`),
    "These are the only external files you may open with read. Do not read Context Pack evidence URIs or artifact paths; their authorized contents are already embedded in this prompt.",
    "If any required read fails, stop and report the failure instead of producing an artifact.",
  ].join("\n");
}

interface JsonEvent {
  type?: unknown;
  message?: unknown;
}

interface MessageBlock {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  arguments?: unknown;
}

function toolPath(argumentsValue: unknown): string | undefined {
  if (!argumentsValue || typeof argumentsValue !== "object") return undefined;
  const record = argumentsValue as Record<string, unknown>;
  for (const key of ["path", "filePath", "file_path"]) {
    if (typeof record[key] === "string") return resolve(record[key]);
  }
  return undefined;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseAgentTaskEvents(rawEvents: string): Pick<AgentTaskResult, "finalText" | "stopReason" | "readPaths" | "toolNames" | "usage"> {
  const replies: string[] = [];
  const readPaths = new Set<string>();
  const toolNames: string[] = [];
  let stopReason: string | undefined;
  const usage: AgentTaskUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 };
  for (const [index, line] of rawEvents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let event: JsonEvent;
    try {
      event = JSON.parse(line) as JsonEvent;
    } catch (error) {
      throw new Error(`Agent JSONL parse failed at record ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (event.type !== "message_end" || !event.message || typeof event.message !== "object") continue;
    const message = event.message as Record<string, unknown>;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    if (typeof message.stopReason === "string") stopReason = message.stopReason;
    if (message.usage && typeof message.usage === "object") {
      const messageUsage = message.usage as Record<string, unknown>;
      usage.input += numeric(messageUsage.input);
      usage.output += numeric(messageUsage.output);
      usage.cacheRead += numeric(messageUsage.cacheRead);
      usage.cacheWrite += numeric(messageUsage.cacheWrite);
      usage.totalTokens += numeric(messageUsage.totalTokens);
      if (messageUsage.cost && typeof messageUsage.cost === "object") {
        usage.costUsd += numeric((messageUsage.cost as Record<string, unknown>).total);
      }
    }
    for (const block of message.content as MessageBlock[]) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        replies.push(block.text.trim());
      }
      if (block.type === "toolCall" && typeof block.name === "string") {
        toolNames.push(block.name);
        if (block.name === "read") {
          const path = toolPath(block.arguments);
          if (path) readPaths.add(normalize(path).toLowerCase());
        }
      }
    }
  }
  return { finalText: replies.at(-1) ?? "", ...(stopReason ? { stopReason } : {}), readPaths: [...readPaths], toolNames, usage };
}

export function runtimeCliPath(): string {
  // The package intentionally exports only its public API. Resolve that entry,
  // then use the package's documented bin sibling instead of requesting an
  // unexported package subpath.
  return resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
}

export function bundledProviderExtensionPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "pipeline-provider.ts");
}

export function bundledPhoenixEventExtensionPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "phoenix-event-extension.ts");
}

export function agentTaskExtensionPaths(
  options: Pick<AgentTaskOptions, "extensionPaths" | "trace" | "traceDisclosure">,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const paths = [...(options.extensionPaths ?? [])];
  if (options.traceDisclosure) paths.push(resolve(dirname(fileURLToPath(import.meta.url)), "harness-trace-reader.ts"));
  if (options.trace && phoenixTracingRequested(env)) paths.push(bundledPhoenixEventExtensionPath());
  return [...new Set(paths.map((path) => resolve(path)))];
}

/**
 * Disable every implicitly discovered Agent resource class. Explicit `-e`
 * extensions remain enabled by Agent when `--no-extensions` is present, which
 * lets an isolated task retain only its provider and Phoenix event extension.
 */
export function agentTaskResourceIsolationArgs(): string[] {
  return [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--append-system-prompt", "",
  ];
}

function privateType(value: unknown) { return /thinking|reasoning|private|hidden/i.test(String(value ?? "")); }
function redactString(raw: string) { let value = raw; let changed = false; const replace = (pattern: RegExp, replacement: string) => { const next = value.replace(pattern, replacement); if (next !== value) changed = true; value = next; }; replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]"); replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_KEY]"); replace(/"(api[_-]?key|x-api-key|authorization|password|secret|token|access[_-]?token|refresh[_-]?token)"\s*:\s*"[^"]*"/gi, '"$1":"[REDACTED]"'); return { value, changed }; }
function publicValue(value: unknown, key = ""): { value: unknown; privateOmitted: boolean; redacted: boolean } {
  if (value === null || typeof value === "number" || typeof value === "boolean") return { value, privateOmitted: false, redacted: false };
  if (typeof value === "string") { if (privateType(key)) return { value: undefined, privateOmitted: true, redacted: false }; const redacted = redactString(value); return { value: redacted.value, privateOmitted: false, redacted: redacted.changed }; }
  if (Array.isArray(value)) { const output: unknown[] = []; let privateOmitted = false; let redacted = false; for (const item of value) { if (item && typeof item === "object" && !Array.isArray(item) && privateType((item as Record<string, unknown>).type)) { privateOmitted = true; continue; } const projected = publicValue(item); privateOmitted ||= projected.privateOmitted; redacted ||= projected.redacted; if (projected.value !== undefined) output.push(projected.value); } return { value: output, privateOmitted, redacted }; }
  if (!value || typeof value !== "object") return { value: undefined, privateOmitted: false, redacted: false };
  const record = value as Record<string, unknown>; if (privateType(record.type)) return { value: undefined, privateOmitted: true, redacted: false };
  const output: Record<string, unknown> = {}; let privateOmitted = false; let redacted = false;
  for (const [childKey, child] of Object.entries(record)) { if (privateType(childKey)) { privateOmitted = true; continue; } if (/^(?:api[_-]?key|x-api-key|authorization|password|secret|token|access[_-]?token|refresh[_-]?token)$/i.test(childKey)) { output[childKey] = "[REDACTED]"; redacted = true; continue; } const projected = publicValue(child, childKey); privateOmitted ||= projected.privateOmitted; redacted ||= projected.redacted; if (projected.value !== undefined) output[childKey] = projected.value; }
  return { value: output, privateOmitted, redacted };
}
export function projectPublicAgentEvents(rawEvents: string): { jsonl: string; provenance: AgentEventProvenance } {
  const output: string[] = []; let sourceRecords = 0; let omittedPrivateRecords = 0; let omittedPrivateBytes = 0; let redactedRecords = 0; let redactedBytes = 0;
  for (const [index, line] of rawEvents.split(/\r?\n/).entries()) { if (!line.trim()) continue; sourceRecords += 1; let event: unknown; try { event = JSON.parse(line); } catch (error) { throw new Error(`Agent JSONL parse failed at record ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); } const projected = publicValue(event); if (projected.privateOmitted) { omittedPrivateRecords += 1; omittedPrivateBytes += Buffer.byteLength(line) + 1; } if (projected.value === undefined || !projected.value || typeof projected.value !== "object") continue; const serialized = JSON.stringify(projected.value); if (projected.redacted) { redactedRecords += 1; redactedBytes += Buffer.byteLength(line) + 1; } output.push(serialized); }
  const jsonl = output.length ? `${output.join("\n")}\n` : ""; return { jsonl, provenance: { format: "public-jsonl", sha256: createHash("sha256").update(jsonl).digest("hex"), bytes: Buffer.byteLength(jsonl), records: output.length, sourceRecords, sourceBytes: Buffer.byteLength(rawEvents), omittedPrivate: { records: omittedPrivateRecords, bytes: omittedPrivateBytes }, redacted: { records: redactedRecords, bytes: redactedBytes } } };
}
export function agentEventProvenance(publicEvents: string): NonNullable<AgentTaskResult["eventProvenance"]> {
  return { format: "public-jsonl", sha256: createHash("sha256").update(publicEvents).digest("hex"), bytes: Buffer.byteLength(publicEvents), records: publicEvents.split(/\r?\n/).filter((line) => line.trim()).length, sourceRecords: publicEvents.split(/\r?\n/).filter((line) => line.trim()).length, sourceBytes: Buffer.byteLength(publicEvents), omittedPrivate: { records: 0, bytes: 0 }, redacted: { records: 0, bytes: 0 } };
}
export async function readAgentEventProvenance(path: string): Promise<NonNullable<AgentTaskResult["eventProvenance"]> | undefined> {
  try {
    const raw = await readFile(path, "utf8"); const saved = JSON.parse(await readFile(`${path}.provenance.json`, "utf8")) as Partial<AgentEventProvenance>;
    if (saved.format === "public-jsonl" && saved.sha256 === createHash("sha256").update(raw).digest("hex") && saved.bytes === Buffer.byteLength(raw) && typeof saved.records === "number" && typeof saved.sourceRecords === "number" && typeof saved.sourceBytes === "number" && typeof saved.omittedPrivate?.records === "number" && typeof saved.omittedPrivate.bytes === "number" && typeof saved.redacted?.records === "number" && typeof saved.redacted.bytes === "number") return saved as AgentEventProvenance;
  } catch { /* absent, malformed, or legacy provenance is intentionally not synthesized */ }
  return undefined;
}

export function agentTaskThinkingLevel(options: Pick<AgentTaskOptions, "thinking">): NonNullable<AgentTaskOptions["thinking"]> {
  return options.thinking ?? "off";
}

export function agentTaskMaxOutputTokens(options: Pick<AgentTaskOptions, "maxOutputTokens">): number | undefined {
  const value = options.maxOutputTokens;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function agentTaskToolArgs(options: Pick<AgentTaskOptions, "tools" | "humanControlDirectory">): string[] {
  if (options.tools === "boundary-batch") return ["--tools", "read_case,read_evidence,ask_boundary,finish_review,append_aligner,append_matcher"+(options.humanControlDirectory?',ask_user':'')];
  if (options.tools === "boundary-comparison") return ["--tools", "ask_boundary,finish_review,read_evidence"];
  if (options.tools === "boundary-review") return ["--tools", "ask_boundary,finish_review,read_source"];
  return options.tools === "none" ? ["--no-tools"] : ["--tools", options.tools === "card-replay-append" ? "expert_card_append" : options.tools === "card-replay-compact" ? "expert_card_read,expert_card_update,expert_card_no_change,expert_evidence" : options.tools === "card-replay" ? "expert_card_copy,expert_trial,expert_evidence" : options.tools === "trace" ? "trace_read" : options.tools === "replay" ? "expert_replay" : "read"];
}

export function verifyInlineAgentTaskDelivery(rawEvents: string, prompt: string): NonNullable<AgentTaskResult["inputDelivery"]> {
  const events = rawEvents.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  const delivered = events.some((event) => event.type === "message_end" && event.message?.role === "user" &&
    Array.isArray(event.message.content) && event.message.content.some((block: { type?: string; text?: string }) => block.type === "text" && block.text?.includes(prompt)));
  if (!delivered) throw new Error("Inline task prompt was not fully present in a public user message");
  if (events.some((event) => event.type === "tool_execution_start" || event.type === "tool_execution_end") || parseAgentTaskEvents(rawEvents).toolNames.length) throw new Error("Tool-disabled task emitted tool calls");
  return { mode: "inline-no-tools-v1", promptSha256: createHash("sha256").update(prompt).digest("hex"), promptBytes: Buffer.byteLength(prompt), verifiedInPublicUserMessage: true };
}

export async function existingAgentTaskSessionPath(session: NonNullable<AgentTaskOptions["session"]>): Promise<string> {
  const matches: string[] = [];
  for (const name of await readdir(session.dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = resolve(session.dir, name);
    const raw = await readFile(path, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    let entries: Array<Record<string, any>>;
    try { entries = lines.map(line => JSON.parse(line)); } catch { continue; }
    const assistant = entries.filter(entry => entry.type === "message" && entry.message?.role === "assistant").at(-1);
    const lastText = Array.isArray(assistant?.message?.content) ? assistant.message.content.filter((block: any) => block.type === "text" && typeof block.text === "string" && block.text.trim()).at(-1)?.text.trim() : undefined;
    const exactSession = session.expectedSessionSha256 && createHash("sha256").update(raw).digest("hex") === session.expectedSessionSha256;
    const assistantMatches = typeof lastText === "string" && (!session.expectedAssistantSha256 || createHash("sha256").update(lastText).digest("hex") === session.expectedAssistantSha256);
    if (entries[0]?.type === "session" && entries[0]?.id === session.id && (session.expectedSessionSha256 ? exactSession && (!session.expectedAssistantSha256 || assistantMatches) : assistantMatches)) matches.push(path);
  }
  if (matches.length !== 1) throw new Error("Structure correction requires exactly one persisted session with prior assistant output");
  return matches[0]!;
}

/** Conservative UTF-16 upper bound including Windows quoting, executable and NUL. */
export function agentTaskCommandLineBound(args: readonly string[]): number {
  return [process.execPath, ...args].reduce((sum, arg) => sum + 2 * arg.length + 3, 1);
}
export async function agentTaskPromptTransportArgs(prefix: readonly string[], options: Pick<AgentTaskOptions, "systemPrompt" | "prompt" | "rawEventsPath">): Promise<string[]> {
  let system = options.systemPrompt;
  let user = options.prompt;
  const userFile = resolve(`${options.rawEventsPath}.prompt.md`);
  const systemFile = resolve(`${options.rawEventsPath}.system-prompt.md`);
  const attachUser = async () => { await writeFile(userFile, options.prompt, "utf8"); user = `@${userFile}`; };
  if (options.prompt.length > 16_000) await attachUser(); // Preserve existing large-user delivery.
  const tail = () => ["--system-prompt", system, user];
  if (agentTaskCommandLineBound([...prefix, ...tail()]) > 30_000) {
    // Agent resolvePromptInput reads an existing path verbatim in the system role.
    await writeFile(systemFile, options.systemPrompt, "utf8"); system = systemFile;
  }
  if (agentTaskCommandLineBound([...prefix, ...tail()]) > 30_000 && user === options.prompt) await attachUser();
  if (agentTaskCommandLineBound([...prefix, ...tail()]) > 30_000) throw new Error("Agent command arguments exceed safe transport budget after prompt file delivery");
  return tail();
}

export async function runAgentTask(options: AgentTaskOptions): Promise<AgentTaskResult> {
  const args = [
    runtimeCliPath(),
    "--offline",
    ...agentTaskResourceIsolationArgs(),
    "--mode", "json",
    "--print",
    ...agentTaskToolArgs(options),
  ];
  if (options.session) {
    if (options.session.requireExisting) args.push("--session", await existingAgentTaskSessionPath(options.session), "--session-dir", options.session.dir);
    else args.push("--session-id", options.session.id, "--session-dir", options.session.dir);
    if (options.session.name) args.push("--name", options.session.name);
  } else {
    args.push("--no-session");
  }
  for (const extensionPath of agentTaskExtensionPaths(options)) args.push("-e", extensionPath);
  args.push("--provider", options.provider, "--model", options.model, "--thinking", agentTaskThinkingLevel(options));
  args.push(...await agentTaskPromptTransportArgs(args, options));

  await writeFile(options.rawEventsPath, "", "utf8");
  const captured = await new Promise<{ rawEvents: string; eventProvenance: AgentEventProvenance }>((resolveRun, reject) => {
    const maxOutputTokens = agentTaskMaxOutputTokens(options);
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.traceDisclosure ? { HARNESS_TRACE_REGISTRY: options.traceDisclosure.registryPath, HARNESS_TRACE_REGISTRY_HASH: options.traceDisclosure.registrySha256 } : { HARNESS_TRACE_REGISTRY: "", HARNESS_TRACE_REGISTRY_HASH: "" }),
        ...(options.trace ? { [PHOENIX_AGENT_TASK_ENV]: encodePhoenixAgentTaskContext(options.trace) } : {}),
        ...(maxOutputTokens ? { PIPELINE_MAX_TOKENS: String(maxOutputTokens) } : {}),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = async (error?: Error) => {
      if (settled) return; settled = true;
      let projected: ReturnType<typeof projectPublicAgentEvents>; try { projected = projectPublicAgentEvents(stdout); await writeFile(options.rawEventsPath, projected.jsonl, "utf8"); await writeFile(`${options.rawEventsPath}.provenance.json`, `${JSON.stringify(projected.provenance, null, 2)}\n`, "utf8"); }
      catch (writeError) { reject(writeError); return; }
      if (error) reject(error); else resolveRun({ rawEvents: stdout, eventProvenance: projected.provenance });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => { void finish(error); });
    let remainingMs = options.timeoutMs, lastTick = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      let waiting = false;
      try { waiting = Boolean(options.humanControlDirectory && humanWaitPending(options.humanControlDirectory)); } catch { /* Invalid control data does not extend execution. */ }
      if (!waiting) remainingMs -= now - lastTick;
      lastTick = now;
      if (remainingMs <= 0) { timedOut = true; child.kill(); }
    }, Math.min(500, options.timeoutMs));
    child.on("close", (code) => {
      clearInterval(timer);
      if (timedOut) void finish(new Error(`Agent task exceeded ${options.timeoutMs}ms`));
      else if (code === 0) void finish();
      else void finish(new Error(`Agent task failed with code ${code}: ${stderr.trim()}`));
    });
  });
  const parsed = parseAgentTaskEvents(captured.rawEvents);
  const inputDelivery = options.tools === "none" ? verifyInlineAgentTaskDelivery(await readFile(options.rawEventsPath, "utf8"), options.prompt) : undefined;
  if (inputDelivery) await writeFile(`${options.rawEventsPath}.input-delivery.json`, `${JSON.stringify(inputDelivery, null, 2)}\n`, "utf8");
  if (!parsed.finalText) throw new Error(`Agent task emitted no final answer; evidence: ${options.rawEventsPath}`);
  return {
    ...parsed,
    rawEventsPath: options.rawEventsPath,
    eventProvenance: captured.eventProvenance,
    ...(inputDelivery ? { inputDelivery } : {}),
    ...(options.session ? { sessionId: options.session.id, sessionDir: options.session.dir } : {}),
  };
}
