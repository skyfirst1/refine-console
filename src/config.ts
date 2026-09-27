import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ExtensionConfig {
  enabled: boolean;
  apiKey?: string;
  baseUrl?: string;
  learningSpaceId?: string;
  skillInclude?: string[];
  skillCacheDir: string;
  captureToolResults: boolean;
  maxToolResultChars: number;
  shutdownTimeoutMs: number;
  productionRunRoot: string;
  productionTimeoutMs: number;
  autoDreamEnabled: boolean;
  autoDreamRunRoot: string;
  autoDreamPublishRoot: string;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.trim().toLowerCase() === "true";
}

function parsePositiveInteger(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ExtensionConfig {
  const apiKey = env.ACONTEXT_API_KEY?.trim();
  const baseUrl = env.ACONTEXT_BASE_URL?.trim();
  const learningSpaceId = env.ACONTEXT_LEARNING_SPACE_ID?.trim();
  const configuredCache = env.ACONTEXT_SKILL_CACHE_DIR?.trim();
  const skillInclude = env.ACONTEXT_SKILL_INCLUDE?.split(",").map((value) => value.trim()).filter(Boolean);
  const productionRunRoot = env.ACONTEXT_PRODUCTION_RUN_ROOT?.trim();
  const autoDreamRunRoot = env.AUTO_DREAM_RUN_ROOT?.trim();
  const autoDreamPublishRoot = env.AUTO_DREAM_SKILL_ROOT?.trim();
  const skillCacheDir = resolve(configuredCache || join(homedir(), ".pi", "agent", "skills", "acontext"));

  return {
    enabled: Boolean(apiKey),
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl: baseUrl.replace(/\/$/, "") } : {}),
    ...(learningSpaceId ? { learningSpaceId } : {}),
    ...(skillInclude?.length ? { skillInclude } : {}),
    skillCacheDir,
    captureToolResults: parseBoolean(env.ACONTEXT_CAPTURE_TOOL_RESULTS, false),
    maxToolResultChars: parsePositiveInteger(env.ACONTEXT_MAX_TOOL_RESULT_CHARS, 4_000),
    shutdownTimeoutMs: parsePositiveInteger(env.ACONTEXT_SHUTDOWN_TIMEOUT_MS, 2_000),
    productionRunRoot: resolve(productionRunRoot || join(process.cwd(), ".pi", "acontext-production")),
    productionTimeoutMs: parsePositiveInteger(env.ACONTEXT_PRODUCTION_TIMEOUT_MS, 900_000),
    autoDreamEnabled: parseBoolean(env.AUTO_DREAM_ENABLED, true),
    autoDreamRunRoot: resolve(autoDreamRunRoot || join(process.cwd(), ".pi", "auto-dream")),
    autoDreamPublishRoot: resolve(autoDreamPublishRoot || join(skillCacheDir, "auto-dream")),
  };
}
