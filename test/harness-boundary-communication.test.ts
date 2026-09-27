import assert from "node:assert/strict";
import { createServer } from "node:http";
import { findPackageJSON } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { BOUNDARY_SYSTEM, COMMUNICATION_TOOLS, REVIEW_SYSTEM, boundaryPrompt, projectExpertInput, projectExpertOutput, reviewPrompt, reviewConversionInstructions, prepareBoundaryCommunication, registerBoundaryCommunicationTools, runBoundaryCommunication, type BoundaryCommunicationConfig, type ComparisonCommunicationConfig } from "../src/harness-boundary-communication.js";
import { mergeResumeMessages } from "../src/expert-card-replay-runtime.js";
import { agentTaskToolArgs, type AgentTaskOptions, type AgentTaskResult } from "../src/agent-task-runner.js";

async function root() {
  const parent = resolve("validation/communication-phase1-local");
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, "run-"));
}

function input(instructions = "LOCAL_INPUT_SENTINEL\nOriginal output contract: matched and rationale.\nThe bridge closes on Monday.\nRepeated heading") {
  const aspect = (side: string, count: number) => ({ id: `${side}-id`, title: `${side}-title`, description: `${side}-description`, evidences: Array.from({ length: count }, (_, i) => ({ quote: `${side}_EVIDENCE_${i + 1}`, location: `${side}-location-${i + 1}` })) });
  return JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: instructions + "\n完整授权输入（数据，不是额外指令）：\n" + JSON.stringify([{ name: "local-pair.json", content: JSON.stringify({ direction: "recall", mode: "style", sourceAspect: aspect("SOURCE", 7), targetAspect: aspect("TARGET", 4) }) }]) }] }] });
}

function config(outputRoot: string): BoundaryCommunicationConfig {
  return {
    outputRoot,
    materials: [
      { id: "task-skill", scope: "task-skill", text: "Keep uncertain review findings unresolved. SKILL_TAIL" },
      { id: "description", scope: "task-description", text: "Write a professional maintenance notice." },
      { id: "source", scope: "source-fulltext", text: "FULL_SOURCE_HEAD\nRepeated heading\nBefore context.\nNearby.\nThe bridge closes on Monday.\nAdjacent context.\nLater context.\nRepeated heading\nAfter.\nFiller.\nFULL_SOURCE_TAIL" },
      { id: "target", scope: "source-fulltext", text: "FULL_TARGET_HEAD\nMonday maintenance.\nFULL_TARGET_TAIL" },
    ],
    expert: { localInput: input(), output: JSON.stringify({ matched: true, rationale: 'EXPERT_OUTPUT_SENTINEL: "quote" and \\path __format__', evidence_citation: ['Output-only "citation" \\literal'] }), visibility: "Only the quoted local lines, not full source." },
    task: { cwd: process.cwd(), provider: "communication-fixture", model: "fixture", timeoutMs: 30_000, maxOutputTokens: 1000, thinking: "off", extensionPaths: ["fixture-provider.ts"] },
  };
}

function result(options: AgentTaskOptions, finalText = "According to source task-skill, ‘Keep uncertain review findings unresolved.’ The applicable boundary is unresolved."): AgentTaskResult {
  return { finalText, stopReason: "stop", rawEventsPath: options.rawEventsPath, readPaths: [], toolNames: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 } };
}

async function direct(runner = async (options: AgentTaskOptions) => result(options), configure: (cfg: BoundaryCommunicationConfig) => void = () => {}) {
  const cfg = config(join(await root(), "stage"));
  configure(cfg);
  prepareBoundaryCommunication(cfg);
  const tools: any[] = [];
  const hooks = new Map<string, Function>();
  const reminders: any[] = [];
  let active: string[] = [];
  registerBoundaryCommunicationTools({ registerTool(tool: any) { tools.push(tool); }, on(name: string, callback: Function) { hooks.set(name, callback); }, setActiveTools(names: string[]) { active = names; }, sendMessage(message: any, options: any) { reminders.push({ message, options }); } }, cfg, runner);
  hooks.get("session_start")!();
  const invoke = async (name: string, args: unknown) => JSON.parse((await tools.find(tool => tool.name === name).execute("call", args)).content[0].text);
  return { cfg, tools, hooks, active, invoke, reminders };
}

test("Expert envelope is unpacked losslessly, mapped offline, and rejects unknown structure", async () => {
  const cfg = config(join(await root(), "stage"));
  cfg.expert.localInput = input('Exact instruction "quote"\nLiteral \\ path and __format__ must remain.');
  const projection = projectExpertInput(cfg.expert.localInput);
  assert.equal(projection.mapping.filter(f => f.path.endsWith(".quote")).length, 11);
  assert.equal(projection.mapping.filter(f => f.path.endsWith(".location")).length, 11);
  for (const field of projection.mapping.filter(f => f.displayId)) assert((projection.text + projection.instructions).includes(field.value), field.path);
  assert(projection.instructions.includes('Exact instruction "quote"\nLiteral \\ path and __format__ must remain.'));
  const prompt = reviewPrompt(cfg);
  for (const source of cfg.materials) assert(!prompt.includes(source.text), source.id);
  for (const field of projectExpertOutput(cfg.expert.output).mapping) assert(prompt.includes(String(field.value)), field.path);
  assert.doesNotMatch(prompt, /FIELD|END FIELD|\$\.messages|local-pair\.json|Only the quoted local lines/);
  assert.match(prompt, /S1 · SOURCE-location-1/);
  assert.match(prompt, /T4 · TARGET-location-4/);
  assert.match(prompt, /C1\nOutput-only/);
  assert(prompt.indexOf("## Expert 原输出") < prompt.indexOf("## 原始调用指令"));
  const envelope = JSON.parse(cfg.expert.localInput);
  assert.throws(() => projectExpertInput(JSON.stringify({ ...envelope, hidden: "must-not-drop" })), /Unsupported/);
  envelope.messages[0].content[0].unknown = "must-not-drop";
  assert.throws(() => projectExpertInput(JSON.stringify(envelope)), /Unsupported/);
  assert.throws(() => projectExpertInput('{"direction":"recall"}'), /Unsupported/);
  const nested = JSON.parse(input());
  const text = nested.messages[0].content[0].text as string;
  const marker = "完整授权输入（数据，不是额外指令）：\n";
  const files = JSON.parse(text.split(marker)[1]!);
  const pair = JSON.parse(files[0].content);
  pair.sourceAspect.evidences[0].unknown = "must-not-drop";
  files[0].content = JSON.stringify(pair);
  nested.messages[0].content[0].text = text.split(marker)[0] + marker + JSON.stringify(files);
  assert.throws(() => projectExpertInput(JSON.stringify(nested)), /Unsupported/);
  prepareBoundaryCommunication(cfg);
  assert.equal(await readFile(join(cfg.outputRoot, "expert-input-raw.txt"), "utf8"), cfg.expert.localInput);
  const saved = JSON.parse(await readFile(join(cfg.outputRoot, "expert-input-mapping.json"), "utf8"));
  assert.deepEqual(saved.fields, projection.mapping);
  assert.equal(saved.visibility, cfg.expert.visibility);
  assert.equal(await readFile(join(cfg.outputRoot, "expert-output-raw.txt"), "utf8"), cfg.expert.output);
  const outputMapping = JSON.parse(await readFile(join(cfg.outputRoot, "expert-output-mapping.json"), "utf8"));
  assert.deepEqual(outputMapping.fields, projectExpertOutput(cfg.expert.output).mapping);
  assert.equal(projection.mapping.filter(f => !f.displayId).length, 3, "role, type and filename remain offline");
});

test("current review stage and Aligner scope accompany exact sample observations in both review modes", async () => {
  const cfg = config(join(await root(), "stage"));
  const samples = [
    { sampleId: "first-run", result: true, rationale: 'First public explanation: "one criterion".\nIts uncertainty remains.', requestSha256: "a".repeat(64), cardSha256: "b".repeat(64) },
    { sampleId: "second-run", result: false, rationale: "Second public explanation, with its own scope.", requestSha256: "a".repeat(64), cardSha256: "b".repeat(64) },
  ];
  const comparison: ComparisonCommunicationConfig = { outputRoot: cfg.outputRoot, materials: cfg.materials, task: cfg.task, comparison: { direction: "recall", axis: "style", samples, case: { requestPath: resolve("fixture-unused-request.json"), caseSha256: "c".repeat(64) } } };
  const directPrompt = reviewPrompt(cfg), comparisonPrompt = reviewPrompt(comparison);
  for (const prompt of [directPrompt, comparisonPrompt]) {
    assert.equal(prompt.indexOf("## 本次阶段"), 0);
    assert(prompt.indexOf("finish_review") < prompt.indexOf("## 被审查 Expert：Aligner"));
  }
  for (const sample of samples) assert(comparisonPrompt.includes(`## ${sample.sampleId}\nresult: ${sample.result}\nrationale:\n${sample.rationale}`));
  for (const source of cfg.materials) assert(!comparisonPrompt.includes(source.text), "Task material remains available through the boundary role, not the comparison input.");
  const question = 'Which criterion applies to the quoted "local behavior"?';
  const boundary = boundaryPrompt(cfg.materials, question);
  for (const source of cfg.materials.filter(item => item.scope !== "source-fulltext")) assert(boundary.includes(source.text));
  assert(boundary.endsWith(question));
});

test("output values decode once with distinct citation identities and reject unknown shape", () => {
  const output = { matched: false, rationale: 'unchanged "rationale"\n__x__ \\-literal', evidence_citation: ['C value \\"quote"', "second\nline"] };
  const projected = projectExpertOutput(JSON.stringify(output));
  assert(projected.text.includes(output.rationale));
  output.evidence_citation.forEach((value, index) => {
    assert(projected.text.includes(value));
    assert.deepEqual(projected.mapping[index + 2], { path: `$.evidence_citation[${index}]`, value, displayId: `C${index + 1}` });
  });
  const singleton = projectExpertOutput(JSON.stringify({ matched: true, rationale: "original", evidence_citation: "single" }));
  assert.equal(singleton.mapping[2]!.path, "$.evidence_citation");
  assert.equal(projectExpertOutput('{"matched":true,"rationale":"only"}').mapping.length, 2);
  for (const bad of [{ ...output, extra: "never-drop" }, { ...output, matched: "false" }, { ...output, evidence_citation: [] }, { ...output, evidence_citation: ["ok", 2] }]) assert.throws(() => projectExpertOutput(JSON.stringify(bad)), /Unsupported/);
});

for (const scope of ["full-input fixture", "local-check fixture"]) test(`conversion instruction preserves ${scope} public history without supplying a teaching answer`, () => {
  const originalSystem = "Original role and runtime suffix\n";
  const originalUser = "Two exact independent observations.";
  const history = [{ role: "system", content: originalSystem }, { role: "user", content: originalUser },
    { role: "assistant", content: "", tool_calls: [{ id: "saved-review", type: "function", function: { name: "finish_review", arguments: JSON.stringify({ review: `${scope}: original "observation" with its own limit.` }) } }] },
    { role: "tool", tool_call_id: "saved-review", content: '{"status":"review-saved"}' }];
  const conversion = reviewConversionInstructions(originalSystem);
  assert(conversion.system.startsWith(originalSystem));
  const prefix = [{ ...history[0], content: conversion.system }, ...history.slice(1), { role: "user", content: conversion.authorizedContinuationMessage }];
  const merged = mergeResumeMessages(prefix, [{ role: "system", content: conversion.system }, { role: "user", content: originalUser }], conversion.system, originalUser, conversion.authorizedContinuationMessage);
  assert.deepEqual(merged, prefix);
  assert.deepEqual(merged.slice(1, -1), history.slice(1));
});

test("norm checks use only prior boundary quotes and remain small supplemental reads", async () => {
  const quote = "The local scope remains unresolved.";
  const f = await direct(async options => result(options, `SOURCE task-skill: ${quote}`), cfg => {
    cfg.materials[0]!.text = `OFFLINE NORM HEAD\nPrevious.\n${quote}\nNext.\nOFFLINE NORM TAIL`;
  });
  assert.equal((await f.invoke("read_source", { action: "read", source: "task-skill", anchor: quote, question: "Check the rule quotation." })).status, "source-read-error");
  await f.invoke("ask_boundary", { question: "What local scope applies?" });
  assert.equal((await f.invoke("read_source", { action: "read", source: "task-skill", anchor: "OFFLINE NORM HEAD", question: "Unseen rule." })).status, "source-read-error");
  const excerpt = await f.invoke("read_source", { action: "read", source: "task-skill", anchor: quote, question: "Check the quoted scope against its immediate context." });
  assert.equal(excerpt.evidenceScope, "harness-norm-check-not-expert-visible");
  assert.deepEqual([excerpt.windowStartLine, excerpt.windowEndLine], [2, 4]);
  assert.equal(excerpt.coverage.totalLines, 3);
  assert.doesNotMatch(JSON.stringify(excerpt.ranges), /OFFLINE NORM/);
  await f.invoke("finish_review", { review: "Boundary quotation checked; remaining unknowns stay unresolved." });
});

test("minimal object schemas survive actual SDK serialization and validation", async () => {
  const sdkRoot = dirname(findPackageJSON("@earendil-works/pi-ai", import.meta.resolve("@earendil-works/pi-coding-agent"))!);
  const { stream } = await import(pathToFileURL(join(sdkRoot, "dist/api/openai-completions.js")).href);
  const { validateToolArguments } = await import(pathToFileURL(join(sdkRoot, "dist/utils/validation.js")).href);
  let captured: any;
  const reply = await stream({ id: "deepseek-v4-flash", name: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "https://api.deepseek.com", reasoning: true, input: ["text"], contextWindow: 1000000, maxTokens: 8000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { thinkingFormat: "deepseek", supportsReasoningEffort: false, supportsDeveloperRole: false } },
    { systemPrompt: REVIEW_SYSTEM, messages: [{ role: "user", content: "Fixture", timestamp: 0 }], tools: COMMUNICATION_TOOLS },
    { apiKey: "local-capture", maxTokens: 8000, maxRetries: 0, fetch: async (_input: unknown, init: any) => { captured = JSON.parse(init.body); throw Error("LOCAL_CAPTURE_BEFORE_NETWORK"); } }).result();
  assert.equal(reply.stopReason, "error");
  for (const definition of COMMUNICATION_TOOLS) {
    const schema = captured.tools.find((tool: any) => tool.function.name === definition.name).function.parameters;
    assert.equal(schema.type, "object");
    assert.deepEqual(schema, JSON.parse(JSON.stringify(definition.parameters)));
    assert.equal(Object.keys(schema.properties).length, definition.name === "read_source" ? 4 : 1);
    const args = definition.name === "ask_boundary" ? { question: "Which requirement applies?" } : definition.name === "read_source" ? { action: "read", source: "source", anchor: "The bridge closes on Monday.", question: "Verify the quoted closure date." } : { review: "This observation remains unresolved." };
    const validate = (argumentsValue: unknown) => validateToolArguments(definition, { type: "toolCall", id: "test", name: definition.name, arguments: argumentsValue });
    assert.deepEqual(validate(args), args);
    assert.throws(() => validate({ ...args, decisionToken: "unnecessary" }), /Validation failed/);
  }
  const artifactRoot = await root();
  await writeFile(join(artifactRoot, "actual-sdk-request.json"), JSON.stringify(captured, null, 2));
  assert.deepEqual(agentTaskToolArgs({ tools: "boundary-review" }), ["--tools", "ask_boundary,finish_review,read_source"]);
});

test("question routes only authorized source material into a fresh no-tools boundary session", async () => {
  let seen: AgentTaskOptions | undefined;
  const f = await direct(async options => { seen = options; return result(options); });
  const question = "What does source task-skill require when evidence is uncertain?";
  const answer = await f.invoke("ask_boundary", { question });
  assert(seen);
  assert.equal(seen.tools, "none");
  assert.equal(seen.systemPrompt, BOUNDARY_SYSTEM);
  assert.equal(seen.session, undefined);
  assert.equal(seen.prompt, boundaryPrompt(f.cfg.materials, question));
  assert.match(seen.prompt, /SKILL_TAIL/);
  assert.doesNotMatch(seen.prompt, /FULL_SOURCE|FULL_TARGET|LOCAL_INPUT_SENTINEL|EXPERT_OUTPUT_SENTINEL/);
  assert.equal(answer.answer, result(seen).finalText);
  assert.deepEqual(Object.keys(answer).sort(), ["answer", "note"]);
  const savedAnswer = JSON.parse(await readFile(join(f.cfg.outputRoot, "boundary-answer.json"), "utf8"));
  assert.equal(savedAnswer.answer, answer.answer);
  assert.equal(savedAnswer.epistemicStatus, "model-interpretation-not-gold");
  assert.deepEqual(savedAnswer.availableSourceIds, ["task-skill", "description"]);
  assert.deepEqual(f.active, ["ask_boundary", "finish_review", "read_source"]);
  assert.deepEqual(await f.invoke("finish_review", { review: "Exact task-skill quote supports an unresolved finding." }), { status: "review-saved" });
  const receipt = JSON.parse(await readFile(join(f.cfg.outputRoot, "review.json"), "utf8"));
  assert.equal(receipt.review, "Exact task-skill quote supports an unresolved finding.");
  await assert.rejects(f.invoke("ask_boundary", { question }), /communication complete/);
  let aborted = false;
  assert.throws(() => f.hooks.get("before_provider_request")!({}, { abort() { aborted = true; } }), /communication complete/);
  assert.equal(aborted, true);
});

test("source lookup is whitelist-bound, ranged, supplemental and recoverable within the request limit", async () => {
  const f = await direct();
  for (const args of [
    { action: "read", source: "../private-card.md", anchor: "x", question: "check" },
    { action: "read", source: "task-skill", anchor: "Keep", question: "check" },
    { action: "read", source: "source", anchor: "not present", question: "check" },
    { action: "read", source: "source", anchor: "FULL_SOURCE_HEAD", question: "hidden location" },
    { action: "read", source: "source", anchor: "Repeated heading", question: "check" },
    { action: "read", source: "source", anchor: "Monday", question: "check", path: "C:/private.md" },
    { action: "read", source: "source", anchor: "Monday", question: "check", contextLines: 40 },
    { action: "expand", source: "source", question: "No previous window exists." },
  ]) assert.equal((await f.invoke("read_source", args)).status, "source-read-error");
  const narrow = await f.invoke("read_source", { action: "read", source: "source", anchor: "The bridge closes on Monday.", question: "Verify the date." });
  assert.equal(narrow.evidenceScope, "harness-supplemental-not-expert-visible");
  assert.deepEqual([narrow.windowStartLine, narrow.windowEndLine], [4, 6]);
  assert.match(JSON.stringify(narrow.ranges), /The bridge closes on Monday/);
  assert.doesNotMatch(JSON.stringify(narrow.ranges), /FULL_SOURCE/);
  assert.equal(narrow.coverage.sourceLines, 3);
  for (const args of [{ action: "expand", source: "source", question: " " }, { action: "expand", source: "source", anchor: "Monday", question: "Check preceding explanation." }]) assert.equal((await f.invoke("read_source", args)).status, "source-read-error");
  const expanded = await f.invoke("read_source", { action: "expand", source: "source", question: "The excerpt names a date but omits the preceding explanation and subsequent restriction." });
  assert.deepEqual([expanded.windowStartLine, expanded.windowEndLine], [2, 8]);
  assert.deepEqual(expanded.ranges.map((r: any) => [r.startLine, r.endLine]), [[2, 3], [7, 8]]);
  assert.equal(expanded.coverage.sourceLines, 7);
  assert.match(JSON.stringify(expanded.ranges), /Before context|Later context/);
  assert.doesNotMatch(JSON.stringify(expanded.ranges), /The bridge closes on Monday|FULL_SOURCE/);
  const seenAnchor = await f.invoke("read_source", { action: "read", source: "source", anchor: "Before context.", question: "Check the newly returned context." });
  assert.equal(seenAnchor.status, "already-visible");
  assert.equal(seenAnchor.coverage.sourceLines, 7);
  for (let i = 0; i < 5; i++) f.hooks.get("before_provider_request")!({}, { abort() {} });
  assert.throws(() => f.hooks.get("before_provider_request")!({}, { abort() {} }), /request limit/);
  await f.invoke("ask_boundary", { question: "What does task-skill require?" });
  await f.invoke("finish_review", { review: "Supplemental evidence remains distinct from the original input." });
  await assert.rejects(f.invoke("read_source", { action: "read", source: "source", anchor: "Monday", question: "after finish" }), /communication complete/);
});

test("disclosure budgets accumulate across anchors and sources, including concurrent calls", async () => {
  const f = await direct(undefined, cfg => {
    for (const source of cfg.materials.filter(s => s.scope === "source-fulltext")) source.text = Array.from({ length: 100 }, (_, i) => `${source.id} line ${String(i + 1).padStart(3, "0")}`).join("\n");
    cfg.expert.localInput = input(cfg.materials.filter(s => s.scope === "source-fulltext").map(s => s.text).join("\n"));
  });
  const results = await Promise.all(Array.from({ length: 9 }, (_, i) => f.invoke("read_source", { action: "read", source: "source", anchor: `source line ${String(5 + i * 5).padStart(3, "0")}`, question: `Check assertion ${i}.` })));
  assert.equal(results.filter(r => r.status === "excerpt-returned").length, 8);
  assert.equal(results[7].coverage.sourceLines, 24);
  assert.equal(results[8].status, "source-read-error");
  assert.equal((await f.invoke("read_source", { action: "expand", source: "source", question: "The final source window still omits neighboring context." })).status, "source-read-error");
  for (let i = 0; i < 5; i++) assert.equal((await f.invoke("read_source", { action: "read", source: "target", anchor: `target line ${String(5 + i * 5).padStart(3, "0")}`, question: `Check target assertion ${i}.` })).status, "excerpt-returned");
  assert.equal((await f.invoke("read_source", { action: "read", source: "target", anchor: "target line 030", question: "Check another assertion." })).status, "source-read-error");
  const already = await f.invoke("read_source", { action: "read", source: "source", anchor: "source line 005", question: "Return to the original observation." });
  assert.equal(already.status, "already-visible");
  assert.equal(already.coverage.totalLines, 39);
  assert.match(already.scopeNote, /not task truth/);
});

test("long lines cannot bypass per-call and cumulative character limits", async () => {
  const long = await direct(undefined, cfg => { cfg.materials[2]!.text = `Known anchor ${"x".repeat(3000)}`; cfg.expert.localInput = input("Known anchor"); });
  assert.equal((await long.invoke("read_source", { action: "read", source: "source", anchor: "Known anchor", question: "Check the claim." })).status, "source-read-error");
  const cumulative = await direct(undefined, cfg => {
    cfg.materials[2]!.text = Array.from({ length: 30 }, (_, i) => `Claim${i.toString().padStart(2, "0")} ${"x".repeat(850)}`).join("\n");
    cfg.expert.localInput = input(cfg.materials[2]!.text);
  });
  for (const index of [2, 7, 12, 17]) assert.equal((await cumulative.invoke("read_source", { action: "read", source: "source", anchor: `Claim${index.toString().padStart(2, "0")}`, question: "Check the associated claim." })).status, "excerpt-returned");
  assert.equal((await cumulative.invoke("read_source", { action: "read", source: "source", anchor: "Claim22", question: "Check another claim." })).status, "source-read-error");
});

test("malformed direct calls, finish-before-answer and repeat questions stop without hidden retries", async () => {
  for (const args of [{}, { question: "" }, { question: "   " }, { question: "Source question", expectedMatched: true }]) {
    let calls = 0;
    const f = await direct(async options => { calls++; return result(options); });
    await assert.rejects(f.invoke("ask_boundary", args), /Invalid/);
    assert.equal(calls, 0);
    await assert.rejects(f.invoke("ask_boundary", { question: "retry" }), /Communication failed/);
  }
  const early = await direct();
  await assert.rejects(early.invoke("finish_review", { review: "premature" }), /receive its answer/);
  const repeated = await direct();
  await repeated.invoke("ask_boundary", { question: "source question" });
  await assert.rejects(repeated.invoke("ask_boundary", { question: "second question" }), /Only one/);
  const failure = await direct(async () => { throw Error("boundary provider failed"); });
  await assert.rejects(failure.invoke("ask_boundary", { question: "source question" }), /provider failed/);
  await assert.rejects(failure.invoke("finish_review", { review: "cannot complete" }), /Communication failed/);
});

test("plain final prose is incomplete and the prepared directory cannot silently rerun", async () => {
  const cfg = config(join(await root(), "stage"));
  const prepared = prepareBoundaryCommunication(cfg);
  await assert.rejects(runBoundaryCommunication(prepared.configPath, async options => { await writeFile(options.rawEventsPath, "{}"); return result(options, "I completed the review."); }), /Review incomplete/);
  await assert.rejects(runBoundaryCommunication(prepared.configPath), /already started/);
});

test("completion reminder is once-only and excludes absent answers, failures, exhausted or completed runs", async () => {
  const stopped = { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "My review is ready." }] } };
  const f = await direct();
  f.hooks.get("turn_end")!(stopped, {});
  assert.equal(f.reminders.length, 0, "No boundary answer, no completion reminder.");
  await f.invoke("ask_boundary", { question: "Which requirement applies?" });
  for (const stopReason of ["error", "aborted", "length", "toolUse"]) f.hooks.get("turn_end")!({ message: { ...stopped.message, stopReason } }, {});
  f.hooks.get("turn_end")!(stopped, { signal: { aborted: true } });
  assert.equal(f.reminders.length, 0);
  f.hooks.get("turn_end")!(stopped, {});
  f.hooks.get("turn_end")!(stopped, {});
  assert.equal(f.reminders.length, 1, "A second plain final must not create another continuation.");
  assert.equal(f.reminders[0].options.deliverAs, "followUp");
  assert.equal(f.reminders[0].options.triggerTurn, true);
  const exhausted = await direct();
  await exhausted.invoke("ask_boundary", { question: "Which requirement applies?" });
  for (let i = 0; i < 5; i++) exhausted.hooks.get("before_provider_request")!({}, { abort() {} });
  exhausted.hooks.get("turn_end")!(stopped, {});
  assert.equal(exhausted.reminders.length, 0);
  const completed = await direct();
  await completed.invoke("ask_boundary", { question: "Which requirement applies?" });
  await completed.invoke("finish_review", { review: "An unresolved finding." });
  completed.hooks.get("turn_end")!(stopped, {});
  assert.equal(completed.reminders.length, 0);
  const failed = await direct();
  await failed.invoke("ask_boundary", { question: "Which requirement applies?" });
  await assert.rejects(failed.invoke("ask_boundary", { question: "duplicate" }));
  failed.hooks.get("turn_end")!(stopped, {});
  assert.equal(failed.reminders.length, 0);
});

for (const reserveAfterTool of [false, true]) test(`actual SDK preserves final submission slot after ${reserveAfterTool ? "a tool result" : "plain final plus reminder"}`, { timeout: 90_000 }, async () => {
  const artifactRoot = await root();
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    requests.push(request);
    const isBoundary = !request.tools?.length;
    const toolResults = request.messages.filter((message: any) => message.role === "tool");
    const finalSlot = request.tools?.length === 1 && request.tools[0].function.name === "finish_review";
    const name = finalSlot ? "finish_review" : toolResults.length < 2 || (reserveAfterTool && toolResults.length === 3) ? "read_source" : toolResults.length === 2 ? "ask_boundary" : "finish_review";
    const args = name === "read_source" ? (toolResults.length === 0 ? { action: "read", source: "source", anchor: "The bridge closes on Monday.", question: "Verify the quoted closure date." } : { action: "expand", source: "source", question: "The returned date lacks the preceding explanation and later restriction." }) : name === "finish_review" ? { review: "SOURCE task-skill: Keep uncertain review findings unresolved. Supplemental source lookup is not Expert-visible evidence. This fixture tests transport only." } : { question: "According to source task-skill, how should an uncertain review finding be expressed?" };
    const plainFinal = !reserveAfterTool && !isBoundary && toolResults.length === 3 && !JSON.stringify(request.messages).includes("尚未通过 finish_review 保存");
    const delta = isBoundary ? { role: "assistant", content: "SOURCE task-skill: ‘Keep uncertain review findings unresolved.’ This source does not resolve a disputed local conclusion." } : plainFinal ? { role: "assistant", content: "My own review is ready, but I have not submitted it." } : { role: "assistant", tool_calls: [{ index: 0, id: `${name}-${toolResults.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
    const finish = isBoundary || plainFinal ? "stop" : "tool_calls";
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const providerPath = join(artifactRoot, "provider.ts");
  await writeFile(providerPath, `export default function(pi) { pi.registerProvider('communication-fixture', {baseUrl: '${origin}/v1', apiKey: 'local-fixture', api: 'openai-completions', models: [{id:'fixture',name:'Fixture',reasoning:false,input:['text'],contextWindow:200000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{supportsDeveloperRole:false}}]}); }`);
  const guardPath = join(artifactRoot, "guard-observer.ts");
  const admissionsPath = join(artifactRoot, "local-admissions.jsonl");
  await writeFile(guardPath, `import {appendFileSync} from 'node:fs'; export default function(pi) { pi.on('before_provider_request', (_event,ctx) => { if(ctx.signal?.aborted) return; appendFileSync(${JSON.stringify(admissionsPath)},JSON.stringify({admitted:true})+'\\n'); }); }`);
  const cfg = config(join(artifactRoot, "stage"));
  cfg.task.extensionPaths = [providerPath, guardPath];
  try {
    const prepared = prepareBoundaryCommunication(cfg);
    const outcome = await runBoundaryCommunication(prepared.configPath);
    assert.equal(outcome.status, "review-saved");
    assert.equal(requests.length, 6);
    const names = ["ask_boundary", "finish_review", "read_source"];
    assert.deepEqual(requests.map(request => (request.tools ?? []).map((tool: any) => tool.function.name)), [names, names, names, [], names, ["finish_review"]]);
    const initial = JSON.stringify(requests[0]);
    assert.doesNotMatch(initial, /FULL_SOURCE|FULL_TARGET|SKILL_TAIL|Write a professional maintenance notice/);
    const initialText = requests[0].messages.map((m: any) => typeof m.content === "string" ? m.content : m.content.map((part: any) => part.text ?? "").join("\n")).join("\n");
    for (const field of projectExpertInput(cfg.expert.localInput).mapping.filter(f => f.displayId)) assert(initialText.includes(field.value), field.path);
    for (const field of projectExpertOutput(cfg.expert.output).mapping) assert(initialText.includes(String(field.value)), field.path);
    assert.doesNotMatch(initialText, /END FIELD|\$\.messages|local-pair\.json|Only the quoted local lines/);
    assert.doesNotMatch(initialText, /\\"sourceAspect\\"|\\\\n/);
    for (let i = 1; i <= 7; i++) assert.match(initial, new RegExp(`SOURCE_EVIDENCE_${i}`));
    for (let i = 1; i <= 4; i++) assert.match(initial, new RegExp(`TARGET_EVIDENCE_${i}`));
    assert.match(initial, /EXPERT_OUTPUT_SENTINEL/);
    const supplemental = JSON.stringify(requests[1].messages.find((message: any) => message.role === "tool"));
    assert.match(supplemental, /harness-supplemental-not-expert-visible/);
    assert.match(supplemental, /The bridge closes on Monday/);
    assert.doesNotMatch(supplemental, /FULL_SOURCE|FULL_TARGET/);
    const expansion = JSON.stringify(requests[2].messages.find((message: any) => message.role === "tool" && message.tool_call_id === "read_source-1"));
    assert.match(expansion, /Before context|Later context/);
    assert.doesNotMatch(expansion, /The bridge closes on Monday|FULL_SOURCE|FULL_TARGET/);
    const boundary = JSON.stringify(requests[3]);
    assert.match(boundary, /SKILL_TAIL/);
    assert.doesNotMatch(boundary, /FULL_SOURCE|FULL_TARGET|EXPERT_OUTPUT_SENTINEL|LOCAL_INPUT_SENTINEL|The bridge closes on Monday|harness-supplemental/);
    const returned = requests[4].messages.find((message: any) => message.role === "tool" && message.tool_call_id === "ask_boundary-2");
    assert.equal(returned.tool_call_id, "ask_boundary-2");
    assert.match(JSON.stringify(returned), /This source does not resolve/);
    assert.equal(requests[3].messages.length, 2);
    assert.equal(requests.slice(0, 5).every(request => request.messages.filter((message: any) => message.role === "user").length === 1), true);
    if (!reserveAfterTool) {
      assert.match(JSON.stringify(requests[5]), /尚未通过 finish_review 保存/);
      assert.match(JSON.stringify(requests[5]), /My own review is ready/);
    } else {
      assert.doesNotMatch(JSON.stringify(requests[5]), /尚未通过 finish_review 保存/);
      assert(requests[5].messages.some((m: any) => m.role === "tool" && m.tool_call_id === "read_source-3"), "The last executed excerpt must be delivered before final submission.");
    }
    const events = await readFile(join(cfg.outputRoot, "review-events.jsonl"), "utf8");
    assert.match(events, /tool_execution_end/);
    assert.match(events, /review-saved/);
    assert.match(events, /"stopReason":"aborted"/);
    const admissions = (await readFile(admissionsPath, "utf8")).trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(admissions.length, 6, "The post-terminal hook must not reach the guarded admission.");
    const boundaryEvents = await readFile(join(cfg.outputRoot, "boundary-events.jsonl"), "utf8");
    assert.doesNotMatch(boundaryEvents, /tool_execution_start/);
    await writeFile(join(artifactRoot, "wire-requests.json"), JSON.stringify(requests, null, 2));
    await writeFile(join(artifactRoot, "proof.json"), JSON.stringify({ kind: "local-provider-transport-not-semantic-quality", requests: 6, paidRequests: 0, expertRequests: 0, defaultFulltextExcluded: true, defaultTaskRulesExcluded: true, originalExpertFieldsExact: true, localEvidenceCounts: [7, 4], firstReadLines: 3, expansionNewLines: 4, supplementalReadBounded: true, supplementalNotAutomaticallySentToBoundary: true, sourceProjectionSeparated: true, boundaryAnswerReturned: true, plainFinalFollowedByOneReminder: !reserveAfterTool, finalSlotReservedAfterTool: reserveAfterTool, finalWireTools: ["finish_review"], finishReceiptSavedByActualTool: true, terminalProviderRequestBlocked: true, toolsChars: JSON.stringify(COMMUNICATION_TOOLS).length, node: process.version, stage: cfg.outputRoot }, null, 2));
    if (process.env.COMMUNICATION_CAPTURE_INDEX) await writeFile(process.env.COMMUNICATION_CAPTURE_INDEX, JSON.stringify({ artifactRoot, stage: cfg.outputRoot }, null, 2));
  } finally {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});
