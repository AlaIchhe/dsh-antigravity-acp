# 项目说明（AGENTS.md）

本文件是 `dsh-antigravity-acp` 的项目级入口：说明项目目的、需求与验收标准、设计取舍、实现边界与维护约定。详细契约见 [`README.md`](README.md) 与 [`docs/`](docs/)。

## 项目目的

把 Google 官方 Antigravity 接入 DeepSeek Harness。生成链路只有一条：官方 ACP（stdio, ACP v1），工具执行仍由 DSH 校验、审批与执行。

本包是 Host + Web Client bundle，只含 `llm-antigravity-acp` 一行组件，不修改 DSH Core，也不把官方 CLI 包装成聊天接口。

npm 包名 `dsh-bundle-antigravity-acp`、provider ID `antigravity-acp`、内部插件名 `llm-antigravity-acp` 不混用。

## 需求与验收标准

已确认的产品要求：

1. **对话可用**：在 DSH 里选择 `Antigravity (ACP)` 的模型即可生成，工具调用经私有 loopback MCP 桥回到 DSH 执行，结果回填同一个 ACP prompt。
2. **连接与目录**：设置页能读取模型目录；ACP 连接在首次聊天时按需建立，不发送聊天 prompt。
3. **模型列表由设置页管理**：用户按模型控制是否出现在 DSH 模型选择器；显示名 / 官方 ID 映射只保留配置兼容，不在 UI 编辑。思考强度不是目录设置，见下一条。
4. **不再维护「默认模型」**：DSH 自带模型选择器负责选模，插件侧不保存第二份「新对话优先模型」。
5. **多账号与面板登录**：账号列表持久化；系统账号使用真实 HOME、只读导入官方 CLI 登录态且不可删除；新增 / 重新登录在设置页直接完成浏览器 OAuth，token 写入该账号隔离 HOME（官方 CLI 格式 + ACP 文件）；切换只影响后续连接，正在进行的回合不被打断；额度按账号读取，药丸跟随当前账号。
6. **额度按账号读取**：套餐额度默认走 Cloud Code Assist HTTP（读该账号 HOME 下的 CLI 登录态）；`cliQuotaEnabled` 打开后改用 `agy -p /usage` 与 `agy -p /credits`，未找到 CLI 时套餐额度回落 HTTP；药丸只跟随当前账号，面板逐账号自动读取，切换 / 登录 / 删除后重新取数。

验收以「目标符合性 + 关键使用流程 + 实际运行证据」共同判断，不以测试通过替代真实账号与 GUI 验收。

## 关键设计取舍

- **模型目录只观测，不自造**：目录来自会话 `configOptions` 与官方 CLI 只读清单。用户设置（`modelOverrides`）只作用于已存在的条目。
- **停用 ≠ 删除**：停用只是不列入选择器，已知模型的显示名、上下文容量与路由仍保留，重新启用不会退回裸 ID。
- **思考强度是模型的元数据**：ACP 1.5 起官方把档位声明成独立的 `thought_level` config option（`category: "thought_level"`），选项随模型变化（Hydrogen 多一档 `xhigh`）。适配器据此声明 `reasoning.efforts`（id 与名称都取 agent 声明），选模只发家族 id，档位另写一次 `session/set_config_option`；请求值不在当前选项里时按 low → medium → high → xhigh 就近收敛，未知值不发出。宿主按模型校验 `reasoningEffort`，没有 `reasoning` 元数据的模型带档位请求会被拒，所以元数据必须如实声明、不能给空 `efforts`。
- **映射优先于路由回调**：`target` 原样写入 `session/set_config_option`，由官方 agent 判定是否接受；未登记 ID 不被静默改写。
- **旧 agent 兼容**：没有 `thought_level` 时，官方档位化目录折叠为家族并退回「档位后缀」路由（`claude-opus-5-5-high`），缺档取最近档位。这条路径是兜底，不是默认。
- **整份 map 作为一个字段**：`modelOverrides` 参与草稿脏值与冲突判断，规范化后比较，避免键序或写回默认值被误判为未保存修改；提交时只发改动过的顶层字段。
- **会话复用**：同一 DSH 对话的后续回合只发送新增消息，历史不是已发送前缀的追加、路由或工具目录变化时受控重建。
- **目录与额度跟随账户**：手动刷新绕过缓存，失败只可复用同账户已观测目录；账户代际隔离目录及额度；登录、退出触发刷新，旧在途结果不能写回。
- **登录取消覆盖 token 交换**：OAuth 回调被消费后仍保留当前流程的取消信号；账户保存与清除串行完成。退出使旧刷新失效，本次插件生命周期内保持退出状态，直到用户再次显式连接。
- **连接成功包含只读项目检测**：CLI 导入先校验或刷新 access token，再通过 `loadCodeAssist` 解析已有 Cloud Code Assist 项目；缺项目时给出可读错误，流程与参考插件的只读探测一致。失效登录态可进入 OAuth；状态快照只返回脱敏阶段与账户代际，授权链接仅在显式登录结果中返回。
- **统一出网**：OAuth、CLI 子进程与 HTTP 额度都使用同一套代理解析，显式 `proxyUrl` 优先，留空继承 Host 的 HTTPS / ALL / HTTP 代理环境，再自动检测系统代理（Windows 注册表 / macOS scutil / Linux GNOME）；`proxyBypass` 命中目标才直连。原生 TLS 不读取全局 fetch dispatcher，不能把宿主 fetch 已走代理当作其出网证据。
- **登录阶段与取消一致**：连接状态区分准备、等待浏览器、完成登录；阶段变化不增加账户代际或重复刷新目录。取消覆盖 OAuth 之前的换发和项目检测，以及回调后的换码与提交；失败原因按授权、项目检测和本地保存分别反馈，重试不受旧回调或监听关闭阻塞。
- **设置页额度自动读取**：账号卡片挂载时按该账号读一次额度（走 Host 缓存，不手动点按钮），面板不广播其它账号结果，药丸只读当前账号。账号切换 / 登录 / 删除后药丸重新取数；旧请求不得覆盖新界面。
- **账号隔离**：`~/.antigravity-acp-accounts` 下的每个隔离账号有自己的 HOME，ACP server 与只读 CLI 都以该 HOME 启动；系统账号真实 HOME 的官方 CLI 文件只读。面板 OAuth 固定 loopback 51121 + state 校验，不下发 code/token；macOS 系统钥匙串的隔离局限必须如实记录。
- **线身份复用审计实现**：Cloud Code Assist 的 HTTP 额度请求复用 `buildAntigravityHarnessBootstrapHeaders`（User-Agent + Accept-Encoding），OAuth 常量取自 `@cortexkit/antigravity-auth-core`；本包只写有界传输与适配器胶水。

## 实现边界

- 协议约束不是 OS 沙箱；ACP fs / terminal 与未知原生权限请求一律拒绝。
- `temperature` / `stop` 无 ACP v1 会话通道，记录警告并忽略；`maxTokens` 忽略；`reasoningEffort` 写入 `thought_level`（旧 agent 则是档位路由键）。
- 额度与 AI Credits 仅为参考值，不是计费依据；ACP 登录与 CLI 登录是两条链路。
- 上下文容量只在实测到 `usage_update.size` 后才声明，不填猜测值。
- 版本与测试范围见 [README 兼容性矩阵](README.md#兼容性与验证范围)；宽 peer 范围是安装条件，不是全部 Core / 平台实机兼容证明。

## 维护约定

- 字段以 [`src/settings.ts`](src/settings.ts) 的 `Config` 为唯一来源；`LIVE_SETTING_KEYS` 只管理即时字段。设置卡片只编辑即时字段与 `modelOverrides` 的显示开关——宿主只把 volatile 字段投影进设置文档，也会拒绝 `mutate` 非 volatile 路径，把它们渲染成可编辑控件只会得到「值不是真值、保存整批失败」；`proxyBypass` 仅保留配置兼容性、不显示控制项（有测试锁定）。
- 设置页分「账号 / 模型」；账号页只保留账号卡片（切换 / 登录 / 删除）与自动额度（参考 `dsh-agy-link` 的账户卡片：状态、操作与额度是同一个账户的两面）；取数方式、会话调优与诊断只在配置文件/日志，不占 UI。
- 模型设置的纯逻辑集中在 [`src/adapter/model-settings.ts`](src/adapter/model-settings.ts)，适配器与客户端只消费其结论。
- 档位选择器与模型目录一起落盘（`catalog.json` 的 `thoughtLevel`，格式 v2）、一起在 worker 间共享；`findThoughtLevelSelector` 集中在 [`src/adapter/model-catalog.ts`](src/adapter/model-catalog.ts)。
- 多账号在 [`src/accounts/`](src/accounts/) 下独立：`types.ts` 共享契约、`store.ts` 持久化与路径校验、`oauth.ts` 授权码 / PKCE / 回调、`manager.ts` 登录与切换。`ensureAcpRuntime` 只接受「当前账号 + 登录代际」，切换时先回收旧链路。
- 客户端 [`src/client.js`](src/client.js) 不得导入 Node 原生模块；`remote.settings` / `remote.llm` 必须逐个声明注入。一个包只注册一次 Host Typert contribution、只执行一次客户端 `$mount`，合并 `agyQuota` 描述符；宿主拒绝重复 package-face / Remote package 身份。
- 行为改动后同步更新 `docs/changelog.md`、`docs/configuration.md`、`docs/reference.md` 与 `docs/development.md` 的验证矩阵，并核对 `scripts/preview-kit.mjs` 的离线预览夹具。
- 验证入口：`npm run typecheck`、`npm test`、`npm run build`（`npm run check` 顺序执行三者）。
- 待决事项：无。
