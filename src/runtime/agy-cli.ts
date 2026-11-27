/**
 * 官方 `agy` CLI 的只读取数通道：模型清单（`models`）、套餐额度（`-p /usage`）与
 * AI Credits（`-p /credits`）。绝不发对话、绝不写凭据，子进程一律经 ctx.subprocess。
 */
import { homedir } from 'node:os'
import { dirname, posix, win32 } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { CreditsSnapshot, QuotaBucket, QuotaGroup, QuotaSnapshot } from '../shared/rpc-contract.js'
import { buildSubprocessEnv } from './process-env.js'
import type { ProxySettings } from './proxy.js'
import { redactSensitiveText } from './redact.js'

export interface CliRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

export interface CliRunRequest {
  argv: readonly string[]
  timeoutMs?: number
  homeDir?: string
}

export type CliRun = (request: CliRunRequest) => Promise<CliRunResult>

export const AGY_CLI_TIMEOUT_MS = 45_000

export class AgyCliError extends Error {
  readonly code: 'cli-missing' | 'cli-failed' | 'cli-bad-output'
  constructor(code: 'cli-missing' | 'cli-failed' | 'cli-bad-output', message: string) {
    super(redactSensitiveText(message))
    this.name = 'AgyCliError'
    this.code = code
  }
}

export function agyCliCandidates(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
  explicitPath?: string,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  const override = explicitPath?.trim() || env.AGY_CLI_BIN?.trim()
  if (override) return [override]
  const paths = platform === 'win32' ? win32 : posix
  const executable = platform === 'win32' ? 'agy.exe' : 'agy'
  const searchPath = Object.entries(env).find(([key]) =>
    platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH',
  )?.[1]
  const fromPath = (searchPath ?? '').split(paths.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => paths.isAbsolute(entry))
    .map((entry) => paths.join(entry, executable))
  const localAppData = env.LOCALAPPDATA?.trim()
  const defaults = platform === 'win32'
    ? [
        ...(localAppData ? [win32.join(localAppData, 'agy', 'bin', 'agy.exe')] : []),
        win32.join(home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe'),
      ]
    : [posix.join(home, '.local', 'bin', 'agy'), posix.join(home, 'bin', 'agy')]
  return [...new Set([...fromPath, ...defaults])]
}

/* ── `agy models` 解析与家族折叠 ───────────────────────────────────── */

const TIER_SUFFIX_RE = /-(low|medium|high|xhigh)$/i
const TIER_LABEL_RE = /\s*\((Low|Medium|High|Extra High|XHigh)\)\s*$/i
const TIER_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const EXCLUDED_FAMILIES = new Set(['gpt-oss-120b'])

function tierRank(tier: string): number {
  const index = (TIER_ORDER as readonly string[]).indexOf(tier)
  return index === -1 ? TIER_ORDER.length : index
}

export interface CliModelEntry {
  id: string
  name: string
  /** 该家族在 `agy models` 原始清单中实际出现过的思考档位（`[]` 表示无档位模型）。 */
  tiers?: readonly string[]
}

export function parseAgyModels(text: string): CliModelEntry[] {
  const out: CliModelEntry[] = []
  const seen = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const tab = trimmed.indexOf('\t')
    const id = (tab === -1 ? trimmed : trimmed.slice(0, tab)).trim()
    const name = (tab === -1 ? '' : trimmed.slice(tab + 1)).trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name: name || id })
  }
  return out
}

/**
 * 把 `agy models` 档位化的原始行（如 `claude-opus-5-5-high`、`gemini-4-hydrogen-xhigh`）
 * 折叠成家族行，并保留每个家族实际声明的档位清单（供 `CatalogStore` 精准按模型暴露档位）。
 */
export function foldCliModelFamilies(rows: readonly CliModelEntry[]): CliModelEntry[] {
  const byFamily = new Map<string, { id: string; name: string; tiers: Set<string> }>()
  for (const row of rows) {
    const tierMatch = TIER_SUFFIX_RE.exec(row.id)
    const familyId = tierMatch ? row.id.slice(0, tierMatch.index) : row.id
    if (EXCLUDED_FAMILIES.has(familyId.toLowerCase())) continue
    let entry = byFamily.get(familyId)
    if (!entry) {
      const cleanName = row.name.replace(TIER_LABEL_RE, '').trim() || familyId
      entry = { id: familyId, name: cleanName, tiers: new Set() }
      byFamily.set(familyId, entry)
    }
    if (tierMatch?.[1]) entry.tiers.add(tierMatch[1].toLowerCase())
  }
  return [...byFamily.values()].map((entry) => ({
    id: entry.id,
    name: entry.name,
    tiers: [...entry.tiers].sort((a, b) => tierRank(a) - tierRank(b)),
  }))
}

export async function fetchAgyModels(run: CliRun, cliPath: string, homeDir?: string): Promise<CliModelEntry[]> {
  const result = await run({
    argv: [cliPath, 'models'],
    timeoutMs: AGY_CLI_TIMEOUT_MS,
    ...(homeDir ? { homeDir } : {}),
  })
  if (result.exitCode !== 0) {
    throw new AgyCliError('cli-failed', `agy models 退出码 ${result.exitCode}：${result.stderr.slice(-300)}`)
  }
  const models = parseAgyModels(result.stdout)
  if (models.length === 0) {
    throw new AgyCliError('cli-bad-output', 'agy models 输出里没有模型')
  }
  return foldCliModelFamilies(models)
}

/* ── `agy -p /usage` 解析 ──────────────────────────────────────────── */

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function firstString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

export function parseAgyUsage(value: unknown, updatedAt = new Date().toISOString()): QuotaSnapshot {
  const root = asRecord(value)
  const command = asRecord(root.command)
  const data = asRecord(command.data)
  if (root.status !== 'SUCCESS' || command.name !== 'usage') {
    throw new AgyCliError('cli-bad-output', 'agy /usage 未返回成功的本地额度报告')
  }
  const plan = firstString(data.plan_name) ?? firstString(data.planName) ?? firstString(data.tier)
  const rawGroups = Array.isArray(data.groups) ? data.groups : Array.isArray(data.quota_groups) ? data.quota_groups : []
  const groups: QuotaGroup[] = rawGroups.map((item) => {
    const g = asRecord(item)
    const rawBuckets = Array.isArray(g.buckets) ? g.buckets : []
    const buckets: QuotaBucket[] = rawBuckets.map((entry) => {
      const b = asRecord(entry)
      const fraction = typeof b.remaining_fraction === 'number'
        ? b.remaining_fraction
        : typeof b.remainingFraction === 'number'
          ? b.remainingFraction
          : undefined
      const pct = typeof b.remaining_pct === 'number'
        ? b.remaining_pct
        : typeof b.remainingPct === 'number'
          ? b.remainingPct
          : fraction !== undefined && fraction >= 0 && fraction <= 1
            ? Math.round(fraction * 10000) / 100
            : undefined
      const desc = firstString(b.description)
      const win = firstString(b.window)
      const reset = firstString(b.reset_time) ?? firstString(b.resetTime)
      return {
        name: firstString(b.display_name) ?? firstString(b.displayName) ?? firstString(b.name) ?? '额度',
        ...(desc ? { description: desc } : {}),
        ...(win ? { window: win } : {}),
        ...(fraction !== undefined && fraction >= 0 && fraction <= 1 ? { remainingFraction: fraction } : {}),
        ...(pct !== undefined ? { remainingPct: pct } : {}),
        ...(reset ? { resetTime: reset } : {}),
        disabled: b.disabled === true,
      }
    })
    const desc = firstString(g.description)
    return {
      name: firstString(g.display_name) ?? firstString(g.displayName) ?? firstString(g.name) ?? '额度',
      ...(desc ? { description: desc } : {}),
      buckets,
    }
  })
  return {
    status: 'ok',
    updatedAt,
    ...(plan ? { plan } : {}),
    groups,
  }
}

export async function fetchAgyUsage(run: CliRun, cliPath: string, homeDir?: string): Promise<QuotaSnapshot> {
  const updatedAt = new Date().toISOString()
  try {
    const result = await run({
      argv: [cliPath, '-p', '/usage', '--output-format', 'json'],
      timeoutMs: AGY_CLI_TIMEOUT_MS,
      ...(homeDir ? { homeDir } : {}),
    })
    if (result.exitCode !== 0) {
      const message = redactSensitiveText(result.stderr.slice(-500))
      return {
        status: 'error',
        updatedAt,
        groups: [],
        error: { code: 'request-failed', message: `agy /usage 退出码 ${result.exitCode}${message ? `：${message}` : ''}` },
      }
    }
    let payload: unknown
    try { payload = JSON.parse(result.stdout) }
    catch { throw new AgyCliError('cli-bad-output', 'agy /usage 输出不是合法 JSON') }
    return parseAgyUsage(payload, updatedAt)
  } catch (error) {
    return {
      status: 'error',
      updatedAt,
      groups: [],
      error: {
        code: error instanceof AgyCliError && error.code === 'cli-bad-output' ? 'bad-response' : 'request-failed',
        message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      },
    }
  }
}

/* ── `agy -p /credits` 解析 ────────────────────────────────────────── */

export function parseAgyCredits(value: unknown): Pick<CreditsSnapshot, 'remainingCredits' | 'planName'> {
  const envelope = asRecord(value)
  const command = asRecord(envelope.command)
  const data = asRecord(command.data)
  if (envelope.status !== 'SUCCESS' || command.name !== 'credits') {
    throw new AgyCliError('cli-bad-output', 'agy /credits 未返回成功的本地余额报告')
  }
  const remaining = data.remaining_credits
  if (typeof remaining !== 'number' || !Number.isSafeInteger(remaining) || remaining < 0) {
    throw new AgyCliError('cli-bad-output', 'agy /credits 缺少有效的 remaining_credits 非负整数')
  }
  const planName = firstString(data.plan_name)
  return {
    remainingCredits: remaining,
    ...(planName ? { planName } : {}),
  }
}

export async function fetchAgyCredits(run: CliRun, cliPath: string, homeDir?: string): Promise<CreditsSnapshot> {
  const updatedAt = new Date().toISOString()
  try {
    const result = await run({
      argv: [cliPath, '-p', '/credits', '--output-format', 'json'],
      timeoutMs: AGY_CLI_TIMEOUT_MS,
      ...(homeDir ? { homeDir } : {}),
    })
    if (result.exitCode !== 0) {
      const message = redactSensitiveText(result.stderr.slice(-500))
      if (/no credits? info(?:rmation)? (?:is available|found)/i.test(message)) {
        return { status: 'unavailable', updatedAt, error: { code: 'no-credit-info', message: '官方 CLI 未提供此账户的 AI Credits 信息' } }
      }
      if (/(?:unknown|unsupported|unrecognized|not supported)[^\n]*\/?credits|\/?credits[^\n]*(?:unknown|unsupported|not supported)/i.test(message)) {
        return { status: 'unavailable', updatedAt, error: { code: 'unsupported', message: '当前官方 CLI 不支持无头 /credits 查询' } }
      }
      return { status: 'error', updatedAt, error: { code: 'request-failed', message: `agy /credits 退出码 ${result.exitCode}${message ? `：${message}` : ''}` } }
    }
    let payload: unknown
    try { payload = JSON.parse(result.stdout) }
    catch { throw new AgyCliError('cli-bad-output', 'agy /credits 输出不是合法 JSON') }
    return { status: 'ok', updatedAt, ...parseAgyCredits(payload) }
  } catch (error) {
    return {
      status: 'error',
      updatedAt,
      error: {
        code: error instanceof AgyCliError && error.code === 'cli-bad-output' ? 'bad-response' : 'request-failed',
        message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      },
    }
  }
}

/* ── Subprocess 实现 ───────────────────────────────────────────────── */

function describeCliAuthFailure(stderr: string, exitCode: number | null): string | undefined {
  if (!/Authentication required|Please visit the URL to log in|not logged (?:in|into)/i.test(stderr)) return undefined
  return `官方 agy CLI 无法完成登录态刷新${exitCode === null ? '（等待登录超时）' : `（退出码 ${exitCode}）`}：登录已失效，或当前网络/代理无法访问 Google；请先检查出网代理，再重新登录 Antigravity 账号`
}

export function createSubprocessCliRun(
  subprocess: SubprocessRuntime,
  readProxy?: () => ProxySettings | undefined,
): CliRun {
  return async ({ argv, timeoutMs, homeDir }) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? AGY_CLI_TIMEOUT_MS)
    let handle: ReturnType<SubprocessRuntime['spawn']> | undefined
    try {
      handle = subprocess.spawn({
        argv,
        cwd: dirname(String(argv[0])),
        env: buildSubprocessEnv({ proxy: readProxy?.(), ...(homeDir ? { homeDir } : {}) }),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 512 * 1024 },
          stderr: { maxBytes: 32 * 1024 },
        },
        graceMs: 5_000,
        signal: controller.signal,
      })
      const outcome = await handle.done
      const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
      const authMessage = describeCliAuthFailure(stderr, outcome.exitCode)
      if (authMessage) throw new Error(authMessage)
      return {
        exitCode: outcome.exitCode,
        stdout: handle.collected.stdout?.readFrom(0).text ?? '',
        stderr,
      }
    } catch (error) {
      const stderr = handle?.collected.stderr?.readFrom(0).text ?? ''
      const authMessage = describeCliAuthFailure(stderr, null)
      if (authMessage) throw new Error(authMessage)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}
