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
import { writeAtomicJson } from '../storage/atomic-json.js'
import { redactSensitiveText } from '../runtime/redact.js'
import { OAUTH_TOKEN_URL, refreshAccessToken, resolveOAuthClient } from './oauth-client.js'
import type { OAuthClientMeta, TokenSet } from './oauth-client.js'

export const CLI_TOKEN_SUBPATH = ['.gemini', 'antigravity-cli', 'antigravity-oauth-token'] as const
export const ACP_HOME_SUBPATH = ['.gemini', 'antigravity-acp'] as const
export const ACP_TOKEN_FILENAME = 'acp_token.json'
export const ACP_SETTINGS_FILENAME = 'settings.json'
export const ACP_AUTH_TYPE = 'oauth-personal'
export const TOKEN_EXPIRY_MARGIN_MS = 60_000

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

export async function readCliTokenState(
  homeDir: string,
  readFileImpl: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
): Promise<TokenState | undefined> {
  try {
    const raw = await readFileImpl(cliTokenPathFor(homeDir))
    return parseTokenState(JSON.parse(raw))
  } catch {
    return undefined
  }
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

  // 2. 选择换发候选（已有 refresh_token 优先，回退官方 CLI 只读登录态）。
  const cliState = await readCliTokenState(home)
  let source: 'refreshed' | 'imported' = existingState.refreshToken ? 'refreshed' : 'imported'
  const primaryCandidate = existingState.refreshToken ? existingState : cliState
  if (!primaryCandidate?.refreshToken) {
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
