import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { buildTraceDisclosure, readTraceDisclosure, routineReadOpening } from "../src/refine-trace-disclosure.js";
import { runAgentTask } from "../src/agent-task-runner.js";

const fixture = (label: string) => {
  const quote = `${label} retained because the scope differs; contrary successful cases also matter. ` + "Exact source. ".repeat(1100);
  return { observedFacts: { invocations: [{ invocationId: "invocation", roleId: "refine.review", stage: "candidate-review", attempt: 1,
    recordedProcessing: { status: "completed", error: null }, inputAndToolRecords: [{ kind: "task_input", text: "Compare source and target", sources: [{ eventRef: "event:fixture:L1" }] }],
    outputs: [{ kind: "assistant_stop", sources: [{ eventRef: "event:fixture:L9" }], text: quote }] }] },
    agentExecutions: [{ roleId: "refine.review", events: [{ publicExcerpt: { paragraphRef: "p-private.1", invocationId: "invocation", stage: "candidate-review", attempt: 1, sourceRefs: ["event:fixture:L9"], start: 0, text: quote, selectionPurposes: ["public-explanation"], relatedRefs: [] } }] }] };
};
test("progressive disclosure keeps exact source and boundaries behind semantic handles", async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-disclosure-"));
  const built = await buildTraceDisclosure(root, [{ source: "current", summary: fixture("CURRENT") }, { source: "historical", summary: fixture("EARLIER") }], { description: { label: "Task", text: "Task source" } });
  assert.ok(!JSON.stringify(built.context).includes(root));
  assert.ok(!JSON.stringify(built.context).includes("p-private"));
  const resource: any = await readTraceDisclosure(built.registryPath, built.registrySha256, { source: "current", level: "resource", handle: "description" });
  assert.equal(resource.source, "current"); assert.equal(resource.phase, "task");
  await assert.rejects(readTraceDisclosure(built.registryPath, built.registrySha256, { source: "historical", level: "resource", handle: "description" }), /cross-source substitution/);
  const query = { source: "current" as const, role: "reviewer", keyword: "scope", level: "detail" as const };
  const detail: any = await readTraceDisclosure(built.registryPath, built.registrySha256, query);
  assert.equal(detail.events.length, 1); assert.equal(detail.events[0].complete, false);
  assert.equal(detail.events[0].originalRead.section, "outputs");
  const originalOutput: any = await readTraceDisclosure(built.registryPath, built.registrySha256, detail.events[0].originalRead);
  assert.ok(originalOutput.text.includes("CURRENT retained")); assert.ok(!originalOutput.text.includes("Compare source and target"));
  let text = detail.events[0].text, next = detail.events[0].continuation;
  while (next) { const result: any = await readTraceDisclosure(built.registryPath, built.registrySha256, next); text += result.text; next = result.next; }
  assert.equal(text, fixture("CURRENT").observedFacts.invocations[0]!.outputs[0]!.text);
  await assert.rejects(readTraceDisclosure(built.registryPath, built.registrySha256, { level: "raw", handle: detail.events[0].rawHandle, source: "historical" }), /source/);
  const raw: any = await readTraceDisclosure(built.registryPath, built.registrySha256, { level: "raw", handle: detail.events[0].rawHandle });
  assert.ok(raw.text.includes("Compare source and target"));
  const absent: any = await readTraceDisclosure(built.registryPath, built.registrySha256, { ...query, keyword: "never-occurs" });
  assert.match(absent.boundary, /not evidence of absence/);
  assert.equal(routineReadOpening("I'll read the required files."), true);
  assert.equal(routineReadOpening("I'll read the required files because their scopes differ."), false);
  await writeFile(built.registryPath, "{}");
  await assert.rejects(readTraceDisclosure(built.registryPath, built.registrySha256, query), /verification failed/);
});

test("state changes keep source order, attempts keep separate raw bindings, and empty selections remain browsable", async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-order-")), summary: any = fixture("first");
  const invocation = summary.observedFacts.invocations[0];
  invocation.inputAndToolRecords.push({ kind: "tool_result:error", text: "comparison input unavailable", sources: [{ eventRef: "event:fixture:L6" }] }, { kind: "task_input", text: "Revised scope", sources: [{ eventRef: "event:fixture:L12" }] });
  summary.observedFacts.invocations.push({ ...invocation, invocationId: "separate-later-turn", attempt: 2, inputAndToolRecords: [{ kind: "task_input", text: "A new public revision instruction", sources: [{ eventRef: "event:other:L1" }] }], outputs: [{ kind: "assistant_stop", text: "Second actual output", sources: [{ eventRef: "event:other:L2" }] }] });
  summary.agentExecutions[0].events.push({ publicExcerpt: { ...summary.agentExecutions[0].events[0].publicExcerpt, invocationId: "separate-later-turn", paragraphRef: "different.1", attempt: 2, sourceRefs: ["event:other:L2"], text: "Second actual output" } });
  summary.observedFacts.invocations.push({ ...invocation, invocationId: "empty-selection", roleId: "refine.aspect-extractor", inputAndToolRecords: [], outputs: [] });
  const built = await buildTraceDisclosure(root, [{ source: "current", summary }], {});
  const page: any = await readTraceDisclosure(built.registryPath, built.registrySha256, { role: "reviewer", limit: 8 });
  assert.equal(page.events[0].kind, "Observed tool/runtime failure");
  assert.ok(page.events[1].text.startsWith("first"));
  assert.equal(page.events[2].kind, "Additional task input");
  assert.equal(page.events[3].attempt, 2);
  assert.match(page.events[3].kind, /Different task input/);
  const change = JSON.parse(page.events[3].text);
  assert.equal(change.before, page.events[1].rawHandle); assert.equal(change.after, page.events[4].rawHandle);
  assert.notEqual(page.events[1].rawHandle, page.events[3].rawHandle);
  const catalog: any = await readTraceDisclosure(built.registryPath, built.registrySha256, { role: "aspect_extractor", level: "invocations" });
  assert.equal(catalog.invocations.length, 1);
  assert.ok(built.context.discovery[0]!.roles.some(role => role.role === "aspect_extractor"));
  const registry = JSON.parse(await readFile(built.registryPath, "utf8"));
  await writeFile(registry.raw[page.events[3].rawHandle].path, "corrupted");
  await assert.rejects(readTraceDisclosure(built.registryPath, built.registrySha256, { level: "raw", handle: page.events[3].rawHandle }), /verification failed/);
});

test("configuration navigation does not dump other roles or duplicate shared instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-config-"));
  const built = await buildTraceDisclosure(root, [{ source: "current", summary: fixture("trace") }], {
    configuration: { label: "Role configuration", text: JSON.stringify({ roles: ["reviewer", "judge"] }), source: "current", phase: "configuration", roleParts: { reviewer: { text: "Exact reviewer instruction; shared handle configuration/shared/1" }, judge: { text: "Separate judge instruction" } } },
    "configuration/shared/1": { label: "Shared instruction", text: "Shared instructions only once", listed: false, source: "current", phase: "parent-harness" },
  });
  assert.deepEqual(built.context.resources.map(item => item.handle), ["configuration"]);
  const nav: any = await readTraceDisclosure(built.registryPath, built.registrySha256, { level: "resource", handle: "configuration" });
  assert.ok(!nav.text.includes("Exact reviewer instruction"));
  const role: any = await readTraceDisclosure(built.registryPath, built.registrySha256, { level: "resource", handle: "configuration", role: "reviewer" });
  const implicit: any = await readTraceDisclosure(built.registryPath, built.registrySha256, { source: "current", level: "resource", role: "reviewer" });
  assert.equal(implicit.text, role.text); assert.equal(implicit.handle, "configuration"); assert.equal(implicit.level, "resource");
  const defaultLayer: any = await readTraceDisclosure(built.registryPath, built.registrySha256, { role: "reviewer" });
  assert.equal(defaultLayer.level, "detail");
  await assert.rejects(readTraceDisclosure(built.registryPath, built.registrySha256, { source: "historical", level: "resource", role: "reviewer" }), /cross-source substitution/);
  assert.equal(role.role, "reviewer"); assert.ok(role.text.includes("Exact reviewer instruction")); assert.ok(!role.text.includes("Separate judge"));
  await assert.rejects(readTraceDisclosure(built.registryPath, built.registrySha256, { source: "historical", level: "resource", handle: "configuration", role: "reviewer" }), /cross-source substitution/);
  const shared: any = await readTraceDisclosure(built.registryPath, built.registrySha256, { level: "resource", handle: "configuration/shared/1" });
  assert.equal(shared.text, "Shared instructions only once");
});

test("real Agent registers trace_read, strips cwd from provider request, and executes detail then raw locally", { timeout: 90000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-provider-"));
  const built = await buildTraceDisclosure(root, [{ source: "current", summary: fixture("CURRENT") }], {});
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk; requests.push(JSON.parse(body));
    const nth = requests.length;
    const call = nth === 1 ? { source: "current", role: "reviewer", level: "detail" } : { source: "current", level: "raw", handle: "current/invocation/1" };
    const delta = nth <= 2 ? { role: "assistant", tool_calls: [{ index: 0, id: `call${nth}`, type: "function", function: { name: "trace_read", arguments: JSON.stringify(call) } }] } : { role: "assistant", content: "Offline evidence inspected." };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: `mock${nth}`, object: "chat.completion.chunk", model: "trace-mock", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ id: `mock${nth}`, object: "chat.completion.chunk", model: "trace-mock", choices: [{ index: 0, delta: {}, finish_reason: nth <= 2 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address() as { port: number };
  const extension = join(root, "mock-provider.mjs");
  await writeFile(extension, `export default function(pi){pi.registerProvider('trace-offline',{baseUrl:'http://127.0.0.1:${address.port}/v1',apiKey:'offline-fixture',api:'openai-completions',models:[{id:'trace-mock',name:'Offline',reasoning:false,input:['text'],contextWindow:100000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]});}`);
  try {
    const result = await runAgentTask({ cwd: resolve("."), provider: "trace-offline", model: "trace-mock", systemPrompt: "Inspect public evidence.", prompt: JSON.stringify(built.context), rawEventsPath: join(root, "events.jsonl"), timeoutMs: 60000, extensionPaths: [extension], tools: "trace", traceDisclosure: built });
    assert.equal(requests.length, 3); assert.deepEqual(result.toolNames, ["trace_read", "trace_read"]);
    assert.deepEqual(requests[0].tools.map((tool: any) => tool.function.name), ["trace_read"]);
    const initial = JSON.stringify(requests[0]); assert.ok(!initial.includes("Current working directory")); assert.ok(!initial.includes(built.registrySha256)); assert.ok(!initial.includes("registry.local"));
    assert.ok(requests[2].messages.some((message: any) => message.role === "tool" && message.content.includes("Compare source and target")));
    const events = await readFile(result.rawEventsPath, "utf8"); assert.match(events, /tool_execution_end/);
    await writeFile(join(root, "provider-requests.json"), JSON.stringify(requests, null, 2));
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});
