import { parseArgs } from "node:util";
import { AcontextClient } from "@acontext/acontext";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "session-id": { type: "string" },
    timeout: { type: "string", default: "900" },
    copy: { type: "boolean", default: false },
  },
});

const sourceSessionId = values["session-id"] ?? positionals[0];
if (!sourceSessionId) {
  throw new Error("Usage: tsx scripts/learn-session.ts --session-id <acontext-session-uuid>");
}

const timeout = Number.parseInt(values.timeout ?? "900000", 10);
if (!Number.isFinite(timeout) || timeout <= 0) {
  throw new Error("--timeout must be a positive number of seconds");
}

const client = new AcontextClient();
let sessionId = sourceSessionId;
if (values.copy) {
  const copied = await client.sessions.copy(sourceSessionId);
  sessionId = copied.new_session_id;
}
const space = await client.learningSpaces.create({
  meta: {
    purpose: "pi-acontext-validation",
    source: "codex-document-generation",
  },
});
await client.learningSpaces.learn({ spaceId: space.id, sessionId });
const result = await client.learningSpaces.waitForLearning({
  spaceId: space.id,
  sessionId,
  timeout,
  pollInterval: 3,
});
const skills = await client.learningSpaces.listSkills(space.id);

process.stdout.write(`${JSON.stringify({
  learningSpaceId: space.id,
  sourceSessionId,
  sessionId,
  status: result.status,
  skills: skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    files: skill.file_index.map((file) => file.path),
  })),
}, null, 2)}\n`);

if (result.status !== "completed") {
  process.exitCode = 1;
}
