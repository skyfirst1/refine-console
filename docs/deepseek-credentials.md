# 模型与凭据

将根目录 `.env.example` 复制为 `.env`，填写 `DEEPSEEK_API_KEY`。`npm run web` 读取该文件；直接运行其他脚本时，在进程环境中设置相同变量，或用 Node 的 `--env-file=.env` 参数加载。密钥不应进入命令参数、文档、日志、浏览器或 Git。

| 变量 | 作用 |
| --- | --- |
| `DEEPSEEK_API_KEY` | 默认 provider 凭据 |
| `DEEPSEEK_BASE_URL` | API 地址，默认 `https://api.deepseek.com` |
| `PIPELINE_API_KEY` | 通用兼容 API 凭据，优先于 DeepSeek 变量 |
| `PIPELINE_BASE_URL` | 通用 API 地址覆盖 |
| `PIPELINE_PROVIDER_ID` / `PIPELINE_MODEL_ID` | provider 和模型标识 |
| `PIPELINE_MAX_TOKENS` | 正整数输出上限，默认 8000；不是费用上限 |

当前 provider 使用 DeepSeek 兼容格式。更换服务还需验证工具 schema、reasoning 和返回格式，不保证任意兼容接口都可直接替换。代码内费率用于本地用量估算，可能与供应商实际计费不同。

Harness 和付费摘要要求明确注入费用 guard；旧实验账本与 guard 不随仓库发布，也不会因为配置了密钥就自动恢复实验。原始 HTTP trace 可能包含敏感输入，不能只依赖常见密钥脱敏就公开。

Acontext 是可选记忆服务。可连接已运行实例；本地部署模板在 `sidecar/`，默认使用镜像，不再依赖相邻源码目录。自定义追踪镜像可通过 `CORE_IMAGE` 指定。已有本地 Compose 项目名和存储路径保留兼容，不自动迁移服务或数据。Docker、远程镜像和供应商连接不属于离线测试覆盖范围。
