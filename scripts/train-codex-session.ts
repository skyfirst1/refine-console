import { writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AcontextClient } from "@acontext/acontext";
import { buildCodexTrainingSnapshot } from "../src/codex-import.js";
import { phoenixTracingEnabled, shutdownPhoenixTracing, tracePhoenixTurn } from "../src/phoenix-tracing.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    input: { type: "string", short: "i" },
    "session-id": { type: "string" },
    timeout: { type: "string", default: "900" },
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
  throw new Error("Usage: npm run train-codex -- <rollout.jsonl> <uuid> [--start <ISO>] [--cutoff <ISO>] [--context <file>] [--artifact <file>] [--snapshot <json>]");
}

const timeout = Number.parseInt(values.timeout ?? "900", 10);
if (!Number.isFinite(timeout) || timeout <= 0) {
  throw new Error("--timeout must be a positive number of seconds");
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
let historicalTurns = 0;
if (phoenixTracingEnabled()) {
  let pendingInputs: string[] = [];
  for (const message of messages) {
    if (message.blob.role === "user") {
      pendingInputs.push(String(message.blob.content));
      continue;
    }
    const isArtifact = message.meta.source === "codex_artifact";
    const turn = ++historicalTurns;
    const inputValue = pendingInputs.length > 0
      ? pendingInputs.join("\n\n")
      : JSON.stringify({ source: "historical-codex-artifact", path: message.meta.source_path });
    pendingInputs = [];
    await tracePhoenixTurn({
      name: `T${String(turn).padStart(2, "0")} ${isArtifact ? "Historical final DOCX artifact" : "Historical Codex document turn"}`,
      kind: "AGENT",
      input: inputValue,
      run: async () => String(message.blob.content),
      output: (content) => content,
    });
  }
}

const learning = await tracePhoenixTurn({
  name: `T${String(historicalTurns + 1).padStart(2, "0")} Acontext learning from historical Codex trace`,
  kind: "AGENT",
  input: JSON.stringify({
    sourceSessionId,
    sourceRolloutPath: snapshot.sourceRolloutPath,
    sourceRolloutSha256: snapshot.sourceRolloutSha256,
    trainingContentSha256: snapshot.trainingContentSha256,
    startTimestamp: snapshot.startTimestamp,
    cutoffTimestamp: snapshot.cutoffTimestamp,
    importedMessages: messages.length,
    importedFiles: snapshot.files,
  }),
  run: async () => {
    const client = new AcontextClient();
    const space = await client.learningSpaces.create({
      meta: {
        purpose: "pi-acontext-real-word-validation",
        source: "historical-codex-document-generation",
      },
    });
    const session = await client.sessions.create({
      configs: {
        source: "codex",
        codex_session_id: sourceSessionId,
        source_file_name: basename(input),
      },
    });

    // Register before flushing so Acontext receives the learning queue event.
    await client.learningSpaces.learn({ spaceId: space.id, sessionId: session.id });
    for (const message of messages) {
      await client.sessions.storeMessage(session.id, message.blob, { format: "openai", meta: message.meta });
    }
    await client.sessions.flush(session.id);
    let result = await client.learningSpaces.waitForLearning({
      spaceId: space.id,
      sessionId: session.id,
      timeout,
      pollInterval: 3,
    });
    // The local async learner can briefly publish `failed` while its skill agent
    // is still draining pending contexts, then transition the same record to
    // `completed`. Give that final merge a bounded grace period.
    if (result.status !== "completed") {
      const graceDeadline = Date.now() + 60_000;
      while (Date.now() < graceDeadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));
        result = await client.learningSpaces.getSession({ spaceId: space.id, sessionId: session.id });
        if (result.status === "completed") break;
      }
    }
    const skills = await client.learningSpaces.listSkills(space.id);
    return { client, space, session, result, skills };
  },
  output: ({ space, session, result, skills }) => JSON.stringify({
    acontextSessionId: session.id,
    learningSpaceId: space.id,
    status: result.status,
    skills: skills.map((skill) => ({ name: skill.name, files: skill.file_index.map((file) => file.path) })),
  }),
});

const { space, session, result, skills } = learning;

process.stdout.write(`${JSON.stringify({
  sourceSessionId,
  acontextSessionId: session.id,
  learningSpaceId: space.id,
  importedMessages: messages.length,
  importedFiles: snapshot.files,
  sourceRolloutSha256: snapshot.sourceRolloutSha256,
  trainingContentSha256: snapshot.trainingContentSha256,
  phoenixHistoricalTurns: historicalTurns,
  snapshot: values.snapshot ? resolve(values.snapshot) : undefined,
  status: result.status,
  skills: skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    files: skill.file_index.map((file) => file.path),
  })),
}, null, 2)}\n`);

if (result.status !== "completed" || skills.length === 0) {
  process.exitCode = 1;
}
await shutdownPhoenixTracing();
