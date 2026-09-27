import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AcontextClient } from "@acontext/acontext";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.js";
import type { AcontextGateway } from "../src/contracts.js";
import { shutdownPhoenixTracing } from "../src/phoenix-tracing.js";
import { runProductionPipeline } from "../src/production-pipeline.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    session: { type: "string", short: "s" },
    output: { type: "string", short: "o" },
    provider: { type: "string", default: "deepseek" },
    model: { type: "string", default: "deepseek-v4-flash" },
    "acontext-start": { type: "string" },
    "acontext-end": { type: "string" },
    "refine-start": { type: "string" },
    "refine-end": { type: "string" },
  },
});
const sessionPath = values.session ?? positionals[0];
if (!sessionPath) throw new Error("Usage: tsx scripts/run-production-session.ts --session <pi-session.jsonl> --output <run-root>");
const manager = SessionManager.open(sessionPath, dirname(sessionPath));
const branch = manager.getBranch();
const first = branch[0];
const last = branch.at(-1);
if (!first || !last) throw new Error("Agent session has no entries");
const config = loadConfig();
if (!config.apiKey) throw new Error("ACONTEXT_API_KEY is required");
const client: AcontextGateway = new AcontextClient({
  apiKey: config.apiKey,
  ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
});

try {
  const result = await runProductionPipeline({
    client,
    piSessionId: manager.getSessionId(),
    piSessionFile: resolve(sessionPath),
    cwd: manager.getCwd(),
    branch,
    selection: {
      version: 1,
      acontext: {
        startEntryId: values["acontext-start"] ?? first.id,
        endEntryId: values["acontext-end"] ?? last.id,
      },
      refine: {
        startEntryId: values["refine-start"] ?? first.id,
        endEntryId: values["refine-end"] ?? last.id,
      },
      selectedAt: new Date().toISOString(),
    },
    runRoot: resolve(values.output ?? config.productionRunRoot),
    provider: values.provider!,
    model: values.model!,
    captureToolResults: false,
    maxToolResultChars: config.maxToolResultChars,
    timeoutMs: config.productionTimeoutMs,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await shutdownPhoenixTracing();
}
