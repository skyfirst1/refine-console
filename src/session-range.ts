import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ProductionRangeKind } from "./production-rules.js";

export const PRODUCTION_RANGE_ENTRY_TYPE = "acontext-production-ranges-v1";

export interface EntryRange {
  startEntryId: string;
  endEntryId: string;
}

export interface ProductionRangeSelection {
  version: 1;
  acontext: EntryRange;
  refine: EntryRange;
  selectedAt: string;
}

export interface SelectableEntry {
  id: string;
  index: number;
  label: string;
  timestamp: string;
}

function messageText(entry: SessionEntry): string {
  if (entry.type !== "message") return entry.type;
  if (!("content" in entry.message)) return entry.message.role;
  const content = entry.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return entry.message.role;
  return content
    .filter((block): block is { type: "text"; text: string } =>
      Boolean(block) && typeof block === "object" && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(" ");
}

function oneLine(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}

export function selectableEntries(branch: readonly SessionEntry[]): SelectableEntry[] {
  return branch.map((entry, index) => ({
    id: entry.id,
    index,
    timestamp: entry.timestamp,
    label: `${String(index + 1).padStart(3, "0")} · ${entry.type}${entry.type === "message" ? `/${entry.message.role}` : ""} · ${oneLine(messageText(entry)) || "(empty)"}`,
  }));
}

export function validateRange(branch: readonly SessionEntry[], range: EntryRange, kind: ProductionRangeKind): void {
  const start = branch.findIndex((entry) => entry.id === range.startEntryId);
  const end = branch.findIndex((entry) => entry.id === range.endEntryId);
  if (start < 0) throw new Error(`${kind} start entry is not on the active branch: ${range.startEntryId}`);
  if (end < 0) throw new Error(`${kind} end entry is not on the active branch: ${range.endEntryId}`);
  if (start > end) throw new Error(`${kind} start entry must not be after its end entry`);
}

export function sliceEntryRange(branch: readonly SessionEntry[], range: EntryRange, kind: ProductionRangeKind): SessionEntry[] {
  validateRange(branch, range, kind);
  const start = branch.findIndex((entry) => entry.id === range.startEntryId);
  const end = branch.findIndex((entry) => entry.id === range.endEntryId);
  return branch.slice(start, end + 1);
}

export function restoreProductionRangeSelection(branch: readonly SessionEntry[], customType: string): ProductionRangeSelection | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== customType || !entry.data) continue;
    const candidate = entry.data as Partial<ProductionRangeSelection>;
    if (candidate.version !== 1 || !candidate.acontext || !candidate.refine || typeof candidate.selectedAt !== "string") continue;
    const selection: ProductionRangeSelection = {
      version: 1,
      acontext: candidate.acontext,
      refine: candidate.refine,
      selectedAt: candidate.selectedAt,
    };
    try {
      validateRange(branch, selection.acontext, "acontext");
      validateRange(branch, selection.refine, "refine");
      return selection;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
