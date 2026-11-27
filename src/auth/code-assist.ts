/**
 * Cloud Code Assist HTTP 套餐额度取数（`loadCodeAssist` → `retrieveUserQuotaSummary`）。
 *
 * 只读目标账号 HOME 下的官方 CLI 登录态，过期时在内存中换发 access_token（不写回磁盘），
 * 线身份头复用 `@cortexkit/antigravity-auth-core` 的 `buildAntigravityHarnessBootstrapHeaders`。
 */
import { homedir } from 'node:os'
import { buildAntigravityHarnessBootstrapHeaders } from '@cortexkit/antigravity-auth-core'
import type { QuotaErrorCode, QuotaGroup, QuotaSnapshot } from '../shared/rpc-contract.js'
import { redactSensitiveText } from '../runtime/redact.js'
import { refreshAccessToken, resolveOAuthClient } from './oauth-client.js'
import { isTokenUsable, readCliTokenDetail } from './token-store.js'
import type { KeyringReader, TokenState } from './token-store.js'

export const CODE_ASSIST_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal'
export const QUOTA_CACHE_MS = 300_000
export const QUOTA_HTTP_TIMEOUT_MS = 20_000

export class QuotaError extends Error {
  constructor(
    readonly code: QuotaErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'QuotaError'
  }
}

export interface CodeAssistProject {
  projectId: string
  plan?: string
}

export interface CodeAssistDeps {
  fetchImpl?: typeof fetch
  readFileImpl?: (path: string) => Promise<string>
  /** 仅系统账号传入：在 CLI token 文件缺失时只读回退系统钥匙串。 */
  readKeyring?: KeyringReader
  env?: Readonly<Record<string, string | undefined>>
  now?: () => number
  homedir?: () => string
  baseUrl?: string
  tokenUrl?: string
  httpTimeoutMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalizeFraction(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return undefined
  return value
}

function effectiveTimeoutMs(deps: CodeAssistDeps): number {
  return deps.httpTimeoutMs !== undefined && deps.httpTimeoutMs > 0 ? deps.httpTimeoutMs : QUOTA_HTTP_TIMEOUT_MS
}

function describeRequestError(method: string, error: unknown, deps: CodeAssistDeps): string {
  const timeoutMs = effectiveTimeoutMs(deps)
  if (error instanceof Error && error.name === 'TimeoutError') {
    const label = timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1_000)} 秒` : `${timeoutMs} 毫秒`
    return `${method} 请求超过 ${label}未完成；请检查网络或代理设置`
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return `${method} 请求在完成前被中止`
  }
  return `请求 ${method} 失败：${redactSensitiveText(error instanceof Error ? error.message : String(error))}`
}

async function postCodeAssist(
  method: string,
  payload: Record<string, unknown>,
  accessToken: string,
  deps: CodeAssistDeps,
): Promise<Record<string, unknown>> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const base = (deps.baseUrl ?? CODE_ASSIST_BASE_URL).replace(/\/+$/, '')
  const headers: Record<string, string> = {
    ...buildAntigravityHarnessBootstrapHeaders(accessToken),
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  let response: Response
  try {
    response = await fetchImpl(`${base}:${method}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(effectiveTimeoutMs(deps)),
    })
  } catch (error) {
    throw new QuotaError('request-failed', describeRequestError(method, error, deps))
  }
  if (!response.ok) {
    throw new QuotaError('request-failed', `${method} 失败（HTTP ${response.status}）`, response.status)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new QuotaError('bad-response', '响应不是合法 JSON')
  }
  return isRecord(body) ? body : {}
}

export async function loadCodeAssist(accessToken: string, deps: CodeAssistDeps = {}): Promise<CodeAssistProject> {
  const payload = await postCodeAssist('loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } }, accessToken, deps)
  const projectId = typeof payload.cloudaicompanionProject === 'string' ? payload.cloudaicompanionProject : ''
  if (!projectId) {
    throw new QuotaError('bad-response', 'loadCodeAssist 未返回 cloudaicompanionProject')
  }
  const plan = [payload.paidTier, payload.currentTier]
    .map((tier) => (isRecord(tier) && typeof tier.name === 'string' ? tier.name : undefined))
    .find((name) => name)
  return { projectId, ...(plan ? { plan } : {}) }
}

export function parseQuotaSummary(raw: unknown): QuotaGroup[] {
  const root = isRecord(raw) ? raw : {}
  const rawGroups = Array.isArray(root.groups) ? root.groups : []
  return rawGroups.filter(isRecord).map((group) => {
    const rawBuckets = Array.isArray(group.buckets) ? group.buckets : []
    const desc = firstString(group.description)
    return {
      name: firstString(group.displayName) ?? '额度',
      ...(desc ? { description: desc } : {}),
      buckets: rawBuckets.filter(isRecord).map((bucket) => {
        const fraction = normalizeFraction(bucket.remainingFraction)
        const bDesc = firstString(bucket.description)
        const win = firstString(bucket.window)
        const reset = firstString(bucket.resetTime)
        return {
          name: firstString(bucket.displayName) ?? firstString(bucket.bucketId) ?? '额度',
          ...(bDesc ? { description: bDesc } : {}),
          ...(win ? { window: win } : {}),
          ...(fraction === undefined ? {} : { remainingFraction: fraction, remainingPct: Math.round(fraction * 10000) / 100 }),
          ...(reset ? { resetTime: reset } : {}),
          disabled: bucket.disabled === true,
        }
      }),
    }
  })
}

function failure(updatedAt: string, code: QuotaErrorCode, message: string): QuotaSnapshot {
  return { status: 'error', updatedAt, groups: [], error: { code, message: redactSensitiveText(message) } }
}

async function refreshInMemory(state: TokenState, deps: CodeAssistDeps): Promise<string> {
  if (!state.refreshToken) {
    throw new QuotaError('token-expired', 'access token 已过期且登录态缺少 refresh_token，请重新登录')
  }
  const client = resolveOAuthClient(deps.env)
  try {
    const refreshed = await refreshAccessToken({
      refreshToken: state.refreshToken,
      client,
      fetchImpl: deps.fetchImpl,
      tokenUrl: deps.tokenUrl,
      timeoutMs: effectiveTimeoutMs(deps),
      now: deps.now,
    })
    return refreshed.accessToken
  } catch (error) {
    throw new QuotaError('refresh-failed', error instanceof Error ? error.message : String(error))
  }
}

async function queryQuotaWithToken(accessToken: string, updatedAt: string, deps: CodeAssistDeps): Promise<QuotaSnapshot> {
  const project = await loadCodeAssist(accessToken, deps)
  const summary = await postCodeAssist('retrieveUserQuotaSummary', { project: project.projectId }, accessToken, deps)
  return {
    status: 'ok',
    updatedAt,
    ...(project.plan ? { plan: project.plan } : {}),
    groups: parseQuotaSummary(summary),
  }
}

/** 读取一次套餐额度快照（无内部缓存，缓存与合并由 remote/service.ts 统一管理）。 */
export async function fetchQuotaSnapshot(deps: CodeAssistDeps = {}): Promise<QuotaSnapshot> {
  const now = deps.now ?? Date.now
  const updatedAt = new Date(now()).toISOString()
  try {
    const home = (deps.homedir ?? homedir)()
    const detail = await readCliTokenDetail(home, {
      ...(deps.readFileImpl ? { readFileImpl: deps.readFileImpl } : {}),
      ...(deps.readKeyring ? { readKeyring: deps.readKeyring } : {}),
    })
    const state = detail.state
    if (!state) {
      if (detail.keyringStatus === 'denied') {
        return failure(
          updatedAt,
          'token-missing',
          '无法读取系统钥匙串中的官方 CLI 登录态（钥匙串已锁定或未授权），请解锁钥匙串或改用「添加账号」登录',
        )
      }
      const message = deps.readKeyring
        ? '读不到官方 CLI 登录态（antigravity-oauth-token 与系统钥匙串均未找到），请先用 agy 登录或改用「添加账号」'
        : '读不到官方 CLI 登录态（antigravity-oauth-token）'
      return failure(updatedAt, 'token-missing', message)
    }
    if (!state.accessToken && !state.refreshToken) {
      return failure(updatedAt, 'token-missing', '官方 CLI 登录态里没有可用 token，请先在 Antigravity 登录')
    }
    const accessToken = isTokenUsable(state, now())
      ? (state.accessToken as string)
      : await refreshInMemory(state, deps)

    try {
      return await queryQuotaWithToken(accessToken, updatedAt, deps)
    } catch (error) {
      if (error instanceof QuotaError && error.code === 'request-failed' && (error.status === 401 || error.status === 403)) {
        const freshToken = await refreshInMemory(state, deps)
        return await queryQuotaWithToken(freshToken, updatedAt, deps)
      }
      throw error
    }
  } catch (error) {
    const code: QuotaErrorCode = error instanceof QuotaError ? error.code : 'request-failed'
    const message = error instanceof Error ? error.message : String(error)
    return failure(updatedAt, code, message)
  }
}
