import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  CODEX_PROJECTION_CUSTOM_TYPE,
  projectCodexRollout,
  writeCodexSessionProjection,
} from "../src/codex-session-projection.js";

function fixtureRollout(): string {
  const records = [
    { timestamp: "2026-08-25T01:00:00.000Z", type: "session_meta", payload: { id: "codex-source-1", cwd: "D:\\workspace", model_provider: "openai" } },
    { timestamp: "2026-08-25T01:00:01.000Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "DEVELOPER_SECRET_REASONING" }] } },
    { timestamp: "2026-08-25T01:00:02.000Z", type: "event_msg", payload: { type: "user_message", message: "## My request for Codex:\nCreate the report" } },
    { timestamp: "2026-08-25T01:00:03.000Z", type: "response_item", payload: { type: "reasoning", summary: [{ text: "HIDDEN_REASONING_RESPONSE" }], encrypted_content: "opaque" } },
    { timestamp: "2026-08-25T01:00:04.000Z", type: "event_msg", payload: { type: "agent_reasoning", text: "HIDDEN_REASONING_EVENT" } },
    { timestamp: "2026-08-25T01:00:05.000Z", type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: "COMMENTARY_NOT_FINAL" } },
    { timestamp: "2026-08-25T01:00:06.000Z", type: "response_item", payload: { type: "custom_tool_call", id: "item-call", call_id: "call-1", name: "exec", input: "inspect D:\\workspace" } },
    { timestamp: "2026-08-25T01:00:07.000Z", type: "response_item", payload: { type: "custom_tool_call_output", id: "item-result", call_id: "call-1", output: "Created D:\\workspace\\final-report.docx" } },
    { timestamp: "2026-08-25T01:00:08.000Z", type: "response_item", payload: { type: "function_call", id: "item-function", call_id: "call-2", name: "inspect", arguments: "{\"path\":\"D:\\\\workspace\\\\final-report.docx\",\"token\":\"sk-proj-1234567890abcdef\"}" } },
    { timestamp: "2026-08-25T01:00:09.000Z", type: "response_item", payload: { type: "function_call_output", id: "item-function-result", call_id: "call-2", output: { ok: true, pages: 3 } } },
    { timestamp: "2026-08-25T01:00:10.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Finished the report." }] } },
    { timestamp: "2026-08-25T01:00:11.000Z", type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "Finished the report." } },
    { timestamp: "2026-08-25T01:00:12.000Z", type: "compacted", payload: { summary: "HIDDEN_COMPACTION_SUMMARY" } },
  ];
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

test("projects public conversation and tool evidence without hidden reasoning", () => {
  const projection = projectCodexRollout(fixtureRollout(), "D:/rollouts/source.jsonl", { sessionName: "Projected production run" });
  const serialized = projection.jsonl;

  assert.equal(projection.header.version, 3);
  assert.equal(projection.header.id, "codex-codex-source-1");
  assert.deepEqual(projection.manifest.counts, { user: 1, assistant_final: 1, tool_call: 2, tool_result: 2 });
  assert.equal(serialized.includes("HIDDEN_REASONING_RESPONSE"), false);
  assert.equal(serialized.includes("HIDDEN_REASONING_EVENT"), false);
  assert.equal(serialized.includes("HIDDEN_COMPACTION_SUMMARY"), false);
  assert.equal(serialized.includes("DEVELOPER_SECRET_REASONING"), false);
  assert.equal(serialized.includes("COMMENTARY_NOT_FINAL"), false);
  assert.equal(serialized.includes("sk-proj-1234567890abcdef"), false);
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /final-report\.docx/);
  assert.equal(projection.manifest.mappings.length, 6);
  assert.ok(projection.manifest.mappings.every((mapping) => projection.entries.some((entry) => entry.id === mapping.piEntryId)));
  const manifestEntry = projection.entries.at(-1);
  assert.equal(manifestEntry?.type, "custom");
  assert.equal(manifestEntry?.type === "custom" ? manifestEntry.customType : undefined, CODEX_PROJECTION_CUSTOM_TYPE);
});

test("writes a fresh session that SessionManager.open and list can read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pi-projection-"));
  const rollout = join(directory, "rollout.jsonl");
  const session = join(directory, "projected.jsonl");
  try {
    await writeFile(rollout, fixtureRollout(), "utf8");
    const written = await writeCodexSessionProjection(rollout, session, {
      cwd: directory,
      sessionName: "Projected production run",
    });
    assert.equal(written.outputPath, session);

    const manager = SessionManager.open(session, directory);
    assert.equal(manager.getSessionId(), "codex-codex-source-1");
    assert.equal(manager.getSessionName(), "Projected production run");
    assert.equal(manager.getBranch().length, written.entries.length);
    assert.deepEqual(
      manager.buildSessionContext().messages.map((message) => message.role),
      ["user", "assistant", "toolResult", "assistant", "toolResult", "assistant"],
    );

    const listed = await SessionManager.list(directory, directory);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.path, session);
    assert.equal(listed[0]?.name, "Projected production run");
    assert.equal(listed[0]?.messageCount, 6);

    await assert.rejects(() => writeCodexSessionProjection(rollout, session), (error: NodeJS.ErrnoException) => error.code === "EEXIST");
    assert.equal((await readFile(session, "utf8")).includes("sourceRolloutSha256"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("honors a timestamp window and validates its boundaries", () => {
  const projected = projectCodexRollout(fixtureRollout(), "D:/rollouts/source.jsonl", {
    startTimestamp: "2026-08-25T01:00:06.000Z",
    cutoffTimestamp: "2026-08-25T01:00:09.000Z",
  });
  assert.deepEqual(projected.manifest.counts, { user: 0, assistant_final: 0, tool_call: 2, tool_result: 2 });
  assert.throws(
    () => projectCodexRollout(fixtureRollout(), "D:/rollouts/source.jsonl", {
      startTimestamp: "2026-08-25T02:00:00.000Z",
      cutoffTimestamp: "2026-08-25T01:00:00.000Z",
    }),
    /must not be later/,
  );
});

test("omits an in-flight tool call that has no result yet", () => {
  const rollout = `${fixtureRollout()}${JSON.stringify({
    timestamp: "2026-08-25T01:00:13.000Z",
    type: "response_item",
    payload: { type: "function_call", call_id: "still-running", name: "write", arguments: "{}" },
  })}\n`;
  const projection = projectCodexRollout(rollout, "D:/rollouts/live.jsonl");
  assert.equal(projection.manifest.counts.tool_call, projection.manifest.counts.tool_result);
  assert.equal(projection.jsonl.includes("still-running"), false);
});
