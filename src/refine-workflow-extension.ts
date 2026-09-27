import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { bundledProviderExtensionPath } from "./agent-task-runner.js";
import { describeRefineWorkflow, runFixedRefineWorkflow } from "./refine-workflow-agent.js";
import { REFINE_WORKFLOW_CARDS } from "./refine-workflow-cards.js";
import { validateRefineHarnessProfile } from "./refine-harness-profile.js";

const RefineWorkflowParameters = Type.Object({
  requirementsPath: Type.String({ description: "Frozen requirements/trace artifact path" }),
  goldPath: Type.String({ description: "Frozen Gold/reference document; never exposed to Draft agents" }),
  activeSkillPath: Type.String({ description: "Complete active SKILL.md used to generate the current Draft" }),
  rulesPath: Type.String({ description: "Deterministic production-rules artifact path" }),
  runRoot: Type.String({ description: "Directory for immutable Refine workflow artifacts" }),
  taskType: Type.Optional(Type.String({ description: "Document task family used to activate an optional Harness Profile" })),
  harnessProfilePath: Type.Optional(Type.String({ description: "Optional learned task-family Harness Profile JSON" })),
});

export function registerRefineWorkflowTool(runtime: ExtensionAPI): void {
  runtime.registerTool({
    name: "refine_workflow_cards",
    label: "Refine Workflow Cards",
    description: "List only the pinned fixed-Workflow Card and its top-level DAG role Cards.",
    parameters: Type.Object({}),
    async execute() {
      const details = Object.values(REFINE_WORKFLOW_CARDS).map((card) => ({
        roleId: card.roleId,
        version: card.version,
        digest: card.digest,
        runtime: card.runtime,
        tools: card.tools,
        embeddedSkill: card.embeddedSkill,
        callableSubagents: card.callableSubagents,
        inputContract: card.inputContract,
        outputContract: card.outputContract,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });

  runtime.registerTool({
    name: "refine_workflow",
    label: "Gold-supervised Refine Workflow",
    description: [
      "Run the fixed Description + Active Skill → Draft → private ExPerT/Gold review → complete Candidate Skill",
      "→ Candidate Draft → ExPerT + independent Judge → Promote/Reject DAG.",
      "Draft agents cannot read Gold. The active Skill is never overwritten by this demo.",
    ].join(" "),
    parameters: RefineWorkflowParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.model) throw new Error("Refine Workflow requires an active Agent model");
      const extensionPaths = ctx.model.provider === "deepseek" ? [bundledProviderExtensionPath()] : [];
      const harnessProfilePath = params.harnessProfilePath ? resolve(ctx.cwd, params.harnessProfilePath) : null;
      const harnessProfile = harnessProfilePath
        ? validateRefineHarnessProfile(JSON.parse(await readFile(harnessProfilePath, "utf8")))
        : undefined;
      const result = await runFixedRefineWorkflow({
        cwd: ctx.cwd,
        provider: ctx.model.provider,
        model: ctx.model.id,
        timeoutMs: 20 * 60_000,
        extensionPaths,
        requirementsPath: resolve(ctx.cwd, params.requirementsPath),
        goldPath: resolve(ctx.cwd, params.goldPath),
        activeSkillPath: resolve(ctx.cwd, params.activeSkillPath),
        rulesPath: resolve(ctx.cwd, params.rulesPath),
        runRoot: resolve(ctx.cwd, params.runRoot),
        ...(params.taskType ? { taskType: params.taskType } : {}),
        ...(harnessProfile ? { harnessProfile } : {}),
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ ...result, executionMode: "workflow" }, null, 2) }],
        details: { ...result, executionMode: "workflow", definition: describeRefineWorkflow() },
      };
    },
  });
}
