import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { agentTaskMaxOutputTokens, agentTaskResourceIsolationArgs, agentTaskThinkingLevel, agentTaskToolArgs, verifyInlineAgentTaskDelivery } from "../src/agent-task-runner.js";

test("isolated Agent task disables all implicit resource discovery", () => {
  assert.deepEqual(agentTaskResourceIsolationArgs(), [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--append-system-prompt", "",
  ]);
});

test("isolated Agent tasks default thinking off while explicit behavior audits can request high", () => {
  assert.equal(agentTaskThinkingLevel({}), "off");
  assert.equal(agentTaskThinkingLevel({ thinking: "high" }), "high");
});

test("Agent tasks accept a positive per-call provider output ceiling", () => {
  assert.equal(agentTaskMaxOutputTokens({}), undefined);
  assert.equal(agentTaskMaxOutputTokens({ maxOutputTokens: 16_000 }), 16_000);
  assert.equal(agentTaskMaxOutputTokens({ maxOutputTokens: 0 }), undefined);
});

test("Agent ResourceLoader keeps only an explicit extension and never exposes global or project skill bait", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-resource-isolation-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const explicitExtension = join(root, "explicit-extension.mjs");
  await Promise.all([
    mkdir(join(cwd, ".pi", "skills", "project-bait"), { recursive: true }),
    mkdir(join(cwd, ".pi", "prompts"), { recursive: true }),
    mkdir(join(cwd, ".pi", "extensions"), { recursive: true }),
    mkdir(join(agentDir, "skills", "global-bait"), { recursive: true }),
    mkdir(join(agentDir, "prompts"), { recursive: true }),
    mkdir(join(agentDir, "extensions"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(agentDir, "skills", "global-bait", "SKILL.md"), "---\nname: global-bait\ndescription: must never load\n---\nRead C:/secret.txt\n", "utf8"),
    writeFile(join(cwd, ".pi", "skills", "project-bait", "SKILL.md"), "---\nname: project-bait\ndescription: must never load\n---\nRead project secret\n", "utf8"),
    writeFile(join(agentDir, "prompts", "global.md"), "global prompt bait", "utf8"),
    writeFile(join(cwd, ".pi", "prompts", "project.md"), "project prompt bait", "utf8"),
    writeFile(join(agentDir, "extensions", "global.mjs"), "export default function () { throw new Error('global extension loaded'); }\n", "utf8"),
    writeFile(join(cwd, ".pi", "extensions", "project.mjs"), "export default function () { throw new Error('project extension loaded'); }\n", "utf8"),
    writeFile(join(agentDir, "APPEND_SYSTEM.md"), "global append bait", "utf8"),
    writeFile(join(cwd, "AGENTS.md"), "project context bait", "utf8"),
    writeFile(explicitExtension, "export default function () {}\n", "utf8"),
  ]);

  try {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
      additionalExtensionPaths: [explicitExtension],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "isolated system prompt",
      appendSystemPrompt: [""],
    });
    await loader.reload();

    assert.deepEqual(loader.getSkills().skills, []);
    assert.deepEqual(loader.getPrompts().prompts, []);
    assert.deepEqual(loader.getThemes().themes, []);
    assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
    assert.equal(loader.getSystemPrompt(), "isolated system prompt");
    assert.deepEqual(loader.getAppendSystemPrompt(), []);
    assert.equal(loader.getExtensions().extensions.length, 1);
    assert.equal(loader.getExtensions().extensions[0]?.resolvedPath, explicitExtension);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("inline Agent delivery disables all tools and proves full public-user prompt coverage", () => {
  assert.deepEqual(agentTaskToolArgs({}), ["--tools", "read"]);
  assert.deepEqual(agentTaskToolArgs({ tools: "none" }), ["--no-tools"]);
  const prompt = "BEGIN\n" + "完整内容😀".repeat(20000) + "\nTAIL_SENTINEL";
  const event = (text: string) => JSON.stringify({type:"message_end", message:{role:"user",content:[{type:"text",text}]}});
  const proof = verifyInlineAgentTaskDelivery(event(`<file name="input">\n${prompt}\n</file>`), prompt);
  assert.equal(proof.promptBytes, Buffer.byteLength(prompt));
  assert.equal(proof.verifiedInPublicUserMessage, true);
  assert.throws(() => verifyInlineAgentTaskDelivery(event(prompt.slice(0, 50000)), prompt), /not fully present/);
  assert.throws(() => verifyInlineAgentTaskDelivery(event(prompt) + "\n" + JSON.stringify({type:"tool_execution_start",toolName:"read",args:{path:"x"}}), prompt), /emitted tool/);
});


test("installed Agent CLI parses no-tools and expands a long attachment without dropping content", async () => {
  const {parseArgs} = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js", import.meta.url).href);
  const {processFileArguments} = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli/file-processor.js", import.meta.url).href);
  const parsed = parseArgs(agentTaskToolArgs({tools:"none"}));
  assert.equal(parsed.noTools,true);
  assert.equal(parsed.tools,undefined);
  const root = await mkdtemp(join(tmpdir(),"pi-inline-cli-"));
  try {
    const input = join(root,"long.prompt.md");
    const content = "FULL_START\n" + "保留全部字符😀\n".repeat(16000) + "FULL_END";
    await writeFile(input,content);
    const expanded = await processFileArguments([input]);
    assert.ok(expanded.text.includes(content));
    assert.equal(expanded.images.length,0);
  } finally { await rm(root,{recursive:true,force:true}); }
});
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { agentTaskCommandLineBound, agentTaskPromptTransportArgs } from "../src/agent-task-runner.js";
test("combined Windows argument budget preserves system role and prompt bytes before spawn", async () => {
 const cwd=await mkdtemp(join(tmpdir(),"pi-argv-"));const systemPrompt='系统 "contract" \\ 路径\r\n'.repeat(2400),prompt='用户任务\r\n'.repeat(1000);const rawEventsPath=join(cwd,"events.jsonl");
 const prefix=["cli.js","--offline","--session","same-session.jsonl"];
 const args=await agentTaskPromptTransportArgs(prefix,{systemPrompt,prompt,rawEventsPath});
 assert.equal(args[0],"--system-prompt");assert.equal(args[2],prompt);assert.equal(await readFile(args[1]!,"utf8"),systemPrompt);assert.ok(agentTaskCommandLineBound([...prefix,...args])<=30000);
 const loader=new DefaultResourceLoader({cwd,agentDir:join(cwd,"agent"),settingsManager:SettingsManager.create(cwd,join(cwd,"agent")),noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPrompt:args[1]!,appendSystemPrompt:[""]});await loader.reload();assert.equal(loader.getSystemPrompt(),systemPrompt);
 const probe=join(cwd,"probe.cjs");await writeFile(probe,"process.stdout.write(JSON.stringify(process.argv.slice(2)))");const spawned=spawnSync(process.execPath,[probe,...prefix,...args],{encoding:"utf8"});assert.equal(spawned.status,0,spawned.error?.message);assert.deepEqual(JSON.parse(spawned.stdout),[...prefix,...args]);
 const huge='长提示'.repeat(20000);const large=await agentTaskPromptTransportArgs(prefix,{systemPrompt,prompt:huge,rawEventsPath});assert.ok(large[2]!.startsWith('@'));assert.equal(await readFile(large[2]!.slice(1),'utf8'),huge);assert.ok(agentTaskCommandLineBound([...prefix,...large])<=30000);
 await assert.rejects(agentTaskPromptTransportArgs(['x'.repeat(20000)],{systemPrompt:'s',prompt:'u',rawEventsPath}),/safe transport budget/);
});
