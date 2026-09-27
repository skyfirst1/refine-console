import { parseArgs } from "node:util";
import { writeCodexSessionProjection } from "../src/codex-session-projection.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    input: { type: "string", short: "i" },
    output: { type: "string", short: "o" },
    cwd: { type: "string" },
    name: { type: "string" },
    "session-id": { type: "string" },
    start: { type: "string" },
    cutoff: { type: "string" },
    "max-tool-result-chars": { type: "string" },
  },
});

const input = values.input ?? positionals[0];
const output = values.output ?? positionals[1];
if (!input || !output) {
  throw new Error("Usage: tsx scripts/project-codex-session.ts --input <rollout.jsonl> --output <pi-session.jsonl> [--cwd <path>] [--name <session-name>] [--start <ISO>] [--cutoff <ISO>]");
}

const maxToolResultChars = values["max-tool-result-chars"] === undefined
  ? undefined
  : Number(values["max-tool-result-chars"]);
const result = await writeCodexSessionProjection(input, output, {
  ...(values.cwd ? { cwd: values.cwd } : {}),
  ...(values.name ? { sessionName: values.name } : {}),
  ...(values["session-id"] ? { sessionId: values["session-id"] } : {}),
  ...(values.start ? { startTimestamp: values.start } : {}),
  ...(values.cutoff ? { cutoffTimestamp: values.cutoff } : {}),
  ...(maxToolResultChars !== undefined ? { maxToolResultChars } : {}),
});

process.stdout.write(`${JSON.stringify({
  outputPath: result.outputPath,
  projectedSessionId: result.header.id,
  sourceSessionId: result.manifest.sourceSessionId,
  sourceRolloutSha256: result.manifest.sourceRolloutSha256,
  counts: result.manifest.counts,
}, null, 2)}\n`);
