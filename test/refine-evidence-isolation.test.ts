import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { locateEvidenceParagraphs, buildEvidenceWindows } from "../src/refine-evidence-window.js";
import { importDocumentAspectSet } from "../src/refine-document-aspect-import.js";
import { runRefineExpertEvaluation } from "../src/refine-expert-pipeline.js";
const aspect = (...quotes: string[]) => ({ id: "a", title: "topic", description: "description", evidences: quotes.map(quote => ({ quote, location: "source" })) });
test("paragraphs preserve negation, pending state, order and multiple-evidence mapping", () => {
  const text = "Table added. Values are pending.\r\n\r\nResult is not confirmed. Final review pending.";
  const result = locateEvidenceParagraphs(text, aspect("Final review", "Table added.", "Values are pending."));
  assert.equal(result.status, "available"); if (result.status !== "available") return;
  assert.deepEqual(result.paragraphs.map(p => p.text), text.split("\r\n\r\n"));
  assert.deepEqual(result.paragraphs.map(p => p.evidenceIndices), [[1, 2], [0]]);
  assert.deepEqual(result.evidenceMap.map(p => p.paragraphIndex), [1, 0, 0]);
});
test("ambiguous, missing, cross-paragraph and oversized evidence never produces a truncated window", () => {
  assert.equal(locateEvidenceParagraphs("Same.\n\nSame.", aspect("Same.")).status, "unavailable");
  assert.equal(locateEvidenceParagraphs("A.\n\nB.", aspect("A. B.")).status, "unavailable");
  assert.equal(locateEvidenceParagraphs("A.", aspect("missing")).status, "unavailable");
  const text = "Confirmed. " + "x".repeat(100) + " Not confirmed.";
  assert.equal(buildEvidenceWindows(text, aspect("Confirmed."), "Other.", aspect("Other."), { maxBytes: 30, maxParagraphsPerSide: 2 }).status, "unavailable");
  assert.equal(locateEvidenceParagraphs("one\n\ntwo\n\nthree", aspect("one", "two", "three")).status, "unavailable");
});
test("whitespace normalization retains exact source offsets without fuzzy semantic matching", () => {
  const text = "A\r\n  sentence. It is not final."; const result = locateEvidenceParagraphs(text, aspect("A sentence."));
  assert.equal(result.status, "available"); if (result.status !== "available") return;
  const span = result.evidenceMap[0]!; assert.equal(text.slice(span.start, span.end), "A\r\n  sentence.");
  assert.equal(result.paragraphs[0]!.text, text);
});
test("explicit Document import binds inputs, producer, schema and local bytes without a new model call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "expert-import-")), sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex"), path = (s: string) => join(dir, s);
  try {
    await writeFile(path("doc"), "Document"); await writeFile(path("description"), "Task"); await writeFile(path("events"), "public execution");
    const set = { sourceSha256: sha("Document"), descriptionSha256: sha("Task"), aspects: [aspect("Document")] }, bytes = JSON.stringify(set); await writeFile(path("aspects"), bytes);
    const card: any = { roleId: "refine.aspect-extractor", digest: "card", promptDigest: "prompt", schemaDigest: "schema", toolDigest: "tools" };
    const producer = { taskId: "producer", stage: "current-document-aspect-extraction", provider: "p", model: "m", card, inputArtifacts: [{ path: path("doc"), sha256: sha("Document") }, { path: path("description"), sha256: sha("Task") }], outputArtifacts: [{ path: path("aspects"), sha256: sha(bytes) }], eventsPath: path("events"), eventProvenance: { sha256: sha("public execution") }, attempts: [{ taskId: "producer:attempt-1", eventsPath: path("events") }] };
    const invocation = { provider: "p", model: "m", prompt: "extract", systemPrompt: "card", rawEventsPath: path("events"), trace: { stage: producer.stage, taskId: "producer:attempt-1" } };
    await writeFile(path("producer"), JSON.stringify(producer)); await writeFile(path("invocation"), JSON.stringify(invocation));
    const ref = { path: path("aspects"), sha256: sha(bytes), producerRecordPath: path("producer"), producerRecordSha256: sha(JSON.stringify(producer)), producerInvocationPath: path("invocation"), producerInvocationSha256: sha(JSON.stringify(invocation)) }, expected = { provider: "p", model: "m", card };
    const validate = () => set;
    const imported = await importDocumentAspectSet(ref, path("doc"), path("description"), path("local"), expected, validate);
    assert.equal(imported.provenance.providerCalls, 0); assert.equal((await readFile(path("local"))).toString(), bytes);
    await assert.rejects(importDocumentAspectSet(ref, path("doc"), path("description"), path("other"), { ...expected, card: { ...card, schemaDigest: "changed" } }, validate));
    await writeFile(path("description"), "changed"); await assert.rejects(importDocumentAspectSet(ref, path("doc"), path("description"), path("other"), expected, validate)); await writeFile(path("description"), "Task");
    await writeFile(path("local"), "changed"); await assert.rejects(importDocumentAspectSet(ref, path("doc"), path("description"), path("local"), expected, validate));
    await assert.rejects(importDocumentAspectSet({ ...ref, producerInvocationSha256: "wrong" }, path("doc"), path("description"), path("other"), expected, validate));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("missing Document import does not regenerate an already frozen Gold or call an extractor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "expert-import-missing-")), sha = (s: string) => createHash("sha256").update(s).digest("hex"); let calls = 0;
  try {
    await writeFile(join(dir, "description"), "Task"); await writeFile(join(dir, "doc"), "Document"); await writeFile(join(dir, "gold"), "Gold");
    const goldBytes = JSON.stringify({ sourceSha256: sha("Gold"), descriptionSha256: sha("Task"), aspects: [aspect("Gold")] }); await writeFile(join(dir, "gold-aspects"), goldBytes);
    await assert.rejects(runRefineExpertEvaluation({ cwd: dir, provider: "p", model: "m", timeoutMs: 100, runId: "missing", runDirectory: dir, parentTaskId: "missing", evaluationId: "current", descriptionPath: join(dir, "description"), goldPath: join(dir, "gold"), documentPath: join(dir, "doc"), goldAspectSetPath: join(dir, "gold-aspects"), outputPath: join(dir, "score"), frozenDocumentAspectSet: { path: join(dir, "missing"), sha256: "missing", producerRecordPath: "missing", producerRecordSha256: "missing", producerInvocationPath: "missing", producerInvocationSha256: "missing" }, runner: async () => { calls++; throw Error("Unexpected provider call"); } }));
    assert.equal(calls, 0); assert.equal(await readFile(join(dir, "gold-aspects"), "utf8"), goldBytes);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
