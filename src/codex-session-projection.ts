import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { FileEntry, SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import { redactText, truncateText } from "./redaction.js";

export const CODEX_SESSION_PROJECTION_VERSION = 1;
export const CODEX_PROJECTION_CUSTOM_TYPE = "acontext.codex-session-projection";

interface CodexRecord {
  timestamp?: unknown;
  type?: unknown;
  payload?: Record<string, unknown>;
}

export interface CodexProjectionOptions {
  cwd?: string;
  sessionId?: string;
  sessionName?: string;
  startTimestamp?: string;
  cutoffTimestamp?: string;
  maxToolResultChars?: number;
}

export type CodexProjectionKind = "user" | "assistant_final" | "tool_call" | "tool_result";

export interface CodexProjectionMapping {
  sourceLine: number;
  sourceRecordType: string;
  sourcePayloadType: string;
  sourceItemId?: string;
  sourceCallId?: string;
  piEntryId: string;
  kind: CodexProjectionKind;
}

export interface CodexProjectionManifest {
  projectionVersion: number;
  source: "codex-rollout";
  sourceSessionId: string;
  sourceRolloutPath: string;
  sourceRolloutSha256: string;
  projectedSessionId: string;
  omittedSensitiveRecordTypes: string[];
  mappings: CodexProjectionMapping[];
  counts: Record<CodexProjectionKind, number>;
}

export interface CodexSessionProjection {
  header: SessionHeader;
  entries: SessionEntry[];
  manifest: CodexProjectionManifest;
  jsonl: string;
}

export interface WrittenCodexSessionProjection extends CodexSessionProjection {
  outputPath: string;
}

interface ParsedRecord {
  line: number;
  record: CodexRecord;
}

interface ProjectionEntry {
  entry: SessionEntry;
  mapping?: CodexProjectionMapping;
}

const OMITTED_SENSITIVE_RECORD_TYPES = [
  "compacted",
  "event_msg/agent_reasoning",
  "response_item/reasoning",
] as const;

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function validTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function parseBoundary(label: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${label} timestamp: ${value}`);
  return parsed;
}

function parseRecords(jsonl: string): ParsedRecord[] {
  const parsed: ParsedRecord[] = [];
  for (const [index, line] of jsonl.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as CodexRecord;
      if (record && typeof record === "object") parsed.push({ line: index + 1, record });
    } catch {
      // Codex rollouts are append-only. Ignore an incomplete trailing line or other malformed record.
    }
  }
  return parsed;
}

function textFromBlocks(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object")
    .filter((block) => block.type === "output_text" || block.type === "text")
    .map((block) => stringValue(block.text))
    .filter((part): part is string => part !== undefined)
    .join("\n")
    .trim();
  return text || undefined;
}

function cleanConversationText(value: string): { text: string; redactions: number } {
  const cleaned = value
    .replace(/\s*<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>\s*/g, "\n")
    .replace(/^\s*## My request for Codex:\s*/i, "")
    .trim();
  const redacted = redactText(cleaned);
  return { text: redacted.text, redactions: redacted.replacements };
}

function redactJsonValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value).text;
  if (Array.isArray(value)) return value.map(redactJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactJsonValue(item)]));
  }
  return value;
}

function jsonArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return redactJsonValue(value) as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return redactJsonValue(parsed) as Record<string, unknown>;
      }
    } catch {
      // Custom Codex tools often use a free-form input rather than JSON.
    }
    return { input: redactText(value).text };
  }
  return { input: value ?? null };
}

function resultText(value: unknown, maxChars: number | undefined): { text: string; truncated: boolean; redactions: number } {
  const serialized = typeof value === "string" ? value : JSON.stringify(value ?? null);
  const truncated = maxChars === undefined ? { text: serialized, truncated: false } : truncateText(serialized, maxChars);
  const redacted = redactText(truncated.text);
  return { text: redacted.text, truncated: truncated.truncated, redactions: redacted.replacements };
}

function sanitizeSessionId(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  if (!sanitized) throw new Error("Projected session id is empty after sanitization");
  return sanitized;
}

function deterministicEntryId(seed: string, used: Set<string>): string {
  let attempt = 0;
  while (true) {
    const id = createHash("sha256").update(`${seed}\0${attempt}`).digest("hex").slice(0, 8);
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
    attempt += 1;
  }
}

function sourceIdentity(records: ParsedRecord[]): { sourceSessionId?: string; cwd?: string; timestamp?: string } {
  for (const { record } of records) {
    if (record.type !== "session_meta" || !record.payload) continue;
    const sourceSessionId = stringValue(record.payload.id) ?? stringValue(record.payload.session_id);
    const cwd = stringValue(record.payload.cwd);
    const timestamp = validTimestamp(record.timestamp) ?? validTimestamp(record.payload.timestamp);
    return {
      ...(sourceSessionId ? { sourceSessionId } : {}),
      ...(cwd ? { cwd } : {}),
      ...(timestamp ? { timestamp } : {}),
    };
  }
  return {};
}

function withinWindow(record: CodexRecord, start: number | undefined, cutoff: number | undefined): boolean {
  if (start === undefined && cutoff === undefined) return true;
  const timestamp = validTimestamp(record.timestamp);
  if (!timestamp) return false;
  const time = Date.parse(timestamp);
  return (start === undefined || time >= start) && (cutoff === undefined || time <= cutoff);
}

function isToolFailure(payload: Record<string, unknown>): boolean {
  if (payload.is_error === true || payload.isError === true) return true;
  const output = payload.output;
  return Boolean(output && typeof output === "object" && (output as Record<string, unknown>).isError === true);
}

/**
 * Convert one raw Codex rollout into a real Agent v3 JSONL session.
 *
 * Only explicit user messages, final answers and tool evidence cross the boundary.
 * Reasoning, compaction summaries, developer messages and commentary are deliberately
 * ignored so hidden chain-of-thought cannot enter the projected session.
 */
export function projectCodexRollout(
  jsonl: string,
  sourceRolloutPath: string,
  options: CodexProjectionOptions = {},
): CodexSessionProjection {
  const records = parseRecords(jsonl);
  if (records.length === 0) throw new Error("Codex rollout contains no valid JSON records");

  const maxToolResultChars = options.maxToolResultChars;
  if (maxToolResultChars !== undefined && (!Number.isInteger(maxToolResultChars) || maxToolResultChars <= 0)) {
    throw new Error("maxToolResultChars must be a positive integer");
  }
  const start = parseBoundary("start", options.startTimestamp);
  const cutoff = parseBoundary("cutoff", options.cutoffTimestamp);
  if (start !== undefined && cutoff !== undefined && start > cutoff) {
    throw new Error("startTimestamp must not be later than cutoffTimestamp");
  }

  const absoluteSourcePath = resolve(sourceRolloutPath);
  const sourceRolloutSha256 = createHash("sha256").update(jsonl).digest("hex");
  const identity = sourceIdentity(records);
  const sourceSessionId = identity.sourceSessionId ?? `unknown-${sourceRolloutSha256.slice(0, 16)}`;
  const sessionId = sanitizeSessionId(options.sessionId ?? `codex-${sourceSessionId}`);
  const headerTimestamp = identity.timestamp ?? records.map(({ record }) => validTimestamp(record.timestamp)).find(Boolean) ?? new Date(0).toISOString();
  const header: SessionHeader = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: headerTimestamp,
    cwd: resolve(options.cwd ?? identity.cwd ?? process.cwd()),
  };

  const usedIds = new Set<string>();
  const projected: ProjectionEntry[] = [];
  let parentId: string | null = null;
  const mappings: CodexProjectionMapping[] = [];
  const counts: Record<CodexProjectionKind, number> = { user: 0, assistant_final: 0, tool_call: 0, tool_result: 0 };
  const toolNames = new Map<string, string>();
  const completedToolCallIds = new Set(
    records
      .filter(({ record }) => withinWindow(record, start, cutoff))
      .filter(({ record }) => record.type === "response_item")
      .filter(({ record }) => record.payload?.type === "function_call_output" || record.payload?.type === "custom_tool_call_output")
      .map(({ record }) => stringValue(record.payload?.call_id))
      .filter((callId): callId is string => Boolean(callId)),
  );
  const hasEventUserMessages = records.some(
    ({ record }) => record.type === "event_msg" && record.payload?.type === "user_message" && withinWindow(record, start, cutoff),
  );

  const append = (
    source: ParsedRecord | undefined,
    kind: CodexProjectionKind | undefined,
    makeEntry: (id: string, parent: string | null) => SessionEntry,
  ): string => {
    const seed = source ? `${sourceRolloutSha256}:${source.line}:${kind ?? "metadata"}` : `${sourceRolloutSha256}:virtual:${projected.length}`;
    const id = deterministicEntryId(seed, usedIds);
    const entry = makeEntry(id, parentId);
    const sourceItemId = source ? stringValue(source.record.payload?.id) : undefined;
    const sourceCallId = source ? stringValue(source.record.payload?.call_id) : undefined;
    const mapping: CodexProjectionMapping | undefined = source && kind ? {
      sourceLine: source.line,
      sourceRecordType: String(source.record.type ?? ""),
      sourcePayloadType: String(source.record.payload?.type ?? ""),
      ...(sourceItemId ? { sourceItemId } : {}),
      ...(sourceCallId ? { sourceCallId } : {}),
      piEntryId: id,
      kind,
    } : undefined;
    projected.push({ entry, ...(mapping ? { mapping } : {}) });
    if (mapping) {
      mappings.push(mapping);
      counts[kind!] += 1;
    }
    parentId = id;
    return id;
  };

  append(undefined, undefined, (id, parent) => ({
    type: "session_info",
    id,
    parentId: parent,
    timestamp: headerTimestamp,
    name: options.sessionName ?? `Codex ${sourceSessionId}`,
  }));

  let lastFinalText: string | undefined;
  for (const parsed of records) {
    const { record } = parsed;
    if (!withinWindow(record, start, cutoff) || !record.payload) continue;
    const payload = record.payload;
    const payloadType = stringValue(payload.type);
    const timestamp = validTimestamp(record.timestamp) ?? headerTimestamp;
    const timestampMs = Date.parse(timestamp);

    if (record.type === "event_msg" && payloadType === "user_message") {
      const original = stringValue(payload.message);
      if (!original) continue;
      const clean = cleanConversationText(original);
      if (!clean.text) continue;
      append(parsed, "user", (id, parent) => ({
        type: "message",
        id,
        parentId: parent,
        timestamp,
        message: { role: "user", content: clean.text, timestamp: timestampMs },
      }));
      lastFinalText = undefined;
      continue;
    }

    if (!hasEventUserMessages && record.type === "response_item" && payloadType === "message" && payload.role === "user") {
      const original = textFromBlocks(payload.content);
      if (!original) continue;
      const clean = cleanConversationText(original);
      if (!clean.text) continue;
      append(parsed, "user", (id, parent) => ({
        type: "message",
        id,
        parentId: parent,
        timestamp,
        message: { role: "user", content: clean.text, timestamp: timestampMs },
      }));
      lastFinalText = undefined;
      continue;
    }

    const eventFinal = record.type === "event_msg" && payloadType === "agent_message" && payload.phase === "final_answer";
    const responseFinal = record.type === "response_item" && payloadType === "message" && payload.role === "assistant" && payload.phase === "final_answer";
    if (eventFinal || responseFinal) {
      const original = eventFinal ? stringValue(payload.message) : textFromBlocks(payload.content);
      if (!original) continue;
      const clean = cleanConversationText(original);
      if (!clean.text || clean.text === lastFinalText) continue;
      append(parsed, "assistant_final", (id, parent) => ({
        type: "message",
        id,
        parentId: parent,
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "text", text: clean.text }],
          api: "openai-responses",
          provider: "openai",
          model: "codex-projection",
          usage: ZERO_USAGE,
          stopReason: "stop",
          timestamp: timestampMs,
        },
      }));
      lastFinalText = clean.text;
      continue;
    }

    if (record.type === "response_item" && (payloadType === "function_call" || payloadType === "custom_tool_call")) {
      const callId = stringValue(payload.call_id) ?? stringValue(payload.id);
      const name = stringValue(payload.name);
      if (!callId || !name || !completedToolCallIds.has(callId)) continue;
      toolNames.set(callId, name);
      const rawArguments = payloadType === "function_call" ? payload.arguments : payload.input;
      append(parsed, "tool_call", (id, parent) => ({
        type: "message",
        id,
        parentId: parent,
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: callId, name, arguments: jsonArguments(rawArguments) }],
          api: "openai-responses",
          provider: "openai",
          model: "codex-projection",
          usage: ZERO_USAGE,
          stopReason: "toolUse",
          timestamp: timestampMs,
        },
      }));
      continue;
    }

    if (record.type === "response_item" && (payloadType === "function_call_output" || payloadType === "custom_tool_call_output")) {
      const callId = stringValue(payload.call_id);
      if (!callId || !toolNames.has(callId)) continue;
      const name = toolNames.get(callId) ?? "codex_tool";
      const result = resultText(payload.output, maxToolResultChars);
      append(parsed, "tool_result", (id, parent) => ({
        type: "message",
        id,
        parentId: parent,
        timestamp,
        message: {
          role: "toolResult",
          toolCallId: callId,
          toolName: name,
          content: [{ type: "text", text: result.text }],
          details: {
            codexProjection: {
              projectionVersion: CODEX_SESSION_PROJECTION_VERSION,
              sourceLine: parsed.line,
              sourceItemId: stringValue(payload.id) ?? null,
              truncated: result.truncated,
              redactionCount: result.redactions,
            },
          },
          isError: isToolFailure(payload),
          timestamp: timestampMs,
        },
      }));
    }
  }

  const manifest: CodexProjectionManifest = {
    projectionVersion: CODEX_SESSION_PROJECTION_VERSION,
    source: "codex-rollout",
    sourceSessionId,
    sourceRolloutPath: absoluteSourcePath,
    sourceRolloutSha256,
    projectedSessionId: sessionId,
    omittedSensitiveRecordTypes: [...OMITTED_SENSITIVE_RECORD_TYPES],
    mappings,
    counts,
  };
  append(undefined, undefined, (id, parent) => ({
    type: "custom",
    id,
    parentId: parent,
    timestamp: records.map(({ record }) => validTimestamp(record.timestamp)).filter((value): value is string => Boolean(value)).at(-1) ?? headerTimestamp,
    customType: CODEX_PROJECTION_CUSTOM_TYPE,
    data: manifest,
  }));

  const entries = projected.map(({ entry }) => entry);
  const jsonlOutput = [...([header] as FileEntry[]), ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  return { header, entries, manifest, jsonl: jsonlOutput };
}

/** Write a fresh projection. Existing targets are rejected so a run cannot silently reuse a cache. */
export async function writeCodexSessionProjection(
  sourceRolloutPath: string,
  outputPath: string,
  options: CodexProjectionOptions = {},
): Promise<WrittenCodexSessionProjection> {
  const absoluteSourcePath = resolve(sourceRolloutPath);
  const absoluteOutputPath = resolve(outputPath);
  const jsonl = await readFile(absoluteSourcePath, "utf8");
  const projection = projectCodexRollout(jsonl, absoluteSourcePath, options);
  await mkdir(dirname(absoluteOutputPath), { recursive: true });
  await writeFile(absoluteOutputPath, projection.jsonl, { encoding: "utf8", flag: "wx" });
  return { ...projection, outputPath: absoluteOutputPath };
}
