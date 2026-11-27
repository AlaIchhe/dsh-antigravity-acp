/**
 * 端到端验证构建产物 `dist/client.js`（零 mock remoteFace / 零假数据）：
 * - 静态断言零 Node 原生模块依赖、正确声明 `inject`、`remote.antigravity` 绝不进 `inject`；
 * - 按 DSH `@deepseek-ai/dsh-api-gateway` 的真实规则严格校验全部 9 个 RPC 方法的参数个数（arity）
 *   与输入/输出 strict codec；
 * - 实机环境下直接把 `dist/client.js` 接到真实的 `AntigravityRemoteService` + 真实本机凭据 +
 *   真实 Cloud Code Assist HTTP 额度 + 真实 `agy models`，完整渲染额度药丸与设置页（账号/模型两页）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { AccountsManager } from '../src/accounts/manager.js'
import { AntigravityRemoteService } from '../src/remote/service.js'
import { createSubprocessCliRun, fetchAgyModels } from '../src/runtime/agy-cli.js'
import { resolveHttpsProxy } from '../src/runtime/proxy.js'
import { CatalogStore } from '../src/session/catalog-store.js'
import { ANTIGRAVITY_REMOTE_INVOCATIONS, PACKAGE_NAME } from '../src/shared/rpc-contract.js'
import { createAntigravityClientApi } from '../src/client/remote.js'
import type { ClientContextLike } from '../src/client/remote.js'
import {
  createRealProxiedFetch,
  createRealSubprocessRuntime,
  REAL_AGY_BIN,
  REAL_CLI_TOKEN_ACCOUNTS,
  REAL_TESTS_ENABLED,
} from './helpers/real-env.js'

const clientBundleSource = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface RegisteredSlot {
  row: { id: string; name: string; order: number; inject?: (...args: unknown[]) => Record<string, unknown> }
  component: React.ComponentType<Record<string, unknown>>
}

/**
 * 严格复刻 DSH `@deepseek-ai/dsh-api-gateway` 客户端代理的校验行为：
 * 1. `args.length === descriptor.parameters.length`（精确 arity）；
 * 2. 逐参数执行 `parameter.codec.create().parse(arg)`；
 * 3. 调用真实的 `AntigravityRemoteService` 方法；
 * 4. 执行 `descriptor.result.create().parse(result)` 并包装为 `{ ok: true, value }` 信封。
 */
function bindRealServiceWithGatewayValidation(
  descriptors: readonly InvocationDescriptor[],
  service: AntigravityRemoteService,
): Record<string, (...args: unknown[]) => Promise<unknown>> {
  const face: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  for (const descriptor of descriptors) {
    const endpoint = `${descriptor.namespace}/${descriptor.method}`
    const expected = descriptor.parameters.length
    face[descriptor.method] = async (...args: unknown[]) => {
      if (args.length !== expected) {
        throw new Error(`client api: ${endpoint} expected ${expected} argument(s), got ${args.length}`)
      }
      const validatedArgs = descriptor.parameters.map((param, idx) => {
        const value = args[idx]
        if (value === undefined && param.acceptsUndefined) return undefined
        if (param.codec.mode === 'strict') return param.codec.create().parse(value)
        return value
      })
      const target = (service as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[descriptor.method]
      if (typeof target !== 'function') throw new Error(`Host service missing method: ${endpoint}`)
      try {
        const rawResult = await target.apply(service, validatedArgs)
        const parsedResult = descriptor.result.mode === 'strict'
          ? descriptor.result.create().parse(rawResult)
          : rawResult
        return { ok: true, value: parsedResult }
      } catch (error) {
        return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
      }
    }
  }
  return face
}

function loadClientBundleWithService(service?: AntigravityRemoteService) {
  let loaded: { id: string; factory: (req: (id: string) => unknown) => { name: string; inject: string[]; apply: (ctx: unknown) => void } } | undefined
  runInNewContext(clientBundleSource, {
    window: { __ModuleLoader__: { load: (v: unknown) => { loaded = v as typeof loaded } } },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  })
  if (!loaded) throw new Error('dist/client.js 未调用 window.__ModuleLoader__.load')

  const plugin = loaded.factory((id) => {
    if (id === 'react') return React
    throw new Error(`Unexpected require in client bundle: ${id}`)
  })

  const mountCalls: Array<{ package: string; descriptors: InvocationDescriptor[] }> = []
  const injectDecls: string[][] = [plugin.inject]
  const slots = new Map<string, RegisteredSlot>()
  let mountedFace: Record<string, (...args: unknown[]) => Promise<unknown>> | undefined

  const ctx = {
    get: (name: string) => (name === 'remote.antigravity' ? mountedFace : undefined),
    effect: (fn: () => unknown) => { fn() },
    inject: (deps: string[], fn: (scope: unknown) => void) => {
      injectDecls.push(deps)
      fn(ctx)
    },
    remote: {
      $mount: (spec: { package: string; descriptors: InvocationDescriptor[] }) => {
        mountCalls.push(spec)
        if (service) mountedFace = bindRealServiceWithGatewayValidation(spec.descriptors, service)
        return () => { mountedFace = undefined }
      },
      $on: () => () => {},
      settings: {
        describe: async () => ({
          ok: true,
          value: { writable: true, namespaces: [{ ns: 'llm-antigravity-acp', revision: 1, value: { hiddenModels: [] } }] },
        }),
        mutate: async () => ({ ok: true, value: {} }),
      },
      llm: { listProviders: async () => ({ ok: true, value: [{ id: 'antigravity-acp' }] }) },
    },
    slots: {
      inject: (_name: string, fn: () => () => void) => fn(),
      register: (row: RegisteredSlot['row'], component: RegisteredSlot['component']) => {
        slots.set(row.id, { row, component })
        return () => {}
      },
    },
    modelDirectories: {
      directoryFor: () => {
        const snap = { current: { provider: 'antigravity-acp', model: 'gemini-4-neon' } }
        return {
          store: {
            subscribe: () => () => {},
            getSnapshot: () => snap,
          },
        }
      },
    },
  }

  plugin.apply(ctx)
  return { plugin, mountCalls, injectDecls, slots, getMountedFace: () => mountedFace }
}

describe('dist/client.js bundled TSX client', () => {
  it('contains zero Node builtins, mounts remote.antigravity once, and enforces inject rules', () => {
    expect(clientBundleSource).not.toMatch(/require\(["']node:/)
    const { mountCalls, injectDecls, slots } = loadClientBundleWithService()

    expect(mountCalls).toHaveLength(1)
    expect(mountCalls[0]!.package).toBe(PACKAGE_NAME)
    expect(mountCalls[0]!.descriptors.map((d) => d.id)).toEqual(
      ANTIGRAVITY_REMOTE_INVOCATIONS.map((d) => d.id),
    )

    expect(injectDecls[0]).toEqual(expect.arrayContaining(['slots', 'remote', 'remote.settings', 'remote.llm']))
    expect(injectDecls.some((deps) => deps.includes('remote.antigravity'))).toBe(false)
    expect(slots.has('antigravity-acp')).toBe(true)
    expect(slots.has('antigravity-quota')).toBe(true)
  })

  it.skipIf(!REAL_TESTS_ENABLED || REAL_CLI_TOKEN_ACCOUNTS.length === 0)(
    'passes strict DSH gateway arity/codecs and renders pill + settings card using real host service & credentials',
    async () => {
      const baseDir = mkdtempSync(join(tmpdir(), 'agy-cli-ui-acc-'))
      const cacheDir = mkdtempSync(join(tmpdir(), 'agy-cli-ui-cache-'))
      dirs.push(baseDir, cacheDir)

      const realAccount = REAL_CLI_TOKEN_ACCOUNTS[0]!
      const accounts = new AccountsManager({
        baseDir,
        homeDir: realAccount.home,
        loginPort: 0,
        openBrowser: async () => false,
      })
      const realFetch = createRealProxiedFetch()
      const { runtime, killAll } = createRealSubprocessRuntime()
      const cliRun = createSubprocessCliRun(runtime, () => resolveHttpsProxy(undefined))
      const catalog = new CatalogStore({
        cacheDir,
        acpVersion: '1.4.0',
        loadCliModels: () => fetchAgyModels(cliRun, REAL_AGY_BIN!, realAccount.dir),
      })

      const service = new AntigravityRemoteService(new Context(), {
        accounts,
        deps: { fetchImpl: realFetch },
        cliQuotaEnabled: () => false,
        resolveCli: () => (REAL_AGY_BIN ? { run: cliRun, cliPath: REAL_AGY_BIN } : undefined),
        listModels: async (force) => {
          await catalog.refreshCliModels(force)
          const models = await catalog.listAllModels('antigravity-acp')
          return { status: 'ok', models: models.map(({ id, name }) => ({ id, name })) }
        },
        installCli: async () => ({ installed: false, message: `官方 CLI 已存在：${REAL_AGY_BIN}` }),
      })

      try {
        const { slots, getMountedFace } = loadClientBundleWithService(service)
        const face = getMountedFace()!
        const api = createAntigravityClientApi({
          get: (name) => (name === 'remote.antigravity' ? face : undefined),
        } satisfies ClientContextLike)

        // 1. 经真实 Gateway arity + strict codec 校验调用全部 RPC 方法
        await expect(api.readCurrentQuota()).resolves.toMatchObject({ status: 'ok' })
        await expect(api.readCurrentQuota({ force: false, model: 'gemini-4-neon' })).resolves.toMatchObject({ status: 'ok' })
        await expect(api.readAccountQuota('primary', false)).resolves.toMatchObject({ status: 'ok' })
        await expect(api.listModels(false)).resolves.toMatchObject({ status: 'ok' })
        await expect(api.listAccounts()).resolves.toMatchObject({ activeAccountId: 'primary', cliInstalled: true })
        await expect(api.activateAccount('primary')).resolves.toMatchObject({ activeAccountId: 'primary' })
        await expect(api.installCli()).resolves.toMatchObject({ installed: false })
        // 真实 loopback OAuth 启动 → 立即取消
        const started = await api.startAccountLogin({ mode: 'add', alias: 'UI-Check' })
        expect(started.auth.phase).toBe('waiting')
        await expect(api.cancelAccountLogin()).resolves.toMatchObject({ auth: { phase: 'cancelled' } })
        // 校验非法回调被真实宿主拒绝（但通过了 Gateway arity/codec 校验）
        await expect(api.submitAccountCallback('not-a-url')).rejects.toThrow()

        // 2. 渲染真实额度药丸：显示真实的百分比，不报读取失败
        const pillSlot = slots.get('antigravity-quota')!
        const pillProps = pillSlot.row.inject!('sess-real-1')
        let pillTree!: TestRenderer.ReactTestRenderer
        await act(async () => {
          pillTree = TestRenderer.create(React.createElement(pillSlot.component, pillProps))
          await new Promise((r) => setTimeout(r, 150))
        })
        const pillText = JSON.stringify(pillTree.toJSON())
        expect(pillText).toContain('Gemini')
        expect(pillText).toMatch(/\d+%/)
        expect(pillText).not.toContain('读取失败')
        pillTree.unmount()

        // 3. 渲染真实设置卡片（账号页 + 模型页）：零报错，真实展示账号与模型
        const settingsSlot = slots.get('antigravity-acp')!
        const settingsProps = settingsSlot.row.inject!()
        let settingsTree!: TestRenderer.ReactTestRenderer
        await act(async () => {
          settingsTree = TestRenderer.create(React.createElement(settingsSlot.component, settingsProps))
          await new Promise((r) => setTimeout(r, 250))
        })
        const settingsText = JSON.stringify(settingsTree.toJSON())
        expect(settingsText).toContain('主账号（系统登录）')
        expect(settingsText).toContain('Gemini 4 Neon')
        expect(settingsText).not.toContain('expected 1 argument')
        settingsTree.unmount()
      } finally {
        killAll()
        await accounts.dispose()
        await realFetch.close()
      }
    },
    120_000,
  )
})
