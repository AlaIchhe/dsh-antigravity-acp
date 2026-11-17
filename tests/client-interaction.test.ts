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
  it('共享额度读取器通知自身时也结束刷新，可再次手动刷新', async () => {
    const listeners = new Set<(value: unknown, source: unknown) => void>()
    const snapshot = { status: 'ok', groups: [{ name: 'Gemini', buckets: [{ window: '5h', remainingPct: 82 }] }] }
    const readQuota = Object.assign(vi.fn(async (_force: boolean, source: unknown) => {
      for (const listener of listeners) listener(snapshot, source)
      return snapshot
    }), { subscribe: (listener: (value: unknown, source: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener) } })
    const renderer = await mountPill(readQuota)
    await act(async () => { await renderer.root.findByProps({ 'aria-haspopup': 'dialog' }).props.onClick() })
    expect(button(renderer, '刷新额度').props.disabled).toBe(false)
    await act(async () => { await button(renderer, '刷新额度').props.onClick() })
    expect(readQuota).toHaveBeenCalledTimes(2)
    expect(button(renderer, '刷新额度').props.disabled).toBe(false)
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

  it('刷新异常保留成功快照并标缓存，后续成功清除缓存标记', async () => {
    let fail = false
    const snapshot = { status: 'ok', updatedAt: '2026-10-25T00:00:00Z', groups: [
      { name: 'Gemini Models', buckets: [{ window: '5h', remainingPct: 82 }] },
    ] }
    const readQuota = vi.fn(async () => {
      if (fail) throw new Error('refresh timeout')
      return snapshot
    })
    const renderer = await mountPill(readQuota)
    await act(async () => { await renderer.root.findByProps({ 'aria-haspopup': 'dialog' }).props.onClick() })
    expect(renderedText(renderer)).toContain('82')
    fail = true
    await act(async () => { await button(renderer, '刷新额度').props.onClick() })
    expect(renderedText(renderer)).toContain('缓存数据 · Error: refresh timeout')
    expect(renderedText(renderer)).toContain('82')
    fail = false
    await act(async () => { await button(renderer, '刷新额度').props.onClick() })
    expect(renderedText(renderer)).not.toContain('缓存数据')
    expect(renderedText(renderer)).toContain('82')
  })
})

describe('settings card with real React state and effects', () => {
  it('保存栏常驻顶部，只提供一个保存入口，编辑和撤销更新未保存计数', async () => {
    const service = transport(document())
    const { renderer } = await mount(service.remote)
    const bar = renderer.root.findByProps({ 'aria-label': '设置保存操作' })
    expect(bar.props.style).toMatchObject({ position: 'sticky', top: 0, display: 'none' })
    expect(bar.findAllByType('button').filter(node => node.children.join('') === '保存')).toHaveLength(1)
    expect(button(renderer, '保存').props.disabled).toBe(true)
    await act(async () => { fieldInput(renderer, 'proxyUrl').props.onChange({ target: { value: 'http://127.0.0.1:7890' } }) })
    expect(renderedText(renderer)).toContain('1 项未保存')
    expect(bar.props.style.display).toBe('grid')
    expect(button(renderer, '保存').props.disabled).toBe(false)
    await act(async () => { button(renderer, '撤销').props.onClick() })
    expect(renderedText(renderer)).not.toContain('项未保存')
    expect(button(renderer, '保存').props.disabled).toBe(true)
  })

  /** 目录桩：两个模型，供逐模型设置渲染。 */
  const catalog = () => ({ status: 'ok' as const, models: [
    { id: 'gemini-3-pro', name: 'Gemini 3 Pro', inputModalities: ['text', 'image'] },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet' },
  ] })
  const controlWith = (models: unknown = catalog(), account: Record<string, unknown> = { state: 'idle', message: 'ready' }) =>
    vi.fn(async (method: string) => method === 'account' ? account : models)

  it('逐模型设置只提交有意义的字段，清空的项从配置里移除', async () => {
    const service = transport(document({
      modelOverrides: { 'gemini-3-pro': { enabled: false, effort: 'low', name: '旧名', target: 'gemini-3-pro-high' } },
    }))
    const { renderer } = await mount(service.remote, controlWith())
    expect(modelControl(renderer, 'enabled', 'gemini-3-pro').props.checked).toBe(false)
    expect(modelControl(renderer, 'effort', 'gemini-3-pro').props.value).toBe('low')
    expect(modelControl(renderer, 'name', 'gemini-3-pro').props.value).toBe('旧名')
    await act(async () => {
      modelControl(renderer, 'enabled', 'gemini-3-pro').props.onChange({ target: { checked: true } })
      modelControl(renderer, 'effort', 'gemini-3-pro').props.onChange({ target: { value: '' } })
      modelControl(renderer, 'name', 'gemini-3-pro').props.onChange({ target: { value: '  ' } })
      modelControl(renderer, 'target', 'gemini-3-pro').props.onChange({ target: { value: '' } })
    })
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).toHaveBeenCalledWith('llm-antigravity-acp', [{ op: 'set', path: ['modelOverrides'], value: {} }], 1)
  })

  it('全部模型被隐藏时提示 provider 会从选择器消失，重新启用后提示消失', async () => {
    const service = transport(document({ modelOverrides: { 'gemini-3-pro': { enabled: false }, 'claude-sonnet-5-5': { enabled: false } } }))
    const { renderer } = await mount(service.remote, controlWith())
    expect(renderedText(renderer)).toContain('全部隐藏后')
    await act(async () => { modelControl(renderer, 'enabled', 'gemini-3-pro').props.onChange({ target: { checked: true } }) })
    expect(renderedText(renderer)).not.toContain('全部隐藏后')
    expect(renderedText(renderer)).toContain('已隐藏 1')
  })

  it('已经保存但当前目录没有的模型 ID 仍可编辑，并标注不在目录', async () => {
    const service = transport(document({ modelOverrides: { 'retired-model': { target: 'retired-model-high' } } }))
    const { renderer } = await mount(service.remote, controlWith())
    expect(modelControl(renderer, 'target', 'retired-model').props.value).toBe('retired-model-high')
    expect(renderedText(renderer)).toContain('不在当前目录')
    expect(renderedText(renderer)).toContain('全部 3')
  })

  it('模型可搜索并按启停筛选，折叠的高级映射仍可编辑', async () => {
    const service = transport(document({ modelOverrides: { 'gemini-3-pro': { enabled: false } } }))
    const { renderer } = await mount(service.remote, controlWith())
    const search = renderer.root.findByProps({ 'aria-label': '搜索模型' })
    await act(async () => { search.props.onChange({ target: { value: 'claude' } }) })
    expect(renderer.root.findAllByProps({ name: 'model-enabled-gemini-3-pro' })).toHaveLength(0)
    expect(modelControl(renderer, 'enabled', 'claude-sonnet-5-5')).toBeDefined()
    await act(async () => { search.props.onChange({ target: { value: '' } }) })
    const filter = renderer.root.findByProps({ 'aria-label': '筛选模型' })
    await act(async () => { filter.props.onChange({ target: { value: 'hidden' } }) })
    expect(modelControl(renderer, 'enabled', 'gemini-3-pro').props.checked).toBe(false)
    expect(renderer.root.findAllByProps({ name: 'model-enabled-claude-sonnet-5-5' })).toHaveLength(0)
    await act(async () => { button(renderer, '全部启用').props.onClick() })
    await act(async () => { filter.props.onChange({ target: { value: 'all' } }) })
    expect(modelControl(renderer, 'enabled', 'gemini-3-pro').props.checked).toBe(true)
  })

  it('缺少设置 namespace 时解释禁用原因，宿主恢复后重新启用控件', async () => {
    const service = transport({ writable: true, namespaces: [] })
    const { renderer } = await mount(service.remote)
    expect(fieldInput(renderer, 'proxyUrl').props.disabled).toBe(true)
    expect(renderedText(renderer)).toContain('尚未提供 Antigravity ACP 的可编辑设置')
    await act(async () => { service.change(document({ proxyUrl: 'http://restored:7890' })) })
    expect(fieldInput(renderer, 'proxyUrl').props.disabled).toBe(false)
    expect(renderedText(renderer)).not.toContain('尚未提供 Antigravity ACP 的可编辑设置')
  })

  it('respects read-only settings instead of offering a save that will fail', async () => {
    const service = transport(document({ proxyUrl: 'http://old:7890' }, 1, false))
    const { renderer } = await mount(service.remote, controlWith())
    expect(fieldInput(renderer, 'proxyUrl').props.disabled).toBe(true)
    expect(modelControl(renderer, 'enabled', 'gemini-3-pro').props.disabled).toBe(true)
    expect(button(renderer, '保存').props.disabled).toBe(true)
    expect(renderedText(renderer)).toContain('只读设置')
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).not.toHaveBeenCalled()
  })

  it('preserves edited fields and merges untouched fields after an external update', async () => {
    const service = transport(document({ proxyUrl: 'http://old:7890', modelOverrides: { 'gemini-3-pro': { effort: 'low' } } }))
    const { renderer } = await mount(service.remote, controlWith())
    await act(async () => { modelControl(renderer, 'target', 'gemini-3-pro').props.onChange({ target: { value: 'custom-target' } }) })
    // 外部同时改了代理和同一个模型的档位：草稿里的映射必须保留并提示冲突。
    await act(async () => { service.change(document({ proxyUrl: 'http://new:7890', modelOverrides: { 'gemini-3-pro': { effort: 'high' } } }, 2)) })
    expect(modelControl(renderer, 'target', 'gemini-3-pro').props.value).toBe('custom-target')
    expect(modelControl(renderer, 'effort', 'gemini-3-pro').props.value).toBe('low')
    expect(fieldInput(renderer, 'proxyUrl').props.value).toBe('http://new:7890')
    expect(renderedText(renderer)).toContain('已保留你的输入')
    expect(renderedText(renderer)).toContain('模型列表设置')
    expect(renderedText(renderer)).toContain('1 项未保存')
    expect(button(renderer, '保存').props.disabled).toBe(false)
  })

  it('ignores an old settings request that resolves after the latest revision', async () => {
    const service = transport()
    const first = deferred<SettingsDocument>()
    service.describe.mockImplementationOnce(() => first.promise)
    const { renderer } = await mount(service.remote, controlWith())
    await act(async () => { service.change(document({ proxyUrl: 'http://latest:7890' }, 3)) })
    await act(async () => { first.resolve(document({ proxyUrl: 'http://stale:7890' }, 1)) })
    expect(fieldInput(renderer, 'proxyUrl').props.value).toBe('http://latest:7890')
    expect(button(renderer, '保存').props.disabled).toBe(true)
  })

  it('can discard a conflicted draft and restore the latest server settings', async () => {
    const service = transport(document({ modelOverrides: { 'gemini-3-pro': { effort: 'low' } } }))
    const { renderer } = await mount(service.remote, controlWith())
    await act(async () => { modelControl(renderer, 'effort', 'gemini-3-pro').props.onChange({ target: { value: 'high' } }) })
    await act(async () => { service.change(document({ modelOverrides: { 'gemini-3-pro': { effort: 'medium' } } }, 2)) })
    await act(async () => { button(renderer, '撤销').props.onClick() })
    expect(modelControl(renderer, 'effort', 'gemini-3-pro').props.value).toBe('medium')
    expect(button(renderer, '保存').props.disabled).toBe(true)
    expect(renderedText(renderer)).not.toContain('其他位置更新了以下设置')
    expect(service.mutate).not.toHaveBeenCalled()
  })

  it('serializes save clicks and submits only edited fields, including a cleared value', async () => {
    const service = transport(document({ proxyUrl: 'http://proxy:7890' }))
    const saved = deferred<{ ok: boolean; value: undefined }>()
    service.mutate.mockImplementationOnce(() => saved.promise)
    const { renderer } = await mount(service.remote, controlWith())
    await act(async () => { fieldInput(renderer, 'proxyUrl').props.onChange({ target: { value: '' } }) })
    const save = button(renderer, '保存').props.onClick as () => Promise<void>
    await act(async () => { void save(); void save() })
    expect(service.mutate).toHaveBeenCalledTimes(1)
    expect(service.mutate).toHaveBeenCalledWith('llm-antigravity-acp', [{ op: 'set', path: ['proxyUrl'], value: '' }], 1)
    expect(button(renderer, '保存中…').props.disabled).toBe(true)
    expect(fieldInput(renderer, 'proxyUrl').props.disabled).toBe(true)
    await act(async () => {
      service.change(document({ proxyUrl: '' }, 2))
      saved.resolve({ ok: true, value: undefined })
    })
    expect(fieldInput(renderer, 'proxyUrl').props.value).toBe('')
    expect(button(renderer, '保存').props.disabled).toBe(true)
    expect(renderedText(renderer)).not.toContain('项未保存的修改')
  })

  it('preserves the draft and refreshes the revision after a rejected mutation', async () => {
    const service = transport(document({ proxyUrl: 'http://old:7890' }))
    service.mutate.mockRejectedValueOnce(new Error('revision conflict'))
    const { renderer } = await mount(service.remote, controlWith())
    await act(async () => { fieldInput(renderer, 'proxyUrl').props.onChange({ target: { value: 'http://mine:7890' } }) })
    service.set(document({ proxyUrl: 'http://other:7890' }, 2))
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(fieldInput(renderer, 'proxyUrl').props.value).toBe('http://mine:7890')
    expect(renderedText(renderer)).toContain('revision conflict')
    expect(renderedText(renderer)).toContain('已保留你的输入')
    expect(button(renderer, '保存').props.disabled).toBe(false)
    service.set(document({ proxyUrl: 'http://mine:7890' }, 3))
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate.mock.calls[1]?.[2]).toBe(2)
  })

  it('目录变化时刷新逐模型列表，手动列目录也能读到新条目', async () => {
    const service = transport()
    let revision = 1
    const control = vi.fn(async (method: string, request?: { force?: boolean }) => {
      if (method === 'account') return { state: 'idle', message: 'ready', runtime: { phase: 'ready', modelCatalogRevision: revision } }
      if (request?.force) return { status: 'ok', models: [{ id: 'fresh-model', name: 'Fresh' }] }
      return revision === 1 ? { status: 'ok', models: [] } : catalog()
    })
    const { renderer, intervals } = await mount(service.remote, control)
    expect(renderedText(renderer)).toContain('暂无模型')
    revision = 2
    await act(async () => { for (const timer of intervals.values()) if (timer.delay === 2000) timer.callback() })
    expect(modelControl(renderer, 'target', 'gemini-3-pro').props.value).toBe('')
    expect(renderedText(renderer)).toContain('文本 · 图片')
    await act(async () => { await button(renderer, '刷新模型目录').props.onClick() })
    expect(modelControl(renderer, 'enabled', 'fresh-model')).toBeDefined()
  })

  it('后台目录通知不覆盖手动拉取的等待状态和失败原因，可再次点击重试', async () => {
    const service = transport()
    const pending = deferred<unknown>()
    let revision = 1
    let fail = true
    const control = vi.fn(async (method: string, request?: { force?: boolean }) => {
      if (method === 'account') return { state: 'idle', runtime: { modelCatalogRevision: revision } }
      if (request?.force) return fail ? pending.promise : { status: 'ok', models: [{ id: 'new-model', name: 'New Model' }] }
      return { status: 'ok', models: [{ id: 'old-model', name: 'Old Model' }] }
    })
    const { renderer, intervals } = await mount(service.remote, control)
    await act(async () => { void button(renderer, '刷新模型目录').props.onClick() })
    expect(renderedText(renderer)).toContain('正在拉取模型目录')
    const calls = control.mock.calls.filter(([method]) => method === 'models').length
    revision++
    await act(async () => { for (const timer of intervals.values()) if (timer.delay === 2000) timer.callback() })
    expect(control.mock.calls.filter(([method]) => method === 'models')).toHaveLength(calls)
    expect(button(renderer, '正在刷新…').props.disabled).toBe(true)
    await act(async () => { pending.resolve({ status: 'error', models: [{ id: 'old-model', name: 'Old Model' }], message: '目录拉取失败，请重试' }) })
    expect(renderedText(renderer)).toContain('目录拉取失败，请重试')
    expect(button(renderer, '刷新模型目录').props.disabled).toBe(false)
    fail = false
    await act(async () => { await button(renderer, '刷新模型目录').props.onClick() })
    expect(modelControl(renderer, 'enabled', 'new-model')).toBeDefined()
  })

  const accountSnapshot = {
    state: 'idle', message: 'ready', activeAccountId: 'primary', auth: { phase: 'idle' },
    accounts: [{ id: 'primary', alias: '主账号（系统登录）', system: true, active: true, ready: true, createdAt: 0 }],
  }
  const accountControl = () => vi.fn(async (method: string) => method === 'account'
    ? accountSnapshot
    : { status: 'ok', models: [] })

  it('账号页合并连接与额度：账号卡片内登录并手动拉取该账号额度', async () => {
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
    expect(button(renderer, '连接 / 登录 ACP')).toBeDefined()
    expect(button(renderer, '拉取额度 主账号（系统登录）')).toBeDefined()
    expect(renderedText(renderer)).toContain('尚未查询')
    await act(async () => { await button(renderer, '拉取额度 主账号（系统登录）').props.onClick() })
    expect(readQuota.readAccount).toHaveBeenCalledWith(true, 'antigravity-acp', 'primary')
    expect(renderedText(renderer)).toContain('73%')
    expect(renderedText(renderer)).toContain('示例套餐')
    // 连接与额度合并；高级页并入账号页后只剩「账号 / 模型」。
    const tabs = renderer.root.findAll((node) => node.type === 'button' && node.props.role === 'tab')
    expect(tabs.map((node) => node.children.join(''))).toEqual(['账号', '模型'])
    await act(async () => { await button(renderer, '连接 / 登录 ACP').props.onClick() })
    expect(control).toHaveBeenCalledWith('account', { action: 'login' })
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

  it('shows session switches and submits timers as numbers, preserving zero', async () => {
    const service = transport()
    const { renderer } = await mount(service.remote)
    expect(renderer.root.findByProps({ name: 'reuseSessions' }).props.checked).toBe(true)
    expect(renderer.root.findByProps({ name: 'resumeSessions' }).props.checked).toBe(false)
    expect(renderer.root.findByProps({ name: 'keepProcessAfterCancel' }).props.checked).toBe(false)
    expect(renderer.root.findByProps({ name: 'cancelGraceMs' }).props.value).toBe(30000)
    expect(renderer.root.findByProps({ name: 'idleRecycleMs' }).props.value).toBe(300000)
    await act(async () => {
      renderer.root.findByProps({ name: 'keepProcessAfterCancel' }).props.onChange({ target: { checked: true } })
      renderer.root.findByProps({ name: 'cancelGraceMs' }).props.onChange({ target: { value: '12000' } })
      renderer.root.findByProps({ name: 'idleRecycleMs' }).props.onChange({ target: { value: '0' } })
    })
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).toHaveBeenCalledWith('llm-antigravity-acp', [
      { op: 'set', path: ['keepProcessAfterCancel'], value: true },
      { op: 'set', path: ['cancelGraceMs'], value: 12000 },
      { op: 'set', path: ['idleRecycleMs'], value: 0 },
    ], 1)
  })

  for (const invalid of ['', '-1', '0.5', '60001', 'NaN']) {
    it(`rejects invalid cancel grace ${JSON.stringify(invalid)} without losing the draft`, async () => {
      const service = transport()
      const { renderer } = await mount(service.remote)
      await act(async () => { renderer.root.findByProps({ name: 'cancelGraceMs' }).props.onChange({ target: { value: invalid } }) })
      await act(async () => { await button(renderer, '保存').props.onClick() })
      expect(service.mutate).not.toHaveBeenCalled()
      expect(renderedText(renderer)).toContain('必须是 0–60000 的整数')
      expect(button(renderer, '保存').props.disabled).toBe(false)
    })
  }

  it('displays pool pressure and clears subscriptions and polling on unmount', async () => {
    const service = transport()
    const control = vi.fn(async (method: string) => method === 'account'
      ? {
        state: 'connected', message: 'ready',
        runtime: { phase: 'prompt', queue: { active: 2, parked: 1, waiting: 3, workers: 2, capacity: 2 } },
        activeAccountId: 'primary', auth: { phase: 'idle' },
        accounts: [{ id: 'primary', alias: '主账号（系统登录）', system: true, active: true, ready: true, createdAt: 0 }],
      }
      : { status: 'ok', models: [] })
    const { renderer, intervals } = await mount(service.remote, control)
    expect(renderedText(renderer)).toContain('运行 2 · 等待工具 1 · 排队 3')
    expect(button(renderer, '连接 / 登录 ACP').props.disabled).toBe(true)
    expect(button(renderer, '立即预热').props.disabled).toBe(true)
    const before = service.describe.mock.calls.length
    await act(async () => { renderer.unmount() })
    expect(intervals.size).toBe(0)
    service.notify()
    expect(service.describe.mock.calls.length).toBe(before)
  })
})
