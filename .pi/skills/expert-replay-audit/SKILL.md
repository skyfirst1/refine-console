---
name: expert-replay-audit
description: Inspect frozen Expert observations and bounded real replays using task boundaries and attributable evidence; preserve original outputs and separate proposed alternatives.
---

# Expert Replay：依据与判断

只审当前冻结任务与真实调用。显式用户边界上位，Description 提供任务情境；生成的边界解释可错，不能覆盖明确要求。历史材料说明当时发生什么，不自动成为本次指令。

## 阶段和当前输入

Matcher 的 matched 表示在完整给定候选池中找到概念可比的对象，不表示 content 或 style 已通过。当前 Matcher 输入是 direction、source 和完整 targets 的 id/title/description。它不接收 Evidence 或上游理由。Recall 从 Gold 到文稿，precision 反向；不同 source 可以选择同一 target，不是全局一对一匹配。局部问题成立不需要先证明唯一最佳替代目标。

Aligner 的 matched 表示选定 pair 在当前 mode 与任务边界下是否对齐。content/style 分轴调用，不能把同名字段理解为 Matcher 的概念可比。当前 Aligner 接收两侧 Aspect 与相关 Evidence、mode/direction，以及调用明确提供的任务合同或原文窗口；不假定存在未送达材料。历史 matchRationale 是上游观察，不属于当前 Aligner 输入，也不是判断前提。两类判断均来自 LLM，都不是金标。Reducer 只依已输出布尔作确定性汇总，不产生新语义判断。

## 证据与公开解释

Evidence 是需要核对原文与归属的可定位引文；location 只指局部位置，不证明全文结构。title/description 是上游抽取的表示，也可能误读或漏项，不能盖过实际引文或自动证明事实授权。Gold 是比较对象，不自动是真实来源。可选 citation 只是待核对引用，需检查它来自哪一侧、是否确实出现、支持哪一主张。

rationale 是公开解释，可能幻觉、误归、遗漏或事后解释；它不等于内部推理过程、实际执行规则或评分真值。不要从解释文字反推模型内部机制已获证明。也不要因多次输出相同就当作正确，或因不一致就断言存在真实边界歧义。

## 如何审查与提出替代

结合当前 mode/边界与两侧实际证据，区分具体无支持的说法、相互矛盾、来源误归、理由不足以支撑结论、结论本身被否、以及合理确认。只有可观察支持才提出发现；没有发现是有效结果，不要求每次找错。

原理由不可靠时，可以暂时搁置它，独立从两侧 Evidence 和任务边界形成替代理由。只有证据足够才建议保留或改变 matched；理由错不自动翻转布尔，也不让布尔迁就理由。证据或边界不足时，说明具体未决判断；其他已获支持的窄发现仍可保留，不能补造证据或全面弃判。

原始输出保持原样。替代理由与建议布尔另列为本次审查的候选，不覆盖旧理由，不冒充模型原输出或金标。机制解释明确标为假说。具体 Card/Expert 操作 Skill 修改须有真实目标与方法、预期收益、风险和验证；无依据时留空，不自动应用，不修改评分公式。

## 有界 Replay

使用真实 expert_replay 工具按需生成；相同 runId 的缓存返回不算新观察。输入、Card、Skill、model 与配置固定，历史异常不复现也如实记录，不能改样本追答案。新结果只能说明各次公开行为，频率不代表真值。遵守调用上限并保留失败或中断，不追加格式重采样、Judge 或审查链。
