# 上游行为断言台账

本文件记录**插件对官方 `agy acp` 行为的每一条断言**，以及它当前的证据等级。
背景：2026-11-18 的排查里发现，若干“设计依据”其实是推断而非实测（最典型的是把
429 归因于并发），而推断写进代码后会被当成事实继续引用。

## 证据等级

- ✅ **真机实测**：有日志、探针或真机运行记录；改动前必须重跑对应验证。
- 🟡 **仅单元测试**：假 agent / 假 fetch 覆盖。注意：假 agent 已于 2026-11-18 删除，
  这类断言现在**等于没有证据**。
- ⚪ **推断**：来自协议文档、社区实现或“看起来合理”，从未验证。

## 台账

| # | 断言 | 代码位置 | 等级 | 验证方式 |
|---|---|---|---|---|
| 1 | stdio 使用换行分隔 JSON-RPC | `protocol/agent-link.ts` | ✅ | 真机探针 2026-11-18 |
| 2 | `initialize` 接受空的 `clientCapabilities` | 同上 | ✅ | 真机探针 |
| 3 | `session/new` 需要 `cwd` 与 `mcpServers` | 同上 | ✅ | 真机探针 + ACP 日志 |
| 4 | `session/prompt` 的 `stopReason: end_turn` / `cancelled` | `adapter/prompt-turn.ts` | ✅ | 真机探针 |
| 5 | `stopReason: max_tokens` / `refusal` / `max_turn_requests` 存在 | 同上 | ⚪ | 只按协议文档写进“干净失败”白名单 |
| 6 | `session/resume` 可接回**已取消**的会话 | `adapter/antigravity-adapter.ts` | ✅ | 真机探针：cancel → resume → prompt end_turn |
| 7 | 取消确认前发新 prompt 会被拒绝 | 同上 | ✅ | 真机探针：`wait for it to finish` |
| 8 | `session/list` 存在并列出会话 | 同上（未启用） | ✅ | 集成用例「取消确认后同一会话可以继续…」 |
| 9 | `session/close` 之后会话仍可 `resume` 并继续对话 | `adapter/antigravity-adapter.ts` | ✅ | 集成用例「session/close 之后仍能 resume 并继续对话」（2026-11-18） |
| 10 | `thought_level` 是独立 configOption，值含 low/medium/high；随当前模型变化 | 同上 | ✅ | 集成用例「新会话声明 model / thought_level / mode 选项…」；`xhigh` 仅 Hydrogen 家族，由 CLI 目录并集补 |
| 11 | `_meta.antigravity.systemPrompt.append` 把 system 追加进 agent 提示 | 同上 | ✅ | 0.1.52 changelog 记录真机 1.5.10 |
| 12 | `enabledTools: []` 关闭 agent 内置工具 | 同上 | ✅ | ACP 日志：工具请求全部走 `mcp_dsh-tools_*` |
| 13 | `eagerMcpServers: ["dsh-tools"]` 预加载桥 | 同上 | ✅ | ACP 日志与 `mcp/dsh-tools` 目录 |
| 14 | `usage_update.size/used` 是当前上下文而非累计 | `adapter/prompt-turn.ts` | ✅ | 0.1.52：修复 360%/411% 的实测 |
| 15 | MCP 工具可在同一 prompt 内被调用、回填并继续生成 | `adapter/prompt-turn.ts`、`bridge/mcp-bridge.ts` | ✅ | 集成用例「MCP 工具：agent 调用工具并在同一 prompt 内拿到结果继续」：真机调用 `ping` 得到 `pong:hello`、`end_turn` |
| 16 | MCP 桥的 loopback + bearer token + 权限握手 | `bridge/mcp-bridge.ts` | 🟡 | 假 agent + 本地 SOCKS 测试；真机只见过日志片段 |
| 17 | `session/set_mode` 接受 agent 声明的 mode（default/accept-edits/auto/plan） | 同上 | ✅ | 集成用例「…档位与模式可设置」：`set_mode` 返回 `{}` |
| 18 | `set_config_option` 可能归一化模型 ID | 同上 | 🟡 | 假 agent |
| 19 | 额度：`loadCodeAssist` → `retrieveUserQuotaSummary` 的端点与字段 | `runtime/quota.ts` | ✅ | 2026-11-18 真机取到 plan=Google AI Pro 与三个额度组 |
| 20 | OAuth：PKCE、loopback 回调、token 交换 | `accounts/oauth.ts` | ⚪ | 只有假 fetch；真 Google 未验证（文档已承认） |
| 21 | Windows 强制完整性（icacls 探测）影响会话建立 | `runtime/integrity.ts` | ⚪ | 从未在 Windows 实机跑过（文档已承认） |
| 22 | `agy -p /usage` / `/credits` 输出格式 | `runtime/agy-cli.ts` | ✅ | 本机实跑日志 |
| 23 | 同一会话的后续 prompt 保留上下文（插件据此只发增量） | `adapter/session-reuse.ts` | ✅ | 集成用例「第二次 prompt 记得第一次的暗号 ZEBRA-731」 |
| 24 | 同账号 5 路并发（含长回答）不触发 429 | 无（实验结论） | ✅ | 2026-11-18 两轮探针：5/5 成功、零 429 |

## 优先验证顺序（按“错了会怎样”排序）

1. **#15 工具续轮**：这是本插件的核心价值（工具回 DSH 执行）。现在零真机证据、零单测，
   错了表现为“工具调用后对话卡死或重复执行”。
2. **#9 `session/close` 后能否 resume**：取消/异常路径依赖它；如果 close 即销毁，
   取消后继续聊就必须改成重建。
3. **#17 `set_mode`**：未验证就先声明支持，配置后可能直接失败。
4. **#20 OAuth 真机**：换账号/新增账号是高频操作，假 fetch 不能证明 Google 端可达。
5. **#21 Windows 完整性**：只在 Windows 上出错，且表现为“会话永久挂起”。

## 怎么跑

```bash
AGY_REAL_ACP=1 npx vitest run tests/integration-real-agent.test.ts   # 全部真机断言
```

用例与断言的对应关系写在用例名里（上表“验证方式”列）；新增断言时同时补用例，
否则它只能停在 ⚪。

## 无法在当前环境验证的

| 断言 | 原因 |
|---|---|
| #5 `max_tokens` / `refusal` / `max_turn_requests` 等 stopReason | 无法稳定构造；代码里只当作“干净失败”白名单，标 ⚪ |
| #16 桥的权限握手细节 | 真机只覆盖到“调用被批准并回填”，权限拒绝分支未构造 |
| #18 `set_config_option` 归一化模型 ID | 需要 agent 返回不同 ID 的样本，未遇到 |
| #20 OAuth 真机 | 需要真实 Google 授权，当前只用假 fetch |
| #21 Windows 强制完整性 | 需要 Windows 实机 |

## 约定

- 新增对上游行为的判断时，必须在本表登记并写明证据等级；没有验证的写 ⚪，
  **不得在注释或文档里写成“实测”**。
- 修改任何 ✅ 项所对应的代码路径前，先重跑对应真机探针。
