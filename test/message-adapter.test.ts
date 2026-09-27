import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { adaptSessionEntry } from "../src/message-adapter.js";

const options = {
  captureToolResults: true,
  maxToolResultChars: 20,
  sourceSessionId: "pi-session",
};

test("adapts user text and redacts credentials", () => {
  const entry = {
    type: "message",
    id: "user-1",
    parentId: null,
    timestamp: "2026-08-24T00:00:00Z",
    message: { role: "user", content: "token sk-ac-1234567890abcdef", timestamp: 1 },
  } as SessionEntry;

  const result = adaptSessionEntry(entry, options);
  assert.equal(result?.blob.role, "user");
  assert.equal(result?.blob.content, "token [REDACTED]");
  assert.equal(result?.meta.redaction_count, 1);
});

test("drops assistant thinking and preserves tool calls", () => {
  const entry = {
    type: "message",
    id: "assistant-1",
    parentId: "user-1",
    timestamp: "2026-08-24T00:00:01Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "Done" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 2,
    },
  } as SessionEntry;

  const result = adaptSessionEntry(entry, options);
  assert.equal(result?.blob.content, "Done");
  assert.deepEqual(result?.blob.tool_calls, [
    { id: "call-1", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } },
  ]);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("can reduce a projected assistant tool turn to text-only learning input", () => {
  const entry = {
    type: "message",
    id: "assistant-tool-only",
    parentId: "user-1",
    timestamp: "2026-08-24T00:00:01Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "exec", arguments: { input: "inspect project" } }],
      api: "openai-responses",
      provider: "openai",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 2,
    },
  } as SessionEntry;
  assert.equal(adaptSessionEntry(entry, { ...options, captureToolCalls: false }), undefined);
});

test("truncates tool results", () => {
  const entry = {
    type: "message",
    id: "tool-1",
    parentId: "assistant-1",
    timestamp: "2026-08-24T00:00:02Z",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "abcdefghijklmnopqrstuvwxyz" }],
      isError: false,
      timestamp: 3,
    },
  } as SessionEntry;

  const result = adaptSessionEntry(entry, options);
  assert.equal(result?.blob.role, "tool");
  assert.equal(result?.meta.truncated, true);
  assert.match(String(result?.blob.content), /TRUNCATED/);
});
