import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AcontextGateway } from "../src/contracts.js";
import { discoverGeneratedArtifacts } from "../src/artifact-discovery.js";
import { normalizeDocumentToMarkdown } from "../src/document-normalizer.js";
import { access } from "node:fs/promises";
import { parseAgentTaskEvents, runtimeCliPath, projectPublicAgentEvents } from "../src/agent-task-runner.js";
import { pipelineRuleLeaks, projectProductionAcontextMessages, stripPipelineOnlyLines, stripPolicyPipelineOnlyLines, waitForCompletedLearning } from "../src/production-pipeline.js";
import { PRODUCTION_RULES } from "../src/production-rules.js";
import { restoreProductionRangeSelection, sliceEntryRange } from "../src/session-range.js";

function userEntry(id: string, parentId: string | null, content: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-25T00:00:00.000Z",
    message: { role: "user", content, timestamp: 1 },
  };
}

test("persists and slices independently selected Acontext and Refine ranges", () => {
  const branch: SessionEntry[] = [
    userEntry("one", null, "one"),
    userEntry("two", "one", "two"),
    userEntry("three", "two", "three"),
    {
      type: "custom",
      id: "range",
      parentId: "three",
      timestamp: "2026-08-25T00:00:03.000Z",
      customType: "ranges",
      data: {
        version: 1,
        acontext: { startEntryId: "one", endEntryId: "three" },
        refine: { startEntryId: "two", endEntryId: "three" },
        selectedAt: "2026-08-25T00:00:03.000Z",
      },
    },
  ];
  const selection = restoreProductionRangeSelection(branch, "ranges");
  assert.ok(selection);
  assert.deepEqual(sliceEntryRange(branch, selection.refine, "refine").map((entry) => entry.id), ["two", "three"]);
});

test("selects the first generated document as baseline and the final generated document as gold", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-production-artifacts-"));
  const baseline = join(directory, "draft.md");
  const gold = join(directory, "final.docx");
  try {
    await Promise.all([writeFile(baseline, "draft", "utf8"), writeFile(gold, "not-a-real-docx", "utf8")]);
    const branch: SessionEntry[] = [
      {
        type: "message",
        id: "draft-call",
        parentId: null,
        timestamp: "2026-08-25T00:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: baseline } }],
          api: "openai-completions",
          provider: "test",
          model: "test",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 1,
        },
      },
      {
        type: "message",
        id: "gold-call",
        parentId: "draft-call",
        timestamp: "2026-08-25T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "c2", name: "word_create_document", arguments: { output_path: gold } }],
          api: "openai-completions",
          provider: "test",
          model: "test",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "draft-result",
        parentId: "gold-call",
        timestamp: "2026-08-25T00:00:02.000Z",
        message: { role: "toolResult", toolCallId: "c1", toolName: "write", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 },
      },
      {
        type: "message",
        id: "gold-result",
        parentId: "draft-result",
        timestamp: "2026-08-25T00:00:03.000Z",
        message: { role: "toolResult", toolCallId: "c2", toolName: "word_create_document", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 4 },
      },
    ];
    const result = await discoverGeneratedArtifacts(branch, directory);
    assert.equal(result.baseline.path, baseline);
    assert.equal(result.gold.path, gold);
    assert.equal(result.baseline.toolResultEntryId, "draft-result");
    assert.equal(result.gold.toolResultEntryId, "gold-result");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("binds an asynchronously started artifact write to its successful wait completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-production-async-artifact-"));
  const artifact = join(directory, "report.docx");
  try {
    await writeFile(artifact, "not-a-real-docx", "utf8");
    const assistant = (id: string, parentId: string | null, callId: string, name: string, args: Record<string, unknown>, timestamp: number): SessionEntry => ({
      type: "message", id, parentId, timestamp: new Date(timestamp).toISOString(),
      message: {
        role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }],
        api: "openai-completions", provider: "test", model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse", timestamp,
      },
    });
    const result = (id: string, parentId: string, callId: string, name: string, text: string, timestamp: number): SessionEntry => ({
      type: "message", id, parentId, timestamp: new Date(timestamp).toISOString(),
      message: { role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text }], isError: false, timestamp },
    });
    const branch: SessionEntry[] = [
      assistant("write-call", null, "write-1", "exec", { input: `SaveAs('${artifact}')` }, 1),
      result("started-result", "write-call", "write-1", "exec", "Script running with cell ID 51", 2),
      assistant("wait-call", "started-result", "wait-1", "wait", { cell_id: "51" }, 3),
      result("completion-result", "wait-call", "wait-1", "wait", "Script completed\nExit code: 0", 4),
    ];
    const discovered = await discoverGeneratedArtifacts(branch, directory);
    assert.equal(discovered.gold.path, artifact);
    assert.equal(discovered.gold.initialToolResultEntryId, "started-result");
    assert.equal(discovered.gold.toolResultEntryId, "completion-result");
    assert.equal(discovered.gold.completionToolCallId, "wait-1");
    assert.equal(discovered.gold.completionToolResultEntryId, "completion-result");
    assert.equal(discovered.gold.asyncCellId, "51");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not let a successful read tool result prove a failed write in the same assistant message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-production-multi-tool-proof-"));
  const existing = join(directory, "old.md");
  try {
    await writeFile(existing, "old", "utf8");
    const branch = [
      {
        type: "message", id: "multi", parentId: null, timestamp: "2026-08-25T00:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "read-ok", name: "read", arguments: { path: existing } },
            { type: "toolCall", id: "write-fails", name: "write", arguments: { path: existing } },
          ],
          api: "openai-completions", provider: "test", model: "test",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse", timestamp: 1,
        },
      },
      { type: "message", id: "read-result", parentId: "multi", timestamp: "2026-08-25T00:00:01.000Z", message: { role: "toolResult", toolCallId: "read-ok", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2 } },
      { type: "message", id: "write-result", parentId: "read-result", timestamp: "2026-08-25T00:00:02.000Z", message: { role: "toolResult", toolCallId: "write-fails", toolName: "write", content: [{ type: "text", text: "failed" }], isError: true, timestamp: 3 } },
    ] as SessionEntry[];
    await assert.rejects(discoverGeneratedArtifacts(branch, directory), /No generated document artifact/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepts a later successful wait when an earlier wait is still running", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-production-multi-wait-"));
  const artifact = join(directory, "report.docx");
  try {
    await writeFile(artifact, "not-a-real-docx", "utf8");
    const assistant = (id: string, parentId: string | null, callId: string, name: string, args: Record<string, unknown>, timestamp: number): SessionEntry => ({ type: "message", id, parentId, timestamp: new Date(timestamp).toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }], api: "openai-completions", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp } });
    const result = (id: string, parentId: string, callId: string, name: string, text: string, timestamp: number): SessionEntry => ({ type: "message", id, parentId, timestamp: new Date(timestamp).toISOString(), message: { role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text }], isError: false, timestamp } });
    const branch: SessionEntry[] = [
      assistant("write-call", null, "write-1", "exec", { input: `SaveAs('${artifact}')` }, 1),
      result("started", "write-call", "write-1", "exec", "Script running with cell ID 77", 2),
      assistant("wait-one", "started", "wait-1", "wait", { cell_id: "77" }, 3),
      result("wait-one-result", "wait-one", "wait-1", "wait", "Script running with cell ID 77", 4),
      assistant("wait-two", "wait-one-result", "wait-2", "wait", { cell_id: "77" }, 5),
      result("wait-two-result", "wait-two", "wait-2", "wait", "Script completed\nExit code: 0", 6),
    ];
    const discovered = await discoverGeneratedArtifacts(branch, directory);
    assert.equal(discovered.gold.completionToolCallId, "wait-2");
    assert.equal(discovered.gold.toolResultEntryId, "wait-two-result");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalizes Markdown and removes embedded image payloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-production-normalize-"));
  const source = join(directory, "artifact.md");
  try {
    await writeFile(source, "# Report\n\n![chart](data:image/png;base64,AAAA)\n\nDone.", "utf8");
    const result = await normalizeDocumentToMarkdown(source);
    assert.equal(result.imagesOmitted, 1);
    assert.match(result.markdown, /\[图片留空\]/);
    assert.doesNotMatch(result.markdown, /base64/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalizes text-based PDF artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-production-pdf-"));
  const source = join(directory, "artifact.pdf");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    "<< /Length 48 >>\nstream\nBT /F1 18 Tf 40 120 Td (PDF Refine Input) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  try {
    await writeFile(source, pdf, "ascii");
    const result = await normalizeDocumentToMarkdown(source);
    assert.equal(result.sourceExtension, ".pdf");
    assert.match(result.markdown, /PDF Refine Input/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalizes real DOCX images to the centrally managed blank placeholder", async () => {
  const source = join(process.cwd(), "node_modules", "mammoth", "test", "test-data", "tiny-picture.docx");
  const result = await normalizeDocumentToMarkdown(source);
  assert.ok(result.imagesOmitted > 0);
  assert.match(result.markdown, /\[图片留空\]/);
  assert.doesNotMatch(result.markdown, /data:image|base64/i);
});

test("allows a transient failed learning record to finish during the bounded grace period", async () => {
  let polls = 0;
  const client = {
    learningSpaces: {
      waitForLearning: async () => ({ status: "failed" }),
      getSession: async () => ({ status: ++polls >= 1 ? "completed" : "failed" }),
    },
  } as unknown as AcontextGateway;
  await waitForCompletedLearning(client, "space", "session", 1_000, 20, 1);
  assert.equal(polls, 1);
});

test("detects pipeline-only rules leaking into a description or policy", () => {
  assert.ok(pipelineRuleLeaks("先维护中间 Markdown 文档并转换为 docx，再由 subagent 并行处理。").includes("document-format-workflow"));
  assert.ok(pipelineRuleLeaks("先以中间 .md 文件形式进行多轮修改与审阅，完成后再产出最终文档版本。").includes("document-format-workflow"));
  assert.deepEqual(pipelineRuleLeaks("参考《企业技术 PRD.md》的组织方式。"), []);
  assert.deepEqual(pipelineRuleLeaks("官方格式：Markdown。\n产出内容完整、语言正式的调研报告。"), []);
  assert.deepEqual(pipelineRuleLeaks("报告需比较 Markdown 与 DOCX 文档生成能力，并输出兼容性结论。"), []);
  assert.deepEqual(pipelineRuleLeaks("调研多智能体并行处理算法及其性能边界。"), []);
  assert.deepEqual(pipelineRuleLeaks("正文引用用户提供的 skill 规范并分析其设计。"), []);
  assert.deepEqual(pipelineRuleLeaks("报告正文采用正式中文并明确范围。"), []);
  assert.deepEqual(stripPipelineOnlyLines("保留内容\n先维护中间 Markdown 文档并转换为 docx\n保留结构"), {
    text: "保留内容\n保留结构",
    removedLines: ["先维护中间 Markdown 文档并转换为 docx"],
  });
});

test("keeps synthetic gold out of Acontext learning and projects only real conversation text", () => {
  const assistant: SessionEntry = {
    type: "message",
    id: "assistant",
    parentId: "user",
    timestamp: "2026-08-25T00:00:01.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "真实助手回复" },
        { type: "toolCall", id: "tool", name: "read", arguments: { path: "D:/private/gold.md" } },
      ],
      api: "openai-completions",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 2,
    },
  };
  const toolResult: SessionEntry = {
    type: "message",
    id: "tool-result",
    parentId: "assistant",
    timestamp: "2026-08-25T00:00:02.000Z",
    message: { role: "toolResult", toolCallId: "tool", toolName: "read", content: [{ type: "text", text: "gold artifact body" }], isError: false, timestamp: 3 },
  };
  const projected = projectProductionAcontextMessages(
    [userEntry("user", null, "真实用户要求"), assistant, toolResult],
    { sourceSessionId: "session", maxToolResultChars: 10_000 },
  );
  assert.equal(PRODUCTION_RULES.version, 2);
  assert.equal(PRODUCTION_RULES.injectNormalizedGoldIntoLearning, false);
  assert.equal(PRODUCTION_RULES.acontextGoldInjectionMode, "disabled-refine-reads-full-gold");
  assert.deepEqual(projected.map((message) => message.blob.role), ["user", "assistant"]);
  assert.deepEqual(projected.map((message) => message.blob.content), ["真实用户要求", "真实助手回复"]);
  assert.ok(projected.every((message) => message.meta.source !== "pi_gold_artifact"));
  assert.doesNotMatch(JSON.stringify(projected), /toolCall|private\/gold\.md/);
});

test("repairs policy description metadata instead of deleting the required YAML key", () => {
  const result = stripPolicyPipelineOnlyLines("---\nname: refined-production-policy\ndescription: DOCX/Markdown 转换与 skill 由生产管线处理。\n---\n\n# Rules\n\n保留正文。\nskill 加载由工具处理。");
  assert.match(result.text, /^---\nname: refined-production-policy\ndescription: 从本轮真实生产 session 提炼的文档内容与写作规则。\n---/);
  assert.doesNotMatch(result.text, /skill|DOCX|Markdown/i);
  assert.equal(result.repairedMetadataLines.length, 1);
  assert.deepEqual(result.removedLines, ["skill 加载由工具处理。"]);
});

test("extracts final text and read evidence from Agent JSON events", () => {
  const raw = [
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", arguments: { path: "D:/run/input.md" } }],
        usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } },
      },
    }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "<<<DONE>>>" }],
        usage: { input: 20, output: 5, cacheRead: 4, cacheWrite: 1, totalTokens: 30, cost: { total: 0.002 } },
        stopReason: "stop",
      },
    }),
  ].join("\n");
  const parsed = parseAgentTaskEvents(raw);
  assert.equal(parsed.finalText, "<<<DONE>>>");
  assert.equal(parsed.stopReason, "stop");
  assert.deepEqual(parsed.toolNames, ["read"]);
  assert.equal(parsed.readPaths.length, 1);
  assert.deepEqual(parsed.usage, {
    input: 30,
    output: 7,
    cacheRead: 7,
    cacheWrite: 1,
    totalTokens: 45,
    costUsd: 0.003,
  });
});

test("Agent event parsing fails closed on malformed JSONL", () => {
  assert.throws(() => parseAgentTaskEvents('{"type":"agent_start"}\n{broken}\n'), /record 2/);
});

test("Agent event persistence removes private reasoning while preserving ordered public observations", () => {
  const secretThought = "never-persist-this-private-thought";
  const source = [
    { type: "agent_start" },
    { type: "thinking_start", content: secretThought },
    { type: "thinking_delta", delta: secretThought },
    { type: "thinking_end", content: secretThought },
    { type: "message_end", reasoning_content: secretThought, assistantMessageEvent: { type: "text_delta", encrypted_reasoning: secretThought }, message: { role: "assistant", reasoningContent: secretThought, metadata: { encrypted_reasoning: secretThought }, content: [{ type: "thinking", thinking: secretThought }, { type: "text", text: "public answer discusses reasoning and private APIs", reasoning_content: secretThought }], stopReason: "stop" } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", encrypted_reasoning: secretThought, arguments: { path: "D:/public/input.md", apiKey: "sk-abcdefghijklmnop", reasoningContent: secretThought } }], stopReason: "toolUse" } },
    { type: "agent_end" },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
  const projected = projectPublicAgentEvents(source); const records = projected.jsonl.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.type), ["agent_start", "message_end", "message_end", "agent_end"]);
  assert.match(projected.jsonl, /public answer discusses reasoning and private APIs/); assert.match(projected.jsonl, /D:\/public\/input\.md/); assert.doesNotMatch(projected.jsonl, /never-persist-this-private-thought|"(?:thinking|reasoning_content|reasoningContent|encrypted_reasoning)"|sk-abcdefghijklmnop/i);
  assert.equal(projected.provenance.sourceRecords, 7); assert.equal(projected.provenance.records, 4); assert.ok(projected.provenance.omittedPrivate.records >= 4); assert.ok(projected.provenance.omittedPrivate.bytes > 0); assert.ok(projected.provenance.redacted.records > 0);
});

test("resolves the installed Agent CLI without using an unexported package subpath", async () => {
  const path = runtimeCliPath();
  assert.match(path.replaceAll("\\", "/"), /pi-coding-agent\/dist\/cli\.js$/);
  await access(path);
});
