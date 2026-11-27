# 使用与技术参考（v1.0）

[返回主页](../README.md) · [配置](configuration.md) · [更新记录](changelog.md) · [开发与验证](development.md)

本文对应 `dsh-bundle-antigravity-acp` **1.1.0**。

## 核心架构（方案 A）

1. **按账号共享常驻 ACP 进程（`AcpRuntimeManager`）**：同一 `(accountId, revision)` 下所有并发对话共享一条官方 ACP stdio 进程；切换账号或重新登录后自动回收旧进程并以新账号 HOME 启动。单条会话异常时若共享链路上仍有其它活跃并发对话，仅关闭故障会话而不误杀整个常驻进程。
2. **多作用域并发 MCP 桥（`McpToolBridge`）**：每个 DSH 对话拥有独立的 Bearer token、工具目录、HTTP 会话表、挂起调用队列与监听器；多个并发对话可同时发起工具调用、挂起续轮与独立取消，互不干扰。
3. **全局模型目录（`CatalogStore`）**：统一观测 ACP 1.5+ `category === 'model'` 与 `thought_level` 配置项，并集只读 `agy models` 家族清单；通过 `hiddenModels` 控制是否在选择器中显示。不再兼容无 `thought_level` 的旧版 agent（< ACP 1.5）或 `server-default` 占位项。
4. **统一会话协调器（`SessionCoordinator`）**：内存复用与跨进程 `session/resume` 共享同一纯校验函数（`evaluateRecordContinuity`），结果显式分为 `reuse`、`resume`、`reset-fresh`（前缀压缩 / 异常中断 / 指纹升级 / 仅思考档位变化 / **同 provider 切换模型** / 工作目录变更）、`unrecoverable`（系统提示变化 / 映射缺失，报 `AGY_SESSION_UNRECOVERABLE`）。思考档位与模型均可在同一对话内切换：映射额外保存去掉档位的 `routeBase` 与去掉模型和档位的 `routeSystem`，只变档位或同 provider 切模型时平滑新建 ACP 会话并保留历史继续，不判死对话。用户取消与干净未交付失败（如 `AGY_UPSTREAM_ERROR_NOTICE`）保留会话并以 `cancelled: true` 落盘，方便直接续聊/重试。工具目录不参与路由与续轮指纹，仅记 `toolsDigest` 诊断日志。
5. **活跃续期超时（`AgentLink` + `PromptTurn`）**：`session/prompt` 的 `promptTimeoutMs` 按**无活动超时**工作——每次收到 `session/update`、权限询问或 MCP 工具回喂都会重置计时器，且在等待 DSH 执行工具期间暂停计时，既能兜住真正假死的连接，也不会在长任务多步循环中误杀正常回合。
6. **统一 RPC 网关（`remote.antigravity`）**：Host（`src/remote/service.ts`）与 TSX Client（`src/client/`）共享 `src/shared/rpc-contract.ts` 定义的 9 个强类型方法：`readQuota`、`listModels`、`listAccounts`、`startAccountLogin`、`submitAccountCallback`、`cancelAccountLogin`、`activateAccount`、`removeAccount`、`installCli`。

## 思考强度与请求项

| 请求项 | 行为 |
|---|---|
| `reasoningEffort` | 严格写入 ACP 1.5+ `thought_level` 配置项；请求档位不在 agent 声明选项内时直接报 `AGY_EFFORT_UNSUPPORTED`，不做就近收敛。 |
| `maxTokens` | 忽略（输出上限由官方 agent 决定）。 |
| `temperature` / `stop` | 记录警告并忽略（ACP v1 无对应通道）。 |

## 额度与多账号

- **系统账号（`primary`）**：使用真实 HOME，只读导入本机官方 CLI 登录态，不可删除。
- **隔离账号**：每个账号位于 `~/.antigravity-acp-accounts/<id>` 独立 HOME，通过设置页浏览器 OAuth（支持无头主机手动粘贴回调地址）登录，凭据以 `0600` 原子写入。
- **额度取数**：默认走 Cloud Code Assist HTTP（`loadCodeAssist` → `retrieveUserQuotaSummary`，只读 CLI token 并在内存中刷新）；开启 `cliQuotaEnabled` 后仅走 `agy -p /usage` 与 `/credits`，未找到 CLI 时直接报错。
- **用量对账**：单步回合精确直出 `PromptResponse.usage`；多步工具回合中间步以 `usage_update.used` 锚定上下文水位、末步按差额对账并做防爆环钳制。
