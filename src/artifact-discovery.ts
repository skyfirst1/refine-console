import { stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { PRODUCTION_RULES } from "./production-rules.js";

export type ArtifactEvidenceKind = "user" | "assistant-delivery" | "tool-call" | "tool-result" | "session-entry";

export interface ArtifactCandidate {
  path: string;
  entryId: string;
  entryIndex: number;
  evidenceKind: ArtifactEvidenceKind;
  toolName?: string;
  toolCallId?: string;
  initialToolResultEntryId?: string;
  toolResultEntryId?: string;
  completionToolCallId?: string;
  completionToolResultEntryId?: string;
  asyncCellId?: string;
  score: number;
  modifiedAtMs: number;
}

interface ToolCompletionEvidence {
  toolResultEntryId: string;
  initialToolResultEntryId: string;
  completionToolCallId?: string;
  completionToolResultEntryId?: string;
  asyncCellId?: string;
}

export interface ArtifactSelection {
  baseline: ArtifactCandidate;
  gold: ArtifactCandidate;
  candidates: ArtifactCandidate[];
}

const WINDOWS_DOCUMENT_PATH = /[A-Za-z]:[\\/][^\r\n"'<>|?*]*?\.(?:docx|pdf|md|markdown)\b/gi;
const FILE_URL = /file:\/\/[A-Za-z]:[\\/][^\r\n"'<>|?*]*?\.(?:docx|pdf|md|markdown)\b/gi;

function allStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) allStrings(item, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) allStrings(item, output);
  }
  return output;
}

function evidence(entry: SessionEntry, successfulToolResults: ReadonlyMap<string, ToolCompletionEvidence>): {
  kind: ArtifactEvidenceKind;
  toolName?: string;
  toolCallId?: string;
  initialToolResultEntryId?: string;
  toolResultEntryId?: string;
  completionToolCallId?: string;
  completionToolResultEntryId?: string;
  asyncCellId?: string;
  score: number;
} {
  if (entry.type !== "message") return { kind: "session-entry", score: 0 };
  const message = entry.message;
  if (message.role === "user") return { kind: "user", score: -40 };
  if (message.role === "toolResult") {
    const lower = message.toolName.toLowerCase();
    const generated = /(?:write|create|save|render|document|docx)/.test(lower);
    const readOnly = /(?:read|inspect|view)/.test(lower);
    return {
      kind: "tool-result",
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      toolResultEntryId: entry.id,
      score: generated ? 80 : readOnly ? -30 : 10,
    };
  }
  if (message.role === "assistant") {
    return { kind: "assistant-delivery", score: 30 };
  }
  return { kind: "session-entry", score: 0 };
}

function resultText(entry: SessionEntry): string {
  if (entry.type !== "message" || entry.message.role !== "toolResult") return "";
  return allStrings(entry.message.content).join("\n");
}

function completedToolCalls(entries: readonly SessionEntry[]): Map<string, ToolCompletionEvidence> {
  const toolCalls = new Map<string, { index: number; name: string; arguments: unknown }>();
  const toolResults = new Map<string, { index: number; entry: SessionEntry }>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.type !== "message") continue;
    if (entry.message.role === "assistant" && Array.isArray(entry.message.content)) {
      for (const block of entry.message.content) {
        if (block.type === "toolCall") toolCalls.set(block.id, { index, name: block.name, arguments: block.arguments });
      }
    } else if (entry.message.role === "toolResult") {
      toolResults.set(entry.message.toolCallId, { index, entry });
    }
  }

  const completed = new Map<string, ToolCompletionEvidence>();
  for (const [callId, result] of toolResults) {
    if (result.entry.type !== "message" || result.entry.message.role !== "toolResult" || result.entry.message.isError) continue;
    const text = resultText(result.entry);
    const running = text.match(/Script running with cell ID\s+([^\s]+)/i);
    if (!running) {
      completed.set(callId, {
        toolResultEntryId: result.entry.id,
        initialToolResultEntryId: result.entry.id,
      });
      continue;
    }

    const asyncCellId = running[1]!;
    const waitCompletions = [...toolCalls.entries()]
      .filter(([, call]) => call.index > result.index && call.name.toLowerCase() === "wait")
      .filter(([, call]) => {
        if (!call.arguments || typeof call.arguments !== "object") return false;
        return String((call.arguments as Record<string, unknown>).cell_id) === asyncCellId;
      })
      .sort((left, right) => left[1].index - right[1].index);
    const waitCompletion = waitCompletions.find(([completionToolCallId]) => {
      const completionResult = toolResults.get(completionToolCallId);
      if (!completionResult || completionResult.entry.type !== "message" || completionResult.entry.message.role !== "toolResult" || completionResult.entry.message.isError) return false;
      const completionText = resultText(completionResult.entry);
      return /Script completed/i.test(completionText) && /Exit code:\s*0\b/i.test(completionText);
    });
    if (!waitCompletion) continue;
    const [completionToolCallId] = waitCompletion;
    const completionResult = toolResults.get(completionToolCallId)!;
    completed.set(callId, {
      initialToolResultEntryId: result.entry.id,
      toolResultEntryId: completionResult.entry.id,
      completionToolCallId,
      completionToolResultEntryId: completionResult.entry.id,
      asyncCellId,
    });
  }
  return completed;
}

function extractPaths(value: unknown, cwd: string): string[] {
  const results = new Set<string>();
  for (const text of allStrings(value)) {
    for (const match of text.matchAll(WINDOWS_DOCUMENT_PATH)) results.add(resolve(match[0]));
    for (const match of text.matchAll(FILE_URL)) results.add(resolve(decodeURI(match[0].replace(/^file:\/\//i, ""))));
    const trimmed = text.trim().replace(/^<|>$/g, "");
    if (PRODUCTION_RULES.acceptedArtifactExtensions.includes(extname(trimmed).toLowerCase() as never)) {
      results.add(resolve(isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed)));
    }
  }
  return [...results];
}

export async function discoverGeneratedArtifacts(entries: readonly SessionEntry[], cwd: string): Promise<ArtifactSelection> {
  const all: ArtifactCandidate[] = [];
  const successfulToolResults = completedToolCalls(entries);
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    if (!entry) continue;
    if (entry.type === "message" && entry.message.role === "assistant" && Array.isArray(entry.message.content)) {
      const toolBlocks = entry.message.content.filter((block) => block.type === "toolCall");
      if (toolBlocks.length > 0) {
        for (const block of toolBlocks) {
          const completion = successfulToolResults.get(block.id);
          if (!completion) continue;
          const toolName = block.name.toLowerCase();
          const serialized = allStrings(block).join("\n");
          const generated = /(?:write|create|save|document|docx)/.test(toolName)
            || /(?:apply_patch|writeFile|write_text|Set-Content|Out-File|word_create|create_document|SaveAs|build[_-][^'"\s]*\.(?:py|js|ts)|转换(?:为|成).*docx)/i.test(serialized);
          if (!generated) continue;
          for (const path of extractPaths(block, cwd)) {
            try {
              const info = await stat(path);
              if (!info.isFile()) continue;
              const extension = extname(path).toLowerCase();
              const extensionIndex = PRODUCTION_RULES.preferredArtifactExtensions.indexOf(extension as never);
              all.push({
                path,
                entryId: entry.id,
                entryIndex,
                evidenceKind: "tool-call",
                toolName: block.name,
                toolCallId: block.id,
                ...completion,
                score: 90 + Math.max(0, 10 - extensionIndex),
                modifiedAtMs: info.mtimeMs,
              });
            } catch {
              // Ignore stale paths mentioned in the tool call.
            }
          }
        }
        continue;
      }
    }
    const source = evidence(entry, successfulToolResults);
    for (const path of extractPaths(entry, cwd)) {
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        const extension = extname(path).toLowerCase();
        const extensionIndex = PRODUCTION_RULES.preferredArtifactExtensions.indexOf(extension as never);
        all.push({
          path,
          entryId: entry.id,
          entryIndex,
          evidenceKind: source.kind,
          ...(source.toolName ? { toolName: source.toolName } : {}),
          ...(source.toolCallId ? { toolCallId: source.toolCallId } : {}),
          ...(source.initialToolResultEntryId ? { initialToolResultEntryId: source.initialToolResultEntryId } : {}),
          ...(source.toolResultEntryId ? { toolResultEntryId: source.toolResultEntryId } : {}),
          ...(source.completionToolCallId ? { completionToolCallId: source.completionToolCallId } : {}),
          ...(source.completionToolResultEntryId ? { completionToolResultEntryId: source.completionToolResultEntryId } : {}),
          ...(source.asyncCellId ? { asyncCellId: source.asyncCellId } : {}),
          score: source.score + Math.max(0, 10 - extensionIndex),
          modifiedAtMs: info.mtimeMs,
        });
      } catch {
        // Ignore stale paths mentioned in the conversation.
      }
    }
  }

  const bestByPath = new Map<string, ArtifactCandidate>();
  for (const candidate of all) {
    const key = candidate.path.toLowerCase();
    const current = bestByPath.get(key);
    if (!current || candidate.score > current.score || (candidate.score === current.score && candidate.entryIndex > current.entryIndex)) {
      bestByPath.set(key, candidate);
    }
  }
  const candidates = [...bestByPath.values()]
    .filter((candidate) => !/[\\/](?:\.codex|\.cache|node_modules|skills?)[\\/]/i.test(candidate.path))
    .filter((candidate) => candidate.score >= 50)
    .sort((left, right) => left.entryIndex - right.entryIndex || left.modifiedAtMs - right.modifiedAtMs);
  if (candidates.length === 0) {
    throw new Error("No generated document artifact was found inside the selected Refine range");
  }
  return {
    baseline: candidates[0]!,
    gold: candidates[candidates.length - 1]!,
    candidates,
  };
}
