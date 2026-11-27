# dsh-antigravity-acp

[![Publish package](https://github.com/AlaIchhe/dsh-antigravity-acp/actions/workflows/publish.yml/badge.svg)](https://github.com/AlaIchhe/dsh-antigravity-acp/actions/workflows/publish.yml)

在 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 里接入 Google 官方 **Antigravity ACP agent**（v1.0）：
用 DSH 的界面选模型、调思考强度、管理多账号与额度，工具调用仍经私有 loopback MCP 桥回到 DSH 审批和执行。

> 基于 [KouzakiUmi/dsh-antigravity-acp](https://github.com/KouzakiUmi/dsh-antigravity-acp)（MIT）的独立分支，
> 2026-11-17 起由 `AlaIchhe` 维护。上游原文见 [README.upstream.md](./README.upstream.md)；
> 原作者如认为本分支不妥，提 [issue](https://github.com/AlaIchhe/dsh-antigravity-acp/issues) 即可，我会归档该仓库。

## 核心能力（v1.0）

- **按账号共享常驻 ACP 进程（方案 A）**：同一账号下的多个并发对话共享一条官方 ACP stdio 进程，按 `sessionId` 多路复用；切换账号或重新登录后自动回收旧进程。
- **真正并发的私有 MCP 桥**：每个 DSH 对话拥有独立 Bearer token、工具目录、挂起队列与监听器；工具执行、审批与沙箱完全留在 DSH。
- **原生模型目录与思考强度**：观测 ACP 1.5+ `category === 'model'` 与 `thought_level`（并集只读 `agy models` 家族清单）；设置页通过 `hiddenModels` 控制选择器显示/隐藏。
- **跨进程会话恢复与活跃续期**：映射持久化在 `sessions.json`（v3），重启后通过 `session/resume` 接回；`promptTimeoutMs` 按无活动超时计时，长任务多步工具循环不会被误杀。
- **多账号与实时额度**：支持系统账号（只读导入本机 CLI 登录态）与浏览器 OAuth 隔离账号（含无头主机手动粘贴回调）；套餐额度默认走 Cloud Code Assist HTTP，开启 `cliQuotaEnabled` 后切至 `agy -p /usage` 与 `/credits`。
- **类型安全的 RPC 与 TSX 客户端**：Host 与 Client 共享 `src/shared/rpc-contract.ts` 定义的 `remote.antigravity` 9 方法强类型契约，客户端经 rolldown 打包至 `dist/client.js`（零 `node:*` 依赖）。

## 安装

```bash
# 从 npm 安装（正式版）
dsh plugin --profile <profile> add dsh-bundle-antigravity-acp
# 或安装预发版（rc）
dsh plugin --profile <profile> add dsh-bundle-antigravity-acp@rc
```

> 如需从源码本地安装，先克隆仓库并执行 `npm ci && npm run build`，再以 `dsh plugin --profile <profile> add file:/path/to/dsh-antigravity-acp` 安装（仓库不提交 `dist/`，不支持直接通过 `github:` 安装）。

安装后重载 DSH 服务，在「设置 → Antigravity ACP」里完成账号登录或使用本机 CLI 登录态即可开始对话。

## 使用

1. **账号**：设置页 →「账号」→ 使用本机「主账号（系统登录）」或点击「新增账号登录」完成 Google 授权（无头主机可直接粘贴回调地址）。多账号各自隔离 HOME，一键切换。
2. **模型**：在 DSH 模型选择器中选择 `Antigravity (ACP)` 下的模型家族；可在设置页「模型」标签里切换显示/隐藏。
3. **思考强度**：在 DSH 的思考强度菜单中选择 agent 声明的档位（例如 Hydrogen 的 `xhigh`），写入官方 `thought_level` 配置项。
4. **额度**：账号卡片自动展示各模型组剩余额度与倒计时；对话输入框旁的额度药丸跟随当前账号与当前模型。

详细技术边界、配置项与排障见 [docs/reference.md](docs/reference.md)、[docs/configuration.md](docs/configuration.md)、[docs/development.md](docs/development.md) 与 [docs/changelog.md](docs/changelog.md)。

## 开发与验证

```bash
npm ci
npm run typecheck   # 宿主 + 客户端双 tsconfig 类型检查
npm run build       # 构建 dist/ 与 dist/client.js（rolldown）
npm test            # 离线单元测试与回归套件（vitest）
npm run check       # 顺序执行 typecheck → build → test
```

## 许可

MIT，与上游一致。版权归 `dsh-bundle-antigravity-acp contributors`；本分支的修改同样以 MIT 发布。
