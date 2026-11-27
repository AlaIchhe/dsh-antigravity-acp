/**
 * Host `AntigravityRemoteService` 与插件装配根测试：零 mock fetch、零假模型。
 * 使用本机真实凭据、真实 Cloud Code Assist HTTP 端点与真实官方 `agy` CLI。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AccountsManager } from '../src/accounts/manager.js'
import { AntigravityRemoteService, registerAntigravityRemote } from '../src/remote/service.js'
import { createSubprocessCliRun, fetchAgyModels } from '../src/runtime/agy-cli.js'
import { resolveHttpsProxy } from '../src/runtime/proxy.js'
import { CatalogStore } from '../src/session/catalog-store.js'
import { apply } from '../src/index.js'
import { Config } from '../src/settings.js'
import { ANTIGRAVITY_REMOTE_INVOCATIONS, PACKAGE_NAME, REMOTE_SERVICE_NAME } from '../src/shared/rpc-contract.js'
import {
  createRealProxiedFetch,
  createRealSubprocessRuntime,
  REAL_AGY_BIN,
  REAL_CLI_TOKEN_ACCOUNTS,
  REAL_TESTS_ENABLED,
} from './helpers/real-env.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('AntigravityRemoteService & plugin composition root', () => {
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

    for (const fn of listeners.get('loader/volatile-update') ?? []) fn([['hiddenModels']])
    expect(emit).toHaveBeenCalledWith('llm/adapters-updated')

    for (const release of cleanups.reverse()) await release()
    expect(REMOTE_SERVICE_NAME).toBe('antigravity')
  })

  it.skipIf(!REAL_TESTS_ENABLED || REAL_CLI_TOKEN_ACCOUNTS.length === 0)(
    'drives real HTTP quota, strict cliQuotaEnabled, real agy CLI usage/models, and caching',
    async () => {
      const baseDir = mkdtempSync(join(tmpdir(), 'agy-rem-acc-'))
      const cacheDir = mkdtempSync(join(tmpdir(), 'agy-rem-cache-'))
      dirs.push(baseDir, cacheDir)

      const realAccount = REAL_CLI_TOKEN_ACCOUNTS[0]!
      const accounts = new AccountsManager({ baseDir, homeDir: realAccount.home })
      const realFetch = createRealProxiedFetch()
      const { runtime, killAll } = createRealSubprocessRuntime()
      const cliRun = createSubprocessCliRun(runtime, () => resolveHttpsProxy(undefined))

      let cliEnabled = true
      let exposeCli = false

      const catalog = new CatalogStore({
        cacheDir,
        acpVersion: '1.4.0',
        loadCliModels: () => fetchAgyModels(cliRun, REAL_AGY_BIN!, realAccount.dir),
      })

      const svc = new AntigravityRemoteService(new Context(), {
        accounts,
        deps: { fetchImpl: realFetch },
        cliQuotaEnabled: () => cliEnabled,
        resolveCli: () => (exposeCli && REAL_AGY_BIN ? { run: cliRun, cliPath: REAL_AGY_BIN } : undefined),
        listModels: async (force) => {
          await catalog.refreshCliModels(force)
          const models = await catalog.listAllModels('antigravity-acp')
          return { status: 'ok', models: models.map(({ id, name }) => ({ id, name })) }
        },
        installCli: async () => ({ installed: false, message: `官方 CLI 已存在：${REAL_AGY_BIN}` }),
      })

      try {
        // 1. cliQuotaEnabled=true 且找不到 CLI → 必须显式报错，绝不回落 HTTP
        const failed = await svc.readQuota()
        expect(failed.status).toBe('error')
        expect(failed.error?.message).toContain('cliQuotaEnabled')

        // 2. 关闭 cliQuotaEnabled → 走真实 Cloud Code Assist HTTP 并缓存
        cliEnabled = false
        const ok1 = await svc.readQuota({ model: 'gemini-4-neon' })
        expect(ok1.status, `真实 HTTP 额度读取失败: ${ok1.error?.message ?? ''}`).toBe('ok')
        expect(ok1.requestedModel).toBe('gemini-4-neon')
        expect(ok1.groups.length).toBeGreaterThan(0)
        expect(ok1.credits?.error?.code).toBe('cli-disabled')

        const ok2 = await svc.readQuota({ model: 'gemini-4-neon' })
        expect(ok2.status).toBe('ok')
        expect(ok2.updatedAt).toBe(ok1.updatedAt) // 命中内存缓存

        // 3. 开启 cliQuotaEnabled + 真实 agy CLI → 走真实 `agy -p /usage` 与 `/credits`
        cliEnabled = true
        exposeCli = true
        const cliQuota = await svc.readQuota({ force: true })
        expect(cliQuota.status, `真实 agy /usage 失败: ${cliQuota.error?.message ?? ''}`).toBe('ok')
        expect(cliQuota.groups.length).toBeGreaterThan(0)

        // 4. listModels 走真实 `agy models`，且按模型暴露精确档位
        const modelsRes = await svc.listModels({ force: true })
        expect(modelsRes.status).toBe('ok')
        expect(modelsRes.models.some((m) => m.id === 'gemini-4-neon')).toBe(true)

        const neon = await catalog.resolveModel('antigravity-acp', 'gemini-4-neon')
        const claude = await catalog.resolveModel('antigravity-acp', 'claude-sonnet-5-5')
        const orchestrator = await catalog.resolveModel('antigravity-acp', 'gemini-pro-orchestrator')
        expect(neon.reasoning?.efforts.map((e) => e.id.toString())).toContain('xhigh')
        expect(claude.reasoning?.efforts.map((e) => e.id.toString())).not.toContain('xhigh')
        expect(orchestrator.reasoning).toBeUndefined()

        // 5. listAccounts 无参返回真实账号与 cliInstalled=true
        const listed = await svc.listAccounts()
        expect(listed.cliInstalled).toBe(true)
        expect(listed.accounts[0]?.system).toBe(true)
      } finally {
        killAll()
        await accounts.dispose()
        await realFetch.close()
      }
    },
    120_000,
  )
})
