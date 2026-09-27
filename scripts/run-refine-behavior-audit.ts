import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { runRefineTaskBehaviorAudit, type RefineHistoricalTrace } from "../src/refine-behavior-audit.js";
import type { HarnessTraceStage } from "../src/refine-harness-self-check.js";
import { readSourceProvenance } from "../src/source-provenance.js";

function values(name: string) {
  const result: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) if (process.argv[index] === name && process.argv[index + 1]) result.push(process.argv[++index]!);
  return result;
}
function required(name: string) { const value = values(name)[0]; if (!value) throw new Error(`Missing required ${name}`); return value; }

if (values("--audit-target-id").length) throw new Error("--audit-target-id is obsolete: behavior audit now reviews one top-level Refine Task through exactly five role states");
const manifestPath = resolve(required("--manifest")); const runDirectory = resolve(required("--run-directory"));
const taskType = required("--task-type");
type Manifest = { runId?: string; stages?: HarnessTraceStage[]; harnessProfile?: unknown; artifacts?: { descriptionPath?: string }; sourceProvenance?: { availability?: string; gitCommit?: string | null; gitDirty?: boolean | null; gitDiffDigest?: string | null } };
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
if (!Array.isArray(manifest.stages)) throw new Error("Manifest stages are required");
const cwd = resolve(values("--cwd")[0] ?? process.cwd());
for (const argument of ["--batch-manifest", "--historical-manifest"]) if (values(argument).length > 1) throw new Error(`${argument} may be supplied only once`);
const batchManifestArgument = values("--batch-manifest")[0];
const historicalManifestArgument = values("--historical-manifest")[0];
if (Boolean(batchManifestArgument) !== Boolean(historicalManifestArgument)) throw new Error("--batch-manifest and --historical-manifest must be supplied together");
let currentTraceIdentity: { batchId: string; round: number } | undefined;
let historicalTrace: RefineHistoricalTrace | undefined;
if (batchManifestArgument && historicalManifestArgument) {
  const batchManifestPath = resolve(batchManifestArgument);
  const historicalManifestPath = resolve(historicalManifestArgument);
  const batch = JSON.parse(await readFile(batchManifestPath, "utf8")) as {
    schemaVersion?: string; batchId?: string; descriptionPath?: string; sourceProvenance?: Manifest["sourceProvenance"];
    rounds?: Array<{ round: number; manifestPath: string }>;
  };
  if (batch.schemaVersion !== "1.0" || !batch.batchId?.trim() || !batch.descriptionPath || !Array.isArray(batch.rounds)) throw new Error("Batch manifest requires schemaVersion 1.0, batchId, descriptionPath and rounds");
  const canonical = (path: string) => resolve(path).toLowerCase();
  const seenRounds = new Set<number>(); const seenPaths = new Set<string>();
  for (const item of batch.rounds) {
    if (!item || !Number.isSafeInteger(item.round) || item.round < 1 || typeof item.manifestPath !== "string" || !item.manifestPath.trim()) throw new Error("Batch rounds require positive unique round numbers and manifest paths");
    const path = canonical(resolve(dirname(batchManifestPath), item.manifestPath));
    if (seenRounds.has(item.round) || seenPaths.has(path)) throw new Error("Batch rounds and manifest paths must be unique");
    seenRounds.add(item.round); seenPaths.add(path);
  }
  const current = batch.rounds.find((item) => canonical(resolve(dirname(batchManifestPath), item.manifestPath)) === canonical(manifestPath));
  const earlier = batch.rounds.find((item) => canonical(resolve(dirname(batchManifestPath), item.manifestPath)) === canonical(historicalManifestPath));
  if (!current || !earlier || earlier.round >= current.round) throw new Error("Both traces must belong to this batch, with the historical trace preceding the current trace");
  const history = JSON.parse(await readFile(historicalManifestPath, "utf8")) as Manifest;
  if (!history.runId || !Array.isArray(history.stages)) throw new Error("Historical manifest requires runId and stages");
  if (JSON.stringify(manifest.harnessProfile ?? null) !== JSON.stringify(history.harnessProfile ?? null)) throw new Error("Historical and current traces must use the same Harness Profile configuration");
  const sourceSignature = (source: Manifest["sourceProvenance"]) => {
    if (source?.availability !== "available" || typeof source.gitCommit !== "string" || typeof source.gitDirty !== "boolean" || (source.gitDirty && typeof source.gitDiffDigest !== "string")) throw new Error("Batch and run source provenance must be available");
    return JSON.stringify([source.gitCommit, source.gitDirty, source.gitDiffDigest ?? null]);
  };
  const expectedSource = sourceSignature(batch.sourceProvenance);
  const localSource = await readSourceProvenance(cwd, "refine-workflow-harness-v2");
  if ([manifest.sourceProvenance, history.sourceProvenance, localSource].some((source) => sourceSignature(source) !== expectedSource)) throw new Error("Both Refine traces and the current checkout must match the batch source provenance");
  const descriptionDigest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
  const expectedDescription = await descriptionDigest(resolve(dirname(batchManifestPath), batch.descriptionPath));
  if (!manifest.artifacts?.descriptionPath || !history.artifacts?.descriptionPath
    || await descriptionDigest(manifest.artifacts.descriptionPath) !== expectedDescription
    || await descriptionDigest(history.artifacts.descriptionPath) !== expectedDescription) throw new Error("Both traces must use the batch's frozen Description bytes");
  currentTraceIdentity = { batchId: batch.batchId, round: current.round };
  historicalTrace = { batchId: batch.batchId, round: earlier.round, runId: history.runId, stages: history.stages, sourceManifestPath: historicalManifestPath };
}
const timeout = Number(values("--timeout-ms")[0] ?? "600000"); if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("--timeout-ms must be positive");
const manualSuccessTraceAudit = process.argv.includes("--manual-success-trace-audit");
const output = await runRefineTaskBehaviorAudit({ cwd, provider: values("--provider")[0] ?? "deepseek", model: values("--model")[0] ?? "deepseek-v4-flash", timeoutMs: timeout, runId: manifest.runId ?? "refine-behavior-audit", runDirectory, stages: manifest.stages, taskType,
  ...(currentTraceIdentity ? { currentTraceIdentity } : {}), ...(historicalTrace ? { historicalTrace } : {}),
  ...(manualSuccessTraceAudit ? { diagnosticContext: { invocation: "manual-diagnostic" as const, purpose: "success-trace-audit" as const, automaticTrigger: false as const } } : {}) });
process.stdout.write(`${JSON.stringify({ traceSummaryPath: output.traceSummaryPath, historicalTraceSummaryPath: output.historicalTraceSummaryPath, roleStatePaths: output.roleStatePaths, traceIntegrityPath: output.traceIntegrityPath, engineeringDiagnosticsPath: output.engineeringDiagnosticsPath, configurationSnapshotPaths: output.configurationSnapshotPaths, proposalLedgerPath: output.proposalLedgerPath, auditBindingPath: output.auditBindingPath, tokenUsagePath: output.tokenUsagePath, diagnosticMetadataPath: output.diagnosticMetadataPath, resultPath: output.resultPath })}\n`);
