import { AcontextClient } from "@acontext/acontext";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { discoverCodexRollouts } from "./codex-session-discovery.js";
import { writeCodexSessionProjection } from "./codex-session-projection.js";
import { registerAcontextServiceCommands } from "./acontext-service-extension.js";
import {
  AcontextServiceManager,
  applyDiscoveredAcontextEnvironment,
} from "./acontext-service-manager.js";
import { loadConfig } from "./config.js";
import { loadActiveAutoDreamPath, rollbackAutoDream, runAutoDream } from "./auto-dream-runner.js";
import type { AcontextGateway } from "./contracts.js";
import pipelineProvider from "./pipeline-provider.js";
import { registerPhoenixAgentEventTracing } from "./phoenix-tracing.js";
import { registerRefineWorkflowTool } from "./refine-workflow-extension.js";
import { runProductionPipeline } from "./production-pipeline.js";
import {
  PRODUCTION_RANGE_ENTRY_TYPE,
  type EntryRange,
  type ProductionRangeSelection,
  restoreProductionRangeSelection,
  selectableEntries,
} from "./session-range.js";
import { SessionSynchronizer, type SyncContext, type SyncState } from "./session-sync.js";
import { SkillSynchronizer } from "./skill-sync.js";
import { registerWordTools } from "./word-tools.js";

const STATE_ENTRY_TYPE = "acontext-state-v1";
const RUN_ENTRY_TYPE = "acontext-production-run-v1";
const DREAM_ENTRY_TYPE = "auto-dream-run-v1";

function restoredState(branch: SessionEntry[]): SyncState | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE || !entry.data) continue;
    const data = entry.data as Partial<SyncState>;
    if (typeof data.acontextSessionId !== "string" || typeof data.syncedMessageCount !== "number") continue;
    return {
      acontextSessionId: data.acontextSessionId,
      syncedMessageCount: data.syncedMessageCount,
      ...(typeof data.lastSyncedEntryId === "string" ? { lastSyncedEntryId: data.lastSyncedEntryId } : {}),
    };
  }
  return undefined;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

async function selectRange(ctx: ExtensionContext, title: string): Promise<EntryRange | undefined> {
  const entries = selectableEntries(ctx.sessionManager.getBranch());
  if (entries.length === 0) return undefined;
  const startLabel = await ctx.ui.select(`${title}：选择起点`, entries.map((entry) => entry.label));
  if (!startLabel) return undefined;
  const start = entries.find((entry) => entry.label === startLabel);
  if (!start) return undefined;
  const endEntries = entries.filter((entry) => entry.index >= start.index);
  const endLabel = await ctx.ui.select(`${title}：选择终点`, endEntries.map((entry) => entry.label));
  if (!endLabel) return undefined;
  const end = endEntries.find((entry) => entry.label === endLabel);
  if (!end) return undefined;
  return { startEntryId: start.id, endEntryId: end.id };
}

export default function acontextExtension(runtime: ExtensionAPI): void {
  registerWordTools(runtime);
  registerRefineWorkflowTool(runtime);
  pipelineProvider(runtime);
  registerPhoenixAgentEventTracing(runtime);
  const serviceManager = new AcontextServiceManager();
  applyDiscoveredAcontextEnvironment(serviceManager.config);
  registerAcontextServiceCommands(runtime, serviceManager);
  const config = loadConfig();
  let client: AcontextGateway | undefined;
  let synchronizer: SessionSynchronizer | undefined;
  let skillSynchronizer: SkillSynchronizer | undefined;
  let state: SyncState | undefined;
  let activeSkillPath: string | undefined;
  let activeDreamPath: string | undefined;
  let latestContext: SyncContext | undefined;
  let rangeSelection: ProductionRangeSelection | undefined;
  let pending = Promise.resolve();
  const learningRegistrations = new Set<string>();

  if (config.enabled && config.apiKey) {
    const configuredClient: AcontextGateway = new AcontextClient({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    });
    client = configuredClient;
    synchronizer = new SessionSynchronizer(configuredClient, {
      captureToolResults: config.captureToolResults,
      maxToolResultChars: config.maxToolResultChars,
    });
    skillSynchronizer = new SkillSynchronizer(configuredClient, config.skillCacheDir, 1_000_000, config.skillInclude);
  }

  const queueBranchSync = (ctx: ExtensionContext): Promise<void> => {
    if (!synchronizer || !latestContext) return Promise.resolve();
    const branch = ctx.sessionManager.getBranch();
    pending = pending
      .then(async () => {
        const result = await synchronizer.sync(branch, state, latestContext!);
        state = result.state;
        if (config.learningSpaceId && !learningRegistrations.has(state.acontextSessionId)) {
          try {
            await client!.learningSpaces.learn({
              spaceId: config.learningSpaceId,
              sessionId: state.acontextSessionId,
            });
            learningRegistrations.add(state.acontextSessionId);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("already learned")) {
              learningRegistrations.add(state.acontextSessionId);
            } else {
              throw error;
            }
          }
        }
        if (result.storedMessages > 0 || result.recreatedSession) {
          runtime.appendEntry(STATE_ENTRY_TYPE, state);
        }
      })
      .catch((error: unknown) => {
        notify(ctx, `Acontext sync failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
      });
    return pending;
  };

  runtime.on("session_start", async (_event, ctx) => {
    const piSessionFile = ctx.sessionManager.getSessionFile();
    latestContext = {
      piSessionId: ctx.sessionManager.getSessionId(),
      ...(piSessionFile ? { piSessionFile } : {}),
      cwd: ctx.cwd,
    };
    state = restoredState(ctx.sessionManager.getBranch());
    activeDreamPath = await loadActiveAutoDreamPath(config.autoDreamPublishRoot);
    rangeSelection = restoreProductionRangeSelection(ctx.sessionManager.getBranch(), PRODUCTION_RANGE_ENTRY_TYPE);
    ctx.ui.setStatus(
      "acontext-production",
      rangeSelection ? "Acontext/Refine ranges selected" : undefined,
    );

    if (!client || !synchronizer || !skillSynchronizer) {
      notify(ctx, "Acontext disabled: set ACONTEXT_API_KEY to enable session capture.", "warning");
      return;
    }

    await queueBranchSync(ctx);
    if (config.learningSpaceId) {
      try {
        const result = await skillSynchronizer.sync(config.learningSpaceId);
        activeSkillPath = result.path;
        notify(ctx, `Acontext skills ready: ${result.skillCount}`);
      } catch (error) {
        activeSkillPath = await skillSynchronizer.loadActivePath(config.learningSpaceId);
        notify(ctx, `Acontext skill refresh failed; using last valid cache: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    }
  });

  runtime.on("resources_discover", () => {
    return {
      skillPaths: [activeSkillPath, activeDreamPath].filter(
        (skillPath): skillPath is string => Boolean(skillPath),
      ),
    };
  });

  runtime.on("agent_settled", async (_event, ctx) => {
    await queueBranchSync(ctx);
  });

  runtime.on("session_shutdown", async (_event, ctx) => {
    await Promise.race([
      pending,
      new Promise<void>((resolve) => setTimeout(resolve, config.shutdownTimeoutMs)),
    ]);
    if (state) notify(ctx, `Acontext session: ${state.acontextSessionId}`);
  });

  runtime.registerCommand("acontext-status", {
    description: "Show Acontext connection, session, and skill-cache status",
    handler: async (_args, ctx) => {
      if (!client) {
        notify(ctx, "Acontext disabled: ACONTEXT_API_KEY is not set.", "warning");
        return;
      }
      try {
        const pong = await client.ping();
        notify(
          ctx,
          `Acontext ${pong}; session=${state?.acontextSessionId ?? "not-created"}; skills=${activeSkillPath ?? "not-loaded"}; productionRanges=${rangeSelection ? "selected" : "not-selected"}`,
        );
      } catch (error) {
        notify(ctx, `Acontext unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  runtime.registerCommand("acontext-ranges", {
    description: "Select Acontext and Refine start/end entries on the active session branch",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) throw new Error("acontext-ranges requires TUI or RPC UI mode");
      const acontext = await selectRange(ctx, "Acontext 学习区间");
      if (!acontext) return;
      const refine = await selectRange(ctx, "Refine 提炼区间");
      if (!refine) return;
      rangeSelection = { version: 1, acontext, refine, selectedAt: new Date().toISOString() };
      runtime.appendEntry(PRODUCTION_RANGE_ENTRY_TYPE, rangeSelection);
      runtime.setLabel(acontext.startEntryId, "acontext-start");
      runtime.setLabel(acontext.endEntryId, "acontext-end");
      runtime.setLabel(refine.startEntryId, "refine-start");
      runtime.setLabel(refine.endEntryId, "refine-end");
      ctx.ui.setStatus("acontext-production", "Acontext/Refine ranges selected");
      notify(ctx, "Acontext 与 Refine 起止点已保存到当前 Agent session。");
    },
  });

  runtime.registerCommand("acontext-production-run", {
    description: "Run the isolated Acontext-to-Refine production pipeline for the selected session ranges",
    handler: async (_args, ctx) => {
      if (!client || !synchronizer) {
        notify(ctx, "Set ACONTEXT_API_KEY before running the production pipeline.", "error");
        return;
      }
      if (!rangeSelection) {
        notify(ctx, "Run /acontext-ranges first.", "warning");
        return;
      }
      if (!ctx.model) {
        notify(ctx, "Select a model before running the production pipeline.", "error");
        return;
      }
      ctx.ui.setStatus("acontext-production", "Production pipeline running");
      try {
        const piSessionFile = ctx.sessionManager.getSessionFile();
        const result = await runProductionPipeline({
          client,
          piSessionId: ctx.sessionManager.getSessionId(),
          ...(piSessionFile ? { piSessionFile } : {}),
          cwd: ctx.cwd,
          branch: ctx.sessionManager.getBranch(),
          selection: rangeSelection,
          runRoot: config.productionRunRoot,
          provider: ctx.model.provider,
          model: ctx.model.id,
          captureToolResults: config.captureToolResults,
          maxToolResultChars: config.maxToolResultChars,
          timeoutMs: config.productionTimeoutMs,
        });
        runtime.appendEntry(RUN_ENTRY_TYPE, result);
        ctx.ui.setStatus("acontext-production", "Production pipeline completed");
        notify(ctx, `生产链路完成：${result.manifestPath}`);
        if (config.autoDreamEnabled) {
          ctx.ui.setStatus("auto-dream", "Auto-Dream queued");
          void runAutoDream({
            cwd: ctx.cwd,
            sourceSkillPath: result.skillPath,
            refinedPolicyPath: result.refinedPolicyPath,
            runRoot: config.autoDreamRunRoot,
            publishRoot: config.autoDreamPublishRoot,
            provider: ctx.model.provider,
            model: ctx.model.id,
            timeoutMs: config.productionTimeoutMs,
            onProgress: (phase) => ctx.ui.setStatus("auto-dream", `Auto-Dream ${phase}`),
          }).then((dream) => {
            if (dream.activeSkillPath) activeDreamPath = dream.activeSkillPath;
            runtime.appendEntry(DREAM_ENTRY_TYPE, dream);
            ctx.ui.setStatus("auto-dream", `Auto-Dream ${dream.status}`);
            notify(ctx, `Auto-Dream ${dream.status}：${dream.manifestPath ?? dream.reason ?? dream.runId}`);
          }).catch((error: unknown) => {
            ctx.ui.setStatus("auto-dream", "Auto-Dream failed");
            notify(ctx, `Auto-Dream 失败：${error instanceof Error ? error.message : String(error)}`, "error");
          });
        }
      } catch (error) {
        ctx.ui.setStatus("acontext-production", "Production pipeline failed");
        notify(ctx, `生产链路失败：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  runtime.registerCommand("auto-dream-rollback", {
    description: "Switch the active Auto-Dream skill back to its previous immutable snapshot",
    handler: async (_args, ctx) => {
      try {
        activeDreamPath = await rollbackAutoDream(config.autoDreamPublishRoot);
        notify(ctx, `Auto-Dream 已回滚到：${activeDreamPath}`);
      } catch (error) {
        notify(ctx, `Auto-Dream 回滚失败：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  runtime.registerCommand("acontext-import-codex", {
    description: "Project a Codex rollout into a real Agent session and switch to it",
    handler: async (args, ctx) => {
      const root = process.env.CODEX_SESSION_ROOT?.trim() || join(homedir(), ".codex", "sessions");
      const candidates = await discoverCodexRollouts(root, ctx.cwd);
      let sourcePath: string | undefined;
      const requested = args.trim();
      if (requested) {
        if (requested.toLowerCase().endsWith(".jsonl")) sourcePath = resolve(requested);
        else sourcePath = candidates.find((candidate) => candidate.sessionId === requested || candidate.sessionId.startsWith(requested))?.path;
        if (!sourcePath) {
          notify(ctx, `Codex rollout not found: ${requested}`, "error");
          return;
        }
      } else {
        if (!ctx.hasUI) {
          notify(ctx, "Provide a rollout path or Codex session id.", "warning");
          return;
        }
        const selected = await ctx.ui.select("选择要投影为 Agent session 的 Codex session", candidates.map((candidate) => candidate.label));
        if (!selected) return;
        sourcePath = candidates.find((candidate) => candidate.label === selected)?.path;
      }
      if (!sourcePath) return;
      const outputPath = join(
        ctx.sessionManager.getSessionDir(),
        `codex-projected-${new Date().toISOString().replace(/[:.]/g, "-")}-${basename(sourcePath, ".jsonl")}.jsonl`,
      );
      const projection = await writeCodexSessionProjection(sourcePath, outputPath, {
        cwd: ctx.cwd,
        sessionName: `Codex production · ${basename(sourcePath, ".jsonl")}`,
      });
      await ctx.switchSession(projection.outputPath, {
        withSession: async (replacement) => {
          replacement.ui.notify(
            `Codex session 已投影为 Agent session：${projection.manifest.counts.user} 条用户消息，${projection.manifest.counts.assistant_final} 条最终回复，${projection.manifest.counts.tool_call} 次工具调用。`,
            "info",
          );
        },
      });
    },
  });

  runtime.registerCommand("acontext-learn", {
    description: "Flush the current session and learn it into the configured Acontext learning space",
    handler: async (_args, ctx) => {
      if (!client || !config.learningSpaceId) {
        notify(ctx, "Set ACONTEXT_API_KEY and ACONTEXT_LEARNING_SPACE_ID before learning.", "warning");
        return;
      }
      await queueBranchSync(ctx);
      if (!state) {
        notify(ctx, "Acontext session was not created.", "error");
        return;
      }
      try {
        await client.sessions.flush(state.acontextSessionId);
        const result = await client.learningSpaces.waitForLearning({
          spaceId: config.learningSpaceId,
          sessionId: state.acontextSessionId,
          timeout: 120,
        });
        notify(ctx, `Acontext learning finished: ${result.status}`, result.status === "completed" ? "info" : "warning");
      } catch (error) {
        notify(ctx, `Acontext learning failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  runtime.registerCommand("acontext-sync", {
    description: "Refresh learned Acontext skills and reload Agent resources",
    handler: async (_args, ctx) => {
      if (!skillSynchronizer || !config.learningSpaceId) {
        notify(ctx, "Set ACONTEXT_API_KEY and ACONTEXT_LEARNING_SPACE_ID before syncing skills.", "warning");
        return;
      }
      try {
        const result = await skillSynchronizer.sync(config.learningSpaceId);
        activeSkillPath = result.path;
        notify(ctx, `Acontext skills synchronized: ${result.skillCount}`);
        await ctx.reload();
      } catch (error) {
        notify(ctx, `Acontext skill sync failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
