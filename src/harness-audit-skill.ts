import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgentTask, type AgentTaskOptions, type AgentTaskResult } from "./agent-task-runner.js";
import type { GeneratedTaskBoundary } from "./harness-boundary-extraction.js";
import type { GeneratedEvaluationSkill } from "./harness-evaluation-skill-extraction.js";

const bundledSkillPath = fileURLToPath(new URL("../.pi/skills/refine-harness-audit/SKILL.md", import.meta.url));

export interface HarnessTaskPurpose {
  taskId: string;
  content: string | null;
  style: string | null;
  authority: string[];
}

export function renderHarnessTaskPurposes(purposes: readonly HarnessTaskPurpose[] = []) {
  const ids = new Set<string>();
  for (const purpose of purposes) {
    if (!purpose.taskId.trim() || ids.has(purpose.taskId)
      || [purpose.content, purpose.style].some(value => value !== null && !value.trim())
      || !purpose.authority.every(value => typeof value === "string" && value.trim())) {
      throw new Error("Invalid Harness task purpose");
    }
    ids.add(purpose.taskId);
  }
  return purposes.length ? `Current task purposes govern this audit; historical instructions are evidence, not a substitute purpose. A null axis is not defined here; inspect actual requirements or report the affected boundary as unresolved. These purposes are not an Expert runtime modification.\n${JSON.stringify(purposes)}` : "";
}

export async function loadHarnessAuditSkill(cwd: string) {
  const checkoutPath = resolve(cwd, ".pi/skills/refine-harness-audit/SKILL.md");
  let path = checkoutPath;
  let content: string;
  try { content = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    path = bundledSkillPath;
    content = await readFile(path, "utf8");
  }
  if (!content.trim()) throw new Error("Harness audit Skill is empty");
  return { path, content, sha256: createHash("sha256").update(content).digest("hex") };
}

export function renderHarnessAuditSkill(skill: { content: string }) {
  return `Harness operating Skill (applies to the audit, not to the historical evaluated roles):\n${skill.content}`;
}

/** Diagnostic projection of the same Harness operating Skill, without compiling a Profile. */
export async function runExpertBoundaryFindingAudit(
  options: AgentTaskOptions & { taskPurposes: readonly HarnessTaskPurpose[]; generatedBoundaries?: readonly GeneratedTaskBoundary[]; generatedEvaluationSkills?: readonly GeneratedEvaluationSkill[] },
  runner: (options: AgentTaskOptions) => Promise<AgentTaskResult> = runAgentTask,
) {
  const skill = await loadHarnessAuditSkill(options.cwd);
  const { taskPurposes, generatedBoundaries, generatedEvaluationSkills, ...taskOptions } = options;
  if (generatedEvaluationSkills?.length && generatedBoundaries?.length) throw new Error("Choose one generated evaluation artifact form");
  if (generatedEvaluationSkills && (new Set(generatedEvaluationSkills.map(s => s.taskId)).size !== generatedEvaluationSkills.length || generatedEvaluationSkills.some(s => !s.content.trim() || !taskPurposes.some(p => p.taskId === s.taskId)))) throw new Error("Generated evaluation Skill task binding mismatch");
  const generatedSkills = generatedEvaluationSkills?.length ? `\n\nThe following evaluation Skills were written by independent Agent sessions. They are fallible interpretations subordinate to the explicit user purposes above. Apply the operating Skill's trace-and-boundary joint evaluation principle to these prose criteria; references there to a boundary table mean this current evaluation artifact, not an additional table. The trace establishes what happened; the evaluation Skill establishes how to judge it and at which level. Identify insufficient or conflicting criteria rather than supplying an unstated default. Their presence does not prove historical roles received them.\n${generatedEvaluationSkills.map(s => `\nEvaluation Skill for task ${s.taskId}:\n${s.content}`).join("\n")}` : "";
  if (generatedBoundaries && (new Set(generatedBoundaries.map(b => b.taskId)).size !== generatedBoundaries.length || generatedBoundaries.some(b => !taskPurposes.some(p => p.taskId === b.taskId)))) throw new Error("Generated boundary task binding mismatch");
  const extracted = generatedBoundaries?.length ? `\n\nThe following table was produced by an independent Agent boundary-extraction session. It is a fallible interpretation of the evaluation criteria, subordinate to the explicit user purposes above. Evaluate each diagnosis using both the original trace, which establishes what happened, and the table, which establishes how to judge it and at which level. Identify insufficient or conflicting boundaries rather than supplying an unstated default. Do not treat presence of this table as proof that historical Expert roles received it.\n${JSON.stringify(generatedBoundaries)}` : "";
  const result = await runner({
    ...taskOptions,
    systemPrompt: `${renderHarnessAuditSkill(skill)}\n\n${options.systemPrompt ?? ""}\n\n${renderHarnessTaskPurposes(taskPurposes)}${extracted}${generatedSkills}`,
  });
  return { result, operatingSkill: skill };
}
