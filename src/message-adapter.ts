import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { StoredMessage } from "./contracts.js";
import { redactText, truncateText } from "./redaction.js";

export interface AdapterOptions {
  captureToolResults: boolean;
  captureToolCalls?: boolean;
  maxToolResultChars: number;
  sourceSessionId: string;
  sourceSessionFile?: string;
}

interface ContentBlock {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

function contentBlocks(value: unknown): ContentBlock[] {
  return Array.isArray(value) ? value.filter((item): item is ContentBlock => Boolean(item) && typeof item === "object") : [];
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  return contentBlocks(value)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

function commonMeta(entry: SessionEntry, options: AdapterOptions, redactions: number): Record<string, unknown> {
  return {
    source: "pi",
    source_session_id: options.sourceSessionId,
    ...(options.sourceSessionFile ? { source_session_file: options.sourceSessionFile } : {}),
    source_entry_id: entry.id,
    source_timestamp: entry.timestamp,
    content_sha256: createHash("sha256").update(JSON.stringify(entry)).digest("hex"),
    redaction_count: redactions,
  };
}

export function adaptSessionEntry(entry: SessionEntry, options: AdapterOptions): StoredMessage | undefined {
  if (entry.type !== "message") return undefined;

  const message = entry.message;
  if (message.role === "user") {
    const redacted = redactText(textFromContent(message.content));
    if (!redacted.text.trim()) return undefined;
    return {
      blob: { role: "user", content: redacted.text },
      meta: commonMeta(entry, options, redacted.replacements),
    };
  }

  if (message.role === "assistant") {
    const blocks = contentBlocks(message.content);
    const redacted = redactText(textFromContent(blocks));
    const toolCalls = options.captureToolCalls === false ? [] : blocks
      .filter(
        (block) =>
          block.type === "toolCall" &&
          typeof block.id === "string" &&
          typeof block.name === "string" &&
          block.arguments !== undefined,
      )
      .map((block) => ({
        id: block.id as string,
        type: "function",
        function: {
          name: block.name as string,
          arguments: JSON.stringify(block.arguments),
        },
      }));

    if (!redacted.text.trim() && toolCalls.length === 0) return undefined;
    return {
      blob: {
        role: "assistant",
        content: redacted.text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      meta: commonMeta(entry, options, redacted.replacements),
    };
  }

  if (message.role === "toolResult" && options.captureToolResults) {
    const original = textFromContent(message.content);
    const truncated = truncateText(original, options.maxToolResultChars);
    const redacted = redactText(truncated.text);
    return {
      blob: {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: redacted.text,
      },
      meta: {
        ...commonMeta(entry, options, redacted.replacements),
        tool_name: message.toolName,
        is_error: message.isError,
        truncated: truncated.truncated,
      },
    };
  }

  return undefined;
}
