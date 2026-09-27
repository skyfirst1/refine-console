import assert from "node:assert/strict";
import test from "node:test";
import {
  encodePhoenixAgentTaskContext,
  PHOENIX_AGENT_TASK_ENV,
  readPhoenixAgentTaskContext,
  summarizeToolInput,
  summarizeToolResult,
} from "../src/phoenix-tracing.js";
import {
  bundledPhoenixEventExtensionPath,
  agentTaskExtensionPaths,
} from "../src/agent-task-runner.js";

test("Phoenix task descriptor contains references but no task content", () => {
  const descriptor = {
    taskId: "run-1:policy",
    name: "Refine policy optimization",
    runId: "run-1",
    stage: "policy-optimization",
    inputRefs: ["D:/run/description.md", "D:/run/gold.md"],
    outputRefs: ["D:/run/refined-policy.md"],
  };
  const encoded = encodePhoenixAgentTaskContext(descriptor);
  assert.deepEqual(readPhoenixAgentTaskContext({ [PHOENIX_AGENT_TASK_ENV]: encoded }), descriptor);
  assert.doesNotMatch(encoded, /document body|policy body|user prompt/i);
});

test("tool summaries never retain prompt, policy, or tool-result bodies", () => {
  const secretPrompt = "SECRET user task and full policy body";
  const input = summarizeToolInput({ path: "D:/run/gold.md", prompt: secretPrompt, command: "print secret" });
  const output = summarizeToolResult({ content: [{ type: "text", text: secretPrompt }] }, false);

  assert.deepEqual(input.artifactRefs, ["D:/run/gold.md"]);
  assert.deepEqual(input.argumentKeys, ["command", "path", "prompt"]);
  assert.equal((input.stringCharacters as Record<string, number>).prompt, secretPrompt.length);
  assert.doesNotMatch(JSON.stringify(input), /SECRET|full policy body|print secret/);
  assert.equal(output.textCharacters, "text".length + secretPrompt.length);
  assert.doesNotMatch(JSON.stringify(output), /SECRET|full policy body/);
});

test("isolated Agent task injects the event tracing extension only when Phoenix tracing is enabled", () => {
  const options = {
    extensionPaths: ["D:/extensions/provider.ts"],
    trace: { taskId: "task", name: "task", stage: "refine" },
  };
  const disabled = agentTaskExtensionPaths(options, { PHOENIX_ENABLED: "false" });
  const enabled = agentTaskExtensionPaths(options, { PHOENIX_ENABLED: "true" });

  assert.equal(disabled.length, 1);
  assert.equal(enabled.length, 2);
  assert.equal(enabled.at(-1), bundledPhoenixEventExtensionPath());
});
