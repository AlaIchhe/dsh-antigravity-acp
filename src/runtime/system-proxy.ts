/**
 * 系统代理自动检测：环境变量 → 平台系统设置（Windows 注册表 / macOS scutil /
 * Linux GNOME）。结果缓存 5 分钟，避免每次取数都起子进程。
 *
 * 只用于「配置里没有 proxyUrl」时的兜底；显式配置永远优先。检测失败一律返回
 * undefined，不阻断插件装载，也不把错误文本带进 UI。
 */
import { execFileSync } from 'node:child_process'
import { normalizeProxyUrl } from './proxy-env.js'

export interface SystemProxyDeps {
  platform?: NodeJS.Platform
  env?: Readonly<Record<string, string | undefined>>
  /** 同步执行外部命令；测试注入假实现。 */
  run?: (command: string, args: readonly string[]) => string
  now?: () => number
  ttlMs?: number
}

const DEFAULT_TTL_MS = 300_000
let cache: { at: number; value: string | undefined } | undefined

function defaultRun(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], {
    encoding: 'utf8',
    timeout: 1_500,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

function unquote(value: string): string {
  return value.trim().replace(/^'|'$/g, '')
}

function envProxy(env: Readonly<Record<string, string | undefined>>): string | undefined {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const value = env[key]?.trim()
    if (value) return value
  }
  return undefined
}

/** `reg query ...Internet Settings` 的 ProxyServer 支持 `http=host:port;https=...`。 */
function parseWindowsProxy(raw: string): string | undefined {
  const enabled = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(raw)?.[1]
  if (!enabled || Number.parseInt(enabled, 16) !== 1) return undefined
  const server = /ProxyServer\s+REG_SZ\s+(.+)/.exec(raw)?.[1]?.trim()
  if (!server) return undefined
  if (!server.includes('=')) return `http://${server}`
  const entries = new Map<string, string>()
  for (const part of server.split(';')) {
    const [scheme, address] = part.split('=', 2).map((item) => item?.trim())
    if (scheme && address) entries.set(scheme.toLowerCase(), address)
  }
  const address = entries.get('https') ?? entries.get('http') ?? entries.get('socks')
  if (!address) return undefined
  return `${entries.has('https') || entries.has('http') ? 'http' : 'socks5'}://${address}`
}

/** `scutil --proxy` 的键值行。 */
function parseMacProxy(raw: string): string | undefined {
  const field = (name: string): string | undefined => new RegExp(`^\\s*${name}\\s*:\\s*(\\S+)`, 'm').exec(raw)?.[1]
  const enabled = (name: string): boolean => field(name) === '1'
  if (enabled('HTTPSEnable') && field('HTTPSProxy') && field('HTTPSPort')) {
    return `http://${field('HTTPSProxy')}:${field('HTTPSPort')}`
  }
  if (enabled('HTTPEnable') && field('HTTPProxy') && field('HTTPPort')) {
    return `http://${field('HTTPProxy')}:${field('HTTPPort')}`
  }
  if (enabled('SOCKSEnable') && field('SOCKSProxy') && field('SOCKSPort')) {
    return `socks5://${field('SOCKSProxy')}:${field('SOCKSPort')}`
  }
  return undefined
}

/** GNOME `gsettings` 的 manual 代理；https 优先，其次 http。 */
function parseGnomeProxy(run: (command: string, args: readonly string[]) => string): string | undefined {
  const mode = unquote(run('gsettings', ['get', 'org.gnome.system.proxy', 'mode']))
  if (mode !== 'manual') return undefined
  for (const scheme of ['https', 'http']) {
    const host = unquote(run('gsettings', ['get', `org.gnome.system.proxy.${scheme}`, 'host']))
    const port = unquote(run('gsettings', ['get', `org.gnome.system.proxy.${scheme}`, 'port']))
    if (host && /^\d+$/.test(port) && port !== '0') return `http://${host}:${port}`
  }
  return undefined
}

function detect(deps: Required<Pick<SystemProxyDeps, 'platform' | 'env' | 'run'>>): string | undefined {
  const ambient = envProxy(deps.env)
  if (ambient) return ambient
  try {
    if (deps.platform === 'win32') {
      return parseWindowsProxy(deps.run('reg', [
        'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      ]))
    }
    if (deps.platform === 'darwin') {
      return parseMacProxy(deps.run('scutil', ['--proxy']))
    }
    if (deps.platform === 'linux') {
      return parseGnomeProxy(deps.run)
    }
  } catch {
    // 没有 gsettings / reg / scutil，或没有桌面会话：视为未配置。
  }
  return undefined
}

/** 当前系统代理；显式配置由调用方优先处理。 */
export function detectSystemProxy(deps: SystemProxyDeps = {}): string | undefined {
  const now = (deps.now ?? Date.now)()
  const ttl = deps.ttlMs ?? DEFAULT_TTL_MS
  if (cache && now - cache.at < ttl) return cache.value
  const raw = detect({
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
    run: deps.run ?? defaultRun,
  })
  let value: string | undefined
  try {
    value = raw === undefined ? undefined : normalizeProxyUrl(raw)
  } catch {
    value = undefined
  }
  cache = { at: now, value }
  return value
}

/** 测试用：清空缓存。 */
export function resetSystemProxyCache(): void {
  cache = undefined
}
