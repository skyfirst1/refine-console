import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { RefineTraceIntegrityReport } from "./refine-trace-integrity.js";
export const PUBLIC_TRACE_NORMALIZATION_VERSION = "execution-scoped-tool-call-result-v2";

export interface PublicTraceRecord {
  stage: string; attempt: number; status: string; kind: string; text: string;
  invocationId: string; toolCallId?: string;
  sources: Array<{ eventRef: string; eventType: string; metadata: Record<string, unknown> }>;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const stringify = (value: unknown) => JSON.stringify(value) ?? "null";
const sanitize = (raw: string) => raw.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
  .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_KEY]")
  .replace(/"(api[_-]?key|x-api-key|authorization|password|secret|token|access[_-]?token|refresh[_-]?token)"\s*:\s*"[^"]*"/gi, '"$1":"[REDACTED]"');

/** Input must already have passed the public Trace integrity gate. No text-based cross-call deduplication. */
export async function normalizePublicTraceRecords(rows: RefineTraceIntegrityReport["completenessMatrix"], sanitizeText: (text: string) => string = sanitize): Promise<PublicTraceRecord[]> {
  const records: PublicTraceRecord[] = [];
  for (const row of rows) {
    if (!row.eventsPath) continue;
    const raw = await readFile(row.eventsPath, "utf8");
    const digest = row.eventsSha256 ?? createHash("sha256").update(raw).digest("hex");
    const executions = new Map<string, number>();
    const activeExecutions = new Set<string>();
    const pairs = new Map<string, PublicTraceRecord[]>();
    const lines = raw.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      const event = object(JSON.parse(line)); const type = String(event.type ?? "unknown");
      const ref = `event:${digest.slice(0, 16)}:L${index + 1}`;
      const add = (kind: string, text: string, metadata: Record<string, unknown> = {}, callId?: string, contentIdentity?: string, executionNumber?: number) => {
        const source = { eventRef: ref, eventType: type, metadata: JSON.parse(sanitizeText(stringify(metadata))) as Record<string, unknown> };
        // Pair only opposite representations, once each, within one actual execution.
        const key = callId && contentIdentity !== undefined ? stringify([callId, executionNumber ?? executions.get(callId) ?? 0, kind, contentIdentity]) : null;
        const previous = key ? pairs.get(key)?.find((record) => record.sources.length === 1 && record.sources[0]!.eventType !== type) : undefined;
        if (previous) { previous.sources.push(source); return; }
        const record: PublicTraceRecord = { stage: row.stage, attempt: row.attempt, status: row.status, kind, text: sanitizeText(text), invocationId: row.invocationId, ...(callId ? { toolCallId: callId } : {}), sources: [source] };
        records.push(record);
        if (key) pairs.set(key, [...(pairs.get(key) ?? []), record]);
      };
      if (type === "tool_execution_start") {
        const id = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
        if (id) { executions.set(id, (executions.get(id) ?? 0) + 1); activeExecutions.add(id); }
        const { args, arguments: argumentsValue, ...metadata } = event;
        add(`tool_call:${String(event.toolName ?? "unknown")}`, stringify(args ?? argumentsValue ?? null), metadata, id, stringify(args ?? argumentsValue ?? null));
      }
      if (type === "tool_execution_end") {
        const result = object(event.result); const content = Object.hasOwn(result, "content") ? result.content : event.result ?? null;
        const { result: ignored, ...eventMetadata } = event; const { content: ignoredContent, ...resultMetadata } = result;
        const id = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
        add(`tool_result:${event.isError === true ? "error" : "completed"}`, stringify(content), { ...eventMetadata, resultMetadata }, id, stringify(content));
        if (id) activeExecutions.delete(id);
      }
      if (type === "message_end") {
        const message = object(event.message); const role = String(message.role ?? "");
        const blocks = Array.isArray(message.content) ? message.content.map(object) : [];
        const text = blocks.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
        if ((role === "user" || role === "assistant") && text.trim()) add(role === "user" ? "task_input" : `assistant_${String(message.stopReason ?? "unknown")}`, text);
        for (const block of blocks) if (block.type === "toolCall") {
          const { arguments: args, ...metadata } = block;
          const id = typeof block.id === "string" ? block.id : undefined;
          const executionNumber = id ? (executions.get(id) ?? 0) + (activeExecutions.has(id) ? 0 : 1) : undefined;
          add(`tool_call:${String(block.name ?? "unknown")}`, stringify(args ?? null), metadata, id, stringify(args ?? null), executionNumber);
        }
        if (role === "toolResult") {
          const { content, ...messageMetadata } = message; const { message: ignored, ...eventMetadata } = event;
          add(`tool_result:${message.isError === true ? "error" : "completed"}`, stringify(content ?? null), { ...eventMetadata, messageMetadata }, typeof message.toolCallId === "string" ? message.toolCallId : undefined, stringify(content ?? null));
        }
      }
    }
    if (row.errorObservation) records.push({ stage: row.stage, attempt: row.attempt, status: row.status, kind: "manifest_error", text: sanitizeText(row.errorObservation.message), invocationId: row.invocationId, sources: [{ eventRef: `manifest:${row.invocationId}`, eventType: "manifest_error", metadata: {} }] });
  }
  return records;
}
