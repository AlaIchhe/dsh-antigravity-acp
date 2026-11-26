import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AccountsManager } from '../src/accounts/manager.js'
import { AntigravityRemoteService, registerAntigravityRemote } from '../src/remote/service.js'
import { writeCliTokenFile } from '../src/auth/token-store.js'
import { apply } from '../src/index.js'
import { Config } from '../src/settings.js'
import { ANTIGRAVITY_REMOTE_INVOCATIONS, PACKAGE_NAME, REMOTE_SERVICE_NAME } from '../src/shared/rpc-contract.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('AntigravityRemoteService & plugin composition root', () => {
  it('enforces strict cliQuotaEnabled (errors instead of HTTP fallback) and caches HTTP quota', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'agy-rem-acc-'))
    const homeDir = mkdtempSync(join(tmpdir(), 'agy-rem-home-'))
    dirs.push(baseDir, homeDir)
    await writeCliTokenFile(homeDir, { accessToken: 'tok-ok', refreshToken: 'ref-ok', expiresAt: Date.now() + 600_000 })

    const accounts = new AccountsManager({ baseDir, homeDir })
    let cliEnabled = true
    let httpCalls = 0
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      httpCalls += 1
      const url = String(input)
      if (url.includes(':loadCodeAssist')) {
        return new Response(JSON.stringify({ cloudaicompanionProject: 'p1', paidTier: { name: 'Pro' } }), { status: 200 })
      }
      return new Response(JSON.stringify({
        groups: [{ displayName: 'Gemini Models', buckets: [{ displayName: '5h', window: '5h', remainingFraction: 0.9, disabled: false }] }],
      }), { status: 200 })
    })

    const fakeCtx = new Context()

    const svc = new AntigravityRemoteService(fakeCtx, {
      accounts,
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
      cliQuotaEnabled: () => cliEnabled,
      resolveCli: () => undefined,
      listModels: async () => ({ status: 'ok', models: [{ id: 'gemini-4-neon', name: 'Gemini 4 Neon' }] }),
      installCli: async () => ({ installed: true, message: 'ok' }),
    })

    // cliQuotaEnabled=true 且找不到 CLI → 必须显式报错，绝不回落 HTTP
    const failed = await svc.readQuota()
    expect(failed.status).toBe('error')
    expect(failed.error?.message).toContain('cliQuotaEnabled')
    expect(httpCalls).toBe(0)

    // 关闭 cliQuotaEnabled → 走 HTTP 并缓存
    cliEnabled = false
    const ok1 = await svc.readQuota({ model: 'gemini-4-neon' })
    expect(ok1.status).toBe('ok')
    expect(ok1.requestedModel).toBe('gemini-4-neon')
    expect(ok1.credits?.error?.code).toBe('cli-disabled')
    expect(httpCalls).toBe(2)

    const ok2 = await svc.readQuota({ model: 'gemini-4-neon' })
    expect(ok2.status).toBe('ok')
    expect(httpCalls).toBe(2) // 命中缓存

    const listed = await svc.listAccounts()
    expect(listed.cliInstalled).toBe(false)
    expect(listed.accounts[0]?.system).toBe(true)

    await accounts.dispose()
  })

  it('registers host Typert contribution and wires apply() cleanly', async () => {
    const registeredContributions: unknown[] = []
    const cleanups: Array<() => void | Promise<void>> = []
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const registerAdapter = vi.fn(() => vi.fn())
    const emit = vi.fn()

    const ctx = {
      subprocess: { spawn: vi.fn() },
      llm: { registerAdapter },
      logger: { info: vi.fn(), warn: vi.fn() },
      emit,
      get: (name: string) => name === 'typert'
        ? { register: (c: unknown) => { registeredContributions.push(c); return () => {} } }
        : name === 'settings'
          ? { configure: vi.fn(() => () => {}) }
          : undefined,
      on: (event: string, fn: (...args: unknown[]) => void) => {
        const list = listeners.get(event) ?? []
        list.push(fn)
        listeners.set(event, list)
      },
      inject: (_deps: string[], fn: (scope: unknown) => void) => {
        if (_deps.includes('typert') || _deps.includes('settings')) fn(ctx)
      },
      plugin: vi.fn(),
      fiber: {},
      effect: (cb: () => Generator<() => void | Promise<void>> | (() => void | Promise<void>)) => {
        const res = cb()
        if (typeof res === 'function') cleanups.push(res)
        else cleanups.push(...res)
      },
    } as unknown as Context

    registerAntigravityRemote(ctx)
    expect(registeredContributions).toHaveLength(1)
    expect(registeredContributions[0]).toMatchObject({
      package: PACKAGE_NAME,
      face: 'host',
      invocations: ANTIGRAVITY_REMOTE_INVOCATIONS,
    })

    const parsed = Config({ hiddenModels: [] })
    apply(ctx, parsed)
    expect(registerAdapter).toHaveBeenCalledWith(['antigravity-acp'], expect.anything())

    // hiddenModels volatile 更新触发 llm/adapters-updated
    for (const fn of listeners.get('loader/volatile-update') ?? []) fn([['hiddenModels']])
    expect(emit).toHaveBeenCalledWith('llm/adapters-updated')

    // 卸载清理不抛异常
    for (const release of cleanups.reverse()) await release()
    expect(REMOTE_SERVICE_NAME).toBe('antigravity')
  })
})
