import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import React from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config, LIVE_SETTING_KEYS, liveHostConfig } from '../src/settings.js'

type SettingsDocument = { writable: boolean; namespaces: Array<{ ns: string; revision: number; value: Record<string, unknown> }> }

function document(value: Record<string, unknown> = {}, revision = 1, writable = true): SettingsDocument {
  return { writable, namespaces: [{ ns: 'llm-antigravity-acp', revision, value }] }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const renderers: ReactTestRenderer[] = []
afterEach(async () => {
  await act(async () => { for (const renderer of renderers.splice(0)) renderer.unmount() })
})

/** Real React hooks and rerenders; only the DSH loader/transport and browser timers are substituted. */
type SharedQuotaReader = ((force: boolean, source?: string) => Promise<unknown>)
function loadCard(quotaRead?: () => Promise<unknown>) {
  let registration: { factory(require: (id: string) => unknown): { apply(ctx: unknown): void } } | undefined
  const components = new Map<string, React.ComponentType<Record<string, unknown>>>()
  const injections = new Map<string, () => Record<string, unknown>>()
  const intervals = new Map<number, { callback: () => void; delay: number }>()
  let timerId = 0
  runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: (value: typeof registration) => { registration = value } }, innerHeight: 800, addEventListener: () => {}, removeEventListener: () => {} },
    document: { documentElement: { clientWidth: 1200 }, addEventListener: () => {}, removeEventListener: () => {} },
    setInterval: (callback: () => void, delay: number) => { intervals.set(++timerId, { callback, delay }); return timerId },
    clearInterval: (id: number) => intervals.delete(id),
    setTimeout, clearTimeout,
  })
  const slots = {
    inject: (_name: string, callback: () => void) => { callback(); return () => {} },
    register: (row: { id: string; inject?: () => Record<string, unknown> }, component: React.ComponentType<Record<string, unknown>>) => {
      components.set(row.id, component)
      if (row.inject) injections.set(row.id, row.inject)
      return () => {}
    },
  }
  const ctx = {
    slots,
    remote: { $mount: () => () => {} },
    get: (name: string) => name === 'remote.agyQuota' ? { read: quotaRead } : undefined,
    effect: (callback: () => unknown) => callback(),
    inject: (_names: string[], callback: (scope: unknown) => void) => callback(ctx),
  }
  registration!.factory(() => React).apply(ctx)
  return { Card: components.get('antigravity-acp')!, Pill: components.get('antigravity-quota')!, intervals,
    reader: injections.get('antigravity-acp')!().readQuota as SharedQuotaReader }
}

function transport(initial = document()) {
  let current = initial
  let listener: ((namespace: string) => void) | undefined
  const describe = vi.fn(async () => current)
  const mutate = vi.fn(async (_namespace: string, _ops: unknown[], _revision: number) => ({ ok: true, value: undefined }))
  return {
    describe, mutate,
    remote: {
      settings: { describe, mutate },
      llm: { listProviders: async () => [{ id: 'antigravity-acp' }] },
      $on: (_event: string, callback: (namespace: string) => void) => { listener = callback; return () => { listener = undefined } },
    },
    change(next: SettingsDocument) { current = next; listener?.('llm-antigravity-acp') },
    set(next: SettingsDocument) { current = next },
    notify() { listener?.('llm-antigravity-acp') },
  }
}

async function mount(remote: unknown, control?: unknown, readQuota?: unknown) {
  const { Card, intervals } = loadCard()
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(React.createElement(Card, { remote, control, readQuota })) })
  renderers.push(renderer)
  return { renderer, intervals }
}

async function mountPill(readQuota: unknown) {
  const { Pill } = loadCard()
  const modelSnapshot = { current: { provider: 'antigravity-acp', model: 'gemini-flash' } }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => modelSnapshot,
  }
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(React.createElement(Pill, { store, readQuota })) })
  renderers.push(renderer)
  return renderer
}

function button(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  return renderer.root.findAllByType('button').find((node) => node.children.join('') === label || node.props['aria-label'] === label)!
}
function fieldInput(renderer: ReactTestRenderer, name: string): ReactTestInstance {
  return renderer.root.findByProps({ name })
}
/** 逐模型列表里某一行的控件。 */
function modelControl(renderer: ReactTestRenderer, kind: 'enabled' | 'effort' | 'target' | 'name', id: string): ReactTestInstance {
  return renderer.root.findByProps({ name: `model-${kind}-${id}` })
}
function renderedText(renderer: ReactTestRenderer): string { return JSON.stringify(renderer.toJSON()) }

describe('quota pill with real React state and effects', () => {
  it('打开额度详情即可查看，不再出现刷新按钮', async () => {
    const snapshot = { status: 'ok', groups: [{ name: 'Gemini', buckets: [{ window: '5h', remainingPct: 82 }] }] }
    const readQuota = vi.fn(async () => snapshot)
    const renderer = await mountPill(readQuota)
    expect(readQuota).toHaveBeenCalled()
    await act(async () => { await renderer.root.findByProps({ 'aria-haspopup': 'dialog' }).props.onClick() })
    expect(renderer.root.findAll((node) => node.type === 'button' && node.children.join('') === '刷新额度')).toHaveLength(0)
    expect(renderedText(renderer)).toContain('82')
    await act(async () => { renderer.root.findByProps({ 'aria-label': '关闭额度详情' }).props.onClick() })
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0)
  })

  it('跨家族官方映射使用实际路由模型的额度组', async () => {
    const renderer = await mountPill(async () => ({
      status: 'ok', requestedModel: 'gemini-flash', routeModel: 'claude-opus-5-5-low',
      groups: [
        { name: 'Gemini', buckets: [{ window: '5h', remainingPct: 81 }] },
        { name: 'Claude and GPT models', buckets: [{ window: '5h', remainingPct: 42 }] },
      ],
    }))
    expect(renderer.root.findByProps({ role: 'progressbar' }).props['aria-valuenow']).toBe(42)
  })

  it('失败信封转成可读错误，不把异常抛出组件', async () => {
    const renderer = await mountPill(async () => ({ ok: false, error: { message: 'remote denied' } }))
    expect(renderer.root.findByProps({ 'aria-haspopup': 'dialog' }).props['aria-label']).toContain('额度读取失败')
    await act(async () => { await renderer.root.findByProps({ 'aria-haspopup': 'dialog' }).props.onClick() })
    expect(renderedText(renderer)).toContain('remote denied')
  })

})

describe('settings card with real React state and effects', () => {

  /** 目录桩：两个模型，供逐模型设置渲染。 */
  const catalog = () => ({ status: 'ok' as const, models: [
    { id: 'gemini-3-pro', name: 'Gemini 3 Pro', inputModalities: ['text', 'image'] },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet' },
  ] })
  const controlWith = (models: unknown = catalog(), account: Record<string, unknown> = { state: 'idle', message: 'ready' }) =>
    vi.fn(async (method: string) => method === 'account' ? account : models)

  it('模型只以标签展示显示 / 隐藏，不再有逐模型编辑器', async () => {
    const service = transport()
    const { renderer } = await mount(service.remote, controlWith())
    await act(async () => { button(renderer, '模型').props.onClick() })
    const chip = button(renderer, 'Gemini 3 Pro')
    expect(chip.props['aria-pressed']).toBe(true)
    await act(async () => { chip.props.onClick() })
    expect(button(renderer, 'Gemini 3 Pro').props['aria-pressed']).toBe(false)
    expect(renderer.root.findAllByProps({ name: 'model-effort-gemini-3-pro' })).toHaveLength(0)
  })

  it('模型目录为空时提示先发一次对话', async () => {
    const service = transport()
    const { renderer } = await mount(service.remote, controlWith({ status: 'ok', models: [] }))
    await act(async () => { button(renderer, '模型').props.onClick() })
    expect(renderedText(renderer)).toContain('模型目录还没有可用模型')
  })








  const accountSnapshot = {
    state: 'idle', message: 'ready', activeAccountId: 'primary', auth: { phase: 'idle' },
    accounts: [{ id: 'primary', alias: '主账号（系统登录）', system: true, active: true, ready: true, createdAt: 0 }],
  }
  const accountControl = () => vi.fn(async (method: string) => method === 'account'
    ? accountSnapshot
    : { status: 'ok', models: [] })

  it('账号页合并连接与额度：账号卡片自动读取该账号额度', async () => {
    const service = transport()
    const control = accountControl()
    const readQuota = Object.assign(vi.fn(async () => ({
      status: 'ok', updatedAt: '2026-11-17T00:00:00.000Z', plan: '示例套餐',
      groups: [{ name: 'Gemini Models', buckets: [{ window: '5h', remainingPct: 73 }] }],
    })), {
      readAccount: vi.fn(async () => ({
        status: 'ok', updatedAt: '2026-11-17T00:00:00.000Z', plan: '示例套餐',
        groups: [{ name: 'Gemini Models', buckets: [{ window: '5h', remainingPct: 73 }] }],
      })),
    })
    const { renderer } = await mount(service.remote, control, readQuota)
    await act(async () => {})
    expect(readQuota.readAccount).toHaveBeenCalledWith(false, 'antigravity-acp', 'primary')
    expect(renderer.root.findAll((node) => node.type === 'button' && node.children.join('') === '拉取额度')).toHaveLength(0)
    expect(renderer.root.findAll((node) => node.type === 'button' && ['连接 / 登录 ACP', '立即预热', '取消连接'].includes(node.children.join('')))).toHaveLength(0)
    expect(renderedText(renderer)).toContain('73%')
    expect(renderedText(renderer)).toContain('示例套餐')
    // 连接与额度合并；高级页并入账号页后只剩「账号 / 模型」。
    const tabs = renderer.root.findAll((node) => node.type === 'button' && node.props.role === 'tab')
    expect(tabs.map((node) => node.children.join(''))).toEqual(['账号', '模型'])
  })

  it('面板添加账号：显示授权链接，取消后回到空闲', async () => {
    const service = transport()
    let auth: Record<string, unknown> = { phase: 'idle' }
    const control = vi.fn(async (method: string, request?: { action?: string }) => {
      if (method !== 'account') return { status: 'ok', models: [] }
      if (request?.action === 'add-account') auth = { phase: 'waiting', message: '等待浏览器授权…', authUrl: 'https://accounts.google.com/auth' }
      if (request?.action === 'cancel-add') auth = { phase: 'cancelled', message: '已取消登录' }
      return { ...accountSnapshot, auth }
    })
    const { renderer } = await mount(service.remote, control, {} as never)
    await act(async () => { await button(renderer, '添加账号').props.onClick() })
    expect(control).toHaveBeenCalledWith('account', { action: 'add-account' })
    expect(renderer.root.findAll((node) => node.type === 'a' && node.props.href === 'https://accounts.google.com/auth')).toHaveLength(1)
    await act(async () => { await button(renderer, '取消登录').props.onClick() })
    expect(control).toHaveBeenCalledWith('account', { action: 'cancel-add' })
    expect(renderer.root.findAllByType('button').some((node) => node.children.join('') === '取消登录')).toBe(false)
  })

  it('账号卡片切换与两段确认删除', async () => {
    const service = transport()
    const accounts = [
      { id: 'primary', alias: '主账号（系统登录）', system: true, active: true, ready: true, createdAt: 0 },
      { id: 'acc_2', alias: '备用账号', email: 'backup@example.com', system: false, active: false, ready: true, createdAt: 1 },
    ]
    let current = { ...accountSnapshot, accounts }
    const control = vi.fn(async (method: string, request?: { action?: string; id?: string }) => {
      if (method !== 'account') return { status: 'ok', models: [] }
      if (request?.action === 'activate') current = { ...current, activeAccountId: 'acc_2', accounts: accounts.map((row) => ({ ...row, active: row.id === 'acc_2' })) }
      if (request?.action === 'remove') current = { ...current, accounts: accounts.filter((row) => row.id !== 'acc_2') }
      return current
    })
    const { renderer } = await mount(service.remote, control, {} as never)
    expect(renderedText(renderer)).toContain('备用账号')
    await act(async () => { await button(renderer, '使用此账号').props.onClick() })
    expect(control).toHaveBeenCalledWith('account', { action: 'activate', id: 'acc_2' })
    const remove = renderer.root.findAllByType('button').find((node) => node.children.join('') === '删除')!
    await act(async () => { remove.props.onClick() })
    expect(renderedText(renderer)).toContain('确认删除')
    await act(async () => { await button(renderer, '确认删除').props.onClick() })
    expect(control).toHaveBeenCalledWith('account', { action: 'remove', id: 'acc_2' })
  })



})
