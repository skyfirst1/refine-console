import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  loadActiveAutoDreamPath,
  rollbackAutoDream,
  runAutoDream,
  type AutoDreamValidation,
} from "../src/auto-dream-runner.js";
import type { AgentTaskOptions, AgentTaskResult } from "../src/agent-task-runner.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function promptPaths(prompt: string): string[] {
  return prompt.split(/\r?\n/)
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(line.indexOf("：") + 1).trim())
    .filter((path) => path.includes("\\") || path.startsWith("/"))
    .map((path) => resolve(path));
}

function fakeRunner(options: { reject?: boolean } = {}): {
  run: (task: AgentTaskOptions) => Promise<AgentTaskResult>;
  calls: () => number;
} {
  let callCount = 0;
  let candidateCount = 0;
  let lastCandidate = "";
  return {
    calls: () => callCount,
    run: async (task) => {
      callCount += 1;
      const readPaths = promptPaths(task.prompt);
      if (task.systemPrompt.includes("Orient、Gather、Consolidate、Prune")) {
        candidateCount += 1;
        lastCandidate = `---\nname: consolidated-document-agent\ndescription: 经过证据合并的文档工作流 ${candidateCount}\n---\n\n# 规则\n\n- 保持事实准确。\n- 版本 ${candidateCount}。`;
        return {
          finalText: `<<<DREAM_SKILL_START>>>\n${lastCandidate}\n<<<DREAM_SKILL_END>>>`,
          rawEventsPath: task.rawEventsPath,
          readPaths,
          toolNames: ["read"],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 },
        };
      }
      const hash = sha256(lastCandidate);
      const checks: AutoDreamValidation["checks"] = {
        source_grounded: !options.reject,
        preserves_refined_policy: true,
        no_contradictions: true,
        no_task_specific_facts: true,
        no_pipeline_leak: true,
        actionable: true,
      };
      return {
        finalText: `<<<DREAM_VALIDATION_START>>>\n${JSON.stringify({ approved: true, candidate_sha256: hash, checks, reason: options.reject ? "缺少来源证据" : "通过" })}\n<<<DREAM_VALIDATION_END>>>`,
        rawEventsPath: task.rawEventsPath,
        readPaths,
        toolNames: ["read"],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 },
      };
    },
  };
}

test("Auto-Dream consolidates, independently validates, publishes, deduplicates, and rolls back", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-dream-"));
  const source = join(root, "source-skills");
  const policy = join(root, "refined-policy.md");
  const runRoot = join(root, "runs");
  const publishRoot = join(root, "published");
  await mkdir(join(source, "writing"), { recursive: true });
  await writeFile(join(source, "writing", "SKILL.md"), "---\nname: writing\ndescription: 写作规则\n---\n\n- 先确认范围。\n", "utf8");
  await writeFile(policy, "---\nname: refined\ndescription: policy\n---\n\n- 保持事实准确。\n", "utf8");
  const runner = fakeRunner();
  try {
    const first = await runAutoDream({
      cwd: root, sourceSkillPath: source, refinedPolicyPath: policy, runRoot, publishRoot,
      provider: "test", model: "test", timeoutMs: 10_000, taskRunner: runner.run,
    });
    assert.equal(first.status, "approved");
    assert.equal(runner.calls(), 2);
    assert.equal(await loadActiveAutoDreamPath(publishRoot), first.activeSkillPath);
    assert.match(await readFile(join(first.activeSkillPath!, "consolidated-document-agent", "SKILL.md"), "utf8"), /版本 1/);

    const duplicate = await runAutoDream({
      cwd: root, sourceSkillPath: source, refinedPolicyPath: policy, runRoot, publishRoot,
      provider: "test", model: "test", timeoutMs: 10_000, taskRunner: runner.run,
    });
    assert.equal(duplicate.status, "skipped");
    assert.equal(runner.calls(), 2);

    await writeFile(policy, "---\nname: refined\ndescription: policy\n---\n\n- 保持事实准确。\n- 明确边界。\n", "utf8");
    const second = await runAutoDream({
      cwd: root, sourceSkillPath: source, refinedPolicyPath: policy, runRoot, publishRoot,
      provider: "test", model: "test", timeoutMs: 10_000, taskRunner: runner.run,
    });
    assert.equal(second.status, "approved");
    assert.notEqual(second.activeSkillPath, first.activeSkillPath);
    assert.equal(second.previousSkillPath, first.activeSkillPath);
    assert.equal(await rollbackAutoDream(publishRoot), first.activeSkillPath);
    assert.equal(await loadActiveAutoDreamPath(publishRoot), first.activeSkillPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Auto-Dream validator defaults to rejection and does not publish failed evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-dream-reject-"));
  const source = join(root, "source-skills");
  const policy = join(root, "refined-policy.md");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "SKILL.md"), "---\nname: source\ndescription: source\n---\n", "utf8");
  await writeFile(policy, "---\nname: refined\ndescription: policy\n---\n", "utf8");
  const runner = fakeRunner({ reject: true });
  try {
    const result = await runAutoDream({
      cwd: root,
      sourceSkillPath: source,
      refinedPolicyPath: policy,
      runRoot: join(root, "runs"),
      publishRoot: join(root, "published"),
      provider: "test",
      model: "test",
      timeoutMs: 10_000,
      taskRunner: runner.run,
    });
    assert.equal(result.status, "rejected");
    assert.equal(result.activeSkillPath, undefined);
    assert.equal(await loadActiveAutoDreamPath(join(root, "published")), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
