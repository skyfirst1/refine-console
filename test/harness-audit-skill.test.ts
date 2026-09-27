import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadHarnessAuditSkill, runExpertBoundaryFindingAudit } from "../src/harness-audit-skill.js";
import type { AgentTaskOptions, AgentTaskResult } from "../src/agent-task-runner.js";

test("diagnostic Harness delivers the checkout operating skill without replacing task inputs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "harness-skill-"));
  const skillDir = join(cwd, ".pi/skills/refine-harness-audit");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "Task purpose governs the audited relation.\n");
  let delivered: AgentTaskOptions | undefined;
  const returned = {} as AgentTaskResult;
  const result = await runExpertBoundaryFindingAudit({ cwd, provider: "fixture", model: "fixture", rawEventsPath: join(cwd, "unused.events.jsonl"), timeoutMs: 1, prompt: "FROZEN PUBLIC TRACE", systemPrompt: "FROZEN TASK PURPOSE", tools: "none", taskPurposes: [{ taskId: "test", content: "Compare topics", style: null, authority: ["Original requirements"] }] }, async options => {
    delivered = options;
    return returned;
  });
  assert.equal(result.result, returned);
  assert.equal(delivered?.prompt, "FROZEN PUBLIC TRACE");
  assert.equal(delivered?.tools, "none");
  assert.ok(delivered?.systemPrompt?.includes(result.operatingSkill.content));
  assert.ok(delivered?.systemPrompt?.includes("FROZEN TASK PURPOSE"));
  assert.ok(delivered?.systemPrompt?.includes('"content":"Compare topics"'));
  const before = result.operatingSkill.sha256;
  await writeFile(join(skillDir, "SKILL.md"), "A revised operating skill.\n");
  assert.notEqual((await loadHarnessAuditSkill(cwd)).sha256, before);
  await writeFile(join(skillDir, "SKILL.md"), "  ");
  await assert.rejects(loadHarnessAuditSkill(cwd), /empty/);
});

test("other checkout roots use the same bundled Harness skill, not a parallel prompt copy", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "harness-bundle-"));
  const skill = await loadHarnessAuditSkill(cwd);
  assert.ok(skill.path.replaceAll("\\", "/").endsWith(".pi/skills/refine-harness-audit/SKILL.md"));
  assert.ok(skill.content.includes("name: refine-harness-audit"));
});
