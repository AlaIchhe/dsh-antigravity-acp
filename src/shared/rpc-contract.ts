/**
 * Host 与 Web Client 共享的 Typert RPC 契约（无 Node 依赖）。
 *
 * 1.0 破坏性重命名：统一命名空间 `remote.antigravity`，按领域拆出明确方法，
 * 不再把账号管理、CLI 安装、模型查询全部塞进 `agyQuota/account`。
 */
import type { InvocationDescriptor, TypertCodec, TypertSchema } from '@deepseek-ai/dsh-typert-protocol'

export const PACKAGE_NAME = 'dsh-bundle-antigravity-acp'
export const REMOTE_SERVICE_NAME = 'antigravity'
export const PROVIDER_ID = 'antigravity-acp'
export const SETTINGS_ENTRY_ID = 'llm-antigravity-acp'

export interface SettingsNamespaceLike {
  ns?: string
  patchId?: string
  plugin?: string
  name?: string
  revision?: number
  value?: Record<string, unknown>
}

/** 兼容精确 `llm-antigravity-acp`、带前缀 `include:llm-antigravity-acp` 及元信息匹配。 */
export function matchSettingsNamespace<T extends SettingsNamespaceLike>(
  namespaces: readonly T[] | undefined,
): T | undefined {
  if (!namespaces?.length) return undefined
  return (
    namespaces.find((item) => item?.ns === SETTINGS_ENTRY_ID)
    ?? namespaces.find((item) => typeof item?.ns === 'string' && item.ns.endsWith(`:${SETTINGS_ENTRY_ID}`))
    ?? namespaces.find((item) => item?.patchId === SETTINGS_ENTRY_ID || item?.plugin === PACKAGE_NAME || item?.name === PACKAGE_NAME)
  )
}

/* ── 共享 DTO 类型 ─────────────────────────────────────────────────── */

export type QuotaErrorCode =
  | 'token-missing'
  | 'token-expired'
  | 'refresh-unavailable'
  | 'refresh-failed'
  | 'request-failed'
  | 'bad-response'

export interface QuotaBucket {
  name: string
  description?: string
  window?: string
  remainingFraction?: number
  remainingPct?: number
  resetTime?: string
  disabled: boolean
}

export interface QuotaGroup {
  name: string
  description?: string
  buckets: QuotaBucket[]
}

export type CreditsErrorCode =
  | 'cli-disabled'
  | 'cli-unavailable'
  | 'no-credit-info'
  | 'unsupported'
  | 'request-failed'
  | 'bad-response'

export interface CreditsSnapshot {
  status: 'ok' | 'unavailable' | 'error'
  updatedAt: string
  remainingCredits?: number
  planName?: string
  error?: { code: CreditsErrorCode; message: string }
}

export interface QuotaSnapshot {
  status: 'ok' | 'error'
  updatedAt: string
  plan?: string
  groups: QuotaGroup[]
  requestedModel?: string
  credits?: CreditsSnapshot
  error?: { code: QuotaErrorCode; message: string }
}

export interface AccountView {
  id: string
  alias: string
  email?: string
  system: boolean
  active: boolean
  ready: boolean
  createdAt: number
  lastUsedAt?: number
}

export type AccountAuthPhase = 'idle' | 'preparing' | 'waiting' | 'exchanging' | 'done' | 'failed' | 'cancelled'

export interface AccountAuthView {
  phase: AccountAuthPhase
  message?: string
  authUrl?: string
  accountId?: string
  startedAt?: number
}

export interface AccountsResult {
  accounts: AccountView[]
  activeAccountId: string
  auth: AccountAuthView
  cliInstalled: boolean
  message?: string
}

export interface ModelRowView {
  id: string
  name: string
  inputModalities?: readonly string[]
}

export interface ModelsResult {
  status: 'ok' | 'error'
  models: ModelRowView[]
  message?: string
}

export interface InstallCliResult {
  installed: boolean
  message: string
}

/* ── 请求类型 ──────────────────────────────────────────────────────── */

export interface ReadQuotaRequest {
  force?: boolean
  model?: string
  accountId?: string
}

export interface ListModelsRequest {
  force?: boolean
}

export interface StartLoginRequest {
  mode: 'add' | 'relogin'
  id?: string
  alias?: string
}

export interface SubmitCallbackRequest {
  callbackUrl: string
}

export interface AccountIdRequest {
  id: string
}

/* ── 运行时严格校验（Host 与 Client 共用，杜绝漂移） ──────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strictCodec(typeSymbol: string, parse: (value: unknown) => unknown): TypertCodec {
  const schema: TypertSchema = { parse }
  return { mode: 'strict', typeSymbol, create: () => schema }
}

export function parseReadQuotaRequest(value: unknown): ReadQuotaRequest | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new TypeError('Invalid ReadQuotaRequest')
  const { force, model, accountId } = value
  if (force !== undefined && typeof force !== 'boolean') throw new TypeError('Invalid ReadQuotaRequest.force')
  if (model !== undefined && (typeof model !== 'string' || !model.trim())) throw new TypeError('Invalid ReadQuotaRequest.model')
  if (accountId !== undefined && (typeof accountId !== 'string' || !accountId.trim())) throw new TypeError('Invalid ReadQuotaRequest.accountId')
  return {
    ...(force === undefined ? {} : { force }),
    ...(model === undefined ? {} : { model: model.trim() }),
    ...(accountId === undefined ? {} : { accountId: accountId.trim() }),
  }
}

export function parseQuotaSnapshot(value: unknown): QuotaSnapshot {
  if (!isRecord(value)) throw new TypeError('Invalid QuotaSnapshot')
  if (value.status !== 'ok' && value.status !== 'error') throw new TypeError('Invalid QuotaSnapshot.status')
  if (typeof value.updatedAt !== 'string') throw new TypeError('Invalid QuotaSnapshot.updatedAt')
  if (!Array.isArray(value.groups)) throw new TypeError('Invalid QuotaSnapshot.groups')
  return value as unknown as QuotaSnapshot
}

export function parseListModelsRequest(value: unknown): ListModelsRequest | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new TypeError('Invalid ListModelsRequest')
  if (value.force !== undefined && typeof value.force !== 'boolean') throw new TypeError('Invalid ListModelsRequest.force')
  return value.force === undefined ? {} : { force: value.force }
}

export function parseModelsResult(value: unknown): ModelsResult {
  if (!isRecord(value)) throw new TypeError('Invalid ModelsResult')
  if (value.status !== 'ok' && value.status !== 'error') throw new TypeError('Invalid ModelsResult.status')
  if (!Array.isArray(value.models)) throw new TypeError('Invalid ModelsResult.models')
  return value as unknown as ModelsResult
}

export function parseStartLoginRequest(value: unknown): StartLoginRequest {
  if (!isRecord(value)) throw new TypeError('Invalid StartLoginRequest')
  if (value.mode !== 'add' && value.mode !== 'relogin') throw new TypeError('Invalid StartLoginRequest.mode')
  const { id, alias } = value
  if (id !== undefined && (typeof id !== 'string' || !id.trim())) throw new TypeError('Invalid StartLoginRequest.id')
  if (alias !== undefined && typeof alias !== 'string') throw new TypeError('Invalid StartLoginRequest.alias')
  if (value.mode === 'relogin' && !id) throw new TypeError('StartLoginRequest.id is required for relogin')
  return {
    mode: value.mode,
    ...(id === undefined ? {} : { id: id.trim() }),
    ...(alias === undefined ? {} : { alias: alias.slice(0, 80) }),
  }
}

export function parseSubmitCallbackRequest(value: unknown): SubmitCallbackRequest {
  if (!isRecord(value) || typeof value.callbackUrl !== 'string') throw new TypeError('Invalid SubmitCallbackRequest')
  return { callbackUrl: value.callbackUrl.slice(0, 4096) }
}

export function parseAccountIdRequest(value: unknown): AccountIdRequest {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) throw new TypeError('Invalid AccountIdRequest')
  return { id: value.id.trim() }
}

export function parseAccountsResult(value: unknown): AccountsResult {
  if (!isRecord(value)) throw new TypeError('Invalid AccountsResult')
  if (!Array.isArray(value.accounts)) throw new TypeError('Invalid AccountsResult.accounts')
  if (typeof value.activeAccountId !== 'string') throw new TypeError('Invalid AccountsResult.activeAccountId')
  if (!isRecord(value.auth) || typeof value.auth.phase !== 'string') throw new TypeError('Invalid AccountsResult.auth')
  if (typeof value.cliInstalled !== 'boolean') throw new TypeError('Invalid AccountsResult.cliInstalled')
  return value as unknown as AccountsResult
}

export function parseInstallCliResult(value: unknown): InstallCliResult {
  if (!isRecord(value) || typeof value.installed !== 'boolean' || typeof value.message !== 'string') {
    throw new TypeError('Invalid InstallCliResult')
  }
  return value as unknown as InstallCliResult
}

/* ── 共享 Typert Invocation 描述符 ──────────────────────────────────── */

const accountsResultCodec = strictCodec(`${PACKAGE_NAME}#AccountsResult`, parseAccountsResult)

/**
 * 构造直接 RPC 描述符。
 *
 * 注意：DSH `dsh-api-gateway` 客户端严格按 `values.length === descriptor.parameters.length`
 * 校验入参个数（`acceptsUndefined: true` 只允许显式传 `undefined`，不放行少传参数）。
 * 因此无参方法（`listAccounts` / `cancelAccountLogin` / `installCli`）必须声明 `parameters: []`。
 */
function directMethod(
  method: string,
  reqCodec: TypertCodec | undefined,
  resCodec: TypertCodec,
  acceptsUndefined = false,
): InvocationDescriptor {
  return {
    id: `${PACKAGE_NAME}#${REMOTE_SERVICE_NAME}/${method}`,
    service: REMOTE_SERVICE_NAME,
    namespace: REMOTE_SERVICE_NAME,
    method,
    invocation: { kind: 'direct' },
    parameters: reqCodec
      ? [{ name: 'request', wire: 'request', source: 'json', ...(acceptsUndefined ? { acceptsUndefined: true as const } : {}), codec: reqCodec }]
      : [],
    result: resCodec,
  }
}

export const ANTIGRAVITY_REMOTE_INVOCATIONS: readonly InvocationDescriptor[] = [
  directMethod(
    'readQuota',
    strictCodec(`${PACKAGE_NAME}#ReadQuotaRequest`, parseReadQuotaRequest),
    strictCodec(`${PACKAGE_NAME}#QuotaSnapshot`, parseQuotaSnapshot),
    true,
  ),
  directMethod(
    'listModels',
    strictCodec(`${PACKAGE_NAME}#ListModelsRequest`, parseListModelsRequest),
    strictCodec(`${PACKAGE_NAME}#ModelsResult`, parseModelsResult),
    true,
  ),
  directMethod('listAccounts', undefined, accountsResultCodec),
  directMethod(
    'startAccountLogin',
    strictCodec(`${PACKAGE_NAME}#StartLoginRequest`, parseStartLoginRequest),
    accountsResultCodec,
  ),
  directMethod(
    'submitAccountCallback',
    strictCodec(`${PACKAGE_NAME}#SubmitCallbackRequest`, parseSubmitCallbackRequest),
    accountsResultCodec,
  ),
  directMethod('cancelAccountLogin', undefined, accountsResultCodec),
  directMethod(
    'activateAccount',
    strictCodec(`${PACKAGE_NAME}#AccountIdRequest`, parseAccountIdRequest),
    accountsResultCodec,
  ),
  directMethod(
    'removeAccount',
    strictCodec(`${PACKAGE_NAME}#AccountIdRequest`, parseAccountIdRequest),
    accountsResultCodec,
  ),
  directMethod(
    'installCli',
    undefined,
    strictCodec(`${PACKAGE_NAME}#InstallCliResult`, parseInstallCliResult),
  ),
]
