/**
 * 多账号的共享类型：宿主存储的账号记录、发给客户端的脱敏视图、登录流程状态。
 *
 * 账号分两类：
 * - **系统账号**（`system: true`，id 固定为 {@link SYSTEM_ACCOUNT_ID}）：使用真实
 *   HOME，登录态来自本机官方 `agy` CLI（插件只读导入，永不改写）。
 * - **隔离账号**：每个账号一个独立 HOME 目录，插件在面板里跑 OAuth 后把凭据写进
 *   该目录；官方 ACP server 与只读 CLI 都以这个 HOME 启动，账号之间互不可见。
 */

/** 系统账号的固定 id；持久化文件里不保存它，启动时按真实 HOME 合成。 */
export const SYSTEM_ACCOUNT_ID = 'primary'

/** 系统账号在界面上的默认名称。 */
export const SYSTEM_ACCOUNT_ALIAS = '主账号（系统登录）'

/** 持久化的账号记录。`dir` 只对隔离账号存在，且必须位于账号根目录之下。 */
export interface AccountRecord {
  id: string
  alias: string
  email?: string
  /** 隔离账号的 HOME；系统账号省略。 */
  dir?: string
  system?: boolean
  createdAt: number
  /** 最近一次被设为当前账号的时间（仅用于展示排序，不参与鉴权）。 */
  lastUsedAt?: number
}

/** 发给客户端的是脱敏视图：绝不包含 HOME 路径或任何 token 材料。 */
export interface AccountView {
  id: string
  alias: string
  email?: string
  system: boolean
  active: boolean
  /** 该账号手上是否有一份可导入的登录态（只读检查文件是否存在）。 */
  ready: boolean
  createdAt: number
  lastUsedAt?: number
}

/**
 * 面板内 OAuth 登录的流程状态。
 * `waiting`：授权页已就绪，等待浏览器回调；`exchanging`：已拿到 code，正在换 token。
 */
export type AccountAuthPhase = 'idle' | 'preparing' | 'waiting' | 'exchanging' | 'done' | 'failed' | 'cancelled'

export interface AccountAuthView {
  phase: AccountAuthPhase
  message?: string
  /** 授权链接；仅 `waiting` 阶段返回，供浏览器未自动打开时手动点击。 */
  authUrl?: string
  /** 本次流程的目标账号：新增账号在成功后才会出现在 accounts 里。 */
  accountId?: string
  startedAt?: number
}

/** `account` remote 的登录/切换动作；ACP 的 status/login/warmup/cancel 保持原义。 */
export type AccountAdminAction = 'add-account' | 'cancel-add' | 'activate' | 'remove' | 'relogin'

/**
 * 面板动作里不含账号语义、但共用同一条 RPC 的那一个：安装官方 CLI。
 *
 * 它与账号无关（装的是 `agy` 二进制），但面板需要一个「点一下做事、回报进度」的
 * 通道，而 `account` remote 已经是这样一个通道，单独开一条 remote 只为安装按钮
 * 不值得。
 */
export type CliInstallAction = 'install-cli'

export const ACCOUNT_ADMIN_ACTIONS: readonly AccountAdminAction[] = ['add-account', 'cancel-add', 'activate', 'remove', 'relogin']

export const CLI_INSTALL_ACTIONS: readonly CliInstallAction[] = ['install-cli']

export interface AccountAdminRequest {
  action: AccountAdminAction
  /** activate / remove / relogin 的目标账号。 */
  id?: string
  /** 新增账号时的显示名；留空按「账号 N」生成。 */
  alias?: string
}

export interface AccountsSnapshot {
  accounts: AccountView[]
  activeAccountId: string
  auth: AccountAuthView
}

/** 当前账号解析结果：`home` 为 ACP / CLI 子进程要使用的 HOME，`dir` 仅隔离账号有。 */
export interface ResolvedAccount {
  id: string
  alias: string
  system: boolean
  home: string
  dir?: string
  /** 登录态代际：重新登录同一账号时递增，运行中的 ACP 链路据此重建。 */
  revision: number
}
