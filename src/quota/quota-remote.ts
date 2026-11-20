/**
 * 额度 remote：把 `src/runtime/quota.ts` 的套餐额度快照经 Typert Gateway 暴露给
 * 浏览器端药丸（`remote.agyQuota.read`）。
 *
 * 接线手法参考 dsh-subusage（同宿主上已验证可用）：Service 继承
 * `TypertRemoteService`，再向 `typert.register` 提交 generated-contribution
 * 形态的 `invocations` 描述符。描述符按 `@deepseek-ai/dsh-typert-protocol`
 * 的 `InvocationDescriptor` / `TypertCodec` 实际类型书写，不臆造字段。
 *
 * `typert.register` 的 contribution 形态（package/face/schemas/model/invocations）
 * 以已安装壳的 `TypertContribution` 与 dsh-subusage 0.13.3 的实际调用为准；本包
 * 工作区依赖的 dsh-typert-protocol 只导出窄契约，故此处用结构化接口 + 类型守卫
 * 收窄，不用 `any` 掩盖。
 */
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { InvocationDescriptor, TypertCodec, TypertSchema } from '@deepseek-ai/dsh-typert-protocol'
import { fetchQuotaSnapshot, QuotaError, QUOTA_CACHE_MS } from '../runtime/quota.js'
import type { CreditsSnapshot, QuotaDeps, QuotaSnapshot } from '../runtime/quota.js'
import { fetchAgyCredits } from '../runtime/credits.js'
import { fetchAgyUsage } from '../runtime/agy-cli.js'
import type { CliRun } from '../runtime/agy-cli.js'
import type { SettingsControl, AccountSnapshot, ModelSnapshot } from './control.js'
import { redactSensitiveText } from '../runtime/redact.js'
import { ACCOUNT_ADMIN_ACTIONS, CLI_INSTALL_ACTIONS } from '../accounts/types.js'
import type { AccountAdminAction, AccountAdminRequest } from '../accounts/types.js'
import type { AccountsManager } from '../accounts/manager.js'

export const PACKAGE_NAME = 'dsh-bundle-antigravity-acp'
/** Typert service / wire namespace。 */
export const AGY_QUOTA_SERVICE = 'agyQuota'

/** `read` 的请求体：`force` 绕过缓存；`source` 标记调用来源。 */
export interface AgYQuotaRequest {
  force?: boolean
  source?: 'acp'
  model?: string
  /** 指定账号；省略时按当前账号取数（药丸行为）。 */
  accountId?: string
}

/** 结构化校验：失败抛 TypeError，交由 Gateway 转成 RemoteError。 */
function parseRequest(value: unknown): AgYQuotaRequest | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid AgYQuotaRequest')
  const record = value as Record<string, unknown>
  const force = record.force
  const source = record.source
  if (force !== undefined && typeof force !== 'boolean') throw new TypeError('Invalid AgYQuotaRequest.force')
  if (source !== undefined && source !== 'acp') throw new TypeError('Invalid AgYQuotaRequest.source')
  const model = record.model
  if (model !== undefined && (typeof model !== 'string' || !model.trim())) throw new TypeError('Invalid AgYQuotaRequest.model')
  const accountId = record.accountId
  if (accountId !== undefined && (typeof accountId !== 'string' || !accountId.trim())) throw new TypeError('Invalid AgYQuotaRequest.accountId')
  return {
    ...(force === undefined ? {} : { force }),
    ...(source === undefined ? {} : { source }),
    ...(model === undefined ? {} : { model }),
    ...(accountId === undefined ? {} : { accountId }),
  }
}

function parseResult(value: unknown): QuotaSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid AgYQuotaResult')
  const record = value as Record<string, unknown>
  if (record.status !== 'ok' && record.status !== 'error') throw new TypeError('Invalid AgYQuotaResult.status')
  if (typeof record.updatedAt !== 'string') throw new TypeError('Invalid AgYQuotaResult.updatedAt')
  if (!Array.isArray(record.groups)) throw new TypeError('Invalid AgYQuotaResult.groups')
  return value as QuotaSnapshot
}

function strictCodec(typeSymbol: string, parse: (value: unknown) => unknown): TypertCodec {
  const schema: TypertSchema = { parse }
  return { mode: 'strict', typeSymbol, create: () => schema }
}

const requestCodec = strictCodec(`${PACKAGE_NAME}#AgYQuotaRequest`, parseRequest)
const resultCodec = strictCodec(`${PACKAGE_NAME}#AgYQuotaResult`, parseResult)

const ACP_ACCOUNT_ACTIONS = ['status', 'login', 'warmup', 'cancel'] as const
type AcpAccountAction = typeof ACP_ACCOUNT_ACTIONS[number]

function isAdminAction(value: unknown): value is AccountAdminAction {
  return typeof value === 'string' && (ACCOUNT_ADMIN_ACTIONS as readonly string[]).includes(value)
}

function isCliInstallAction(value: unknown): boolean {
  return typeof value === 'string' && (CLI_INSTALL_ACTIONS as readonly string[]).includes(value)
}

function parseAccountRequest(value: unknown): { action: AcpAccountAction | AccountAdminAction | 'install-cli'; id?: string; alias?: string } {
  if (value === undefined) return { action: 'status' }
  if (!value || typeof value !== 'object' || !('action' in value)) throw new TypeError('Invalid AgYAccountRequest')
  const record = value as Record<string, unknown>
  const action = record.action
  if (!(ACP_ACCOUNT_ACTIONS as readonly unknown[]).includes(action) && !isAdminAction(action) && !isCliInstallAction(action)) {
    throw new TypeError('Invalid AgYAccountRequest.action')
  }
  const id = record.id
  if (id !== undefined && (typeof id !== 'string' || !id.trim())) throw new TypeError('Invalid AgYAccountRequest.id')
  const alias = record.alias
  if (alias !== undefined && typeof alias !== 'string') throw new TypeError('Invalid AgYAccountRequest.alias')
  return {
    action: action as AcpAccountAction | AccountAdminAction | 'install-cli',
    ...(id === undefined ? {} : { id }),
    ...(alias === undefined ? {} : { alias: alias.slice(0, 80) }),
  }
}
function parseAccount(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('state' in value) || !('message' in value)
    || !['idle', 'connecting', 'cancelling', 'connected', 'cancelled', 'error'].includes(String(value.state))
    || typeof value.message !== 'string') throw new TypeError('Invalid AgYAccountResult')
  return value
}
function parseModels(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('models' in value) || !Array.isArray(value.models)
    || !('status' in value) || !['ok', 'error'].includes(String(value.status))) throw new TypeError('Invalid AgYModelsResult')
  return value
}

/** 本包贡献的 invocation 描述符（直连一元调用）。 */
export const AGY_QUOTA_INVOCATIONS: readonly InvocationDescriptor[] = [
  {
    id: `${PACKAGE_NAME}#${AGY_QUOTA_SERVICE}/read`,
    service: AGY_QUOTA_SERVICE,
    namespace: AGY_QUOTA_SERVICE,
    method: 'read',
    invocation: { kind: 'direct' },
    parameters: [
      { name: 'request', wire: 'request', source: 'json', acceptsUndefined: true, codec: requestCodec },
    ],
    result: resultCodec,
  },
  ...(['account', 'models'] as const).map((method): InvocationDescriptor => ({
    id: `${PACKAGE_NAME}#${AGY_QUOTA_SERVICE}/${method}`,
    service: AGY_QUOTA_SERVICE, namespace: AGY_QUOTA_SERVICE, method,
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: true,
      codec: method === 'account' ? strictCodec(`${PACKAGE_NAME}#AgYAccountRequest`, parseAccountRequest) : requestCodec }],
    result: method === 'account' ? strictCodec(`${PACKAGE_NAME}#AgYAccountResult`, parseAccount) : strictCodec(`${PACKAGE_NAME}#AgYModelsResult`, parseModels),
  })),
]

/** 宿主 typert 注册面（对准已安装壳的 TypertContribution 形态）。 */
interface TypertContribution {
  readonly package: string
  readonly face: 'host' | 'client'
  readonly schemas: readonly unknown[]
  readonly model: {
    readonly services: readonly unknown[]
    readonly events: readonly unknown[]
    readonly objects: readonly unknown[]
  }
  readonly invocations: readonly InvocationDescriptor[]
}

interface HostTypertRegistrar {
  register(contribution: TypertContribution): () => void | Promise<void>
}

function isRegistrar(value: unknown): value is HostTypertRegistrar {
  return typeof value === 'object' && value !== null
    && typeof (value as { register?: unknown }).register === 'function'
}

/** 把 contribution 提交给 Gateway；typert 服务缺席时静默跳过（无 Web 的 profile 也能加载）。 */
export function registerAgYQuotaRemote(ctx: Context): void {
  ctx.inject(['typert'], (scope) => {
    scope.effect(() => {
      const candidate: unknown = scope.get('typert')
      if (!isRegistrar(candidate)) {
        // 必须留痕：typert 缺席时以前是「静默跳过」，出问题时无法与「注册成功但
        // 客户端没挂上」区分（2026-10-17 排查额度药丸就卡在这里）。
        ctx.logger?.warn?.('antigravity-acp: typert 服务不可用，额度 remote 未注册')
        return () => undefined
      }
      let dispose: () => void | Promise<void>
      try {
        dispose = candidate.register({
          package: PACKAGE_NAME,
          face: 'host',
          schemas: [],
          model: { services: [], events: [], objects: [] },
          invocations: [...AGY_QUOTA_INVOCATIONS],
        })
      } catch (error) {
        ctx.logger?.warn?.('antigravity-acp: 额度 remote 注册失败', error)
        return () => undefined
      }
      ctx.logger?.info?.(
        `antigravity-acp: 额度 remote 已注册（package=${PACKAGE_NAME} service=${AGY_QUOTA_SERVICE} method=read）`,
      )
      return dispose
    }, 'antigravity-acp: quota remote')
  })
}

export interface AgYQuotaServiceOptions {
  control?: SettingsControl

  /** 测试注入面（fetch/文件/时钟等），生产不传。 */
  deps?: QuotaDeps
  /**
   * 官方 CLI 只读取数通道（`agy -p /usage` 与 `agy -p /credits`）。
   * 仅当 {@link cliQuotaEnabled} 返回 true 时才会被使用；缺省 / 关闭时
   * 默认不 spawn agy（套餐额度走内置直连，AI Credits 不查询）。
   */
  cli?: { run: CliRun; cliPath: string }
  /** Re-detect installations without restarting the host. */
  resolveCli?: () => { run: CliRun; cliPath: string } | undefined
  /** 是否允许调用本机 agy CLI 取数；默认不允许（实时读取，可随设置即时切换）。 */
  cliQuotaEnabled?: () => boolean
  /** 已保存的官方模型映射，供药丸按实际家族选择额度组。 */
  modelTarget?: (model: string) => string | undefined
  /** 多账号管理器：账号列表、登录与当前账号解析。 */
  accounts?: AccountsManager
  /**
   * 一键安装官方 CLI（`agy`）。返回给面板的短句；失败时由实现方抛出可读错误。
   * 只在用户显式点按钮时调用，不参与任何自动流程。
   */
  installCli?: () => Promise<{ message: string }>
  /** 宿主日志（index.ts 接 `ctx.logger`）；用于记录每次取数的来源与结果。 */
  log?: { info(message: string): void; warn(message: string, error?: unknown): void }
}

/**
 * 额度取数服务：`read(request)` 返回快照，失败折叠成 `status: 'error'` 而不抛。
 *
 * 字段刻意用 TS `private` 而非 ES `#私有`：Cordis Service 的方法经 Proxy 调用，
 * `this` 是代理而非真实实例，`#x` 会抛 “Cannot read private member #x from an
 * object whose class did not declare it”。
 */
interface QuotaCacheEntry {
  value?: QuotaSnapshot
  at?: number
  credits?: CreditsSnapshot
  creditsAt?: number
  inflight?: Promise<QuotaSnapshot>
  inflightBypassed?: boolean
  readCacheStatus: { quota: boolean; credits: boolean }
  forced: boolean
}

/**
 * 额度取数服务：`read(request)` 返回快照，失败折叠成 `status: 'error'` 而不抛。
 *
 * 缓存与在途请求按「账号 + CLI 开关」分开：面板可以让多个账号各自拉取额度，
 * 互不覆盖；药丸不传 accountId 时读取当前账号。字段刻意用 TS `private` 而非
 * ES `#私有`：Cordis Service 的方法经 Proxy 调用，`this` 是代理而非真实实例。
 */
export class AgYQuotaService extends TypertRemoteService {
  private readonly _entries = new Map<string, QuotaCacheEntry>()
  private readonly _deps: QuotaDeps
  private readonly _cli: { run: CliRun; cliPath: string } | undefined
  private readonly _resolveCli: AgYQuotaServiceOptions['resolveCli']
  private readonly _cliQuotaEnabled: AgYQuotaServiceOptions['cliQuotaEnabled']
  private readonly _modelTarget: AgYQuotaServiceOptions['modelTarget']
  private readonly _log: AgYQuotaServiceOptions['log']
  private readonly _control: SettingsControl | undefined
  private readonly _accounts: AccountsManager | undefined
  private readonly _installCli: (() => Promise<{ message: string }>) | undefined

  constructor(ctx: Context, options: AgYQuotaServiceOptions = {}) {
    super(ctx, AGY_QUOTA_SERVICE)
    this._deps = options.deps ?? {}
    this._cli = options.cli
    this._resolveCli = options.resolveCli
    this._cliQuotaEnabled = options.cliQuotaEnabled
    this._modelTarget = options.modelTarget
    this._log = options.log
    this._control = options.control
    this._accounts = options.accounts
    this._installCli = options.installCli
  }

  /**
   * 账户控制 + 账号列表。ACP 的 status/login/warmup/cancel 沿用原语义；
   * 多账号动作（add-account / activate / remove / relogin …）由账号管理器处理。
   */
  async account(request?: { action?: string; id?: string; alias?: string }): Promise<AccountSnapshot> {
    const parsed = parseAccountRequest(request)
    if (isCliInstallAction(parsed.action)) {
      if (!this._installCli) throw new Error('一键安装未接入')
      const outcome = await this._installCli()
      const base: AccountSnapshot = this._control
        ? this._control.account('status')
        : { state: 'idle', message: '', updatedAt: new Date().toISOString() }
      return {
        ...base,
        ...(this._accounts ? this._accounts.snapshot() : {}),
        message: outcome.message,
      } as AccountSnapshot
    }
    if (isAdminAction(parsed.action)) {
      if (!this._accounts) throw new Error('账号管理服务未就绪')
      const result = await this._accounts.handle({
        action: parsed.action,
        ...(parsed.id === undefined ? {} : { id: parsed.id }),
        ...(parsed.alias === undefined ? {} : { alias: parsed.alias }),
      } satisfies AccountAdminRequest)
      const base: AccountSnapshot = this._control
        ? this._control.account('status')
        : { state: 'idle', message: result.message, updatedAt: new Date().toISOString() }
      return { ...base, ...result.snapshot, message: result.message, cliInstalled: this._resolveCli?.() !== undefined }
    }
    if (!this._control) throw new Error('账户控制服务未就绪')
    const snapshot = this._control.account(parsed.action as AcpAccountAction)
    const withCli: AccountSnapshot = { ...snapshot, cliInstalled: this._resolveCli?.() !== undefined }
    return this._accounts ? { ...withCli, ...this._accounts.snapshot(), cliInstalled: withCli.cliInstalled } : withCli
  }

  async models(request?: AgYQuotaRequest): Promise<ModelSnapshot> {
    if (!this._control) throw new Error('模型管理服务未就绪')
    return this._control.models(parseRequest(request)?.force === true)
  }

  /** 客户端药丸的取数入口；同一账号的并发调用合并为同一次取数。 */
  async read(request?: AgYQuotaRequest): Promise<QuotaSnapshot> {
    const requestedId = request?.accountId?.trim() || undefined
    const account = this.resolveAccount(requestedId)
    const cliOn = this.cliQuotaOn()
    const entry = this.entryFor(`${account.id}:${cliOn ? 'cli' : 'http'}`)
    const force = request?.force === true
    while (entry.inflight) {
      const existing = entry.inflight
      // force 只并入「确实在取新数」的在途读取；命中缓存的即时返回必须等它结束。
      if (!force || entry.inflightBypassed) {
        const result = await existing
        return await this.finalize(result, request, requestedId, account.id)
      }
      await existing.catch(() => undefined)
    }
    if (force) {
      // 必须在调用 _read 前失效：旧的部分读取即使刚完成，也不能把新 force 误变成缓存。
      delete entry.at
      delete entry.creditsAt
    }
    entry.forced = force
    entry.readCacheStatus = { quota: true, credits: true }
    const run = this._read(request, account, cliOn, entry)
    entry.inflight = run
    entry.inflightBypassed = !entry.readCacheStatus.quota && !entry.readCacheStatus.credits
    try {
      const result = await run
      return await this.finalize(result, request, requestedId, account.id)
    } finally {
      if (entry.inflight === run) {
        entry.inflight = undefined
        entry.inflightBypassed = false
        entry.forced = false
      }
    }
  }

  /** 未指定账号的读取若撞上账号切换，重读新账号；显式账号读原样返回。 */
  private async finalize(result: QuotaSnapshot, request: AgYQuotaRequest | undefined, requestedId: string | undefined, accountId: string): Promise<QuotaSnapshot> {
    if (requestedId === undefined && this._accounts && this._accounts.active().id !== accountId) {
      return await this.read(request)
    }
    return this.withModelRoute(result, request)
  }

  private withModelRoute(result: QuotaSnapshot, request?: AgYQuotaRequest): QuotaSnapshot {
    if (!request?.model) return result
    return { ...result, requestedModel: request.model, routeModel: this._modelTarget?.(request.model) || request.model }
  }

  /** 用户是否显式允许调用本机 agy CLI 取数；默认不允许。 */
  private cliQuotaOn(): boolean {
    return this._cliQuotaEnabled?.() === true
  }

  private entryFor(key: string): QuotaCacheEntry {
    let entry = this._entries.get(key)
    if (!entry) {
      entry = { readCacheStatus: { quota: true, credits: true }, forced: false }
      this._entries.set(key, entry)
    }
    return entry
  }

  /** 解析账号（显式 id 或当前账号）；没有账号管理器时退化为单一本机账号。 */
  private resolveAccount(id?: string): { id: string; home?: string } {
    if (!this._accounts) return { id: 'primary' }
    const found = id ? this._accounts.resolve(id) : this._accounts.active()
    if (!found) throw new Error('账号不存在或已删除')
    return { id: found.id, home: found.home }
  }

  private depsFor(home: string | undefined): QuotaDeps {
    if (!home) return this._deps
    return { ...this._deps, homedir: () => home }
  }

  private async _read(
    request: AgYQuotaRequest | undefined,
    account: { id: string; home?: string },
    cliOn: boolean,
    entry: QuotaCacheEntry,
  ): Promise<QuotaSnapshot> {
    // 这条日志让「药丸到底有没有把请求发到 Host、读的是哪个账号」可证。
    const cli = cliOn ? (this._resolveCli?.() ?? this._cli) : undefined
    const source = cli ? `cli=${redactSensitiveText(cli.cliPath)}`
      : cliOn ? 'http（已开启 CLI 取数但未找到 agy CLI）'
        : 'http（未开启 agy CLI 取数）'
    this._log?.info(`antigravity-acp: 额度取数请求（账号 ${account.id}，force=${request?.force === true}，来源 ${source}）`)
    try {
      if (cliOn && !cli) {
        throw new Error('已开启 cliQuotaEnabled 但找不到 agy CLI：请配置 agyCliPath，或关闭该开关（不再回落到 HTTP 取数）')
      }
      const now = Date.now()
      // 双路 CLI 的完成时间可能不同：本轮时间戳必须一致，且不能早于请求开始。
      const fetchedAt = Math.max(now, entry.at ?? 0, entry.creditsAt ?? 0)
      const cached = entry.value
      const previousCredits = entry.credits
      const forced = entry.forced === true
      const quotaCached = !forced && Boolean(cached && entry.at !== undefined && now - entry.at < QUOTA_CACHE_MS && cached.status === 'ok' && cached.stale !== true)
      const creditsCached = !forced && Boolean(previousCredits && entry.creditsAt !== undefined && now - entry.creditsAt < QUOTA_CACHE_MS && previousCredits.status !== 'error' && !previousCredits.stale)
      entry.readCacheStatus = { quota: quotaCached, credits: creditsCached }
      if (quotaCached && creditsCached) {
        this._log?.info('antigravity-acp: 套餐额度与余额命中独立缓存')
        return { ...cached!, credits: previousCredits }
      }
      const previous = entry.value
      const [fresh, freshCredits] = await Promise.all([
        quotaCached ? Promise.resolve(cached!)
          : cli
            ? fetchAgyUsage(cli.run, cli.cliPath, account.home)
            : fetchQuotaSnapshot(entry, this.depsFor(account.home)),
        creditsCached ? Promise.resolve(previousCredits!) : cli
          ? fetchAgyCredits(cli.run, cli.cliPath, account.home)
          : Promise.resolve<CreditsSnapshot>({ status: 'unavailable', updatedAt: new Date().toISOString(), error: {
            code: cliOn ? 'cli-unavailable' : 'cli-disabled',
            message: cliOn
              ? '未找到官方 agy CLI，无法查询 AI Credits'
              : '未开启 agy CLI 取数，不查询 AI Credits。在设置页「账号」的「额度取数方式」打开「用 agy CLI 查询额度」并保存后才会调用本机 agy。',
          } }),
      ])
      // 刷新失败就如实报错：不再把上一次成功的数据当「stale」继续展示。
      const credits: CreditsSnapshot = freshCredits
      entry.credits = credits
      if (credits.status === 'error') delete entry.creditsAt
      else if (!creditsCached) entry.creditsAt = fetchedAt
      const snapshot: QuotaSnapshot = fresh
      entry.value = snapshot
      if (snapshot.status === 'error') delete entry.at
      else if (!quotaCached) entry.at = fetchedAt
      this._log?.info(
        `antigravity-acp: 额度取数结果（账号 ${account.id}）status=${snapshot.status} 组数=${snapshot.groups.length}` +
          (snapshot.error ? ` 错误=${snapshot.error.code}:${snapshot.error.message.slice(0, 160)}` : ''),
      )
      return { ...snapshot, credits }
    } catch (error) {
      const message = redactSensitiveText(error instanceof Error ? error.message : String(error))
      this._log?.warn?.(`antigravity-acp: 额度取数抛异常（账号 ${account.id}）：${message}`)
      return {
        status: 'error',
        updatedAt: new Date().toISOString(),
        groups: [],
        error: { code: error instanceof QuotaError ? error.code : 'request-failed', message },
      }
    }
  }
}
