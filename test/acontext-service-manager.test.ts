import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AcontextServiceManager,
  applyDiscoveredAcontextEnvironment,
  parseComposePsOutput,
  parseEnvFile,
  resolveAcontextServiceConfig,
} from "../src/acontext-service-manager.js";

test("resolves an isolated sidecar with loopback API defaults", () => {
  const config = resolveAcontextServiceConfig({
    ACONTEXT_SIDECAR_HOME: "D:\\isolated\\acontext",
    ACONTEXT_SIDECAR_API_PORT: "18029",
    ACONTEXT_SIDECAR_PROJECT: "test-project",
  });
  assert.equal(config.apiBaseUrl, "http://127.0.0.1:18029/api/v1");
  assert.equal(config.projectName, "test-project");
  assert.match(config.composeFile, /sidecar[\\/]docker-compose\.yaml$/);
});

test("parses secrets without including comments or printing values", () => {
  assert.deepEqual(parseEnvFile("# note\nROOT_API_BEARER_TOKEN='root-token'\nLLM_API_KEY=llm-token\n"), {
    ROOT_API_BEARER_TOKEN: "root-token",
    LLM_API_KEY: "llm-token",
  });
});

test("discovers API credentials from the private sidecar env file", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-acontext-sidecar-test-"));
  try {
    const envFile = join(home, ".env");
    await writeFile(envFile, "ROOT_API_BEARER_TOKEN=private-token\nLLM_API_KEY=model-token\n", "utf8");
    const config = resolveAcontextServiceConfig({ ACONTEXT_SIDECAR_HOME: home, ACONTEXT_SIDECAR_API_PORT: "18030" });
    const targetEnv: NodeJS.ProcessEnv = {};
    assert.equal(applyDiscoveredAcontextEnvironment(config, targetEnv), true);
    assert.equal(targetEnv.ACONTEXT_API_KEY, "sk-ac-private-token");
    assert.equal(targetEnv.ACONTEXT_BASE_URL, "http://127.0.0.1:18030/api/v1");
    const summary = await new AcontextServiceManager(config).redactedConfigurationSummary();
    assert.doesNotMatch(summary, /private-token|model-token/);
    assert.match(summary, /configured=yes/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("preserves an already-prefixed Acontext root key", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-acontext-sidecar-prefix-test-"));
  try {
    await writeFile(join(home, ".env"), "ROOT_API_BEARER_TOKEN=sk-ac-prefixed-token\nLLM_API_KEY=model-token\n", "utf8");
    const config = resolveAcontextServiceConfig({ ACONTEXT_SIDECAR_HOME: home });
    const targetEnv: NodeJS.ProcessEnv = {};
    applyDiscoveredAcontextEnvironment(config, targetEnv);
    assert.equal(targetEnv.ACONTEXT_API_KEY, "sk-ac-prefixed-token");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("parses both line-delimited and array compose status output", () => {
  const lineDelimited = '{"Service":"api","State":"running","Health":"healthy"}\n{"Service":"core","State":"running","Health":"healthy"}\n';
  const array = '[{"Service":"api","State":"running","Health":"healthy"}]';
  assert.equal(parseComposePsOutput(lineDelimited).length, 2);
  assert.deepEqual(parseComposePsOutput(array), [{ service: "api", state: "running", health: "healthy" }]);
});

test("vendored compose omits UI, Jaeger, sandbox and public infrastructure ports", async () => {
  const config = resolveAcontextServiceConfig({ ACONTEXT_SIDECAR_HOME: "D:\\isolated\\acontext" });
  const compose = await readFile(config.composeFile, "utf8");
  assert.doesNotMatch(compose, /^\s{2}(?:ui|jaeger):/m);
  assert.match(compose, /SANDBOX_TYPE: disabled/);
  assert.match(compose, /APP_TELEMETRY_ENABLED: \$\{ACONTEXT_API_OTEL_ENABLED:-true\}/);
  assert.match(compose, /OTEL_SDK_DISABLED: \$\{ACONTEXT_API_OTEL_SDK_DISABLED:-false\}/);
  assert.match(compose, /host\.docker\.internal:14317/);
  assert.match(compose, /OTEL_RESOURCE_ATTRIBUTES: openinference\.project\.name=\$\{ACONTEXT_API_PHOENIX_PROJECT_NAME:-acontext-transport\}/);
  assert.match(compose, /image: \$\{CORE_IMAGE:-ghcr\.io\/memodb-io\/acontext-core:0\.1\.20\}/);
  assert.doesNotMatch(compose, /Dockerfile\.trace|context: \.\.\//, "default deployment must not depend on a sibling source checkout");
  assert.match(compose, /127\.0\.0\.1:\$\{ACONTEXT_SIDECAR_API_PORT/);
  assert.equal((compose.match(/^\s{4}ports:/gm) ?? []).length, 1);
});

test("vendored sidecar raises Acontext's completion limit through the upstream kwargs hook", async () => {
  const bundledConfig = await readFile(new URL("../sidecar/config.yaml", import.meta.url), "utf8");
  assert.match(
    bundledConfig,
    /llm_openai_completion_kwargs:\s*\r?\n\s+extra_body:\s*\r?\n\s+max_tokens:\s*8192\b/,
  );
  assert.doesNotMatch(bundledConfig, /(?:api[_-]?key|bearer[_-]?token)\s*:/i);
});
