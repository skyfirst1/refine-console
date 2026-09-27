import test from "node:test";
import assert from "node:assert/strict";
import { publicAssistantSpans, parsePublicExcerptSelection, materializePublicExcerptSelections, programPublicOutputObservations } from "../src/refine-trace-facts.js";
import type { PublicTraceRecord } from "../src/refine-public-trace-records.js";

const record = (line: number, text: string, kind = "assistant_stop"): PublicTraceRecord => ({ invocationId: "attempt", stage: "review", attempt: 1, status: "completed", kind, text, sources: [{ eventRef: `event:fixture:L${line}`, eventType: "message_end", metadata: {} }] });
test("source selection quotes exact public spans and orders late decisions after earlier evidence", () => {
  const early = record(2, "Earlier comparison retained condition A.\n\nContrary observation kept for comparison.");
  const late = record(20, "Later revision rejects A because the stated scope already covers it.");
  const earlyRefs = publicAssistantSpans(early), lateRef = publicAssistantSpans(late)[0]!.ref;
  const events = materializePublicExcerptSelections([
    { anchorRef: lateRef, relatedRefs: [earlyRefs[0]!.ref], purpose: "public-explanation" },
    { anchorRef: earlyRefs[0]!.ref, relatedRefs: [], purpose: "public-explanation" },
    { anchorRef: earlyRefs[1]!.ref, relatedRefs: [], purpose: "public-explanation" },
  ], [early, late]);
  assert.equal(events[2]!.sourceRefs[0], "event:fixture:L20");
  assert.equal(events[2]!.publicExcerpt.text, late.text);
  assert.equal(events[2]!.publicExcerpt.relatedRefs[0], earlyRefs[0]!.ref);
  assert.equal(events[0]!.publicExcerpt.text, early.text.slice(earlyRefs[0]!.start, earlyRefs[0]!.end));
  assert.ok(events.every(event => event.publicReasoning === null));
});
test("artifact selection is a labelled selector claim, never invented original reasoning", () => {
  const artifact = record(3, '<<<RESULT>>>\n{"matched":false,"rationale":"A condition is absent"}\n<<<END>>>');
  const anchorRef = publicAssistantSpans(artifact)[0]!.ref;
  const selection = parsePublicExcerptSelection(JSON.stringify({ selections: [{ anchorRef, relatedRefs: [], purpose: "artifact-observation" }] }));
  const event = materializePublicExcerptSelections(selection.selections, [artifact])[0]!;
  assert.equal(event.publicExcerpt.text, artifact.text);
  assert.deepEqual(event.publicExcerpt.selectionPurposes, ["artifact-observation"]);
  assert.equal(event.publicReasoning, null);
  assert.throws(() => parsePublicExcerptSelection(JSON.stringify({ selections: [{ anchorRef, relatedRefs: [], purpose: "public-explanation", reason: "invented" }] })));
});
test("tool and absent references cannot become assistant anchors; duplicate selection merges by source only", () => {
  const tool = record(4, "Tool result", "tool_result:completed"), assistant = record(5, "Same words");
  assert.deepEqual(publicAssistantSpans(tool), []);
  assert.throws(() => materializePublicExcerptSelections([{ anchorRef: "event:fixture:L4", relatedRefs: [], purpose: "public-explanation" }], [tool, assistant]));
  const anchorRef = publicAssistantSpans(assistant)[0]!.ref;
  const selection = { anchorRef, relatedRefs: [], purpose: "public-explanation" as const };
  assert.equal(materializePublicExcerptSelections([selection, selection], [tool, assistant]).length, 1);
  const another = record(6, "Same words");
  assert.equal(materializePublicExcerptSelections([selection, { ...selection, anchorRef: publicAssistantSpans(another)[0]!.ref }], [assistant, another]).length, 2);
});

test("program retains explicit structured public claims regardless of boolean while tool field names do not become explanations", () => {
  const outputs = [record(1, '{"matched":true,"rationale":"Both claims cover the condition"}'), record(2, '{"matched":false,"rationale":"One claim omits the condition"}'), record(3, '{"rationale":"Input example only"}', 'tool_result:completed')];
  const observed = programPublicOutputObservations(outputs, "refine.evidence-aligner");
  assert.equal(observed.selections.length, 2);
  const events = materializePublicExcerptSelections(observed.selections, outputs);
  assert.equal(events[0]!.publicExcerpt.text, outputs[0]!.text);
  assert.equal(events[1]!.publicExcerpt.text, outputs[1]!.text);
  assert.ok(events.every(event => event.publicReasoning === null));
});

test("artifact text changes retain removed and replacement source paragraphs and do not classify moves as deletion", () => {
  const before = record(10, "Rule A\n\nRule B\n\nRule C"), after = record(20, "Rule C\n\nRule A\n\nReplacement B");
  const observed = programPublicOutputObservations([before, after], "refine.policy-optimizer");
  assert.equal(observed.changes.length, 1); assert.equal(observed.changes[0]!.reordered, true);
  assert.deepEqual(observed.changes[0]!.removedParagraphRefs, [publicAssistantSpans(before)[1]!.ref]);
  assert.deepEqual(observed.changes[0]!.addedParagraphRefs, [publicAssistantSpans(after)[2]!.ref]);
  const events = materializePublicExcerptSelections(observed.selections, [before, after]);
  assert.ok(events.some(event => event.publicExcerpt.text === "Rule B"));
  assert.ok(events.some(event => event.publicExcerpt.text === "Replacement B"));
  const deletionOnly = programPublicOutputObservations([before, record(30, "Rule A\n\nRule C")], "refine.policy-optimizer");
  assert.equal(deletionOnly.changes[0]!.addedParagraphRefs.length, 0);
  assert.equal(deletionOnly.changes[0]!.removedParagraphRefs.length, 1);
});

test("structured extraction artifacts remain visible without model-selected explanations", () => {
  const output = record(8, '{"aspects":[{"id":"aspect-A","text":"Condition A","evidence":"exact original evidence"}]}');
  const observed = programPublicOutputObservations([output], "refine.aspect-extractor");
  const events = materializePublicExcerptSelections(observed.selections, [output]);
  assert.equal(events[0]!.publicExcerpt.text, output.text);
  assert.deepEqual(events[0]!.publicExcerpt.selectionPurposes, ["artifact-observation"]);
  assert.equal(events[0]!.publicReasoning, null);
});
