import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAgentTask, type AgentTaskOptions, type AgentTaskResult } from "./agent-task-runner.js";

export interface BoundaryExtractionInput {
  taskId: string;
  description: string;
  userBoundary: string;
  migrationGoal: string;
}
export interface GeneratedTaskBoundary {
  taskId: string;
  boundaries: Array<Record<string, unknown> & { axis: "content" | "style" }>;
}
export const boundaryExtractionInstruction = `You are a task-boundary extraction agent in an independent session. Your input contains the actual task Description, explicit user boundaries, and a migration goal. Produce a task-conditioned comparison boundary table, not an audit of historical failures or a replacement document. Explicit user boundaries are superior to Description and contextual inferences. Explain any apparent conflict rather than silently restoring a stricter historical criterion. Infer reasonable situational defaults where supported; mark their provenance rather than treating everything unspecified as unknowable. Do not copy entities or details from the reference as universal invariants when the task may change. Keep content, style, and source authority distinct.
Return one JSON object with a boundaries array. Include at least a content row and a style row. Each row contains: axis (content or style), comparisonUnit, allowedVariation, mustPreserve, authority, decidability (what can be judged and what remains unknown), provenance (explicit-user, description, context-inference, unresolved, or a combination), and basis (concise public justification). Fields may be strings or arrays of strings. Use uncertainty precisely. No fixed finding or repair is requested. No private reasoning. Optional extra explanatory fields are allowed; do not wrap the JSON in prose.`;

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const parseTable = (text: string, taskId: string): GeneratedTaskBoundary => {
  let candidate = text.trim();
  if (candidate.startsWith("```json") && candidate.endsWith("```")) candidate = candidate.slice(7, -3).trim();
  const parsed = JSON.parse(candidate);
  if (!Array.isArray(parsed.boundaries) || !["content", "style"].every(axis => parsed.boundaries.some((r: any) => r.axis === axis))) throw new Error("Missing content/style boundary rows");
  for (const row of parsed.boundaries) {
    if (!["content", "style"].includes(row.axis)) throw new Error("Unknown boundary axis");
    for (const key of ["comparisonUnit", "allowedVariation", "mustPreserve", "authority", "decidability", "provenance", "basis"]) {
      const value = row[key];
      if (!(typeof value === "string" && value.trim()) && !(Array.isArray(value) && value.length && value.every(v => typeof v === "string" && v.trim()))) throw new Error(`Missing business boundary field: ${key}`);
    }
  }
  return { taskId, boundaries: parsed.boundaries };
};

/** A separate Agent session, cached by semantic input and model/instruction configuration. */
export async function runHarnessBoundaryExtraction(
  input: BoundaryExtractionInput,
  options: AgentTaskOptions & { cacheDirectory: string; providerConfigurationIdentity?: string },
  runner: (options: AgentTaskOptions) => Promise<AgentTaskResult> = runAgentTask,
) {
  if (![input.taskId, input.description, input.userBoundary, input.migrationGoal].every(v => typeof v === "string" && v.trim())) throw new Error("Empty boundary extraction input");
  const binding = { schema: "boundary-table-v1", input, instruction: boundaryExtractionInstruction, provider: options.provider, model: options.model, thinking: options.thinking, maxOutputTokens: options.maxOutputTokens, providerConfigurationIdentity: options.providerConfigurationIdentity ?? null };
  const key = digest(JSON.stringify(binding));
  const directory = join(options.cacheDirectory, key);
  await mkdir(directory, { recursive: true });
  const statePath = join(directory, "state.json");
  let cached: any;
  try { cached = JSON.parse(await readFile(statePath, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (cached) {
    if (cached.key !== key || cached.status !== "completed") throw new Error("Existing incomplete/failed boundary session retained; no automatic regeneration");
    if (digest(JSON.stringify(cached.table)) !== cached.tableSha256) throw new Error("Cached boundary table integrity mismatch");
    parseTable(JSON.stringify(cached.table), input.taskId);
    return { table: cached.table as GeneratedTaskBoundary, key, sessionId: cached.sessionId as string, directory, reused: true };
  }
  const sessionId = randomUUID();
  const state: any = { key, binding, sessionId, status: "started", startedAt: new Date().toISOString() };
  await writeFile(statePath, JSON.stringify(state, null, 2), { flag: "wx" });
  const { cacheDirectory: _cache, providerConfigurationIdentity: _providerIdentity, ...taskOptions } = options;
  const actual: AgentTaskOptions = { ...taskOptions, systemPrompt: boundaryExtractionInstruction, prompt: JSON.stringify(input), tools: "none", rawEventsPath: join(directory, "events.jsonl"), session: { id: sessionId, dir: join(directory, "session") } };
  await writeFile(join(directory, "actual-options.json"), JSON.stringify(actual, null, 2));
  try {
    const result = await runner(actual);
    await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2));
    await writeFile(join(directory, "public-output.md"), result.finalText);
    if (result.stopReason !== "stop") throw new Error(`Boundary session incomplete: ${result.stopReason}`);
    state.table = parseTable(result.finalText, input.taskId);
    state.tableSha256 = digest(JSON.stringify(state.table));
    state.status = "completed";
  } catch (error) {
    state.status = "failed";
    state.error = String(error);
    throw error;
  } finally {
    state.finishedAt = new Date().toISOString();
    await writeFile(statePath, JSON.stringify(state, null, 2));
  }
  return { table: state.table as GeneratedTaskBoundary, key, sessionId, directory, reused: false };
}
