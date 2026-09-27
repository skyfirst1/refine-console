import {
  context,
  register,
  setSession,
  SpanStatusCode,
  trace,
} from "@arizeai/phoenix-otel";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type PhoenixSpanKind = "AGENT" | "EVALUATOR" | "RETRIEVER" | "LLM" | "TOOL";

export interface PhoenixAgentTaskContext {
  taskId: string;
  name: string;
  stage: string;
  runId?: string;
  inputRefs?: string[];
  outputRefs?: string[];
  attributes?: Record<string, string | number | boolean>;
}

interface PhoenixTracing {
  enabled: boolean;
  sessionId: string | undefined;
  provider?: ReturnType<typeof register>;
}

interface JsonRecord {
  [key: string]: unknown;
}

interface SpanLike {
  setAttribute(name: string, value: string | number | boolean): unknown;
  setStatus(status: { code: SpanStatusCode; message?: string }): unknown;
  recordException(error: Error): unknown;
  end(): unknown;
}

export const PHOENIX_AGENT_TASK_ENV = "PI_PHOENIX_AGENT_TASK";

export function phoenixTracingRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PHOENIX_ENABLED?.trim().toLowerCase() === "true";
}

const state: PhoenixTracing = {
  enabled: phoenixTracingRequested(),
  sessionId: process.env.PHOENIX_SESSION_ID?.trim(),
};

if (state.enabled) {
  if (!state.sessionId) throw new Error("PHOENIX_SESSION_ID is required when PHOENIX_ENABLED=true");
  state.provider = register({
    projectName: process.env.PHOENIX_PROJECT_NAME?.trim() || "pi-acontext-evaluation",
    url: process.env.PHOENIX_COLLECTOR_ENDPOINT?.trim() || "http://localhost:6006",
    batch: false,
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (isRecord(value)) return Object.values(value).flatMap(strings);
  return [];
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function messageSummary(message: unknown): JsonRecord {
  if (!isRecord(message)) return { role: "unknown" };
  const content = Array.isArray(message.content) ? message.content : [];
  const textCharacters = content.reduce((total, block) => {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return total;
    return total + block.text.length;
  }, 0);
  const toolCalls = content.filter((block) => isRecord(block) && block.type === "toolCall").length;
  const usage = isRecord(message.usage) ? message.usage : {};
  const cost = isRecord(usage.cost) ? usage.cost : {};
  return {
    role: typeof message.role === "string" ? message.role : "unknown",
    stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
    content: { textCharacters, toolCalls, blocks: content.length },
    usage: {
      input: numeric(usage.input),
      output: numeric(usage.output),
      cacheRead: numeric(usage.cacheRead),
      cacheWrite: numeric(usage.cacheWrite),
      totalTokens: numeric(usage.totalTokens),
      costUsd: numeric(cost.total),
    },
  };
}

/**
 * Summarize tool input without copying prompts, policies, document bodies, or
 * shell commands into telemetry. File references are retained as provenance.
 */
export function summarizeToolInput(args: unknown): JsonRecord {
  if (!isRecord(args)) return { argumentType: Array.isArray(args) ? "array" : typeof args };
  const refs = ["path", "filePath", "file_path"]
    .flatMap((key) => typeof args[key] === "string" ? [args[key] as string] : []);
  return {
    argumentKeys: Object.keys(args).sort(),
    artifactRefs: refs,
    stringCharacters: Object.fromEntries(
      Object.entries(args)
        .filter(([, value]) => typeof value === "string")
        .map(([key, value]) => [key, (value as string).length]),
    ),
  };
}

/** Summarize a Agent tool result by shape and size only; never retain its content. */
export function summarizeToolResult(result: unknown, isError: boolean): JsonRecord {
  const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
  return {
    isError,
    contentBlocks: content.length,
    textCharacters: content.reduce((total, block) => total + strings(block).join("").length, 0),
    imageBlocks: content.filter((block) => isRecord(block) && block.type === "image").length,
  };
}

export function encodePhoenixAgentTaskContext(task: PhoenixAgentTaskContext): string {
  return JSON.stringify(task);
}

export function readPhoenixAgentTaskContext(env: NodeJS.ProcessEnv = process.env): PhoenixAgentTaskContext | undefined {
  const raw = env[PHOENIX_AGENT_TASK_ENV]?.trim();
  if (!raw) return undefined;
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)
    || typeof value.taskId !== "string"
    || typeof value.name !== "string"
    || typeof value.stage !== "string") {
    throw new Error(`${PHOENIX_AGENT_TASK_ENV} must contain a valid task descriptor`);
  }
  return value as unknown as PhoenixAgentTaskContext;
}

function setJson(span: SpanLike, name: "input.value" | "output.value", value: unknown): void {
  span.setAttribute(name, JSON.stringify(value));
  span.setAttribute(name.replace("value", "mime_type"), "application/json");
}

/**
 * Bind Phoenix spans to The runtime's real AgentSession lifecycle. The parent span is
 * one agent task; model turns and tool executions are children created from
 * ExtensionAPI events. No prompt, response body, policy, or document body is
 * exported.
 */
export function registerPhoenixAgentEventTracing(
  runtime: ExtensionAPI,
  configuredTask: PhoenixAgentTaskContext | undefined = readPhoenixAgentTaskContext(),
): void {
  if (!state.enabled || !state.sessionId) return;
  const tracer = trace.getTracer("pi-agent-session-events");
  const sessionContext = setSession(context.active(), { sessionId: state.sessionId });
  let taskSpan: SpanLike | undefined;
  let taskContext = sessionContext;
  let turnSpan: SpanLike | undefined;
  let turnContext = sessionContext;
  let turnCount = 0;
  let toolCount = 0;
  const tools = new Map<string, { span: SpanLike; name: string }>();

  const closeTools = (status: SpanStatusCode, message?: string): void => {
    for (const { span } of tools.values()) {
      span.setStatus(message ? { code: status, message } : { code: status });
      span.end();
    }
    tools.clear();
  };

  const closeTurn = (status: SpanStatusCode, message?: string): void => {
    closeTools(status, message);
    if (!turnSpan) return;
    turnSpan.setStatus(message ? { code: status, message } : { code: status });
    turnSpan.end();
    turnSpan = undefined;
    turnContext = taskContext;
  };

  const closeTask = (status: SpanStatusCode, output: JsonRecord, message?: string): void => {
    closeTurn(status, message);
    if (!taskSpan) return;
    setJson(taskSpan, "output.value", output);
    taskSpan.setStatus(message ? { code: status, message } : { code: status });
    taskSpan.end();
    taskSpan = undefined;
    taskContext = sessionContext;
  };

  runtime.on("before_agent_start", (_event, ctx) => {
    if (taskSpan) closeTask(SpanStatusCode.ERROR, { status: "superseded", turns: turnCount, toolCalls: toolCount });
    turnCount = 0;
    toolCount = 0;
    const task = configuredTask ?? {
      taskId: ctx.sessionManager.getSessionId(),
      name: "Agent AgentSession task",
      stage: "interactive",
    };
    taskSpan = tracer.startSpan(task.name, {
      attributes: {
        "openinference.span.kind": "AGENT",
        "session.id": state.sessionId!,
        "agent.task.id": task.taskId,
        "agent.task.stage": task.stage,
        ...(task.runId ? { "agent.run.id": task.runId } : {}),
        ...(task.attributes ?? {}),
      },
    }, sessionContext);
    taskContext = trace.setSpan(sessionContext, taskSpan as Parameters<typeof trace.setSpan>[1]);
    setJson(taskSpan, "input.value", {
      taskId: task.taskId,
      runId: task.runId,
      stage: task.stage,
      inputRefs: task.inputRefs ?? [],
    });
  });

  runtime.on("turn_start", (event, ctx) => {
    if (!taskSpan) return;
    closeTurn(SpanStatusCode.ERROR, "turn replaced before turn_end");
    turnCount += 1;
    turnSpan = tracer.startSpan(`model turn ${event.turnIndex + 1}`, {
      attributes: {
        "openinference.span.kind": "LLM",
        "session.id": state.sessionId!,
        "llm.provider": ctx.model?.provider ?? "unknown",
        "llm.model_name": ctx.model?.id ?? "unknown",
        "agent.turn.index": event.turnIndex,
      },
    }, taskContext);
    turnContext = trace.setSpan(taskContext, turnSpan as Parameters<typeof trace.setSpan>[1]);
    setJson(turnSpan, "input.value", { turnIndex: event.turnIndex, model: ctx.model?.id ?? null });
  });

  runtime.on("tool_execution_start", (event) => {
    if (!taskSpan) return;
    toolCount += 1;
    const span = tracer.startSpan(`tool ${event.toolName}`, {
      attributes: {
        "openinference.span.kind": "TOOL",
        "session.id": state.sessionId!,
        "tool.name": event.toolName,
        "tool.call.id": event.toolCallId,
      },
    }, turnSpan ? turnContext : taskContext);
    setJson(span, "input.value", summarizeToolInput(event.args));
    tools.set(event.toolCallId, { span, name: event.toolName });
  });

  runtime.on("tool_execution_end", (event) => {
    const active = tools.get(event.toolCallId);
    if (!active) return;
    setJson(active.span, "output.value", summarizeToolResult(event.result, event.isError));
    active.span.setStatus({ code: event.isError ? SpanStatusCode.ERROR : SpanStatusCode.OK });
    active.span.end();
    tools.delete(event.toolCallId);
  });

  runtime.on("turn_end", (event) => {
    if (!turnSpan) return;
    const summary = messageSummary(event.message);
    setJson(turnSpan, "output.value", {
      ...summary,
      toolResults: event.toolResults.length,
    });
    const usage = isRecord(summary.usage) ? summary.usage : {};
    turnSpan.setAttribute("llm.token_count.prompt", numeric(usage.input));
    turnSpan.setAttribute("llm.token_count.completion", numeric(usage.output));
    turnSpan.setAttribute("llm.token_count.total", numeric(usage.totalTokens));
    turnSpan.setAttribute("llm.cost.total", numeric(usage.costUsd));
    closeTurn(SpanStatusCode.OK);
  });

  runtime.on("agent_end", (event) => {
    const task = configuredTask;
    const finalMessage = [...event.messages].reverse().find((message) => isRecord(message) && message.role === "assistant");
    closeTask(SpanStatusCode.OK, {
      status: "completed",
      turns: turnCount,
      toolCalls: toolCount,
      finalMessage: messageSummary(finalMessage),
      artifactRefs: task?.outputRefs ?? [],
    });
  });

  runtime.on("session_shutdown", async () => {
    if (taskSpan) closeTask(SpanStatusCode.ERROR, { status: "session_shutdown", turns: turnCount, toolCalls: toolCount });
    await shutdownPhoenixTracing();
  });
}

export function phoenixTracingEnabled(): boolean {
  return state.enabled;
}

/** Coarse spans are reserved for non-Agent external/evaluation operations. */
export async function tracePhoenixTurn<T>(options: {
  name: string;
  kind: Exclude<PhoenixSpanKind, "LLM" | "TOOL">;
  input: string;
  run: () => Promise<T>;
  output: (result: T) => string;
  attributes?: Record<string, string | number | boolean>;
  resultAttributes?: (result: T) => Record<string, string | number | boolean>;
}): Promise<T> {
  if (!state.enabled || !state.sessionId) return options.run();
  const tracer = trace.getTracer("pi-acontext-evaluation");
  const sessionContext = setSession(context.active(), { sessionId: state.sessionId });

  return context.with(sessionContext, () => tracer.startActiveSpan(options.name, {
    attributes: {
      "openinference.span.kind": options.kind,
      "session.id": state.sessionId!,
      "input.value": options.input,
      ...options.attributes,
    },
  }, async (span) => {
    try {
      const result = await options.run();
      span.setAttribute("output.value", options.output(result));
      for (const [name, value] of Object.entries(options.resultAttributes?.(result) ?? {})) {
        span.setAttribute(name, value);
      }
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setAttribute("output.value", JSON.stringify({ status: "error", errorType: error instanceof Error ? error.name : "unknown" }));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  }));
}

export async function shutdownPhoenixTracing(): Promise<void> {
  await state.provider?.shutdown();
}
