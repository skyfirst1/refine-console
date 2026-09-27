# Replay 完整任务 Skill 接入

`src/expert-replay-session.ts` 将操作说明与任务评判 Skill 分开加载。`expertReplayInputFromArchive` 仍只选择已知字段，不把归档中的 `criteria.skill` 自动提升为当前指令。

调用者可在适配后设置 `operatingInstruction: {path, sha256}`，以及 `taskEvaluationSkill: {path, sha256, descriptionSha256}`。构造器核验文件全文 SHA 和实际 Description SHA，失败则在模型调用前退出。任务 Skill 原文完整附加到真实 system；当前用户边界优先，任务 Skill 解释评判标准，本轮调查目标决定 Replay 职责。

`taskSkillPlacement` 默认为 `after-operation`。显式 `before-operation` 只改变两块顺序，不重复全文。真实 system、prompt 及选择均进入返回绑定。未提供这些可选字段时保留原入口行为。外部运行适配器不得再用短 system 覆盖构造器结果。

只读冻结观察使用 `registerExpertObservationTool`，无参数读取绑定的两份记录及原 producer。它与生成新回放的 `registerExpertReplayTool` 是不同能力；只读结果标记 `cached-existing`，不能计为新 Expert 生成。

验证覆盖全文送达、内容与 Description 漂移拒绝、顺序切换不重复制文、默认旧路、工具白名单、缓存重放身份与失败保留。真实试验的请求与提案评估保留在本地实验归档，不随仓库发布；接入通过不证明生成 Skill 或 Replay 提案正确。
