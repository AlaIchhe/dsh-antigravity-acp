/**
 * 多账号管理器：持久化账号列表、真实 HOME 的系统账号、隔离账号的 OAuth 登录、
 * 当前账号切换与删除。
 *
 * 并发口径：同一时间只允许一条登录流程；账号切换/删除不打断已在进行的 ACP 回合，
 * 但下一次建立连接时会按当前账号重新准备凭据（见 index.ts 的 ensureAcpRuntime）。
 */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  OAUTH_CALLBACK_PATH,
  exchangeCode,
  fallbackLoginClient,
  fetchUserEmail,
  generatePkce,
  buildAuthorizeUrl,
  startCallbackListener,
  writeCliTokenFile,
} from './oauth.js'
import type { CallbackListener, OAuthClientMeta, TokenSet } from './oauth.js'
import { accountDirFor, isValidAccountId, loadAccountsFile, saveAccountsFile } from './store.js'
import type { AccountsFile } from './store.js'
import {
  SYSTEM_ACCOUNT_ALIAS,
  SYSTEM_ACCOUNT_ID,
  type AccountAdminRequest,
  type AccountAuthView,
  type AccountRecord,
  type AccountView,
  type AccountsSnapshot,
  type ResolvedAccount,
} from './types.js'

export interface AccountsManagerOptions {
  /** 账号根目录；默认见 resolveAccountsDir()。 */
  baseDir: string
  /** 真实 HOME（系统账号与默认 CLI 登录态所在）。 */
  homeDir?: string
  now?: () => number
  randomId?: () => string
  /** OAuth 授权码换 token 用的 fetch（生产传插件代理 fetch）。 */
  fetchImpl?: typeof fetch
  /** 解析官方 OAuth client；失败时回落到已审计的内嵌一对。 */
  resolveClient?: () => Promise<OAuthClientMeta | undefined>
  /** 把刚拿到的登录态写成 ACP server 需要的两份文件（生产用 writeAcpCredentialFiles）。 */
  writeCredentials?: (input: { home: string; client: OAuthClientMeta; tokens: TokenSet }) => Promise<void>
  /** 打开默认浏览器；返回是否成功（失败时客户端仍可点授权链接）。 */
  openBrowser?: (url: string) => Promise<boolean>
  /** 登录等待上限（毫秒）。 */
  loginTimeoutMs?: number
  /** 本机回调端口；默认 51121（官方 Antigravity client 注册的回调），测试可传 0。 */
  loginPort?: number
  /** 账号列表或当前账号变化后调用（index.ts 用来通知目录刷新）。 */
  onChange?: () => void
  log?: { info(message: string): void; warn(message: string, error?: unknown): void }
}

interface LoginTarget {
  kind: 'add' | 'relogin'
  id: string
  alias?: string
  /** 新增账号的暂存 HOME；成功后才 rename 成正式目录。 */
  staging?: string
  /** 重新登录的目标账号目录。 */
  home: string
}

interface ActiveLogin {
  target: LoginTarget
  verifier: string
  redirectUri: string
  listener: CallbackListener
  cancel(): void
}

export interface AccountActionResult {
  snapshot: AccountsSnapshot
  message: string
}

/** 账号管理器。所有 token / HOME 细节只在 Host 侧，客户端只看 AccountView。 */
export class AccountsManager {
  private file: AccountsFile
  private auth: AccountAuthView = { phase: 'idle' }
  private login: ActiveLogin | undefined
  private authReset?: ReturnType<typeof setTimeout>
  private disposed = false
  /** 每个账号的登录态代际；重新登录成功后递增，只影响该账号的链路。 */
  private readonly revisions = new Map<string, number>()
  /** 本进程见过的账号 id；保存时用来保留其它 Host 新增的记录。 */
  private readonly knownIds = new Set<string>()
  private readonly baseDir: string
  private readonly homeDir: string
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly fetchImpl: typeof fetch
  private readonly writeCredentials: AccountsManagerOptions['writeCredentials']
  private readonly openBrowser: AccountsManagerOptions['openBrowser']
  private readonly resolveClient: AccountsManagerOptions['resolveClient']
  private readonly loginTimeoutMs: number
  private readonly loginPort: number | undefined
  private readonly onChange: AccountsManagerOptions['onChange']
  private readonly log: AccountsManagerOptions['log']

  constructor(options: AccountsManagerOptions) {
    this.baseDir = options.baseDir
    this.homeDir = options.homeDir ?? homedir()
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? (() => `${this.now()}_${randomBytes(4).toString('hex')}`)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.writeCredentials = options.writeCredentials
    this.openBrowser = options.openBrowser
    this.resolveClient = options.resolveClient
    this.loginTimeoutMs = options.loginTimeoutMs ?? 300_000
    this.loginPort = options.loginPort
    this.onChange = options.onChange
    this.log = options.log
    this.file = loadAccountsFile(this.baseDir)
    for (const record of this.file.accounts) this.knownIds.add(record.id)
    // 中断的登录会留下 staging_*；它们不属于任何已提交账号，启动时清掉即可。
    try {
      for (const entry of readdirSync(this.baseDir)) {
        if (!entry.startsWith('staging_')) continue
        rmSync(join(this.baseDir, entry), { recursive: true, force: true })
      }
    } catch {
      // 目录不存在 / 不可读不影响账号列表；登录时会按需创建。
    }
    if (!this.activeRecordId()) {
      this.file.activeAccountId = SYSTEM_ACCOUNT_ID
      this.persist()
    }
    this.auth = { phase: 'idle' }
  }

  /** 客户端可见的快照：账号列表 + 当前账号 + 登录流程。 */
  snapshot(): AccountsSnapshot {
    const activeId = this.activeRecordId()
    const accounts: AccountView[] = [this.systemView(activeId), ...this.file.accounts.map((record) => this.viewOf(record, activeId))]
    return {
      accounts,
      activeAccountId: activeId,
      auth: { ...this.auth },
    }
  }

  /** 当前账号（ACP / CLI 子进程使用的 HOME）。 */
  active(): ResolvedAccount {
    const id = this.activeRecordId()
    if (id === SYSTEM_ACCOUNT_ID) return this.systemResolved()
    const record = this.file.accounts.find((row) => row.id === id)
    return record ? this.resolvedOf(record) : this.systemResolved()
  }

  /** 按 id 解析账号；系统账号或未知 id 返回 undefined / 系统账号。 */
  resolve(id?: string): ResolvedAccount | undefined {
    if (!id || id === SYSTEM_ACCOUNT_ID) return this.systemResolved()
    const record = this.file.accounts.find((row) => row.id === id)
    return record ? this.resolvedOf(record) : undefined
  }

  /** 面板动作入口。 */
  async handle(request: AccountAdminRequest): Promise<AccountActionResult> {
    switch (request.action) {
      case 'add-account':
        return this.beginAdd(request.alias)
      case 'cancel-add':
        return this.cancelLogin()
      case 'activate':
        return this.activate(request.id)
      case 'remove':
        return this.remove(request.id)
      case 'relogin':
        return this.beginRelogin(request.id)
      default:
        throw new Error('不支持的账号操作')
    }
  }

  /** 登录流程结束后由面板轮询取走的状态；调用方不需要主动查询。 */
  authState(): AccountAuthView {
    return { ...this.auth }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const pending = this.login?.target
    this.login?.cancel()
    this.login = undefined
    if (pending?.staging) void rm(pending.staging, { recursive: true, force: true }).catch(() => undefined)
    if (this.authReset !== undefined) clearTimeout(this.authReset)
    this.authReset = undefined
  }

  // ---- 账号视图 ----

  private systemResolved(): ResolvedAccount {
    return { id: SYSTEM_ACCOUNT_ID, alias: SYSTEM_ACCOUNT_ALIAS, system: true, home: this.homeDir, revision: 0 }
  }

  private resolvedOf(record: AccountRecord): ResolvedAccount {
    return {
      id: record.id,
      alias: record.alias,
      system: false,
      home: record.dir as string,
      dir: record.dir,
      revision: this.revisions.get(record.id) ?? 0,
    }
  }

  private systemView(activeId: string): AccountView {
    const home = this.homeDir
    return {
      id: SYSTEM_ACCOUNT_ID,
      alias: SYSTEM_ACCOUNT_ALIAS,
      system: true,
      active: activeId === SYSTEM_ACCOUNT_ID,
      ready: this.tokenExists(home, false),
      createdAt: 0,
    }
  }

  private viewOf(record: AccountRecord, activeId: string): AccountView {
    return {
      id: record.id,
      alias: record.alias,
      ...(record.email ? { email: record.email } : {}),
      system: false,
      active: activeId === record.id,
      ready: this.tokenExists(record.dir as string, true),
      createdAt: record.createdAt,
      ...(record.lastUsedAt === undefined ? {} : { lastUsedAt: record.lastUsedAt }),
    }
  }

  /** 只读检查登录态文件是否存在；不解析 token，避免把清单轮询变成磁盘热路径。 */
  private tokenExists(home: string, isolated: boolean): boolean {
    if (!isolated && !existsSync(home)) return false
    return existsSync(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'))
      || existsSync(join(home, '.gemini', 'antigravity-acp', 'acp_token.json'))
  }

  private activeRecordId(): string {
    const id = this.file.activeAccountId
    if (id === SYSTEM_ACCOUNT_ID) return SYSTEM_ACCOUNT_ID
    if (typeof id === 'string' && this.file.accounts.some((row) => row.id === id)) return id
    return SYSTEM_ACCOUNT_ID
  }

  private persist(): void {
    try {
      saveAccountsFile(this.baseDir, this.file, this.knownIds)
    } catch (error) {
      this.log?.warn?.('antigravity-acp: 账号列表保存失败', error)
    }
  }

  // ---- 切换 / 删除 ----

  private activate(id?: string): AccountActionResult {
    const target = id === SYSTEM_ACCOUNT_ID
      ? this.systemResolved()
      : this.file.accounts.find((row) => row.id === id)
    if (!target) throw new Error('要切换的账号不存在')
    this.file.activeAccountId = id === SYSTEM_ACCOUNT_ID ? SYSTEM_ACCOUNT_ID : target.id
    if (id !== SYSTEM_ACCOUNT_ID && 'lastUsedAt' in target) target.lastUsedAt = this.now()
    this.persist()
    this.onChange?.()
    const name = id === SYSTEM_ACCOUNT_ID ? SYSTEM_ACCOUNT_ALIAS : (target as AccountRecord).alias
    return { snapshot: this.snapshot(), message: `已切换到「${name}」；新建连接将使用该账号` }
  }

  private async remove(id?: string): Promise<AccountActionResult> {
    if (id === SYSTEM_ACCOUNT_ID) throw new Error('系统账号不能删除')
    const index = this.file.accounts.findIndex((row) => row.id === id)
    if (index < 0) throw new Error('要删除的账号不存在')
    const record = this.file.accounts[index] as AccountRecord
    const wasActive = this.activeRecordId() === record.id
    if (this.login?.target.id === record.id) this.cancelLogin()
    this.file.accounts.splice(index, 1)
    if (wasActive) this.file.activeAccountId = SYSTEM_ACCOUNT_ID
    this.persist()
    // 只删除本插件在账号根目录下创建的目录；store 加载时已校验包含性。
    if (record.dir && existsSync(record.dir)) {
      await rm(record.dir, { recursive: true, force: true }).catch((error) => {
        this.log?.warn?.('antigravity-acp: 删除账号目录失败', error)
      })
    }
    this.onChange?.()
    return {
      snapshot: this.snapshot(),
      message: wasActive ? `已删除「${record.alias}」；当前账号回到系统账号` : `已删除「${record.alias}」`,
    }
  }

  // ---- 登录 ----

  private beginAdd(alias?: string): AccountActionResult {
    this.assertNoLogin()
    const id = `acc_${this.randomId()}`
    if (!isValidAccountId(id)) throw new Error('无法生成合法的账号 id')
    const staging = accountDirFor(this.baseDir, `staging_${id}`)
    const finalDir = accountDirFor(this.baseDir, id)
    const target: LoginTarget = {
      kind: 'add',
      id,
      ...(alias?.trim() ? { alias: alias.trim().slice(0, 80) } : {}),
      staging,
      home: staging,
    }
    void this.runLogin(target, finalDir)
    return { snapshot: this.snapshot(), message: '正在准备浏览器授权…' }
  }

  private beginRelogin(id?: string): AccountActionResult {
    this.assertNoLogin()
    if (id === SYSTEM_ACCOUNT_ID) {
      throw new Error('系统账号使用本机官方 CLI 的登录态，请在官方 agy 中登录后重新导入，本面板不会改写它')
    }
    const record = this.file.accounts.find((row) => row.id === id)
    if (!record) throw new Error('要登录的账号不存在')
    const target: LoginTarget = { kind: 'relogin', id: record.id, home: record.dir as string }
    void this.runLogin(target)
    return { snapshot: this.snapshot(), message: '正在准备浏览器授权…' }
  }

  /** 登录流程从 `preparing` 起就占用唯一槽位：listener 建立前的 await 窗口也不能被第二次点击穿进来。 */
  private assertNoLogin(): void {
    if (this.login || ['preparing', 'waiting', 'exchanging'].includes(this.auth.phase)) {
      throw new Error('已有登录流程正在进行，请先完成或取消')
    }
  }

  private cancelLogin(): AccountActionResult {
    if (!this.login) return { snapshot: this.snapshot(), message: '当前没有进行中的登录流程' }
    this.login.cancel()
    const target = this.login.target
    this.login = undefined
    this.setAuth({ phase: 'cancelled', message: '已取消登录' })
    if (target.staging) void rm(target.staging, { recursive: true, force: true }).catch(() => undefined)
    this.onChange?.()
    return { snapshot: this.snapshot(), message: '已取消登录' }
  }

  private setAuth(auth: AccountAuthView): void {
    this.auth = auth
    if (this.authReset !== undefined) clearTimeout(this.authReset)
    this.authReset = undefined
    if (auth.phase === 'done' || auth.phase === 'failed' || auth.phase === 'cancelled') {
      this.authReset = setTimeout(() => {
        if (this.auth.phase === auth.phase) this.auth = { phase: 'idle' }
      }, auth.phase === 'done' ? 20_000 : 60_000)
      this.authReset.unref?.()
    }
  }

  private async runLogin(target: LoginTarget, finalDir?: string): Promise<void> {
    try {
      this.setAuth({ phase: 'preparing', message: '正在准备浏览器授权…', accountId: target.id })
      const client = (await this.resolveClient?.().catch(() => undefined)) ?? fallbackLoginClient()
      const { verifier, challenge } = generatePkce()
      const state = randomBytes(16).toString('hex')
      let listener: CallbackListener
      try {
        listener = await startCallbackListener({ port: this.loginPort, timeoutMs: this.loginTimeoutMs, expectedState: state })
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
        if (code === 'EADDRINUSE') {
          throw new Error('本机登录回调端口 51121 已被占用；请关闭占用该端口的程序（可能是另一个 DSH 或官方登录窗口）后重试')
        }
        throw error
      }
      if (this.disposed) {
        await listener.close()
        return
      }
      // 授权链接与换码使用同一个 redirect_uri；生产端口固定 51121，测试可让系统分配。
      const redirectUri = `http://localhost:${listener.port}${OAUTH_CALLBACK_PATH}`
      const authUrl = buildAuthorizeUrl({ clientId: client.clientId, challenge, state, redirectUri })
      this.login = {
        target,
        verifier,
        redirectUri,
        listener,
        cancel: () => {
          listener.cancel('已取消登录')
        },
      }
      this.setAuth({ phase: 'waiting', authUrl, message: '等待浏览器授权…', accountId: target.id, startedAt: this.now() })
      const opened = await this.openBrowser?.(authUrl).catch(() => false)
      if (opened === false) {
        this.log?.warn?.('antigravity-acp: 未能自动打开浏览器，请在面板中点击授权链接')
      }
      let callback
      try {
        callback = await listener.result
      } catch (error) {
        if (this.auth.phase === 'cancelled') return
        throw error
      }
      if (this.login?.target.id !== target.id) return
      this.setAuth({ phase: 'exchanging', message: '已收到授权，正在换取登录态…', accountId: target.id, startedAt: this.auth.startedAt })
      const tokens = await exchangeCode({ code: callback.code, verifier, client, fetchImpl: this.fetchImpl, redirectUri: this.login?.redirectUri })
      // 换码期间用户可能点了取消：不再落地 token，也不提交账号。
      if (this.login?.target.id !== target.id) {
        if (target.staging) void rm(target.staging, { recursive: true, force: true }).catch(() => undefined)
        return
      }
      if (!tokens.refreshToken) throw new Error('Google 未返回 refresh_token；请重新授权并确认 consent')
      const email = await fetchUserEmail(tokens.accessToken, this.fetchImpl)
      // 新增账号先写到暂存 HOME，拿到 token 后整体改名；登录态文件与 ACP 文件
      // 都落在最终目录里，避免客户端看到「账号存在但 HOME 指向暂存目录」。
      let tokenHome = target.staging ?? target.home
      await mkdir(join(tokenHome, '.gemini'), { recursive: true })
      await writeCliTokenFile(tokenHome, tokens)
      if (target.kind === 'add') {
        const dir = finalDir as string
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
        await mkdir(join(this.baseDir), { recursive: true })
        await rename(target.staging as string, dir)
        tokenHome = dir
      }
      const prepared = await this.prepareCredentials(tokenHome, client, tokens)
      if (this.login?.target.id !== target.id) {
        if (target.kind === 'add') void rm(tokenHome, { recursive: true, force: true }).catch(() => undefined)
        return
      }
      let autoActivated = false
      if (target.kind === 'add') {
        autoActivated = await this.commitNewAccount(target, tokenHome, email)
      } else {
        const record = this.file.accounts.find((row) => row.id === target.id)
        if (record) {
          if (email) record.email = email
          this.persist()
        }
      }
      this.revisions.set(target.id, (this.revisions.get(target.id) ?? 0) + 1)
      this.login = undefined
      const doneMessage = prepared.ready
        ? (autoActivated ? '登录成功，已切换到该账号' : '登录成功；点「使用此账号」切换')
        : `登录成功，但 ACP 登录态写入失败：${prepared.note ?? '未知原因'}`
      this.setAuth({ phase: 'done', message: doneMessage, accountId: target.id })
      this.onChange?.()
    } catch (error) {
      this.login = undefined
      if (this.disposed) return
      const message = error instanceof Error ? error.message : String(error)
      this.setAuth({ phase: 'failed', message, accountId: target.id })
      if (target.staging) void rm(target.staging, { recursive: true, force: true }).catch(() => undefined)
      this.log?.warn?.('antigravity-acp: 账号登录失败', error)
    }
  }

  /** 把刚拿到的登录态写成 ACP server 需要的两个文件；未注入时视为成功。 */
  private async prepareCredentials(home: string, client: OAuthClientMeta, tokens: TokenSet): Promise<{ ready: boolean; note?: string }> {
    if (!this.writeCredentials) return { ready: true }
    try {
      await this.writeCredentials({ home, client, tokens })
      return { ready: true }
    } catch (error) {
      return { ready: false, note: error instanceof Error ? error.message : String(error) }
    }
  }

  private async commitNewAccount(target: LoginTarget, dir: string, email: string | undefined): Promise<boolean> {
    const count = this.file.accounts.length + 2
    const record: AccountRecord = {
      id: target.id,
      alias: target.alias ?? `账号 ${count}`,
      ...(email ? { email } : {}),
      dir,
      createdAt: this.now(),
    }
    this.file.accounts.push(record)
    this.knownIds.add(record.id)
    // 原来的当前账号没有可用登录态时，新账号自动成为当前账号；否则保持用户选择。
    const activeId = this.activeRecordId()
    const activeReady = activeId === SYSTEM_ACCOUNT_ID
      ? this.tokenExists(this.homeDir, false)
      : this.tokenExists(this.file.accounts.find((row) => row.id === activeId)?.dir as string, true)
    if (!activeReady) {
      this.file.activeAccountId = record.id
      record.lastUsedAt = this.now()
    }
    this.persist()
    return !activeReady
  }
}
