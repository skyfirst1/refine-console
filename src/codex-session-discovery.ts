import { open, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

export interface CodexRolloutCandidate {
  path: string;
  sessionId: string;
  cwd?: string;
  timestamp?: string;
  title?: string;
  modifiedAtMs: number;
  label: string;
}

async function readThreadTitles(root: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const indexPath = join(dirname(resolve(root)), "session_index.jsonl");
  let jsonl: string;
  try {
    jsonl = await readFile(indexPath, "utf8");
  } catch {
    return titles;
  }
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
      if (typeof value.id === "string" && typeof value.thread_name === "string" && value.thread_name.trim()) {
        titles.set(value.id, value.thread_name.trim());
      }
    } catch {
      // The index is append-only; tolerate a partially written trailing line.
    }
  }
  return titles;
}

async function jsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await jsonlFiles(path));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === ".jsonl") files.push(path);
  }
  return files;
}

async function readSessionMeta(path: string): Promise<{ sessionId?: string; cwd?: string; timestamp?: string }> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as { type?: unknown; timestamp?: unknown; payload?: Record<string, unknown> };
        if (value.type !== "session_meta" || !value.payload) continue;
        return {
          ...(typeof value.payload.id === "string" ? { sessionId: value.payload.id } : {}),
          ...(typeof value.payload.cwd === "string" ? { cwd: value.payload.cwd } : {}),
          ...(typeof value.timestamp === "string" ? { timestamp: value.timestamp } : {}),
        };
      } catch {
        continue;
      }
    }
    return {};
  } finally {
    await handle.close();
  }
}

export async function discoverCodexRollouts(root: string, preferredCwd?: string, limit = 20): Promise<CodexRolloutCandidate[]> {
  const absoluteRoot = resolve(root);
  const threadTitles = await readThreadTitles(absoluteRoot);
  const candidates: CodexRolloutCandidate[] = [];
  for (const path of await jsonlFiles(absoluteRoot)) {
    const [info, meta] = await Promise.all([stat(path), readSessionMeta(path)]);
    const sessionId = meta.sessionId ?? basename(path, ".jsonl").match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i)?.[1];
    if (!sessionId) continue;
    const cwdMatch = preferredCwd && meta.cwd
      ? resolve(meta.cwd).toLowerCase() === resolve(preferredCwd).toLowerCase()
      : false;
    const title = threadTitles.get(sessionId);
    candidates.push({
      path: resolve(path),
      sessionId,
      ...(meta.cwd ? { cwd: meta.cwd } : {}),
      ...(meta.timestamp ? { timestamp: meta.timestamp } : {}),
      ...(title ? { title } : {}),
      modifiedAtMs: info.mtimeMs,
      label: `${cwdMatch ? "[当前项目] " : ""}${title ? `${title} · ` : ""}${meta.timestamp ?? new Date(info.mtimeMs).toISOString()} · ${sessionId} · ${meta.cwd ?? "cwd unknown"}`,
    });
  }
  return candidates
    .sort((left, right) => {
      const leftMatch = preferredCwd && left.cwd && resolve(left.cwd).toLowerCase() === resolve(preferredCwd).toLowerCase() ? 1 : 0;
      const rightMatch = preferredCwd && right.cwd && resolve(right.cwd).toLowerCase() === resolve(preferredCwd).toLowerCase() ? 1 : 0;
      return rightMatch - leftMatch || right.modifiedAtMs - left.modifiedAtMs;
    })
    .slice(0, limit);
}
