import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AcontextServiceManager } from "./acontext-service-manager.js";

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function serviceSummary(status: Awaited<ReturnType<AcontextServiceManager["status"]>>): string {
  const counts = status.services.reduce<Record<string, number>>((result, service) => {
    result[service.state] = (result[service.state] ?? 0) + 1;
    return result;
  }, {});
  return `Acontext sidecar ${status.state}; API=${status.apiBaseUrl}; services=${status.services.length}; running=${counts.running ?? 0}`;
}

export function registerAcontextServiceCommands(runtime: ExtensionAPI, manager: AcontextServiceManager): void {
  runtime.registerCommand("acontext-service-start", {
    description: "Start the minimal local Acontext sidecar managed by this Agent package",
    handler: async (_args, ctx) => {
      try {
        ctx.ui.setStatus("acontext-service", "Starting local Acontext");
        const status = await manager.start();
        ctx.ui.setStatus("acontext-service", "Local Acontext running");
        notify(ctx, serviceSummary(status));
      } catch (error) {
        ctx.ui.setStatus("acontext-service", "Local Acontext failed");
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  runtime.registerCommand("acontext-service-status", {
    description: "Health-check the locally managed local Acontext sidecar",
    handler: async (_args, ctx) => {
      try {
        const status = await manager.status();
        notify(ctx, `${serviceSummary(status)}; ${await manager.redactedConfigurationSummary()}`, status.healthy ? "info" : "warning");
      } catch (error) {
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  runtime.registerCommand("acontext-service-stop", {
    description: "Stop the locally managed local Acontext sidecar without deleting persisted data",
    handler: async (_args, ctx) => {
      try {
        ctx.ui.setStatus("acontext-service", "Stopping local Acontext");
        const status = await manager.stop();
        ctx.ui.setStatus("acontext-service", undefined);
        notify(ctx, serviceSummary(status));
      } catch (error) {
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  if (manager.config.autoStart) {
    runtime.on("session_start", async (_event, ctx) => {
      try {
        const status = await manager.status();
        if (!status.healthy) await manager.start();
        ctx.ui.setStatus("acontext-service", "Local Acontext running");
      } catch (error) {
        notify(ctx, `Acontext auto-start failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    });
  }
}
