import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AcontextGateway } from "../src/contracts.js";
import { SessionSynchronizer } from "../src/session-sync.js";

function fakeClient(): AcontextGateway & { stored: Record<string, unknown>[]; created: number } {
  const client = {
    stored: [] as Record<string, unknown>[],
    created: 0,
    async ping() { return "pong"; },
    sessions: {
      async create() {
        client.created += 1;
        return { id: `ac-${client.created}` };
      },
      async storeMessage(_sessionId: string, blob: Record<string, unknown>) {
        client.stored.push(blob);
      },
      async flush() {},
      async copy() { return { old_session_id: "old", new_session_id: "new" }; },
    },
    learningSpaces: {
      async learn() { return { status: "pending" }; },
      async waitForLearning() { return { status: "completed" }; },
      async listSkills() { return []; },
    },
    skills: { async getFile() { throw new Error("unused"); } },
  };
  return client;
}

function userEntry(id: string, parentId: string | null): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-24T00:00:00Z",
    message: { role: "user", content: id, timestamp: 1 },
  };
}

test("syncs only entries after the stored cursor", async () => {
  const client = fakeClient();
  const sync = new SessionSynchronizer(client, { captureToolResults: false, maxToolResultChars: 100 });
  const context = { piSessionId: "pi-1", cwd: "D:/repo" };
  const first = await sync.sync([userEntry("one", null)], undefined, context);
  const second = await sync.sync([userEntry("one", null), userEntry("two", "one")], first.state, context);

  assert.equal(client.created, 1);
  assert.equal(client.stored.length, 2);
  assert.equal(second.storedMessages, 1);
  assert.equal(second.state.lastSyncedEntryId, "two");
});

test("creates a new Acontext session when the cursor is not on the active branch", async () => {
  const client = fakeClient();
  const sync = new SessionSynchronizer(client, { captureToolResults: false, maxToolResultChars: 100 });
  const result = await sync.sync(
    [userEntry("new-root", null)],
    { acontextSessionId: "old-session", lastSyncedEntryId: "missing", syncedMessageCount: 4 },
    { piSessionId: "pi-1", cwd: "D:/repo" },
  );

  assert.equal(result.recreatedSession, true);
  assert.equal(result.state.acontextSessionId, "ac-1");
  assert.equal(result.state.syncedMessageCount, 1);
});
