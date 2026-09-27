import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compareDiagnosisCapabilityExperiment, type DiagnosisCapabilityRun } from "../src/refine-diagnosis-evaluation.js";

const inputPath = process.argv[2];
if (!inputPath) throw new Error("Usage: npm run evaluate-refine-diagnosis -- <frozen-experiment.json>");
const input = JSON.parse(await readFile(resolve(inputPath), "utf8")) as { frozenTraceDigest?: unknown; baseline?: unknown; candidateRuns?: unknown };
if (typeof input.frozenTraceDigest !== "string" || !input.baseline || !Array.isArray(input.candidateRuns) || input.candidateRuns.length !== 3) {
  throw new Error("Experiment input requires frozenTraceDigest, baseline, and exactly three candidateRuns");
}
for (const [index, value] of [input.baseline, ...input.candidateRuns].entries()) {
  const run = value as Partial<DiagnosisCapabilityRun>;
  if (typeof run.sourceRunId !== "string" || typeof run.traceDigest !== "string" || typeof run.shardSourceFingerprint !== "string" || typeof run.frozenInputDigest !== "string") {
    throw new Error(`Experiment run ${index} requires sourceRunId, traceDigest, shardSourceFingerprint, and frozenInputDigest`);
  }
}
const report = compareDiagnosisCapabilityExperiment({ frozenTraceDigest: input.frozenTraceDigest, baseline: input.baseline as DiagnosisCapabilityRun,
  candidateRuns: input.candidateRuns as [DiagnosisCapabilityRun, DiagnosisCapabilityRun, DiagnosisCapabilityRun] });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
