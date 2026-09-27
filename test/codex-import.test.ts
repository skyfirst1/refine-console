import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCodexTrainingSnapshot, extractCodexMessages } from "../src/codex-import.js";

test("extracts only user and final assistant events", () => {
  const records = [
    { timestamp: "t1", type: "event_msg", payload: { type: "user_message", message: "Create a guide" } },
    { timestamp: "t2", type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: "Working" } },
    { timestamp: "t3", type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "Finished" } },
    { timestamp: "t4", type: "response_item", payload: { type: "reasoning", encrypted_content: "secret" } },
  ];
  const messages = extractCodexMessages(records.map((record) => JSON.stringify(record)).join("\n"), "codex-1");
  assert.deepEqual(messages.map((message) => message.blob), [
    { role: "user", content: "Create a guide" },
    { role: "assistant", content: "Finished" },
  ]);
});

test("deduplicates repeated final events", () => {
  const record = JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", phase: "final_answer", message: "Finished" },
  });
  assert.equal(extractCodexMessages(`${record}\n${record}`, "codex-1").length, 1);
});

test("applies an immutable cutoff before later session messages", () => {
  const records = [
    { timestamp: "2026-08-24T01:00:00Z", type: "event_msg", payload: { type: "user_message", message: "Teacher task" } },
    { timestamp: "2026-08-24T01:01:00Z", type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "Teacher complete" } },
    { timestamp: "2026-08-24T02:00:00Z", type: "event_msg", payload: { type: "user_message", message: "Unrelated follow-up" } },
  ];
  const messages = extractCodexMessages(records.map((record) => JSON.stringify(record)).join("\n"), "codex-1", {
    cutoffTimestamp: "2026-08-24T01:01:00Z",
  });
  assert.deepEqual(messages.map((message) => message.blob.content), ["Teacher task", "Teacher complete"]);
});

test("selects a historical time window and removes ambient browser context", () => {
  const records = [
    { timestamp: "2026-07-15T07:00:00Z", type: "event_msg", payload: { type: "user_message", message: "Earlier unrelated work" } },
    { timestamp: "2026-07-15T08:00:00Z", type: "event_msg", payload: { type: "user_message", message: '<in-app-browser-context source="ambient-ui-state">noise</in-app-browser-context>\n\n## My request for Codex:\nWrite the technical summary' } },
    { timestamp: "2026-07-15T08:01:00Z", type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "Summary complete" } },
    { timestamp: "2026-07-15T09:00:00Z", type: "event_msg", payload: { type: "user_message", message: "Later unrelated work" } },
  ];
  const messages = extractCodexMessages(records.map((record) => JSON.stringify(record)).join("\n"), "codex-1", {
    startTimestamp: "2026-07-15T08:00:00Z",
    cutoffTimestamp: "2026-07-15T08:01:00Z",
  });
  assert.deepEqual(messages.map((message) => message.blob.content), ["Write the technical summary", "Summary complete"]);
});

test("injects context before the final answer and the delivered artifact after it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-training-"));
  const rollout = join(directory, "rollout.jsonl");
  const context = join(directory, "rubric.md");
  const artifact = join(directory, "guide.md");
  try {
    await Promise.all([
      writeFile(rollout, [
        JSON.stringify({ timestamp: "t1", type: "event_msg", payload: { type: "user_message", message: "Write a guide" } }),
        JSON.stringify({ timestamp: "t2", type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "Complete" } }),
      ].join("\n"), "utf8"),
      writeFile(context, "Score accuracy and structure.", "utf8"),
      writeFile(artifact, "# Final guide\n\nVerified content.", "utf8"),
    ]);
    const snapshot = await buildCodexTrainingSnapshot(rollout, "codex-1", {
      contextFiles: [context],
      artifactFiles: [artifact],
    });
    assert.deepEqual(snapshot.messages.map((message) => message.blob.role), ["user", "user", "assistant", "assistant"]);
    assert.match(String(snapshot.messages[1]?.blob.content), /Score accuracy/);
    assert.match(String(snapshot.messages[3]?.blob.content), /# Final guide/);
    assert.equal(snapshot.files.length, 2);
    assert.equal(snapshot.files[1]?.characters, 32);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
