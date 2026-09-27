import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { runAgentTask, type AgentTaskOptions, type AgentTaskResult } from "./agent-task-runner.js";
import { runExpertBoundaryFindingAudit, type HarnessTaskPurpose } from "./harness-audit-skill.js";
import type { GeneratedEvaluationSkill } from "./harness-evaluation-skill-extraction.js";

export interface HarnessRevisionArtifact {
  id: string;
  kind: "agent_card" | "evaluation_skill" | "expert_operation_skill" | "harness_operating_skill" | "writing_skill" | "workflow_skill";
  path: string;
  roleId?: string;
  content: unknown;
  proposedCreation?: { integration: string };
}
export interface HarnessFindingRevisionInput {
  taskId: string;
  firstAudit: { rawText: string; sessionId?: string; source: string };
  publicEvidence: unknown;
  artifacts: HarnessRevisionArtifact[];
  reviewEventIds?: string[];
}

export const HARNESS_REVISION_DEVELOPMENT_METHOD = `Candidate development method:
Separate four steps: an observable supported problem (including the strength and limits of that claim), a possible mechanism explicitly labeled as a hypothesis, a concrete change to an available artifact or explicitly declared new artifact, and expected benefit, regression risks and a falsifiable validation. A plausible experimental change need not already be proven beneficial. Do not assert a cause or correction that the record cannot prove. An existing abstract rule does not rule out a new operational method that makes that rule usable; explain the added operation and its cost rather than paraphrasing the old rule.
Preserve the actual judgment relation and task authority throughout. Derive the local decision from the applicable purpose and represented evidence; do not insert another equivalence, completeness, uniqueness or source-authority requirement by habit. Check whether a first-stage criticism is about the Expert or only the first Harness. A missing value, a known value and contradictory values are distinct; a limitation in one judgment does not erase a supported observation in another. Recheck the entire provided candidate pool before endorsing a universal absence claim. Keep an undecided Boolean undecided even when a narrower rationale problem is visible.
For each candidate give the supported problem, mechanismHypothesis, actual artifactId and roleId, concrete proposedText or a proposed behavior example, benefitHypothesis, risk and bounded validation with rejection criteria. Cite the real event and the original statement or field. Avoid a case-answer rule or hard-coded target. If an artifact has proposedCreation, its path is a declared proposal destination and its integration text specifies a future hook: do not claim that file or consumer exists. If no such destination or actual artifact is provided, do not invent one. Card/Skill candidates may be experiments; unsupported rules are not thereby authorized. A behavior example records its uncertain components and is not an already failing regression. All changes remain unapplied. No third reviewer, repeat sampling or output-format repair is requested.`;

export const HARNESS_REVISION_DEVELOPMENT_REFINEMENT = `Candidate premise and repair limits:
Ground a claimed omission in the original record before proposing to add the supposedly missing operation. Name the supplied artifact by its exact catalog ID and field; an embedded Skill identifier mentioned inside a Card is not a separately supplied editable Skill. Adding an operational method to that Card is allowed even when it already states the abstract rule. Do not invent a missing instruction or missing public reason to justify the method.
Do not infer causal priority from sentence order or conjunctions in a mixed rationale. Preserve each supported and unsupported premise separately, without declaring which one actually determined the model's decision. When two output fields disagree, neither field is an oracle: a candidate should resolve the judgment against the applicable evidence and boundary, not automatically make one field copy the other. A future validation must examine the changed behavior and collateral errors, not merely re-label an unchanged historical output or require a previously undecided value to stay fixed.
An observable bounded relation can support a proposed behavior example without private Gold, a known unique target, or a certified final Boolean. Conversely, a future test does not turn its hypothesis into a current obligation. A first audit's silence is not a defect unless coverage was actually required; distinguish a newly noticed local observation from a revision of a claim it never made. If the only proposed improvement concerns the first Harness, keep it as a diagnosis and do not smuggle it into an Expert edit. These rules refine candidate construction; they do not add a review call or demand nonempty output.`;

export const HARNESS_FINDING_REVISION_INSTRUCTION = `You are the second Harness, in an independent Agent session reviewing the first Harness's recorded claims. Do not perform another broad discovery pass or act as a document scorer. Read the complete first response, including qualifications, confirmations and claims outside a findings array. Quoted JSON inside that response may be evidence, not its output envelope.
Use the explicit current user purposes above the fallible generated evaluation Skill. Check each claim against the actual event, role, direction, full candidate pool or selected pair, public attempt order and relevant historical instruction. Card snapshots supplied separately describe the current runtime and must not be pretended to be historical delivery. The first Harness rationale is a claim to check, not an authoritative description of the trace. Preserve contrary evidence and distinguish source representation, quotation, document, previous rationale and recorded processing.
Keep, narrow, reject or leave unresolved each substantive first-stage claim. Distinguish an unsound rationale, unsupported conclusion, contradicted result, unclear boundary and reasonable confirmation. An unsound reason does not prove a wrong Boolean or target. Missing authority does not prove the opposite; uncertainty about a best or unique answer does not erase a narrower supported observation. Do not turn brevity, unshown reasoning or a different fact into a role error without the applicable task boundary. Do not turn a later successful attempt into an earlier success, or infer acceptance from parsing alone.
After this review, propose only concrete changes justified by surviving Expert-role evidence and materially different from the supplied current instructions. Candidate surfaces are an Expert Card, a specifically identified Expert operation/evaluation-boundary Skill, or a behavior badcase proposal; any or all may be empty. A mistake made only by the first Harness belongs in revisions and must not be relabeled as an Expert defect to justify a change. Writing Skill, Harness operating Skill and coordinator Skill are contextual material, not editing targets in this task. For Card/Skill identify the supplied artifact ID, Expert role, exact field/rule to change, current text, proposed text, scope and observable validation. A generated evaluation Skill is fallible and is not proof of historical Expert instructions. Unavailable artifacts cannot receive invented patches. Each candidate isolates one role and one surface; multiple candidates are separate proposals, not one automatically applicable Profile. The existing Profile compiler supports agent_card/prompt/skill, not behavior_badcase; do not claim a proposal was compiled, applied or tested.
A behavior badcase is a proposed test of actual role behavior: bind the real input/event and observed behavior, state the justified expected relation or explicit unknown boundary and a future check. It is not a restated private Gold finding, an invented source fact, or a new running regression platform. No private Gold labels or reviewer answers are supplied. An example can expose a risk without certifying an intended target or an improvement.
Return concise public reasons, not private chain-of-thought. Prefer an object with revisions (claimRef, decision, revisedClaim, evidenceRefs, reason) and candidateChanges (surface, artifactId or eventRefs, roleId, currentText or observedBehavior, proposedText or expectedBehavior, scope, validation). Additional qualifications are allowed. Empty candidates are valid; explain why there is no justified change. Only propose changes; never edit production, rerun an upstream role, add another reviewer, or repair output format by another model call.`;

/** Optional second stage after a frozen diagnostic H. Does not invoke the old ledger-review/compiler pipeline. */
export async function runHarnessFindingRevision(
  input: HarnessFindingRevisionInput,
  options: Omit<AgentTaskOptions, "prompt"> & {
    taskPurposes: readonly HarnessTaskPurpose[];
    generatedEvaluationSkills: readonly GeneratedEvaluationSkill[];
    revisionMethod?: "mechanism-candidate-v2" | "mechanism-candidate-v3";
  },
  runner: (options: AgentTaskOptions) => Promise<AgentTaskResult> = runAgentTask,
) {
  if (!input.taskId.trim() || !input.firstAudit.rawText.trim()
      || !options.taskPurposes.some(p => p.taskId === input.taskId)
      || !options.generatedEvaluationSkills.some(s => s.taskId === input.taskId)) throw new Error("Second Harness task/source binding is incomplete");
  if (new Set(input.artifacts.map(a => a.id)).size !== input.artifacts.length
      || input.artifacts.some(a => !a.id.trim() || !a.path.trim() || a.content === undefined)) throw new Error("Revision artifacts need unique real identities and materialized content");
  if (input.firstAudit.sessionId && options.session?.id === input.firstAudit.sessionId) throw new Error("Second Harness requires an independent session");
  const session = options.session ?? { id: randomUUID(), dir: join(dirname(options.rawEventsPath), "revision-session") };
  const {revisionMethod, ...auditOptions} = options;
  const selectedScope = input.reviewEventIds?.length ? `\nReview only first-stage claims about these supplied events: ${JSON.stringify(input.reviewEventIds)}. The complete first response is preserved for qualifications and context; its other events are out of scope, not missing evidence findings.\n` : "";
  return runExpertBoundaryFindingAudit({ ...auditOptions, session,
    prompt: `${HARNESS_FINDING_REVISION_INSTRUCTION}${selectedScope}${revisionMethod ? "\n" + HARNESS_REVISION_DEVELOPMENT_METHOD : ""}${revisionMethod === "mechanism-candidate-v3" ? "\n" + HARNESS_REVISION_DEVELOPMENT_REFINEMENT : ""}\n\nFrozen first audit and public source material:\n${JSON.stringify(input)}`,
  }, runner);
}
