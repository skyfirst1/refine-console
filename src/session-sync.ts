import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AcontextGateway } from "./contracts.js";
import { adaptSessionEntry, type AdapterOptions } from "./message-adapter.js";

export interface SyncState {
  acontextSessionId: string;
  lastSyncedEntryId?: string;
  syncedMessageCount: number;
}

export interface SyncContext {
  piSessionId: string;
  piSessionFile?: string;
  cwd: string;
}

export interface SyncResult {
  state: SyncState;
  storedMessages: number;
  recreatedSession: boolean;
}

export class SessionSynchronizer {
  constructor(
    private readonly client: AcontextGateway,
    private readonly adapterOptions: Pick<AdapterOptions, "captureToolResults" | "maxToolResultChars">,
  ) {}

  async createState(context: SyncContext): Promise<SyncState> {
    const session = await this.client.sessions.create({
      configs: {
        source: "pi",
        pi_session_id: context.piSessionId,
        ...(context.piSessionFile ? { pi_session_file: context.piSessionFile } : {}),
        cwd: context.cwd,
      },
    });
    return { acontextSessionId: session.id, syncedMessageCount: 0 };
  }

  async sync(branch: SessionEntry[], existingState: SyncState | undefined, context: SyncContext): Promise<SyncResult> {
    let state = existingState ?? (await this.createState(context));
    let recreatedSession = false;
    let startIndex = 0;

    if (state.lastSyncedEntryId) {
      const cursorIndex = branch.findIndex((entry) => entry.id === state.lastSyncedEntryId);
      if (cursorIndex >= 0) {
        startIndex = cursorIndex + 1;
      } else {
        state = await this.createState(context);
        recreatedSession = true;
      }
    }

    let storedMessages = 0;
    let lastStoredEntryId = state.lastSyncedEntryId;
    const options: AdapterOptions = {
      ...this.adapterOptions,
      sourceSessionId: context.piSessionId,
      ...(context.piSessionFile ? { sourceSessionFile: context.piSessionFile } : {}),
    };

    for (const entry of branch.slice(startIndex)) {
      const stored = adaptSessionEntry(entry, options);
      if (!stored) continue;
      await this.client.sessions.storeMessage(state.acontextSessionId, stored.blob, {
        format: "openai",
        meta: stored.meta,
      });
      storedMessages += 1;
      lastStoredEntryId = entry.id;
    }

    return {
      state: {
        acontextSessionId: state.acontextSessionId,
        ...(lastStoredEntryId ? { lastSyncedEntryId: lastStoredEntryId } : {}),
        syncedMessageCount: state.syncedMessageCount + storedMessages,
      },
      storedMessages,
      recreatedSession,
    };
  }
}
