import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { readSourceProvenance } from "../src/source-provenance.js";

const execute = promisify(execFile);
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "refine-history-cli-"));
const checkout = join(root, "checkout");
await mkdir(checkout);
execFileSync("git", ["init", "--quiet", checkout]);
execFileSync("git", ["-C", checkout, "-c", "user.name=CLI fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "fixture"]);
const provenance = await readSourceProvenance(checkout, "refine-workflow-harness-v2");

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const directory = await mkdtemp(join(root, "case-"));
  const descriptionPath = join(directory, "description.md");
  await writeFile(descriptionPath, "Frozen task content for a CLI boundary test.\n");
  const currentPath = join(directory, "current.json");
  const historicalPath = join(directory, "historical.json");
  const batchPath = join(directory, "batch.json");
  const current = { runId: "current-fixture", stages: [], sourceProvenance: { ...provenance }, artifacts: { descriptionPath } };
  const historical = { runId: "historical-fixture", stages: [], sourceProvenance: { ...provenance }, artifacts: { descriptionPath } };
  const batch = { schemaVersion: "1.0", batchId: "fixture-batch", descriptionPath, sourceProvenance: { ...provenance },
    rounds: [{ round: 1, manifestPath: historicalPath }, { round: 2, manifestPath: currentPath }] };
  return { directory, descriptionPath, currentPath, historicalPath, batchPath, current, historical, batch };
}

async function rejectsBeforeAudit(f: Fixture, expected: RegExp, extra: string[] = []) {
  await Promise.all([[f.currentPath, f.current], [f.historicalPath, f.historical], [f.batchPath, f.batch]].map(async ([path, value]) => writeFile(path as string, JSON.stringify(value))));
  const auditDirectory = join(f.directory, "audit");
  await assert.rejects(execute(process.execPath, ["--import", "tsx", "scripts/run-refine-behavior-audit.ts",
    "--cwd", checkout, "--manifest", f.currentPath, "--run-directory", auditDirectory, "--task-type", "fixture",
    "--provider", "test-provider-never-called", "--batch-manifest", f.batchPath, "--historical-manifest", f.historicalPath, ...extra],
  { cwd: project, timeout: 20_000 }), (error: unknown) => {
    const failure = error as { code?: number; stderr?: string };
    assert.notEqual(failure.code, 0);
    assert.match(failure.stderr ?? "", expected);
    return true;
  });
  await assert.rejects(access(auditDirectory), { code: "ENOENT" });
}

test("history CLI rejects duplicate batch round numbers before audit", async () => {
  const f = await fixture(); f.batch.rounds[1]!.round = 1;
  await rejectsBeforeAudit(f, /Batch rounds and manifest paths must be unique/);
});
test("history CLI rejects duplicate batch manifest paths before audit", async () => {
  const f = await fixture(); f.batch.rounds[1]!.manifestPath = f.historicalPath;
  await rejectsBeforeAudit(f, /Batch rounds and manifest paths must be unique/);
});
test("history CLI rejects a trace outside the recorded batch before audit", async () => {
  const f = await fixture(); f.batch.rounds[0]!.manifestPath = join(f.directory, "unrelated.json");
  await rejectsBeforeAudit(f, /Both traces must belong to this batch/);
});
test("history CLI rejects reverse temporal ordering before audit", async () => {
  const f = await fixture(); f.batch.rounds[0]!.round = 3;
  await rejectsBeforeAudit(f, /historical trace preceding the current trace/);
});
test("history CLI rejects mismatched run source provenance before audit", async () => {
  const f = await fixture(); f.historical.sourceProvenance.gitCommit = "0".repeat(40);
  await rejectsBeforeAudit(f, /must match the batch source provenance/);
});
test("history CLI rejects Description content falsely attributed to the batch before audit", async () => {
  const f = await fixture(); f.historical.artifacts.descriptionPath = join(f.directory, "other-description.md");
  await writeFile(f.historical.artifacts.descriptionPath, "A different task description.\n");
  await rejectsBeforeAudit(f, /must use the batch's frozen Description bytes/);
});
for (const argument of ["--historical-manifest", "--batch-manifest"]) test(`history CLI rejects repeated ${argument} instead of silently selecting one`, async () => {
  const f = await fixture(); await rejectsBeforeAudit(f, /may be supplied only once/, [argument, argument === "--batch-manifest" ? f.batchPath : f.historicalPath]);
});
