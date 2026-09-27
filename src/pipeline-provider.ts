import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function pipelineProvider(runtime: ExtensionAPI): void {
  const genericKey = process.env.PIPELINE_API_KEY?.trim();
  const deepseekKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!genericKey && !deepseekKey) return;
  const providerId = process.env.PIPELINE_PROVIDER_ID?.trim() || "deepseek";
  const modelId = process.env.PIPELINE_MODEL_ID?.trim() || "deepseek-v4-flash";
  const requestedMaxTokens = Number.parseInt(process.env.PIPELINE_MAX_TOKENS?.trim() || "8000", 10);
  const maxTokens = Number.isSafeInteger(requestedMaxTokens) && requestedMaxTokens > 0 ? requestedMaxTokens : 8_000;
  runtime.registerProvider(providerId, {
    name: process.env.PIPELINE_PROVIDER_NAME?.trim() || "Pipeline OpenAI-compatible API",
    baseUrl: process.env.PIPELINE_BASE_URL?.trim()
      || process.env.DEEPSEEK_BASE_URL?.trim()
      || "https://api.deepseek.com",
    apiKey: genericKey ? "$PIPELINE_API_KEY" : "$DEEPSEEK_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: modelId,
        name: process.env.PIPELINE_MODEL_NAME?.trim() || modelId,
        reasoning: true,
        input: ["text"],
        cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 },
        contextWindow: 1_000_000,
        maxTokens,
        compat: {
          thinkingFormat: "deepseek",
          supportsReasoningEffort: false,
          supportsDeveloperRole: false,
        },
      },
    ],
  });
}
