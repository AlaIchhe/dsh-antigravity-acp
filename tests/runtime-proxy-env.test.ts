/**
 * runtime/proxy、process-env、binary、agy-cli 测试：零 mock fetch / 零 mock undici。
 * 代理路由用真实本地 HTTP 服务器 + 真实 undici ProxyAgent 验证；
 * `agy models` 解析除离线断言外，实机环境也直跑真实 `agy models`。
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ProxyConfigError,
  ambientProxyEnv,
  buildProxyEnv,
  createLiveProxiedFetch,
  createProxiedFetch,
  matchesBypass,
  normalizeProxyUrl,
  resolveHttpsProxy,
} from '../src/runtime/proxy.js'
import { buildSubprocessEnv, isolatedHomeEnv } from '../src/runtime/process-env.js'
import {
  AGY_BINARY_ERROR,
  assertValidVersion,
  defaultAgentArgs,
  ensureAgentBinary,
  isAgyCliExecutable,
  pickExecutablePath,
  resolveAgentArgs,
  resolveInstallRoot,
  versionCachePaths,
} from '../src/runtime/binary.js'
import {
  agyCliCandidates,
  createSubprocessCliRun,
  fetchAgyModels,
  foldCliModelFamilies,
  parseAgyCredits,
  parseAgyModels,
  parseAgyUsage,
} from '../src/runtime/agy-cli.js'
import { createRealSubprocessRuntime, REAL_AGY_BIN, REAL_TESTS_ENABLED } from './helpers/real-env.js'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('runtime/proxy, process-env, binary, agy-cli', () => {
  it('normalizes proxy URLs, preserves loopback bypass, and routes via real undici ProxyAgent', async () => {
    expect(normalizeProxyUrl('127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
    expect(() => normalizeProxyUrl('ftp://127.0.0.1:21')).toThrow(ProxyConfigError)
    expect(matchesBypass('127.0.0.1', 'localhost,127.0.0.1,::1')).toBe(true)
    expect(matchesBypass('api.internal', '*.internal,localhost')).toBe(true)
    expect(matchesBypass('google.com', '*.internal,localhost')).toBe(false)

    const env = buildProxyEnv({ url: 'http://127.0.0.1:7890' })
    expect(env?.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(env?.NO_PROXY).toContain('127.0.0.1')
    expect(ambientProxyEnv({ HTTPS_PROXY: 'http://proxy.local:8080' })?.https_proxy).toBe('http://proxy.local:8080')
    expect(resolveHttpsProxy(undefined, { HTTPS_PROXY: 'http://proxy.local:8080' })?.url).toBe('http://proxy.local:8080')

    // 真实本地目标 HTTP 服务器 + 真实本地 HTTP 代理服务器 + 真实 undici ProxyAgent
    const targetHits: string[] = []
    const proxyHits: string[] = []
    const targetServer = createServer((req, res) => {
      targetHits.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('direct-target')
    })
    const proxyServer = createServer((req, res) => {
      proxyHits.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('via-real-proxy')
    })

    await Promise.all([
      new Promise<void>((r) => targetServer.listen(0, '127.0.0.1', () => r())),
      new Promise<void>((r) => proxyServer.listen(0, '127.0.0.1', () => r())),
    ])

    const targetPort = (targetServer.address() as AddressInfo).port
    const proxyPort = (proxyServer.address() as AddressInfo).port
    const proxyUrl = `http://127.0.0.1:${proxyPort}`

    const pf = createProxiedFetch({ url: proxyUrl, bypass: 'localhost,127.0.0.1,::1' })
    const live = createLiveProxiedFetch(() => ({ url: proxyUrl, bypass: 'localhost,127.0.0.1,::1' }))
    try {
      // loopback 必须绕过代理直连目标
      const directResp = await pf(`http://127.0.0.1:${targetPort}/mcp`)
      expect(await directResp.text()).toBe('direct-target')
      expect(targetHits).toEqual(['/mcp'])
      expect(proxyHits).toHaveLength(0)

      // 非 loopback 必须走真实 undici ProxyAgent 到达本地代理服务器
      const proxiedResp = await live('http://example.invalid/check')
      expect(await proxiedResp.text()).toBe('via-real-proxy')
      expect(proxyHits).toEqual(['http://example.invalid/check'])
    } finally {
      await pf.close()
      await live.close()
      await Promise.all([
        new Promise<void>((r) => targetServer.close(() => r())),
        new Promise<void>((r) => proxyServer.close(() => r())),
      ])
    }
  })

  it('builds minimal scrubbed subprocess env with isolated home and proxy precedence', () => {
    const winHome = isolatedHomeEnv('C:\\Users\\alice', 'win32')
    expect(winHome.USERPROFILE).toBe('C:\\Users\\alice')
    expect(winHome.HOMEDRIVE).toBe('C:')
    expect(winHome.HOMEPATH).toBe('\\Users\\alice')
    expect(winHome.DBUS_SESSION_BUS_ADDRESS).toBeUndefined()

    const env = buildSubprocessEnv({
      binaryDir: '/opt/agy',
      tmpDir: '/tmp/run1',
      homeDir: '/accounts/acc1',
      proxy: { url: 'http://127.0.0.1:7890' },
      parent: { PATH: '/usr/bin', DSH_SECRET: 'must-not-leak', HTTPS_PROXY: 'http://old:8080' },
      platform: 'linux',
    })
    expect(env.DSH_SECRET).toBeUndefined()
    expect(env.HOME).toBe('/accounts/acc1')
    expect(env.TMPDIR).toBe('/tmp/run1')
    expect(env.PATH?.startsWith('/opt/agy:')).toBe(true)
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
  })

  it('locates ACP binary from config, env, versioned cache, and local agy CLI fallback without downloading', async () => {
    expect(() => assertValidVersion('../evil')).toThrow()
    expect(pickExecutablePath(['sub/agy_acp_server.par', 'agy_acp_server.par'], 'posix')).toBe('agy_acp_server.par')
    expect(resolveInstallRoot({ LOCALAPPDATA: 'C:\\Local' }, 'win32', 'C:\\Users\\u')).toContain('dsh-antigravity-host')

    const dir = mkdtempSync(join(tmpdir(), 'agy-bin-'))
    tempDirs.push(dir)
    const { extractDir } = versionCachePaths(dir, '1.5.0')
    mkdirSync(extractDir, { recursive: true })
    const bin = join(extractDir, 'agy_acp_server.par')
    writeFileSync(bin, '#!/bin/sh\n')

    const found = await ensureAgentBinary({ cacheDir: dir, version: '1.5.0', platform: 'linux', arch: 'x64', env: {}, home: dir })
    expect(found).toEqual({ executablePath: bin, source: 'cache', version: '1.5.0' })

    // 缓存缺失且 PATH / 默认目录均无 agy 时明确报错
    await expect(
      ensureAgentBinary({ cacheDir: dir, version: '9.9.9', platform: 'linux', arch: 'x64', env: {}, home: dir }),
    ).rejects.toMatchObject({ code: AGY_BINARY_ERROR.BINARY_MISSING })

    // 缓存缺失但默认安装目录（~/.local/bin/agy）存在时自动回退到本机 agy CLI
    const localBinDir = join(dir, '.local', 'bin')
    mkdirSync(localBinDir, { recursive: true })
    const localAgy = join(localBinDir, 'agy')
    writeFileSync(localAgy, '#!/bin/sh\n')
    const fromDefaultCli = await ensureAgentBinary({
      cacheDir: dir,
      version: '9.9.9',
      platform: 'linux',
      arch: 'x64',
      env: {},
      home: dir,
    })
    expect(fromDefaultCli).toEqual({ executablePath: localAgy, source: 'cli' })

    // PATH 中的 agy 优先于默认安装目录
    const pathBinDir = join(dir, 'path-bin')
    mkdirSync(pathBinDir, { recursive: true })
    const pathAgy = join(pathBinDir, 'agy')
    writeFileSync(pathAgy, '#!/bin/sh\n')
    const fromPathCli = await ensureAgentBinary({
      cacheDir: dir,
      version: '9.9.9',
      platform: 'linux',
      arch: 'x64',
      env: { PATH: pathBinDir },
      home: dir,
    })
    expect(fromPathCli).toEqual({ executablePath: pathAgy, source: 'cli' })

    // 显式 cliPath（对应 config.agyCliPath）优先于 PATH
    const customAgy = join(dir, 'custom-dir', 'agy')
    mkdirSync(join(dir, 'custom-dir'), { recursive: true })
    writeFileSync(customAgy, '#!/bin/sh\n')
    const fromCliPath = await ensureAgentBinary({
      cacheDir: dir,
      cliPath: customAgy,
      version: '9.9.9',
      platform: 'linux',
      arch: 'x64',
      env: { PATH: pathBinDir },
      home: dir,
    })
    expect(fromCliPath).toEqual({ executablePath: customAgy, source: 'cli' })

    // AGY_ACP_BIN 指向 agy 时保留 source=env
    const fromEnvAgy = await ensureAgentBinary({
      cacheDir: dir,
      version: '9.9.9',
      platform: 'darwin',
      arch: 'arm64',
      env: { AGY_ACP_BIN: localAgy },
      home: dir,
    })
    expect(fromEnvAgy).toEqual({ executablePath: localAgy, source: 'env' })

    // 统一 agy CLI 与旧版独立 agy_acp_server 的参数区分
    expect(isAgyCliExecutable('/Users/alice/.local/bin/agy')).toBe(true)
    expect(isAgyCliExecutable('C:\\Users\\alice\\AppData\\Local\\agy\\bin\\agy.exe')).toBe(true)
    expect(isAgyCliExecutable('/usr/local/bin/antigravity')).toBe(true)
    expect(isAgyCliExecutable('C:\\tools\\antigravity.exe')).toBe(true)
    expect(isAgyCliExecutable('/opt/agy/agy_acp_server.par')).toBe(false)
    expect(defaultAgentArgs('linux', '/usr/local/bin/agy')).toEqual(['acp'])
    expect(defaultAgentArgs('darwin', '/Users/alice/.local/bin/agy')).toEqual(['acp'])
    expect(defaultAgentArgs('linux', '/opt/agy/agy_acp_server.par')).toEqual(['--uid='])
    expect(resolveAgentArgs('/root/.local/bin/agy', undefined, 'linux')).toEqual(['acp'])
    expect(resolveAgentArgs('/root/.local/bin/agy', ['--disable-telemetry'], 'linux')).toEqual(['acp', '--disable-telemetry'])
    expect(resolveAgentArgs('/root/.local/bin/agy', ['acp', '--disable-telemetry'], 'linux')).toEqual(['acp', '--disable-telemetry'])
    expect(resolveAgentArgs('/opt/agy/agy_acp_server.par', ['--foo'], 'linux')).toEqual(['--uid=', '--foo'])
    expect(resolveAgentArgs('/opt/agy/agy_acp_server.par', ['--foo'], 'darwin')).toEqual(['--foo'])
  })

  it('parses agy CLI models with per-family tiers, usage, and credits cleanly', () => {
    expect(agyCliCandidates({ PATH: '/usr/local/bin' }, '/home/u', undefined, 'linux')[0]).toBe('/usr/local/bin/agy')

    const rawModels = parseAgyModels([
      'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
      'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
      'claude-opus-5-5-max\tClaude Opus 5.5 (Max)',
      'gpt-oss-120b\tGPT OSS',
      'gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)',
      'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)',
      'gemini-pro-orchestrator\tOrchestrator (Carbon)',
    ].join('\n'))
    expect(foldCliModelFamilies(rawModels)).toEqual([
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', tiers: ['low', 'high', 'max'] },
      { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', tiers: ['high', 'xhigh'] },
      { id: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)', tiers: [] },
    ])

    const usage = parseAgyUsage({
      status: 'SUCCESS',
      command: {
        name: 'usage',
        data: {
          plan_name: 'Google AI Pro',
          groups: [{ display_name: 'Gemini Models', buckets: [{ window: '5h', remaining_fraction: 0.75, disabled: false }] }],
        },
      },
    })
    expect(usage.plan).toBe('Google AI Pro')
    expect(usage.groups[0]?.buckets[0]?.remainingPct).toBe(75)

    const credits = parseAgyCredits({
      status: 'SUCCESS',
      command: { name: 'credits', data: { remaining_credits: 4200, plan_name: 'Pro' } },
    })
    expect(credits).toEqual({ remainingCredits: 4200, planName: 'Pro' })
  })

  it.skipIf(!REAL_TESTS_ENABLED || !REAL_AGY_BIN)('runs real `agy models` and folds real per-family tiers', async () => {
    const { runtime, killAll } = createRealSubprocessRuntime()
    const cliRun = createSubprocessCliRun(runtime, () => resolveHttpsProxy(undefined))
    try {
      const families = await fetchAgyModels(cliRun, REAL_AGY_BIN!)
      expect(families.length).toBeGreaterThan(3)
      const neon = families.find((f) => f.id === 'gemini-4-neon')
      const claude = families.find((f) => f.id === 'claude-sonnet-5-5')
      expect(neon?.tiers).toEqual(expect.arrayContaining(['low', 'medium', 'high', 'xhigh']))
      expect(claude?.tiers).toEqual(expect.arrayContaining(['low', 'medium', 'high']))
      expect(claude?.tiers).not.toContain('xhigh')
    } finally {
      killAll()
    }
  }, 60_000)
})
