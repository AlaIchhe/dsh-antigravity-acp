# 配置与环境变量（v1.0）

[返回主页](../README.md) · [使用与排障](reference.md) · [开发与验证](development.md)

以下对应 **1.0.0**，以 [`src/settings.ts`](../src/settings.ts) 的 `Config` 为唯一来源。字段位于 `llm-antigravity-acp` 插件配置根级。设置页仅编辑 `hiddenModels`（模型显示开关），其余高级字段在配置文件中维护。

## 配置清单

| 字段 | 默认值 | 可热更新 | 作用与限制 |
|---|---|---|---|
| `hiddenModels` | `[]` | 是 | 不出现在 DSH 模型选择器中的模型 ID 列表；隐藏不影响进行中的会话。 |
| `agentMode` | 未设置 | 是 | 会话模式（agent 声明的 mode id，如 `plan` / `auto`）；留空沿用默认，仅作用于新建或恢复的会话。 |
| `agyCliPath` | 未设置 | 是 | 官方 `agy` CLI 路径；留空依次查 `AGY_CLI_BIN`、PATH 与平台默认目录。 |
| `proxyUrl` | 未设置 | 是 | 显式出网代理（如 `http://127.0.0.1:7890`）；留空继承宿主代理，宿主未配置时直连。支持 HTTP/HTTPS、SOCKS5/SOCKS5H，始终自动绕过 `localhost`/`127.0.0.1`/`::1`。 |
| `resumeSessions` | `true` | 是 | 跨进程通过 `session/resume` 接回原 ACP 会话；映射存于 `$DSH_HOME/cache/antigravity-acp/sessions.json`（格式 v3）。 |
| `cancelGraceMs` | `30000` | 是 | 用户取消后等待 agent 确认停止的上限（毫秒）；`0` 表示立即回收进程。 |
| `idleRecycleMs` | `900000` | 是 | 空闲共享 ACP 进程保留时长（毫秒，默认 15 分钟）；超时回收，下次按 `session/resume` 接回。`0` 表示不回收。 |
| `cliQuotaEnabled` | `false` | 是 | 是否允许额度取数调用本机 `agy` CLI。关闭时套餐额度走 Cloud Code Assist HTTP，不查 AI Credits；开启后仅运行 `agy -p /usage` 与 `/credits`，未找到 CLI 时直接报错（不回落 HTTP）。 |
| `binaryPath` | 未设置 | 否 | 官方 ACP server 可执行文件路径，优先级高于 `AGY_ACP_BIN` 与缓存目录；找不到直接报错（不自动下载）。 |
| `extraArgs` | `[]` | 否 | 传给 ACP server 的额外命令行参数。 |
| `acpVersion` | `"1.4.0"` | 否 | 缓存目录与目录缓存匹配的目标版本。 |
| `requestTimeoutMs` | `30000` | 否 | 普通 ACP 请求超时（毫秒）。 |
| `handshakeTimeoutMs` | `120000` | 否 | `initialize` 握手等待上限（毫秒）。 |
| `authTimeoutMs` | `300000` | 否 | `authenticate` 等待上限（毫秒）。 |
| `promptTimeoutMs` | `1800000` | 否 | `session/prompt` 无活动超时上限（毫秒）；每次收到 `session/update`、权限询问或工具往返时自动续期，等待宿主执行工具期间暂停计时，避免长任务多步工具循环被误掐断。 |
| `bridgeParkSettleMs` | `50` | 否 | 并发 MCP `tools/call` 聚合窗口（毫秒）。 |

## 环境变量

| 变量 | 用途 |
|---|---|
| `AGY_ACP_BIN` | 官方 ACP 可执行文件覆盖，优先级低于 `binaryPath`。 |
| `AGY_ACP_HOME` | 官方可执行文件安装根目录覆盖（避开 Windows Low 完整性目录）。 |
| `AGY_CLI_BIN` | 官方 CLI 路径覆盖，低于 `agyCliPath`。 |
| `AGY_ACP_ACCOUNTS_DIR` | 多账号根目录覆盖（默认 `~/.antigravity-acp-accounts`）。 |
| `AGY_OAUTH_CLIENT_ID` / `AGY_OAUTH_CLIENT_SECRET` | OAuth client 元数据覆盖；未设置时使用 `@cortexkit/antigravity-auth-core`。 |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`（含小写） | `proxyUrl` 留空时继承的宿主代理环境。 |
| `DSH_HOME` | 数据缓存目录（`catalog.json`、`sessions.json`）所在宿主目录。 |
