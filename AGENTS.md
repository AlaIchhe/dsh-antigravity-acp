# 项目说明（AGENTS.md · v1.0）

本文件是 `dsh-antigravity-acp` 的项目级入口：说明项目目的、架构边界、设计取舍与维护约定。详细契约见 [`README.md`](README.md) 与 [`docs/`](docs/)。

## 项目目的

把 Google 官方 Antigravity 接入 DeepSeek Harness。生成链路只有一条：官方 ACP（stdio, ACP v1），工具执行仍由 DSH 校验、审批与执行。

本包是 Host + Web Client bundle，只含 `llm-antigravity-acp` 一行组件，不修改 DSH Core。npm 包名 `dsh-bundle-antigravity-acp`、provider ID `antigravity-acp`、内部插件名 `llm-antigravity-acp`、RPC 服务名 `antigravity` 不混用。

## 核心架构（v1.0 方案 A）

- **按账号共享常驻 ACP 进程**：[`src/runtime/acp-runtime.ts`](src/runtime/acp-runtime.ts) 按 `(accountId, revision)` 维护单一共享 `AgentLink`；切换账号或重新登录后自动回收旧进程。
- **多作用域并发 MCP 桥**：[`src/bridge/mcp-bridge.ts`](src/bridge/mcp-bridge.ts) 为每个对话作用域独立维护 Bearer token、工具目录、HTTP 会话、`pending` 队列与 `onParked` 监听器，支持多对话真正并发。
- **模块化会话核心**：[`src/session/`](src/session/) 将原巨型适配器拆分为 `catalog-store`、`model-router`、`session-coordinator`、`session-reuse`、`session-store`、`transcript`、`turn-runner`、`usage-accounting`、`permission`、`tool-args` 与薄外观 `adapter`。
- **统一凭据域**：[`src/auth/`](src/auth/) 集中管理 OAuth/PKCE、`acp_token.json` 准备与 Cloud Code Assist HTTP 额度；系统账号官方 CLI 文件严格只读。
- **共享 RPC 契约 + TSX 客户端**：[`src/shared/rpc-contract.ts`](src/shared/rpc-contract.ts) 唯一定义 `remote.antigravity` 的 9 个方法与严格 codec；[`src/client/`](src/client/) 为纯 TypeScript + JSX（经 `scripts/build-client.mjs` 用 rolldown 打包至 `dist/client.js`，禁止导入 `node:*`）。

## 关键设计取舍与红线

- **模型列表与思考强度**：目录只观测、不自造；设置页通过 `hiddenModels` 控制显示/隐藏。仅支持 ACP 1.5+ 的 `category === 'model'` 与 `thought_level`，请求未声明档位直接报 `AGY_EFFORT_UNSUPPORTED`。
- **会话延续与指纹**：`ContinuationState` 与 `SessionCoordinator` 共享同一个 `routeFingerprint`（含 provider / model / effort / system，**不含 `tools`**）；`SessionStore`（format v3）完整保留 `routeVersion`。内存与磁盘共用 `evaluateRecordContinuity`，明确区分 `reuse | resume | reset-fresh | unrecoverable`。
- **额度取数**：默认走 Cloud Code Assist HTTP；开启 `cliQuotaEnabled` 后仅走 `agy -p /usage` 与 `/credits`，未找到 CLI 时明确报错（不回落 HTTP）。
- **安全红线**：ACP `fs`/`terminal`/未知权限请求一律拒绝；子进程一律经 `ctx.subprocess` 并通过 [`src/runtime/process-env.ts`](src/runtime/process-env.ts) 构造最小环境；所有错误与日志经 `redactSensitiveText` 脱敏。
- **上游断言**：新增任何对官方 `agy acp` 行为的判断，必须登记到 [`docs/claims.md`](docs/claims.md) 并注明证据等级。

## 维护约定

- 配置唯一来源：[`src/settings.ts`](src/settings.ts)；原子落盘统一走 [`src/storage/atomic-json.ts`](src/storage/atomic-json.ts)。
- `AntigravityRemoteService` 继承 `TypertRemoteService`（Cordis Service 经 Proxy 调用），必须使用 TS `private` 而非 ES `#private`。
- 客户端 `remote.settings` / `remote.llm` 须逐个声明在 `inject` 中；`remote.antigravity` 绝不写进 `inject`。
- 验证入口：`npm run check`（顺序执行 `typecheck` → `build` → `test`）；发版前跑 `AGY_REAL_ACP=1 npx vitest run tests/integration-real-agent.test.ts tests/real-usage-accounting.test.ts`。
