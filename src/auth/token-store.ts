/**
 * 统一的凭据读写与 ACP 登录态准备。
 *
 * 红线：
 * - 系统账号的 CLI 登录态文件（`~/.gemini/antigravity-cli/antigravity-oauth-token`）只读不写回；
 * - 隔离账号的 OAuth token 以 0600 原子写入该账号 HOME；
 * - 所有错误文本经过 `redactSensitiveText`，token 全文绝不进日志或返回值。
 */
import { readFile } from 'node:fs/promises'
import { homedir as osHomedir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { writeAtomicJson } from '../storage/atomic-json.js'
import { buildSubprocessEnv } from '../runtime/process-env.js'
import { redactSensitiveText } from '../runtime/redact.js'
import { OAUTH_TOKEN_URL, refreshAccessToken, resolveOAuthClient } from './oauth-client.js'
import type { OAuthClientMeta, TokenSet } from './oauth-client.js'

export const CLI_TOKEN_SUBPATH = ['.gemini', 'antigravity-cli', 'antigravity-oauth-token'] as const
export const CLI_KEYRING_SERVICE = 'gemini'
export const CLI_KEYRING_ACCOUNT = 'antigravity'
export const ACP_HOME_SUBPATH = ['.gemini', 'antigravity-acp'] as const
export const ACP_TOKEN_FILENAME = 'acp_token.json'
export const ACP_SETTINGS_FILENAME = 'settings.json'
export const ACP_AUTH_TYPE = 'oauth-personal'
export const TOKEN_EXPIRY_MARGIN_MS = 60_000

const GO_KEYRING_BASE64_PREFIX = 'go-keyring-base64:'
const KEYRING_READ_TIMEOUT_MS = 5_000

export const ACP_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/aicode',
] as const

export interface TokenState {
  accessToken?: string
  refreshToken?: string
  expiry?: string
}

export interface AcpCredentialDocument {
  client_id: string
  client_secret: string
  refresh_token: string
  token_uri: string
  scopes: readonly string[]
  project_id?: string
  token?: string
  expiry?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** 解析 CLI 或 ACP 登录态文件：兼容嵌套 `token.{...}` 与平铺两种格式。 */
export function parseTokenState(raw: unknown): TokenState {
  const root = isRecord(raw) ? raw : {}
  const token = isRecord(root.token) ? root.token : root
  const accessToken = nonEmptyString(token.access_token) ?? nonEmptyString(token.token) ?? nonEmptyString(root.access_token) ?? nonEmptyString(root.token)
  const refreshToken = nonEmptyString(token.refresh_token) ?? nonEmptyString(root.refresh_token)
  let expiry = nonEmptyString(token.expiry) ?? nonEmptyString(root.expiry)
  if (!expiry) {
    const expiryDate = typeof token.expiry_date === 'number'
      ? token.expiry_date
      : typeof root.expiry_date === 'number'
        ? root.expiry_date
        : undefined
    if (expiryDate !== undefined && Number.isFinite(expiryDate) && expiryDate > 0) {
      expiry = new Date(expiryDate).toISOString()
    }
  }
  return {
    ...(accessToken ? { accessToken } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiry ? { expiry } : {}),
  }
}

export function isTokenUsable(state: TokenState, nowMs = Date.now()): boolean {
  if (!state.accessToken) return false
  if (!state.expiry) return true
  const expiresAt = Date.parse(state.expiry)
  if (!Number.isFinite(expiresAt)) return false
  return expiresAt - TOKEN_EXPIRY_MARGIN_MS > nowMs
}

export function cliTokenPathFor(homeDir: string): string {
  return join(homeDir, ...CLI_TOKEN_SUBPATH)
}

export type KeyringReadStatus = 'ok' | 'not-found' | 'denied' | 'unavailable'

export interface KeyringReadResult {
  status: KeyringReadStatus
  payload?: string
  note?: string
}

export type KeyringReader = () => Promise<KeyringReadResult>

export interface ReadCliTokenOptions {
  readFileImpl?: (path: string) => Promise<string>
  /** 仅系统账号允许传入；隔离账号绝不传，避免串读系统钥匙串。 */
  readKeyring?: KeyringReader
}

export interface CliTokenReadDetail {
  state?: TokenState
  source?: 'file' | 'keyring'
  keyringStatus?: KeyringReadStatus
  keyringNote?: string
}

/**
 * 解码 `zalando/go-keyring` 写入系统钥匙串的载荷：
 * - macOS `security find-generic-password -w` 在值含换行或非 ASCII 字节时会输出纯十六进制；
 * - `go-keyring` 在部分场景会写入 `go-keyring-base64:<base64>` 包装。
 */
export function decodeKeyringPayload(raw: string): string {
  let text = raw.trim()
  if (
    text.length >= 2
    && text.length % 2 === 0
    && !text.startsWith('{')
    && !text.startsWith(GO_KEYRING_BASE64_PREFIX)
    && /^[0-9a-fA-F]+$/.test(text)
  ) {
    try {
      const decoded = Buffer.from(text, 'hex').toString('utf8')
      const trimmed = decoded.trim()
      if (trimmed.startsWith('{') || trimmed.startsWith(GO_KEYRING_BASE64_PREFIX)) {
        text = trimmed
      }
    } catch {
      // 保持原始文本
    }
  }
  if (text.startsWith(GO_KEYRING_BASE64_PREFIX)) {
    const b64 = text.slice(GO_KEYRING_BASE64_PREFIX.length).trim()
    try {
      return Buffer.from(b64, 'base64').toString('utf8').trim()
    } catch {
      return text
    }
  }
  return text
}

/**
 * 通过 `ctx.subprocess` 只读查询本机系统钥匙串中的官方 `agy` CLI OAuth 凭据。
 * - macOS：`/usr/bin/security find-generic-password -s gemini -a antigravity -w`
 * - Linux（仅在存在 `DBUS_SESSION_BUS_ADDRESS` 时）：`secret-tool lookup service gemini username antigravity`
 * - 其它平台或无桌面 D-Bus 时直接返回 `unavailable`，不派生子进程。
 */
export function createSubprocessKeyringReader(
  subprocess: SubprocessRuntime,
  options: {
    platform?: NodeJS.Platform
    env?: Readonly<Record<string, string | undefined>>
    timeoutMs?: number
  } = {},
): KeyringReader {
  const platform = options.platform ?? process.platform
  const parent = options.env ?? process.env
  const timeoutMs = options.timeoutMs ?? KEYRING_READ_TIMEOUT_MS

  return async (): Promise<KeyringReadResult> => {
    let argv: string[] | undefined
    const env = buildSubprocessEnv({ parent, platform })

    if (platform === 'darwin') {
      argv = ['/usr/bin/security', 'find-generic-password', '-s', CLI_KEYRING_SERVICE, '-a', CLI_KEYRING_ACCOUNT, '-w']
    } else if (platform === 'linux') {
      const dbus = parent.DBUS_SESSION_BUS_ADDRESS?.trim()
      if (!dbus) return { status: 'unavailable' }
      env.DBUS_SESSION_BUS_ADDRESS = dbus
      argv = ['secret-tool', 'lookup', 'service', CLI_KEYRING_SERVICE, 'username', CLI_KEYRING_ACCOUNT]
    } else {
      return { status: 'unavailable' }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const handle = subprocess.spawn({
        argv,
        cwd: osHomedir(),
        env,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 64 * 1024 },
          stderr: { maxBytes: 4 * 1024 },
        },
        graceMs: 1_000,
        signal: controller.signal,
      })
      const outcome = await handle.done
      const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
      const stderr = handle.collected.stderr?.readFrom(0).text ?? ''

      if (outcome.exitCode === 0) {
        const trimmed = stdout.trim()
        return trimmed ? { status: 'ok', payload: trimmed } : { status: 'not-found' }
      }

      const cleanStderr = redactSensitiveText(stderr.trim()).slice(0, 200)
      if (platform === 'darwin') {
        if (outcome.exitCode === 44 || /could not be found|SecKeychainSearchCopyNext/i.test(stderr)) {
          return { status: 'not-found' }
        }
        if (
          outcome.exitCode === 36
          || outcome.exitCode === 51
          || outcome.exitCode === 128
          || /interaction is not allowed|user canceled|denied|locked/i.test(stderr)
        ) {
          return { status: 'denied', ...(cleanStderr ? { note: cleanStderr } : {}) }
        }
      } else if (platform === 'linux') {
        if (outcome.exitCode === 1 && !/locked|denied|cannot autolaunch/i.test(stderr)) {
          return { status: 'not-found' }
        }
        if (/locked|denied|dismissed/i.test(stderr)) {
          return { status: 'denied', ...(cleanStderr ? { note: cleanStderr } : {}) }
        }
      }

      return { status: 'unavailable', ...(cleanStderr ? { note: cleanStderr } : {}) }
    } catch (error) {
      if (controller.signal.aborted) {
        return { status: 'denied', note: '读取系统钥匙串超时（可能正在等待解锁或权限确认）' }
      }
      const message = redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 200)
      return { status: 'unavailable', ...(message ? { note: message } : {}) }
    } finally {
      clearTimeout(timer)
    }
  }
}

function hasAnyToken(state: TokenState | undefined): boolean {
  return Boolean(state?.accessToken || state?.refreshToken)
}

export async function readCliTokenDetail(
  homeDir: string,
  options: ReadCliTokenOptions = {},
): Promise<CliTokenReadDetail> {
  const readFileImpl = options.readFileImpl ?? ((path: string) => readFile(path, 'utf8'))
  let fileState: TokenState | undefined
  try {
    const raw = await readFileImpl(cliTokenPathFor(homeDir))
    fileState = parseTokenState(JSON.parse(raw))
    if (hasAnyToken(fileState)) {
      return { state: fileState, source: 'file' }
    }
  } catch {
    fileState = undefined
  }

  if (options.readKeyring) {
    try {
      const keyring = await options.readKeyring()
      if (keyring.status === 'ok' && keyring.payload) {
        try {
          const decoded = decodeKeyringPayload(keyring.payload)
          const parsed = parseTokenState(JSON.parse(decoded))
          if (hasAnyToken(parsed)) {
            return { state: parsed, source: 'keyring', keyringStatus: 'ok' }
          }
        } catch {
          return {
            ...(fileState ? { state: fileState, source: 'file' as const } : {}),
            keyringStatus: 'unavailable',
            keyringNote: '系统钥匙串中的登录态格式无法解析',
          }
        }
      }
      return {
        ...(fileState ? { state: fileState, source: 'file' as const } : {}),
        keyringStatus: keyring.status,
        ...(keyring.note ? { keyringNote: keyring.note } : {}),
      }
    } catch (error) {
      return {
        ...(fileState ? { state: fileState, source: 'file' as const } : {}),
        keyringStatus: 'unavailable',
        keyringNote: redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 200),
      }
    }
  }

  return fileState ? { state: fileState, source: 'file' } : {}
}

export async function readCliTokenState(
  homeDir: string,
  optionsOrReadFileImpl?: ReadCliTokenOptions | ((path: string) => Promise<string>),
): Promise<TokenState | undefined> {
  const options: ReadCliTokenOptions = typeof optionsOrReadFileImpl === 'function'
    ? { readFileImpl: optionsOrReadFileImpl }
    : (optionsOrReadFileImpl ?? {})
  const detail = await readCliTokenDetail(homeDir, options)
  return detail.state
}

/** 仅用于隔离账号 HOME：把 OAuth 登录态写入官方 CLI 同格式文件。 */
export async function writeCliTokenFile(homeDir: string, tokens: TokenSet): Promise<string> {
  const file = cliTokenPathFor(homeDir)
  const payload = {
    token: {
      access_token: tokens.accessToken,
      ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
      ...(tokens.expiresAt === undefined ? {} : { expiry_date: tokens.expiresAt, expiry: new Date(tokens.expiresAt).toISOString() }),
    },
  }
  await writeAtomicJson(file, payload, 0o600)
  return file
}

export function buildAcpCredentialDocument(input: {
  client: OAuthClientMeta
  state: TokenState
  projectId?: string
  tokenUri?: string
}): AcpCredentialDocument {
  if (!input.state.refreshToken) {
    throw new Error('登录态里没有 refresh_token，无法生成 acp_token.json')
  }
  return {
    client_id: input.client.clientId,
    client_secret: input.client.clientSecret,
    refresh_token: input.state.refreshToken,
    token_uri: input.tokenUri ?? OAUTH_TOKEN_URL,
    scopes: [...ACP_SCOPES],
    ...(input.projectId ? { project_id: input.projectId } : {}),
    ...(input.state.accessToken ? { token: input.state.accessToken } : {}),
    ...(input.state.expiry ? { expiry: input.state.expiry } : {}),
  }
}

export function buildAcpSettingsDocument(): { auth: { type: string } } {
  return { auth: { type: ACP_AUTH_TYPE } }
}

/** 把刚拿到的新鲜 OAuth token 直接写入隔离账号 HOME 的 ACP 凭据与 settings.json。 */
export async function writeAcpCredentialFiles(
  homeDir: string,
  client: OAuthClientMeta,
  state: TokenState,
  projectId?: string,
): Promise<{ tokenPath: string; settingsPath: string }> {
  const acpDir = join(homeDir, ...ACP_HOME_SUBPATH)
  const tokenPath = join(acpDir, ACP_TOKEN_FILENAME)
  const settingsPath = join(acpDir, ACP_SETTINGS_FILENAME)
  await writeAtomicJson(tokenPath, buildAcpCredentialDocument({ client, state, ...(projectId ? { projectId } : {}) }), 0o600)
  let existing: unknown
  try { existing = JSON.parse(await readFile(settingsPath, 'utf8')) } catch { existing = undefined }
  const merged = isRecord(existing)
    ? { ...existing, auth: { ...(isRecord(existing.auth) ? existing.auth : {}), ...buildAcpSettingsDocument().auth } }
    : buildAcpSettingsDocument()
  await writeAtomicJson(settingsPath, merged, 0o600)
  return { tokenPath, settingsPath }
}

export interface AcpCredentialResult {
  ready: boolean
  status: 'existing' | 'refreshed' | 'imported' | 'unavailable'
  settingsWritten: boolean
  tokenPath: string
  settingsPath: string
  note?: string
}

export interface EnsureAcpCredentialsDeps {
  homeDir?: string
  env?: Readonly<Record<string, string | undefined>>
  fetchImpl?: typeof fetch
  now?: () => number
  resolveProjectId?: (accessToken: string) => Promise<string | undefined>
  /** 仅系统账号传入，用于在 `antigravity-oauth-token` 文件缺失时回退读取系统钥匙串。 */
  readKeyring?: KeyringReader
}

async function readJsonSafe(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/**
 * 为指定 HOME 准备 `acp_token.json` 与 `settings.json`。
 * 优先复用已有有效凭据；否则刷新或从官方 CLI 登录态只读导入。
 * 失败时不抛异常，返回 `{ ready: false, note }` 供调用方决定降级策略。
 */
export async function ensureAcpCredentials(deps: EnsureAcpCredentialsDeps = {}): Promise<AcpCredentialResult> {
  const home = deps.homeDir ?? osHomedir()
  const now = deps.now ?? Date.now
  const acpDir = join(home, ...ACP_HOME_SUBPATH)
  const tokenPath = join(acpDir, ACP_TOKEN_FILENAME)
  const settingsPath = join(acpDir, ACP_SETTINGS_FILENAME)
  const base = { tokenPath, settingsPath }
  const degrade = (note: string, settingsWritten: boolean): AcpCredentialResult => ({
    ...base,
    ready: false,
    status: 'unavailable',
    settingsWritten,
    note: redactSensitiveText(note).slice(0, 240),
  })

  const existingRaw = await readJsonSafe(tokenPath)
  const existingRecord = isRecord(existingRaw) ? existingRaw : undefined
  const existingState = parseTokenState(existingRaw)
  const existingProjectId = nonEmptyString(existingRecord?.project_id)

  // 1. 已有可用 acp_token.json：补齐 settings.json 即可。
  if (existingState.refreshToken && isTokenUsable(existingState, now())) {
    try {
      const existingSettings = await readJsonSafe(settingsPath)
      const hasAuthType = isRecord(existingSettings) && isRecord(existingSettings.auth) && existingSettings.auth.type === ACP_AUTH_TYPE
      if (!hasAuthType) {
        const merged = isRecord(existingSettings)
          ? { ...existingSettings, auth: { ...(isRecord(existingSettings.auth) ? existingSettings.auth : {}), ...buildAcpSettingsDocument().auth } }
          : buildAcpSettingsDocument()
        await writeAtomicJson(settingsPath, merged, 0o600)
      }
      return { ...base, ready: true, status: 'existing', settingsWritten: !hasAuthType }
    } catch (error) {
      return degrade(`无法写入 settings.json：${error instanceof Error ? error.message : String(error)}`, false)
    }
  }

  // 2. 选择换发候选（已有 refresh_token 优先，回退官方 CLI 只读登录态 / 系统钥匙串）。
  const cliDetail = await readCliTokenDetail(home, {
    ...(deps.readKeyring ? { readKeyring: deps.readKeyring } : {}),
  })
  const cliState = cliDetail.state
  let source: 'refreshed' | 'imported' = existingState.refreshToken ? 'refreshed' : 'imported'
  const primaryCandidate = existingState.refreshToken ? existingState : cliState
  if (!primaryCandidate?.refreshToken) {
    if (cliDetail.keyringStatus === 'denied') {
      return degrade('无法读取系统钥匙串中的官方 CLI 登录态（钥匙串已锁定或拒绝访问），请解锁钥匙串或在设置页「添加账号」登录', false)
    }
    return degrade('未找到可用的 Antigravity 登录态（acp_token.json 与 CLI 登录态均缺失）', false)
  }

  const client = resolveOAuthClient(deps.env)
  let refreshed: TokenSet | undefined
  let lastError: unknown
  try {
    refreshed = await refreshAccessToken({
      refreshToken: primaryCandidate.refreshToken,
      client,
      fetchImpl: deps.fetchImpl,
      now,
    })
  } catch (error) {
    lastError = error
    if (cliState?.refreshToken && cliState.refreshToken !== primaryCandidate.refreshToken) {
      try {
        refreshed = await refreshAccessToken({
          refreshToken: cliState.refreshToken,
          client,
          fetchImpl: deps.fetchImpl,
          now,
        })
        source = 'imported'
      } catch (fallbackError) {
        lastError = fallbackError
      }
    }
  }
  if (!refreshed) {
    return degrade(`换发 access token 失败：${lastError instanceof Error ? lastError.message : String(lastError)}`, false)
  }

  let projectId = existingProjectId
  if (!projectId && deps.resolveProjectId) {
    try {
      projectId = await deps.resolveProjectId(refreshed.accessToken)
    } catch {
      projectId = undefined
    }
  }

  try {
    await writeAcpCredentialFiles(
      home,
      client,
      {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? primaryCandidate.refreshToken,
        ...(refreshed.expiresAt === undefined ? {} : { expiry: new Date(refreshed.expiresAt).toISOString() }),
      },
      projectId,
    )
    return { ...base, ready: true, status: source, settingsWritten: true }
  } catch (error) {
    return degrade(`无法写 acp_token.json：${error instanceof Error ? error.message : String(error)}`, false)
  }
}
