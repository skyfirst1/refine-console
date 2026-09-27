import type { AtomicAspect } from "./refine-expert-pipeline.js";

export type EvidenceWindow = { status: "available"; paragraphs: Array<{ start: number; end: number; text: string; evidenceIndices: number[] }>; evidenceMap: Array<{ evidenceIndex: number; paragraphIndex: number; start: number; end: number }> } | { status: "unavailable"; reason: string };
// Normalize whitespace only, retaining a source offset for every normalized character.
function normalized(text: string) { let value = ""; const offsets: number[] = []; for (let i = 0; i < text.length; i++) { if (/\s/u.test(text[i]!)) { if (!value.endsWith(" ")) { value += " "; offsets.push(i); } } else { value += text[i]; offsets.push(i); } } return { value, offsets }; }
export function locateEvidenceParagraphs(text: string, aspect: AtomicAspect, maxParagraphs = 2): EvidenceWindow {
  if (!Number.isSafeInteger(maxParagraphs) || maxParagraphs < 1 || !aspect.evidences.length) return { status: "unavailable", reason: "invalid-budget-or-empty-evidence" };
  const boundaries: Array<{ start: number; end: number }> = []; let start = 0;
  for (const match of text.matchAll(/\r?\n[\t ]*\r?\n(?:[\t ]*\r?\n)*/g)) { if (match.index! > start) boundaries.push({ start, end: match.index! }); start = match.index! + match[0].length; }
  if (start < text.length) boundaries.push({ start, end: text.length });
  const source = normalized(text), located: Array<{ evidenceIndex: number; start: number; end: number; paragraph: { start: number; end: number } }> = [];
  for (const [evidenceIndex, evidence] of aspect.evidences.entries()) {
    const quote = normalized(evidence.quote).value.trim(); if (!quote) return { status: "unavailable", reason: "empty-quote" };
    const first = source.value.indexOf(quote); if (first < 0 || source.value.indexOf(quote, first + 1) >= 0) return { status: "unavailable", reason: first < 0 ? "quote-not-found" : "ambiguous-quote" };
    const begin = source.offsets[first]!, end = source.offsets[first + quote.length - 1]! + 1;
    const paragraph = boundaries.find(p => p.start <= begin && p.end >= end); if (!paragraph) return { status: "unavailable", reason: "cross-paragraph-quote" };
    located.push({ evidenceIndex, start: begin, end, paragraph });
  }
  const unique = [...new Map(located.map(x => [x.paragraph.start, x.paragraph])).values()].sort((a, b) => a.start - b.start);
  if (unique.length > maxParagraphs) return { status: "unavailable", reason: "paragraph-budget-exceeded" };
  const paragraphs = unique.map(p => ({ ...p, text: text.slice(p.start, p.end), evidenceIndices: located.filter(x => x.paragraph.start === p.start).map(x => x.evidenceIndex) }));
  return { status: "available", paragraphs, evidenceMap: located.map(x => ({ evidenceIndex: x.evidenceIndex, paragraphIndex: unique.findIndex(p => p.start === x.paragraph.start), start: x.start, end: x.end })) };
}
export function buildEvidenceWindows(sourceText: string, sourceAspect: AtomicAspect, targetText: string, targetAspect: AtomicAspect, limits = { maxParagraphsPerSide: 2, maxBytes: 4000 }) {
  const source = locateEvidenceParagraphs(sourceText, sourceAspect, limits.maxParagraphsPerSide), target = locateEvidenceParagraphs(targetText, targetAspect, limits.maxParagraphsPerSide);
  if (source.status === "unavailable" || target.status === "unavailable") return { status: "unavailable" as const, reason: source.status === "unavailable" ? source.reason : (target as Extract<EvidenceWindow, { status: "unavailable" }>).reason };
  const bytes = [...source.paragraphs, ...target.paragraphs].reduce((n, p) => n + Buffer.byteLength(p.text, "utf8"), 0);
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 || bytes > limits.maxBytes) return { status: "unavailable" as const, reason: "pair-byte-budget-exceeded" };
  return { status: "available" as const, source, target, bytes };
}
