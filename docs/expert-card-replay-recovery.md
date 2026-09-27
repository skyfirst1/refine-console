# Expert Card Replay 恢复

本页保留回放恢复接口的演进说明，不是当前实验的续跑指令。实际 checkpoint、预算和授权状态由本地运行目录提供，不随仓库发布；不能用旧导入覆盖新状态。当前用户入口见 [用户参与工作流](human-workflows.md)。

新实验共用 `expert-card-copy-store.ts` 和 `expert-card-replay-runtime.ts`。实际 Pi 入口为 `runCardReplaySession → runPiTask`，工具注册共用 `registerCardReplayTools`。旧 validation 下的 copy-store、extension 和 CLI adapter 保留为历史证据，不再作为续跑入口。

## 分离修改阶段的精简接口

`prepareSeparatedModificationStage` 新生成的配置默认采用 `runtime.modificationToolContract="compact-v1"`，通过同一 `--run` 入口执行。现有配置省略该字段时保留原接口；新准备器也可用显式 `"legacy"` 生成旧接口配置。不要给已付费 prefix 更换接口后重发。

模型先用 `expert_evidence` 读取 inventory 和注册材料，再使用以下工具：

| 工具 | 输入 | 结果 |
| --- | --- | --- |
| `expert_card_read` | `{}` | 唯一父 Card 的 `systemPrompt`、`skill` 和完整案例 |
| `expert_card_update` | `reason`，以及修改的 `systemPrompt`、`cardSkill` 或 `fewShotCases` | 保存不可变副本，返回待审状态并暂停 |
| `expert_card_no_change` | `reason` | 保存原样理由，返回已记录状态并暂停 |

`cardSkill` 是 Card 辅助文字，写入原存储字段 `skill`；任务边界 Skill 仍由注册材料提供。省略内容继承，空 `cardSkill` 或空案例数组清除对应内容。运行时绑定角色、父版、诊断回执、准备时状态及完整提交标志；额外字段、过期绑定、账务未清或越权更新均拒绝。

案例保留合成任务要求、content/style、双侧完整正文、模型标签、双方逐项引句解释、边界依据和适用范围。模型填写 `sourceText`、`targetText` 与 `evidenceRationale` 中的 `side/quotedText/explanation`；适配器只补固定标识、位置和索引，并逐字校验同侧引用。适配器不生成案例语义或标签。历史案例按原结构返回和存储。

新版读取不返回父 Card 的旧 `reason`、摘要或历史元数据；原记录完整保留。读取顺序仍由模型决定，本改动不实现跨 agent 通信或“先固定边界再开放 Card”。工具成功不证明判断正确。

本地验证：在仓库运行 `node --import tsx --test test/expert-card-compact-tools.test.ts test/expert-card-separated-stages.test.ts test/expert-card-provider-schema.test.ts`，再运行 `npm run typecheck`。测试使用 SDK 本地拦截或本机模拟服务，不调用远程模型。

## 当前 checkpoint

运行 `node --import tsx scripts/prepare-card-replay-recovery.ts <archive-root> <new-output-root>` 只做离线准备。输入与输出目录必须显式提供。它核对旧副本、实际请求、发送编号、结算记录与解析结果，将状态写入新目录，不改旧状态和账本。重复准备只允许导入状态完全相同；已续跑的状态不能被旧快照覆盖。

历史迁移的 `recovery-config.json` 默认禁止付费，`offline-proof.json` 记录旧样本的绑定与账本哈希。它们是本地运行产物，不是仓库预设，也不构成新的执行授权。

后续获授权时，唯一入口为 `scripts/prepare-card-replay-recovery.ts --run <recovery-config.json>`。调用前显式启用配置的 `allowPaidProvider` 并按原方式配置 provider 凭据；本修复不加载或输出凭据。新入口使用共享 extension 和原预算 guard，保留原 cap、费率与预留算法。更换工具 schema 可能仍使保守预留不足，不能绕过 guard。

## Harness 评价 Skill

准备命令可以在 validation 根目录、输出目录之后传入 Harness Skill 文件路径：

```powershell
node --import tsx scripts/prepare-card-replay-recovery.ts /path/to/archive /path/to/new-output /path/to/operating-skill.md
```

准备器将正文追加到 system，并同步恢复前缀的 system；原 user、已付费观察及工具配置保持不变。文件加入来源绑定，运行前校验。省略路径时保持原行为。该 Skill 指导 Harness 如何核实观察、应用边界和解释处置，不替换任务边界 Skill 或 Expert Card。真实请求仍须核对注入内容，不能仅凭文档或本地文件判断模型已收到。

这次恢复仅允许读取现有 Card 和证据、完成最终评价，不允许新样本或候选。新实验需另行配置授权额度及带独立结算凭据的执行回调；不复用本次只读配置中的拒绝回调。

新获授权的写入实验仍走同一入口：配置 `runtime.readOnly=false` 及 `expertExecution`，共享 extension 使用 `expert-card-paid-executor.ts` 运行绑定的局部 Aligner。基线的实际 options/request 必须登记为来源；每个新请求仅允许 Card 部分变化，发送前校验完整 payload，结算与解析分别记账。解析失败保留原文并计一次 attempt，批次继续尚未执行身份。没有执行器配置时写模式拒绝启动。

可为当前会话显式登记 `defaultCardVersion`；只在 read 缺版本时使用并返回实际版本，不能替 update 选择父版。artifact 默认项必须是注册资源，可以登记含 Card、全部样本及子资源清单的完整版本 bundle；不得将版本 ID 猜作某个样本或任意路径。工程失败后保留原调用及错误，以真实参数离线重放证明修复，再从已付费消息前缀继续，不重复原 user 或已执行样本。

## 状态与工具

- `not-sent`、`pre-send-blocked`：有明确未发送证明后可使用同一身份继续。
- `running`、`unknown`：停止新请求，先核对实际发送和账务；不能当成失败后自动重试。
- `settled-success`、`settled-parse-failure`：终结 attempt；缓存读取不计新样本。解析失败不计成功，但不阻断同批尚未执行的样本或下一版更新。

`parentVersion` 表示已有父版本。旧 `version` 别名仍接受，两者冲突则拒绝。update 省略字段继承；显式空 `skill` 清除。版本单调分配，额度由 inventory 返回，不写死在 schema。相同更新和样本幂等。

freeze 只绑定一个 selection ID 与不可变版本；旧确认身份永不改名，新分支使用新 selection ID。冻结不禁止其他获准分支。artifact 从注册表读取；省略文件名仅使用该 run 明确登记的默认文件；session 省略 ID 仅使用明确默认 session。歧义或未知 ID 拒绝，不猜路径。

任何工程拒绝会写入该 session 的持久 stop，在下一 provider 请求前中止，包括 schema 校验失败。stop 不向模型开放清除工具。恢复使用新 session 和已付费 provider 消息前缀，原 user 只有一次；既有工具结果直接恢复，不重新执行。

generation-only 的完成凭证不是模型最终文本。只有本次产生一个有效候选、写入与授权及 `readyForTrial` 一致的 submission，并留下版本、Card digest、few-shot digest 全部匹配的 `candidate-review-pause.json`，入口才返回 `candidate-saved-awaiting-review`。没有有效 update 的正常 final 返回 `generation-incomplete`；两种终态都写入统一 `resumed-result.json`，且 `automaticRetry=false`。计划内暂停不是工程失败，候选仍须独立人工审阅，凭证不证明案例或标签质量。

store 用跨实例目录锁与原子状态替换。进程崩溃留下锁时应先人工核查在途请求，再清理失效锁；不能因锁“旧了”就自动重跑。历史迁移的解析失败需要独立 parser 证明和精确结算记录；缺任一项保持 unknown。

## 离线验证

`node --import tsx --test test/expert-card-copy-store.test.ts test/expert-card-replay-runtime.test.ts test/expert-card-recovery-entry.test.ts test/pi-task-isolation.test.ts test/pi-budget-session-resume.test.ts`

测试包含实际 Pi CLI 连接本地 loopback fake provider：副本修改、成功及解析失败、冻结后分支、artifact 默认读取、长输入恢复、工程错误后阻断下一请求。fake 回调和真实远程模型严格分开；没有新 Judge、业务边界规则或生产 Card 修改。
