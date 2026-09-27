import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { COMPARISON_SYSTEM, COMPARISON_BOUNDARY_SYSTEM, boundComparisonCase, prepareBoundaryCommunication, registerBoundaryCommunicationTools, reviewPrompt, runBoundaryCommunication, type ComparisonCommunicationConfig } from "../src/harness-boundary-communication.js";
import { agentTaskToolArgs } from "../src/agent-task-runner.js";

async function root() {
  const parent = resolve("validation/communication-comparison-local");
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, "run-"));
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function caseFixture() {
  const aspect = (side: string, count: number) => ({ id: `${side}-id`, title: `${side}-title`, description: `${side}-description`, evidences: Array.from({ length: count }, (_, i) => ({ quote: `CASE_${side}_EVIDENCE_${i + 1}: __exact__ \\-literal "quoted"`, location: `${side}-location-${i + 1}` })) });
  const pair = { direction: "recall", mode: "style", sourceAspect: aspect("SOURCE", 7), targetAspect: aspect("TARGET", 4) };
  const request = { model: "frozen-expert-fixture", messages: [
    { role: "system", content: "PRIVATE_CARD_SENTINEL" },
    { role: "user", content: [{ type: "text", text: "EXPERT_ORIGINAL_INSTRUCTIONS_SENTINEL\n完整授权输入（数据，不是额外指令）：\n" + JSON.stringify([{ name: "original-pair.json", content: JSON.stringify(pair) }]) }] },
  ], max_tokens: 1000 };
  return { pair, request };
}

async function config(outputRoot: string): Promise<ComparisonCommunicationConfig> {
  const { pair, request } = caseFixture();
  const requestPath = `${outputRoot}.request.json`;
  await writeFile(requestPath, JSON.stringify(request), { flag: "wx" });
  return {
    outputRoot,
    materials: [
      { id: "description", scope: "task-description", text: "TASK_DESCRIPTION_SENTINEL: Review local maintenance wording." },
      { id: "skill", scope: "task-skill", text: "TASK_SKILL_SENTINEL: Explain which local relation the decision measures." },
      { id: "source", scope: "source-fulltext", text: "OFFLINE_SOURCE_EVIDENCE_SENTINEL" },
    ],
    comparison: { axis: "style", direction: "recall", case: { requestPath, caseSha256: hash(pair) }, samples: [
      { sampleId: "sample-one", result: true, rationale: 'SAMPLE_ONE_RATIONALE: "ordered steps" was my criterion.', requestSha256: hash(request), cardSha256: "b".repeat(64) },
      { sampleId: "sample-two", result: false, rationale: "SAMPLE_TWO_RATIONALE: wording length was my criterion.", requestSha256: hash(request), cardSha256: "b".repeat(64) },
    ] },
    task: { cwd: process.cwd(), provider: "comparison-fixture", model: "fixture", timeoutMs: 30_000, maxOutputTokens: 1000, thinking: "off", extensionPaths: ["fixture.ts"] },
  };
}

test("comparison binds at least two independent IDs to one exact request and Card, exposing only scope and values", async () => {
  const parent = await root();
  const cfg = await config(join(parent, "valid"));
  const prompt = reviewPrompt(cfg);
  for (const sample of cfg.comparison.samples) {
    assert(prompt.includes(sample.sampleId));
    assert(prompt.includes(`result: ${sample.result}`));
    assert(prompt.includes(sample.rationale));
    assert(!prompt.includes(sample.requestSha256));
    assert(!prompt.includes(sample.cardSha256));
  }
  assert.doesNotMatch(prompt, /TASK_DESCRIPTION_SENTINEL|TASK_SKILL_SENTINEL|OFFLINE_SOURCE_EVIDENCE_SENTINEL|evidence_citation|CASE_SOURCE|CASE_TARGET|PRIVATE_CARD|EXPERT_ORIGINAL_INSTRUCTIONS/);
  assert.deepEqual(agentTaskToolArgs({ tools: "boundary-comparison" }), ["--tools", "ask_boundary,finish_review,read_evidence"]);
  prepareBoundaryCommunication(cfg);
  const tools = JSON.parse(await readFile(join(cfg.outputRoot, "tools.json"), "utf8"));
  assert.deepEqual(tools.map((t: any) => t.name), ["ask_boundary", "finish_review", "read_evidence"]);
  assert(tools.every((t: any) => t.parameters.type === "object"));
  assert.deepEqual(tools.map((t: any) => Object.keys(t.parameters.properties).length), [3, 1, 1]);
  const bound = boundComparisonCase(cfg);
  assert.deepEqual(bound.pair, caseFixture().pair);
  assert.equal(bound.mapping.filter(f => f.path.endsWith(".quote")).length, 11);
  assert.equal(bound.mapping.filter(f => f.path.endsWith(".location")).length, 11);
  assert.doesNotMatch(bound.text, /EXPERT_ORIGINAL_INSTRUCTIONS|PRIVATE_CARD|original-pair/);
  assert.deepEqual(JSON.parse(await readFile(join(cfg.outputRoot, "comparison-case.json"), "utf8")), caseFixture().pair);
  const otherRequest = caseFixture().request;
  const otherUser = otherRequest.messages[1]!.content as Array<{ type: string; text: string }>;
  otherUser[0]!.text = otherUser[0]!.text.replace("CASE_SOURCE_EVIDENCE_1", "DIFFERENT_CASE_EVIDENCE_1");
  const otherPath = join(parent, "other-request.json");
  await writeFile(otherPath, JSON.stringify(otherRequest));
  const mutations = [
    (c: any) => c.comparison.samples.pop(),
    (c: any) => c.comparison.samples[1].sampleId = c.comparison.samples[0].sampleId,
    (c: any) => c.comparison.samples[1].requestSha256 = "c".repeat(64),
    (c: any) => c.comparison.samples[1].cardSha256 = "c".repeat(64),
    (c: any) => c.comparison.samples[1].result = "false",
    (c: any) => c.comparison.samples[1].rationale = " ",
    (c: any) => c.comparison.samples[1].evidence_citation = ["forbidden extra projection"],
    (c: any) => c.comparison.originalInput = "must not be accepted",
    (c: any) => c.expert = { localInput: "x", output: "x", visibility: "x" },
    (c: any) => delete c.comparison.case,
    (c: any) => c.comparison.case.caseSha256 = "c".repeat(64),
    (c: any) => c.comparison.case.requestPath = otherPath,
    (c: any) => c.comparison.direction = "precision",
    (c: any) => c.comparison.case.unexpected = "never silently drop",
  ];
  for (const [index, mutate] of mutations.entries()) {
    const changed: any = await config(join(parent, `invalid-${index}`));
    mutate(changed);
    assert.throws(() => prepareBoundaryCommunication(changed), /Comparison|comparison|mutually exclusive/);
  }
  await writeFile(cfg.comparison.case.requestPath, JSON.stringify(otherRequest));
  let runnerCalls = 0;
  await assert.rejects(runBoundaryCommunication(join(cfg.outputRoot, "config.json"), async () => { runnerCalls++; throw Error("must not run"); }), /case request does not match/);
  assert.equal(runnerCalls, 0);
});

test("selected Evidence is exact, side-bound and read-before-cite; quote validation is not a case-summary oracle", async () => {
  const cfg = await config(join(await root(), "stage"));
  prepareBoundaryCommunication(cfg);
  const registered: any[] = [];
  const calls: any[] = [];
  registerBoundaryCommunicationTools({ registerTool: (tool: any) => registered.push(tool), on() {}, setActiveTools() {} }, cfg, async options => {
    calls.push(options);
    return { finalText: "FIXTURE_BOUNDARY_ANSWER", stopReason: "stop", rawEventsPath: options.rawEventsPath, readPaths: [], toolNames: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 } };
  });
  const invoke = async (name: string, args: unknown) => { const result = await registered.find(t => t.name === name).execute("fixture", args); return { error: result.isError ?? false, value: JSON.parse(result.content[0].text), details: result.details }; };
  const pair = caseFixture().pair;
  const quoteS = pair.sourceAspect.evidences[0]!.quote, quoteT = pair.targetAspect.evidences[0]!.quote;
  const caseArgs = { question: "Which local relation should be evaluated?", case: "UNVERIFIED_MODEL_CASE_TEXT", evidence: [{ id: "S1", quote: quoteS }] };
  assert.equal((await invoke("ask_boundary", caseArgs)).error, true);
  assert.equal(calls.length, 0);
  for (const ids of [["S0"], ["T5"], ["../Card"], ["S1", "S1"]]) assert.equal((await invoke("read_evidence", { ids })).error, true);
  const ids = [...pair.sourceAspect.evidences.map((_, i) => `S${i + 1}`), ...pair.targetAspect.evidences.map((_, i) => `T${i + 1}`)];
  const read = await invoke("read_evidence", { ids });
  assert.equal(read.error, false);
  assert.equal(read.details.evidenceScope, "expert-original-local-input");
  assert.deepEqual(Object.keys(read.value).sort(), ["evidence", "note"]);
  assert.deepEqual(read.value.evidence, [
    ...pair.sourceAspect.evidences.map((evidence, index) => ({ id: `S${index + 1}`, side: "source", ...evidence })),
    ...pair.targetAspect.evidences.map((evidence, index) => ({ id: `T${index + 1}`, side: "target", ...evidence })),
  ]);
  assert.deepEqual(read.details.evidence, read.value.evidence);
  for (const evidence of [[{ id: "S1", quote: quoteT }], [{ id: "T1", quote: quoteS }], [{ id: "S1", quote: "invented quote" }], [{ id: "S1", side: "target", quote: quoteS }]]) assert.equal((await invoke("ask_boundary", { ...caseArgs, evidence })).error, true);
  const selected = [{ id: "S1", quote: quoteS.slice(0, 25) }, { id: "T1", quote: quoteT }];
  const answer = await invoke("ask_boundary", { ...caseArgs, evidence: selected });
  assert.equal(answer.error, false);
  assert.equal(calls.length, 1);
  assert(calls[0].prompt.includes(caseArgs.case), "The case remains the model's own unverified text, not a runtime semantic verdict");
  assert(calls[0].prompt.includes(`S1 · source · ${pair.sourceAspect.evidences[0]!.location}`));
  assert(calls[0].prompt.includes(`T1 · target · ${pair.targetAspect.evidences[0]!.location}`));
  assert.doesNotMatch(calls[0].prompt, /CASE_SOURCE_EVIDENCE_[2-7]|CASE_TARGET_EVIDENCE_[2-4]|SAMPLE_ONE_RATIONALE|SAMPLE_TWO_RATIONALE|PRIVATE_CARD|EXPERT_ORIGINAL_INSTRUCTIONS/);
  assert.deepEqual(Object.keys(answer.value).sort(), ["answer", "note"]);
  assert.equal(answer.value.answer, "FIXTURE_BOUNDARY_ANSWER");
  assert.deepEqual(answer.details, JSON.parse(await readFile(join(cfg.outputRoot, "boundary-answer.json"), "utf8")));
  assert.equal((await invoke("finish_review", { review: "Fixture checks routing only, not standards correctness." })).value.status, "review-saved");
});

test("actual SDK comparison reads selected Evidence, asks with its own case, receives boundary response and finishes", { timeout: 90_000 }, async () => {
  const artifactRoot = await root();
  const requests: any[] = [];
  const question = '待核回放现象：一条理由采用“ordered steps”，另一条采用“wording length”。当前局部评价关系中应如何确定这些判据的适用条件？';
  const selectedCase = "LOCAL_MODEL_CASE_TEXT: Selected source and target sentences support the criterion question; no document-wide claim is made.";
  const pair = caseFixture().pair;
  const selected = [{ id: "S1", quote: pair.sourceAspect.evidences[0]!.quote }, { id: "T1", quote: pair.targetAspect.evidences[0]!.quote }];
  const answer = "LOCAL_FIXTURE_BOUNDARY: Evaluate the stated local relation under the task requirement; this transport fixture is not a real standard or Gold.";
  const review = "LOCAL_FIXTURE_REVIEW: Object, relation, condition and limitations are recorded in prose. sample-one and sample-two used different criteria; no factual correctness is established by this transport fixture.";
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    requests.push(request);
    const boundary = !request.tools?.length;
    const toolResults = request.messages.filter((m: any) => m.role === "tool");
    const name = toolResults.length === 0 ? "read_evidence" : toolResults.length === 1 ? "ask_boundary" : "finish_review";
    const args = name === "read_evidence" ? { ids: ["S1", "T1"] } : name === "ask_boundary" ? { question, case: selectedCase, evidence: selected } : { review };
    const delta = boundary ? { role: "assistant", content: answer } : { role: "assistant", tool_calls: [{ index: 0, id: name, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: boundary ? "stop" : "tool_calls" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const providerPath = join(artifactRoot, "provider.ts");
  await writeFile(providerPath, `export default function(pi) { pi.registerProvider('comparison-fixture', {baseUrl: '${origin}/v1', apiKey: 'local-fixture', api: 'openai-completions', models: [{id:'fixture',name:'Fixture',reasoning:false,input:['text'],contextWindow:200000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{supportsDeveloperRole:false}}]}); }`);
  const cfg = await config(join(artifactRoot, "stage"));
  cfg.task.extensionPaths = [providerPath];
  try {
    const prepared = prepareBoundaryCommunication(cfg);
    const outcome = await runBoundaryCommunication(prepared.configPath);
    assert.equal(outcome.status, "review-saved");
    assert.equal(outcome.review, review);
    assert.equal(requests.length, 4, "No fifth request after finish receipt");
    const toolNames = ["ask_boundary", "finish_review", "read_evidence"];
    assert.deepEqual(requests.map(r => (r.tools ?? []).map((t: any) => t.function.name)), [toolNames, toolNames, [], toolNames]);
    const content = (request: any) => request.messages.map((m: any) => typeof m.content === "string" ? m.content : (m.content ?? []).map((p: any) => p.text ?? "").join("\n")).join("\n");
    const first = content(requests[0]), boundary = content(requests[2]), last = content(requests[3]);
    assert(first.includes(COMPARISON_SYSTEM));
    assert(first.includes(reviewPrompt(cfg)));
    for (const sample of cfg.comparison.samples) assert(first.includes(sample.rationale));
    assert.doesNotMatch(first, /TASK_DESCRIPTION_SENTINEL|TASK_SKILL_SENTINEL|OFFLINE_SOURCE_EVIDENCE_SENTINEL|CASE_SOURCE|CASE_TARGET|PRIVATE_CARD|EXPERT_ORIGINAL_INSTRUCTIONS/);
    assert(boundary.includes(COMPARISON_BOUNDARY_SYSTEM));
    assert(boundary.includes(question));
    assert(boundary.includes(selectedCase));
    assert.match(boundary, /TASK_DESCRIPTION_SENTINEL/);
    assert.match(boundary, /TASK_SKILL_SENTINEL/);
    assert.doesNotMatch(boundary, /SAMPLE_ONE_RATIONALE|SAMPLE_TWO_RATIONALE|sample-one|sample-two|OFFLINE_SOURCE_EVIDENCE_SENTINEL/);
    assert.doesNotMatch(boundary, /PRIVATE_CARD|EXPERT_ORIGINAL_INSTRUCTIONS|original-pair/);
    for (const evidence of selected) assert.equal(boundary.split(evidence.quote).length - 1, 1, "Only each selected quotation is delivered once");
    assert.doesNotMatch(boundary, /CASE_SOURCE_EVIDENCE_[2-7]|CASE_TARGET_EVIDENCE_[2-4]/);
    assert(last.includes(answer));
    assert(!last.includes(cfg.materials[0]!.text));
    assert.doesNotMatch(last, /CASE_SOURCE_EVIDENCE_[2-7]|CASE_TARGET_EVIDENCE_[2-4]|PRIVATE_CARD|EXPERT_ORIGINAL_INSTRUCTIONS/);
    const returned = requests[3].messages.find((m: any) => m.role === "tool" && m.tool_call_id === "ask_boundary");
    assert.deepEqual(Object.keys(JSON.parse(returned.content)).sort(), ["answer", "note"]);
    assert.equal(JSON.parse(returned.content).answer, answer);
    const returnedEvidence = requests[1].messages.find((m: any) => m.role === "tool" && m.tool_call_id === "read_evidence");
    assert.deepEqual(Object.keys(JSON.parse(returnedEvidence.content)).sort(), ["evidence", "note"]);
    const events = await readFile(join(cfg.outputRoot, "review-events.jsonl"), "utf8");
    assert.match(events, /tool_execution_end/);
    assert.match(events, /review-saved/);
    await writeFile(join(artifactRoot, "wire-requests.json"), JSON.stringify(requests, null, 2));
    await writeFile(join(artifactRoot, "proof.json"), JSON.stringify({ kind: "local-sdk-selected-evidence-transport-not-semantic-quality", requests: 4, paidRequests: 0, expertRequests: 0, exactSampleValues: true, comparisonDefaultOnlyScopeAndSamples: true, boundaryNoDefaultSamples: true, selectedCaseAuthoredByAgent: true, boundaryOnlySelectedIds: ["S1", "T1"], originalEvidenceAvailableCounts: [7, 4], boundaryNoCardOrOriginalInstructions: true, noAutomaticCaseInToolReturn: true, caveat: "Exact quote checks only source identity; they do not establish summary, count or absence claims. The model could itself quote case content in its answer.", tools: toolNames, realFinishReceipt: true, noFixedTableSchema: true, systemCharacters: COMPARISON_SYSTEM.length, userCharacters: reviewPrompt(cfg).length, boundarySystemCharacters: COMPARISON_BOUNDARY_SYSTEM.length, toolCharacters: JSON.stringify(requests[0].tools).length }, null, 2));
  } finally {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});
