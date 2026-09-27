# 历史视图

`/#history` 展示已导入的真实产物；`/#experts` 管理新任务。历史记录不冒充新执行，局部 true / false 不是正确率，候选回放也不是完整重评。

## 启动与导入

```sh
npm run expert-demo -- --registry /path/to/registry.json --port 4318
```

服务只监听本机。新克隆不包含原始实验、用户文稿或本地注册表；README 的 GIF 是独立展示资源。

已有相容产物可以离线导入：

```sh
npm run import-expert-demo -- --batch /path/to/review-batch --replays /path/to/candidate-replays --evaluation /path/to/evaluation/result.json --out /path/to/new-registry
```

导入器核查 Card 身份和评分来源，不调用模型。可选 `--refine-history /path/to/refine-run` 注册独立 Refine 历史；需要 `REPORT.md`、`run-result.json`，并可提供 `run-summary.json`。这不是任意 trace 格式的通用导入器。

`scripts/import-refine-demo-stages.mjs --registry <文件> --history <目录>` 可在已绑定历史上补齐九阶段原件。它验证来源哈希并备份注册表，不把两个实验拼成一次新闭环。

## 展示内容

- Refine：任务要求、原稿、原评价、问题归因、候选 Skill、新稿、新评价、独立对照和采用决定。
- Expert / Harness：任务材料、原评价、六例判断、审查、边界问答、候选 Card 和回放对照。
- Card：增量约束、规范正文、版本绑定反馈、bad case 输入与示范输出。候选未验收时保留提示。

原评价的 recall / precision / F1 来自已注册原件。没有完整新评价时不补造分数。所有详情只能读取登记且哈希一致的文件。

## 可选摘要

`--summary-cache <目录>` 只读取缓存；不提供摘要配置时禁用调用。

`--summary-module <本地模块路径>` 加载可信模块的默认导出。模块通过 `createSummaryRunner` 显式提供 provider、预算 guard 和缓存配置；不要加载不可信模块。进入 Expert 判断或候选回放详情时，未缓存的选中案例可自动产生付费摘要，总览和其他节点不触发。

摘要只接收公开 result / rationale，压缩转述各次理由；不接收原 Evidence、Card 或任务全文，不核实事实，不新增判断。缓存绑定来源哈希、模型与提示版本；失败、中断和预算拒绝不自动重试。摘要费用上限由注入的 guard 决定，不存在适用于所有安装的统一额度。

## 反馈与接口

Skill 反馈绑定可见正文哈希和 Card 版本。保存反馈不会自动学习或改写 Card。真实任务的边界补充和审查问答见 [用户参与工作流](human-workflows.md)。

- `GET /api/expert-demo`：评价、Card、判断和 Skill。
- `GET /api/expert-demo/cases`：固定案例、来源和摘要状态。
- `POST /api/expert-demo/cases/:caseId/summary`：缓存或受限摘要。
- `GET /api/expert-demo/artifacts/:id`：只读已注册原件。
- `GET/POST /api/expert-demo/skill-feedback`：版本绑定反馈。

新 Refine 完成后的部分评价登记只在当前进程有效；重启后历史入口由启动时的注册表恢复。任务本身的轮次和产物另行持久化。
