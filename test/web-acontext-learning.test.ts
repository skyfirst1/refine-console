import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AcontextGateway } from "../src/contracts.js";
import { runAcontextRangeLearning } from "../src/web-acontext-learning.js";

function message(id: string, parentId: string | null, role: "user" | "assistant", content: string): SessionEntry {
  if (role === "user") return { type: "message", id, parentId, timestamp: "2026-08-25T00:00:00.000Z", message: { role, content, timestamp: 0 } };
  return {
    type: "message", id, parentId, timestamp: "2026-08-25T00:00:01.000Z",
    message: {
      role, content: [{ type: "text", text: content }], api: "openai-completions", provider: "test", model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: 0,
    },
  };
}

test("Acontext range learning consumes conversation text without document artifacts", async () => {
  const cache = await mkdtemp(join(tmpdir(), "pi-acontext-range-"));
  const stored: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  let waitOptions: Record<string, unknown> | undefined;
  const client: AcontextGateway = {
    async ping() { return "pong"; },
    sessions: {
      async create() { return { id: "session-1" }; },
      async storeMessage(_sessionId, blob) { calls.push("store"); stored.push(blob); },
      async flush() { calls.push("flush"); },
      async copy() { return { old_session_id: "old", new_session_id: "new" }; },
    },
    learningSpaces: {
      async create() { return { id: "space-1" }; },
      async learn() { calls.push("learn"); return { status: "pending" }; },
      async waitForLearning(options) { calls.push("wait"); waitOptions = options; return { status: "completed" }; },
      async listSkills() {
        return [{ id: "skill-1", name: "preferences", description: "learned", updated_at: "2026-08-25T00:00:02.000Z", file_index: [{ path: "SKILL.md", mime: "text/markdown" }] }];
      },
    },
    skills: {
      async getFile() { return { path: "SKILL.md", mime: "text/markdown", content: { raw: "---\nname: preferences\ndescription: learned\n---\n" } }; },
    },
  };
  try {
    const toolOnly = message("tool-only", "u1", "assistant", "");
    if (toolOnly.type === "message" && toolOnly.message.role === "assistant") {
      toolOnly.message.content = [{ type: "toolCall", id: "call-1", name: "exec", arguments: { input: "inspect project" } }];
    }
    const branch = [message("u1", null, "user", "偏好简短回答"), toolOnly, message("a1", "tool-only", "assistant", "已记住")];
    const result = await runAcontextRangeLearning({
      client,
      branch,
      range: { startEntryId: "u1", endEntryId: "a1" },
      piSessionId: "pi-1",
      cwd: process.cwd(),
      skillCacheDir: cache,
      maxToolResultChars: 1000,
      timeoutMs: 1001,
    });
    assert.equal(result.storedMessages, 2);
    assert.equal(result.skillCount, 1);
    assert.deepEqual(stored.map((item) => item.role), ["user", "assistant"]);
    assert.deepEqual(calls, ["learn", "store", "store", "flush", "wait"]);
    assert.deepEqual(waitOptions, {
      spaceId: "space-1",
      sessionId: "session-1",
      timeout: 2,
      pollInterval: 1,
    });
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});

test("Acontext history replay stores messages one by one and blocks at the upstream buffer boundary", async () => {
  const cache = await mkdtemp(join(tmpdir(), "pi-acontext-progressive-"));
  const calls: string[] = [];
  const phases: string[] = [];
  const client: AcontextGateway = {
    async ping() { return "pong"; },
    project: {
      async getConfigs() { return { project_session_message_buffer_max_turns: 3 }; },
    },
    sessions: {
      async create() { return { id: "session-progressive" }; },
      async storeMessage() { calls.push("store"); },
      async flush() { calls.push("flush"); },
      async copy() { return { old_session_id: "old", new_session_id: "new" }; },
    },
    learningSpaces: {
      async create() { return { id: "space-progressive" }; },
      async learn() { calls.push("learn"); return { status: "pending" }; },
      async waitForLearning() { calls.push("wait"); return { status: "completed" }; },
      async listSkills() {
        return [{ id: "skill-progressive", name: "workflow", description: "learned", updated_at: "2026-08-25T00:00:02.000Z", file_index: [{ path: "SKILL.md", mime: "text/markdown" }] }];
      },
    },
    skills: {
      async getFile() { return { path: "SKILL.md", mime: "text/markdown", content: { raw: "---\nname: workflow\ndescription: learned\n---\n" } }; },
    },
  };
  try {
    const branch = Array.from({ length: 7 }, (_, index) => message(`u${index + 1}`, index === 0 ? null : `u${index}`, "user", `消息 ${index + 1}`));
    const result = await runAcontextRangeLearning({
      client,
      branch,
      range: { startEntryId: "u1", endEntryId: "u7" },
      piSessionId: "pi-progressive",
      cwd: process.cwd(),
      skillCacheDir: cache,
      maxToolResultChars: 1000,
      timeoutMs: 1000,
      onProgress: (progress) => phases.push(`${progress.phase}:${progress.storedMessages}`),
    });
    assert.equal(result.storedMessages, 7);
    assert.equal(calls.filter((call) => call === "store").length, 7);
    assert.equal(calls.filter((call) => call === "flush").length, 3);
    assert.deepEqual(calls, [
      "learn", "store", "store", "store", "flush", "store", "store", "store", "flush", "store", "flush", "wait",
    ]);
    assert.deepEqual(phases, [
      "preparing:0", "replaying:0", "replaying:1", "replaying:2", "replaying:3",
      "replaying:4", "replaying:5", "replaying:6", "replaying:7", "learning:7", "syncing:7",
    ]);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});
