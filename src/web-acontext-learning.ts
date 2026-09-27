import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolveAcontextReplayChunkSize } from "./acontext-replay.js";
import type { AcontextGateway } from "./contracts.js";
import { adaptSessionEntry } from "./message-adapter.js";
import { sliceEntryRange, type EntryRange } from "./session-range.js";
import { SkillSynchronizer } from "./skill-sync.js";

export type AcontextLearningPhase = "preparing" | "replaying" | "learning" | "syncing";

export interface AcontextLearningProgress {
  phase: AcontextLearningPhase;
  storedMessages: number;
}

export interface AcontextRangeLearningOptions {
  client: AcontextGateway;
  branch: readonly SessionEntry[];
  range: EntryRange;
  piSessionId: string;
  piSessionFile?: string;
  cwd: string;
  skillCacheDir: string;
  maxToolResultChars: number;
  timeoutMs: number;
  onProgress?: (progress: AcontextLearningProgress) => void;
}

export async function runAcontextRangeLearning(options: AcontextRangeLearningOptions): Promise<{
  learningSpaceId: string;
  acontextSessionId: string;
  storedMessages: number;
  skillPath: string;
  skillCount: number;
}> {
  if (!options.client.learningSpaces.create) throw new Error("当前 Acontext SDK 不支持创建独立 learning space");
  const entries = sliceEntryRange(options.branch, options.range, "acontext");
  options.onProgress?.({ phase: "preparing", storedMessages: 0 });
  const learningSpace = await options.client.learningSpaces.create({
    meta: { purpose: "pi-session-memory", source: "pi-session-range", pi_session_id: options.piSessionId },
  });
  const session = await options.client.sessions.create({
    configs: {
      source: "pi",
      pi_session_id: options.piSessionId,
      ...(options.piSessionFile ? { pi_session_file: options.piSessionFile } : {}),
      cwd: options.cwd,
    },
  });
  await options.client.learningSpaces.learn({ spaceId: learningSpace.id, sessionId: session.id });
  const replayChunkSize = await resolveAcontextReplayChunkSize(options.client);
  let storedMessages = 0;
  options.onProgress?.({ phase: "replaying", storedMessages });
  for (const entry of entries) {
    const stored = adaptSessionEntry(entry, {
      captureToolResults: false,
      captureToolCalls: false,
      maxToolResultChars: options.maxToolResultChars,
      sourceSessionId: options.piSessionId,
      ...(options.piSessionFile ? { sourceSessionFile: options.piSessionFile } : {}),
    });
    if (!stored) continue;
    await options.client.sessions.storeMessage(session.id, stored.blob, { format: "openai", meta: stored.meta });
    storedMessages += 1;
    options.onProgress?.({ phase: "replaying", storedMessages });
    if (storedMessages % replayChunkSize === 0) await options.client.sessions.flush(session.id);
  }
  if (storedMessages === 0) throw new Error("Acontext 区间中没有可学习的用户或助手文本");
  if (storedMessages % replayChunkSize !== 0) await options.client.sessions.flush(session.id);
  options.onProgress?.({ phase: "learning", storedMessages });
  const learned = await options.client.learningSpaces.waitForLearning({
    spaceId: learningSpace.id,
    sessionId: session.id,
    timeout: Math.ceil(options.timeoutMs / 1000),
    pollInterval: 1,
  });
  if (learned.status !== "completed") throw new Error(`Acontext 学习未完成：${learned.status}`);
  options.onProgress?.({ phase: "syncing", storedMessages });
  const synced = await new SkillSynchronizer(options.client, options.skillCacheDir).sync(learningSpace.id);
  return {
    learningSpaceId: learningSpace.id,
    acontextSessionId: session.id,
    storedMessages,
    skillPath: synced.path,
    skillCount: synced.skillCount,
  };
}
