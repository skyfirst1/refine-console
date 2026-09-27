import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { bundledProviderExtensionPath } from "./agent-task-runner.js";
import { REFINE_AGENT_CARDS } from "./refine-agent-cards.js";
import {
  advanceGoldSkillRefineAgent,
  initializeGoldSkillRefineAgent,
  runRefineDraftAgent,
} from "./refine-agent-harness.js";

const RefineAgentParameters = Type.Object({
  requirementsPath: Type.String({ description: "Frozen requirements/trace artifact path" }),
  goldPath: Type.String({ description: "Frozen successful reference document used only by Reviewer/ExPerT/Judge" }),
  activeSkillPath: Type.String({ description: "Full active SKILL.md or policy file used to generate the current Draft" }),
  activeSkillVersion: Type.String({ description: "Version identifier of the active Skill snapshot" }),
  rulesPath: Type.String({ description: "Deterministic production-rules artifact path" }),
  runRoot: Type.String({ description: "Directory for immutable Refine run artifacts" }),
});

const DraftAgentParameters = Type.Object({
  descriptionPath: Type.String({ description: "Frozen Description artifact" }),
  skillPath: Type.String({ description: "Complete Skill used by the isolated Draft Agent" }),
  outputPath: Type.String({ description: "Draft Markdown output path" }),
  runDirectory: Type.Optional(Type.String({ description: "Directory for Draft Agent events" })),
});

const RefineAgentStepParameters = Type.Object({
  runDirectory: Type.String({ description: "Run directory returned by refine_agent" }),
  stage: Type.Union([
    Type.Literal("description-reconstruction"),
    Type.Literal("current-draft-generation"),
    Type.Literal("reviewer-private-expert"),
    Type.Literal("skill-attribution-review"),
    Type.Literal("candidate-skill-compilation"),
    Type.Literal("candidate-draft-generation"),
    Type.Literal("candidate-private-expert"),
    Type.Literal("independent-judge"),
    Type.Literal("promotion-decision"),
  ], { description: "The exact nextStage returned by the previous coordinator tool call" }),
});

export function registerRefineAgentTools(runtime: ExtensionAPI): void {
  runtime.registerTool({
    name: "refine_agent_cards",
    label: "Refine Agent Cards",
    description: "List only the pinned step-coordinated Refine Agent Card and its fixed-stage role Cards.",
    parameters: Type.Object({}),
    async execute() {
      const details = Object.values(REFINE_AGENT_CARDS).map((card) => ({
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
    name: "refine_draft_agent",
    label: "Refine Draft Agent",
    description: "Invoke the versioned Refine Draft Agent as an isolated no-session Agent task that reads one Description and one complete Skill.",
    parameters: DraftAgentParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.model) throw new Error("Refine Draft Agent requires an active Agent model");
      const extensionPaths = ctx.model.provider === "deepseek" ? [bundledProviderExtensionPath()] : [];
      const result = await runRefineDraftAgent({
        cwd: ctx.cwd,
        provider: ctx.model.provider,
        model: ctx.model.id,
        timeoutMs: 20 * 60_000,
        extensionPaths,
        descriptionPath: resolve(ctx.cwd, params.descriptionPath),
        skillPath: resolve(ctx.cwd, params.skillPath),
        outputPath: resolve(ctx.cwd, params.outputPath),
        ...(params.runDirectory ? { runDirectory: resolve(ctx.cwd, params.runDirectory) } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });

  runtime.registerTool({
    name: "refine_agent",
    label: "Refine Agent",
    description: [
      "Initialize a Gold-supervised Skill Refine run owned by the current Agent session.",
      "This tool does not execute the fixed DAG. It returns nextStage; the current session must call refine_agent_step",
      "once per stage until status is promoted or rejected.",
    ].join(" "),
    parameters: RefineAgentParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.model) throw new Error("Refine Agent requires an active Agent model");
      const extensionPaths = ctx.model.provider === "deepseek" ? [bundledProviderExtensionPath()] : [];
      const result = await initializeGoldSkillRefineAgent({
        cwd: ctx.cwd,
        provider: ctx.model.provider,
        model: ctx.model.id,
        timeoutMs: 20 * 60_000,
        extensionPaths,
        requirementsPath: resolve(ctx.cwd, params.requirementsPath),
        goldPath: resolve(ctx.cwd, params.goldPath),
        activeSkillPath: resolve(ctx.cwd, params.activeSkillPath),
        activeSkillVersion: params.activeSkillVersion,
        rulesPath: resolve(ctx.cwd, params.rulesPath),
        runRoot: resolve(ctx.cwd, params.runRoot),
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });

  runtime.registerTool({
    name: "refine_agent_step",
    label: "Refine Agent Step",
    description: [
      "Execute exactly one child-Agent/tool stage for a run initialized by refine_agent.",
      "Pass the exact nextStage returned by the previous call. The current Agent session owns the decision to continue.",
      "A no-Finding review terminates immediately without generating a duplicate Candidate Draft.",
    ].join(" "),
    parameters: RefineAgentStepParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.model) throw new Error("Refine Agent Step requires an active Agent model");
      const result = await advanceGoldSkillRefineAgent({
        runDirectory: resolve(ctx.cwd, params.runDirectory),
        stage: params.stage,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });
}
