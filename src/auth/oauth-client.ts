/**
 * 统一的 Google OAuth 2.0 客户端：PKCE、loopback 回调、手动回调解析、
 * 授权码换 token、refresh_token 换发与用户信息查询。
 *
 * 合并原 accounts/oauth.ts 与 runtime/quota.ts 的 OAuth 逻辑：
 * - OAuth client 标识统一取环境变量覆盖或 `@cortexkit/antigravity-auth-core`，
 *   不再扫描 200MB 官方二进制正则提取；
 * - 所有网络请求复用调用方注入的 fetch（统一出网代理），错误文本全量脱敏。
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET } from '@cortexkit/antigravity-auth-core'
import { redactSensitiveText } from '../runtime/redact.js'

export const OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const OAUTH_USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo'

export const OAUTH_CALLBACK_PORT = 51121
export const OAUTH_CALLBACK_PATH = '/oauth-callback'
export const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`

/** 登录 scopes：刻意不包含 openid，避免官方 client 落入挂起的 first-party 原生 consent。 */
export const LOGIN_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
]

export const OAUTH_HTTP_TIMEOUT_MS = 20_000

export interface OAuthClientMeta {
  clientId: string
  clientSecret: string
}

/** 唯一 OAuth client 解析来源：环境变量覆盖 → `@cortexkit/antigravity-auth-core`。 */
export function resolveOAuthClient(
  env: Readonly<Record<string, string | undefined>> = process.env,
): OAuthClientMeta {
  const envId = env.AGY_OAUTH_CLIENT_ID?.trim()
  const envSecret = env.AGY_OAUTH_CLIENT_SECRET?.trim()
  if (envId && envSecret) return { clientId: envId, clientSecret: envSecret }
  return { clientId: ANTIGRAVITY_CLIENT_ID, clientSecret: ANTIGRAVITY_CLIENT_SECRET }
}

export interface PkcePair {
  verifier: string
  challenge: string
}

export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export interface AuthorizeUrlInput {
  clientId: string
  challenge: string
  state: string
  redirectUri?: string
}

export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL(OAUTH_AUTHORIZE_URL)
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', input.redirectUri ?? OAUTH_REDIRECT_URI)
  url.searchParams.set('scope', LOGIN_SCOPES.join(' '))
  url.searchParams.set('code_challenge', input.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', input.state)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  return url.toString()
}

export interface TokenSet {
  accessToken: string
  refreshToken?: string
  /** Epoch ms；token 端点未给 expires_in 时省略。 */
  expiresAt?: number
}

interface TokenPayload {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  error?: unknown
  error_description?: unknown
}

function describeTokenError(payload: TokenPayload, status: number): string {
  const code = typeof payload.error === 'string'
    ? payload.error
    : payload.error && typeof payload.error === 'object' && 'status' in payload.error
      ? String((payload.error as { status?: unknown }).status)
      : undefined
  const detail = typeof payload.error_description === 'string' ? payload.error_description : undefined
  const parts = [code, detail].filter(Boolean).join(': ')
  return redactSensitiveText(parts ? `OAuth token 端点失败（HTTP ${status}，${parts}）` : `OAuth token 端点失败（HTTP ${status}）`)
}

async function postTokenEndpoint(
  body: URLSearchParams,
  options: { fetchImpl?: typeof fetch; tokenUrl?: string; timeoutMs?: number; now?: () => number },
): Promise<TokenSet> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const url = options.tokenUrl ?? OAUTH_TOKEN_URL
  const timeoutMs = options.timeoutMs ?? OAUTH_HTTP_TIMEOUT_MS
  const now = options.now ?? Date.now
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const message = error instanceof Error && error.name === 'TimeoutError'
      ? `OAuth 请求超过 ${Math.round(timeoutMs / 1000)} 秒未完成；请检查网络或代理设置`
      : redactSensitiveText(error instanceof Error ? error.message : String(error))
    throw new Error(message)
  }
  let payload: TokenPayload
  try {
    payload = (await response.json()) as TokenPayload
  } catch {
    throw new Error(`OAuth token 端点响应不是合法 JSON（HTTP ${response.status}）`)
  }
  if (!response.ok) throw new Error(describeTokenError(payload, response.status))
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token.trim() : ''
  if (!accessToken) throw new Error('OAuth token 端点未返回 access_token')
  const refreshToken = typeof payload.refresh_token === 'string' && payload.refresh_token.trim()
    ? payload.refresh_token.trim()
    : undefined
  const expiresIn = typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in) && payload.expires_in > 0
    ? payload.expires_in
    : undefined
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresIn === undefined ? {} : { expiresAt: now() + expiresIn * 1000 }),
  }
}

export async function exchangeCode(input: {
  code: string
  verifier: string
  client: OAuthClientMeta
  redirectUri?: string
  fetchImpl?: typeof fetch
  tokenUrl?: string
  now?: () => number
}): Promise<TokenSet> {
  const body = new URLSearchParams({
    client_id: input.client.clientId,
    client_secret: input.client.clientSecret,
    code: input.code,
    code_verifier: input.verifier,
    grant_type: 'authorization_code',
    redirect_uri: input.redirectUri ?? OAUTH_REDIRECT_URI,
  })
  return postTokenEndpoint(body, input)
}

export async function refreshAccessToken(input: {
  refreshToken: string
  client: OAuthClientMeta
  fetchImpl?: typeof fetch
  tokenUrl?: string
  timeoutMs?: number
  now?: () => number
}): Promise<TokenSet> {
  const body = new URLSearchParams({
    client_id: input.client.clientId,
    client_secret: input.client.clientSecret,
    refresh_token: input.refreshToken,
    grant_type: 'refresh_token',
  })
  const tokens = await postTokenEndpoint(body, input)
  return {
    ...tokens,
    refreshToken: tokens.refreshToken ?? input.refreshToken,
  }
}

export async function fetchUserEmail(
  accessToken: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(OAUTH_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return undefined
    const payload = (await response.json()) as { email?: unknown }
    return typeof payload.email === 'string' && payload.email.trim() ? payload.email.trim() : undefined
  } catch {
    return undefined
  }
}

/* ── 本机 Loopback 回调监听器 & 无头手动回调解析 ───────────────────── */

export type CallbackRejectReason = 'cancelled' | 'timeout' | 'error'

export class CallbackRejected extends Error {
  readonly reason: CallbackRejectReason
  constructor(message: string, reason: CallbackRejectReason = 'error') {
    super(message)
    this.name = 'CallbackRejected'
    this.reason = reason
  }
}

export interface CallbackResult {
  code: string
  state: string
}

export interface CallbackListener {
  port: number
  result: Promise<CallbackResult>
  close(): Promise<void>
  cancel(reason?: string): void
}

const SUCCESS_HTML = '<!doctype html><meta charset="utf-8"><title>Antigravity 授权成功</title><body style="font-family:system-ui;padding:24px"><h2>授权成功</h2><p>可以关闭此页面并返回 DeepSeek Harness。</p></body>'

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

export function startCallbackListener(options: {
  expectedState: string
  port?: number
  path?: string
  timeoutMs?: number
}): Promise<CallbackListener> {
  const path = options.path ?? OAUTH_CALLBACK_PATH
  const timeoutMs = options.timeoutMs ?? 300_000
  return new Promise((resolveListener, rejectListener) => {
    let listening = false
    let settled = false
    let resolveResult!: (value: CallbackResult) => void
    let rejectResult!: (error: Error) => void
    const result = new Promise<CallbackResult>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    // 防止在调用方 await 之前就触发 unhandledRejection。
    result.catch(() => undefined)

    let timer: ReturnType<typeof setTimeout> | undefined
    const close = (): Promise<void> => new Promise((done) => {
      if (timer) { clearTimeout(timer); timer = undefined }
      server.close(() => done())
      server.closeIdleConnections?.()
      server.closeAllConnections?.()
    })
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      if (timer) { clearTimeout(timer); timer = undefined }
      rejectResult(error)
    }
    const succeed = (value: CallbackResult): void => {
      if (settled) return
      settled = true
      if (timer) { clearTimeout(timer); timer = undefined }
      resolveResult(value)
      setTimeout(() => { void close() }, 1_000).unref?.()
    }

    const handle = (request: IncomingMessage, response: ServerResponse): void => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname !== path) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('Not found')
        return
      }
      const error = url.searchParams.get('error')
      if (error) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', connection: 'close' })
        response.end(`<h2>授权失败：${escapeHtml(error)}</h2>`)
        fail(new Error(`google oauth error: ${error}`))
        return
      }
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      if (!code || !state) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('Missing code or state')
        return
      }
      if (state !== options.expectedState) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('State mismatch')
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', connection: 'close' })
      response.end(SUCCESS_HTML)
      succeed({ code, state })
    }

    const portToBind = options.port ?? OAUTH_CALLBACK_PORT
    const server: Server = createServer(handle)
    server.once('error', (error) => {
      const err = error as NodeJS.ErrnoException
      const wrapped = err?.code === 'EADDRINUSE'
        ? new Error(`端口 ${portToBind} 已被占用（EADDRINUSE），请关闭占用该端口的程序或稍后重试`)
        : (error instanceof Error ? error : new Error(String(error)))
      if (!listening) rejectListener(wrapped)
      else fail(wrapped)
    })
    server.listen(portToBind, '127.0.0.1', () => {
      listening = true
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : portToBind
      timer = setTimeout(() => fail(new CallbackRejected('等待浏览器授权超时', 'timeout')), timeoutMs)
      timer.unref?.()
      resolveListener({
        port,
        result,
        close,
        cancel: (reason = '登录已取消') => {
          fail(new CallbackRejected(reason, 'cancelled'))
          void close()
        },
      })
    })
  })
}

export type ManualCallbackOutcome =
  | { ok: true; code: string }
  | { ok: false; reason: string }

export function parseManualCallback(raw: string, expectedState: string): ManualCallbackOutcome {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, reason: '回调地址为空' }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, reason: '这不是一个完整地址；请粘贴浏览器地址栏里的整条 URL' }
  }
  const error = url.searchParams.get('error')
  if (error) return { ok: false, reason: `Google 返回授权错误：${error}` }
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code) return { ok: false, reason: '地址里没有 code 参数；请确认复制的是授权完成后的那条地址' }
  if (!state) return { ok: false, reason: '地址里没有 state 参数；请确认复制的是完整地址' }
  if (state !== expectedState) {
    return { ok: false, reason: 'state 不匹配：这条地址可能来自上一次登录或已过期，请重新发起登录' }
  }
  return { ok: true, code }
}
