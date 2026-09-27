import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";

export const TRACE_DISCLOSURE_VERSION = "progressive-public-trace-v1";
export interface DisclosureResource { label: string; text: string; source?: "current" | "historical"; phase?: string; listed?: boolean; roleParts?: Record<string, { text: string }> }
type SourceName = "current" | "historical";
interface Entry { handle: string; source: SourceName; origin: string; role: string; stage: string; sequence: number; localOrder?: number; attempt: number; kind: string; text: string; rawHandle: string; rawSection?: "inputs" | "outputs" | "all"; related: string[] }
interface Registry { version: string; entries: Entry[]; raw: Record<string, { path: string; sha256: string; origin: string; role: string; stage: string; sequence: number; source: SourceName }>; resources: Record<string, DisclosureResource & { source: SourceName; phase: string }>; logPath: string }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const origins = { current: "当前执行：本次任务 Description 与当前 Writing Skill 驱动的 Refine", historical: "较早执行：同一任务 Description、同批较早 Writing Skill 驱动的 Refine；只能作参照或反证，不能当当前执行" };
export const traceRoleName = (role: string | null) => ({ "refine.review": "reviewer", "refine.policy-optimizer": "policy_optimizer", "refine.draft": "draft", "refine.aspect-extractor": "aspect_extractor", "refine.aspect-matcher": "matcher", "refine.evidence-aligner": "aligner", "refine.independent-judge": "judge" }[role ?? ""] ?? role?.replace("refine.", "") ?? "task");
// This presentation-only filter removes only complete, content-free acknowledgements.
// Any extra clause, comparison, negation or reason fails the exact pattern and remains.
export function routineReadOpening(text: string) { return /^(?:(?:I(?:'ll| will)) (?:read|start by reading)|Let me read) (?:the )?(?:(?:two|three|both|all) )?(?:required|specified) (?:files|inputs|documents)(?: first)?[.!]?$/i.test(text.trim()); }
function preview(text: string, limit = 180) {
  const clean = text.replace(/[A-Za-z]:[\\/][^\s"<>]+/g, "[本地原文入口]").replace(/\b[0-9a-f]{32,64}\b/gi, "[本地校验值]");
  return { excerpt: clean.slice(0, limit), shortened: clean.length > limit };
}

/** Uses already source-validated v6 results. No model creates this registry or its facts. */
export async function buildTraceDisclosure(root: string, sources: Array<{ source: SourceName; summary: any }>, resources: Record<string, DisclosureResource>) {
  await mkdir(root, { recursive: true });
  const registry: Registry = { version: TRACE_DISCLOSURE_VERSION, entries: [], raw: {}, resources: Object.fromEntries(Object.entries(resources).map(([handle, resource]) => [handle, { ...resource, source: resource.source ?? "current", phase: resource.phase ?? "task" }])), logPath: join(root, "reads.jsonl") };
  const invocationKey = (item: any) => `${item.invocationId}:${item.stage}:${item.attempt}`;
  const sourceLine = (refs: any[]) => Number(String(refs[0]?.eventRef ?? refs[0] ?? "").match(/:L(\d+)/)?.[1] ?? 0);
  for (const { source, summary } of sources) {
    const origin = origins[source], invocations = new Map<string, string>();
    for (const [index, invocation] of summary.observedFacts.invocations.entries()) {
      const handle = `${source}/invocation/${index + 1}`, path = join(root, `${source}-raw-${index + 1}.json`), raw = JSON.stringify(invocation, null, 2);
      await writeFile(path, raw); registry.raw[handle] = { path, sha256: hash(raw), origin, role: traceRoleName(invocation.roleId), stage: invocation.stage, sequence: index + 1, source }; invocations.set(invocationKey(invocation), handle);
    }
    const paragraphHandles = new Map<string, string>();
    for (const execution of summary.agentExecutions) {
      const role = traceRoleName(execution.roleId);
      for (const event of execution.events) {
        const quote = event.publicExcerpt;
        if (!quote) continue;
        if (routineReadOpening(quote.text)) continue;
        const handle = `${source}/${role}/${registry.entries.filter(entry => entry.source === source && entry.role === role).length + 1}`;
        paragraphHandles.set(quote.paragraphRef, handle);
        registry.entries.push({ handle, source, origin, role, stage: quote.stage, sequence: registry.entries.length + 1, attempt: quote.attempt, kind: quote.selectionPurposes?.includes("artifact-observation") ? "公开产物（不是解释）" : "公开陈述/比较（需核对原文，不保证判断正确）", text: quote.text, rawSection: "outputs", localOrder: sourceLine(quote.sourceRefs) + quote.start / 1_000_000, rawHandle: invocations.get(invocationKey(quote))!, related: quote.relatedRefs ?? [] });
      }
    }
    for (const execution of summary.agentExecutions) for (const event of execution.events) {
      if (event.publicExcerpt) continue;
      let change: any; try { change = JSON.parse(event.outcome).programParagraphTextChange; } catch { continue; }
      if (!change) continue;
      const related = [...change.removedParagraphRefs, ...change.addedParagraphRefs].map(ref => paragraphHandles.get(ref)).filter(Boolean);
      const existing = registry.entries.find(entry => related.includes(entry.handle));
      if (!existing) continue;
      const terminal = summary.observedFacts.invocations.find((invocation: any) => invocation.outputs.some((output: any) => output.sources.some((ref: any) => ref.eventRef === change.sourceRefs[0])));
      registry.entries.push({ ...existing, handle: `${source}/${existing.role}/change-${registry.entries.length + 1}`, stage: terminal?.stage ?? existing.stage, attempt: terminal?.attempt ?? existing.attempt,
        rawHandle: terminal ? invocations.get(invocationKey(terminal))! : existing.rawHandle,
        localOrder: sourceLine(change.sourceRefs), kind: "Program-observed artifact paragraph change, not intent or acceptance",
        text: JSON.stringify({ removed: change.removedParagraphRefs.map((ref: string) => paragraphHandles.get(ref)), added: change.addedParagraphRefs.map((ref: string) => paragraphHandles.get(ref)), reordered: change.reordered }), related: [] });
    }
    for (const entry of registry.entries.filter(entry => entry.source === source)) entry.related = entry.related.map(ref => paragraphHandles.get(ref)).filter((value): value is string => Boolean(value));
    // Input changes and runtime failures remain discoverable even without selected prose.
    const precedingInputs = new Map<string, { text: string; attempt: number; rawHandle: string }>();
    for (const [index, invocation] of summary.observedFacts.invocations.entries()) {
      const role = traceRoleName(invocation.roleId), rawHandle = invocations.get(invocationKey(invocation))!;
      const inputs = invocation.inputAndToolRecords.filter((record: any) => record.kind === "task_input");
      const errors = invocation.inputAndToolRecords.filter((record: any) => record.kind === "tool_result:error" || record.kind === "manifest_error");
      const addState = (record: any, kind: string, text: string, offset = 0) => registry.entries.push({ handle: `${source}/${role}/state-${index + 1}-${registry.entries.length + 1}`, source, origin, role, stage: invocation.stage, sequence: 0, localOrder: sourceLine(record.sources) + offset, attempt: invocation.attempt, kind, text, rawHandle, rawSection: "inputs", related: [] });
      const comparisonKey = `${invocation.roleId}:${invocation.stage}`, previous = precedingInputs.get(comparisonKey);
      if (inputs[0] && previous && invocation.attempt > previous.attempt && inputs[0].text !== previous.text) {
        addState(inputs[0], "Different task input in a later same-stage invocation", JSON.stringify({ before: previous.rawHandle, after: rawHandle, observedTextChanged: true, beforeAttempt: previous.attempt, afterAttempt: invocation.attempt, scope: "Same role and exact stage, increasing recorded attempt order. Text difference only; this does not establish a retry, semantic improvement or causal modification. Read both original inputs." }));
      }
      if (inputs.length) precedingInputs.set(comparisonKey, { text: inputs.at(-1).text, attempt: invocation.attempt, rawHandle });
      inputs.slice(1).forEach((record: any, position: number) => addState(record, "Additional task input", JSON.stringify({ changedFromPrevious: record.text !== inputs[position].text, inputPreview: preview(record.text, 300), boundary: "Original input remains in this invocation; preview is not the complete changed instruction." })));
      errors.forEach((record: any) => { const call = invocation.inputAndToolRecords.find((candidate: any) => candidate.toolCallId === record.toolCallId && candidate.kind.startsWith("tool_call:")); addState(record, "Observed tool/runtime failure", JSON.stringify({ tool: call?.kind.slice(10) ?? "runtime", outcome: record.text })); });
      if (invocation.recordedProcessing.error && !errors.length) {
        const last = invocation.outputs.at(-1) ?? invocation.inputAndToolRecords.at(-1) ?? { sources: [] };
        addState(last, "Invocation terminal status (not a located earlier event)", JSON.stringify({ status: invocation.recordedProcessing.status, outcome: invocation.recordedProcessing.error }), 1);
      }
    }
  }
  registry.entries.sort((left, right) => sources.findIndex(item => item.source === left.source) - sources.findIndex(item => item.source === right.source) || registry.raw[left.rawHandle]!.sequence - registry.raw[right.rawHandle]!.sequence || (left.localOrder ?? 0) - (right.localOrder ?? 0));
  registry.entries.forEach((entry, index) => { entry.sequence = index + 1; delete entry.localOrder; });
  const registryPath = join(root, "registry.local.json"); await writeFile(registryPath, JSON.stringify(registry, null, 2));
  const discovery = sources.map(({ source }) => ({ source, origin: origins[source], roles: [...new Set(Object.values(registry.raw).filter(entry => entry.source === source).map(entry => entry.role))].map(role => {
    const entries = registry.entries.filter(entry => entry.source === source && entry.role === role);
    const prose = entries.filter(entry => !entry.kind.startsWith("调用概览") && !/^#{1,6} [^\r\n]+$/.test(entry.text.trim()) && !routineReadOpening(entry.text));
    const picks = [...new Set([0, Math.floor(prose.length / 2), prose.length - 1])].map(index => prose[index]).filter((entry): entry is Entry => Boolean(entry));
    return { role, availableEvents: entries.length, stages: [...new Set(Object.values(registry.raw).filter(entry => entry.source === source && entry.role === role).map(entry => entry.stage))], cues: picks.map(entry => ({ source, role, stage: entry.stage, order: entry.sequence, kind: entry.kind, handle: entry.handle, ...preview(entry.text) })), read: { source, role, level: "detail" } };
  }) }));
  return { registryPath, registrySha256: hash(await readFile(registryPath, "utf8")), context: { version: TRACE_DISCLOSURE_VERSION, task: "审查 Refine 中可泛化的写作方法及角色执行缺口；不要复制 Gold 的样本事实。", discovery, resources: Object.entries(registry.resources).filter(([, resource]) => resource.listed !== false).map(([handle, resource]) => ({ handle, source: resource.source, phase: resource.phase, purpose: resource.label })), reading: "使用 trace_read：可不带 keyword 按 source/role/stage 顺序浏览；detail 返回公开比较、产物及状态线索；rawHandle 可读取对应调用的完整公开输入/工具返回/输出。keyword 只作字面召回，零命中和未返回不表示不存在。摘要摘句仅提供发现线索，不替代完整理由。" } };
}

export interface TraceReadQuery { source?: SourceName; role?: string; stage?: string; keyword?: string; section?: "inputs" | "outputs" | "all"; level?: "invocations" | "detail" | "excerpt" | "raw" | "resource"; handle?: string; cursor?: number; limit?: number; adjacent?: number }
export async function readTraceDisclosure(registryPath: string, expectedHash: string, query: TraceReadQuery) {
  try { return await readVerifiedDisclosure(registryPath, expectedHash, query); }
  catch (error) {
    await appendFile(join(dirname(registryPath), "reads.jsonl"), JSON.stringify({ at: new Date().toISOString(), query, status: "failed", localError: String(error), units: "not tokens" }) + "\n");
    const message = error instanceof Error ? error.message : "Evidence read failed";
    throw new Error(/^(Unknown|Invalid|Unsupported|Handle|Resource|Local evidence|Original public)/.test(message) ? message : "Local evidence read failed; unavailable does not mean absent evidence");
  }
}
async function readVerifiedDisclosure(registryPath: string, expectedHash: string, query: TraceReadQuery) {
  const registryText = await readFile(registryPath, "utf8"); if (hash(registryText) !== expectedHash) throw new Error("Local evidence registry changed; source verification failed");
  const registry: Registry = JSON.parse(registryText); if (registry.version !== TRACE_DISCLOSURE_VERSION) throw new Error("Unsupported evidence registry");
  let result: unknown;
  for (const key of ["cursor", "limit", "adjacent"] as const) if (query[key] !== undefined && (!Number.isInteger(query[key]) || query[key]! < 0)) throw new Error("Invalid paging value");
  const cursor = Math.max(0, query.cursor ?? 0), limit = Math.max(1, Math.min(query.limit ?? 4, 8));
  if (query.level === "invocations") {
    const matches = Object.entries(registry.raw).filter(([, entry]) => (!query.source || entry.source === query.source) && (!query.role || entry.role === query.role) && (!query.stage || entry.stage === query.stage));
    const page = matches.slice(cursor, cursor + limit);
    result = { invocations: page.map(([handle, entry]) => ({ source: entry.source, origin: entry.origin, role: entry.role, stage: entry.stage, order: entry.sequence, rawHandle: handle })), next: cursor + page.length < matches.length ? { ...query, cursor: cursor + page.length } : null, boundary: "Original invocation navigation, including invocations without selected public excerpts; keyword does not filter this view." };
  } else if (query.level === "excerpt") {
    const entry = registry.entries.find(entry => entry.handle === query.handle && (!query.source || entry.source === query.source));
    if (!entry) throw new Error("Unknown excerpt handle for this source");
    const text = entry.text.slice(cursor, cursor + 12000);
    result = { ...entry, text, complete: cursor + text.length >= entry.text.length, next: cursor + text.length < entry.text.length ? { ...query, cursor: cursor + text.length } : null };
  } else if (query.level === "raw") {
    const entry = registry.entries.find(entry => entry.handle === query.handle), rawHandle = entry?.rawHandle ?? query.handle ?? "", source = registry.raw[rawHandle];
    if (!source || query.source && !rawHandle.startsWith(`${query.source}/`)) throw new Error("Unknown raw handle for this source; browse detail to obtain one");
    const original = await readFile(source.path, "utf8"); if (hash(original) !== source.sha256) throw new Error("Original public facts changed; source verification failed");
    const facts = JSON.parse(original);
    const text = query.section === "outputs" ? JSON.stringify({ outputs: facts.outputs.map((output: any) => ({ kind: output.kind, text: output.text, businessSelection: output.businessSelection ?? "not-inferred" })) })
      : query.section === "inputs" ? JSON.stringify({ inputAndToolRecords: facts.inputAndToolRecords.map((record: any) => ({ kind: record.kind, toolCallId: record.toolCallId ?? null, text: record.text })) }) : original;
    const width = 16000, part = text.slice(cursor, cursor + width);
    result = { source: rawHandle.split("/")[0], origin: source.origin, role: source.role, stage: source.stage, order: source.sequence, rawHandle, text: part, complete: cursor + part.length >= text.length, next: cursor + part.length < text.length ? { ...query, handle: rawHandle, cursor: cursor + part.length } : null, units: "cursor counts UTF-16 source code units; omitted pages are not absent evidence" };
  } else if (query.level === "resource") {
    const handle = query.handle ?? "configuration";
    const resource = registry.resources[handle]; if (!resource) throw new Error('Unknown resource handle; configuration navigation uses {"level":"resource","handle":"configuration"}; task documents use the declared resource handles');
    if (query.source && query.source !== resource.source) throw new Error("Resource is unavailable for requested execution source; no cross-source substitution");
    if (query.role && !resource.roleParts?.[query.role]) throw new Error("Unknown role for this resource; read its unfiltered navigation or omit role for task documents");
    const content = query.role ? resource.roleParts![query.role]!.text : resource.text;
    const text = content.slice(cursor, cursor + 16000); result = { handle, source: resource.source, origin: origins[resource.source], phase: resource.phase, ...(query.role ? { role: query.role } : {}), purpose: resource.label, text, complete: cursor + text.length >= content.length, next: cursor + text.length < content.length ? { ...query, handle, cursor: cursor + text.length } : null };
  } else {
    const scoped = registry.entries.filter(entry => (!query.source || entry.source === query.source) && (!query.role || entry.role === query.role) && (!query.stage || entry.stage === query.stage));
    const anchor = query.handle ? scoped.findIndex(entry => entry.handle === query.handle) : -1;
    if (query.handle && anchor < 0) throw new Error("Handle does not belong to the requested source/role; browse its labelled source");
    const adjacent = Math.max(0, Math.min(query.adjacent ?? 1, 3));
    const matches = query.handle ? scoped.slice(Math.max(0, anchor - adjacent), anchor + adjacent + 1) : scoped.filter(entry => !query.keyword || entry.text.toLocaleLowerCase().includes(query.keyword.toLocaleLowerCase()));
    const page = matches.slice(cursor, cursor + limit);
    result = { query, matchingEvents: matches.length, events: page.map(({ rawSection, ...entry }) => ({ ...entry, originalRead: { source: entry.source, level: "raw", handle: entry.rawHandle, section: rawSection ?? "all" }, text: entry.text.slice(0, 2400), complete: entry.text.length <= 2400, continuation: entry.text.length > 2400 ? { source: entry.source, level: "excerpt", handle: entry.handle, cursor: 2400 } : null })), next: cursor + page.length < matches.length ? { ...query, cursor: cursor + page.length } : null, boundary: matches.length ? "Returned public sources, not validated conclusions. For a comparison read rawHandle to inspect the same invocation's actual input/evidence; related handles and adjacent browsing preserve context." : "No literal matches in this selected detail view; this is not evidence of absence. Remove keyword and browse source/role, then inspect original invocation facts." };
  }
  result = { level: query.level ?? "detail", ...(result as Record<string, unknown>) };
  await appendFile(registry.logPath, JSON.stringify({ at: new Date().toISOString(), query, resultBytes: Buffer.byteLength(JSON.stringify(result)), resultCodeUnits: JSON.stringify(result).length, units: "not tokens" }) + "\n");
  return result;
}
