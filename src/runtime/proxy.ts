/**
 * 统一出网代理：环境变量解析 + undici ProxyAgent fetch。
 *
 * 合并原 proxy-env.ts 与 proxied-fetch.ts，保证 OAuth、Cloud Code Assist HTTP、
 * CLI 安装、ACP server 与 agy CLI 子进程共用同一套代理解析口径。
 */

export interface ProxySettings {
  url?: string | undefined
  bypass?: string | undefined
}

export interface ResolvedProxy {
  url: string
  bypass: string
}

export class ProxyConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProxyConfigError'
  }
}

const ALWAYS_BYPASS = ['localhost', '127.0.0.1', '::1'] as const
const KNOWN_PROTOCOLS = ['http:', 'https:', 'socks5:', 'socks5h:'] as const

export function normalizeProxyUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim() ?? ''
  if (trimmed === '') return undefined
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new ProxyConfigError('代理地址无法解析（示例：http://127.0.0.1:7890）；请检查主机名和端口')
  }
  const protocol = parsed.protocol.toLowerCase()
  if (!KNOWN_PROTOCOLS.includes(protocol as (typeof KNOWN_PROTOCOLS)[number])) {
    throw new ProxyConfigError(`不支持的代理协议 ${parsed.protocol}（支持 ${KNOWN_PROTOCOLS.map((item) => item.replace(':', '')).join('、')}）`)
  }
  if (!parsed.hostname) {
    throw new ProxyConfigError('代理地址缺少主机名（示例：http://127.0.0.1:7890）')
  }
  const credentials = parsed.username
    ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@`
    : ''
  return `${protocol}//${credentials}${parsed.host}`
}

export function resolveProxyBypass(raw?: string): string {
  const entries: string[] = []
  for (const part of (raw ?? '').split(',')) {
    const entry = part.trim()
    if (entry !== '' && !entries.includes(entry)) entries.push(entry)
  }
  for (const entry of ALWAYS_BYPASS) {
    if (!entries.includes(entry)) entries.push(entry)
  }
  return entries.join(',')
}

export function resolveProxy(settings: ProxySettings | undefined): ResolvedProxy | undefined {
  const url = normalizeProxyUrl(settings?.url)
  if (!url) return undefined
  return { url, bypass: resolveProxyBypass(settings?.bypass) }
}

/** 显式代理优先，留空继承宿主环境中的 HTTPS / ALL / HTTP 代理。 */
export function resolveHttpsProxy(
  settings: ProxySettings | undefined,
  parent: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedProxy | undefined {
  const ambient = ambientProxyEnv(parent)
  return resolveProxy({
    url: normalizeProxyUrl(settings?.url) ?? ambient?.HTTPS_PROXY ?? ambient?.HTTP_PROXY,
    bypass: settings?.bypass ?? ambient?.NO_PROXY,
  })
}

export function buildProxyEnv(settings: ProxySettings | undefined): NodeJS.ProcessEnv | undefined {
  const resolved = resolveProxy(settings)
  if (!resolved) return undefined
  return {
    HTTP_PROXY: resolved.url,
    HTTPS_PROXY: resolved.url,
    ALL_PROXY: resolved.url,
    NO_PROXY: resolved.bypass,
    http_proxy: resolved.url,
    https_proxy: resolved.url,
    all_proxy: resolved.url,
    no_proxy: resolved.bypass,
  }
}

export function ambientProxyEnv(
  parent: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv | undefined {
  const pick = (names: readonly string[]): string | undefined => {
    for (const name of names) {
      const value = parent[name]
      if (value && value.trim().length > 0) return value.trim()
    }
    return undefined
  }
  const generic = pick(['all_proxy', 'ALL_PROXY'])
  const httpProxy = pick(['http_proxy', 'HTTP_PROXY']) ?? generic
  const httpsProxy = pick(['https_proxy', 'HTTPS_PROXY']) ?? generic
  if (!httpProxy && !httpsProxy) return undefined
  const bypass = resolveProxyBypass(pick(['no_proxy', 'NO_PROXY']))
  const env: NodeJS.ProcessEnv = { NO_PROXY: bypass, no_proxy: bypass }
  if (httpProxy) {
    env.HTTP_PROXY = httpProxy
    env.http_proxy = httpProxy
  }
  if (httpsProxy) {
    env.HTTPS_PROXY = httpsProxy
    env.https_proxy = httpsProxy
  }
  if (generic) {
    env.ALL_PROXY = generic
    env.all_proxy = generic
  }
  return env
}

/* ── undici ProxyAgent fetch ───────────────────────────────────────── */

export interface UndiciLike {
  ProxyAgent: new (options: { uri: string; token?: string; username?: string; password?: string }) => {
    close?(): Promise<void>
    destroy?(): Promise<void>
  }
  fetch: (input: string, init?: Record<string, unknown>) => Promise<Response>
}

export type ManagedFetch = typeof fetch & { close(): Promise<void> }
export const PROXY_CLOSE_TIMEOUT_MS = 2_000

export interface ProxiedFetchDeps {
  loadUndici?: () => Promise<UndiciLike | undefined>
  fallback?: typeof fetch
}

async function defaultLoadUndici(): Promise<UndiciLike | undefined> {
  try {
    const mod = (await import('undici')) as unknown as Partial<UndiciLike>
    if (typeof mod.ProxyAgent === 'function' && typeof mod.fetch === 'function') return mod as UndiciLike
    return undefined
  } catch {
    return undefined
  }
}

function isSupportedProxy(url: string): boolean {
  return /^(https?|socks5h?):\/\//i.test(url)
}

export function matchesBypass(hostname: string, bypass: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  for (const raw of bypass.split(',')) {
    let entry = raw.trim().toLowerCase()
    if (!entry) continue
    if (entry === '*') return true
    if (entry.startsWith('[')) entry = /^\[([^\]]+)\](?::\d+)?$/.exec(entry)?.[1] ?? entry
    else if (entry.split(':').length === 2) entry = entry.replace(/:\d+$/, '')
    if (entry === host) return true
    if (entry.startsWith('*.') && host.endsWith(entry.slice(1))) return true
    if (entry.startsWith('.') && host.endsWith(entry)) return true
  }
  return false
}

export function createLiveProxiedFetch(
  readProxy: () => ResolvedProxy | undefined,
  deps: ProxiedFetchDeps = {},
): ManagedFetch {
  const routes = new Map<string, ManagedFetch>()
  let closed = false
  const request: typeof fetch = (input, init) => {
    if (closed) return Promise.reject(new ProxyConfigError('代理传输已关闭；请求未发送'))
    let proxy: ResolvedProxy | undefined
    try {
      proxy = readProxy()
    } catch (error) {
      return Promise.reject(error)
    }
    const key = JSON.stringify(proxy ?? null)
    let route = routes.get(key)
    if (!route) {
      route = createProxiedFetch(proxy, deps)
      routes.set(key, route)
    }
    return route(input, init)
  }
  return Object.assign(request, {
    close: async () => {
      closed = true
      const results = await Promise.allSettled([...routes.values()].map((route) => route.close()))
      routes.clear()
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failed) throw failed.reason
    },
  })
}

export function createProxiedFetch(
  proxy: ResolvedProxy | undefined,
  deps: ProxiedFetchDeps = {},
): ManagedFetch {
  const fallback = deps.fallback ?? ((input, init) => globalThis.fetch(input, init))
  if (!proxy) {
    return Object.assign(((input, init) => fallback(input, init)) as typeof fetch, { close: async () => undefined })
  }
  if (!isSupportedProxy(proxy.url)) {
    throw new ProxyConfigError('插件请求支持 HTTP、HTTPS、SOCKS5 代理；不支持 SOCKS4')
  }
  const load = deps.loadUndici ?? defaultLoadUndici
  let closed = false
  let prepared: Promise<{ undici: UndiciLike; agent: { close?(): Promise<void>; destroy?(): Promise<void> } }> | undefined
  const prepare = (): NonNullable<typeof prepared> => {
    prepared ??= load().catch(() => undefined).then((undici) => {
      if (!undici) throw new ProxyConfigError('无法加载代理传输依赖 undici；请求未发送，请重新安装插件')
      try {
        const uri = new URL(proxy.url)
        if (uri.protocol === 'socks5h:') uri.protocol = 'socks5:'
        if (uri.protocol === 'socks5:') {
          return {
            undici,
            agent: new undici.ProxyAgent({
              uri: uri.href,
              username: decodeURIComponent(uri.username),
              password: decodeURIComponent(uri.password),
            }),
          }
        }
        const token = uri.username || uri.password
          ? `Basic ${Buffer.from(`${decodeURIComponent(uri.username)}:${decodeURIComponent(uri.password)}`).toString('base64')}`
          : undefined
        uri.username = ''
        uri.password = ''
        return { undici, agent: new undici.ProxyAgent({ uri: uri.href, ...(token ? { token } : {}) }) }
      } catch {
        throw new ProxyConfigError('无法初始化代理传输；请求未发送，请检查代理设置')
      }
    })
    return prepared
  }
  const doFetch: typeof fetch = async (input, init) => {
    if (closed) throw new ProxyConfigError('代理传输已关闭；请求未发送')
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let hostname = ''
    try {
      hostname = new URL(url).hostname
    } catch {
      throw new ProxyConfigError('请求地址无效；请求未发送')
    }
    if (matchesBypass(hostname, proxy.bypass)) return fallback(input, init)
    const route = await prepare()
    if (closed) throw new ProxyConfigError('代理传输已关闭；请求未发送')
    const requestInit = input instanceof Request
      ? {
          method: input.method, headers: input.headers, body: input.body,
          signal: input.signal, redirect: input.redirect, credentials: input.credentials,
          cache: input.cache, integrity: input.integrity, keepalive: input.keepalive,
          referrer: input.referrer, referrerPolicy: input.referrerPolicy, duplex: 'half',
        }
      : {}
    return route.undici.fetch(url, { ...requestInit, ...(init as Record<string, unknown> | undefined), dispatcher: route.agent })
  }
  let closing: Promise<void> | undefined
  return Object.assign(doFetch, {
    close: () => {
      closed = true
      closing ??= (async () => {
        const stop = (async () => {
          const route = await prepared?.catch(() => undefined)
          if (!route) return
          await (route.agent.destroy ? route.agent.destroy() : route.agent.close?.())
        })()
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            stop,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new ProxyConfigError('代理连接回收超时')), PROXY_CLOSE_TIMEOUT_MS)
            }),
          ])
        } finally {
          if (timer) clearTimeout(timer)
        }
      })()
      return closing
    },
  })
}
