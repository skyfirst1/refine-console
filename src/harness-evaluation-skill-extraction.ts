import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAgentTask, type AgentTaskOptions, type AgentTaskResult } from "./agent-task-runner.js";
import type { BoundaryExtractionInput } from "./harness-boundary-extraction.js";

export interface GeneratedEvaluationSkill { taskId: string; content: string }
export interface EvaluationSkillExtractionInput extends BoundaryExtractionInput {
  /** Versioned process description, separate from task-specific evaluation criteria. */
  workflow?: { version: string; content: string };
}
export const evaluationSkillExtractionInstruction = `Create a coherent evaluation Skill for unseen tasks in the same task family, using only the supplied actual Description, explicit user boundaries, and migration goal. This independent session does not audit historical failures or prescribe a case finding. Write the Skill directly as useful prose in Markdown, not a JSON object, boundary array, or table converted into prose. Organize it naturally around purpose and applicable situations; permitted content variation and its reasons; what must remain and the basis; how to combine observed trace with the evaluation criteria at the relevant stage; and uncertainty or conflicts. Distinguish content, style, and authority without imposing one universal criterion on unrelated task families.
Explicit user constraints have priority. Distinguish their requirements from Description-specific conditions, reasonable contextual inferences, and genuinely undefined relations. Infer supported contextual defaults rather than making every unstated requirement unknown. A reusable method must allow entities and details to change when the task goal permits; do not turn this sample's names, dates, numerical values or conclusion list into universal rules. Explain how the criteria apply to the observed unit; do not assume whole-document requirements automatically determine a local comparison. If scope or authority is insufficient or conflicting, identify the affected judgment rather than inventing a default. Give concise public justifications, not private reasoning. Return the finished Skill text only; no mandatory metadata wrapper or fixed heading schema.`;
export const workflowEvaluationSkillExtractionInstruction = evaluationSkillExtractionInstruction.replace(
  "using only the supplied actual Description, explicit user boundaries, and migration goal",
  "using the supplied actual Description, explicit user boundaries, migration goal, and versioned Expert workflow description",
) + `
The Skill's user is Harness auditing Expert behavior, not a writer producing or checking an entire document. Use the workflow to understand each stage's actual inputs, representation, output, and downstream effects. Write a natural-language method for interpreting that stage's observed public trace under the task-derived evaluation relation. Do not merely relabel a document-writing checklist as an Expert audit. The workflow establishes process and information availability, not a universal task standard or proof that a historical run received today's instructions. Keep concept comparability, separate content/style relations, source fidelity, and deterministic aggregation distinct. Derive the appropriate granularity, allowed variation, invariants, authority and unknowns from the actual task and superior explicit user constraints; do not import historical role defaults as universal correctness criteria. A single Aspect need not satisfy whole-document requirements. Explain what evidence would support or limit a stage-level judgment and how an error could propagate, without prescribing a finding, Boolean answer, repair or alleged internal reasoning. The final Skill should remain useful for unseen tasks in this family whose entities and details change.`;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Optional first-layer method; it receives no local trace or expected finding. */
export const localEvidenceEvaluationSkillExtractionInstruction = workflowEvaluationSkillExtractionInstruction + `
Make the method operational at the local stage while retaining its applicability to unseen tasks. Distinguish variation allowed across tasks from fidelity to the authorized source within one task. For each stage, explain its judgment object and responsibility, the minimum available evidence that can support a bounded conclusion, and which particular judgment an unknown would block. Distinguish a field or concept being represented, its value being known, two values agreeing, and an assertion being authorized by a real source: evidence for one does not automatically establish or negate the others.
When a candidate Aspect covers a broader grouping, inspect the related sub-concept actually represented by its content instead of inferring absence from the breadth of its title or an unspecified value. Conversely, shared broad subject matter alone does not establish a comparable concept. Keep establishing some comparability separate from selecting the best available candidate or proving uniqueness. Treat a historical rationale as an assertion to check against evidence, not as a rule that validates itself. Explain how a limited conclusion supported at the stage can stand while other questions remain unresolved, without turning a limitation into a blanket refusal. Integrate these distinctions into natural, coherent evaluation prose rather than adding a rigid table, field checklist, or case-specific prohibitions. Do not supply a predetermined diagnosis, verdict, target identity, or implementation repair.`;

/** A prose artifact generated in its own Agent session; never reuses the table cache. */
export async function runHarnessEvaluationSkillExtraction(
  input: EvaluationSkillExtractionInput,
  options: AgentTaskOptions & { cacheDirectory: string; providerConfigurationIdentity?: string; evaluationMethod?: "local-evidence-v1" },
  runner: (options: AgentTaskOptions) => Promise<AgentTaskResult> = runAgentTask,
) {
  if (![input.taskId, input.description, input.userBoundary, input.migrationGoal].every(v => typeof v === "string" && v.trim())) throw Error("Empty evaluation Skill input");
  if (input.workflow && (![input.workflow.version, input.workflow.content].every(v => typeof v === "string" && v.trim()))) throw Error("Incomplete workflow input");
  if (options.evaluationMethod && (!input.workflow || options.evaluationMethod !== "local-evidence-v1")) throw Error("Local evidence method requires a versioned workflow");
  const instruction = options.evaluationMethod ? localEvidenceEvaluationSkillExtractionInstruction : input.workflow ? workflowEvaluationSkillExtractionInstruction : evaluationSkillExtractionInstruction;
  const binding = { schema: options.evaluationMethod ? "evaluation-skill-local-evidence-v1" : input.workflow ? "evaluation-skill-workflow-prose-v1" : "evaluation-skill-prose-v1", input, instruction, provider: options.provider, model: options.model, thinking: options.thinking, maxOutputTokens: options.maxOutputTokens, providerConfigurationIdentity: options.providerConfigurationIdentity ?? null };
  const key = sha(JSON.stringify(binding)), directory = join(options.cacheDirectory, key);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "state.json");
  let state: any;
  try { state = JSON.parse(await readFile(path, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (state) {
    if (state.key !== key || state.status !== "completed") throw Error("Existing incomplete/failed Skill session retained; no automatic regeneration");
    const content = await readFile(join(directory, "SKILL.md"), "utf8");
    if (!content.trim() || sha(content) !== state.skillSha256) throw Error("Cached evaluation Skill integrity mismatch");
    return { skill: { taskId: input.taskId, content } as GeneratedEvaluationSkill, key, sessionId: state.sessionId as string, directory, reused: true };
  }
  const sessionId = randomUUID();
  state = { key, binding, sessionId, status: "started", startedAt: new Date().toISOString() };
  await writeFile(path, JSON.stringify(state, null, 2), { flag: "wx" });
  const { cacheDirectory: _cache, providerConfigurationIdentity: _identity, evaluationMethod: _method, ...taskOptions } = options;
  const actual: AgentTaskOptions = { ...taskOptions, systemPrompt: instruction, prompt: JSON.stringify(input), tools: "none", rawEventsPath: join(directory, "events.jsonl"), session: { id: sessionId, dir: join(directory, "session") } };
  await writeFile(join(directory, "actual-options.json"), JSON.stringify(actual, null, 2));
  try {
    const result = await runner(actual);
    await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2));
    await writeFile(join(directory, "public-output.md"), result.finalText);
    if (result.stopReason !== "stop" || !result.finalText.trim()) throw Error(`Incomplete evaluation Skill: ${result.stopReason}`);
    // Preserve the generated prose exactly. Its semantic quality is not certified by serialization.
    await writeFile(join(directory, "SKILL.md"), result.finalText);
    state.skillSha256 = sha(result.finalText);
    state.status = "completed";
  } catch (error) { state.status = "failed"; state.error = String(error); throw error; }
  finally { state.finishedAt = new Date().toISOString(); await writeFile(path, JSON.stringify(state, null, 2)); }
  return { skill: { taskId: input.taskId, content: await readFile(join(directory, "SKILL.md"), "utf8") } as GeneratedEvaluationSkill, key, sessionId, directory, reused: false };
}
