# 开发、验证与发布（v1.0）

[返回主页](../README.md) · [使用参考](reference.md) · [配置](configuration.md) · [更新记录](changelog.md)

## 项目结构

| 入口 / 目录 | 职责 |
|---|---|
| [`src/index.ts`](../src/index.ts) | 纯装配根（Composition Root）：Cordis 注入、事件接线与卸载闭环 |
| [`src/settings.ts`](../src/settings.ts) | 唯一配置 Schema（`Config`）与 `liveHostConfig` |
| [`src/shared/`](../src/shared/) | Host + Client 共享契约（`rpc-contract.ts`、`model-groups.ts`，零 Node 依赖） |
| [`src/storage/`](../src/storage/) | 统一原子文件写入原语（`atomic-json.ts`） |
| [`src/auth/`](../src/auth/) | 统一 OAuth / PKCE、凭据只读导入与 Cloud Code Assist HTTP 客户端 |
| [`src/accounts/`](../src/accounts/) | 多账号隔离存储与登录编排 |
| [`src/protocol/`](../src/protocol/) | ACP v1 stdio JSON-RPC 链路（`agent-link.ts`） |
| [`src/bridge/`](../src/bridge/) | 私有 loopback 多作用域并发 MCP 桥（`mcp-bridge.ts`） |
| [`src/session/`](../src/session/) | 核心领域：`adapter`、`catalog-store`、`model-router`、`session-coordinator`、`session-reuse`、`session-store`、`transcript`、`turn-runner`、`usage-accounting`、`permission`、`tool-args` |
| [`src/runtime/`](../src/runtime/) | `acp-runtime`（方案 A 共享进程管理）、`binary`、`process-env`、`proxy`、`agy-cli`、`agy-cli-install`、`integrity`、`redact`、`abort` |
| [`src/remote/`](../src/remote/) | `remote.antigravity` 宿主 Typert 服务 |
| [`src/client/`](../src/client/) | TypeScript + JSX Web Client（`scripts/build-client.mjs` 经 rolldown 打包至 `dist/client.js`） |

## 构建与验证

```console
npm run typecheck   # tsc --noEmit && tsc -p tsconfig.client.json --noEmit
npm run build       # tsc -p tsconfig.build.json && node scripts/build-client.mjs
npm test            # vitest run（离线隔离回归）
npm run check       # 顺序执行 typecheck → build → test
```

发版前运行真机集成回归：

```console
AGY_REAL_ACP=1 npx vitest run tests/integration-real-agent.test.ts tests/real-usage-accounting.test.ts
```
