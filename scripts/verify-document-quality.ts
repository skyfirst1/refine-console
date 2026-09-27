import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  compareJudgeRounds,
  parseJudgeJson,
  QUALITY_CRITERIA,
  type BlindLabel,
  type CandidateName,
  type MappedJudgeRound,
} from "../src/document-quality-verifier.js";
import { shutdownPhoenixTracing, tracePhoenixTurn } from "../src/phoenix-tracing.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    baseline: { type: "string" },
    memory: { type: "string" },
    task: { type: "string" },
    rubric: { type: "string" },
    source: { type: "string", multiple: true, default: [] },
    output: { type: "string" },
    model: { type: "string", default: "deepseek-v4-flash" },
    "min-delta": { type: "string", default: "1" },
    "turn-prefix": { type: "string", default: "" },
    "turn-start": { type: "string", default: "4" },
  },
});

const baselinePath = values.baseline ?? positionals[0];
const memoryPath = values.memory ?? positionals[1];
if (!baselinePath || !memoryPath || !values.task || !values.rubric) {
  throw new Error("Usage: npm run verify-doc-quality -- <baseline.md> <memory.md> --task <prompt.md> --rubric <rubric.md> [--source <file>] [--output <json>]");
}

const minDelta = Number(values["min-delta"]);
if (!Number.isFinite(minDelta) || minDelta < 0) throw new Error("--min-delta must be non-negative");
const turnStart = Number.parseInt(values["turn-start"]!, 10);
if (!Number.isInteger(turnStart) || turnStart < 1) throw new Error("--turn-start must be a positive integer");
const turnName = (offset: number, label: string) => `${values["turn-prefix"]}${String(turnStart + offset).padStart(2, "0")} ${label}`;

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required");
const baseUrl = (process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com").replace(/\/$/, "");

async function load(path: string): Promise<string> {
  return readFile(resolve(path), "utf8");
}

const [baseline, memory, task, rubric, ...sources] = await Promise.all([
  load(baselinePath),
  load(memoryPath),
  load(values.task),
  load(values.rubric),
  ...values.source.map(load),
]);

const sourcePack = sources.map((content, index) => `### ${basename(values.source[index] ?? `source-${index + 1}`)}\n${content}`).join("\n\n");
const maxPromptChars = 500_000;
if (baseline.length + memory.length + task.length + rubric.length + sourcePack.length > maxPromptChars) {
  throw new Error(`Verifier input exceeds ${maxPromptChars} characters`);
}

async function judge(
  labels: Record<BlindLabel, CandidateName>,
  turnName: string,
): Promise<MappedJudgeRound> {
  const documents: Record<BlindLabel, string> = {
    A: labels.A === "baseline" ? baseline : memory,
    B: labels.B === "baseline" ? baseline : memory,
  };
  const prompt = `你是文档质量盲评 verifier。你不知道哪个文档使用了记忆。严格依据任务、rubric 和冻结资料评估 A、B。\n\n` +
    `规则：\n1. 不因文档更长而加分。\n2. 事实必须能由冻结资料支持。\n3. 每项质量分为 1-5。\n4. hard_checks 必须逐条覆盖 rubric 的硬性检查。\n5. factual_errors 列出具体错误；没有则返回空数组。\n6. 只输出 JSON。\n\n` +
    `质量指标：${QUALITY_CRITERIA.join("、")}\n\n` +
    `## 任务\n${task}\n\n## Rubric\n${rubric}\n\n## 冻结资料\n${sourcePack || "未提供额外资料；只能核验任务和 rubric 中明确给出的事实。"}\n\n` +
    `## 文档 A\n${documents.A}\n\n## 文档 B\n${documents.B}\n\n` +
    `返回结构：{"documents":{"A":{"hard_checks":[{"id":"...","passed":true,"reason":"...","evidence":"..."}],"scores":{"事实准确性":1,"方案完整性":1,"结构清晰度":1,"语言简洁度":1,"可操作性":1,"边界意识":1},"factual_errors":[],"summary":"..."},"B":{"hard_checks":[],"scores":{"事实准确性":1,"方案完整性":1,"结构清晰度":1,"语言简洁度":1,"可操作性":1,"边界意识":1},"factual_errors":[],"summary":"..."}},"winner":"A|B|tie","reason":"..."}`;

  return tracePhoenixTurn({
    name: turnName,
    kind: "EVALUATOR",
    input: prompt,
    run: async () => {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: values.model,
          messages: [
            { role: "system", content: "你是严格、可复核的文档质量 verifier。" },
            { role: "user", content: prompt },
          ],
          temperature: 0,
          max_tokens: 4096,
          response_format: { type: "json_object" },
          thinking: { type: "disabled" },
        }),
      });
      if (!response.ok) throw new Error(`Judge request failed: ${response.status} ${await response.text()}`);
      const payload = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: Record<string, unknown>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error("Judge returned no content");
      return { labels, result: parseJudgeJson(content), ...(payload.usage ? { usage: payload.usage } : {}) };
    },
    output: (round) => JSON.stringify(round.result),
  });
}

const rounds = [
  await judge({ A: "baseline", B: "memory" }, turnName(0, "Blind verifier round 1")),
  await judge({ A: "memory", B: "baseline" }, turnName(1, "Blind verifier round 2")),
];
const comparison = await tracePhoenixTurn({
  name: turnName(2, "Final quality verdict"),
  kind: "EVALUATOR",
  input: JSON.stringify(rounds.map((round) => ({ labels: round.labels, winner: round.result.winner, reason: round.result.reason }))),
  run: async () => compareJudgeRounds(rounds, minDelta),
  output: (result) => JSON.stringify(result),
});
const output = {
  ...comparison,
  inputs: {
    baseline: resolve(baselinePath),
    memory: resolve(memoryPath),
    task: resolve(values.task),
    rubric: resolve(values.rubric),
    sources: values.source.map((path) => resolve(path)),
    model: values.model,
  },
  interpretation: "This verdict applies to one paired task. It does not establish cross-task causal improvement.",
};
const serialized = `${JSON.stringify(output, null, 2)}\n`;
if (values.output) await writeFile(resolve(values.output), serialized, "utf8");
process.stdout.write(serialized);
process.exitCode = comparison.verdict === "improved" ? 0 : comparison.verdict === "inconclusive" ? 2 : 1;
await shutdownPhoenixTracing();
