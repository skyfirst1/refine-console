import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentTaskResult } from "../src/agent-task-runner.js";
import { runDescriptionReconstruction, runPolicyOptimizationStage } from "../src/refine-workflow.js";

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  costUsd: 0,
};

test("description reconstruction removes pipeline-only lines without a cleanup agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-refine-description-stage-"));
  const turnsPath = join(root, "turns.md");
  const rulesPath = join(root, "rules.json");
  const outputPath = join(root, "description.md");
  const stages: string[] = [];
  try {
    await Promise.all([
      writeFile(turnsPath, "write a report", "utf8"),
      writeFile(rulesPath, "{}", "utf8"),
    ]);
    const result = await runDescriptionReconstruction({
      cwd: root,
      provider: "test",
      model: "test",
      extensionPaths: [],
      timeoutMs: 1000,
      runId: "run",
      runDirectory: root,
      turnsPath,
      rulesPath,
      outputPath,
      taskName: "Description",
      runner: async (options): Promise<AgentTaskResult> => {
        stages.push(options.trace?.stage ?? "unknown");
        return {
          finalText: "<<<DESCRIPTION_START>>>\n保留报告内容要求。\n先维护中间 Markdown 文档并转换为 docx。\n<<<DESCRIPTION_END>>>",
          rawEventsPath: options.rawEventsPath,
          readPaths: options.trace?.inputRefs ?? [],
          toolNames: ["read"],
          usage: emptyUsage,
        };
      },
    });

    assert.deepEqual(stages, ["task-reconstruction"]);
    assert.equal(result.description, "保留报告内容要求。");
    assert.deepEqual(result.removedLines, ["先维护中间 Markdown 文档并转换为 docx。"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared policy stage preserves optimizer and format-repair lineage", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-refine-policy-stage-"));
  const inputPath = join(root, "input.md");
  const outputPath = join(root, "policy.md");
  const incompleteOutputPath = join(root, "policy.incomplete.md");
  const stages: string[] = [];
  try {
    await writeFile(inputPath, "baseline", "utf8");
    const result = await runPolicyOptimizationStage({
      cwd: root,
      provider: "test",
      model: "test",
      extensionPaths: [],
      timeoutMs: 1000,
      runId: "run",
      runDirectory: root,
      runner: async (options): Promise<AgentTaskResult> => {
        stages.push(options.trace?.stage ?? "unknown");
        return {
          finalText: options.trace?.stage === "policy-format-repair"
            ? "<<<POLICY_START>>>\n---\nname: repaired\ndescription: repaired\n---\n\n# Rules\n\nKeep evidence.\n<<<POLICY_END>>>"
            : "<<<POLICY_START>>>\n---\nname: truncated",
          rawEventsPath: options.rawEventsPath,
          readPaths: options.trace?.inputRefs ?? [],
          toolNames: ["read"],
          usage: emptyUsage,
        };
      },
      requiredPaths: [inputPath],
      outputRefs: [outputPath],
      outputPath,
      taskId: "run:policy-optimization",
      taskName: "Policy optimizer",
      eventsPath: join(root, "optimizer.events.jsonl"),
      systemPrompt: "Optimize policy.",
      prompt: "Read and optimize.",
      incompleteOutputPath,
      repairTaskId: "run:policy-format-repair",
      repairTaskName: "Policy format repair",
      repairEventsPath: join(root, "repair.events.jsonl"),
      repairSystemPrompt: "Repair formatting only.",
      repairPrompt: (paths) => paths.map((path) => `- ${path}`).join("\n"),
    });

    assert.deepEqual(stages, ["policy-optimization", "policy-format-repair"]);
    assert.equal(result.recovery, "format-repair");
    assert.match(result.policy, /name: repaired/);
    assert.equal(result.primary.rawEventsPath, join(root, "optimizer.events.jsonl"));
    assert.equal(result.formatRepair?.run.rawEventsPath, join(root, "repair.events.jsonl"));
    assert.equal(result.formatRepair?.incompleteOutputPath, incompleteOutputPath);
    assert.match(await readFile(incompleteOutputPath, "utf8"), /name: truncated/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared policy stage can preserve fail-fast product behavior", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-refine-policy-fail-fast-"));
  const inputPath = join(root, "input.md");
  const outputPath = join(root, "policy.md");
  let calls = 0;
  try {
    await writeFile(inputPath, "baseline", "utf8");
    await assert.rejects(
      runPolicyOptimizationStage({
        cwd: root,
        provider: "test",
        model: "test",
        extensionPaths: [],
        timeoutMs: 1000,
        runId: "run",
        runDirectory: root,
        runner: async (options): Promise<AgentTaskResult> => {
          calls += 1;
          return {
            finalText: "<<<POLICY_START>>>\ntruncated",
            rawEventsPath: options.rawEventsPath,
            readPaths: options.trace?.inputRefs ?? [],
            toolNames: ["read"],
            usage: emptyUsage,
          };
        },
        requiredPaths: [inputPath],
        outputRefs: [outputPath],
        outputPath,
        taskId: "run:policy-optimization",
        taskName: "Policy optimizer",
        eventsPath: join(root, "optimizer.events.jsonl"),
        systemPrompt: "Optimize policy.",
        prompt: "Read and optimize.",
        recoveryMode: "fail",
      }),
      /未返回完整 policy 标记/,
    );
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
