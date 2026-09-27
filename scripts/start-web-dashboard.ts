import { parseArgs } from "node:util";
import { startWebDashboard } from "../src/web-dashboard.js";

const { values } = parseArgs({
  options: {
    cwd: { type: "string", short: "C", default: process.cwd() },
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", short: "p", default: "4318" },
    "session-dir": { type: "string" },
  },
});

const port = Number.parseInt(values.port!, 10);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error("--port must be an integer between 0 and 65535");
}

const dashboard = await startWebDashboard({
  cwd: values.cwd!,
  host: values.host!,
  port,
  ...(values["session-dir"] ? { sessionDir: values["session-dir"] } : {}),
});

process.stdout.write(`loom: ${dashboard.url}\n`);

const close = async (): Promise<void> => {
  await dashboard.close();
  process.exit(0);
};
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
