import { writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AcontextClient } from "@acontext/acontext";
import { buildCodexTrainingSnapshot } from "../src/codex-import.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    input: { type: "string", short: "i" },
    "session-id": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    start: { type: "string" },
    cutoff: { type: "string" },
    context: { type: "string", multiple: true, default: [] },
    artifact: { type: "string", multiple: true, default: [] },
    snapshot: { type: "string" },
  },
});

const input = values.input ?? positionals[0];
const sourceSessionId = values["session-id"] ?? positionals[1];

if (!input || !sourceSessionId) {
  throw new Error("Usage: npm run import-codex -- <rollout.jsonl> <uuid> [--start <ISO>] [--cutoff <ISO>] [--context <file>] [--artifact <file>] [--snapshot <json>] [--dry-run]");
}

const snapshot = await buildCodexTrainingSnapshot(input, sourceSessionId, {
  ...(values.start ? { startTimestamp: values.start } : {}),
  ...(values.cutoff ? { cutoffTimestamp: values.cutoff } : {}),
  contextFiles: values.context,
  artifactFiles: values.artifact,
});
const messages = snapshot.messages;
if (values.snapshot) {
  await writeFile(resolve(values.snapshot), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}
const summary = {
  source: basename(input),
  sourceSessionId,
  messages: messages.length,
  roles: messages.reduce<Record<string, number>>((counts, message) => {
    const role = String(message.blob.role);
    counts[role] = (counts[role] ?? 0) + 1;
    return counts;
  }, {}),
  redactions: messages.reduce((total, message) => total + Number(message.meta.redaction_count ?? 0), 0),
  importedFiles: snapshot.files,
  sourceRolloutSha256: snapshot.sourceRolloutSha256,
  trainingContentSha256: snapshot.trainingContentSha256,
  snapshot: values.snapshot ? resolve(values.snapshot) : undefined,
};

if (values["dry-run"]) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(0);
}

const client = new AcontextClient();
const session = await client.sessions.create({
  configs: {
    source: "codex",
    codex_session_id: sourceSessionId,
    source_file_name: basename(input),
  },
});

for (const message of messages) {
  await client.sessions.storeMessage(session.id, message.blob, { format: "openai", meta: message.meta });
}
await client.sessions.flush(session.id);

process.stdout.write(`${JSON.stringify({ ...summary, acontextSessionId: session.id }, null, 2)}\n`);
