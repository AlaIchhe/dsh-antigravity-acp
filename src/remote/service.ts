/**
 * `remote.antigravity` 宿主 RPC 服务（v1.0 规范化接口）。
 *
 * 注意：Cordis Service 方法经 Proxy 调度，成员字段必须使用 TS `private` 而非 ES `#private`。
 */
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import {
  ANTIGRAVITY_REMOTE_INVOCATIONS,
  PACKAGE_NAME,
  REMOTE_SERVICE_NAME,
  parseAccountIdRequest,
  parseListModelsRequest,
  parseReadQuotaRequest,
  parseStartLoginRequest,
  parseSubmitCallbackRequest,
} from '../shared/rpc-contract.js'
import type {
  AccountIdRequest,
  AccountsResult,
  CreditsSnapshot,
  InstallCliResult,
  ListModelsRequest,
  ModelsResult,
  QuotaSnapshot,
  ReadQuotaRequest,
  StartLoginRequest,
  SubmitCallbackRequest,
} from '../shared/rpc-contract.js'
import { fetchQuotaSnapshot, QUOTA_CACHE_MS, QuotaError } from '../auth/code-assist.js'
import type { CodeAssistDeps } from '../auth/code-assist.js'
import { fetchAgyCredits, fetchAgyUsage } from '../runtime/agy-cli.js'
import type { CliRun } from '../runtime/agy-cli.js'
import { redactSensitiveText } from '../runtime/redact.js'
import type { AccountsManager } from '../accounts/manager.js'

interface TypertContribution {
  readonly package: string
  readonly face: 'host' | 'client'
  readonly schemas: readonly unknown[]
  readonly model: { readonly services: readonly unknown[]; readonly events: readonly unknown[]; readonly objects: readonly unknown[] }
  readonly invocations: readonly InvocationDescriptor[]
}

interface HostTypertRegistrar {
  register(contribution: TypertContribution): () => void | Promise<void>
}

function isRegistrar(value: unknown): value is HostTypertRegistrar {
  return typeof value === 'object' && value !== null && typeof (value as { register?: unknown }).register === 'function'
}

export function registerAntigravityRemote(ctx: Context): void {
  ctx.inject(['typert'], (scope) => {
    scope.effect(() => {
      const candidate: unknown = scope.get('typert')
      if (!isRegistrar(candidate)) {
        ctx.logger?.warn?.('antigravity-acp: typert 服务不可用，remote.antigravity 未注册')
        return () => undefined
      }
      try {
        const dispose = candidate.register({
          package: PACKAGE_NAME,
          face: 'host',
          schemas: [],
          model: { services: [], events: [], objects: [] },
          invocations: [...ANTIGRAVITY_REMOTE_INVOCATIONS],
        })
        ctx.logger?.info?.(`antigravity-acp: 已注册 remote.${REMOTE_SERVICE_NAME}（${ANTIGRAVITY_REMOTE_INVOCATIONS.length} 个方法）`)
        return dispose
      } catch (error) {
        ctx.logger?.warn?.('antigravity-acp: remote.antigravity 注册失败', error)
        return () => undefined
      }
    }, 'antigravity-acp: remote registration')
  })
}

export interface AntigravityRemoteOptions {
  accounts: AccountsManager
  listModels: (force: boolean) => Promise<ModelsResult>
  installCli: () => Promise<InstallCliResult>
  deps?: CodeAssistDeps
  cliQuotaEnabled?: () => boolean
  resolveCli?: () => { run: CliRun; cliPath: string } | undefined
  log?: { info(message: string): void; warn(message: string, error?: unknown): void }
}

interface QuotaCacheEntry {
  revision?: number
  quota?: QuotaSnapshot
  quotaAt?: number
  credits?: CreditsSnapshot
  creditsAt?: number
  inflight?: Promise<QuotaSnapshot>
  inflightForced?: boolean
}

export class AntigravityRemoteService extends TypertRemoteService {
  private readonly _entries = new Map<string, QuotaCacheEntry>()
  private readonly _options: AntigravityRemoteOptions

  constructor(ctx: Context, options: AntigravityRemoteOptions) {
    super(ctx, REMOTE_SERVICE_NAME)
    this._options = options
    const unsub = options.accounts.subscribe((event) => {
      if (event.kind === 'remove' || event.kind === 'login') {
        this.invalidateQuotaCache(event.accountId)
      }
    })
    ctx.effect(() => unsub)
  }

  /** 清理指定账号（或全部）额度缓存，防止重登后返回旧快照或已删账号常驻内存。 */
  invalidateQuotaCache(accountId?: string): void {
    if (accountId === undefined) {
      this._entries.clear()
      return
    }
    this._entries.delete(`${accountId}:http`)
    this._entries.delete(`${accountId}:cli`)
  }

  /* ── 账号管理 RPC ────────────────────────────────────────────────── */

  async listAccounts(): Promise<AccountsResult> {
    await this._options.accounts.refreshSystemReady()
    return this.buildAccountsResult()
  }

  async startAccountLogin(request?: StartLoginRequest): Promise<AccountsResult> {
    const parsed = parseStartLoginRequest(request)
    const outcome = await this._options.accounts.startLogin(parsed)
    return { ...outcome.snapshot, cliInstalled: this.hasCli(), message: outcome.message }
  }

  async submitAccountCallback(request?: SubmitCallbackRequest): Promise<AccountsResult> {
    const parsed = parseSubmitCallbackRequest(request)
    const outcome = this._options.accounts.submitCallback(parsed.callbackUrl)
    return { ...outcome.snapshot, cliInstalled: this.hasCli(), message: outcome.message }
  }

  async cancelAccountLogin(): Promise<AccountsResult> {
    const outcome = await this._options.accounts.cancelLogin()
    return { ...outcome.snapshot, cliInstalled: this.hasCli(), message: outcome.message }
  }

  async activateAccount(request?: AccountIdRequest): Promise<AccountsResult> {
    const parsed = parseAccountIdRequest(request)
    const outcome = this._options.accounts.activate(parsed.id)
    return { ...outcome.snapshot, cliInstalled: this.hasCli(), message: outcome.message }
  }

  async removeAccount(request?: AccountIdRequest): Promise<AccountsResult> {
    const parsed = parseAccountIdRequest(request)
    const outcome = await this._options.accounts.remove(parsed.id)
    this.invalidateQuotaCache(parsed.id)
    return { ...outcome.snapshot, cliInstalled: this.hasCli(), message: outcome.message }
  }

  /* ── 模型与 CLI 安装 RPC ─────────────────────────────────────────── */

  async listModels(request?: ListModelsRequest): Promise<ModelsResult> {
    const parsed = parseListModelsRequest(request)
    return this._options.listModels(parsed?.force === true)
  }

  async installCli(): Promise<InstallCliResult> {
    return this._options.installCli()
  }

  /* ── 套餐额度与 AI Credits RPC ───────────────────────────────────── */

  async readQuota(request?: ReadQuotaRequest): Promise<QuotaSnapshot> {
    const parsed = parseReadQuotaRequest(request)
    const requestedId = parsed?.accountId
    const account = this.resolveAccount(requestedId)
    const cliOn = this._options.cliQuotaEnabled?.() === true
    const force = parsed?.force === true
    const key = `${account.id}:${cliOn ? 'cli' : 'http'}`
    const entry = this.entryFor(key)

    while (entry.inflight) {
      const existing = entry.inflight
      if (!force || entry.inflightForced) {
        const result = await existing
        return this.finalizeQuota(result, parsed, requestedId, account.id)
      }
      await existing.catch(() => undefined)
    }

    if (force) {
      delete entry.quotaAt
      delete entry.creditsAt
    }

    const run = this.fetchQuotaForAccount(account, cliOn, entry, force)
    entry.inflight = run
    entry.inflightForced = force
    try {
      const result = await run
      return await this.finalizeQuota(result, parsed, requestedId, account.id)
    } finally {
      if (entry.inflight === run) {
        entry.inflight = undefined
        entry.inflightForced = false
      }
    }
  }

  /* ── 内部方法 ────────────────────────────────────────────────────── */

  private buildAccountsResult(message?: string): AccountsResult {
    const snap = this._options.accounts.snapshot()
    return { ...snap, cliInstalled: this.hasCli(), ...(message ? { message } : {}) }
  }

  private hasCli(): boolean {
    return this._options.resolveCli?.() !== undefined
  }

  private resolveAccount(id?: string): { id: string; home: string; system: boolean; revision: number } {
    const found = id ? this._options.accounts.resolve(id) : this._options.accounts.active()
    if (!found) throw new Error('账号不存在或已删除')
    return { id: found.id, home: found.home, system: found.system, revision: found.revision }
  }

  private entryFor(key: string): QuotaCacheEntry {
    let entry = this._entries.get(key)
    if (!entry) {
      entry = {}
      this._entries.set(key, entry)
    }
    return entry
  }

  private async finalizeQuota(
    result: QuotaSnapshot,
    request: ReadQuotaRequest | undefined,
    requestedId: string | undefined,
    accountId: string,
  ): Promise<QuotaSnapshot> {
    if (requestedId === undefined && this._options.accounts.active().id !== accountId) {
      return this.readQuota(request)
    }
    return request?.model ? { ...result, requestedModel: request.model } : result
  }

  private async fetchQuotaForAccount(
    account: { id: string; home: string; system: boolean; revision: number },
    cliOn: boolean,
    entry: QuotaCacheEntry,
    force: boolean,
  ): Promise<QuotaSnapshot> {
    const cli = cliOn ? this._options.resolveCli?.() : undefined
    this._options.log?.info(
      `antigravity-acp: 额度取数（账号=${account.id}，force=${force}，方式=${cliOn ? (cli ? 'cli' : 'cli-missing') : 'http'}）`,
    )
    try {
      if (cliOn && !cli) {
        throw new Error('已开启 cliQuotaEnabled 但找不到 agy CLI：请配置 agyCliPath 或关闭该开关（不回落 HTTP）')
      }
      const now = Date.now()
      const sameRevision = entry.revision === account.revision
      const quotaCached = !force && sameRevision && entry.quota !== undefined && entry.quotaAt !== undefined
        && now - entry.quotaAt < QUOTA_CACHE_MS && entry.quota.status === 'ok'
      const creditsCached = !force && sameRevision && entry.credits !== undefined && entry.creditsAt !== undefined
        && now - entry.creditsAt < QUOTA_CACHE_MS && entry.credits.status !== 'error'

      if (quotaCached && creditsCached) {
        return { ...entry.quota!, credits: entry.credits }
      }

      const httpDeps = {
        ...(this._options.deps ?? {}),
        homedir: () => account.home,
        readKeyring: account.system ? this._options.deps?.readKeyring : undefined,
      }

      const [freshQuota, freshCredits] = await Promise.all([
        quotaCached
          ? Promise.resolve(entry.quota!)
          : cli
            ? fetchAgyUsage(cli.run, cli.cliPath, account.home)
            : fetchQuotaSnapshot(httpDeps),
        creditsCached
          ? Promise.resolve(entry.credits!)
          : cli
            ? fetchAgyCredits(cli.run, cli.cliPath, account.home)
            : Promise.resolve<CreditsSnapshot>({
                status: 'unavailable',
                updatedAt: new Date(now).toISOString(),
                error: { code: 'cli-disabled', message: '未开启 cliQuotaEnabled，不查询 AI Credits' },
              }),
      ])

      entry.revision = account.revision
      entry.quota = freshQuota
      if (freshQuota.status === 'error') delete entry.quotaAt
      else if (!quotaCached) entry.quotaAt = now

      entry.credits = freshCredits
      if (freshCredits.status === 'error') delete entry.creditsAt
      else if (!creditsCached) entry.creditsAt = now

      return { ...freshQuota, credits: freshCredits }
    } catch (error) {
      const message = redactSensitiveText(error instanceof Error ? error.message : String(error))
      this._options.log?.warn(`antigravity-acp: 额度取数失败（账号=${account.id}）：${message}`)
      return {
        status: 'error',
        updatedAt: new Date().toISOString(),
        groups: [],
        error: { code: error instanceof QuotaError ? error.code : 'request-failed', message },
      }
    }
  }
}
