import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  ensureAgentBinary,
  pickExecutablePath,
  resolveInstallRoot,
  versionCachePaths,
} from '../src/runtime/binary.js'
import {
  agyCliCandidates,
  foldCliModelFamilies,
  parseAgyCredits,
  parseAgyModels,
  parseAgyUsage,
} from '../src/runtime/agy-cli.js'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('runtime/proxy, process-env, binary, agy-cli', () => {
  it('normalizes proxy URLs, preserves loopback bypass, and routes via undici', async () => {
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

    const fallback = vi.fn(async () => new Response('direct'))
    const proxyFetch = vi.fn(async () => new Response('proxied'))
    const destroy = vi.fn(async () => {})
    const loadUndici = async () => ({
      ProxyAgent: class { destroy = destroy },
      fetch: proxyFetch,
    })

    const pf = createProxiedFetch({ url: 'http://127.0.0.1:7890', bypass: 'localhost,127.0.0.1' }, { fallback, loadUndici })
    await pf('http://127.0.0.1:1234/mcp')
    expect(fallback).toHaveBeenCalledTimes(1)
    await pf('https://oauth2.googleapis.com/token')
    expect(proxyFetch).toHaveBeenCalledTimes(1)
    await pf.close()
    expect(destroy).toHaveBeenCalledTimes(1)

    let currentUrl: string | undefined
    const live = createLiveProxiedFetch(() => (currentUrl ? { url: currentUrl, bypass: 'localhost' } : undefined), { fallback, loadUndici })
    await live('https://example.com')
    expect(fallback).toHaveBeenCalledTimes(2)
    currentUrl = 'http://127.0.0.1:7890'
    await live('https://example.com')
    expect(proxyFetch).toHaveBeenCalledTimes(2)
    await live.close()
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

  it('locates ACP binary from config, env, and versioned cache without downloading', async () => {
    expect(() => assertValidVersion('../evil')).toThrow()
    expect(pickExecutablePath(['sub/agy_acp_server.par', 'agy_acp_server.par'], 'posix')).toBe('agy_acp_server.par')
    expect(resolveInstallRoot({ LOCALAPPDATA: 'C:\\Local' }, 'win32', 'C:\\Users\\u')).toContain('dsh-antigravity-host')

    const dir = mkdtempSync(join(tmpdir(), 'agy-bin-'))
    tempDirs.push(dir)
    const { extractDir } = versionCachePaths(dir, '1.5.0')
    mkdirSync(extractDir, { recursive: true })
    const bin = join(extractDir, 'agy_acp_server.par')
    writeFileSync(bin, '#!/bin/sh\n')

    const found = await ensureAgentBinary({ cacheDir: dir, version: '1.5.0', platform: 'linux', arch: 'x64', env: {} })
    expect(found).toEqual({ executablePath: bin, source: 'cache', version: '1.5.0' })

    await expect(
      ensureAgentBinary({ cacheDir: dir, version: '9.9.9', platform: 'linux', arch: 'x64', env: {} }),
    ).rejects.toMatchObject({ code: AGY_BINARY_ERROR.BINARY_MISSING })
  })

  it('parses agy CLI models, usage, and credits cleanly', () => {
    expect(agyCliCandidates({ PATH: '/usr/local/bin' }, '/home/u', undefined, 'linux')[0]).toBe('/usr/local/bin/agy')

    const rawModels = parseAgyModels('claude-opus-5-5-high\tClaude Opus 5.5 (High)\nclaude-opus-5-5-low\tClaude Opus 5.5 (Low)\ngpt-oss-120b\tGPT OSS\ngemini-4-neon\tGemini 4 Neon\n')
    expect(foldCliModelFamilies(rawModels)).toEqual([
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
      { id: 'gemini-4-neon', name: 'Gemini 4 Neon' },
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
})
