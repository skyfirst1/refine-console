import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { REFINE_CANONICAL_STAGE_SEQUENCE } from "../src/refine-workflow-harness.js";
import { describeRefineWorkflow, REFINE_WORKFLOW_DAG } from "../src/refine-workflow-agent.js";
import { registerRefineAgentTools } from "../src/refine-agent-extension.js";
import { registerRefineWorkflowTool } from "../src/refine-workflow-extension.js";

test("Agent and Workflow register separate entry and Card tools", () => {
  const registered = (register: (pi: Parameters<typeof registerRefineAgentTools>[0]) => void): string[] => {
    const names: string[] = [];
    register({ registerTool(tool: { name: string }) { names.push(tool.name); } } as unknown as Parameters<typeof registerRefineAgentTools>[0]);
    return names;
  };
  assert.deepEqual(registered(registerRefineAgentTools), [
    "refine_agent_cards",
    "refine_draft_agent",
    "refine_agent",
    "refine_agent_step",
  ]);
  assert.deepEqual(registered(registerRefineWorkflowTool), ["refine_workflow_cards", "refine_workflow"]);
});

test("product extension registers Workflow v2 and does not expose the legacy Agent tools", async () => {
  const source = await readFile(resolve("src/index.ts"), "utf8");
  assert.match(source, /registerRefineWorkflowTool\(runtime\)/);
  assert.doesNotMatch(source, /registerRefineAgentTools\(runtime\)/);
  assert.doesNotMatch(source, /from "\.\/refine-agent-extension\.js"/);
});

test("fixed workflow declares the exact Gold-supervised Skill refinement DAG", () => {
  assert.deepEqual(REFINE_WORKFLOW_DAG.map((node) => node.id), [...REFINE_CANONICAL_STAGE_SEQUENCE]);
  assert.ok(REFINE_WORKFLOW_DAG.every((node) => node.implementation === "fixed-refine-workflow-harness"));
  assert.deepEqual(
    REFINE_WORKFLOW_DAG.slice(1).map((node) => node.dependsOn),
    REFINE_WORKFLOW_DAG.slice(0, -1).map((node) => [node.id]),
  );
  const definition = describeRefineWorkflow();
  assert.equal(definition.id, "refine-workflow-gold-skill-v2");
  assert.equal(definition.executionMode, "workflow");
  assert.equal(definition.failClosed, true);
  assert.equal(REFINE_WORKFLOW_DAG.some((node) => node.id.includes("revision")), false);
  assert.equal(REFINE_WORKFLOW_DAG.some((node) => node.id.includes("baseline")), false);
});
