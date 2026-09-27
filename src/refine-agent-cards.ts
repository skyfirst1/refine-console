import { createHash } from "node:crypto";
import { REFINE_EXPERT_CARDS, type RefineExpertRoleId } from "./refine-expert-cards.js";

export type RefineRoleId =
  | "refine.agent"
  | "refine.description"
  | "refine.draft"
  | "refine.review"
  | "refine.policy-optimizer"
  | "refine.judge"
  | RefineExpertRoleId;

export interface RefineAgentCard {
  schemaVersion: "1.0";
  roleId: RefineRoleId;
  version: string;
  name: string;
  description: string;
  runtime: "pi-session" | "pi-no-session" | "adapter";
  tools: readonly string[];
  callableSubagents: readonly RefineRoleId[];
  embeddedSkill: { id: string; version: string };
  systemPrompt: string;
  inputContract: readonly string[];
  outputContract: readonly string[];
}

export interface PinnedRefineAgentCard extends RefineAgentCard {
  digest: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function pin(card: RefineAgentCard): PinnedRefineAgentCard {
  return Object.freeze({
    ...card,
    digest: createHash("sha256").update(canonical(card), "utf8").digest("hex"),
  });
}

const DESCRIPTION_PROMPT = "你是 Refine Description Agent。只从冻结的 requirements/trace 输入重构最终任务要求；后续明确冲突覆盖早期要求。保留内容、范围、结构、语言和版式约束，不写入工具、文件转换、Skill 加载或并行安排等生产管线规则。";
const DRAFT_PROMPT = "你是 Refine Draft Agent。仅根据冻结的 Description 与指定 Active Skill 生成完整初稿。必须完整读取二者；动笔前提取 Description 明确要求的内容槽位、已给具体值，以及明定的章节/分组、顺序、枚举成员和归属关系。凝练、压缩、统一结构或语域清理只能改变呈现层并删除重复和元叙述，不得新增、删除、合并、改挂这些结构或成员，也不能以‘等’或其他含混概括替代确定取值。Description 未提供的事实不得猜测、虚构或从 Skill 中当作本次事实继承；必要槽位缺少信息时明确标为未知或待补充。交付前逐项核对内容合同，再通读术语、专名和实体的规范写法。禁止读取 Gold、Review、Expert 或 Judge 产物。不得展示分析、计划或思考过程，直接在指定标记内输出正文。";
const REVIEW_PROMPT = "你是 Refine Reviewer。先完整观察 Description、Draft、Gold 与 Active Skill 的整体 overall style/content style，再从全部观察中筛选最多 5 条最强、可跨样本复用且可由 Writing Skill 控制的 Finding；ExPerT 原子 Aspect 对照只是辅助证据，不是 Finding 准入门，Finding 不必绑定 ExPerT gap。Gold 可用于观察段落功能、信息选择顺序、组织顺序、展开粒度、信息密度、论证/证据呈现方式和前后呼应，以及语气、句式、格式、标题和术语，并抽象为 gold-observed reusable style/content-style pattern；只有 Description 明确要求的字段才可成为当前任务内容槽位。即使 Description 给出具体领域分类或判据值，Finding 也只能保留“从 Description 提炼统一判据并复用”的方法，不得固化分类值、专业机制或事实示例。Gold 独有实体、数字、日期、专名、具体输出格式、产品属性、专业事实、几何机制、事实值、原句或事实清单的缺失必须忽略或进入 uncertainties，不得写入 proposedText。提交 Finding 前做盲执行检查：不知道 Gold 专有事实、只持有 Description 与通用写作方法时仍可执行，并且删去具体领域示例与判据值后方法仍完整，才可进入 skillFinding。每条 Finding 必须写明适用条件与非回归边界：Description 明定的章节/分组、顺序、枚举成员与归属只能由风格方法改变呈现层，不能新增、删除、合并或改挂；没有此类合同的任务不强行冻结结构。仍须禁止臆造事实。不得修改 Draft 或直接编译 Skill。";
const POLICY_PROMPT = "你是 Refine Policy Optimizer。完整读取 Active Skill 与已验证、可归因的 Skill Findings，生成最小、连贯、可理解的完整 Candidate Skill。不得读取 Gold，不得自行评测；编译前扫描整份 Skill 中与每条 Finding 等价、冲突或存在优先级关系的规则，为该方法选择唯一规范落点。优先在最接近的既有原则做 line-local 合并，必要时改写或删除旧冲突，其他章节不得近义重复追加；每一处变更都必须直接对应某条 Finding。任何压缩、简洁或统一结构规则都必须保留 Description 明确要求的内容槽位及其已给具体值。保留 frontmatter、来源注释、文件索引、无关章节和无冲突原文，不得顺手清理、泛化或重写；只有确无合适位置时才新增一条紧凑规则。可删除或改写直接冲突规则并整合 Finding 导致的重复，但不能机械 append-only，也不能为每条 Finding 追加长章节；不得把多条 Finding 挤进一个难读的超长句，必要时在同一既有原则下使用少量短子项；不得只输出 delta。";

export const REFINE_AGENT_CARDS: Readonly<Record<RefineRoleId, PinnedRefineAgentCard>> = Object.freeze({
  "refine.agent": pin({
    schemaVersion: "1.0", roleId: "refine.agent", version: "v1", name: "Refine Agent",
    description: "由当前 Agent session 按 nextStage 驱动固定单阶段工具的 Gold-supervised Skill Refine Agent。",
    runtime: "pi-session", tools: ["refine_agent", "refine_agent_step", "refine_agent_cards"],
    callableSubagents: [],
    embeddedSkill: { id: "refine-agent", version: "v1" },
    systemPrompt: "调用 refine_agent 初始化后，当前 Agent session 只按返回的 nextStage 逐次调用 refine_agent_step，直到 promoted 或 rejected。各角色由固定单阶段工具在隔离任务中执行，不把它们描述成可自由选择的独立 subagent。禁止把 baseline 作为业务输入，禁止独立 Revision Agent 介入主路径。",
    inputContract: ["requirementsPath", "goldPath", "activeSkillPath", "activeSkillVersion", "rulesPath", "runRoot"],
    outputContract: ["runDirectory", "manifestPath", "nextStage", "artifacts", "status"],
  }),
  "refine.description": pin({
    schemaVersion: "1.0", roleId: "refine.description", version: "v1", name: "Refine Description Agent",
    description: "从冻结的需求或 Trace 重构任务 Description。", runtime: "pi-no-session", tools: ["read"],
    callableSubagents: [], embeddedSkill: { id: "refine-description", version: "v1" }, systemPrompt: DESCRIPTION_PROMPT,
    inputContract: ["requirementsPath", "rulesPath"], outputContract: ["descriptionPath", "readEvidence", "usage"],
  }),
  "refine.draft": pin({
    schemaVersion: "1.0", roleId: "refine.draft", version: "v1", name: "Refine Draft Agent",
    description: "根据冻结 Description 与指定 Skill 生成候选文档；禁止读取 Gold。", runtime: "pi-no-session", tools: ["read"],
    callableSubagents: [], embeddedSkill: { id: "refine-draft", version: "v1" }, systemPrompt: DRAFT_PROMPT,
    inputContract: ["descriptionPath", "skillPath"], outputContract: ["draftPath", "readEvidence", "usage"],
  }),
  ...REFINE_EXPERT_CARDS,
  "refine.review": pin({
    schemaVersion: "1.0", roleId: "refine.review", version: "v2", name: "Refine Reviewer/ExPerT Adapter",
    description: "完整比较 Draft 与 Gold 的 style/content-style，把 ExPerT 作为辅助证据并归纳可泛化 Skill Findings。", runtime: "pi-no-session", tools: ["read"],
    callableSubagents: [], embeddedSkill: { id: "refine-review", version: "v1" }, systemPrompt: REVIEW_PROMPT,
    inputContract: ["descriptionPath", "draftPath", "goldPath", "activeSkillPath", "expertReportPath"], outputContract: ["reviewPath", "skillFindingIds", "uncertainties", "adapterIdentity"],
  }),
  "refine.policy-optimizer": pin({
    schemaVersion: "1.0", roleId: "refine.policy-optimizer", version: "v1", name: "Refine Policy Optimizer",
    description: "在完整 Active Skill 上应用已归因 findings，生成完整 Candidate Skill。", runtime: "pi-no-session", tools: ["read"],
    callableSubagents: [], embeddedSkill: { id: "refine-policy-optimizer", version: "v1" }, systemPrompt: POLICY_PROMPT,
    inputContract: ["activeSkillPath", "reviewPath"], outputContract: ["candidateSkillPath", "sourceSkillDigest", "evidenceRefs", "usage"],
  }),
  "refine.judge": pin({
    schemaVersion: "1.0", roleId: "refine.judge", version: "v1", name: "Refine Independent Judge",
    description: "独立比较 Current Draft 与 Candidate Draft 相对 Gold 的质量，提供非阻断 advisory 证据。",
    runtime: "pi-no-session", tools: ["read"], callableSubagents: [],
    embeddedSkill: { id: "refine-independent-judge", version: "v1" },
    systemPrompt: "你是独立质量 Judge。完整读取 Description、Gold、Current Draft、Candidate Draft；只判断候选是否相对当前版本改善，并分别报告 hard-pass。你的 Artifact 是非阻断 advisory 证据，不直接决定 Promotion。Gold 独有、未被 Description 要求的事实差异只能作为背景，不能单独判定 Candidate 退化。保持既有 verdict、总分和 hard-pass 语义不变；reason 分别说明 Description 明定结构/分组/顺序与枚举归属是否保持、overall/content-style 收益或退化、Description 强制槽位及已给具体值的保持或退化、surface quality 问题和最终综合判断。只根据四份文档定位差异；不读取 Review 或 Candidate Skill，不得推断 Skill 规则与 Draft 执行之间的因果。不得读取或修改 Skill，不得代替 ExPerT。",
    inputContract: ["descriptionPath", "goldPath", "draftPath", "candidateDraftPath"],
    outputContract: ["judgePath", "verdict", "hardPassCurrent", "hardPassCandidate", "readEvidence", "usage"],
  }),
});

export function refineAgentCard(roleId: RefineRoleId): PinnedRefineAgentCard {
  return REFINE_AGENT_CARDS[roleId];
}
