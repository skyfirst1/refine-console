import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { discoverGeneratedArtifacts } from "../src/artifact-discovery.js";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function artifactEntries(id: string, parentId: string | null, callId: string, path: string, timestamp: number): SessionEntry[] {
  const assistantId = `${id}-assistant`;
  return [
    {
      type: "message", id: assistantId, parentId, timestamp: new Date(timestamp).toISOString(),
      message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "write", arguments: { path } }], api: "openai-completions", provider: "test", model: "test", usage, stopReason: "toolUse", timestamp },
    },
    {
      type: "message", id: `${id}-result`, parentId: assistantId, timestamp: new Date(timestamp + 1).toISOString(),
      message: { role: "toolResult", toolCallId: callId, toolName: "write", content: [{ type: "text", text: `Wrote ${path}` }], details: {}, isError: false, timestamp: timestamp + 1 },
    },
  ];
}

test("artifact discovery ignores txt secrets and selects supported document outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-artifact-extensions-"));
  const key = join(root, "key.txt");
  const baseline = join(root, "baseline.md");
  const gold = join(root, "gold.md");
  await Promise.all([
    writeFile(key, "secret", "utf8"),
    writeFile(baseline, "# Draft", "utf8"),
    writeFile(gold, "# Final", "utf8"),
  ]);
  try {
    const entries = [
      ...artifactEntries("key", null, "c-key", key, 1),
      ...artifactEntries("baseline", "key-result", "c-baseline", baseline, 3),
      ...artifactEntries("gold", "baseline-result", "c-gold", gold, 5),
    ];
    const selection = await discoverGeneratedArtifacts(entries, root);
    assert.equal(selection.candidates.length, 2);
    assert.equal(selection.baseline.path, baseline);
    assert.equal(selection.gold.path, gold);
    assert.equal(selection.candidates.some((candidate) => candidate.path === key), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
