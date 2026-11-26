/**
 * 多账号管理器：系统账号（真实 HOME 只读导入）+ 隔离账号（独立 HOME + OAuth 登录）。
 *
 * v1.0 直接暴露清晰领域方法（startLogin / submitCallback / cancelLogin / activate / remove），
 * 不再经过字符串 action 联合分发，统一依赖 `src/auth/`。
 */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  buildAuthorizeUrl,
  CallbackRejected,
  exchangeCode,
  fetchUserEmail,
  generatePkce,
  OAUTH_CALLBACK_PATH,
  parseManualCallback,
  resolveOAuthClient,
  startCallbackListener,
} from '../auth/oauth-client.js'
import type { CallbackListener, OAuthClientMeta, TokenSet } from '../auth/oauth-client.js'
import { ACP_HOME_SUBPATH, ACP_TOKEN_FILENAME, CLI_TOKEN_SUBPATH, writeAcpCredentialFiles, writeCliTokenFile } from '../auth/token-store.js'
import { accountDirFor, isValidAccountId, loadAccountsFile, saveAccountsFile } from './store.js'
import type { AccountsFile } from './store.js'
import {
  SYSTEM_ACCOUNT_ALIAS,
  SYSTEM_ACCOUNT_ID,
  type AccountAuthView,
  type AccountRecord,
  type AccountView,
  type ResolvedAccount,
} from './types.js'

export interface AccountsSnapshot {
  accounts: AccountView[]
  activeAccountId: string
  auth: AccountAuthView
}

export interface AccountActionResult {
  snapshot: AccountsSnapshot
  message: string
}

export interface AccountsManagerOptions {
  baseDir: string
  homeDir?: string
  now?: () => number
  randomId?: () => string
  fetchImpl?: typeof fetch
  resolveClient?: () => OAuthClientMeta
  writeCredentials?: (input: { home: string; client: OAuthClientMeta; tokens: TokenSet }) => Promise<void>
  openBrowser?: (url: string) => Promise<boolean>
  loginTimeoutMs?: number
  loginPort?: number
  onChange?: () => void
  log?: { info(message: string): void; warn(message: string, error?: unknown): void }
}

interface LoginTarget {
  kind: 'add' | 'relogin'
  id: string
  alias?: string
  staging?: string
  home: string
}

interface ActiveLogin {
  target: LoginTarget
  verifier: string
  redirectUri: string
  listener: CallbackListener
  submit(raw: string): void
  cancel(): void
}

const AUTH_TERMINAL_RESET_MS = 15_000

export class AccountsManager {
  private file: AccountsFile
  private auth: AccountAuthView = { phase: 'idle' }
  private login: ActiveLogin | undefined
  private authReset?: ReturnType<typeof setTimeout>
  private disposed = false
  private readonly revisions = new Map<string, number>()
  private readonly knownIds = new Set<string>()
  private readonly baseDir: string
  private readonly homeDir: string
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly fetchImpl: typeof fetch
  private readonly resolveClient: () => OAuthClientMeta
  private readonly writeCredentials: NonNullable<AccountsManagerOptions['writeCredentials']>
  private readonly openBrowser: AccountsManagerOptions['openBrowser']
  private readonly loginTimeoutMs: number
  private readonly loginPort: number | undefined
  private readonly onChange: (() => void) | undefined
  private readonly log: AccountsManagerOptions['log']

  constructor(options: AccountsManagerOptions) {
    this.baseDir = options.baseDir
    this.homeDir = options.homeDir ?? homedir()
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? (() => `acc_${this.now()}_${randomBytes(4).toString('hex')}`)
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.resolveClient = options.resolveClient ?? (() => resolveOAuthClient())
    this.writeCredentials = options.writeCredentials ?? (async ({ home, client, tokens }) => {
      await writeAcpCredentialFiles(home, client, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        ...(tokens.expiresAt === undefined ? {} : { expiry: new Date(tokens.expiresAt).toISOString() }),
      })
    })
    this.openBrowser = options.openBrowser
    this.loginTimeoutMs = options.loginTimeoutMs ?? 300_000
    this.loginPort = options.loginPort
    this.onChange = options.onChange
    this.log = options.log
    this.file = loadAccountsFile(this.baseDir)
    for (const row of this.file.accounts) this.knownIds.add(row.id)
    this.cleanupStagingDirs()
  }

  snapshot(): AccountsSnapshot {
    this.syncFromDisk()
    const activeId = this.activeRecordId()
    const system: AccountView = {
      id: SYSTEM_ACCOUNT_ID,
      alias: SYSTEM_ACCOUNT_ALIAS,
      system: true,
      active: activeId === SYSTEM_ACCOUNT_ID,
      ready: this.tokenExists(this.homeDir, false),
      createdAt: 0,
    }
    const isolated: AccountView[] = this.file.accounts.map((row) => ({
      id: row.id,
      alias: row.alias,
      ...(row.email ? { email: row.email } : {}),
      system: false,
      active: activeId === row.id,
      ready: row.dir ? this.tokenExists(row.dir, true) : false,
      createdAt: row.createdAt,
      ...(row.lastUsedAt === undefined ? {} : { lastUsedAt: row.lastUsedAt }),
    }))
    return {
      accounts: [system, ...isolated],
      activeAccountId: activeId,
      auth: { ...this.auth },
    }
  }

  active(): ResolvedAccount {
    this.syncFromDisk()
    const id = this.activeRecordId()
    return this.resolve(id) ?? this.systemResolved()
  }

  resolve(id: string): ResolvedAccount | undefined {
    this.syncFromDisk()
    if (id === SYSTEM_ACCOUNT_ID) return this.systemResolved()
    const found = this.file.accounts.find((row) => row.id === id)
    if (!found || !found.dir) return undefined
    return {
      id: found.id,
      alias: found.alias,
      system: false,
      home: found.dir,
      dir: found.dir,
      revision: this.revisions.get(found.id) ?? 0,
    }
  }

  async startLogin(input: { mode: 'add' | 'relogin'; id?: string; alias?: string }): Promise<AccountActionResult> {
    if (this.disposed) throw new Error('账号服务已卸载')
    if (this.login) {
      throw new Error('已有一条登录流程在进行中；请先完成或取消当前登录')
    }
    let target: LoginTarget
    if (input.mode === 'relogin') {
      const id = input.id?.trim() ?? ''
      if (id === SYSTEM_ACCOUNT_ID) throw new Error('系统账号使用本机官方 CLI 登录态，请在终端执行 agy 登录')
      const record = this.file.accounts.find((row) => row.id === id)
      if (!record || !record.dir) throw new Error('账号不存在或已删除')
      target = { kind: 'relogin', id: record.id, alias: record.alias, home: record.dir }
    } else {
      const id = this.randomId()
      if (!isValidAccountId(id)) throw new Error('生成的账号标识不合法')
      const finalDir = accountDirFor(this.baseDir, id)
      const staging = join(this.baseDir, `.staging-${id}`)
      const alias = input.alias?.trim().slice(0, 80) || undefined
      target = { kind: 'add', id, ...(alias ? { alias } : {}), staging, home: finalDir }
    }

    this.setAuth({ phase: 'preparing', message: '正在准备授权流程…', accountId: target.id, startedAt: this.now() })
    const pkce = generatePkce()
    const state = randomBytes(16).toString('hex')
    const client = this.resolveClient()

    let listener: CallbackListener
    try {
      listener = await startCallbackListener({
        expectedState: state,
        ...(this.loginPort === undefined ? {} : { port: this.loginPort }),
        timeoutMs: this.loginTimeoutMs,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setAuth({ phase: 'failed', message: `无法启动本机授权回调监听：${message}`, accountId: target.id })
      throw new Error(`无法启动本机授权回调监听：${message}`)
    }

    const redirectUri = `http://localhost:${listener.port}${OAUTH_CALLBACK_PATH}`
    const authUrl = buildAuthorizeUrl({ clientId: client.clientId, challenge: pkce.challenge, state, redirectUri })

    let manualResolve!: (code: string) => void
    const manualPromise = new Promise<{ code: string; state: string }>((resolve) => {
      manualResolve = (code) => resolve({ code, state })
    })

    const active: ActiveLogin = {
      target,
      verifier: pkce.verifier,
      redirectUri,
      listener,
      submit: (raw: string) => {
        const parsed = parseManualCallback(raw, state)
        if (!parsed.ok) throw new Error(parsed.reason)
        manualResolve(parsed.code)
      },
      cancel: () => {
        listener.cancel('登录已取消')
      },
    }
    this.login = active

    const opened = await this.openBrowser?.(authUrl).catch(() => false)
    this.setAuth({
      phase: 'waiting',
      message: opened
        ? '已打开浏览器，请在页面中完成 Google 授权…'
        : '请点击授权链接在浏览器中完成登录；无头主机可直接粘贴回调地址',
      authUrl,
      accountId: target.id,
      startedAt: this.auth.startedAt,
    })

    void this.finishLogin(active, client, Promise.race([listener.result, manualPromise]))
    return {
      snapshot: this.snapshot(),
      message: this.auth.message ?? '等待浏览器授权…',
    }
  }

  submitCallback(callbackUrl: string): AccountActionResult {
    if (!this.login) throw new Error('当前没有等待中的登录流程')
    this.login.submit(callbackUrl)
    return { snapshot: this.snapshot(), message: '已收到回调地址，正在完成登录…' }
  }

  async cancelLogin(): Promise<AccountActionResult> {
    const active = this.login
    if (!active) return { snapshot: this.snapshot(), message: '当前没有进行中的登录' }
    this.login = undefined
    active.cancel()
    await active.listener.close().catch(() => undefined)
    if (active.target.staging) void rm(active.target.staging, { recursive: true, force: true }).catch(() => undefined)
    this.setAuth({ phase: 'cancelled', message: '已取消登录', accountId: active.target.id })
    return { snapshot: this.snapshot(), message: '已取消登录' }
  }

  activate(id: string): AccountActionResult {
    this.syncFromDisk()
    if (id !== SYSTEM_ACCOUNT_ID) {
      const record = this.file.accounts.find((row) => row.id === id)
      if (!record) throw new Error('账号不存在或已删除')
      record.lastUsedAt = this.now()
    }
    this.file.activeAccountId = id
    this.persist()
    this.onChange?.()
    return { snapshot: this.snapshot(), message: '已切换当前账号（将在下次连接时生效）' }
  }

  async remove(id: string): Promise<AccountActionResult> {
    if (id === SYSTEM_ACCOUNT_ID) throw new Error('系统账号不可删除')
    this.syncFromDisk()
    const index = this.file.accounts.findIndex((row) => row.id === id)
    if (index < 0) throw new Error('账号不存在或已删除')
    const [removed] = this.file.accounts.splice(index, 1)
    if (this.file.activeAccountId === id) {
      this.file.activeAccountId = SYSTEM_ACCOUNT_ID
    }
    this.persist()
    this.revisions.delete(id)
    if (removed?.dir) {
      await rm(removed.dir, { recursive: true, force: true }).catch(() => undefined)
    }
    this.onChange?.()
    return { snapshot: this.snapshot(), message: `已删除账号「${removed?.alias ?? id}」` }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.authReset) { clearTimeout(this.authReset); this.authReset = undefined }
    const active = this.login
    this.login = undefined
    if (active) {
      active.cancel()
      await active.listener.close().catch(() => undefined)
      if (active.target.staging) await rm(active.target.staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /* ── 内部方法 ────────────────────────────────────────────────────── */

  private async finishLogin(
    active: ActiveLogin,
    client: OAuthClientMeta,
    callbackPromise: Promise<{ code: string; state: string }>,
  ): Promise<void> {
    const { target, verifier, redirectUri } = active
    try {
      const callback = await callbackPromise
      await active.listener.close().catch(() => undefined)
      if (this.login !== active || this.disposed) return

      this.setAuth({ phase: 'exchanging', message: '已收到授权，正在换取登录态…', accountId: target.id, startedAt: this.auth.startedAt })
      const tokens = await exchangeCode({
        code: callback.code,
        verifier,
        client,
        fetchImpl: this.fetchImpl,
        redirectUri,
        now: this.now,
      })
      if (this.login !== active || this.disposed) {
        if (target.staging) void rm(target.staging, { recursive: true, force: true }).catch(() => undefined)
        return
      }
      if (!tokens.refreshToken) {
        throw new Error('Google 未返回 refresh_token；请重新授权并确认 consent')
      }
      const email = await fetchUserEmail(tokens.accessToken, this.fetchImpl)

      let tokenHome = target.staging ?? target.home
      await mkdir(join(tokenHome, '.gemini'), { recursive: true })
      await writeCliTokenFile(tokenHome, tokens)

      if (target.kind === 'add') {
        await rm(target.home, { recursive: true, force: true }).catch(() => undefined)
        await mkdir(this.baseDir, { recursive: true })
        await rename(target.staging as string, target.home)
        tokenHome = target.home
      }

      let credNote: string | undefined
      try {
        await this.writeCredentials({ home: tokenHome, client, tokens })
      } catch (error) {
        credNote = error instanceof Error ? error.message : String(error)
      }

      if (this.login !== active || this.disposed) {
        if (target.kind === 'add') void rm(tokenHome, { recursive: true, force: true }).catch(() => undefined)
        return
      }

      let autoActivated = false
      if (target.kind === 'add') {
        autoActivated = this.commitNewAccount(target, tokenHome, email)
      } else {
        const record = this.file.accounts.find((row) => row.id === target.id)
        if (record) {
          if (email) record.email = email
          this.persist()
        }
      }
      this.revisions.set(target.id, (this.revisions.get(target.id) ?? 0) + 1)
      this.login = undefined
      const doneMessage = credNote
        ? `登录成功，但 ACP 登录态写入失败：${credNote}`
        : autoActivated
          ? '登录成功，已切换到该账号'
          : '登录成功；点「使用此账号」切换'
      this.setAuth({ phase: 'done', message: doneMessage, accountId: target.id })
      this.onChange?.()
    } catch (error) {
      if (this.login === active) this.login = undefined
      await active.listener.close().catch(() => undefined)
      if (target.staging) void rm(target.staging, { recursive: true, force: true }).catch(() => undefined)
      if (this.disposed) return
      if (error instanceof CallbackRejected && error.message === '登录已取消') return
      const message = error instanceof Error ? error.message : String(error)
      this.setAuth({ phase: 'failed', message, accountId: target.id })
      this.log?.warn?.('antigravity-acp: 账号登录失败', error)
    }
  }

  private commitNewAccount(target: LoginTarget, dir: string, email: string | undefined): boolean {
    this.syncFromDisk()
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
    const activeId = this.activeRecordId()
    const activeReady = activeId === SYSTEM_ACCOUNT_ID
      ? this.tokenExists(this.homeDir, false)
      : this.tokenExists(this.file.accounts.find((row) => row.id === activeId)?.dir ?? '', true)
    if (!activeReady) {
      this.file.activeAccountId = record.id
      record.lastUsedAt = this.now()
    }
    this.persist()
    return !activeReady
  }

  private setAuth(next: AccountAuthView): void {
    this.auth = next
    if (this.authReset) { clearTimeout(this.authReset); this.authReset = undefined }
    if (next.phase === 'done' || next.phase === 'cancelled') {
      this.authReset = setTimeout(() => {
        if (this.auth === next) this.auth = { phase: 'idle' }
      }, AUTH_TERMINAL_RESET_MS)
      this.authReset.unref?.()
    }
  }

  private syncFromDisk(): void {
    try {
      const latest = loadAccountsFile(this.baseDir)
      this.file = latest
      for (const row of latest.accounts) this.knownIds.add(row.id)
    } catch {
      // 保留内存快照，避免瞬时读盘失败打断运行。
    }
  }

  private persist(): void {
    saveAccountsFile(this.baseDir, this.file, this.knownIds)
  }

  private activeRecordId(): string {
    const id = this.file.activeAccountId
    if (id && id !== SYSTEM_ACCOUNT_ID && this.file.accounts.some((row) => row.id === id)) return id
    return SYSTEM_ACCOUNT_ID
  }

  private systemResolved(): ResolvedAccount {
    return {
      id: SYSTEM_ACCOUNT_ID,
      alias: SYSTEM_ACCOUNT_ALIAS,
      system: true,
      home: this.homeDir,
      revision: this.revisions.get(SYSTEM_ACCOUNT_ID) ?? 0,
    }
  }

  private tokenExists(home: string, checkAcpToken: boolean): boolean {
    if (!home) return false
    if (existsSync(join(home, ...CLI_TOKEN_SUBPATH))) return true
    return checkAcpToken && existsSync(join(home, ...ACP_HOME_SUBPATH, ACP_TOKEN_FILENAME))
  }

  private cleanupStagingDirs(): void {
    try {
      if (!existsSync(this.baseDir)) return
      for (const name of readdirSync(this.baseDir)) {
        if (name.startsWith('.staging-')) {
          rmSync(join(this.baseDir, name), { recursive: true, force: true })
        }
      }
    } catch { /* 清理失败不影响启动 */ }
  }
}
