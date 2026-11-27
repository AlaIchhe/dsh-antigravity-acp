import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ReasoningEffortId,
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestMessage, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { AnyMessage, SessionConfigOption, Stream } from '@agentclientprotocol/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { AgentLink } from '../src/protocol/agent-link.js'
import { AntigravityAcpAdapter, AGY_ADAPTER_ERROR } from '../src/session/adapter.js'
import { CatalogStore } from '../src/session/catalog-store.js'
import { AGY_ROUTING_ERROR, applySessionSelection } from '../src/session/model-router.js'
import { evaluateRecordContinuity } from '../src/session/session-coordinator.js'
import { ContinuationState, ROUTE_FINGERPRINT_VERSION, outputHash, prefixHash, routeFingerprint } from '../src/session/session-reuse.js'
import { createFileSessionStore, readSessionMap, writeSessionMap } from '../src/session/session-store.js'
import { describeUpstreamErrorNotice } from '../src/session/turn-runner.js'
import { TurnUsageAccounting } from '../src/session/usage-accounting.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 创建进程内双向 ACP Stream（测试用，不起子进程）。 */
function createLinkedAcpPair(
  onAgentMessage: (msg: AnyMessage, sendToClient: (msg: AnyMessage) => void) => void | Promise<void>,
): Stream {
  let clientCtrl!: ReadableStreamDefaultController<AnyMessage>
  const readable = new ReadableStream<AnyMessage>({
    start(controller) { clientCtrl = controller },
  })
  const sendToClient = (msg: AnyMessage) => { clientCtrl.enqueue(msg) }
  const writable = new WritableStream<AnyMessage>({
    async write(msg) { await onAgentMessage(msg, sendToClient) },
    close() { try { clientCtrl.close() } catch { /* already closed */ } },
  })
  return { readable, writable }
}

const DEFAULT_CONFIG_OPTIONS: SessionConfigOption[] = [
  {
    type: 'select',
    id: 'model',
    name: 'Model',
    category: 'model',
    currentValue: 'gemini-4-neon',
    options: [
      { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
      { value: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
    ],
  },
  {
    type: 'select',
    id: 'thought_level',
    name: 'Thought Level',
    category: 'thought_level',
    currentValue: 'medium',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
]

describe('v1.0 session core & bug regressions', () => {
  it('BUG FIX #1: session-store preserves routeVersion across disk read/write', async () => {
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
      routeVersion: ROUTE_FINGERPRINT_VERSION,
      updatedAt: Date.now(),
    }
    expect(await writeSessionMap(dir, { 'dsh-1::chat': entry })).toBe(true)
    const reloaded = await readSessionMap(dir)
    expect(reloaded['dsh-1::chat']?.routeVersion).toBe(ROUTE_FINGERPRINT_VERSION)
  })

  it('BUG FIX #2: ContinuationState ignores dynamic tool changes mid-turn (e.g. bcdp lazy unlock)', () => {
    const toolA: ToolSchema = { name: 'read', description: 'read', parameters: { type: 'object', properties: {} } }
    const toolB: ToolSchema = { name: 'bcdp_click', description: 'click', parameters: { type: 'object', properties: {} } }
    const u1 = createUserMessage({ content: [{ type: 'text', text: 'open page' }], source: { kind: 'user' } })
    const baseOpts: GenerateOptions = {
      provider: 'antigravity-acp',
      model: 'gemini-4-neon',
      messages: [u1],
      tools: [toolA],
    }
    const cont = new ContinuationState(baseOpts)
    const callBlock = { type: 'tool-call' as const, id: ToolCallId('dsh-tools-1'), name: 'read', arguments: '{}' }
    cont.emitted(callBlock)

    const nextOpts: GenerateOptions = {
      ...baseOpts,
      tools: [toolA, toolB], // 动态新增了工具！
      messages: [
        u1,
        createAssistantMessage({ content: [callBlock], source: { provider: 'antigravity-acp', model: 'gemini-4-neon' } }),
        createToolResultMessage({ callId: ToolCallId('dsh-tools-1'), content: [{ type: 'text', text: 'ok' }], isError: false }),
      ],
    }
    expect(cont.accepts(nextOpts, 1)).toBe(true)
  })

  it('BUG FIX #3: evaluateRecordContinuity distinguishes reuse / reset-fresh / unrecoverable cleanly', () => {
    const u1 = createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } })
    const a1 = createAssistantMessage({ content: [{ type: 'text', text: 'reply' }], source: { provider: 'antigravity-acp', model: 'gemini-4-neon' } })
    const u2 = createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } })
    const route = routeFingerprint({ provider: 'antigravity-acp', model: 'gemini-4-neon' })

    const baseRecord = {
      sessionId: 'acp-1',
      cwd: '/work',
      sentCount: 1,
      sentHash: prefixHash([u1]),
      outputHash: outputHash(a1.content),
      route,
      routeVersion: ROUTE_FINGERPRINT_VERSION,
    }

    // 正常追加
    expect(evaluateRecordContinuity(baseRecord, { provider: 'antigravity-acp', model: 'gemini-4-neon', messages: [u1, a1, u2] }, '/work')).toEqual({ ok: true })
    // 切换模型 → unrecoverable
    expect(evaluateRecordContinuity(baseRecord, { provider: 'antigravity-acp', model: 'claude-sonnet-5-5', messages: [u1, a1, u2] }, '/work')).toMatchObject({ ok: false, kind: 'unrecoverable' })
    // 历史压缩前缀变化 → 显式 reset-fresh
    const compacted = createUserMessage({ content: [{ type: 'text', text: 'summary' }], source: { kind: 'user' } })
    expect(evaluateRecordContinuity(baseRecord, { provider: 'antigravity-acp', model: 'gemini-4-neon', messages: [compacted, u2] }, '/work')).toMatchObject({ ok: false, kind: 'reset-fresh' })
  })

  it('CatalogStore filters hiddenModels and persists v3 catalog with thoughtLevel', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-cat-'))
    dirs.push(dir)
    let hidden: string[] = ['claude-sonnet-5-5']
    const store = new CatalogStore({
      cacheDir: dir,
      acpVersion: '1.5.0',
      readHiddenModels: () => hidden,
      canReadImages: () => true,
    })
    store.setImageSupported(true)
    store.observeConfigOptions(DEFAULT_CONFIG_OPTIONS)
    store.noteContextWindow('gemini-4-neon', 200_000)

    const visible = await store.listVisibleModels()
    expect(visible.map((m) => m.id)).toEqual(['gemini-4-neon'])
    const all = await store.listAllModels()
    expect(all.map((m) => m.id)).toEqual(['gemini-4-neon', 'claude-sonnet-5-5'])

    const resolved = await store.resolveModel('antigravity-acp', 'gemini-4-neon')
    expect(resolved.context?.contextWindow).toBe(200_000)
    expect(resolved.inputModalities).toEqual(['text', 'image'])
    expect(resolved.reasoning?.efforts.map((e) => e.id.toString())).toEqual(['low', 'medium', 'high'])
  })

  it('applySessionSelection rejects undeclared effort with AGY_EFFORT_UNSUPPORTED', async () => {
    const link = {
      setConfigOption: vi.fn(async () => ({ configOptions: DEFAULT_CONFIG_OPTIONS })),
    } as unknown as AgentLink

    await expect(applySessionSelection({
      link,
      sessionId: 's1',
      configOptions: DEFAULT_CONFIG_OPTIONS,
      model: 'gemini-4-neon',
      effort: ReasoningEffortId('xhigh'),
    })).rejects.toMatchObject({ code: AGY_ROUTING_ERROR.EFFORT_UNSUPPORTED })
  })

  it('TurnUsageAccounting reconciles multi-step tool turns and describeUpstreamErrorNotice catches 429 notices', () => {
    const acc = new TurnUsageAccounting()
    acc.noteObservedUsed(10_000)
    const step1 = acc.emitIntermediateStep()
    expect(step1?.inputTokens).toBe(10_000)
    expect(step1?.outputTokens).toBe(0)

    acc.noteObservedUsed(12_000)
    const final = acc.reconcileFinalStep({
      inputTokens: 15_000,
      cachedReadTokens: 7_000,
      cachedWriteTokens: 0,
      outputTokens: 400,
      thoughtTokens: 120,
      totalTokens: 22_400,
    })
    expect(final?.outputTokens).toBe(400)
    expect(final?.reasoningTokens).toBe(120)
    expect(final?.totalTokens).toBe((final?.inputTokens ?? 0) + (final?.cacheReadTokens ?? 0) + (final?.cacheWriteTokens ?? 0) + 400)

    expect(describeUpstreamErrorNotice('⚠ RESOURCE_EXHAUSTED (code 429): quota', false)).toContain('HTTP 429')
    expect(describeUpstreamErrorNotice('⚠ RESOURCE_EXHAUSTED (code 429): quota', true)).toBeUndefined()
  })

  it('Plan A adapter multiplexes two concurrent conversations over ONE shared AgentLink', async () => {
    let sessionSeq = 0
    const createdSessions: string[] = []
    const stream = createLinkedAcpPair(async (msg, send) => {
      if (!('method' in msg) || !('id' in msg)) return
      if (msg.method === 'initialize') {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { promptCapabilities: { image: true }, sessionCapabilities: { resume: {} } },
            authMethods: [],
          },
        })
        return
      }
      if (msg.method === 'session/new') {
        const sid = `acp-s-${++sessionSeq}`
        createdSessions.push(sid)
        send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: sid, configOptions: DEFAULT_CONFIG_OPTIONS } })
        return
      }
      if (msg.method === 'session/prompt') {
        const params = msg.params as { sessionId: string; prompt: Array<{ type: string; text?: string }> }
        const text = params.prompt.map((b) => b.text ?? '').join('')
        const tag = text.includes('ALPHA') ? 'reply-ALPHA' : 'reply-BETA'
        // 交错延时，验证并发多路复用
        await new Promise((r) => setTimeout(r, tag === 'reply-ALPHA' ? 40 : 10))
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: tag } },
          },
        })
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } },
        })
      }
    })

    const dir = mkdtempSync(join(tmpdir(), 'agy-adapter-'))
    dirs.push(dir)
    const store = createFileSessionStore(dir)
    const catalog = new CatalogStore({ cacheDir: dir, acpVersion: '1.5.0' })

    let linkInst: AgentLink | undefined
    let linkReady: Promise<AgentLink> | undefined
    const getLinkCalls = vi.fn((handlers) => {
      linkReady ??= (async () => {
        const created = new AgentLink({ stream, handlers })
        created.start()
        await created.initialize({ clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
        linkInst = created
        return created
      })()
      return linkReady
    })

    const adapter = new AntigravityAcpAdapter({
      catalog,
      getLink: getLinkCalls,
      recycleLink: async (l) => { await l.close() },
      sessionStore: store,
      cwd: '/work',
      readSettings: () => ({ resumeSessions: true, idleRecycleMs: 0 }),
    })

    const collect = async (opts: GenerateOptions) => {
      let text = ''
      let finish = ''
      for await (const chunk of adapter.stream(opts)) {
        if (chunk.type === 'text-delta') text += chunk.text
        if (chunk.type === 'finish') finish = chunk.reason.kind
      }
      return { text, finish }
    }

    const [resA, resB] = await Promise.all([
      collect({
        provider: 'antigravity-acp',
        model: 'gemini-4-neon',
        sessionId: 'conv-alpha' as GenerateOptions['sessionId'],
        messages: [createUserMessage({ content: [{ type: 'text', text: 'ALPHA' }], source: { kind: 'user' } })],
      }),
      collect({
        provider: 'antigravity-acp',
        model: 'gemini-4-neon',
        sessionId: 'conv-beta' as GenerateOptions['sessionId'],
        messages: [createUserMessage({ content: [{ type: 'text', text: 'BETA' }], source: { kind: 'user' } })],
      }),
    ])

    expect(resA).toEqual({ text: 'reply-ALPHA', finish: 'stop' })
    expect(resB).toEqual({ text: 'reply-BETA', finish: 'stop' })
    expect(createdSessions).toHaveLength(2)

    // 校验缺失映射的历史聊天报 AGY_SESSION_UNRECOVERABLE
    await expect(collect({
      provider: 'antigravity-acp',
      model: 'gemini-4-neon',
      sessionId: 'conv-ghost' as GenerateOptions['sessionId'],
      messages: [
        createUserMessage({ content: [{ type: 'text', text: 'old' }], source: { kind: 'user' } }),
        createAssistantMessage({ content: [{ type: 'text', text: 'old-reply' }], source: { provider: 'antigravity-acp', model: 'gemini-4-neon' } }),
        createUserMessage({ content: [{ type: 'text', text: 'new' }], source: { kind: 'user' } }),
      ],
    })).rejects.toMatchObject({ code: AGY_ADAPTER_ERROR.SESSION_UNRECOVERABLE })

    await adapter.dispose()
    await linkInst?.close()
    await store.close()
  })

  it('Plan A 故障隔离 + 取消/干净失败后保留会话可续聊', async () => {
    let sessionSeq = 0
    const closedSessions: string[] = []
    let promptCount = 0
    const stream = createLinkedAcpPair(async (msg, send) => {
      if (!('method' in msg) || !('id' in msg)) return
      if (msg.method === 'initialize') {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { promptCapabilities: { image: true }, sessionCapabilities: { resume: {} } },
            authMethods: [],
          },
        })
        return
      }
      if (msg.method === 'session/new') {
        const sid = `acp-iso-${++sessionSeq}`
        send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: sid, configOptions: DEFAULT_CONFIG_OPTIONS } })
        return
      }
      if (msg.method === 'session/close') {
        closedSessions.push((msg.params as { sessionId: string }).sessionId)
        send({ jsonrpc: '2.0', id: msg.id, result: {} })
        return
      }
      if (msg.method === 'session/prompt') {
        promptCount += 1
        const params = msg.params as { sessionId: string; prompt: Array<{ type: string; text?: string }> }
        const text = params.prompt.map((b) => b.text ?? '').join('')
        if (text.includes('FAIL_TIMEOUT')) {
          // 故意不回复，让它命中 promptTimeoutMs
          return
        }
        if (text.includes('NOTICE_429')) {
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: params.sessionId,
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '⚠ RESOURCE_EXHAUSTED (code 429): busy' } },
            },
          })
          send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
          return
        }
        // 25ms 发首块触发活跃续期，再等 35ms（总计 60ms > 45ms promptTimeoutMs）发尾块
        await new Promise((r) => setTimeout(r, 25))
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'healthy-' } },
          },
        })
        await new Promise((r) => setTimeout(r, 35))
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
          },
        })
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      }
    })

    const dir = mkdtempSync(join(tmpdir(), 'agy-iso-'))
    dirs.push(dir)
    const store = createFileSessionStore(dir)
    const catalog = new CatalogStore({ cacheDir: dir, acpVersion: '1.5.0' })

    let linkInst: AgentLink | undefined
    let linkReady: Promise<AgentLink> | undefined
    const recycleSpy = vi.fn(async (l: AgentLink) => { await l.close() })
    const adapter = new AntigravityAcpAdapter({
      catalog,
      getLink: (handlers) => {
        linkReady ??= (async () => {
          const created = new AgentLink({ stream, handlers })
          created.start()
          await created.initialize({ clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
          linkInst = created
          return created
        })()
        return linkReady
      },
      recycleLink: recycleSpy,
      sessionStore: store,
      cwd: '/work',
      readSettings: () => ({ resumeSessions: true, idleRecycleMs: 0, promptTimeoutMs: 45 }),
    })

    const collect = async (opts: GenerateOptions) => {
      let text = ''
      let finish = ''
      let code: string | undefined
      for await (const chunk of adapter.stream(opts)) {
        if (chunk.type === 'text-delta') text += chunk.text
        if (chunk.type === 'finish') {
          finish = chunk.reason.kind
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') code = chunk.reason.failure?.code
        }
      }
      return { text, finish, code }
    }

    // 1. 并发：FAIL_TIMEOUT 超时时，不能误杀同时运行的 HEALTHY 会话
    const [badRes, okRes] = await Promise.all([
      collect({
        provider: 'antigravity-acp',
        model: 'gemini-4-neon',
        sessionId: 'conv-bad' as GenerateOptions['sessionId'],
        messages: [createUserMessage({ content: [{ type: 'text', text: 'FAIL_TIMEOUT' }], source: { kind: 'user' } })],
      }),
      collect({
        provider: 'antigravity-acp',
        model: 'gemini-4-neon',
        sessionId: 'conv-ok' as GenerateOptions['sessionId'],
        messages: [createUserMessage({ content: [{ type: 'text', text: 'HEALTHY' }], source: { kind: 'user' } })],
      }),
    ])
    expect(badRes.finish).toBe('error')
    expect(okRes).toEqual({ text: 'healthy-ok', finish: 'stop', code: undefined })
    expect(recycleSpy).not.toHaveBeenCalled()
    expect(closedSessions).toHaveLength(1)

    // 2. 干净失败（429 通告）后保留会话并写盘 cancelled: true，下一轮直接复用不报 SESSION_UNRECOVERABLE
    const m1 = createUserMessage({ content: [{ type: 'text', text: 'NOTICE_429' }], source: { kind: 'user' } })
    const r1 = await collect({
      provider: 'antigravity-acp',
      model: 'gemini-4-neon',
      sessionId: 'conv-retry' as GenerateOptions['sessionId'],
      messages: [m1],
    })
    expect(r1.finish).toBe('error')
    expect(r1.code).toBe('AGY_UPSTREAM_ERROR_NOTICE')
    await store.flush()
    const saved = await store.get('conv-retry::chat')
    expect(saved?.cancelled).toBe(true)

    const m2 = createUserMessage({ content: [{ type: 'text', text: 'RETRY_NOW' }], source: { kind: 'user' } })
    const sessionsBeforeRetry = sessionSeq
    const r2 = await collect({
      provider: 'antigravity-acp',
      model: 'gemini-4-neon',
      sessionId: 'conv-retry' as GenerateOptions['sessionId'],
      messages: [m1, m2],
    })
    expect(r2).toEqual({ text: 'healthy-ok', finish: 'stop', code: undefined })
    expect(sessionSeq).toBe(sessionsBeforeRetry) // 复用了原会话，没有新建

    await adapter.dispose()
    await linkInst?.close()
    await store.close()
  })
})

describe('tool continuation ledger rotation (rc.1 regression)', () => {
  it('同一 ACP 会话连续两段工具调用不再报废（AGY_SESSION_UNRECOVERABLE）', async () => {
    // 真机复现：2026-11-27 09:50 的会话，第 1 步 glob、第 2 步 grep 都成功回喂，
    // 第 3 步却报「没有可发送的增量消息」。根因是续轮被接受后账本没轮换：
    // 旧的 #history 停在首个请求上、#emitted 跨步累加，第二段续轮 accepts() 恒假
    // → abort 整个回合 → 会话被标 cancelled → 下一轮判定 unrecoverable。
    const TOOL: ToolSchema = {
      name: 'glob',
      description: 'list files',
      parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
    }
    const clients: Client[] = []
    const parkOrder: string[] = []
    let sessionSeq = 0
    let prompts = 0

    const stream = createLinkedAcpPair(async (msg, send) => {
      if (!('method' in msg) || !('id' in msg)) return
      if (msg.method === 'initialize') {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { promptCapabilities: { image: false }, sessionCapabilities: { resume: {} } },
            authMethods: [],
          },
        })
        return
      }
      if (msg.method === 'session/new') {
        const sid = `acp-tools-${++sessionSeq}`
        // MCP 桥注册信息只在 session/new 下发一次（ACP 语义），续轮不会重发。
        const server = (msg.params as { mcpServers?: Array<{ url: string; headers: Array<{ name: string; value: string }> }> })
          .mcpServers?.[0]
        if (server) mcpServer = server
        send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: sid, configOptions: DEFAULT_CONFIG_OPTIONS } })
        return
      }
      if (msg.method === 'session/prompt') {
        prompts += 1
        const params = msg.params as {
          sessionId: string
          prompt: Array<{ type: string; text?: string }>
        }
        if (!cached && mcpServer) {
          const token = mcpServer.headers.find((h) => h.name.toLowerCase() === 'authorization')?.value ?? ''
          const transport = new StreamableHTTPClientTransport(new URL(mcpServer.url), {
            requestInit: { headers: { authorization: token } },
          })
          const client = new Client({ name: 'fake-agent', version: '1.0.0' })
          await client.connect(transport)
          clients.push(client)
          cached = client
        }
        const client = cached
        if (!client) throw new Error('未拿到 MCP 桥注册信息')
        // 第一段：发 glob 工具调用，等 DSH 回喂结果
        parkOrder.push('call-1')
        await client.callTool({ name: 'glob', arguments: { pattern: '**/*' } })
        // 第二段：同一 prompt 内再发一次工具调用（这一步在修复前会整轮报废）
        parkOrder.push('call-2')
        await client.callTool({ name: 'glob', arguments: { pattern: 'src/**' } })
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'all-done' } },
          },
        })
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      }
    })
    let cached: Client | undefined
    let mcpServer: { url: string; headers: Array<{ name: string; value: string }> } | undefined

    const dir = mkdtempSync(join(tmpdir(), 'agy-tools-'))
    dirs.push(dir)
    const store = createFileSessionStore(dir)
    const catalog = new CatalogStore({ cacheDir: dir, acpVersion: '1.5.0' })
    let linkInst: AgentLink | undefined
    let linkReady: Promise<AgentLink> | undefined
    const adapter = new AntigravityAcpAdapter({
      catalog,
      getLink: (handlers) => {
        linkReady ??= (async () => {
          const created = new AgentLink({ stream, handlers })
          created.start()
          await created.initialize({ clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
          linkInst = created
          return created
        })()
        return linkReady
      },
      recycleLink: async (l: AgentLink) => { await l.close() },
      sessionStore: store,
      cwd: '/work',
      readSettings: () => ({ resumeSessions: true, idleRecycleMs: 0, promptTimeoutMs: 5_000, bridgeParkSettleMs: 5, cancelGraceMs: 0 }),
    })

    const runStep = async (opts: GenerateOptions) => {
      const blocks: unknown[] = []
      let text = ''
      let finish = ''
      let code: string | undefined
      for await (const chunk of adapter.stream(opts)) {
        if (chunk.type === 'block-end') blocks.push(chunk.block)
        if (chunk.type === 'text-delta') text += chunk.text
        if (chunk.type === 'finish') {
          finish = chunk.reason.kind
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') code = chunk.reason.failure?.code
        }
      }
      return { blocks, text, finish, code }
    }

    const base = { provider: 'antigravity-acp', model: 'gemini-4-neon', tools: [TOOL] }
    const u1 = createUserMessage({ content: [{ type: 'text', text: '看看仓库' }], source: { kind: 'user' } })

    // 第 1 步：新会话，模型发第一个工具调用
    const step1 = await runStep({ ...base, sessionId: 'conv-tools' as GenerateOptions['sessionId'], messages: [u1] })
    expect(step1.finish).toBe('tool-calls')
    expect(step1.code).toBeUndefined()
    const call1 = step1.blocks.find((b) => (b as { type: string }).type === 'tool-call') as { id: string } | undefined
    expect(call1).toBeDefined()

    const a1 = createAssistantMessage({
      content: step1.blocks as never,
      source: { provider: 'antigravity-acp', model: 'gemini-4-neon' },
    })
    const t1 = createToolResultMessage({ callId: ToolCallId(call1!.id), content: [{ type: 'text', text: 'glob-ok-1' }], isError: false })

    // 第 2 步：回喂第一个结果 → 模型在同一 prompt 内发第二个工具调用（续轮，必须被接受）
    const step2 = await runStep({
      ...base,
      sessionId: 'conv-tools' as GenerateOptions['sessionId'],
      messages: [u1, a1, t1],
    })
    expect(step2.finish).toBe('tool-calls')
    expect(step2.code).toBeUndefined()
    const call2 = step2.blocks.find((b) => (b as { type: string }).type === 'tool-call') as { id: string } | undefined
    expect(call2).toBeDefined()

    const a2 = createAssistantMessage({
      content: step2.blocks as never,
      source: { provider: 'antigravity-acp', model: 'gemini-4-neon' },
    })
    const t2 = createToolResultMessage({ callId: ToolCallId(call2!.id), content: [{ type: 'text', text: 'glob-ok-2' }], isError: false })

    // 第 3 步：回喂第二个结果 → 模型收尾（修复前这里直接 AGY_SESSION_UNRECOVERABLE）
    const step3 = await runStep({
      ...base,
      sessionId: 'conv-tools' as GenerateOptions['sessionId'],
      messages: [u1, a1, t1, a2, t2],
    })
    expect(step3.code).toBeUndefined()
    expect(step3.finish).toBe('stop')
    expect(step3.text).toBe('all-done')
    expect(sessionSeq).toBe(1) // 全程同一个 ACP 会话，没有新建
    expect(prompts).toBe(1) // 全程同一个 prompt，两段工具调用都是续轮
    expect(parkOrder).toEqual(['call-1', 'call-2'])

    for (const client of clients) await client.close().catch(() => undefined)
    await adapter.dispose()
    await linkInst?.close()
    await store.close()
  })
})
