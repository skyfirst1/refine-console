import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const digest = (parts: readonly (string | Uint8Array)[]): string => {
  const hash = createHash("sha256"); for (const part of parts) hash.update(part); return hash.digest("hex");
};

export interface SourceProvenance {
  availability: "available" | "unavailable";
  gitCommit: string | null;
  gitDirty: boolean | null;
  gitDiffDigest: string | null;
  harnessVersion: string;
  diagnosisSchemaVersion: "1.0";
  unavailableReason: string | null;
}

export async function readSourceProvenance(cwd: string, harnessVersion: string): Promise<SourceProvenance> {
  try {
    const run = async (...args: string[]) => (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout;
    const root = (await run("rev-parse", "--show-toplevel")).trim();
    const gitCommit = (await run("rev-parse", "HEAD")).trim();
    const status = await run("status", "--porcelain=v1", "-z");
    const gitDirty = status.length > 0;
    let gitDiffDigest: string | null = null;
    if (gitDirty) {
      const diff = await run("diff", "--no-ext-diff", "--binary", "HEAD", "--");
      const untracked = status.split("\0").filter(Boolean).filter((entry) => entry.startsWith("?? ")).map((entry) => entry.slice(3)).sort();
      const untrackedParts: Array<string | Uint8Array> = [];
      for (const relativePath of untracked) {
        untrackedParts.push(`\0untracked:${relativePath}\0`);
        try { untrackedParts.push(await readFile(resolve(root, relativePath))); } catch { untrackedParts.push("[unavailable]"); }
      }
      gitDiffDigest = digest([status, diff, ...untrackedParts]);
    }
    return { availability: "available", gitCommit, gitDirty, gitDiffDigest, harnessVersion, diagnosisSchemaVersion: "1.0", unavailableReason: null };
  } catch (error) {
    return { availability: "unavailable", gitCommit: null, gitDirty: null, gitDiffDigest: null, harnessVersion,
      diagnosisSchemaVersion: "1.0", unavailableReason: error instanceof Error ? error.message : String(error) };
  }
}
