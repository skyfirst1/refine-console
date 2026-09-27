import type {
  RefineWorkflowOptions,
  RefineWorkflowResult,
} from "./refine-workflow-harness.js";
import {
  REFINE_CANONICAL_STAGE_SEQUENCE,
  runFixedRefineWorkflowHarness,
} from "./refine-workflow-harness.js";

export interface RefineWorkflowNode {
  id: (typeof REFINE_CANONICAL_STAGE_SEQUENCE)[number];
  dependsOn: readonly (typeof REFINE_CANONICAL_STAGE_SEQUENCE)[number][];
  implementation: "fixed-refine-workflow-harness";
}

/**
 * A declarative view of the fixed demo DAG. Execution remains in the existing
 * Agent harness; this module deliberately does not introduce another scheduler.
 */
export const REFINE_WORKFLOW_DAG: readonly RefineWorkflowNode[] = Object.freeze([
  { id: "description-reconstruction", dependsOn: [], implementation: "fixed-refine-workflow-harness" },
  { id: "current-draft-generation", dependsOn: ["description-reconstruction"], implementation: "fixed-refine-workflow-harness" },
  { id: "draft-expert-evaluation", dependsOn: ["current-draft-generation"], implementation: "fixed-refine-workflow-harness" },
  { id: "skill-review", dependsOn: ["draft-expert-evaluation"], implementation: "fixed-refine-workflow-harness" },
  { id: "candidate-skill-compilation", dependsOn: ["skill-review"], implementation: "fixed-refine-workflow-harness" },
  { id: "candidate-draft-generation", dependsOn: ["candidate-skill-compilation"], implementation: "fixed-refine-workflow-harness" },
  { id: "candidate-expert-evaluation", dependsOn: ["candidate-draft-generation"], implementation: "fixed-refine-workflow-harness" },
  { id: "independent-judge", dependsOn: ["candidate-expert-evaluation"], implementation: "fixed-refine-workflow-harness" },
  { id: "promotion-decision", dependsOn: ["independent-judge"], implementation: "fixed-refine-workflow-harness" },
]);

export function describeRefineWorkflow(): {
  id: "refine-workflow-gold-skill-v2";
  executionMode: "workflow";
  failClosed: true;
  nodes: readonly RefineWorkflowNode[];
} {
  return {
    id: "refine-workflow-gold-skill-v2",
    executionMode: "workflow",
    failClosed: true,
    nodes: REFINE_WORKFLOW_DAG,
  };
}

/**
 * Thin fixed-workflow entry point. Agent-mode orchestration owns a separate
 * entry point and may reuse only explicitly extracted neutral primitives.
 */
export async function runFixedRefineWorkflow(
  options: RefineWorkflowOptions,
): Promise<RefineWorkflowResult> {
  return runFixedRefineWorkflowHarness({ ...options, executionMode: "workflow" });
}
