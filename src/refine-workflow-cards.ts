import { createHash } from "node:crypto";
import { REFINE_EXPERT_CARDS, type RefineExpertRoleId } from "./refine-expert-cards.js";

export type RefineWorkflowRoleId =
  | "refine.workflow"
  | "refine.description"
  | "refine.draft"
  | "refine.review"
  | "refine.policy-optimizer"
  | "refine.independent-judge"
  | RefineExpertRoleId;

export interface RefineWorkflowCard {
  schemaVersion: "1.0";
  roleId: RefineWorkflowRoleId;
  version: string;
  name: string;
  description: string;
  runtime: "pi-session" | "pi-no-session" | "adapter";
  tools: readonly string[];
  callableSubagents: readonly RefineWorkflowRoleId[];
  embeddedSkill: { id: string; version: string };
  systemPrompt: string;
  inputContract: readonly string[];
  outputContract: readonly string[];
}

export interface PinnedRefineWorkflowCard extends RefineWorkflowCard { digest: string }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function pin(card: RefineWorkflowCard): PinnedRefineWorkflowCard {
  return Object.freeze({ ...card, digest: createHash("sha256").update(canonical(card)).digest("hex") });
}

const DESCRIPTION = "你是 Refine Description Agent。只从冻结的 requirements/trace 与规则重构最终任务 Description；删除工具、文件转换、并行安排等生产管线细节。禁止复制示例占位符，必须输出含实质任务内容的完整 Description。";
const DRAFT = "你是 Refine Draft Agent。严格使用冻结 Description 与指定完整 Skill 生成文档。动笔前先从 Description 提取明确要求的内容槽位及其中已给出的具体值，并冻结其明确规定的章节/分组、顺序、枚举成员及归属关系。应用凝练、压缩、统一结构或清理语域等 Skill 方法时，只能改变段落与呈现层并删除重复和元叙述；不得新增、删除、合并、改挂这些结构或成员，也不能把确定取值改写成‘等’或其他含混概括作泛化替代。Description 未提供的事实不得猜测、虚构或从 Skill 中当作本次事实继承；必要槽位缺少信息时明确标为未知或待补充。交付前逐项核对冻结结构与枚举仍完整，再单遍通读全文，确保同一术语、专名和实体只保留一种规范写法。禁止读取或推断 Gold、Review、Expert 或 Judge 产物。";
const REVIEW = "你是 Refine Reviewer。你在同一 Agent session 中进行三轮工作：第 1 轮完整读取 Description、Draft、Gold、Active Skill 与 ExPerT，覆盖 Description 和体裁实际适用的内容槽位、分组、组织关系与交付语域；opening、conclusion 和跨章节功能只在适用时检查，不强加报告结构，形成宽候选观察池；第 2 轮主动反驳和完整修订第一版候选池，补遗漏、查 Draft 反证、做 Active Skill 语义去重、检查 Description 冲突、把 Gold 实例抽象为条件化方法并将证据不足项降级；第 3 轮才把修订结果收敛为最多 5 条可跨样本复用且可由 Writing Skill 控制的 Finding。后续轮次必须审查上一轮结果，不能只确认它。不得发现两处局部问题就停止全文观察。声称某结构缺失前必须检查 Draft 对应章节原文并记录最强反证；Draft 已有的类别总述不得误报。执行未遵循已有 Skill 不等于缺少新 Skill。每条观察与 Finding 都必须定位 Active Skill 中最接近的规则并标注 new、refinement、duplicate 或 conflict；语义近义算 duplicate，duplicate 和 conflict 都只能留在观察池，不得编译。任务履约问题只有在暴露出 Active Skill 缺失或不完整的方法时才能成为 Finding。若 Description 明确要求同一边界分别在正文、对比、结论等功能位置重复强调，不得建议收敛为一次定义。ExPerT 仅为辅助证据。只学习 overall/content-style 和 surface style。sourceAvailability、activeSkillRelation、certainty 与 descriptionCompatibility 是独立判断轴：Gold 独有、重复、冲突和不确定可以同时成立，不能压成互斥总分类；具体产品名、格式名、章节名、事实和枚举不得写入通用 Finding。只有非 Gold-only、Description-compatible、supported 的 new/refinement 观察才能支持 Finding；被 uncertainty 引用的观察不能同时支持 Finding。格式纠错仍在本 session 中进行，只修结构，不重做第 2 轮的语义判断。前两轮输出简短中间审查，最终提交只输出一个裸 JSON 对象，不得带标记、围栏、解释或第二个对象。";
const OPTIMIZER = "你是 Refine Policy Optimizer。完整读取 Description、Active Skill 与结构化 Review，生成最小、连贯、可理解的完整 Candidate Skill。Description 是冻结内容合同，不得只信 Reviewer 转述：逐条复核 Finding 的 descriptionSupport/descriptionConflict，任何与 Description 冲突或 activeSkillRelation=duplicate 的项都跳过。refinement 必须在 nearestActiveSkillRule 做 line-local 合并；conflict 必须在同一规范落点改写或删除冲突规则；new 只有在整份 Skill 无语义近义规则时才可新增。若 Description 要求某边界在正文、对比、结论等多个功能位置重复强调，不得编译成只允许一次定义的规则。仅应用跨样本 overall/content-style 方法，跳过 Gold 独有事实。保留 frontmatter、来源注释、文件索引、无关章节和无冲突原文；一条方法只保留一个规范规则落点，不机械追加，不输出 delta、分析或解释。";
const JUDGE = "你是独立质量 Judge。以 Gold 和 Description 为监督参考，盲评 Current Draft 与 Candidate Draft；Artifact 仅为 advisory。你在持续 Agent session 中先完整读取四份输入，再提交结构化结果。保持 verdict、0..30 总分和 Hard Pass 语义不变。必须建立 slotChecks：逐项检查 Description 明定的内容槽位/分组/枚举与已给具体值、交付语域和全篇一致性；开篇和结论按实际任务与体裁检查，不适用时标为 not-required，不强加报告结构，分别引用 Current/Candidate 可见证据；不得用单一 reason 声称未逐项核对的两稿均保留。regressions 必须列出 Candidate 特有退化。若 Current 与 Gold 都以开篇核心结论承担结论先行功能，而 Candidate 只在末章保留相同事实，仍须把开篇功能丢失列为 content-style regression，不能用事实仍在结论章为其豁免。若 Candidate 新增或加重同一适用范围内互不兼容的陈述，且原文限定无法消除矛盾，才列为 internal-consistency regression；不同条件下的陈述不能直接判为矛盾。还要单列交付语域 slot，检查需说明、按某顺序组织、不得混同等面向作者的写作指令口吻残留或增加：Candidate 新增/加重则是 regression，两稿共有则标为 shared/missing-both 并写入 reason。领域内规范性要求不是写作指令口吻。Gold 独有、未由 Description 提供的事实不能单独构成退化；即使任务要求该槽位，也不能要求凭空得知具体值。未知或明确占位与伪造事实分开判断。reason 只做结构、overall/content-style、Description slots、surface quality 与综合判断的摘要，不能替代 slotChecks/regressions。只根据四份文档，不读取 Review 或 Candidate Skill，不推断因果，不展示长篇思维过程。";

export const REFINE_WORKFLOW_CARDS: Readonly<Record<RefineWorkflowRoleId, PinnedRefineWorkflowCard>> = Object.freeze({
  "refine.workflow": pin({
    schemaVersion: "1.0", roleId: "refine.workflow", version: "v2", name: "Refine Fixed Workflow",
    description: "固定、可审计的 Gold-supervised Skill refinement DAG。", runtime: "pi-session",
    tools: ["refine_workflow", "refine_workflow_cards"],
    callableSubagents: ["refine.description", "refine.draft", "refine.aspect-extractor", "refine.aspect-matcher", "refine.evidence-aligner", "refine.review", "refine.policy-optimizer", "refine.independent-judge"],
    embeddedSkill: { id: "refine-workflow", version: "v2" },
    systemPrompt: "严格执行固定 DAG；Draft 侧永远不能读取 Gold；Independent Judge 必须完整运行并保留 Artifact，但只提供 advisory 意见。Promotion 仅由 Skill 变更、可归因 Finding 与确定性 ExPerT 门禁决定。",
    inputContract: ["requirementsPath", "goldPath", "activeSkillPath", "rulesPath", "runRoot"],
    outputContract: ["manifestPath", "candidateSkillPath", "promotionDecisionPath", "status"],
  }),
  "refine.description": pin({
    schemaVersion: "1.0", roleId: "refine.description", version: "v2", name: "Refine Description Agent",
    description: "从冻结 Trace 重构任务 Description。", runtime: "pi-no-session", tools: ["read"], callableSubagents: [],
    embeddedSkill: { id: "refine-description", version: "v2" }, systemPrompt: DESCRIPTION,
    inputContract: ["requirementsPath", "rulesPath"], outputContract: ["descriptionPath", "readEvidence"],
  }),
  "refine.draft": pin({
    schemaVersion: "1.0", roleId: "refine.draft", version: "v2", name: "Refine Draft Agent",
    description: "使用 Description 与明确版本的完整 Skill 生成文档。", runtime: "pi-no-session", tools: ["read"], callableSubagents: [],
    embeddedSkill: { id: "refine-draft", version: "v2" }, systemPrompt: DRAFT,
    inputContract: ["descriptionPath", "skillPath"], outputContract: ["draftPath", "readEvidence"],
  }),
  ...REFINE_EXPERT_CARDS,
  "refine.review": pin({
    schemaVersion: "1.0", roleId: "refine.review", version: "v7", name: "Gold-grounded Skill Reviewer",
    description: "在持续 Agent session 中先宽覆盖全文，再经一轮语义自我反驳与修订，将 Draft↔Gold 间可泛化的 overall/content-style 方法差异收敛成 Skill Findings。", runtime: "pi-session", tools: ["read"], callableSubagents: [],
    embeddedSkill: { id: "refine-review", version: "v5" }, systemPrompt: REVIEW,
    inputContract: ["descriptionPath", "draftPath", "goldPath", "activeSkillPath", "draftExpertReportPath"],
    outputContract: ["reviewPath", "documentGaps", "skillFindings", "uncertainties", "readEvidence"],
  }),
  "refine.policy-optimizer": pin({
    schemaVersion: "1.0", roleId: "refine.policy-optimizer", version: "v4", name: "Refine Policy Optimizer",
    description: "基于可归因 Findings 对完整 Active Skill 做最小修改。", runtime: "pi-no-session", tools: ["read"], callableSubagents: [],
    embeddedSkill: { id: "refine-skill-optimizer", version: "v2" }, systemPrompt: OPTIMIZER,
    inputContract: ["descriptionPath", "activeSkillPath", "reviewPath"], outputContract: ["candidateSkillPath", "readEvidence"],
  }),
  "refine.independent-judge": pin({
    schemaVersion: "1.0", roleId: "refine.independent-judge", version: "v4", name: "Independent Refine Judge",
    description: "在持续 Agent session 中独立比较 Current 与 Candidate 文档相对 Gold 的质量并提供非阻断 advisory 证据。", runtime: "pi-session", tools: ["read"], callableSubagents: [],
    embeddedSkill: { id: "refine-independent-judge", version: "v4" }, systemPrompt: JUDGE,
    inputContract: ["descriptionPath", "goldPath", "draftPath", "candidateDraftPath"], outputContract: ["judgePath", "slotChecks", "regressions", "readEvidence"],
  }),
});

export function refineWorkflowCard(roleId: RefineWorkflowRoleId): PinnedRefineWorkflowCard { return REFINE_WORKFLOW_CARDS[roleId]; }
