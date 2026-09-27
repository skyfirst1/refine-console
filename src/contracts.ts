export interface AcontextSession {
  id: string;
}

export interface LearningResult {
  status: string;
}

export interface SkillFileInfo {
  path: string;
  mime: string;
}

export interface AcontextSkill {
  id: string;
  name: string;
  description: string;
  updated_at: string;
  file_index: SkillFileInfo[];
}

export interface SkillFileResult {
  path: string;
  mime: string;
  content?: { raw: string } | null | undefined;
  url?: string | null | undefined;
}

export interface AcontextGateway {
  ping(): Promise<string>;
  project?: {
    getConfigs(): Promise<Record<string, unknown>>;
  };
  sessions: {
    create(options?: {
      user?: string | null;
      disableTaskTracking?: boolean | null;
      configs?: Record<string, unknown>;
      useUuid?: string | null;
    }): Promise<AcontextSession>;
    storeMessage(
      sessionId: string,
      blob: Record<string, unknown>,
      options?: {
        format?: "acontext" | "openai" | "anthropic" | "gemini";
        meta?: Record<string, unknown> | null;
      },
    ): Promise<unknown>;
    flush(sessionId: string): Promise<unknown>;
    copy(sessionId: string): Promise<{ old_session_id: string; new_session_id: string }>;
  };
  learningSpaces: {
    create?(options?: {
      user?: string | null;
      meta?: Record<string, unknown> | null;
    }): Promise<{ id: string }>;
    delete?(spaceId: string): Promise<void>;
    learn(options: { spaceId: string; sessionId: string }): Promise<LearningResult>;
    waitForLearning(options: {
      spaceId: string;
      sessionId: string;
      timeout?: number;
      pollInterval?: number;
    }): Promise<LearningResult>;
    getSession?(options: { spaceId: string; sessionId: string }): Promise<LearningResult>;
    listSkills(spaceId: string): Promise<AcontextSkill[]>;
  };
  skills: {
    getFile(options: { skillId: string; filePath: string; expire?: number | null }): Promise<SkillFileResult>;
  };
}

export interface StoredMessage {
  blob: Record<string, unknown>;
  meta: Record<string, unknown>;
}
