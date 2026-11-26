/**
 * 端到端验证构建产物 `dist/client.js`：
 * - 无任何 Node 原生模块依赖；
 * - 注册 `dsh-bundle-antigravity-acp#antigravity/*` 共 9 个 RPC 方法；
 * - `inject` 逐个声明 `remote.settings` / `remote.llm`，且绝不声明 `remote.antigravity`；
 * - 额度药丸正确拆封 `{ ok, value }` 信封并渲染当前家族剩余百分比；
 * - 设置卡片无死 `stale` 分支，正常渲染账号与模型两页。
 */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { ANTIGRAVITY_REMOTE_INVOCATIONS, PACKAGE_NAME } from '../src/shared/rpc-contract.js'

const clientBundleSource = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')

interface RegisteredSlot {
  row: { id: string; name: string; order: number; inject?: (...args: unknown[]) => Record<string, unknown> }
  component: React.ComponentType<Record<string, unknown>>
}

function loadClientBundle(mocks: {
  readQuota?: () => Promise<unknown>
  listAccounts?: () => Promise<unknown>
  listModels?: () => Promise<unknown>
  describeSettings?: () => Promise<unknown>
} = {}) {
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

  const mountCalls: Array<{ package: string; descriptors: Array<{ id: string }> }> = []
  const injectDecls: string[][] = [plugin.inject]
  const slots = new Map<string, RegisteredSlot>()

  const remoteFace = {
    readQuota: mocks.readQuota ?? (async () => ({
      ok: true,
      value: {
        status: 'ok',
        updatedAt: '2026-11-26T12:00:00Z',
        plan: 'Google AI Pro',
        groups: [{ name: 'Gemini Models', buckets: [{ name: '5h', window: '5h', remainingPct: 88, disabled: false }] }],
      },
    })),
    listAccounts: mocks.listAccounts ?? (async () => ({
      ok: true,
      value: {
        accounts: [{ id: 'primary', alias: '主账号（系统登录）', system: true, active: true, ready: true, createdAt: 0 }],
        activeAccountId: 'primary',
        auth: { phase: 'idle' },
        cliInstalled: true,
      },
    })),
    listModels: mocks.listModels ?? (async () => ({
      ok: true,
      value: { status: 'ok', models: [{ id: 'gemini-4-neon', name: 'Gemini 4 Neon' }] },
    })),
  }

  const ctx = {
    get: (name: string) => (name === 'remote.antigravity' ? remoteFace : undefined),
    effect: (fn: () => unknown) => { fn() },
    inject: (deps: string[], fn: (scope: unknown) => void) => {
      injectDecls.push(deps)
      fn(ctx)
    },
    remote: {
      $mount: (spec: { package: string; descriptors: Array<{ id: string }> }) => {
        mountCalls.push(spec)
        return () => {}
      },
      $on: () => () => {},
      settings: {
        describe: mocks.describeSettings ?? (async () => ({
          ok: true,
          value: { writable: true, namespaces: [{ ns: 'llm-antigravity-acp', revision: 1, value: { hiddenModels: [] } }] },
        })),
        mutate: vi.fn(async () => ({ ok: true, value: {} })),
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
  return { plugin, mountCalls, injectDecls, slots }
}

describe('dist/client.js bundled TSX client', () => {
  it('contains zero Node builtins, mounts remote.antigravity once, and enforces inject rules', () => {
    expect(clientBundleSource).not.toMatch(/require\(["']node:/)
    const { mountCalls, injectDecls, slots } = loadClientBundle()

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

  it('renders quota pill and settings card cleanly with envelope unwrapping', async () => {
    const { slots } = loadClientBundle()

    const pillSlot = slots.get('antigravity-quota')!
    const pillProps = pillSlot.row.inject!('sess-1')
    let pillTree!: TestRenderer.ReactTestRenderer
    await act(async () => {
      pillTree = TestRenderer.create(React.createElement(pillSlot.component, pillProps))
      await new Promise((r) => setTimeout(r, 20))
    })
    const pillText = JSON.stringify(pillTree.toJSON())
    expect(pillText).toContain('Gemini')
    expect(pillText).toContain('88%')
    pillTree.unmount()

    const settingsSlot = slots.get('antigravity-acp')!
    const settingsProps = settingsSlot.row.inject!()
    let settingsTree!: TestRenderer.ReactTestRenderer
    await act(async () => {
      settingsTree = TestRenderer.create(React.createElement(settingsSlot.component, settingsProps))
      await new Promise((r) => setTimeout(r, 20))
    })
    const settingsText = JSON.stringify(settingsTree.toJSON())
    expect(settingsText).toContain('主账号（系统登录）')
    expect(settingsText).toContain('Gemini 4 Neon')
    settingsTree.unmount()
  })
})
