/** 离线预览夹具共享模块（v1.0：从构建后的 dist/client.js 渲染静态 HTML）。 */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')
const quota = {
  status: 'ok',
  updatedAt: '2026-10-22T03:00:00+08:00',
  plan: '示例套餐',
  groups: [
    { name: 'Gemini Models', buckets: [{ name: '5h', window: '5h', remainingPct: 86, resetTime: new Date(Date.now() + 2 * 3600_000).toISOString(), disabled: false }, { name: 'Weekly', window: 'weekly', remainingPct: 72, disabled: false }] },
    { name: 'Claude and GPT models', buckets: [{ name: '5h', window: '5h', remainingPct: 42, disabled: false }, { name: 'Weekly', window: 'weekly', remainingPct: 24, disabled: false }] },
    { name: 'Gemini 4 Argon', buckets: [{ name: '5h', window: '5h', remainingPct: 8, disabled: false }, { name: 'Weekly', window: 'weekly', remainingPct: 31, disabled: false }] },
  ],
  credits: { status: 'ok', remainingCredits: 1234, planName: '示例套餐', updatedAt: '2026-10-22T03:00:00+08:00' },
}

let plugin
runInNewContext(source, { window: { __ModuleLoader__: { load(value) { plugin = value } } } })
let index = 0
let states = {}
const React = {
  createElement: (type, props, ...children) => (
    typeof type === 'function'
      ? type({ ...(props ?? {}), children: children.flat() })
      : { type, props: props ?? {}, children: children.flat() }
  ),
  Fragment: ({ children }) => ({ type: 'div', props: {}, children: children ?? [] }),
  useState: (initial) => [index in states ? states[index++] : (index++, initial), () => {}],
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  useEffect() {},
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

const components = new Map()
const ctx = {
  effect(fn) { fn(); return () => {} },
  inject(_deps, fn) { fn(ctx) },
  get() {},
  remote: { $mount() { return () => {} } },
  slots: {
    inject(_name, fn) { fn(); return () => {} },
    register(row, component) { components.set(row.id, component); return () => {} },
  },
}
plugin.factory(() => React).apply(ctx)

const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const booleanAttributes = new Set(['disabled', 'checked', 'selected', 'multiple', 'readOnly', 'required'])
const unitlessStyles = new Set(['opacity', 'zIndex', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink', 'order'])

function html(node) {
  if (node === undefined || node === null || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(html).join('')
  if (typeof node !== 'object') return escape(node)
  const { type, props, children } = node
  let attrs = ''
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || key === 'ref' || key === 'key' || key.startsWith('on')) continue
    if (key === 'className') attrs += ` class="${escape(value)}"`
    else if (key === 'style') {
      attrs += ' style="' + escape(Object.entries(value).map(([k, v]) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) + ':' + (typeof v === 'number' && v !== 0 && !unitlessStyles.has(k) ? v + 'px' : v)).join(';')) + '"'
    } else if (booleanAttributes.has(key)) { if (value) attrs += ' ' + key.toLowerCase() }
    else attrs += ' ' + key + '="' + escape(value) + '"'
  }
  return '<' + type + attrs + '>' + (children ?? []).map(html).join('') + '</' + type + '>'
}

function render(id, values, props) { index = 0; states = values; return html(components.get(id)(props)) }
function pill(model) {
  return render('antigravity-quota', { 0: quota }, {
    store: { subscribe() {}, getSnapshot: () => ({ current: { provider: 'antigravity-acp', model } }) },
    api: { subscribeCurrentQuota: () => () => {}, subscribeAccountChanged: () => () => {} },
  })
}
const models = [
  { id: 'gemini-4-neon', name: 'Gemini 4 Neon', inputModalities: ['text', 'image'] },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', inputModalities: ['text'] },
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon', inputModalities: ['text', 'image'] },
]
const settings = render('antigravity-acp', {
  0: 'account',
  1: models,
  2: false,
  3: 1,
  4: true,
  5: [],
  6: [],
  7: false,
  8: null,
  9: {
    accounts: [
      { id: 'primary', alias: '主账号（系统登录）', system: true, active: true, ready: true, createdAt: 0 },
      { id: 'acc_demo', alias: '备用账号', email: 'backup@example.com', system: false, active: false, ready: true, createdAt: 1 },
    ],
    activeAccountId: 'primary',
    auth: { phase: 'idle' },
    cliInstalled: true,
  },
}, { remote: {}, api: {} })

export { quota, models, settings, pill, render, escape }
