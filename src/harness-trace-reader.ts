import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readTraceDisclosure } from "./refine-trace-disclosure.js";

export default function traceReader(runtime: ExtensionAPI) {
  const registryPath = process.env.HARNESS_TRACE_REGISTRY;
  const registryHash = process.env.HARNESS_TRACE_REGISTRY_HASH;
  if (!registryPath || !registryHash) throw new Error("Trace reader requires locally bound evidence");
  runtime.on("before_agent_start", (event, context) => ({
    // Agent automatically appends cwd even with a custom prompt. It is not evidence.
    systemPrompt: event.systemPrompt.replace(`\nCurrent working directory: ${context.cwd.replace(/\\/g, "/")}\n`, "\n"),
  }));
  runtime.on("context", event => ({ messages: event.messages.map(message => {
    if (message.role !== "user") return message;
    // The runtime's command-line attachment transport adds a local filename around the
    // controlled Harness user prompt. Keep all prompt bytes; replace only that
    // transport label, including prior turns replayed from the same session.
    const clean = (text: string) => text.replace(/^<file name="[^"\r\n]+events\.jsonl\.prompt\.md">\r?\n/, '<file name="harness-task">\n');
    return { ...message, content: typeof message.content === "string" ? clean(message.content) : message.content.map(block => block.type === "text" ? { ...block, text: clean(block.text) } : block) };
  }) }));
  runtime.registerTool({
    name: "trace_read", label: "Read public trace evidence",
    description: "Browse source-labelled public trace by role/stage, optionally recall literal keywords. Detail gives comparison statements, artifact changes and state events; raw retrieves original invocation evidence; use detail.originalRead to obtain the original output without unrelated input payloads, or choose inputs/all. Resource reads task documents/configuration. Follow returned continuation objects; zero hits or partial pages do not establish absence. Invocations browses originals even when no excerpts were selected. Handles come from default context or previous results.",
    parameters: Type.Object({
      source: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("historical")])),
      role: Type.Optional(Type.String({ description: 'For role configuration use level="resource", handle="configuration" (default resource handle), plus role. Omitting level browses detail, not configuration. Omit role for task documents.' })), stage: Type.Optional(Type.String()), keyword: Type.Optional(Type.String()),
      level: Type.Optional(Type.Union([Type.Literal("invocations"), Type.Literal("detail"), Type.Literal("excerpt"), Type.Literal("raw"), Type.Literal("resource")])),
      section: Type.Optional(Type.Union([Type.Literal("inputs"), Type.Literal("outputs"), Type.Literal("all")])),
      handle: Type.Optional(Type.String()), cursor: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })), adjacent: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
    }),
    async execute(_id, query) {
      const result = await readTraceDisclosure(registryPath, registryHash, query);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: { category: "public-trace-evidence" } };
    },
  });
}
