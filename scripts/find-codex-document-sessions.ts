import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { homedir } from "node:os";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions") },
    limit: { type: "string", default: "30" },
  },
});

const ignoredPrefixes = [
  "<recommended_plugins>",
  "# AGENTS.md instructions",
  "<environment_context>",
  "<in-app-browser-context",
];
const documentPattern = /(?:\.docx\b|Word\s*文档|生成\s*Word|技术文档|技术方案|架构文档|PRD|产品需求文档)/i;
const wordPattern = /(?:\.docx\b|Word\s*文档|生成\s*Word|Microsoft Word)/i;

async function findJsonl(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findJsonl(path));
    else if (extname(entry.name) === ".jsonl") files.push(path);
  }
  return files;
}

function textParts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part: any) => part && (part.type === "input_text" || part.type === "output_text"))
    .map((part: any) => String(part.text ?? ""));
}

function safePreview(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{12,}/gi, "[REDACTED]")
    .replace(/bearer\s+[A-Za-z0-9._-]{12,}/gi, "Bearer [REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

const results: any[] = [];
for (const path of await findJsonl(values.root!)) {
  const input = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let sessionId = basename(path, ".jsonl").match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i)?.[1];
  let cwd = "";
  let timestamp = "";
  const userPrompts: string[] = [];
  let assistantTurns = 0;
  let toolCalls = 0;
  let docxMentions = 0;
  let renderMentions = 0;
  for await (const line of input) {
    let item: any;
    try { item = JSON.parse(line); } catch { continue; }
    if (item.type === "session_meta") {
      sessionId = item.payload?.id ?? sessionId;
      cwd = item.payload?.cwd ?? cwd;
      timestamp = item.payload?.timestamp ?? timestamp;
    }
    const payload = item.payload;
    if (item.type === "response_item" && payload?.type === "message") {
      const parts = textParts(payload.content);
      if (payload.role === "user") {
        for (const part of parts) {
          if (!ignoredPrefixes.some((prefix) => part.trimStart().startsWith(prefix))) userPrompts.push(part);
        }
      } else if (payload.role === "assistant" && parts.some((part) => part.trim())) {
        assistantTurns += 1;
      }
    }
    if (item.type === "response_item" && payload?.type === "function_call") toolCalls += 1;
    const raw = line;
    if (/\.docx\b/i.test(raw)) docxMentions += 1;
    if (/render_docx\.py|LibreOffice|soffice/i.test(raw)) renderMentions += 1;
  }
  const relevantPrompts = userPrompts.filter((prompt) => documentPattern.test(prompt));
  if (relevantPrompts.length === 0) continue;
  const score = relevantPrompts.length * 10
    + userPrompts.filter((prompt) => wordPattern.test(prompt)).length * 20
    + Math.min(assistantTurns, 10)
    + Math.min(toolCalls, 20)
    + Math.min(docxMentions, 20)
    + Math.min(renderMentions, 20) * 2;
  results.push({
    score,
    sessionId,
    timestamp,
    cwd,
    userTurns: userPrompts.length,
    assistantTurns,
    toolCalls,
    docxMentions,
    renderMentions,
    prompt: safePreview(relevantPrompts[0]!),
    path,
  });
}

results.sort((a, b) => b.score - a.score || b.timestamp.localeCompare(a.timestamp));
process.stdout.write(`${JSON.stringify(results.slice(0, Number.parseInt(values.limit!, 10)), null, 2)}\n`);
