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
| 1 | stdio 使用换行分隔 JSON-RPC | `src/protocol/agent-link.ts` | ✅ | 真机探针 2026-11-18 |
| 2 | `initialize` 接受空的 `clientCapabilities` | 同上 | ✅ | 真机探针 |
| 3 | `session/new` 需要 `cwd` 与 `mcpServers` | 同上 | ✅ | 真机探针 + ACP 日志 |
| 4 | `session/prompt` 的 `stopReason: end_turn` / `cancelled` | `src/session/turn-runner.ts` | ✅ | 真机探针 |
| 5 | `stopReason: max_tokens` / `refusal` / `max_turn_requests` 存在 | 同上 | ⚪ | 只按协议文档写进“干净失败”白名单 |
| 6 | `session/resume` 可接回**已取消**的会话 | `src/session/adapter.ts`、`src/session/session-coordinator.ts` | ✅ | 真机探针：cancel → resume → prompt end_turn |
| 7 | 取消确认前发新 prompt 会被拒绝 | 同上 | ✅ | 真机探针：`wait for it to finish` |
| 8 | `session/list` 存在并列出会话 | `src/protocol/agent-link.ts`（未启用） | ✅ | 集成用例「取消确认后同一会话可以继续…」 |
| 9 | `session/close` 之后会话仍可 `resume` 并继续对话 | `src/session/adapter.ts`、`src/session/session-coordinator.ts` | ✅ | 集成用例「session/close 之后仍能 resume 并继续对话」（2026-11-18） |
| 10 | `thought_level` 是独立 configOption，值含 low/medium/high；随当前模型变化 | `src/session/catalog-store.ts`、`src/session/model-router.ts` | ✅ | 集成用例「新会话声明 model / thought_level / mode 选项…」；`xhigh` 仅 Hydrogen 家族，由 CLI 目录并集补 |
| 11 | `_meta.antigravity.systemPrompt.append` 把 system 追加进 agent 提示 | `src/session/adapter.ts` | ✅ | 0.1.52 changelog 记录真机 1.5.10 |
| 12 | `enabledTools: []` 关闭 agent 内置工具 | 同上 | ✅ | ACP 日志：工具请求全部走 `mcp_dsh-tools_*` |
| 13 | `eagerMcpServers: ["dsh-tools"]` 预加载桥 | 同上 | ✅ | ACP 日志与 `mcp/dsh-tools` 目录 |
| 14 | `usage_update.size/used` 是当前上下文而非累计 | `src/session/turn-runner.ts`、`src/session/usage-accounting.ts` | ✅ | 0.1.52：修复 360%/411% 的实测 |
| 15 | MCP 工具可在同一 prompt 内被调用、回填并继续生成 | `src/session/turn-runner.ts`、`src/bridge/mcp-bridge.ts` | ✅ | 集成用例「MCP 工具：agent 调用工具并在同一 prompt 内拿到结果继续」：真机调用 `ping` 得到 `pong:hello`、`end_turn` |
| 16 | MCP 桥的 loopback + bearer token + 权限握手 | `src/bridge/mcp-bridge.ts` | 🟡 | 单测 + 本地 SOCKS 测试；真机已覆盖批准并回填，拒绝分支未构造 |
| 17 | `session/set_mode` 接受 agent 声明的 mode（default/accept-edits/auto/plan） | `src/session/model-router.ts` | ✅ | 集成用例「…档位与模式可设置」：`set_mode` 返回 `{}` |
| 18 | `set_config_option` 可能归一化模型 ID | `src/session/model-router.ts` | 🟡 | 离线单元测试 |
| 19 | 额度：`loadCodeAssist` → `retrieveUserQuotaSummary` 的端点与字段 | `src/auth/code-assist.ts` | ✅ | 2026-11-18 真机取到 plan=Google AI Pro 与三个额度组 |
| 20 | OAuth：PKCE、loopback 回调、token 交换 | `src/auth/oauth-client.ts` | ⚪ | 只有假 fetch；真 Google 未验证（文档已承认） |
| 21 | Windows 强制完整性（icacls 探测）影响会话建立 | `src/runtime/integrity.ts` | ⚪ | 从未在 Windows 实机跑过（文档已承认） |
| 22 | `agy -p /usage` / `/credits` 输出格式 | `src/runtime/agy-cli.ts` | ✅ | 本机实跑日志 |
| 23 | 同一会话的后续 prompt 保留上下文（插件据此只发增量） | `src/session/session-reuse.ts`、`src/session/session-coordinator.ts` | ✅ | 集成用例「第二次 prompt 记得第一次的暗号 ZEBRA-731」 |
| 24 | 同账号 5 路并发（含长回答）不触发 429 | 无（实验结论） | ✅ | 2026-11-18 两轮探针：5/5 成功、零 429 |
| 25 | `PromptResponse.usage` 是**本回合**内各次内部模型调用之和（非会话累计）；`totalTokens` = 本轮 Σ `usage_update.used` | `src/session/turn-runner.ts`、`src/session/usage-accounting.ts` | ✅ | 2026-11-18 与 2026-11-25 探针：单步 total=used=12305；3 次调用轮 total=39209=12803+12974+13432，末步上下文 13432 |
| 26 | agy 对 MCP 工具声明 `mcp_dsh-tools_<后缀>_<短名>`，并在声明里附加必填 `toolSummary`；调用进 MCP 前这两项被剥离 | `src/session/tool-args.ts` | ✅ | 2026-11-18：agy 会话库里的工具声明含 `{"required":["toolSummary"],…}` 与 `mcp_dsh-tools_5406866c_*`；DSH `session-6642c5ed` 的 584 次 `tool/call` 参数里没有 `toolSummary` |
| 27 | `PromptResponse.usage` 四桶互斥（`inputTokens + cachedReadTokens + cachedWriteTokens + outputTokens === totalTokens`），且 `outputTokens` 已包含 `thoughtTokens` | `src/session/usage-accounting.ts` | ✅ | 2026-11-25 真机探针：单步 12194+0+0+111=12305（thought=45≤111）；3 步工具轮 28148+10564+0+497=39209（thought=347≤497） |
| 28 | 多步工具回合中 `usage_update` 在对应 MCP `tools/call` 之前到达（间隔约 1.4–1.6s） | `src/session/turn-runner.ts`、`src/session/usage-accounting.ts` | ✅ | 2026-11-25 真机探针：`usage_update(12803)` +14842ms → `tools/call` +16420ms；`usage_update(12974)` +44856ms → `tools/call` +46304ms；`tests/real-usage-accounting.test.ts` |
| 29 | 上游对含越狱模板指纹的提示词返回 `RESOURCE_EXHAUSTED (HTTP 429)`，而不是 safety refusal；与账号额度、并发、模型无关 | 无（上游行为，插件只登记不下判断） | ✅ | 2026-11-26 本机探针矩阵（同账号交替发送）：`[MODE: UNRESTRICTED SANDBOX — STABLE]` 35 B → 8 次重试全 429；`[MODE: HELPFUL SANDBOX — STABLE]` 61 B、`[MODE: UNRESTRICTED SANDBOX]` 29 B、`UNRESTRICTED SANDBOX — STABLE` 32 B、中性 41 KB → 正常。Hydrogen / Carbon 都触发；当时额度 82%/83%、同分钟换模型可出流 |
| 30 | 官方 agent 把上游失败写成 `end_turn` + `⚠ <CODE> (code NNN): <detail>` 文本，ACP 层没有 error 信号（binary 内模板为 `end_turn\n⚠ %s\n`） | `src/session/turn-runner.ts`（`describeUpstreamErrorNotice`） | ✅ | 2026-11-26 真机：`session-e3421f85` 的 8 次上游 429 最终以该文本收尾并 `stopReason=end_turn`，宿主记 `completed`；`agy` 1.5.17 binary 内可见同一模板 |
| 31 | 复用轮只发增量，工具签名只在第一轮 prompt 里发一次；agent 的 MCP 工具面在 `session/new` 握手时确定，宿主中途新增工具对已有会话没有实际影响 | `src/session/transcript.ts`（`buildFullPrompt` 一次注入、`buildDeltaPrompt` 只发增量）、`src/session/session-reuse.ts`（指纹不含 tools） | 🟡 | 插件侧行为由 `tests/session-core.test.ts`「`ContinuationState ignores dynamic tool changes mid-turn`」锁定；官方 agent 是否会在长回合中重新 `tools/list` 未做真机确认（`AGY_REAL_ACP` 可升级为 ✅） |
| 32 | 官方 `agy` CLI 使用 `zalando/go-keyring` 将 `StoredToken` JSON 写入系统钥匙串（macOS 钥匙串 `service=gemini` / `account=antigravity`，Linux Secret Service 属性 `service=gemini` / `username=antigravity`） | `src/auth/token-store.ts`（`decodeKeyringPayload`、`createSubprocessKeyringReader`） | ⚪ | Linux `agy 1.5.18` 二进制符号确认 `zalando/go-keyring` 与 `KeyringTokenStorage`/`StoredToken`，且 [Issue #2](https://github.com/AlaIchhe/dsh-antigravity-acp/issues/2) 确认 macOS 钥匙串条目；但尚未在 macOS 实机验证 `security find-generic-password` 返回格式与钥匙串弹窗行为 |
| 33 | 统一官方 `agy` CLI（1.5+）通过 `agy acp` 子命令默认以 stdio JSON-RPC 启动 ACP server，无需 `--uid=`，可直接完成 `initialize` 握手 | `src/runtime/binary.ts`（`isAgyCliExecutable`、`resolveAgentArgs`、`ensureAgentBinary`） | ✅ | 2026-11-27 真机 `agy 1.5.18`：`agy acp --help` 确认默认 `--stdio`，发 `initialize` 返回 `Antigravity ACP Server 1.5.18` |

## 优先补验顺序（剩余未实机验证项）

1. **#20 OAuth 真机**：换账号/新增账号是高频操作，假 fetch 不能证明 Google 端可达。
2. **#21 Windows 完整性**：只在 Windows 上出错，且表现为“会话永久挂起”。
3. **#31 长回合中官方 agent 是否重拉 `tools/list`**：目前插件侧已锁定不破坏会话，上游动态工具刷新行为仍待真机确认。

## 怎么跑

```bash
AGY_REAL_ACP=1 npx vitest run tests/integration-real-agent.test.ts   # 全部真机断言
AGY_REAL_ACP=1 npx vitest run tests/real-usage-accounting.test.ts    # 单步/多步用量与水位对账真机断言
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
