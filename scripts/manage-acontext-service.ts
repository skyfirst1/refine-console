import { AcontextServiceManager } from "../src/acontext-service-manager.js";

const action = process.argv[2]?.trim().toLowerCase() || "status";
const manager = new AcontextServiceManager();

async function main(): Promise<void> {
  const status = action === "start"
    ? await manager.start()
    : action === "stop"
      ? await manager.stop()
      : action === "status"
        ? await manager.status()
        : undefined;
  if (!status) throw new Error("Usage: npm run acontext-service -- start|status|stop");
  process.stdout.write(`${JSON.stringify({
    state: status.state,
    healthy: status.healthy,
    apiBaseUrl: status.apiBaseUrl,
    serviceCount: status.services.length,
    services: status.services,
  }, null, 2)}\n`);
  if (action !== "stop" && !status.healthy) process.exitCode = 1;
}

await main();
