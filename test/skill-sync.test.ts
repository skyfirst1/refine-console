import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AcontextGateway } from "../src/contracts.js";
import { changedSkillFiles, resolveSafeRelativePath, SkillSynchronizer } from "../src/skill-sync.js";

test("rejects skill paths that escape the cache", () => {
  assert.throws(() => resolveSafeRelativePath("D:/cache", "../secret.txt"), /Unsafe skill path/);
  assert.throws(() => resolveSafeRelativePath("D:/cache", "C:/secret.txt"), /Unsafe skill path/);
});

test("requires a content-level learning delta", () => {
  assert.deepEqual(changedSkillFiles(
    { files: { "skill:SKILL.md": "same" }, unavailable: [] },
    { files: { "skill:SKILL.md": "same", "skill:learned.md": "new" }, unavailable: [] },
  ), ["skill:learned.md"]);
  assert.deepEqual(changedSkillFiles(
    { files: { "skill:SKILL.md": "same" }, unavailable: [] },
    { files: { "skill:SKILL.md": "same" }, unavailable: [] },
  ), []);
});

test("downloads a validated skill snapshot", async () => {
  const cache = await mkdtemp(join(tmpdir(), "pi-acontext-test-"));
  const client: AcontextGateway = {
    async ping() { return "pong"; },
    sessions: {
      async create() { return { id: "unused" }; },
      async storeMessage() {},
      async flush() {},
      async copy() { return { old_session_id: "old", new_session_id: "new" }; },
    },
    learningSpaces: {
      async learn() { return { status: "pending" }; },
      async waitForLearning() { return { status: "completed" }; },
      async listSkills() {
        return [{
          id: "12345678-1234-1234-1234-123456789012",
          name: "document-style",
          description: "Writing guidance",
          updated_at: "2026-08-24T00:00:00Z",
          file_index: [{ path: "SKILL.md", mime: "text/markdown" }],
        }];
      },
    },
    skills: {
      async getFile() {
        return { path: "SKILL.md", mime: "text/markdown", content: { raw: "# Document Style\n" } };
      },
    },
  };

  try {
    const sync = new SkillSynchronizer(client, cache);
    const result = await sync.sync("space-1");
    assert.equal(result.skillCount, 1);
    assert.equal(
      await readFile(join(result.path, "document-style-12345678", "SKILL.md"), "utf8"),
      "# Document Style\n",
    );
    assert.equal(await sync.loadActivePath("space-1"), result.path);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});

test("downloads only explicitly included skills", async () => {
  const cache = await mkdtemp(join(tmpdir(), "pi-acontext-filter-test-"));
  const skills = ["integration-patterns", "daily-logs"].map((name, index) => ({
    id: `${index + 1}2345678-1234-1234-1234-123456789012`,
    name,
    description: name,
    updated_at: "2026-08-24T00:00:00Z",
    file_index: [{ path: "SKILL.md", mime: "text/markdown" }],
  }));
  const client = {
    async ping() { return "pong"; },
    sessions: {
      async create() { return { id: "unused" }; }, async storeMessage() {}, async flush() {},
      async copy() { return { old_session_id: "old", new_session_id: "new" }; },
    },
    learningSpaces: {
      async learn() { return { status: "pending" }; }, async waitForLearning() { return { status: "completed" }; },
      async listSkills() { return skills; },
    },
    skills: { async getFile() { return { path: "SKILL.md", mime: "text/markdown", content: { raw: "# Included\n" } }; } },
  } satisfies AcontextGateway;

  try {
    const result = await new SkillSynchronizer(client, cache, 1_000_000, ["integration-patterns"]).sync("space-1");
    assert.equal(result.skillCount, 1);
    assert.equal(await readFile(join(result.path, "integration-patterns-12345678", "SKILL.md"), "utf8"), "# Included\n");
    await assert.rejects(readFile(join(result.path, "daily-logs-22345678", "SKILL.md"), "utf8"));
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});

test("indexes learned markdown files from the root skill manifest", async () => {
  const cache = await mkdtemp(join(tmpdir(), "pi-acontext-index-test-"));
  const client = {
    async ping() { return "pong"; },
    sessions: {
      async create() { return { id: "unused" }; }, async storeMessage() {}, async flush() {},
      async copy() { return { old_session_id: "old", new_session_id: "new" }; },
    },
    learningSpaces: {
      async learn() { return { status: "pending" }; }, async waitForLearning() { return { status: "completed" }; },
      async listSkills() {
        return [{
          id: "12345678-1234-1234-1234-123456789012", name: "integration-patterns", description: "patterns",
          updated_at: "2026-08-24T00:00:00Z",
          file_index: [{ path: "SKILL.md", mime: "text/markdown" }, { path: "paired-validation.md", mime: "text/markdown" }],
        }];
      },
    },
    skills: {
      async getFile({ filePath }: { skillId: string; filePath: string }) {
        return { path: filePath, mime: "text/markdown", content: { raw: filePath === "SKILL.md" ? "# Patterns\n" : "# Paired validation\n" } };
      },
    },
  } satisfies AcontextGateway;

  try {
    const result = await new SkillSynchronizer(client, cache).sync("space-1");
    const manifest = await readFile(join(result.path, "integration-patterns-12345678", "SKILL.md"), "utf8");
    assert.match(manifest, /Learned memory files/);
    assert.match(manifest, /\[paired-validation\.md\]\(\.\/paired-validation\.md\)/);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});

test("audits a stale missing skill file and keeps other downloadable skills", async () => {
  const cache = await mkdtemp(join(tmpdir(), "pi-acontext-stale-file-test-"));
  const skills = ["stale", "valid"].map((name, index) => ({
    id: `${index + 1}2345678-1234-1234-1234-123456789012`,
    name,
    description: name,
    updated_at: "2026-08-25T00:00:00Z",
    file_index: [{ path: "SKILL.md", mime: "text/markdown" }],
  }));
  const client = {
    async ping() { return "pong"; },
    sessions: {
      async create() { return { id: "unused" }; }, async storeMessage() {}, async flush() {},
      async copy() { return { old_session_id: "old", new_session_id: "new" }; },
    },
    learningSpaces: {
      async learn() { return { status: "pending" }; }, async waitForLearning() { return { status: "completed" }; },
      async listSkills() { return skills; },
    },
    skills: {
      async getFile({ skillId }: { skillId: string; filePath: string }) {
        if (skillId.startsWith("1")) throw new Error("file not found");
        return { path: "SKILL.md", mime: "text/markdown", content: { raw: "# Valid\n" } };
      },
    },
  } satisfies AcontextGateway;
  try {
    const result = await new SkillSynchronizer(client, cache).sync("space-stale");
    assert.equal(result.skillCount, 1);
    assert.deepEqual(result.skippedFiles, [{ skill: "stale", path: "SKILL.md", reason: "file not found" }]);
    assert.equal(await readFile(join(result.path, "valid-22345678", "SKILL.md"), "utf8"), "# Valid\n");
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});
