import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { normalizeDocumentToMarkdown } from "./document-normalizer.js";
import { redactText } from "./redaction.js";
import type { StoredMessage } from "./contracts.js";

interface JsonRecord {
  timestamp?: unknown;
  type?: unknown;
  payload?: Record<string, unknown>;
}

export interface CodexImportOptions {
  startTimestamp?: string;
  cutoffTimestamp?: string;
  contextFiles?: string[];
  artifactFiles?: string[];
  maxFileChars?: number;
}

export interface ImportedFile {
  path: string;
  label: string;
  role: "user" | "assistant";
  contentSha256: string;
  characters: number;
}

export interface CodexTrainingSnapshot {
  version: 1;
  sourceSessionId: string;
  sourceRolloutPath: string;
  sourceRolloutSha256: string;
  trainingContentSha256: string;
  startTimestamp?: string;
  cutoffTimestamp?: string;
  messages: StoredMessage[];
  files: ImportedFile[];
}

function asText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return undefined;
}

export function extractCodexMessages(
  jsonl: string,
  sourceSessionId: string,
  options: Pick<CodexImportOptions, "startTimestamp" | "cutoffTimestamp"> = {},
): StoredMessage[] {
  const messages: StoredMessage[] = [];
  const seen = new Set<string>();
  const start = options.startTimestamp ? Date.parse(options.startTimestamp) : undefined;
  const cutoff = options.cutoffTimestamp ? Date.parse(options.cutoffTimestamp) : undefined;
  if (options.startTimestamp && !Number.isFinite(start)) {
    throw new Error(`Invalid start timestamp: ${options.startTimestamp}`);
  }
    if (options.cutoffTimestamp && !Number.isFinite(cutoff)) {
    throw new Error(`Invalid cutoff timestamp: ${options.cutoffTimestamp}`);
  }

  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: JsonRecord;
    try {
      record = JSON.parse(line) as JsonRecord;
    } catch {
      continue;
    }
    if (start !== undefined) {
      const timestamp = asText(record.timestamp);
      if (!timestamp || Date.parse(timestamp) < start) continue;
    }
    if (cutoff !== undefined) {
      const timestamp = asText(record.timestamp);
      if (timestamp && Date.parse(timestamp) > cutoff) continue;
    }
    if (record.type !== "event_msg" || !record.payload) continue;

    const payloadType = record.payload.type;
    let role: "user" | "assistant" | undefined;
    if (payloadType === "user_message") role = "user";
    if (payloadType === "agent_message" && record.payload.phase === "final_answer") role = "assistant";
    if (!role) continue;

    const original = asText(record.payload.message)
      ?.replace(/\s*<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>\s*/g, "\n")
      .replace(/^\s*## My request for Codex:\s*/i, "")
      .trim();
    if (!original?.trim()) continue;
    const redacted = redactText(original);
    const hash = createHash("sha256").update(`${role}\0${redacted.text}`).digest("hex");
    if (seen.has(hash)) continue;
    seen.add(hash);

    messages.push({
      blob: { role, content: redacted.text },
      meta: {
        source: "codex",
        source_session_id: sourceSessionId,
        source_timestamp: asText(record.timestamp),
        content_sha256: hash,
        redaction_count: redacted.replacements,
      },
    });
  }

  return messages;
}

async function readFileMessage(
  path: string,
  role: "user" | "assistant",
  sourceSessionId: string,
  maxFileChars: number,
): Promise<{ message: StoredMessage; file: ImportedFile }> {
  const absolutePath = resolve(path);
  const info = await stat(absolutePath);
  if (!info.isFile()) throw new Error(`Training input is not a file: ${absolutePath}`);
  const original = (await normalizeDocumentToMarkdown(absolutePath)).markdown;
  if (original.length > maxFileChars) {
    throw new Error(`Training input exceeds ${maxFileChars} characters: ${absolutePath}`);
  }

  const redacted = redactText(original);
  const label = basename(absolutePath);
  const contentSha256 = createHash("sha256").update(redacted.text).digest("hex");
  const heading = role === "user" ? "Training context file" : "Final delivered artifact";
  const content = `[${heading}: ${label}]\n\n${redacted.text}`;

  return {
    message: {
      blob: { role, content },
      meta: {
        source: role === "user" ? "codex_training_context" : "codex_artifact",
        source_session_id: sourceSessionId,
        source_path: absolutePath,
        content_sha256: contentSha256,
        redaction_count: redacted.replacements,
      },
    },
    file: {
      path: absolutePath,
      label,
      role,
      contentSha256,
      characters: redacted.text.length,
    },
  };
}

export async function buildCodexTrainingSnapshot(
  path: string,
  sourceSessionId: string,
  options: CodexImportOptions = {},
): Promise<CodexTrainingSnapshot> {
  const absolutePath = resolve(path);
  const jsonl = await readFile(absolutePath, "utf8");
  const messages = extractCodexMessages(jsonl, sourceSessionId, options);
  const files: ImportedFile[] = [];
  const maxFileChars = options.maxFileChars ?? 200_000;
  if (!Number.isInteger(maxFileChars) || maxFileChars <= 0) {
    throw new Error("maxFileChars must be a positive integer");
  }

  const contextMessages: StoredMessage[] = [];
  for (const contextPath of options.contextFiles ?? []) {
    const loaded = await readFileMessage(contextPath, "user", sourceSessionId, maxFileChars);
    contextMessages.push(loaded.message);
    files.push(loaded.file);
  }
  const firstAssistant = messages.findIndex((message) => message.blob.role === "assistant");
  messages.splice(firstAssistant < 0 ? messages.length : firstAssistant, 0, ...contextMessages);

  for (const artifactPath of options.artifactFiles ?? []) {
    const loaded = await readFileMessage(artifactPath, "assistant", sourceSessionId, maxFileChars);
    messages.push(loaded.message);
    files.push(loaded.file);
  }

  return {
    version: 1,
    sourceSessionId,
    sourceRolloutPath: absolutePath,
    sourceRolloutSha256: createHash("sha256").update(jsonl).digest("hex"),
    trainingContentSha256: createHash("sha256").update(JSON.stringify(messages)).digest("hex"),
    ...(options.startTimestamp ? { startTimestamp: options.startTimestamp } : {}),
    ...(options.cutoffTimestamp ? { cutoffTimestamp: options.cutoffTimestamp } : {}),
    messages,
    files,
  };
}

export async function readCodexMessages(
  path: string,
  sourceSessionId: string,
  options: CodexImportOptions = {},
): Promise<StoredMessage[]> {
  return (await buildCodexTrainingSnapshot(path, sourceSessionId, options)).messages;
}
