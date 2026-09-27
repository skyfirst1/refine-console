import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePublicTraceRecords } from "../src/refine-public-trace-records.js";
import type { RefineTraceIntegrityReport } from "../src/refine-trace-integrity.js";

const content = [{ type: "text", text: "complete public tool output" }];
const start = (id = "call-1") => ({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path: "document.md" } });
const end = (id = "call-1", value = content, isError = false) => ({ type: "tool_execution_end", toolCallId: id, toolName: "read", isError, result: { content: value, details: { lines: 7 } } });
const message = (id = "call-1", value = content, isError = false) => ({ type: "message_end", message: { role: "toolResult", toolCallId: id, isError, content: value, timestamp: 123 } });
const callMessage = (id = "call-1") => ({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "document.md" } }] } });
async function row(events: unknown[], invocationId = "run:stage:attempt-1") {
  const directory = await mkdtemp(join(tmpdir(), "public-records-")); const eventsPath = join(directory, "events.jsonl");
  await writeFile(eventsPath, events.map((event) => JSON.stringify(event)).join("\n"));
  return { invocationId, stage: "review", attempt: 1, status: "completed", eventsPath, eventsSha256: null, errorObservation: null } as RefineTraceIntegrityReport["completenessMatrix"][number];
}
test("canonical result stores content once with both source refs and wrapper metadata", async () => {
  const records = await normalizePublicTraceRecords([await row([start(), end(), message()])]);
  const result = records.filter((item) => item.kind.startsWith("tool_result"));
  assert.equal(result.length, 1); assert.equal(result[0]!.text, JSON.stringify(content));
  assert.equal(result[0]!.sources.length, 2);
  assert.deepEqual(result[0]!.sources.map((source) => source.eventRef.split(":").at(-1)), ["L2", "L3"]);
  assert.deepEqual(result[0]!.sources[0]!.metadata.resultMetadata, { details: { lines: 7 } });
  assert.equal((result[0]!.sources[1]!.metadata.messageMetadata as Record<string, unknown>).timestamp, 123);
});

test("tool-call mirrors share one payload per actual execution, with all source refs", async () => {
  for (const secondId of ["call-1", "call-2"]) {
    const records = await normalizePublicTraceRecords([await row([callMessage(), start(), end(), message(), callMessage(secondId), start(secondId), end(secondId), message(secondId)])]);
    const calls = records.filter(record => record.kind.startsWith("tool_call"));
    assert.equal(calls.length, 2);
    assert.ok(calls.every(record => record.sources.length === 2));
    assert.deepEqual(calls[0]!.sources.map(source => source.eventType), ["message_end", "tool_execution_start"]);
  }
  const reversed = await normalizePublicTraceRecords([await row([start(), callMessage(), end(), message()])]);
  assert.equal(reversed.filter(record => record.kind.startsWith("tool_call")).length, 1);
});
test("content conflicts and error-status conflicts survive", async () => {
  for (const other of [message("call-1", [{ type: "text", text: "different output" }]), message("call-1", content, true)]) {
    const records = await normalizePublicTraceRecords([await row([start(), end(), other])]);
    assert.equal(records.filter((item) => item.kind.startsWith("tool_result")).length, 2);
  }
});
test("identical output from different calls or repeated executions of one call id survives", async () => {
  for (const secondId of ["call-2", "call-1"]) {
    const records = await normalizePublicTraceRecords([await row([start(), end(), message(), start(secondId), end(secondId), message(secondId)])]);
    const results = records.filter((item) => item.kind.startsWith("tool_result"));
    assert.equal(results.length, 2); assert.ok(results.every((item) => item.sources.length === 2));
  }
});
test("identical text in distinct attempts and public corrections is never deduplicated", async () => {
  const text = { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "I retract the earlier answer." }] } };
  const first = await row([text, text, start(), end(), message()]); first.errorObservation = { source: "manifest", eventRef: null, message: "explicit failure" };
  const second = await row([start(), end(), message()], "run:stage:attempt-2"); second.attempt = 2;
  const records = await normalizePublicTraceRecords([first, second]);
  assert.equal(records.filter((item) => item.kind === "assistant_stop").length, 2);
  assert.equal(records.filter((item) => item.kind.startsWith("tool_result")).length, 2);
  assert.equal(records.filter((item) => item.kind === "manifest_error").length, 1);
});
test("unidentified results and same representation duplicates remain separate", async () => {
  const unbound = { type: "tool_execution_end", result: { content } };
  const records = await normalizePublicTraceRecords([await row([unbound, unbound, end(), end()])]);
  assert.equal(records.length, 4);
});
test("redaction applies to public content and metadata without merging distinct raw content", async () => {
  const a = end("call-1", [{ type: "text", text: "Bearer abcdefghijklmnop" }]);
  const b = message("call-1", [{ type: "text", text: "Bearer differentsecret" }]);
  const records = await normalizePublicTraceRecords([await row([a, b])]);
  assert.equal(records.length, 2); assert.doesNotMatch(JSON.stringify(records), /abcdefghijklmnop|differentsecret/);
});
