/**
 * 官方 `agy` CLI 的**只读取数**通道：套餐额度（`-p /usage`）与模型清单
 * （`models`）；AI Credits（`-p /credits`）复用本模块 CliRun，见 credits.ts。
 *
 * 授权边界（2026-10-16 用户明确批准）：放宽「不 wrap agy CLI」，**仅限只读取数
 * 用途**。本模块只做两件事：
 * - `-p /usage --output-format json`：slash 命令由 CLI 本地处理（实测
 *   `num_turns: 0`、`total_tokens: 0`，无任何模型回合）；
 * - `models`：列出官方模型 id/名称。
 *
 * 绝不发对话、绝不写文件、绝不读写凭据。子进程一律经 DSH 的 subprocess 服务
 * （本模块通过 {@link CliRun} 注入，不碰 child_process），失败折叠为可读错误。
 */
import { homedir } from 'node:os'
import { dirname, posix, win32 } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { redactSensitiveText } from './redact.js'
import { ambientProxyEnv, buildProxyEnv } from './proxy-env.js'
import { isolatedHomeEnv } from './isolated-home.js'
import type { ProxySettings } from './proxy-env.js'
import type { QuotaBucket, QuotaGroup, QuotaSnapshot } from './quota.js'

/** 单次 CLI 只读调用的返回面（由宿主经 ctx.subprocess 实现）。 */
export interface CliRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

export interface CliRunRequest {
  argv: readonly string[]
  timeoutMs?: number
  /** 隔离账号的 HOME；省略时用宿主真实 HOME。 */
  homeDir?: string
}

export type CliRun = (request: CliRunRequest) => Promise<CliRunResult>

/** 默认超时：CLI 启动会做登录/配置刷新，冷启动可达数秒。 */
export const AGY_CLI_TIMEOUT_MS = 45_000

/** CLI 候选优先级：显式配置、环境覆盖、PATH 绝对目录、各平台默认安装位置。 */
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
  const searchPath = Object.entries(env).find(([key]) => platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH')?.[1]
  // 跳过空条目与相对目录，避免从当前工作区意外加载同名文件。
  const fromPath = (searchPath ?? '').split(paths.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => paths.isAbsolute(entry))
    .map((entry) => paths.join(entry, executable))
  const localAppData = env.LOCALAPPDATA?.trim()
  const defaults = platform === 'win32'
    ? [...(localAppData ? [win32.join(localAppData, 'agy', 'bin', 'agy.exe')] : []), win32.join(home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe')]
    : [posix.join(home, '.local', 'bin', 'agy'), posix.join(home, 'bin', 'agy')]
  return [...new Set([...fromPath, ...defaults])]
}

/** CLI 取数失败（错误文本已脱敏，不含凭据）。 */
export class AgyCliError extends Error {
  readonly code: 'cli-missing' | 'cli-failed' | 'cli-bad-output'
  constructor(code: 'cli-missing' | 'cli-failed' | 'cli-bad-output', message: string) {
    super(redactSensitiveText(message))
    this.name = 'AgyCliError'
    this.code = code
  }
}

/**
 * `agy models` 的输出解析：每行 `id<TAB>名称`。
 * 空行忽略；缺名称的行用 id 兜底，不编造名称。
 */
export function parseAgyModels(text: string): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = []
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

/** 思考强度档位（官方模型 id 后缀），从弱到强。 */
export const AGY_REASONING_EFFORTS = ['low', 'medium', 'high'] as const
export type AgyReasoningEffort = (typeof AGY_REASONING_EFFORTS)[number]

/** 显示名映射（档位标签与思考强度菜单同名）。 */
export const AGY_REASONING_EFFORT_NAMES: Record<AgyReasoningEffort, string> = {
  low: '低',
  medium: '中',
  high: '高',
}

/**
 * 未选思考强度时的路由档位（官方 CLI 的默认模型是
 * `Gemini 3.8 Flash (Medium)`，与其中档一致）。
 */
export const DEFAULT_AGY_REASONING_EFFORT: AgyReasoningEffort = 'medium'

/**
 * 用户明确排除的模型家族（2026-10-16 指示：gpt-oss-120b 临近下架，不进选择器）。
 * 按家族排除：`gpt-oss-120b` 与其全部档位变体一并不出现。
 */
export const AGY_MODEL_EXCLUDED_FAMILIES: ReadonlySet<string> = new Set(['gpt-oss-120b'])

/**
 * 家族 id：去掉思考强度后缀；没有后缀时原样返回。
 *
 * 主要服务新协议：`thought_level` 是独立选择器，模型 id 本身已是家族 id
 * （`claude-opus-5-5`），但官方 CLI 清单里仍可能带 `-high` 这类后缀，按家族
 * 归并与匹配上下文容量时必须先剥掉。
 */
export function modelFamilyId(id: string): string {
  const cut = id.lastIndexOf('-')
  if (cut <= 0) return id
  const suffix = id.slice(cut + 1)
  return AGY_KNOWN_TIER_NAMES.has(suffix) ? id.slice(0, cut) : id
}

/** 已知档位名，仅用于识别 id 后缀（不决定「有哪些档位」，那由 agent 声明）。 */
const AGY_KNOWN_TIER_NAMES = new Set<string>([...AGY_REASONING_EFFORTS, 'xhigh'])

/** 显示名里的档位标签（如 `Claude Opus 5.5 (High)` → `Claude Opus 5.5`）。 */
function stripTierLabel(name: string): string {
  return name.replace(/\s*\((low|medium|high|xhigh)\)\s*$/i, '').trim() || name
}

/**
 * 把官方 CLI 清单里的档位化行折叠成家族条目。
 *
 * CLI 的 `agy models` 输出是档位化原始行（`claude-opus-5-5-high`、
 * "Claude Opus 5.5 (High)"）。模型选择器只该列家族，因此先折叠。这里**不再**
 * 返回档位表：新协议由 agent 的 `thought_level` 选择器声明档位，不需要客户端
 * 再从目录里推断一套。
 *
 * @param rows - CLI 原始清单。
 * @returns 家族条目（按首次出现顺序）。
 */
export function foldAgyModelFamilies(
  rows: readonly { id: string; name: string; description?: string }[],
): { models: Array<{ id: string; name: string; description?: string }> } {
  const families = new Map<string, { id: string; name: string; description?: string }>()
  for (const row of rows) {
    const familyId = modelFamilyId(row.id)
    if (AGY_MODEL_EXCLUDED_FAMILIES.has(familyId)) continue
    const existing = families.get(familyId)
    const stripped = stripTierLabel(row.name)
    if (existing === undefined) {
      families.set(familyId, {
        id: familyId,
        name: stripped,
        ...(row.description === undefined ? {} : { description: row.description }),
      })
      continue
    }
    // 已有条目若名称还是裸 id，用这次更可读的名称补上。
    if (existing.name === familyId && stripped !== row.name) existing.name = stripped
  }
  return { models: [...families.values()] }
}

/**
 * `-p /usage --output-format json` 的输出解析：命令结果在 `command.data.groups`。
 * 字段按官方形态（`window`/`remaining_fraction`/`reset_time`）映射到本包快照。
 */
export function parseAgyUsage(payload: unknown): QuotaGroup[] {
  if (typeof payload !== 'object' || payload === null) return []
  const command = (payload as { command?: unknown }).command
  if (typeof command !== 'object' || command === null) return []
  const data = (command as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return []
  const groups = (data as { groups?: unknown }).groups
  if (!Array.isArray(groups)) return []
  const out: QuotaGroup[] = []
  for (const raw of groups) {
    if (typeof raw !== 'object' || raw === null) continue
    const group = raw as Record<string, unknown>
    const buckets: QuotaBucket[] = []
    const rawBuckets = Array.isArray(group.buckets) ? group.buckets : []
    for (const rawBucket of rawBuckets) {
      if (typeof rawBucket !== 'object' || rawBucket === null) continue
      const bucket = rawBucket as Record<string, unknown>
      const fraction = typeof bucket.remaining_fraction === 'number' && Number.isFinite(bucket.remaining_fraction)
        && bucket.remaining_fraction >= 0 && bucket.remaining_fraction <= 1
        ? bucket.remaining_fraction
        : undefined
      buckets.push({
        name: firstString(bucket.name) ?? firstString(bucket.id) ?? '额度',
        ...(firstString(bucket.description) === undefined ? {} : { description: firstString(bucket.description) }),
        ...(firstString(bucket.window) === undefined ? {} : { window: firstString(bucket.window) }),
        ...(fraction === undefined
          ? {}
          : { remainingFraction: fraction, remainingPct: Math.round(fraction * 10000) / 100 }),
        ...(firstString(bucket.reset_time) === undefined ? {} : { resetTime: firstString(bucket.reset_time) }),
        disabled: false,
      })
    }
    out.push({
      name: firstString(group.name) ?? '额度',
      ...(firstString(group.description) === undefined ? {} : { description: firstString(group.description) }),
      buckets,
    })
  }
  return out
}

/** 跑一次官方 CLI 的额度查询（slash 命令本地处理，无模型回合）。 */
export async function fetchAgyUsage(run: CliRun, cliPath: string, homeDir?: string): Promise<QuotaSnapshot> {
  const stamp = new Date().toISOString()
  let result: CliRunResult
  try {
    result = await run({ argv: [cliPath, '-p', '/usage', '--output-format', 'json'], timeoutMs: AGY_CLI_TIMEOUT_MS, ...(homeDir ? { homeDir } : {}) })
  } catch (error) {
    return usageFailure(stamp, error)
  }
  if (result.exitCode !== 0) {
    return usageFailure(stamp, new AgyCliError('cli-failed', `agy /usage 退出码 ${result.exitCode}：${result.stderr.slice(-300)}`))
  }
  let payload: unknown
  try {
    payload = JSON.parse(result.stdout)
  } catch {
    return usageFailure(stamp, new AgyCliError('cli-bad-output', 'agy /usage 输出不是合法 JSON'))
  }
  const envelope = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  const command = typeof envelope.command === 'object' && envelope.command !== null
    ? envelope.command as Record<string, unknown>
    : {}
  if (envelope.status !== 'SUCCESS' || command.name !== 'usage') {
    return usageFailure(stamp, new AgyCliError('cli-bad-output', 'agy /usage 未返回成功的本地额度报告'))
  }
  const groups = parseAgyUsage(payload)
  if (groups.length === 0) {
    return usageFailure(stamp, new AgyCliError('cli-bad-output', 'agy /usage 输出里没有额度分组'))
  }
  const data = typeof command.data === 'object' && command.data !== null
    ? command.data as Record<string, unknown>
    : {}
  const plan = firstString(data.plan) ?? firstString(data.tier)
  return {
    status: 'ok',
    updatedAt: stamp,
    ...(plan === undefined ? {} : { plan }),
    groups,
  }
}

function usageFailure(updatedAt: string, error: unknown): QuotaSnapshot {
  const message = error instanceof AgyCliError
    ? error.message
    : redactSensitiveText(error instanceof Error ? error.message : String(error))
  return { status: 'error', updatedAt, groups: [], error: { code: 'request-failed', message } }
}

/** 跑一次官方 CLI 的模型清单（只读列表，无模型回合）。 */
export async function fetchAgyModels(run: CliRun, cliPath: string, homeDir?: string): Promise<Array<{ id: string; name: string }>> {
  const result = await run({ argv: [cliPath, 'models'], timeoutMs: AGY_CLI_TIMEOUT_MS, ...(homeDir ? { homeDir } : {}) })
  if (result.exitCode !== 0) {
    throw new AgyCliError('cli-failed', `agy models 退出码 ${result.exitCode}：${result.stderr.slice(-300)}`)
  }
  const models = parseAgyModels(result.stdout)
  if (models.length === 0) {
    throw new AgyCliError('cli-bad-output', 'agy models 输出里没有模型')
  }
  return models
}

function firstString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 官方 CLI 未登录时会先打印授权 URL 再挂起；把这种超时/非零退出折成可行动文案。 */
function describeCliAuthFailure(stderr: string, exitCode: number | null): string | undefined {
  if (!/Authentication required|Please visit the URL to log in|not logged (?:in|into)/i.test(stderr)) return undefined
  return `官方 agy CLI 无法完成登录态刷新${exitCode === null ? '（等待登录超时）' : `（退出码 ${exitCode}）`}：登录已失效，或当前网络/代理无法访问 Google；请先检查出网代理，再重新登录 Antigravity 账号`
}

/**
 * 用 DSH 的 subprocess 服务实现 {@link CliRun}（本模块不碰 child_process）。
 * 环境按最小可用集显式传入：Windows 系统键 + 用户目录键 + 出网代理键；
 * DSH_* 内部键一律不透传给官方二进制。
 */
export function createSubprocessCliRun(
  subprocess: SubprocessRuntime,
  proxy?: ProxySettings | undefined,
): CliRun {
  return async ({ argv, timeoutMs, homeDir }) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? AGY_CLI_TIMEOUT_MS)
    let handle: ReturnType<SubprocessRuntime['spawn']> | undefined
    try {
      handle = subprocess.spawn({
        argv,
        // cwd 用 CLI 自身目录：与 ACP server 的启动约定一致，避免工作目录
        // 影响官方二进制的相对资源解析。
        cwd: dirname(String(argv[0])),
        env: cliEnv(process.env, proxy, homeDir),
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

/**
 * 官方 CLI 的最小环境：系统键 + 用户目录键 + 代理，其余不透传。
 *
 * **代理必须在这里补齐**：`agy` 每次启动都会做登录/配置刷新（实测无代理时
 * `-p /usage` 会一直挂在网络上、直到被杀），而 DSH 的 subprocess 会 scrub 父环境。
 * 宿主进程环境里未必有代理变量——插件配置的 `proxyUrl` 才是权威来源。规则与官方
 * ACP 进程保持一致：**插件配置优先，其次宿主环境自身导出的代理**。
 */
export function cliEnv(
  parent: Readonly<Record<string, string | undefined>> = process.env,
  proxy?: ProxySettings | undefined,
  homeDir?: string,
): Record<string, string> {
  const keys = [
    'SystemRoot', 'SystemDrive', 'windir', 'COMSPEC', 'ComSpec', 'PATHEXT', 'PATH',
    'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USER',
    'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'TMPDIR',
  ]
  const env: Record<string, string> = {}
  for (const key of keys) {
    const value = parent[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  // 隔离账号覆盖上面转发的 HOME / USERPROFILE；必须在代理合并之前。
  if (homeDir) Object.assign(env, isolatedHomeEnv(homeDir))
  // 代理最后合并：配置的 proxyUrl 覆盖宿主环境里的同名键。
  const proxyEnv = proxy ? buildProxyEnv(proxy) : ambientProxyEnv(parent)
  for (const [key, value] of Object.entries(proxyEnv ?? {})) {
    if (typeof value === 'string' && value !== '') env[key] = value
  }
  return env
}
