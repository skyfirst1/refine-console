import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE_PATH = join(PACKAGE_ROOT, "sidecar", "docker-compose.yaml");
const DEFAULT_CONFIG_PATH = join(PACKAGE_ROOT, "sidecar", "config.yaml");

export interface AcontextServiceConfig {
  home: string;
  envFile: string;
  configFile: string;
  composeFile: string;
  projectName: string;
  apiPort: number;
  apiBaseUrl: string;
  autoStart: boolean;
}

export interface AcontextServiceStatus {
  state: "running" | "stopped" | "degraded";
  healthy: boolean;
  apiBaseUrl: string;
  services: Array<{ service: string; state: string; health: string }>;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function parsePort(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "8029", 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) return 8029;
  return parsed;
}

function parseBoolean(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function resolveAcontextServiceConfig(env: NodeJS.ProcessEnv = process.env): AcontextServiceConfig {
  const home = resolve(env.ACONTEXT_SIDECAR_HOME?.trim() || join(homedir(), ".pi", "acontext-sidecar"));
  const apiPort = parsePort(env.ACONTEXT_SIDECAR_API_PORT);
  return {
    home,
    envFile: resolve(env.ACONTEXT_SIDECAR_ENV_FILE?.trim() || join(home, ".env")),
    configFile: resolve(env.ACONTEXT_SIDECAR_CONFIG_FILE?.trim() || join(home, "config.yaml")),
    composeFile: COMPOSE_PATH,
    projectName: env.ACONTEXT_SIDECAR_PROJECT?.trim() || "pi-acontext-sidecar",
    apiPort,
    apiBaseUrl: `http://127.0.0.1:${apiPort}/api/v1`,
    autoStart: parseBoolean(env.ACONTEXT_SIDECAR_AUTO_START),
  };
}

export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match?.[1] || match[2] === undefined || match[1].startsWith("#")) continue;
    values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

/** Discover sidecar credentials without printing or persisting them elsewhere. */
export function applyDiscoveredAcontextEnvironment(
  config: AcontextServiceConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!existsSync(config.envFile)) return false;
  const values = parseEnvFile(readFileSync(config.envFile, "utf8"));
  const token = values.ROOT_API_BEARER_TOKEN?.trim();
  if (!env.ACONTEXT_API_KEY && token) env.ACONTEXT_API_KEY = token.startsWith("sk-ac-") ? token : `sk-ac-${token}`;
  if (!env.ACONTEXT_BASE_URL) env.ACONTEXT_BASE_URL = config.apiBaseUrl;
  return Boolean(token);
}

export function parseComposePsOutput(output: string): AcontextServiceStatus["services"] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  let records: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown> | Array<Record<string, unknown>>;
    records = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    records = trimmed.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  }
  return records.map((item) => ({
    service: String(item.Service ?? "unknown"),
    state: String(item.State ?? "unknown"),
    health: String(item.Health ?? ""),
  }));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function run(command: string, args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: false,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

export class AcontextServiceManager {
  constructor(readonly config: AcontextServiceConfig = resolveAcontextServiceConfig()) {}

  private composeArgs(commandArgs: string[]): string[] {
    return [
      "compose",
      "--project-name", this.config.projectName,
      "--project-directory", this.config.home,
      "--env-file", this.config.envFile,
      "-f", this.config.composeFile,
      ...commandArgs,
    ];
  }

  private commandEnv(): NodeJS.ProcessEnv {
    return {
      ACONTEXT_SIDECAR_API_PORT: String(this.config.apiPort),
      ACONTEXT_SIDECAR_CONFIG_FILE: this.config.configFile,
    };
  }

  private async ensureRuntimeFiles(): Promise<void> {
    await mkdir(this.config.home, { recursive: true });
    if (!(await fileExists(this.config.envFile))) {
      throw new Error(`Acontext sidecar configuration is missing: ${this.config.envFile}. Copy sidecar/.env.example and fill the required secrets.`);
    }
    if (!(await fileExists(this.config.configFile))) await copyFile(DEFAULT_CONFIG_PATH, this.config.configFile);
  }

  async start(timeoutSeconds = 180): Promise<AcontextServiceStatus> {
    await this.ensureRuntimeFiles();
    const result = await run(
      "docker",
      this.composeArgs(["up", "-d", "--wait", "--wait-timeout", String(timeoutSeconds)]),
      this.config.home,
      this.commandEnv(),
    );
    if (result.exitCode !== 0) {
      throw new Error(`Acontext sidecar failed to start: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`);
    }
    const status = await this.status();
    if (!status.healthy) throw new Error("Acontext sidecar containers started but the API health check failed");
    return status;
  }

  async status(): Promise<AcontextServiceStatus> {
    if (!(await fileExists(this.config.envFile))) {
      return { state: "stopped", healthy: false, apiBaseUrl: this.config.apiBaseUrl, services: [] };
    }
    const result = await run("docker", this.composeArgs(["ps", "--format", "json"]), this.config.home, this.commandEnv());
    if (result.exitCode !== 0) throw new Error(`Cannot inspect Acontext sidecar: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    const services = parseComposePsOutput(result.stdout);
    let healthy = false;
    try {
      const response = await fetch(`${this.config.apiBaseUrl.replace(/\/api\/v1$/, "")}/health`, { signal: AbortSignal.timeout(3_000) });
      healthy = response.ok;
    } catch {
      healthy = false;
    }
    const running = services.some((service) => service.state === "running");
    return {
      state: healthy ? "running" : running ? "degraded" : "stopped",
      healthy,
      apiBaseUrl: this.config.apiBaseUrl,
      services,
    };
  }

  async stop(): Promise<AcontextServiceStatus> {
    if (!(await fileExists(this.config.envFile))) {
      return { state: "stopped", healthy: false, apiBaseUrl: this.config.apiBaseUrl, services: [] };
    }
    const result = await run("docker", this.composeArgs(["down", "--remove-orphans"]), this.config.home, this.commandEnv());
    if (result.exitCode !== 0) throw new Error(`Acontext sidecar failed to stop: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    return this.status();
  }

  async redactedConfigurationSummary(): Promise<string> {
    if (!(await fileExists(this.config.envFile))) return `home=${this.config.home}; configured=no`;
    const values = parseEnvFile(await readFile(this.config.envFile, "utf8"));
    const required = ["LLM_API_KEY", "ROOT_API_BEARER_TOKEN"];
    const missing = required.filter((name) => !values[name]?.trim());
    return `home=${this.config.home}; configured=${missing.length === 0 ? "yes" : "no"}; missing=${missing.join(",") || "none"}`;
  }
}
