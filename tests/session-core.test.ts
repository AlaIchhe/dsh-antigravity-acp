/**
 * 会话核心纯逻辑与持久化回归测试（零 mock / 零假 ACP agent）。
 *
 * 所有涉及真实 ACP 进程、MCP 桥、工具续轮、取消宽限、多账号切换与并发的端到端测试
 * 均在 `tests/real-session-core.test.ts` 中使用本机真实 `agy acp` 与真实凭据运行。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ReasoningEffortId,
  ToolCallId,
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestMessage, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { AntigravityAcpAdapter, classifyTurnOutcome } from '../src/session/adapter.js'
import { CatalogStore, defaultContextWindowFor } from '../src/session/catalog-store.js'
import { findModelSelector, findThoughtLevelSelector, normalizeEffort } from '../src/session/model-router.js'
import { SessionCoordinator, evaluateRecordContinuity } from '../src/session/session-coordinator.js'
import {
  ContinuationState,
  ROUTE_FINGERPRINT_VERSION,
  outputHash,
  prefixHash,
  prefixMatches,
  rotateContinuation,
  routeBaseFingerprint,
  routeFingerprint,
} from '../src/session/session-reuse.js'
import { createFileSessionStore, readSessionMap, writeSessionMap } from '../src/session/session-store.js'
import { describeUpstreamErrorNotice } from '../src/session/turn-runner.js'
import { TurnUsageAccounting } from '../src/session/usage-accounting.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function configOptionsFor(
  modelId: string,
  effort: 'low' | 'medium' | 'high' | 'xhigh',
  efforts: Array<{ value: string; name: string }> = [
    { value: 'low', name: 'Low' },
    { value: 'medium', name: 'Medium' },
    { value: 'high', name: 'High' },
  ],
): SessionConfigOption[] {
  return [
    {
      type: 'select',
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: modelId,
      options: [
        { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
        { value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
        { value: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
        { value: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)' },
      ],
    },
    {
      type: 'select',
      id: 'thought_level',
      name: 'Thought Level',
      category: 'thought_level',
      currentValue: effort,
      options: efforts,
    },
  ]
}

describe('v1.0 session core pure invariants (zero mocks)', () => {
  it('session-store persists routeVersion, routeBase, and accountId strictly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-smap-'))
    dirs.push(dir)
    const msg = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
    const entry = {
      sessionId: 'acp-sess-1',
      cwd: '/work',
      sentCount: 1,
      sentHash: prefixHash([msg]),
      outputHash: outputHash([{ type: 'text', text: 'hi' }]),
      route: routeFingerprint({ provider: 'antigravity-acp', model: 'gemini-4-neon', system: 'sys' }),
      routeBase: routeBaseFingerprint({ provider: 'antigravity-acp', model: 'gemini-4-neon', system: 'sys' }),
      routeVersion: ROUTE_FINGERPRINT_VERSION,
      accountId: 'acc_work_1',
      updatedAt: Date.now(),
    }
    expect(await writeSessionMap(dir, { 'dsh-1::chat': entry })).toBe(true)
    const reloaded = await readSessionMap(dir)
    expect(reloaded['dsh-1::chat']?.routeVersion).toBe(ROUTE_FINGERPRINT_VERSION)
    expect(reloaded['dsh-1::chat']?.routeBase).toBe(entry.routeBase)
    expect(reloaded['dsh-1::chat']?.accountId).toBe('acc_work_1')

    // 非法 routeBase 或空白 accountId 必须被拒收（不静默接受脏数据）
    await writeSessionMap(dir, { 'dsh-bad-rb::chat': { ...entry, routeBase: 'not-a-hash' } })
    await writeSessionMap(dir, { 'dsh-bad-acc::chat': { ...entry, accountId: '   ' } })
    const checked = await readSessionMap(dir)
    expect(checked['dsh-bad-rb::chat']).toBeUndefined()
    expect(checked['dsh-bad-acc::chat']).toBeUndefined()
  })

  it('ContinuationState ignores dynamic tool additions mid-turn and rotateContinuation advances ledger', () => {
    const toolA: ToolSchema = { name: 'read', description: 'read', parameters: { type: 'object', properties: {} } }
    const toolB: ToolSchema = { name: 'bcdp_click', description: 'click', parameters: { type: 'object', properties: {} } }
    const u1 = createUserMessage({ content: [{ type: 'text', text: 'open page' }], source: { kind: 'user' } })
    const baseOpts: GenerateOptions = {
      provider: 'antigravity-acp',
      model: 'gemini-4-neon',
      messages: [u1],
      tools: [toolA],
    }
    const host = { continuation: new ContinuationState(baseOpts) }
    const call1 = { type: 'tool-call' as const, id: ToolCallId('dsh-tools-1'), name: 'read', arguments: '{}' }
    host.continuation.emitted(call1)

    const step2Opts: GenerateOptions = {
      ...baseOpts,
      tools: [toolA, toolB],
      messages: [
        u1,
        createAssistantMessage({ content: [call1], source: { provider: 'antigravity-acp', model: 'gemini-4-neon' } }),
        createToolResultMessage({ callId: ToolCallId('dsh-tools-1'), content: [{ type: 'text', text: 'ok' }], isError: false }),
      ],
    }
    expect(host.continuation.accepts(step2Opts, 1)).toBe(true)

    // 轮换账本后，第二段工具调用同样可通过 accepts()
    rotateContinuation(host, step2Opts)
    const call2 = { type: 'tool-call' as const, id: ToolCallId('dsh-tools-2'), name: 'bcdp_click', arguments: '{}' }
    host.continuation.emitted(call2)
    const step3Opts: GenerateOptions = {
      ...step2Opts,
      messages: [
        ...step2Opts.messages,
        createAssistantMessage({ content: [call2], source: { provider: 'antigravity-acp', model: 'gemini-4-neon' } }),
        createToolResultMessage({ callId: ToolCallId('dsh-tools-2'), content: [{ type: 'text', text: 'clicked' }], isError: false }),
      ],
    }
    expect(host.continuation.accepts(step3Opts, 1)).toBe(true)
  })

  it('tolerates host in-place system-role message refresh during tool continuation and across turns without cold replay', () => {
    const sysV1 = createSystemMessage('Enabled engines: exa, tavily, wechat.')
    const sysV2 = createSystemMessage('Enabled engines: exa, firecrawl, tavily.')
    const sysAppended = createSystemMessage('Updated system notice.')
    const u1 = createUserMessage({ content: [{ type: 'text', text: 'run test' }], source: { kind: 'user' } })
    const call1 = { type: 'tool-call' as const, id: ToolCallId('dsh-tools-sys-1'), name: 'wait_agent', arguments: '{}' }
    const a1 = createAssistantMessage({ content: [call1], source: { provider: 'antigravity-acp', model: 'gemini-4-neon' } })
    const tr1 = createToolResultMessage({ callId: ToolCallId('dsh-tools-sys-1'), content: [{ type: 'text', text: '{"timedOut":true}' }], isError: false })

    // 1. 工具续轮中途宿主原地替换 messages[0]（surfaceOp: replace）：必须继续接受，不得强杀会话
    const step1Opts: GenerateOptions = {
      provider: 'antigravity-acp',
      model: 'gemini-4-neon',
      messages: [sysV1, u1],
    }
    const cont = new ContinuationState(step1Opts)
    cont.emitted(call1)
    expect(cont.accepts({ ...step1Opts, messages: [sysV2, u1, a1, tr1] }, 1)).toBe(true)
    // 宿主在工具续轮尾部追加新的 system 消息同样不得打断续轮
    expect(cont.accepts({ ...step1Opts, messages: [sysV2, u1, a1, tr1, sysAppended] }, 1)).toBe(true)
    // 但若删掉 system 槽位或改写用户消息，仍必须拒绝
    expect(cont.accepts({ ...step1Opts, messages: [u1, a1, tr1] }, 1)).toBe(false)
    const tamperedU1 = createUserMessage({ content: [{ type: 'text', text: 'other' }], source: { kind: 'user' } })
    expect(cont.accepts({ ...step1Opts, messages: [sysV2, tamperedU1, a1, tr1] }, 1)).toBe(false)

    // 2. 跨回合复用：原地刷新 role='system' 不改变 prefixHash，不得误触发 reset-fresh 全量冷重放
    const reply1 = createAssistantMessage({ content: [{ type: 'text', text: 'done' }], source: { provider: 'antigravity-acp', model: 'gemini-4-neon' } })
    const u2 = createUserMessage({ content: [{ type: 'text', text: 'next' }], source: { kind: 'user' } })
    const sent = [sysV1, u1]
    const sentHash = prefixHash(sent)
    expect(prefixMatches([sysV2, u1, reply1, u2], sent.length, sentHash)).toBe(true)

    const base = { provider: 'antigravity-acp', model: 'gemini-4-neon' }
    const record = {
      sessionId: 'acp-sys-refresh',
      cwd: '/work',
      sentCount: sent.length,
      sentHash,
      outputHash: outputHash(reply1.content),
      route: routeFingerprint(base),
      routeBase: routeBaseFingerprint(base),
      routeVersion: ROUTE_FINGERPRINT_VERSION,
      accountId: 'primary',
    }
    expect(evaluateRecordContinuity(record, { ...base, messages: [sysV2, u1, reply1, u2] }, '/work', 'primary'))
      .toEqual({ ok: true })
  })

  it('evaluateRecordContinuity handles effort change, account switch & compaction as reset-fresh, model/system change as unrecoverable', () => {
    const u1 = createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
    const a1 = createAssistantMessage({ content: [{ type: 'text', text: 'ok' }], source: { provider: 'antigravity-acp', model: 'gemini-4-neon' } })
    const u2 = createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } })
    const base = { provider: 'antigravity-acp', model: 'gemini-4-neon', system: 'SYS' }
    const effort = (id: string) => ReasoningEffortId(id)
    const record = {
      sessionId: 'acp-e',
      cwd: '/work',
      sentCount: 2,
      sentHash: prefixHash([u1]),
      outputHash: outputHash(a1.content),
      route: routeFingerprint({ ...base, reasoningEffort: effort('high') }),
      routeBase: routeBaseFingerprint(base),
      routeVersion: ROUTE_FINGERPRINT_VERSION,
      accountId: 'primary',
    }

    // 1. 仅思考档位变化 → reset-fresh
    expect(evaluateRecordContinuity(record, { ...base, reasoningEffort: effort('low'), messages: [u1, a1, u2] }, '/work', 'primary'))
      .toMatchObject({ ok: false, kind: 'reset-fresh' })
    // 2. 切换账号 → reset-fresh（不跨账号 resume）
    expect(evaluateRecordContinuity(record, { ...base, reasoningEffort: effort('high'), messages: [u1, a1, u2] }, '/work', 'acc_2'))
      .toMatchObject({ ok: false, kind: 'reset-fresh' })
    // 3. 换模型 → unrecoverable
    expect(evaluateRecordContinuity(record, { ...base, model: 'claude-sonnet-5-5', reasoningEffort: effort('high'), messages: [u1, a1, u2] }, '/work', 'primary'))
      .toMatchObject({ ok: false, kind: 'unrecoverable' })
    // 4. 换系统提示 → unrecoverable
    expect(evaluateRecordContinuity(record, { ...base, system: 'OTHER', reasoningEffort: effort('high'), messages: [u1, a1, u2] }, '/work', 'primary'))
      .toMatchObject({ ok: false, kind: 'unrecoverable' })
    // 5. 旧映射没有 routeBase 时保持保守语义
    const legacy = { ...record } as Record<string, unknown>
    delete legacy.routeBase
    expect(evaluateRecordContinuity(legacy as never, { ...base, reasoningEffort: effort('low'), messages: [u1, a1, u2] }, '/work', 'primary'))
      .toMatchObject({ ok: false, kind: 'unrecoverable' })

    // 6. 上下文压缩（/compact）使消息条数 ≤ sentCount 且含 compact-checkpoint → reset-fresh（不得误判死）
    const compactedRecord = { ...record, sentCount: 413 }
    const checkpoint = createUserMessage({
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'compact-checkpoint' } as never,
    }) as RequestMessage
    expect(evaluateRecordContinuity(compactedRecord, { ...base, reasoningEffort: effort('high'), messages: [checkpoint, u2] }, '/work', 'primary'))
      .toMatchObject({ ok: false, kind: 'reset-fresh' })
    // 无 compact-checkpoint 且条数未增长仍保持 unrecoverable
    expect(evaluateRecordContinuity(compactedRecord, { ...base, reasoningEffort: effort('high'), messages: [u1, u2] }, '/work', 'primary'))
      .toMatchObject({ ok: false, kind: 'unrecoverable' })
  })

  it('drops failed brand-new or consecutively failing ACP sessions without stranding retry as unrecoverable', async () => {
    // 1. classifyTurnOutcome 判定不变量
    expect(classifyTurnOutcome('error', true, { reused: false, consecutiveErrors: 0 })).toBe('failed')
    expect(classifyTurnOutcome('error', true, { reused: true, consecutiveErrors: 0 })).toBe('cancelled')
    expect(classifyTurnOutcome('error', true, { reused: true, consecutiveErrors: 1 })).toBe('failed')
    expect(classifyTurnOutcome('error', false, { reused: true, consecutiveErrors: 0 })).toBe('failed')
    expect(classifyTurnOutcome('aborted', true, { reused: false, consecutiveErrors: 0 })).toBe('cancelled')
    expect(classifyTurnOutcome('stop', true, { reused: false, consecutiveErrors: 0 })).toBe('delivered')

    // 2. 新建会话首轮即 429 失败：不得落盘保留毒丸会话，且下一次重试允许干净 reset-fresh
    const dir = mkdtempSync(join(tmpdir(), 'agy-coord-retry-'))
    dirs.push(dir)
    const store = createFileSessionStore(dir)
    const coord = new SessionCoordinator('/work', store)
    const u1 = createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
    const a1 = createAssistantMessage({ content: [{ type: 'text', text: 'ok' }], source: { provider: 'antigravity-acp', model: 'gemini-4-neon' } })
    const u2 = createUserMessage({ content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } })
    const opts: GenerateOptions = { provider: 'antigravity-acp', model: 'gemini-4-neon', messages: [u1, a1, u2] }
    const dummyLink = { closed: false } as never
    const live = coord.registerNew({
      key: 'sess-1::chat',
      sessionId: 'poison-acp-session',
      link: dummyLink,
      options: opts,
      systemViaMeta: false,
    })

    // 首轮失败 → 丢弃映射并标记允许干净重试
    coord.advance(live, opts, [], true, 'failed', { allowFreshRetry: true })
    await store.flush()
    expect(coord.getLive('sess-1::chat')).toBeUndefined()
    expect((await readSessionMap(dir))['sess-1::chat']).toBeUndefined()

    // 下一轮带历史发「继续」→ 走 reset-fresh（而非报「没有可用的会话映射」）
    const retryDecision = await coord.decide({
      key: 'sess-1::chat',
      options: opts,
      hasPriorHistory: true,
      resumeEnabled: true,
      hasValidBridgeScope: () => true,
    })
    expect(retryDecision).toMatchObject({ kind: 'reset-fresh' })

    // 一次性标记消耗后，若真的没有映射则仍保持保守的 unrecoverable
    const missingDecision = await coord.decide({
      key: 'sess-1::chat',
      options: opts,
      hasPriorHistory: true,
      resumeEnabled: true,
      hasValidBridgeScope: () => true,
    })
    expect(missingDecision).toMatchObject({ kind: 'unrecoverable' })
  })

  it('CatalogStore isolates thought_level per model, unions CLI family tiers, ignores non-authoritative currentValue, and omits tierless models', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'agy-cat-'))
    dirs.push(cacheDir)

    const store = new CatalogStore({
      cacheDir,
      acpVersion: '1.4.0',
      loadCliModels: async () => [
        { id: 'gemini-4-neon', name: 'Gemini 4 Neon', tiers: ['low', 'medium', 'high', 'xhigh'] },
        { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', tiers: ['low', 'medium', 'high', 'xhigh'] },
        { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', tiers: ['low', 'medium', 'high'] },
        { id: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)', tiers: [] },
      ],
    })
    await store.refreshCliModels(true)

    // 聊天会话在 Hydrogen 上选了 xhigh
    store.observeConfigOptions(
      configOptionsFor('gemini-4-hydrogen', 'xhigh', [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'xhigh', name: 'Extra High' },
      ]),
      { authoritative: true },
    )

    // Hydrogen 拿到 xhigh 且 defaultEffort=xhigh
    const hydrogen = await store.resolveModel('antigravity-acp', 'gemini-4-hydrogen')
    expect(hydrogen.reasoning?.efforts.map((e) => e.id.toString())).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(hydrogen.reasoning?.defaultEffort?.toString()).toBe('xhigh')

    // Claude Sonnet 5.5 绝不能被 Hydrogen 的 xhigh 污染！
    const claude = await store.resolveModel('antigravity-acp', 'claude-sonnet-5-5')
    expect(claude.reasoning?.efforts.map((e) => e.id.toString())).toEqual(['low', 'medium', 'high'])
    expect(claude.reasoning?.defaultEffort?.toString()).toBe('medium')

    // 无档位模型 Orchestrator 必须省略 reasoning
    const orchestrator = await store.resolveModel('antigravity-acp', 'gemini-pro-orchestrator')
    expect(orchestrator.reasoning).toBeUndefined()

    // 后台标题请求在 Hydrogen 上用了 low（authoritative: false）：绝不能覆盖 Hydrogen 的 xhigh
    store.observeConfigOptions(
      configOptionsFor('gemini-4-hydrogen', 'low', [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'xhigh', name: 'Extra High' },
      ]),
      { authoritative: false },
    )
    expect((await store.resolveModel('antigravity-acp', 'gemini-4-hydrogen')).reasoning?.defaultEffort?.toString()).toBe('xhigh')

    // 从磁盘重新加载缓存后，分模型 thought_level 同样恢复
    await new Promise((r) => setTimeout(r, 30))
    const reloaded = new CatalogStore({ cacheDir, acpVersion: '1.4.0' })
    expect((await reloaded.resolveModel('antigravity-acp', 'gemini-4-hydrogen')).reasoning?.defaultEffort?.toString()).toBe('xhigh')
  })

  it('CatalogStore returns conservative fallback contextWindow before observation without polluting cache, and prefers observed values', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'agy-ctx-'))
    dirs.push(cacheDir)

    expect(defaultContextWindowFor('gemini-4-neon')).toBe(1_048_576)
    expect(defaultContextWindowFor('claude-sonnet-5-5')).toBe(200_000)
    expect(defaultContextWindowFor('gpt-oss-120b-medium')).toBe(128_000)

    const store = new CatalogStore({ cacheDir, acpVersion: '1.4.0' })
    store.observeConfigOptions(configOptionsFor('gemini-4-neon', 'high'), { authoritative: true })

    // 未跑过真实回合前，resolveModel 仍提供家族保守兜底，避免已有会话切模型被 DSH 压缩检查阻断
    expect((await store.resolveModel('antigravity-acp', 'gemini-4-neon')).context?.contextWindow).toBe(1_048_576)
    expect((await store.resolveModel('antigravity-acp', 'claude-sonnet-5-5')).context?.contextWindow).toBe(200_000)
    expect((await store.resolveModel('antigravity-acp', 'gpt-oss-120b-medium')).context?.contextWindow).toBe(128_000)

    // 兜底值不得写入 catalog.json 伪装为实测值
    await new Promise((r) => setTimeout(r, 30))
    const savedBefore = JSON.parse(readFileSync(join(cacheDir, 'catalog.json'), 'utf8')) as {
      models: Array<{ id: string; contextWindow?: number }>
    }
    expect(savedBefore.models.find((m) => m.id === 'claude-sonnet-5-5')?.contextWindow).toBeUndefined()

    // 一旦收到上游实测 usage_update.size，立刻覆盖兜底并持久化
    store.noteContextWindow('claude-sonnet-5-5', 1_000_000)
    expect((await store.resolveModel('antigravity-acp', 'claude-sonnet-5-5')).context?.contextWindow).toBe(1_000_000)
    await new Promise((r) => setTimeout(r, 30))
    const reloaded = new CatalogStore({ cacheDir, acpVersion: '1.4.0' })
    expect((await reloaded.resolveModel('antigravity-acp', 'claude-sonnet-5-5')).context?.contextWindow).toBe(1_000_000)
  })

  it('usage accounting, upstream error notice detection, and model-router pure helpers work accurately', () => {
    const acc = new TurnUsageAccounting()
    acc.noteObservedUsed(12_000)
    const step1 = acc.emitIntermediateStep()
    expect(step1?.outputTokens).toBe(0)
    expect(step1?.totalTokens).toBe(12_000)
    acc.noteObservedUsed(13_000)
    const final = acc.reconcileFinalStep({
      inputTokens: 15_000,
      cachedReadTokens: 10_000,
      cachedWriteTokens: 0,
      outputTokens: 320,
      thoughtTokens: 120,
      totalTokens: 25_320,
    })
    expect(final?.outputTokens).toBe(320)
    expect(final?.reasoningTokens).toBe(120)
    expect(final!.inputTokens + (final!.cacheReadTokens ?? 0) + (final!.cacheWriteTokens ?? 0) + final!.outputTokens).toBe(final!.totalTokens)

    expect(describeUpstreamErrorNotice('⚠ RESOURCE_EXHAUSTED (code 429): quota', false)).toContain('HTTP 429')
    expect(describeUpstreamErrorNotice('⚠ RESOURCE_EXHAUSTED (code 429): quota', true)).toBeUndefined()

    const opts = configOptionsFor('gemini-4-neon', 'high')
    expect(findModelSelector(opts)?.currentValue).toBe('gemini-4-neon')
    expect(findThoughtLevelSelector(opts)?.currentValue).toBe('high')
    expect(normalizeEffort(ReasoningEffortId('HIGH'))).toBe('high')
  })

  it('releaseConversation preserves persisted mapping by default (live→cold) and only deletes on explicit deletePersisted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-release-'))
    dirs.push(dir)
    const msg = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
    const entry = {
      sessionId: 'acp-sess-live',
      cwd: '/work',
      sentCount: 1,
      sentHash: prefixHash([msg]),
      outputHash: outputHash([{ type: 'text', text: 'hi' }]),
      route: routeFingerprint({ provider: 'antigravity-acp', model: 'gemini-4-neon', system: 'sys' }),
      routeBase: routeBaseFingerprint({ provider: 'antigravity-acp', model: 'gemini-4-neon', system: 'sys' }),
      routeVersion: ROUTE_FINGERPRINT_VERSION,
      updatedAt: Date.now(),
    }
    expect(await writeSessionMap(dir, { 'dsh-keep::chat': entry })).toBe(true)

    const sessionStore = createFileSessionStore(dir)
    const catalog = new CatalogStore({ cacheDir: dir, acpVersion: '1.4.0' })
    const adapter = new AntigravityAcpAdapter({
      cwd: '/work',
      catalog,
      getLink: async () => { throw new Error('unused') },
      recycleLink: async () => {},
      sessionStore,
      readSettings: () => ({ resumeSessions: true }),
    })

    // 默认（对应 DSH session/disposed）：不得删除持久化映射
    adapter.releaseConversation('dsh-keep')
    await sessionStore.flush()
    expect((await readSessionMap(dir))['dsh-keep::chat']?.sessionId).toBe('acp-sess-live')

    // 显式要求彻底删除时才从磁盘移除
    adapter.releaseConversation('dsh-keep', { deletePersisted: true })
    await sessionStore.flush()
    expect((await readSessionMap(dir))['dsh-keep::chat']).toBeUndefined()

    await adapter.dispose()
    await sessionStore.close()
  })
})
