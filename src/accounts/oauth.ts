/**
 * 面板内 OAuth 登录（Google consumer 授权码 + PKCE + 本机 loopback 回调）。
 *
 * 参考 dsh-agy-link 的账户添加流程：不依赖官方 CLI 的交互式登录，直接向 Google
 * 发起授权，拿到 refresh_token 后按官方 `agy` 的磁盘格式写进**该账号自己的 HOME**。
 * 之后由 `ensureAcpCredentials()` 导入成本插件 ACP server 认识的 `acp_token.json`。
 *
 * 安全边界：
 * - 回调只监听 127.0.0.1 的固定端口，state 必须与本次流程一致，不匹配不消费流程；
 * - 授权码换 token 走注入的 fetch（复用插件代理），错误文本先脱敏；
 * - token 只写 0600 文件，不进日志、不进客户端响应；
 * - 客户端拿到的只有授权 URL 与阶段，不返回 code / token / 文件路径。
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET } from '@cortexkit/antigravity-auth-core'
import { redactSensitiveText } from '../runtime/redact.js'

export const OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const OAUTH_USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo'

/** Antigravity 官方 loopback 回调（与 dsh-agy-link / 官方客户端一致）。 */
export const OAUTH_CALLBACK_PORT = 51121
export const OAUTH_CALLBACK_PATH = '/oauth-callback'
export const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`

/**
 * 登录 scopes。**不要加 openid**：官方 client 走 openid 会被路由到会挂起的
 * first-party 原生 consent（参考 dsh-agy-link 的实测记录）。
 */
export const LOGIN_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
]

/** 登录换发使用的 OAuth client 元数据（与 ACP 凭据换发保持同一对）。 */
export interface OAuthClientMeta {
  clientId: string
  clientSecret: string
}

/** 官方二进制里没有可审计 client 时的最后兜底（与 @cortexkit/antigravity-auth-core 同源）。 */
export function fallbackLoginClient(): OAuthClientMeta {
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
  /** Epoch ms；token 端点没给 expires_in 时省略。 */
  expiresAt?: number
}

interface TokenPayload {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  error?: unknown
  error_description?: unknown
}

function errorText(payload: TokenPayload): string {
  const code = typeof payload.error === 'string'
    ? payload.error
    : payload.error && typeof payload.error === 'object' && 'status' in payload.error
      ? String((payload.error as { status?: unknown }).status)
      : undefined
  const description = typeof payload.error_description === 'string'
    ? payload.error_description
    : payload.error && typeof payload.error === 'object' && 'message' in payload.error
      ? String((payload.error as { message?: unknown }).message)
      : undefined
  return redactSensitiveText([code, description].filter(Boolean).join(' — ') || 'unknown error')
}

async function postTokenForm(
  fields: Record<string, string>,
  input: { client: OAuthClientMeta; fetchImpl: typeof fetch; timeoutMs?: number },
): Promise<TokenSet> {
  const body = new URLSearchParams({
    client_id: input.client.clientId,
    client_secret: input.client.clientSecret,
    ...fields,
  })
  const response = await input.fetchImpl(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(input.timeoutMs ?? 30_000),
  })
  const payload = (await response.json().catch(() => ({}))) as TokenPayload
  if (!response.ok) throw new Error(`token endpoint ${response.status}: ${errorText(payload)}`)
  if (typeof payload.access_token !== 'string' || !payload.access_token) throw new Error('token endpoint returned no access_token')
  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : undefined
  return {
    accessToken: payload.access_token,
    ...(typeof payload.refresh_token === 'string' && payload.refresh_token ? { refreshToken: payload.refresh_token } : {}),
    ...(expiresIn === undefined ? {} : { expiresAt: Date.now() + expiresIn * 1000 }),
  }
}

export interface ExchangeInput {
  code: string
  verifier: string
  client: OAuthClientMeta
  fetchImpl: typeof fetch
  redirectUri?: string
  timeoutMs?: number
}

/** 用授权码 + PKCE verifier 换 token。 */
export async function exchangeCode(input: ExchangeInput): Promise<TokenSet> {
  return postTokenForm({
    grant_type: 'authorization_code',
    code: input.code.trim(),
    redirect_uri: input.redirectUri ?? OAUTH_REDIRECT_URI,
    code_verifier: input.verifier,
  }, { client: input.client, fetchImpl: input.fetchImpl, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) })
}

/** 读取账号邮箱（best effort；失败不阻断登录）。 */
export async function fetchUserEmail(
  accessToken: string,
  fetchImpl: typeof fetch,
  timeoutMs = 15_000,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(OAUTH_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return undefined
    const payload = (await response.json()) as { email?: unknown }
    return typeof payload.email === 'string' && payload.email ? payload.email : undefined
  } catch {
    return undefined
  }
}

/** ISO-8601 带本地时区偏移，和官方 agy 写出的 expiry 形态一致。 */
export function formatLocalIso(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T`
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
    + `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
}

/** 官方 `agy` 的磁盘形态：`{"token": {...}, "auth_method": "consumer"}`。 */
export function buildCliTokenDocument(tokens: TokenSet): Record<string, unknown> {
  const expiry = formatLocalIso(tokens.expiresAt ?? Date.now() + 3600_000)
  return {
    token: {
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
      expiry,
    },
    auth_method: 'consumer',
  }
}

/** 把 token 写进账号 HOME 的官方 CLI 路径，0600、原子替换。 */
export async function writeCliTokenFile(homeDir: string, tokens: TokenSet): Promise<string> {
  const dir = join(homeDir, '.gemini', 'antigravity-cli')
  const file = join(dir, 'antigravity-oauth-token')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(temp, JSON.stringify(buildCliTokenDocument(tokens)), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await chmod(temp, 0o600).catch(() => undefined)
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
  await chmod(file, 0o600).catch(() => undefined)
  return file
}

const HTML_ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPE[character] ?? character)
}

const SUCCESS_HTML = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>登录成功</title></head>'
  + '<body style="font-family:system-ui;text-align:center;padding:3rem">'
  + '<h2>✓ 授权成功</h2><p>可以关闭此标签页，返回 DeepSeek Harness 的 Antigravity 设置。</p></body></html>'

export interface CallbackResult {
  code: string
  state: string
}

export interface CallbackListenerOptions {
  /** 默认 51121；测试可传 0 让系统分配。 */
  port?: number
  path?: string
  timeoutMs?: number
  /** 本次流程的 state；不匹配的回调只回 400，不结束流程。 */
  expectedState: string
}

export interface CallbackListener {
  /** 实际监听的端口。 */
  port: number
  result: Promise<CallbackResult>
  close(): Promise<void>
  /** 主动取消：结果 promise 以可读错误结束，监听关闭。 */
  cancel(reason?: string): void
}

/** 授权流程以可读原因失败（取消、超时、手动提交的地址不可用）。 */
export class CallbackRejected extends Error {
  readonly phase = 'failed'
}

/**
 * 在 127.0.0.1 上等一次授权回调。
 *
 * 绑定失败会立即 reject（端口被占用、无回环权限），调用方转成可读错误；
 * 超时、state 不匹配与 `error=` 回调都会让 result reject，并关闭监听。
 */
export function startCallbackListener(options: CallbackListenerOptions): Promise<CallbackListener> {
  const path = options.path ?? OAUTH_CALLBACK_PATH
  const timeoutMs = options.timeoutMs ?? 300_000
  return new Promise((resolveListener, rejectListener) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let resolveResult!: (value: CallbackResult) => void
    let rejectResult!: (reason: Error) => void
    const result = new Promise<CallbackResult>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    const close = async (): Promise<void> => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      await new Promise<void>((done) => server.close(() => done()))
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      rejectResult(error)
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      setTimeout(() => { void close() }, 1_000).unref?.()
    }
    const succeed = (value: CallbackResult): void => {
      if (settled) return
      settled = true
      resolveResult(value)
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
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
        // state 不匹配不消耗本次流程：可能是别的进程/过期标签页打回来的回调。
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('State mismatch')
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', connection: 'close' })
      response.end(SUCCESS_HTML)
      succeed({ code, state })
    }
    const server: Server = createServer(handle)
    server.once('error', (error) => {
      if (!settled) rejectListener(error instanceof Error ? error : new Error(String(error)))
      else fail(error instanceof Error ? error : new Error(String(error)))
    })
    server.listen(options.port ?? OAUTH_CALLBACK_PORT, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : options.port ?? OAUTH_CALLBACK_PORT
      timer = setTimeout(() => fail(new CallbackRejected('等待浏览器授权超时')), timeoutMs)
      timer.unref?.()
      resolveListener({
        port,
        result,
        close,
        cancel: (reason = '登录已取消') => {
          fail(new CallbackRejected(reason))
          void close()
        },
      })
    })
  })
}

/** 手动提交回调的结果：成功给出 code，失败给出可读原因。 */
export type ManualCallbackOutcome =
  | { ok: true; code: string }
  | { ok: false; reason: string }

/**
 * 从用户粘贴的回调地址里取出授权码。
 *
 * 无头主机（浏览器在另一台机器上）无法把 loopback 回调送回 DSH：授权后浏览器
 * 停在 `http://localhost:51121/oauth-callback?code=…&state=…` 打不开，但地址栏
 * 里的 URL 是完整的。让用户整条粘回来，校验 state 后取 code，与监听器拿到的
 * 结果走完全相同的换码流程。
 *
 * 校验规则与 handler 一致：
 * - `error` 参数优先（用户拒绝授权）；
 * - 缺 `code` / `state` 直接拒绝；
 * - `state` 不匹配拒绝——那是别的流程或过期标签页的回调。
 *
 * @param raw - 用户粘贴的完整回调地址（允许前后空格）。
 * @param expectedState - 本次流程生成的 state。
 * @returns 成功给 code，失败给可读原因；**不抛异常**，让调用方决定怎么显示。
 */
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
