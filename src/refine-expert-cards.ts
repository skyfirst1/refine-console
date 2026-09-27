import { createHash } from "node:crypto";

export type RefineExpertRoleId =
  | "refine.aspect-extractor"
  | "refine.aspect-matcher"
  | "refine.evidence-aligner";

export interface RefineExpertCard {
  schemaVersion: "1.0";
  roleId: RefineExpertRoleId;
  version: "v1";
  name: string;
  description: string;
  runtime: "pi-session";
  tools: readonly ["read"];
  callableSubagents: readonly [];
  embeddedSkill: { id: string; version: "v1" };
  systemPrompt: string;
  inputContract: readonly string[];
  outputContract: readonly string[];
}

export interface PinnedRefineExpertCard extends RefineExpertCard { digest: string }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function pin(card: RefineExpertCard): PinnedRefineExpertCard {
  return Object.freeze({ ...card, digest: createHash("sha256").update(canonical(card)).digest("hex") });
}

const EXTRACTOR_PROMPT = [
  "你是 Refine Aspect Extractor。完整读取一份 Description 与一份 source document，使用同一拆解标准提取 source document 表达的完整原子 Aspect。Description 只提供任务语境，绝不是 Evidence 来源。",
  "每个 Aspect 只表达一个可独立核验的事实、立场、约束、细节或写作特征，并提供至少一条可在 source document 定位的短 Evidence。Evidence quote 必须逐字来自 source document；不得引用、改写或拼接 Description 文本冒充 source document Evidence，也不得把标点写成正则或 Markdown 转义形式（例如不得在句点、连字符前新增反斜杠）。",
  "aspects 数组的每个元素都必须是对象，且只含 id、title、description、evidences；evidences 每项只含 quote、location。所有字符串和 evidences 都必须非空。",
  "长文档使用 8 到 12 个高覆盖 Aspect；严格不得超过 12 个。内容更多时按同一主题合并相邻细项，但每项仍须可独立核验。title 不超过 30 字，description 不超过 120 字，每项提供一条或多条相关原句作为 Evidence，保留必要上下文而非复制全文。不得用空对象、占位符或畸形字段凑数。",
  "不得比较其他文档，不得评分，不得输出建议或思维过程。先在内部完成全部 Aspect 的构造与校验，不得流式输出未完成的草稿对象；最终只输出唯一一组指定标记和其中唯一一个完整合法 JSON 对象，结束标记后不得继续解释或修订。",
].join("");

const MATCHER_PROMPT = [
  "你是 Refine Directional Aspect Matcher。完整读取一个 source Aspect 与完整 target Aspect 列表。",
  "direction 由输入文件给出；只选择语义上最匹配的一个 target，或明确返回 none。不得评分、不得判断整篇文档、不得输出思维过程。",
  "最终 JSON 必须包含 direction、sourceAspectId、targetAspectId、matched、rationale 五个字段，可选 evidence_citation；direction 与 sourceAspectId 必须逐字复制 source 输入，targetAspectId 必须是 target 列表中的 id 或 null，matched 必须等于 targetAspectId 是否非 null。不得省略 identity 字段；除可选 evidence_citation 外，不得增加 score 或其他字段。",
  "rationale 按证据需要说明理由，无固定字数上限；引用中的双引号必须合法 JSON 转义。可选 evidence_citation 为非空字符串或非空字符串数组，独立记录证据引用，不要求提供。只输出指定标记中的唯一 JSON 对象。",
].join("");

const ALIGNER_PROMPT = [
  "你是 Refine Evidence Alignment Agent。完整读取一个已匹配的 Aspect Pair 与 mode。",
  "mode=content 时只判断事实、立场、约束和细节是否对齐；mode=style 时只判断段落功能、组织顺序、展开粒度、信息密度、边界措辞、语气、句式与格式是否对齐。",
  "mode=style 不得用事实是否相同、事实是否覆盖或实体是否出现替代风格判断；即使事实不同，只要上述表达方法一致，style 仍可匹配。",
  "只读取系统消息指定的输入文件；完成该读取后不得调用占位路径或任何其他路径，立即输出结果。最终 JSON 必须包含 matched、rationale，可选 evidence_citation；matched 为布尔判断，rationale 按证据需要说明理由，无固定字数上限；双引号必须合法 JSON 转义。evidence_citation 可为非空字符串或非空字符串数组，不要求提供。不得增加 score、mode、Aspect id 或其他字段；不得评分、不得输出自由推理过程。只输出指定标记中的 JSON。",
].join("");

export const REFINE_EXPERT_CARDS: Readonly<Record<RefineExpertRoleId, PinnedRefineExpertCard>> = Object.freeze({
  "refine.aspect-extractor": pin({
    schemaVersion: "1.0", roleId: "refine.aspect-extractor", version: "v1", name: "Refine Aspect Extractor",
    description: "以同一标准从 Gold、Current 或 Candidate 文档中提取带 Evidence 的原子 Aspect。",
    runtime: "pi-session", tools: ["read"], callableSubagents: [], embeddedSkill: { id: "refine-aspect-extractor", version: "v1" },
    systemPrompt: EXTRACTOR_PROMPT,
    inputContract: ["descriptionPath", "sourceDocumentPath"], outputContract: ["aspectSetPath", "readEvidence"],
  }),
  "refine.aspect-matcher": pin({
    schemaVersion: "1.0", roleId: "refine.aspect-matcher", version: "v1", name: "Refine Directional Aspect Matcher",
    description: "让每个 source Aspect 在完整 target Aspect 列表中选择至多一个最佳匹配。",
    runtime: "pi-session", tools: ["read"], callableSubagents: [], embeddedSkill: { id: "refine-aspect-matcher", version: "v1" },
    systemPrompt: MATCHER_PROMPT,
    inputContract: ["sourceAspectPath", "targetAspectSetPath"], outputContract: ["aspectMatchPath", "readEvidence"],
  }),
  "refine.evidence-aligner": pin({
    schemaVersion: "1.0", roleId: "refine.evidence-aligner", version: "v1", name: "Refine Evidence Alignment Agent",
    description: "以 content/style 模式分别核验已匹配 Aspect Pair 的 Evidence 对齐情况。",
    runtime: "pi-session", tools: ["read"], callableSubagents: [], embeddedSkill: { id: "refine-evidence-aligner", version: "v1" },
    systemPrompt: ALIGNER_PROMPT,
    inputContract: ["aspectPairPath"], outputContract: ["evidenceAlignmentPath", "readEvidence"],
  }),
});

export function refineExpertCard(roleId: RefineExpertRoleId): PinnedRefineExpertCard { return REFINE_EXPERT_CARDS[roleId]; }
