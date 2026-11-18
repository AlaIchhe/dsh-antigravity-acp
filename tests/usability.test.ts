/**
 * 可用性回归（全插件审查第二批）：代理 fetch、下载超时/取消、凭据换发回退与原子写、
 * 额度失败保留旧值、预中止的请求、客户端版本号。
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { AnyMessage, Stream } from '@agentclientprotocol/sdk'
import { AgentLink, AGY_CLIENT_INFO, AGY_LINK_ERROR } from '../src/protocol/agent-link.js'
import { ensureAcpCredentials } from '../src/runtime/credentials.js'
import { createProxiedFetch, matchesBypass } from '../src/runtime/proxied-fetch.js'
import type { UndiciLike } from '../src/runtime/proxied-fetch.js'
import { AgYQuotaService, AGY_QUOTA_SERVICE } from '../src/quota/quota-remote.js'
import type { CliRun } from '../src/runtime/agy-cli.js'
import type { QuotaTokenState } from '../src/runtime/quota.js'

describe('createProxiedFetch', () => {
  const proxy = { url: 'http://127.0.0.1:7890', bypass: 'localhost,127.0.0.1,::1' }

  function fakeUndici(): { undici: UndiciLike; calls: Array<{ url: string; dispatcher: unknown }>; agents: string[] } {
    const calls: Array<{ url: string; dispatcher: unknown }> = []
    const agents: string[] = []
    class ProxyAgent {
      constructor(options: { uri: string }) {
        agents.push(options.uri)
      }
    }
    return {
      calls,
      agents,
      undici: {
        ProxyAgent: ProxyAgent as unknown as UndiciLike['ProxyAgent'],
        fetch: async (url, init) => {
          calls.push({ url, dispatcher: init?.dispatcher })
          return new Response('via-proxy')
        },
      },
    }
  }

  it('配置了 http 代理：经 undici ProxyAgent 发出，且 agent 只建一次', async () => {
    const fake = fakeUndici()
    const direct: string[] = []
    const doFetch = createProxiedFetch(proxy, {
      loadUndici: async () => fake.undici,
      fallback: async (input) => { direct.push(String(input)); return new Response('direct') },
    })
    expect(await (await doFetch('https://oauth2.googleapis.com/token')).text()).toBe('via-proxy')
    await doFetch('https://dl.google.com/x')
    expect(fake.agents).toEqual(['http://127.0.0.1:7890/'])
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[0]!.dispatcher).toBeDefined()
    expect(direct).toEqual([])
  })

  it('只有未配置代理或显式排除才使用宿主出口；依赖失败不得直连', async () => {
    const direct: string[] = []
    const fallback = async (input: string | URL | Request): Promise<Response> => { direct.push(String(input)); return new Response('direct') }
    const fake = fakeUndici()
    await createProxiedFetch(undefined, { fallback })('https://a.test/')
    await createProxiedFetch(proxy, { loadUndici: async () => fake.undici, fallback })('http://127.0.0.1:9/mcp')
    await expect(createProxiedFetch(proxy, { loadUndici: async () => undefined, fallback })('https://c.test/')).rejects.toThrow(/undici/)
    expect(direct).toEqual(['https://a.test/', 'http://127.0.0.1:9/mcp'])
    expect(fake.calls).toEqual([])
  })

  it('SOCKS5 和 SOCKS5H 都走代理，并保留 SOCKS 用户名密码', async () => {
    const fake = fakeUndici()
    const doFetch = createProxiedFetch({ url: 'socks5h://alice:pass@127.0.0.1:1080', bypass: '' }, { loadUndici: async () => fake.undici, fallback: async () => { throw new Error('must not connect directly') } })
    await doFetch('https://example.com')
    expect(fake.agents).toEqual(['socks5://alice:pass@127.0.0.1:1080'])
    expect(fake.calls).toHaveLength(1)
    await doFetch.close()
    await expect(doFetch('https://example.com')).rejects.toThrow(/已关闭/)
  })

  it('不支持的 SOCKS4 在任何请求发出前失败', () => {
    expect(() => createProxiedFetch({ url: 'socks4://localhost:1080', bypass: '' })).toThrow(/SOCKS4/)
  })

  it('排除列表匹配：精确主机与通配后缀', () => {
    expect(matchesBypass('localhost', 'localhost,127.0.0.1')).toBe(true)
    expect(matchesBypass('localhost', 'localhost:8080,127.0.0.1:7890')).toBe(true)
    expect(matchesBypass('127.0.0.1', '127.0.0.1:7890')).toBe(true)
    expect(matchesBypass('a.internal', '*.internal')).toBe(true)
    expect(matchesBypass('a.internal', '.internal')).toBe(true)
    expect(matchesBypass('example.com', '*.internal,localhost')).toBe(false)
    expect(matchesBypass('::1', '::1')).toBe(true)
    expect(matchesBypass('::1', '[::1]:8080')).toBe(true)
  })
})


const HOME = '/home/tester'
const ACP_DIR = join(HOME, '.gemini', 'antigravity-acp')
const TOKEN_PATH = join(ACP_DIR, 'acp_token.json')
const CLI_TOKEN_PATH = join(HOME, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
const CLIENT = { clientId: '1-a.apps.googleusercontent.com', clientSecret: 'GOCSPX-x' }
const STALE_DOC = JSON.stringify({
  client_id: CLIENT.clientId,
  client_secret: CLIENT.clientSecret,
  refresh_token: 'revoked-token',
  token_uri: 'https://oauth2.googleapis.com/token',
  scopes: [],
  token: 'old',
  expiry: '2020-01-01T00:00:00.000Z',
})

describe('ensureAcpCredentials 换发回退', () => {
  function setup() {
    const files = new Map<string, string>([
      [TOKEN_PATH, STALE_DOC],
      [CLI_TOKEN_PATH, JSON.stringify({ token: { refresh_token: 'fresh-cli-token' } })],
    ])
    const tried: string[] = []
    return {
      files,
      tried,
      deps: {
        homedir: () => HOME,
        env: {},
        readFileImpl: async (path: string) => {
          const value = files.get(path)
          if (value === undefined) throw new Error('ENOENT')
          return value
        },
        writeFileImpl: async (path: string, data: string) => { files.set(path, data) },
        mkdirImpl: async () => undefined,
        resolveClient: async () => CLIENT,
        now: () => Date.parse('2026-10-20T00:00:00.000Z'),
      },
    }
  }

  it('acp_token.json 里的 refresh_token 被撤销时，回退用 CLI 当前登录态换发', async () => {
    const { files, tried, deps } = setup()
    const result = await ensureAcpCredentials({
      ...deps,
      refresh: async (state: QuotaTokenState) => {
        tried.push(state.refreshToken ?? '')
        if (state.refreshToken === 'revoked-token') throw new Error('invalid_grant')
        return { accessToken: 'new-access', refreshToken: state.refreshToken, expiry: '2099-01-01T00:00:00.000Z' }
      },
    })
    expect(tried).toEqual(['revoked-token', 'fresh-cli-token'])
    expect(result).toMatchObject({ ready: true, status: 'imported' })
    expect(JSON.parse(files.get(TOKEN_PATH)!)).toMatchObject({ refresh_token: 'fresh-cli-token', token: 'new-access' })
  })

  it('两条都失败时仍按既有降级走（磁盘上有可用凭据就算 ready）', async () => {
    const { deps } = setup()
    const result = await ensureAcpCredentials({ ...deps, refresh: async () => { throw new Error('invalid_grant') } })
    expect(result.ready).toBe(true)
    expect(result.status).toBe('existing')
    expect(result.note).toMatch(/换发 access token 失败/)
  })
})

describe('额度失败保留旧值', () => {
  const CREDITS = JSON.stringify({ status: 'SUCCESS', num_turns: 0, command: { name: 'credits', data: { remaining_credits: 100 } } })
  const USAGE = JSON.stringify({
    status: 'SUCCESS',
    command: { name: 'usage', data: { groups: [{ name: 'Gemini', buckets: [{ name: '5h', window: '5h', remaining_fraction: 0.62 }] }] } },
  })

  

  

  it('force 刷新不并入「命中缓存」的在途读取：同一 tick 的刷新必须真正重新取数', async () => {
    let call = 0
    const run: CliRun = async (request) => {
      if (request.argv.includes('/credits')) return { exitCode: 0, stdout: CREDITS, stderr: '' }
      call += 1
      return { exitCode: 0, stdout: USAGE, stderr: '' }
    }
    const ctx = new Context()
    ctx.plugin(AgYQuotaService, { cli: { run, cliPath: '/fake/agy' }, cliQuotaEnabled: () => true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const service = (ctx as unknown as Record<string, { read(r?: { force?: boolean }): Promise<{ status: string; groups: unknown[] }> }>)[AGY_QUOTA_SERVICE]!
    await service.read()
    const before = call
    // 同一同步段内：非 force 读取命中缓存（在途、即时返回），force 紧随其后到达。
    const cached = service.read()
    const forced = service.read({ force: true })
    const [a, b] = await Promise.all([cached, forced])
    expect(a.groups).toHaveLength(1)
    expect(b.groups).toHaveLength(1)
    // force 必须触发一次真实的 CLI 取数，而不是拿缓存在途读取的结果直接返回。
    expect(call).toBe(before + 1)
  })
})

describe('AgentLink 细节', () => {
  it('signal 已中止时不发出请求', async () => {
    const written: AnyMessage[] = []
    const stream: Stream = {
      readable: new ReadableStream<AnyMessage>(),
      writable: new WritableStream<AnyMessage>({ write: (message) => { written.push(message) } }),
    }
    const link = new AgentLink({ stream })
    const controller = new AbortController()
    controller.abort(new Error('用户取消'))
    await expect(link.request('session/prompt', {}, { signal: controller.signal })).rejects.toMatchObject({
      code: AGY_LINK_ERROR.REQUEST_TIMEOUT,
    })
    expect(written).toEqual([])
  })

  it('clientInfo 版本取自 package.json，而不是硬编码的 0.1.0', async () => {
    const { readFileSync } = await import('node:fs')
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(AGY_CLIENT_INFO.version).toBe(pkg.version)
  })
})
