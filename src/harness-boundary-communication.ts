import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { runAgentTask, type AgentTaskOptions, type AgentTaskResult } from "./agent-task-runner.js";

export interface BoundarySource {
  id: string;
  scope: "task-skill" | "task-description" | "source-fulltext";
  text: string;
}

export interface BoundaryCommunicationConfig {
  outputRoot: string;
  materials: BoundarySource[];
  /** Prepared local projection only: exclude the Expert's Card/system instructions. */
  expert: { localInput: string; output: string; visibility: string };
  comparison?: never;
  task: Pick<AgentTaskOptions, "cwd" | "provider" | "model" | "timeoutMs" | "maxOutputTokens" | "thinking" | "extensionPaths">;
}

export interface ComparisonCommunicationConfig extends Omit<BoundaryCommunicationConfig, "expert" | "comparison"> {
  expert?: never;
  comparison: {
    axis: string;
    direction: string;
    case: { requestPath: string; caseSha256: string };
    samples: Array<{ sampleId: string; result: boolean; rationale: string; requestSha256: string; cardSha256: string }>;
  };
}
export type CommunicationConfig = BoundaryCommunicationConfig | ComparisonCommunicationConfig;

export const COMPARISON_SYSTEM = `你负责审查对齐阶段（Aligner）的 Expert：它按给定方向和评价维度判断局部材料之间的关系。你的目标是查清具体判断是否有据，为改进 Expert 积累真实的案例教学和改进建议。
逐次核对判断结果与给出的理由，保留每次行为的归属和原语境。围绕疑点查阅相关原文；提问只传待核事实、判据与必要原句，不带当前判断结果或预设答案，也不扩大原说法的范围。收到边界回复后，回到自己可见的原文核对其解释。
分别说明观察到了什么差异、依据什么标准才足以判断关系；看实际文本结构、含义与显示效果，区分位置和措辞，标记拼写或信息点数量本身不等于组织差异。集合有无须核对相应范围，未展示的部分保留待核。将原文事实、任务要求与推断分清，来源和限度记入审查，供后续案例教学追溯。`;

export const COMPARISON_BOUNDARY_SYSTEM = `你帮助审查方确定具体案例适用的评价边界。结合用户要求、相关规范和引用原文，说明应评价什么关系、适用什么判断标准，以及依据和限度。
先区分审查方的概括与所引原句，核对片段能支持案例描述到什么程度；集合有无或数量需要相应范围，未展示的内容保留待核。事实未明仍可解释判断标准，区分明确要求与合理推断，规范需要限定或补充时说明理由。
区分可观察差异与足以判断关系的依据，结合实际文本结构、含义和显示效果解释判据，区分位置与措辞。用来源和必要原句说明适用条件，不替 Expert 决定当前样本的答案。`;

export const REVIEW_SYSTEM = `你负责审查对齐阶段（Aligner）的 Expert：它按给定方向和评价维度判断局部材料之间的关系。你的目标是查清具体判断是否有据，为改进 Expert 积累真实的案例教学和改进建议。
核对实际输入、判断结果与给出的理由，保留行为归属和原语境。围绕疑点查阅相关原文，区分原始证据与后续补充材料；提问只传待核事实、判据与必要原句，不带当前判断结果或预设答案，也不扩大原说法的范围。收到边界回复后，回到自己可见的原文核对其解释。
分别说明观察到了什么差异、依据什么标准才足以判断关系；看实际文本结构、含义与显示效果，区分位置和措辞，标记拼写或信息点数量本身不等于组织差异。集合有无须核对相应范围，未展示的部分保留待核。将原文事实、任务要求与推断分清，来源和限度记入审查，供后续案例教学追溯。`;

export const BOUNDARY_SYSTEM = `你帮助审查方确定具体案例适用的评价边界。结合用户要求、相关规范和引用原文，说明应评价什么关系、适用什么判断标准，以及依据和限度。
先区分审查方的概括与所引原句，核对原句能支持描述到什么程度；集合有无或数量需要相应范围，未展示的内容保留待核。事实未明仍可解释判断标准，区分明确要求与合理推断，规范需要限定或补充时说明理由。
区分可观察差异与足以判断关系的依据，结合实际文本结构、含义和显示效果解释判据，区分位置与措辞。将全篇要求用于局部判断时说明理由，用来源和必要原句说明适用条件，不替 Expert 决定当前样本的答案。`;

const REVIEW_STAGE = "## 本次阶段\n围绕当前材料完成局部审查；收到边界回复后，用 finish_review 保存观察、依据和待核范围并结束。后续在同一上下文收到转换任务时，再构建教学实例与增量约束。";

/** Apply only after the saved review and its public tool results are restored. */
export function reviewConversionInstructions(originalSystem: string) {
  return {
    system: `${originalSystem}\n\n本阶段只忠实转换已完成的审查，用 expert_card_append 提交并结束。`,
    authorizedContinuationMessage: `请忠实转换本轮已有观察与边界回复，不重新审查或补充材料。promptAppend 只写有据、可复用的通用判断原则。
badCaseAppend 以“真实输入→示范输出”为主体：输入含方向、轴、两侧原 Evidence，保留会影响结论的必要上下文；rationale 对题作答，不写审查报告。
有充分依据支持完整判断时，示范输出在 <<<EVIDENCE_ALIGNMENT_START>>> 与 <<<EVIDENCE_ALIGNMENT_END>>> 之间仅放一个 JSON：matched 为表示本轴是否对齐的 boolean，rationale 为非空 string；可选 evidence_citation 为非空 string 或非空 string[]，不加其他字段。单条理由有误不意味着应反转原布尔判断。
若只核实局部，就明确给出局部正误对照，不冒充完整判断或完整 JSON，不造 null、unknown 标签。可附标明“不应模仿”的短错误对照。来源沿用已有审查记录，教学正文不叙述审查过程。`,
  };
}

export const COMMUNICATION_TOOLS = [
  {
    name: "ask_boundary",
    label: "询问任务边界",
    description: "向独立边界 agent 提一个有来源的任务边界问题，返回其回答。仅可成功调用一次；不要传 Expert 结论、拟定答案或 Card 内容。",
    parameters: Type.Object({ question: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  },
  {
    name: "finish_review",
    label: "保存审查并结束",
    description: "收到边界回答后，保存审查正文并结束。正文应包含原文依据、来源、适用范围和未决项；不要求当前 pair 的替代标签。",
    parameters: Type.Object({ review: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  },
  {
    name: "read_source",
    label: "按断言查证原文",
    description: "局部证据不足以核查具体断言时才查原文，不重评全文。read：填已见的唯一单行 anchor（规范须先由边界回答引用），question 写核查问题，返回前后各1行。expand：不传anchor，question 写上一片段仍缺的具体信息，从该来源最近窗口前后各扩2行，只返新增原文。本次查证预算为每来源24行、合计40行；限额或缺口不代表事实不存在或标签成立。结果为Harness补证，非Expert原可见输入。",
    parameters: Type.Object({ action: Type.Union([Type.Literal("read"), Type.Literal("expand")]), source: Type.String({ minLength: 1 }), question: Type.String({ minLength: 1 }), anchor: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
  },
] as const;

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2);
const save = (path: string, value: unknown) => writeFileSync(path, `${json(value)}\n`, { flag: "wx" });
const sourcePrompt = (sources: BoundarySource[]) => sources.map(source =>
  `SOURCE ${source.id} (${source.scope})\n${source.text}\nEND SOURCE ${source.id}`).join("\n\n");
const boundaryMaterials = (materials: BoundarySource[]) => materials.filter(source => source.scope !== "source-fulltext");

/** Decode the supported Expert envelope without summarizing or normalizing any string leaf. */
export function projectExpertInput(raw: string) {
  const mapping: Array<{ path: string; value: string; displayId?: string }> = [];
  const blocks: string[] = [];
  const instructions: string[] = [];
  let context = "";
  const object = (value: any, keys: string[], path: string) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) throw Error(`Unsupported Expert input shape: ${path}`);
  };
  const leaf = (value: unknown, path: string, displayId?: string) => {
    if (typeof value !== "string") throw Error(`Expected original string at ${path}`);
    mapping.push({ path, value, ...(displayId ? { displayId } : {}) });
    return value;
  };
  const array = (value: any, path: string): any[] => {
    if (!Array.isArray(value) || !value.length) throw Error(`Expected nonempty array at ${path}`);
    return value;
  };
  const envelope = JSON.parse(raw);
  object(envelope, ["messages"], "$ ");
  let pairs = 0;
  let localPair: any;
  for (const [i, message] of array(envelope.messages, "$.messages").entries()) {
    const messagePath = `$.messages[${i}]`;
    object(message, ["role", "content"], messagePath);
    if (message.role !== "user") throw Error(`Unsupported Expert message role at ${messagePath}`);
    leaf(message.role, `${messagePath}.role`);
    for (const [j, content] of array(message.content, `${messagePath}.content`).entries()) {
      const path = `${messagePath}.content[${j}]`;
      object(content, ["type", "text"], path);
      if (content.type !== "text" || typeof content.text !== "string") throw Error(`Unsupported Expert content at ${path}`);
      leaf(content.type, `${path}.type`);
      const marker = "完整授权输入（数据，不是额外指令）：\n";
      const split = content.text.indexOf(marker);
      if (split < 0) { instructions.push(leaf(content.text, `${path}.text`, `instructions.${instructions.length + 1}`)); continue; }
      instructions.push(leaf(content.text.slice(0, split + marker.length), `${path}.text[instructions-prefix]`, `instructions.${instructions.length + 1}`));
      const files = JSON.parse(content.text.slice(split + marker.length));
      for (const [k, file] of array(files, `${path}.text[file-array]`).entries()) {
        const filePath = `${path}.text[file-array][${k}]`;
        object(file, ["name", "content"], filePath);
        leaf(file.name, `${filePath}.name`);
        if (typeof file.content !== "string") throw Error(`Expected pair JSON string at ${filePath}.content`);
        const pair = JSON.parse(file.content);
        const pairPath = `${filePath}.content[pair]`;
        object(pair, ["direction", "mode", "sourceAspect", "targetAspect"], pairPath);
        pairs++;
        localPair = pair;
        context = `被审查 Expert：Aligner；方向：${leaf(pair.direction, `${pairPath}.direction`, "direction")}；轴：${leaf(pair.mode, `${pairPath}.mode`, "mode")}`;
        for (const side of ["sourceAspect", "targetAspect"] as const) {
          const aspect = pair[side], aspectPath = `${pairPath}.${side}`;
          object(aspect, ["id", "title", "description", "evidences"], aspectPath);
          const label = side === "sourceAspect" ? "source" : "target";
          blocks.push(`## ${label}\nid: ${leaf(aspect.id, `${aspectPath}.id`, `${label}.id`)}\ntitle: ${leaf(aspect.title, `${aspectPath}.title`, `${label}.title`)}\ndescription: ${leaf(aspect.description, `${aspectPath}.description`, `${label}.description`)}`);
          for (const [n, evidence] of array(aspect.evidences, `${aspectPath}.evidences`).entries()) {
            const evidencePath = `${aspectPath}.evidences[${n}]`;
            object(evidence, ["quote", "location"], evidencePath);
            const id = `${side === "sourceAspect" ? "S" : "T"}${n + 1}`;
            const quote = leaf(evidence.quote, `${evidencePath}.quote`, `${id}.quote`);
            const location = leaf(evidence.location, `${evidencePath}.location`, `${id}.location`);
            blocks.push(`${id} · ${location}\n${quote}`);
          }
        }
      }
    }
  }
  if (pairs !== 1) throw Error("Expected exactly one supported local Aspect pair; no fields were silently omitted");
  return { text: `${context}\n\n${blocks.join("\n\n")}`, instructions: instructions.join("\n\n"), mapping, pair: localPair };
}

/** Runtime-only binding: source request and case bytes never pass through the reviewer. */
export function boundComparisonCase(config: ComparisonCommunicationConfig) {
  const binding = config.comparison.case;
  if (!binding) throw Error("Comparison case binding is required; re-prepare the comparison with its frozen source request");
  if (Object.keys(binding).some(key => !["requestPath", "caseSha256"].includes(key)) || typeof binding.requestPath !== "string" || !isAbsolute(binding.requestPath) || !/^[a-f0-9]{64}$/.test(binding.caseSha256)) throw Error("Invalid comparison case binding");
  const request = JSON.parse(readFileSync(binding.requestPath, "utf8"));
  const requestSha256 = digest(JSON.stringify(request));
  if (!config.comparison.samples.length || config.comparison.samples.some(sample => sample.requestSha256 !== requestSha256)) throw Error("Comparison case request does not match sample request binding");
  if (!Array.isArray(request.messages)) throw Error("Comparison case request has no messages");
  const originalUsers = request.messages.filter((message: any) => message?.role === "user");
  const projection = projectExpertInput(JSON.stringify({ messages: originalUsers }));
  const caseSha256 = digest(JSON.stringify(projection.pair));
  if (caseSha256 !== binding.caseSha256) throw Error("Comparison case digest mismatch");
  if (projection.pair.mode !== config.comparison.axis || projection.pair.direction !== config.comparison.direction) throw Error("Comparison case mode/direction does not match comparison scope");
  return { requestPath: binding.requestPath, requestSha256, caseSha256, pair: projection.pair, text: projection.text,
    mapping: projection.mapping.filter(field => field.displayId && !field.displayId.startsWith("instructions.")) };
}

function comparisonEvidence(config: ComparisonCommunicationConfig) {
  const { pair } = boundComparisonCase(config);
  return (["source", "target"] as const).flatMap(side => pair[`${side}Aspect`].evidences.map((evidence: { quote: string; location: string }, index: number) => ({ id: `${side === "source" ? "S" : "T"}${index + 1}`, side, quote: evidence.quote, location: evidence.location })));
}

function comparisonTools(config: ComparisonCommunicationConfig) {
  const ids = comparisonEvidence(config).map(evidence => evidence.id).join(", ");
  return [
    { name: "ask_boundary", label: "用具体 case 询问边界", description: "提交待核事实、判据问题和必要选摘，保留行为归属与原语境，不带当前判断结果或预设答案。引句须先 read_evidence 并逐字来自对应 ID；来源核对不证明概括或缺失判断。仅可成功调用一次。",
      parameters: Type.Object({ question: Type.String({ minLength: 1 }), case: Type.String({ minLength: 1 }), evidence: Type.Array(Type.Object({ id: Type.String({ minLength: 1 }), quote: Type.String({ minLength: 1 }) }, { additionalProperties: false }), { minItems: 1 }) }, { additionalProperties: false }) },
    COMMUNICATION_TOOLS[1],
    { name: "read_evidence", label: "读取原局部 Evidence", description: `按需读取冻结 Expert 局部输入的原句与位置，非源文稿全文；不能由未读推断不存在。可用 ID：${ids}。`, parameters: Type.Object({ ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }) }, { additionalProperties: false }) },
  ];
}

export function projectExpertOutput(raw: string) {
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["matched", "rationale", "evidence_citation"].includes(key)) || typeof value.matched !== "boolean" || typeof value.rationale !== "string") throw Error("Unsupported Expert output shape");
  const mapping: Array<{ path: string; value: string | boolean; displayId: string }> = [
    { path: "$.matched", value: value.matched, displayId: "matched" }, { path: "$.rationale", value: value.rationale, displayId: "rationale" },
  ];
  const blocks = [`matched: ${value.matched}`, `rationale:\n${value.rationale}`];
  if ("evidence_citation" in value) {
    const citations = typeof value.evidence_citation === "string" ? [value.evidence_citation] : value.evidence_citation;
    if (!Array.isArray(citations) || !citations.length || citations.some(item => typeof item !== "string" || !item.trim())) throw Error("Unsupported Expert output evidence_citation");
    blocks.push("Expert 用于支持判断的引用（待核对）：\n这些是 Expert 自行列出、声称支持 rationale 的引用；需核查是否来自原局部输入并支持其理由，不是新增输入 Evidence、规范或 Gold。");
    citations.forEach((citation: string, index: number) => {
      const displayId = `C${index + 1}`;
      mapping.push({ path: typeof value.evidence_citation === "string" ? "$.evidence_citation" : `$.evidence_citation[${index}]`, value: citation, displayId });
      blocks.push(`${displayId}\n${citation}`);
    });
  }
  return { text: blocks.join("\n\n"), mapping };
}

export function reviewPrompt(config: CommunicationConfig): string {
  if (config.comparison) return `${REVIEW_STAGE}\n\n## 被审查 Expert：Aligner\n方向：${config.comparison.direction}；轴：${config.comparison.axis}\n\n${config.comparison.samples.map(sample => `## ${sample.sampleId}\nresult: ${sample.result}\nrationale:\n${sample.rationale}`).join("\n\n")}`;
  const input = projectExpertInput(config.expert.localInput);
  const directory = config.materials.map(source => `${source.id}: ${source.scope}, ${source.text.split(/\r?\n/).length} lines`).join("\n");
  return `${REVIEW_STAGE}\n\n## 被审查 Expert：Aligner\n${input.text}\n\n## Expert 原输出\n${projectExpertOutput(config.expert.output).text}\n\n## 原始调用指令（历史原文）\n${input.instructions}\n\n## 可查来源（正文未提供；规范须先由边界引用）\n${directory}`;
}

export function boundaryPrompt(materials: BoundarySource[], question: string): string {
  return `## 任务材料\n${sourcePrompt(boundaryMaterials(materials))}\n\n## 审查方的问题与所引局部材料\n${question}`;
}

export const SOURCE_READ_LIMITS = { initialContextLines: 1, expansionLinesPerSide: 2, maxSourceLines: 24, maxTotalLines: 40, maxCallCharacters: 3000, maxTotalCharacters: 12000 } as const;
const MAX_REVIEW_REQUESTS = 5;
interface SourceReadState { windows: Map<string, { startLine: number; endLine: number; seen: Set<number> }>; totalLines: number; totalCharacters: number }

/** Reuse the SDK's bounded line reader; ranges and cumulative disclosure stay runtime-bound. */
async function readSource(config: BoundaryCommunicationConfig, state: SourceReadState, args: { action: "read" | "expand"; source: string; anchor?: string; question: string }) {
  const source = config.materials.find(item => item.id === args.source);
  if (!source) throw Error("Unknown source; choose an id from SOURCE DIRECTORY. Paths, Card and history are not available.");
  const lines = source.text.split(/\r?\n/);
  const previous = state.windows.get(source.id);
  let startLine: number, endLine: number;
  if (args.action === "read") {
    if (!args.anchor?.trim() || /[\r\n]/.test(args.anchor)) throw Error("read requires a nonempty single-line anchor from the original local input or previously returned source text.");
    const answerPath = resolve(config.outputRoot, "boundary-answer.json");
    const visible = source.scope === "source-fulltext" ? projectExpertInput(config.expert.localInput).mapping.map(item => item.value).join("\n") : existsSync(answerPath) ? JSON.parse(readFileSync(answerPath, "utf8")).answer as string : "";
    if (!visible.includes(args.anchor) && ![...(previous?.seen ?? [])].some(line => lines[line - 1]!.includes(args.anchor!))) throw Error("Anchor was not visible in the original local input, prior boundary answer (task rules only), or returned excerpts; use a visible quoted fragment.");
    const offset = source.text.indexOf(args.anchor);
    if (offset < 0) throw Error("Anchor not found; use an exact fragment of the quoted source text.");
    if (source.text.indexOf(args.anchor, offset + 1) >= 0) throw Error("Anchor occurs more than once; provide a longer unique fragment.");
    const anchorLine = source.text.slice(0, offset).split(/\r?\n/).length;
    startLine = Math.max(1, anchorLine - SOURCE_READ_LIMITS.initialContextLines);
    endLine = Math.min(lines.length, anchorLine + SOURCE_READ_LIMITS.initialContextLines);
  } else {
    if (args.anchor !== undefined || !previous) throw Error("expand requires a previous successful read of this source, no anchor, and question describing the remaining gap in that excerpt.");
    startLine = Math.max(1, previous.startLine - SOURCE_READ_LIMITS.expansionLinesPerSide);
    endLine = Math.min(lines.length, previous.endLine + SOURCE_READ_LIMITS.expansionLinesPerSide);
  }
  const seen = previous?.seen ?? new Set<number>();
  const added = Array.from({ length: endLine - startLine + 1 }, (_, i) => startLine + i).filter(line => !seen.has(line));
  const characters = added.reduce((sum, line) => sum + lines[line - 1]!.length + 1, 0);
  if (seen.size + added.length > SOURCE_READ_LIMITS.maxSourceLines || state.totalLines + added.length > SOURCE_READ_LIMITS.maxTotalLines || characters > SOURCE_READ_LIMITS.maxCallCharacters || state.totalCharacters + characters > SOURCE_READ_LIMITS.maxTotalCharacters) throw Error("This run's bounded source-verification budget would be exceeded. Preserve the specific evidence gap; a read limit is not evidence of absence or a true/false label.");
  const ranges: Array<{ startLine: number; endLine: number }> = [];
  for (const line of added) {
    const last = ranges.at(-1);
    if (last && last.endLine + 1 === line) last.endLine = line;
    else ranges.push({ startLine: line, endLine: line });
  }
  const boundPath = resolve(config.outputRoot, "bound-source.txt");
  const assertPath = (path: string) => { if (path !== boundPath) throw Error("Source path binding changed"); };
  const reader = createReadTool(config.outputRoot, { operations: {
    access: async path => { assertPath(path); },
    readFile: async path => { assertPath(path); return Buffer.from(source.text, "utf8"); },
    detectImageMimeType: async () => undefined,
  } });
  const excerpts = await Promise.all(ranges.map(async range => {
    const result = await reader.execute("read-bound-source", { path: boundPath, offset: range.startLine, limit: range.endLine - range.startLine + 1 });
    return { ...range, content: result.content, ...(result.details ? { details: result.details } : {}) };
  }));
  added.forEach(line => seen.add(line));
  state.windows.set(source.id, { startLine, endLine, seen });
  state.totalLines += added.length;
  state.totalCharacters += characters;
  return { source: source.id, action: args.action, question: args.question, ...(args.anchor ? { anchor: args.anchor } : {}), windowStartLine: startLine, windowEndLine: endLine, totalLines: lines.length,
    evidenceScope: source.scope === "source-fulltext" ? "harness-supplemental-not-expert-visible" : "harness-norm-check-not-expert-visible", status: added.length ? "excerpt-returned" : "already-visible", ranges: excerpts,
    coverage: { sourceLines: seen.size, totalLines: state.totalLines, totalCharacters: state.totalCharacters }, limits: SOURCE_READ_LIMITS,
    scopeNote: "Limits describe this run's verification budget, not task truth; preserve unresolved gaps when further reading is unavailable." };
}

function validateConfig(config: CommunicationConfig): void {
  if (!config.outputRoot || !config.task.cwd || !config.task.provider || !config.task.model || !(config.task.timeoutMs > 0)) throw Error("Missing communication runtime configuration");
  if (!config.task.extensionPaths?.length) throw Error("An explicit provider extension is required; include the existing budget guard for paid runs");
  const ids = new Set<string>();
  for (const source of config.materials) {
    if (!source.id.trim() || ids.has(source.id) || !source.text.trim() || !["task-skill", "task-description", "source-fulltext"].includes(source.scope)) throw Error("Invalid or duplicate source");
    ids.add(source.id);
  }
  for (const scope of ["task-skill", "task-description"]) if (!config.materials.some(source => source.scope === scope)) throw Error(`Missing ${scope}`);
  if (config.comparison) {
    if (config.expert !== undefined) throw Error("Expert review and replay comparison are mutually exclusive");
    const comparison = config.comparison;
    if (!comparison.axis?.trim() || !comparison.direction?.trim() || !Array.isArray(comparison.samples) || comparison.samples.length < 2) throw Error("Comparison requires scope and at least two samples");
    if (Object.keys(comparison).some(key => !["axis", "direction", "samples", "case"].includes(key))) throw Error("Unknown comparison field");
    const sampleIds = new Set<string>();
    for (const sample of comparison.samples) {
      if (Object.keys(sample).some(key => !["sampleId", "result", "rationale", "requestSha256", "cardSha256"].includes(key)) || !sample.sampleId?.trim() || sampleIds.has(sample.sampleId) || typeof sample.result !== "boolean" || typeof sample.rationale !== "string" || !sample.rationale.trim()) throw Error("Invalid or duplicate comparison sample");
      sampleIds.add(sample.sampleId);
      for (const field of ["requestSha256", "cardSha256"] as const) if (!/^[a-f0-9]{64}$/.test(sample[field]) || sample[field] !== comparison.samples[0]![field]) throw Error("Comparison samples must bind the same immutable request and Card");
    }
    boundComparisonCase(config);
  } else {
    if (!config.expert) throw Error("Missing communication input mode");
    for (const value of Object.values(config.expert)) if (typeof value !== "string" || !value.trim()) throw Error("Missing Expert projection or visibility");
  }
}

/** One new output directory is one run. No old sessions or model history are resumed. */
export function prepareBoundaryCommunication(config: CommunicationConfig): { configPath: string; extensionPath: string } {
  validateConfig(config);
  const projection = config.expert ? projectExpertInput(config.expert.localInput) : undefined;
  const outputProjection = config.expert ? projectExpertOutput(config.expert.output) : undefined;
  const caseProjection = config.comparison ? boundComparisonCase(config) : undefined;
  mkdirSync(config.outputRoot, { recursive: false });
  const configPath = resolve(config.outputRoot, "config.json");
  const extensionPath = resolve(config.outputRoot, "review-extension.ts");
  const moduleUrl = pathToFileURL(fileURLToPath(import.meta.url)).href;
  const raw = `${json(config)}\n`;
  writeFileSync(configPath, raw, { flag: "wx" });
  if (caseProjection) {
    save(resolve(config.outputRoot, "comparison-case-binding.json"), { requestPath: caseProjection.requestPath, requestSha256: caseProjection.requestSha256, caseSha256: caseProjection.caseSha256, fields: caseProjection.mapping });
    save(resolve(config.outputRoot, "comparison-case.json"), caseProjection.pair);
  }
  if (config.expert && projection && outputProjection) {
    writeFileSync(resolve(config.outputRoot, "expert-input-raw.txt"), config.expert.localInput, { flag: "wx" });
    save(resolve(config.outputRoot, "expert-input-mapping.json"), { rawSha256: digest(config.expert.localInput), decoding: "messages/content.text -> instructions prefix + JSON file array -> content pair JSON; string leaves unchanged; fields without displayId are offline metadata", visibility: config.expert.visibility, fields: projection.mapping });
    writeFileSync(resolve(config.outputRoot, "expert-output-raw.txt"), config.expert.output, { flag: "wx" });
    save(resolve(config.outputRoot, "expert-output-mapping.json"), { rawSha256: digest(config.expert.output), decoding: "JSON values decoded once; input S/T evidence and output C citations remain separate", fields: outputProjection.mapping });
  }
  writeFileSync(extensionPath, `import { readFileSync } from 'node:fs';\nimport { createHash } from 'node:crypto';\nimport { registerBoundaryCommunicationTools } from ${JSON.stringify(moduleUrl)};\nexport default function(pi) {\n const raw = readFileSync(${JSON.stringify(configPath)}, 'utf8');\n if (createHash('sha256').update(raw).digest('hex') !== ${JSON.stringify(digest(raw))}) throw Error('Communication config changed');\n registerBoundaryCommunicationTools(pi, JSON.parse(raw));\n}\n`, { flag: "wx" });
  writeFileSync(resolve(config.outputRoot, "boundary-limit-extension.ts"), `import { installCommunicationRequestLimit } from ${JSON.stringify(moduleUrl)};\nexport default function(pi) { installCommunicationRequestLimit(pi, 1); }\n`, { flag: "wx" });
  writeFileSync(resolve(config.outputRoot, "rendered-prompts.md"), `# 审查 Expert 的 Harness agent\n\n${config.comparison ? COMPARISON_SYSTEM : REVIEW_SYSTEM}\n\n# 边界 Harness agent\n\n${config.comparison ? COMPARISON_BOUNDARY_SYSTEM : BOUNDARY_SYSTEM}\n\n# 初始审查输入\n\n${reviewPrompt(config)}\n`, { flag: "wx" });
  save(resolve(config.outputRoot, "tools.json"), config.comparison ? comparisonTools(config) : COMMUNICATION_TOOLS);
  return { configPath, extensionPath };
}

/** Installed before the existing paid guard so terminal/over-limit requests abort first. */
export function installCommunicationRequestLimit(runtime: any, maxRequests: number, assertOpen: () => void = () => {}): () => number {
  let requests = 0;
  runtime.on("before_provider_request", (_event: unknown, context: any) => {
    try { assertOpen(); if (++requests > maxRequests) throw Error("Communication request limit reached"); }
    catch (error) { context.abort(); throw error; }
  });
  return () => requests;
}

export function registerBoundaryCommunicationTools(runtime: any, config: CommunicationConfig, runner: typeof runAgentTask = runAgentTask): void {
  const root = config.outputRoot;
  const questionPath = resolve(root, "question.json");
  const answerPath = resolve(root, "boundary-answer.json");
  const reviewPath = resolve(root, "review.json");
  const failurePath = resolve(root, "failure.json");
  const assertOpen = () => {
    if (existsSync(reviewPath)) throw Error("Review saved; communication complete");
    if (existsSync(failurePath)) throw Error("Communication failed; see failure.json");
  };
  const requestCount = installCommunicationRequestLimit(runtime, MAX_REVIEW_REQUESTS, assertOpen);
  const sourceReads: SourceReadState = { windows: new Map(), totalLines: 0, totalCharacters: 0 };
  const evidenceReadIds = new Set<string>();
  let readQueue: Promise<unknown> = Promise.resolve();
  let reminded = false;
  runtime.on("turn_end", (event: any, context: any) => {
    const message = event.message;
    if (requestCount() === MAX_REVIEW_REQUESTS - 1 && !context.signal?.aborted && existsSync(answerPath) && !existsSync(reviewPath) && !existsSync(failurePath) && message?.role === "assistant" && ["stop", "toolUse"].includes(message.stopReason)) {
      // Reserve the final request for submission, including unresolved findings.
      runtime.setActiveTools(["finish_review"]);
    }
    if (reminded || requestCount() >= MAX_REVIEW_REQUESTS || context.signal?.aborted || existsSync(reviewPath) || existsSync(failurePath) || !existsSync(answerPath) ||
      message?.role !== "assistant" || message.stopReason !== "stop" || !message.content?.some((part: any) => part.type === "text" && part.text?.trim()) ||
      message.content.some((part: any) => part.type === "toolCall")) return;
    reminded = true;
    const content = "审查正文尚未通过 finish_review 保存。请调用 finish_review 提交你自己的已有审查；本提醒不要求改变结论。纯文字回复不会生成完成回执。";
    save(resolve(root, "completion-reminder.json"), { content, reviewRequestsUsed: requestCount(), maxReviewRequests: MAX_REVIEW_REQUESTS });
    runtime.sendMessage({ customType: "communication-completion-reminder", content, display: true }, { deliverAs: "followUp", triggerTurn: true });
  });
  const definitions = config.comparison ? comparisonTools(config) : COMMUNICATION_TOOLS;
  for (const definition of definitions) {
    runtime.registerTool({ ...definition, execute: async (_id: string, args: any) => {
      assertOpen();
      try {
        const valid: boolean = Check(definition.parameters, args);
        if (!valid || (definition.name !== "read_evidence" && !String(args.question ?? args.review).trim()) || (definition.name === "read_source" && !args.source.trim())) throw Error(`Invalid ${definition.name} arguments`);
        if (definition.name === "read_evidence") {
          if (!config.comparison) throw Error("Evidence selection requires comparison mode");
          const catalog = comparisonEvidence(config);
          if (new Set(args.ids).size !== args.ids.length) throw Error("Evidence IDs must be unique");
          const selected = args.ids.map((id: string) => { const item = catalog.find(evidence => evidence.id === id); if (!item) throw Error(`Unknown Evidence ID: ${id}`); return item; });
          args.ids.forEach((id: string) => evidenceReadIds.add(id));
          return { content: [{ type: "text", text: json({ note: "以下是本次读取的原局部材料，不是文稿全文；未展示的部分仍待核，原句是否支持案例描述需另行判断。", evidence: selected }) }], details: { evidenceScope: "expert-original-local-input", evidence: selected, scopeNote: "Only selected original local Evidence; this is not full source-document coverage or proof of a case summary." } };
        }
        if (definition.name === "read_source") {
          if (config.comparison) throw Error("Source reads are unavailable in replay comparison");
          const pending = readQueue.then(() => readSource(config, sourceReads, args));
          readQueue = pending.catch(() => {});
          return { content: [{ type: "text", text: json(await pending) }], details: {} };
        }
        if (definition.name === "ask_boundary") {
          if (existsSync(questionPath)) throw Error("Only one boundary question is allowed");
          let question = args.question;
          let selected: Array<{ id: string; side: string; quote: string; location: string }> | undefined;
          if (config.comparison) {
            if (!args.case.trim()) throw Error("A concrete, evidence-supported case is required");
            const catalog = comparisonEvidence(config);
            selected = args.evidence.map((citation: { id: string; quote: string }) => {
              const original = catalog.find(item => item.id === citation.id);
              if (!original || !evidenceReadIds.has(citation.id)) throw Error(`Read Evidence ${citation.id} before citing it`);
              if (!citation.quote.trim() || !original.quote.includes(citation.quote)) throw Error(`Quote does not occur in Evidence ${citation.id}`);
              return { id: original.id, side: original.side, location: original.location, quote: citation.quote };
            });
            question = `被审查 Expert：Aligner；方向：${config.comparison.direction}；轴：${config.comparison.axis}\n\n审查方提出的待核案例\n${args.case}\n\n所引原句（仅本次选摘，不代表完整集合；未展示的内容仍待核）\n${selected!.map(item => `${item.id} · ${item.side} · ${item.location}\n${item.quote}`).join("\n\n")}\n\n开放问题\n${args.question}`;
          }
          save(questionPath, { question: args.question, ...(selected ? { case: args.case, evidence: selected } : {}) });
          const prompt = boundaryPrompt(config.materials, question);
          writeFileSync(resolve(root, "boundary-input.md"), prompt, { flag: "wx" });
          const result = await runner({ ...config.task, tools: "none", systemPrompt: config.comparison ? COMPARISON_BOUNDARY_SYSTEM : BOUNDARY_SYSTEM, prompt,
            extensionPaths: [resolve(root, "boundary-limit-extension.ts"), ...config.task.extensionPaths!],
            rawEventsPath: resolve(root, "boundary-events.jsonl") });
          if (result.stopReason !== "stop" || !result.finalText.trim()) throw Error("Boundary agent did not complete its answer");
          const answer = { answer: result.finalText, epistemicStatus: "model-interpretation-not-gold", availableSourceIds: boundaryMaterials(config.materials).map(source => source.id) };
          save(answerPath, answer);
          save(resolve(root, "boundary-result.json"), result);
          return { content: [{ type: "text", text: json({ note: "以下是边界方的解释，仍可能有误；请结合自己可见的原文核对依据和适用范围。", answer: result.finalText }) }], details: answer };
        }
        if (!existsSync(answerPath)) throw Error("Ask the boundary agent and receive its answer before finishing");
        save(reviewPath, { review: args.review, epistemicStatus: "model-review-not-gold" });
        return { content: [{ type: "text", text: json({ status: "review-saved" }) }], details: {} };
      } catch (error) {
        if (definition.name === "read_source" || definition.name === "read_evidence" || (config.comparison && definition.name === "ask_boundary" && !existsSync(questionPath))) return { content: [{ type: "text", text: json({ status: definition.name === "ask_boundary" ? "boundary-case-error" : definition.name === "read_evidence" ? "evidence-read-error" : "source-read-error", error: error instanceof Error ? error.message : String(error) }) }], isError: true, details: {} };
        if (!existsSync(failurePath)) save(failurePath, { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }});
  }
  runtime.on("session_start", () => runtime.setActiveTools(definitions.map(tool => tool.name)));
}

export async function runBoundaryCommunication(configPath: string, runner: typeof runAgentTask = runAgentTask): Promise<{ status: "review-saved"; review: string; runnerError?: string }> {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as CommunicationConfig;
  validateConfig(config);
  const root = dirname(resolve(configPath));
  if (resolve(config.outputRoot) !== root) throw Error("Communication output binding changed");
  for (const name of ["review-events.jsonl", "question.json", "review.json", "failure.json"]) if (existsSync(resolve(root, name))) throw Error("Communication run already started; no automatic replay");
  let result: AgentTaskResult | undefined;
  let runnerError: string | undefined;
  try {
    result = await runner({ ...config.task, timeoutMs: 2 * config.task.timeoutMs + 10_000, tools: config.comparison ? "boundary-comparison" : "boundary-review",
      extensionPaths: [resolve(root, "review-extension.ts"), ...config.task.extensionPaths!],
      systemPrompt: config.comparison ? COMPARISON_SYSTEM : REVIEW_SYSTEM, prompt: reviewPrompt(config), rawEventsPath: resolve(root, "review-events.jsonl") });
  } catch (error) { runnerError = error instanceof Error ? error.message : String(error); }
  if (result) save(resolve(root, "review-result.json"), result);
  if (!existsSync(resolve(root, "review.json"))) throw Error(`Review incomplete: ${runnerError ?? result?.stopReason ?? "no finish_review receipt"}`);
  const receipt = JSON.parse(readFileSync(resolve(root, "review.json"), "utf8"));
  const outcome = { status: "review-saved" as const, review: receipt.review as string, ...(runnerError ? { runnerError } : {}) };
  save(resolve(root, "outcome.json"), outcome);
  return outcome;
}
