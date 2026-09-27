import assert from "node:assert/strict";
import test from "node:test";
import { buildRefineTraceFactProjection, parseLiteralJson, projectPublicOutputJson } from "../src/refine-trace-facts.js";
import type { RefineTraceIntegrityReport } from "../src/refine-trace-integrity.js";
import type { PublicTraceRecord } from "../src/refine-public-trace-records.js";

test("JSON projection preserves multiple observed candidates and false/null literals without selecting one", () => {
  const text = 'First {"matched":false,"targetAspectId":null} then {"matched":true,"targetAspectId":"aspect-1"}';
  const result = projectPublicOutputJson(text);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates.map(item => Object.fromEntries(item.literalFields!.map(field => [field.pointer.slice(1), field.value]))), [{ targetAspectId: null, matched: false }, { targetAspectId: "aspect-1", matched: true }]);
  for (const candidate of result.candidates) assert.ok(text.slice(candidate.start, candidate.end).startsWith("{"));
  assert.equal(projectPublicOutputJson("The earlier criticism is withdrawn: the Draft already has this boundary.").status, "opaque-public-text");
});

test("duplicate keys never silently collapse and unclosed regions remain opaque without quadratic suffix extraction", () => {
  assert.throws(() => parseLiteralJson('{"matched":false,"matched":true}'), /Duplicate/);
  assert.throws(() => parseLiteralJson('{"nested":{"x":1,"x":2}}'), /Duplicate/);
  assert.deepEqual(parseLiteralJson('[{"x":1},{"x":2}]'), [{ x: 1 }, { x: 2 }]);
  const outputs = projectPublicOutputJson('broken { before {"matched":false}');
  assert.equal(outputs.candidates[0]!.parseStatus, "invalid-json");
  assert.equal(outputs.candidates.length, 1);
  assert.equal(projectPublicOutputJson("{".repeat(20_000)).candidates.length, 1);
});

test("fact projection preserves invocation identity, opaque outputs and full recorded errors without inferred acceptance", () => {
  const row = (invocationId: string, attempt: number) => ({ invocationId, attempt, stage: "precision-match-1", roleId: "matcher", status: attempt === 1 ? "failed" : "completed", eventsPath: `${invocationId}.jsonl`, eventsSha256: "digest", complete: true, inputObserved: true, outputObserved: true, terminalObserved: true, errorObservation: attempt === 1 ? { message: "preview" } : null, outputArtifactTerminals: [] });
  const report = { completenessMatrix: [row("a", 1), row("b", 2)] } as unknown as RefineTraceIntegrityReport;
  const record = (invocationId: string, attempt: number, text: string): PublicTraceRecord => ({ invocationId, attempt, stage: "precision-match-1", status: "completed", kind: "assistant_stop", text, sources: [{ eventRef: `event:hash:L${attempt}`, eventType: "message_end", metadata: {} }] });
  const error = "validator rejected: " + "x".repeat(500);
  const projection = buildRefineTraceFactProjection(report, [record("a", 1, '{"matched":false,"targetAspectId":null}'), record("a", 1, "Correction: no evidence supports the previous criticism."), record("b", 2, '{"matched":false,"targetAspectId":null}')], [{ stage: "precision-match-1", taskId: "stage", attempts: [{ taskId: "a", attempt: 1, status: "failed", error }] }]);
  assert.equal(projection.invocations.length, 2);
  assert.equal(projection.invocations[0]!.recordedProcessing.error, error);
  assert.equal(projection.invocations[0]!.outputs.length, 2);
  assert.equal(projection.invocations[0]!.outputs[1]!.json.status, "opaque-public-text");
  assert.equal(projection.invocations[1]!.outputs.length, 1);
  assert.ok(projection.invocations.flatMap(item => item.outputs).every(item => item.businessSelection === "not-inferred"));
  assert.match(projection.policy, /not business truth/);
  const tool = { ...record("a", 1, JSON.stringify({ ids: ["first", "last"], matched: false, result: 0, longValue: "complete".repeat(500) })), kind: "tool_result:completed", toolCallId: "read-1" };
  const withTool = buildRefineTraceFactProjection(report, [tool]);
  const indexed = withTool.invocations[0]!.inputAndToolRecords[0]!;
  assert.equal(indexed.text, tool.text);
  assert.equal(indexed.toolCallId, "read-1");
  assert.deepEqual(indexed.sources, tool.sources);
  assert.equal(indexed.json.candidates[0]!.literalFields!.find(field => field.pointer === "/matched")!.value, false);
  assert.equal(indexed.json.candidates[0]!.literalFields!.find(field => field.pointer === "/result")!.value, 0);
  assert.equal(indexed.json.candidates[0]!.literalFields!.find(field => field.pointer === "/ids/1")!.value, "last");
});
