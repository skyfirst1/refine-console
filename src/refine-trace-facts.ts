import { createHash } from "node:crypto";
import type { RefineTraceIntegrityReport } from "./refine-trace-integrity.js";
import type { PublicTraceRecord } from "./refine-public-trace-records.js";
import type { HarnessTraceStage } from "./refine-harness-self-check.js";

export const TRACE_FACT_VERSION = "observed-public-records-v3-public-spans";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Syntactic source spans, not a classification of reasoning or correctness. */
export function publicAssistantSpans(record: PublicTraceRecord) {
  if (!record.kind.startsWith("assistant_")) return [];
  const spans: Array<{ ref: string; start: number; end: number }> = [];
  const expression = /[^\r\n]+(?:\r?\n(?!\r?\n)[^\r\n]+)*/g;
  for (const match of record.text.matchAll(expression)) {
    spans.push({ ref: `p${digest(`${record.invocationId}:${record.attempt}:${record.sources[0]?.eventRef}`).slice(0, 10)}.${spans.length + 1}`, start: match.index!, end: match.index! + match[0].length });
  }
  return spans;
}

export interface PublicExcerptSelection { anchorRef: string; relatedRefs: string[]; purpose: "public-explanation" | "artifact-observation" }
export function parsePublicExcerptSelection(raw: string): { selections: PublicExcerptSelection[] } {
  const value = parseLiteralJson(raw.trim()) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Object.keys(value).join() !== "selections" || !Array.isArray(value.selections)) throw new Error("Expected only selections array");
  for (const selection of value.selections) {
    if (!selection || typeof selection !== "object" || Object.keys(selection).sort().join() !== "anchorRef,purpose,relatedRefs" || typeof selection.anchorRef !== "string" || !Array.isArray(selection.relatedRefs) || !selection.relatedRefs.every((ref: unknown) => typeof ref === "string") || !["public-explanation", "artifact-observation"].includes(selection.purpose)) throw new Error("Invalid public excerpt selection");
  }
  return value as unknown as { selections: PublicExcerptSelection[] };
}

export function materializePublicExcerptSelections(selections: readonly PublicExcerptSelection[], records: readonly PublicTraceRecord[]) {
  const catalog = new Map(records.flatMap((record, order) => publicAssistantSpans(record).map(span => [span.ref, { record, order, span }] as const)));
  const merged = new Map<string, { anchorRef: string; relatedRefs: string[]; purposes: string[] }>();
  for (const selection of selections) {
    for (const ref of [selection.anchorRef, ...selection.relatedRefs]) if (!catalog.has(ref)) throw new Error(`Unknown assistant paragraph reference: ${ref}`);
    const previous = merged.get(selection.anchorRef);
    merged.set(selection.anchorRef, { anchorRef: selection.anchorRef, purposes: [...new Set([...(previous?.purposes ?? []), selection.purpose])], relatedRefs: [...new Set([...(previous?.relatedRefs ?? []), ...selection.relatedRefs])].filter(ref => ref !== selection.anchorRef) });
  }
  for (const selection of [...merged.values()]) for (const ref of selection.relatedRefs) if (!merged.has(ref)) merged.set(ref, { anchorRef: ref, relatedRefs: [], purposes: ["supporting-source"] });
  const quote = (ref: string) => { const { record, span } = catalog.get(ref)!; return { paragraphRef: ref, invocationId: record.invocationId, stage: record.stage, attempt: record.attempt, sourceRefs: record.sources.map(source => source.eventRef), start: span.start, end: span.end, text: record.text.slice(span.start, span.end), sourceKind: record.kind }; };
  return [...merged.values()].sort((a, b) => { const left = catalog.get(a.anchorRef)!; const right = catalog.get(b.anchorRef)!; return left.order - right.order || left.span.start - right.span.start; }).map(selection => ({ sourceRefs: quote(selection.anchorRef).sourceRefs, kind: "output" as const, tool: null, outcome: "Selected public source excerpt; purpose is the selector's classification, not verified reasoning or correctness.", publicReasoning: null, publicExcerpt: { ...quote(selection.anchorRef), selectionPurposes: selection.purposes, relatedRefs: selection.relatedRefs } }));
}

/** Program observations of role-contract outputs, never inferred author intentions. */
export function programPublicOutputObservations(records: readonly PublicTraceRecord[], roleId: string | null) {
  const selections: PublicExcerptSelection[] = [];
  const changes: Array<{ sourceRefs: string[]; removedParagraphRefs: string[]; addedParagraphRefs: string[]; reordered: boolean }> = [];
  const outputs = records.filter(record => record.kind === "assistant_stop");
  if (roleId === "refine.aspect-extractor") {
    for (const output of outputs) selections.push(...publicAssistantSpans(output).map(span => ({ anchorRef: span.ref, relatedRefs: [], purpose: "artifact-observation" as const })));
  }
  if (["refine.evidence-aligner", "refine.aspect-matcher"].includes(roleId ?? "")) {
    for (const output of outputs) {
      const explicitFields = projectPublicOutputJson(output.text).candidates.filter(candidate => candidate.parseStatus === "parsed" && candidate.literalFields?.some(field => ["rationale", "reason", "reasons"].includes(field.pointer.split("/").at(-1)!)));
      for (const span of publicAssistantSpans(output)) if (explicitFields.some(candidate => span.start < candidate.end && span.end > candidate.start)) selections.push({ anchorRef: span.ref, relatedRefs: [], purpose: "public-explanation" });
    }
  }
  if (roleId === "refine.policy-optimizer") {
    let previous: typeof outputs[number] | undefined;
    for (const output of outputs) {
      const after = publicAssistantSpans(output);
      if (!previous) { selections.push(...after.map(span => ({ anchorRef: span.ref, relatedRefs: [], purpose: "artifact-observation" as const }))); previous = output; continue; }
      const before = publicAssistantSpans(previous), available = new Map<string, number[]>();
      before.forEach((span, index) => { const text = previous!.text.slice(span.start, span.end); available.set(text, [...(available.get(text) ?? []), index]); });
      const added: typeof after = [], matched: number[] = [];
      for (const span of after) { const positions = available.get(output.text.slice(span.start, span.end)); const index = positions?.shift(); if (index === undefined) added.push(span); else matched.push(index); }
      const removed = [...available.values()].flat().sort((a, b) => a - b).map(index => before[index]!);
      const reordered = matched.some((index, position) => position > 0 && index < matched[position - 1]!);
      if (added.length || removed.length || reordered) {
        selections.push(...added.map(span => ({ anchorRef: span.ref, relatedRefs: [], purpose: "artifact-observation" as const })), ...removed.map(span => ({ anchorRef: span.ref, relatedRefs: [], purpose: "artifact-observation" as const })));
        changes.push({ sourceRefs: [...output.sources.map(source => source.eventRef), ...previous.sources.map(source => source.eventRef)], removedParagraphRefs: removed.map(span => span.ref), addedParagraphRefs: added.map(span => span.ref), reordered });
      }
      previous = output;
    }
  }
  return { selections, changes, boundary: "Role-contract public output observations only. A rationale field is a public claim, not verified truth or private thought. Paragraph differences are textual changes, not inferred rule intent or evidence of runtime acceptance." };
}

/** Reject duplicate object keys rather than letting JSON.parse silently select a last value. */
export function parseLiteralJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}\[\],:]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) ?? [];
  let index = 0;
  const visit = (): void => {
    const token = tokens[index++];
    if (token === "{") {
      const keys = new Set<string>();
      if (tokens[index] === "}") { index++; return; }
      while (index < tokens.length) {
        const key = JSON.parse(tokens[index++]!) as string;
        if (keys.has(key)) throw new Error(`Duplicate JSON object key: ${key}`);
        keys.add(key); index++; visit();
        if (tokens[index++] === "}") return;
      }
    } else if (token === "[") {
      if (tokens[index] === "]") { index++; return; }
      while (index < tokens.length) { visit(); if (tokens[index++] === "]") return; }
    }
  };
  visit(); return value;
}

function projectLiteralFields(value: unknown) {
  const fields: Array<{ pointer: string; type: string; value?: string | number | boolean | null; valueSource?: "original-candidate-json" }> = [];
  const pending: Array<{ value: unknown; pointer: string }> = [{ value, pointer: "" }];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.value !== null && typeof current.value === "object") {
      for (const [key, child] of Object.entries(current.value)) pending.push({ value: child, pointer: `${current.pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}` });
    } else {
      const type = current.value === null ? "null" : typeof current.value;
      // Long prose stays once in output.text. Its exact value remains addressable by JSON pointer.
      fields.push(typeof current.value === "string" && current.value.length > 256 ? { pointer: current.pointer, type, valueSource: "original-candidate-json" } : { pointer: current.pointer, type, value: current.value as string | number | boolean | null });
    }
  }
  return fields;
}

/** A syntactic projection only. Parsing never repairs text or approves a business contract. */
export function projectPublicOutputJson(text: string) {
  const candidates: Array<{ start: number; end: number; sha256: string; parseStatus: "parsed" | "invalid-json"; literalFields?: ReturnType<typeof projectLiteralFields>; error?: string }> = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{" && text[start] !== "[") continue;
    const stack: string[] = []; let quoted = false; let escaped = false; let end = text.length;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index]!;
      if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
      if (char === '"') { quoted = true; continue; }
      if (char === "{" || char === "[") stack.push(char);
      if (char === "}" || char === "]") {
        const opening = stack.pop();
        if ((char === "}" && opening !== "{") || (char === "]" && opening !== "[" ) || !stack.length) { end = index + 1; break; }
      }
    }
    const raw = text.slice(start, end);
    try { candidates.push({ start, end, sha256: digest(raw), parseStatus: "parsed", literalFields: projectLiteralFields(parseLiteralJson(raw)) }); }
    catch (error) { candidates.push({ start, end, sha256: digest(raw), parseStatus: "invalid-json", error: error instanceof Error ? error.message : String(error) }); }
    start = end - 1;
  }
  return { status: candidates.length ? "candidates-observed" as const : "opaque-public-text" as const, candidates };
}

export function buildRefineTraceFactProjection(report: RefineTraceIntegrityReport, records: readonly PublicTraceRecord[], stages: readonly HarnessTraceStage[] = [], sanitizeText: (text: string) => string = text => text) {
  const attempts = stages.flatMap(stage => [stage, ...(stage.subtasks ?? [])]).flatMap(stage => (stage.attempts ?? []).map(attempt => ({ stage: stage.stage, ...attempt })));
  return {
    schemaVersion: TRACE_FACT_VERSION,
    category: "refine_observed_trace_facts" as const,
    policy: "Observed public outputs and recorded runtime processing, not business truth. JSON parsing is not contract acceptance. Every candidate is retained; last output is not inferred to be selected. Source spans use UTF-16 offsets into the retained public text. Invalid/unclosed JSON-shaped regions stay opaque; nested substrings are not reinterpreted as accepted candidates. Long string values are referenced by JSON pointer rather than duplicated.",
    invocations: report.completenessMatrix.map(row => {
      const attempt = attempts.find(item => item.taskId === row.invocationId && item.attempt === row.attempt && item.stage === row.stage);
      const outputs = records.filter(record => record.invocationId === row.invocationId && record.attempt === row.attempt && record.stage === row.stage && record.kind.startsWith("assistant_")).map((record, index) => ({
        outputId: `${row.invocationId}:public-output:${index + 1}`,
        kind: record.kind, sources: record.sources, text: record.text, textSha256: digest(record.text),
        json: projectPublicOutputJson(record.text), paragraphSpans: publicAssistantSpans(record),
        businessSelection: "not-inferred" as const,
      }));
      return {
        invocationId: row.invocationId, stage: row.stage, roleId: row.roleId, attempt: row.attempt,
        eventsSource: { path: row.eventsPath, sha256: row.eventsSha256 },
        scope: { complete: row.complete, inputObserved: row.inputObserved, outputObserved: row.outputObserved, terminalObserved: row.terminalObserved },
        recordedProcessing: {
          status: row.status,
          error: attempt?.error || row.errorObservation?.message ? sanitizeText(attempt?.error ?? row.errorObservation!.message) : null,
          errorSource: attempt?.error ? "manifest-attempt" : row.errorObservation ? "integrity-preview" : "none-recorded",
          adapterProvenance: attempt?.adapterProvenance ?? null,
          artifactTerminalAssociations: row.outputArtifactTerminals,
          associationPolicy: "Integrity records artifact association to a terminal event. This is not proof each embedded JSON candidate was accepted; no selected candidate is inferred.",
        },
        // Normalization has already paired duplicate representations of tool results
        // within each actual execution. Keep call identity and complete original values
        // here; semantic compression never produces or reconstructs this index.
        inputAndToolRecords: records.filter(record => record.invocationId === row.invocationId && record.attempt === row.attempt && record.stage === row.stage && !record.kind.startsWith("assistant_")).map(record => ({
          kind: record.kind, toolCallId: record.toolCallId ?? null, sources: record.sources,
          text: record.text, textSha256: digest(record.text),
          json: projectPublicOutputJson(record.text),
        })),
        outputs,
      };
    }),
  };
}
