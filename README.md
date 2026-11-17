# Antigravity ACP for DSH · 二次开源分支

> 本项目是 **[KouzakiUmi/dsh-antigravity-acp](https://github.com/KouzakiUmi/dsh-antigravity-acp)** 的
> 二次开源分支（fork），由 `AlaIchhe` 维护，**不是官方版本**，与原作者没有隶属或授权关系。
>
> 上游 README 原文完整保留在 [README.upstream.md](./README.upstream.md)。
> 许可证沿用上游的 MIT，版权归原作者及贡献者。

---

## 关于下架

这个分支之所以存在，只因为我需要两处上游尚未合并的行为修复（见下）。它不是要替代上游，
也不是要分叉生态。

**如果原作者认为本分支的存在不妥：**

- 在 [Issues](https://github.com/AlaIchhe/dsh-antigravity-acp/issues) 提一条即可（标题写「下架」两个字就行，不用说明理由）；
- 我会在 48 小时内把仓库归档或删除；
- 我的改动会改为**只向上游提 PR** 的形式，不再单独维护分支。

同理，如果上游后续合并了等价修复，我会主动归档本分支并引导使用者回到上游。

---

## 为什么有这个分支

两处问题都在上游 issue 里有记录，修复都很小，但会影响日常使用。

### 1. `xhigh` 档位被当成一个独立模型

官方 1.5.x 给 Gemini 4 Hydrogen 增加了 `-xhigh` 后缀。上游的档位正则只认
`low|medium|high`，于是 `gemini-4-hydrogen-xhigh` 匹配不到后缀，被折叠成**一个独立家族**，
模型选择器里会多出一行「Gemini 4 Hydrogen (XHigh)」。

但直接把 `xhigh` 加进档位表又会走向另一个坑：模型会声明四档，而宿主侧的 reasoning 校验
只接受已注册的档位，选中「极高」后调用直接以 `UNSUPPORTED_REASONING_EFFORT` 失败。

本分支的做法是**只折叠、不路由**：

- 新增 `AgyModelTier = AgyReasoningEffort | 'xhigh'`，仅用于识别与家族折叠；
- `AGY_REASONING_EFFORTS` 仍是 `low / medium / high`，思考强度菜单里不会出现选中就报错的选项。

### 上游状态

- 第 1 项已向上游提 PR：[#11 fix(model): 识别 xhigh 档位但不暴露](https://github.com/KouzakiUmi/dsh-antigravity-acp/pull/11)（对应 issue [#10](https://github.com/KouzakiUmi/dsh-antigravity-acp/issues/10)）
- 第 2 项尚未提 PR；先在本分支验证，稳定后再提

### 2. 上下文显示一直是 100%

宿主的上下文占用投影需要一个「上一次请求的 prompt 用量」作为锚点。上游的注释写的是
「官方 `agy_acp_server` 1.4.0 实测不返回 `PromptResponse.usage`，因此通常不上报」——
于是锚点长期不更新，投影只按消息增长累加，很快顶到窗口上限并**一直显示 100%**。

本分支在 `usage_update` 到达时记录 `used`（ACP 定义：当前上下文已用 token），
回合结束时若官方没有给出 `usage`，就用它作为本轮样本上报：

```ts
this.finishRound(mapUsage(response.usage) ?? this.#observedUsage)
```

---

## 与上游的差异清单

| 文件 | 改动 |
|---|---|
| `src/runtime/agy-cli.ts` | 新增 `AgyModelTier`；`tierForModelId` / `stripTierLabel` 认识 `xhigh`；档位表保持三档 |
| `src/adapter/antigravity-adapter.ts` | 家族档位集合类型放宽到 `AgyModelTier`；`usage_update.used` 记入本轮 |
| `src/adapter/prompt-turn.ts` | 新增 `noteUsage()`；回合结束时用 `response.usage ?? #observedUsage` 上报 |
| `README.md` | 本文件（上游原文见 `README.upstream.md`） |

除此之外**没有任何改动**：没有改桥、没有改提示词、没有改代理模式。

---

## 安装

```bash
# 直接从仓库安装
dsh plugin --profile <profile> add github:AlaIchhe/dsh-antigravity-acp
```

安装后按上游文档在「设置 → Antigravity ACP」里连接账号即可，使用方式与上游完全一致
（详见 [README.upstream.md](./README.upstream.md)）。

---

## 与上游同步

```bash
git remote add upstream https://github.com/KouzakiUmi/dsh-antigravity-acp.git
git fetch upstream
git rebase upstream/main
```

改动刻意保持最小，就是为了这一步不发生冲突。上游合并等价修复后，本分支会归档。

---

## 开发与验证

```bash
npm ci
npx tsc --noEmit     # 类型检查
npx vitest run       # 47 个文件 / 843 项测试
```

本分支提交时上述两项均通过。

---

## 许可

MIT，与上游一致。版权归 `dsh-bundle-antigravity-host contributors`；本分支的修改同样以 MIT 发布。
