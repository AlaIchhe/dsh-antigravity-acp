/**
 * 多会话共享同一 Worker 的回归测试（方案 A：MCP 桥按对话作用域隔离 + 软/硬失效分离）。
 *
 * 复现并锁定 2026-11-25 故障：
 * 1. 对话 A（带工具）完成后，对话 B（带工具）复用同一 Worker；回到对话 A Turn 2 时，
 *    桥作用域互不干扰，直接复用原 ACP 会话，不再触发 session/close 或 AGY_SESSION_UNRECOVERABLE。
 * 2. 对话 A 的桥作用域若已失效（软失效），只清内存句柄并保留恢复映射，通过 session/resume
 *    带着新的 mcpServers 接回原 ACP 会话。
 * 3. 路由（模型/系统提示）变化属于硬失效，直接透传真实原因，不再落入 #resumeSession
 *    报误导性的「磁盘上没有该会话的映射」；**工具目录变化不算路由**（见第 4 条）。
 * 4. 宿主中途新增工具不再让已有 ACP 会话报废（2026-11-26 `session-a1c4ea7a` 事故）：
 *    agent 侧工具面在 `session/new` 握手时固定，新增工具对已有会话无实际影响。
 */
import { describe, expect, it } from 'vitest'
import type { AnyMessage, Stream } from '@agentclientprotocol/sdk'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmError, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { AgentLink } from '../src/protocol/agent-link.js'
import { AntigravityAcpAdapter, AGY_ADAPTER_ERROR } from '../src/adapter/antigravity-adapter.js'
import { SessionMapStore } from '../src/runtime/session-map.js'
import type { SessionMapEntry } from '../src/runtime/session-map.js'

const TOOLS: ToolSchema[] = [
  {
    name: 'read_file',
    description: '读取文件',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
]

function user(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function assistant(text: string) {
  return createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'antigravity-acp', model: 'gemini-4-neon' } })
}

interface RecordedAgent {
  stream: Stream
  methods: string[]
  closedSessions: string[]
  resumedSessions: string[]
}

function createFakeAgent(): RecordedAgent {
  const agentToClient = new TransformStream<AnyMessage, AnyMessage>()
  const clientToAgent = new TransformStream<AnyMessage, AnyMessage>()
  const reader = clientToAgent.readable.getReader()
  const writer = agentToClient.writable.getWriter()
  const methods: string[] = []
  const closedSessions: string[] = []
  const resumedSessions: string[] = []
  let seq = 0

  void (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const msg = value as AnyMessage & { method?: string; id?: string | number | null; params?: Record<string, unknown> }
      if (msg.method) methods.push(msg.method)
      if (msg.method === 'initialize') {
        await writer.write({
          jsonrpc: '2.0',
          id: msg.id!,
          result: {
            protocolVersion: 1,
            agentCapabilities: { sessionCapabilities: { resume: {} } },
          },
        })
      } else if (msg.method === 'session/new') {
        const sessionId = `acp-session-${++seq}`
        const configOptions = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }] }]
        await writer.write({ jsonrpc: '2.0', id: msg.id!, result: { sessionId, configOptions } })
      } else if (msg.method === 'session/resume') {
        const sessionId = String(msg.params?.sessionId ?? '')
        resumedSessions.push(sessionId)
        const configOptions = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }] }]
        await writer.write({ jsonrpc: '2.0', id: msg.id!, result: { configOptions } })
      } else if (msg.method === 'session/close') {
        closedSessions.push(String(msg.params?.sessionId ?? ''))
        await writer.write({ jsonrpc: '2.0', id: msg.id!, result: {} })
      } else if (msg.method === 'session/prompt') {
        const sessionId = String(msg.params?.sessionId ?? '')
        await writer.write({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `reply:${sessionId}` } },
          },
        })
        await writer.write({ jsonrpc: '2.0', id: msg.id!, result: { stopReason: 'end_turn' } })
      }
    }
  })()

  return {
    stream: { writable: clientToAgent.writable, readable: agentToClient.readable },
    methods,
    closedSessions,
    resumedSessions,
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<string> {
  let text = ''
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return text
}

function makeAdapter(agent: RecordedAgent, seed: Record<string, SessionMapEntry> = {}): { adapter: AntigravityAcpAdapter; store: SessionMapStore; teardown: () => Promise<void>; disk: () => Record<string, SessionMapEntry> } {
  let disk: Record<string, SessionMapEntry> = { ...seed }
  const store = new SessionMapStore({
    load: async () => disk,
    save: (rows) => { disk = rows },
  })
  let cachedLink: AgentLink | undefined
  let bridgeTeardown: (() => Promise<void>) | undefined
  const adapter = new AntigravityAcpAdapter({
    resumeSessions: true,
    sessionStore: store,
    recycleLink: async () => undefined,
    registerBridgeTeardown: (fn) => { bridgeTeardown = fn },
    getLink: async (handlers) => {
      if (!cachedLink) {
        cachedLink = new AgentLink({ stream: agent.stream, handlers })
        cachedLink.start()
        await cachedLink.initialize()
      }
      return cachedLink
    },
  })
  const teardown = async () => {
    await bridgeTeardown?.()
    await cachedLink?.close()
  }
  return { adapter, store, teardown, disk: () => disk }
}

describe('多会话共享 Worker 与软/硬失效分离', () => {
  it('同一 Worker 上交替运行对话 A（带工具）与对话 B（带工具），回到对话 A 直接复用原 ACP 会话', async () => {
    const agent = createFakeAgent()
    const { adapter, teardown } = makeAdapter(agent)
    try {
      const qA1 = user('A-1')
      const rA1 = await collect(adapter.stream({
        sessionId: 'session-a' as GenerateOptions['sessionId'],
        provider: 'antigravity-acp',
        model: 'gemini-4-neon',
        system: 'sys',
        tools: TOOLS,
        messages: [qA1],
      }))
      expect(rA1).toBe('reply:acp-session-1')

      // 对话 B 复用同一个 Worker 并带工具，不应破坏对话 A 的桥作用域。
      const rB1 = await collect(adapter.stream({
        sessionId: 'session-b' as GenerateOptions['sessionId'],
        provider: 'antigravity-acp',
        model: 'gemini-4-neon',
        system: 'sys',
        tools: TOOLS,
        messages: [user('B-1')],
      }))
      expect(rB1).toBe('reply:acp-session-2')

      // 回到对话 A Turn 2：必须直接复用 acp-session-1，不发 session/close、不新建会话。
      const rA2 = await collect(adapter.stream({
        sessionId: 'session-a' as GenerateOptions['sessionId'],
        provider: 'antigravity-acp',
        model: 'gemini-4-neon',
        system: 'sys',
        tools: TOOLS,
        messages: [qA1, assistant(rA1), user('A-2')],
      }))
      expect(rA2).toBe('reply:acp-session-1')
      expect(agent.closedSessions).toEqual([])
      expect(agent.resumedSessions).toEqual([])
      expect(agent.methods.filter((m) => m === 'session/new')).toHaveLength(2)
    } finally {
      await teardown()
    }
  })

  it('桥作用域失效属于软失效：保留恢复映射并通过 session/resume 接回原 ACP 会话', async () => {
    const agent = createFakeAgent()
    const { adapter, teardown } = makeAdapter(agent)
    try {
      const q1 = user('Q1')
      const r1 = await collect(adapter.stream({
        sessionId: 'session-soft' as GenerateOptions['sessionId'],
        provider: 'antigravity-acp',
        model: 'gemini-4-neon',
        system: 'sys',
        tools: TOOLS,
        messages: [q1],
      }))
      expect(r1).toBe('reply:acp-session-1')

      // 模拟对话 A 的桥作用域失效（例如被淘汰或异常作废）。
      adapter.bridge.invalidateRound('模拟作用域失效', 'session-soft::chat')
      expect(adapter.bridge.hasScope('session-soft::chat')).toBe(false)

      const r2 = await collect(adapter.stream({
        sessionId: 'session-soft' as GenerateOptions['sessionId'],
        provider: 'antigravity-acp',
        model: 'gemini-4-neon',
        system: 'sys',
        tools: TOOLS,
        messages: [q1, assistant(r1), user('Q2')],
      }))
      expect(r2).toBe('reply:acp-session-1')
      expect(agent.resumedSessions).toEqual(['acp-session-1'])
      expect(adapter.bridge.hasScope('session-soft::chat')).toBe(true)
    } finally {
      await teardown()
    }
  })

  it('路由变化属于硬失效：直接透传真实原因，不再报误导性的「磁盘上没有该会话的映射」', async () => {
    const agent = createFakeAgent()
    const { adapter, teardown } = makeAdapter(agent)
    try {
      const q1 = user('Q1')
      const r1 = await collect(adapter.stream({
        sessionId: 'session-hard' as GenerateOptions['sessionId'],
        provider: 'antigravity-acp',
        model: 'gemini-4-neon',
        system: 'sys-v1',
        tools: TOOLS,
        messages: [q1],
      }))
      expect(r1).toBe('reply:acp-session-1')

      let caught: unknown
      try {
        await collect(adapter.stream({
          sessionId: 'session-hard' as GenerateOptions['sessionId'],
          provider: 'antigravity-acp',
        model: 'gemini-4-neon',
          system: 'sys-v2',
          tools: TOOLS,
          messages: [q1, assistant(r1), user('Q2')],
        }))
      } catch (error) {
        caught = error
      }
      expect(caught).toBeDefined()
      expect((caught as LlmError).code).toBe(AGY_ADAPTER_ERROR.SESSION_UNRECOVERABLE)
      expect((caught as Error).message).toContain('模型或系统提示已变化')
      expect((caught as Error).message).not.toContain('磁盘上没有该会话的映射')
    } finally {
      await teardown()
    }
  })

  it('宿主中途新增工具不再让已有会话报废：复用原 ACP 会话而不是 AGY_SESSION_UNRECOVERABLE', async () => {
    const agent = createFakeAgent()
    const { adapter, teardown } = makeAdapter(agent)
    try {
      const q1 = user('Q1')
      const base = {
        sessionId: 'session-tools' as GenerateOptions['sessionId'],
        provider: 'antigravity-acp',
        model: 'gemini-4-neon',
        system: 'sys',
      }
      const r1 = await collect(adapter.stream({ ...base, tools: TOOLS, messages: [q1] }))
      expect(r1).toBe('reply:acp-session-1')

      // 模拟 dsh-browser-cdp 在别的会话里懒加载工具：本轮的 tools 多出一批。
      const withInjected: ToolSchema[] = [
        ...TOOLS,
        { name: 'bcdp_status', description: '探通道', parameters: { type: 'object', properties: {} } },
        { name: 'bcdp_navigate', description: '导航', parameters: { type: 'object', properties: {} } },
      ]
      const r2 = await collect(adapter.stream({
        ...base,
        tools: withInjected,
        messages: [q1, assistant(r1), user('Q2')],
      }))
      // 复用成功：还是同一个 ACP 会话，没有新建、也没有 resume。
      expect(r2).toBe('reply:acp-session-1')
      expect(agent.resumedSessions).toEqual([])
      expect(agent.closedSessions).toEqual([])
      expect(agent.methods.filter((method) => method === 'session/new')).toHaveLength(1)
    } finally {
      await teardown()
    }
  })

  it('旧版映射（没有 routeVersion）按陈旧处理：新开会话重放一次，而不是报「模型或系统提示已变化」', async () => {
    const agent = createFakeAgent()
    const legacyKey = 'session-legacy::chat'
    const seeded = makeAdapter(agent, {
      [legacyKey]: {
        sessionId: 'acp-legacy',
        cwd: process.cwd(),
        sentCount: 1,
        sentHash: 'legacy',
        outputHash: 'legacy',
        route: 'legacy-route-scheme',
        updatedAt: Date.now(),
      },
    })
    const { adapter, teardown } = seeded
    try {
      const q1 = user('Q1')
      const reply = await collect(adapter.stream({
        sessionId: 'session-legacy' as GenerateOptions['sessionId'],
        provider: 'antigravity-acp',
        model: 'gemini-4-neon',
        system: 'sys',
        tools: TOOLS,
        messages: [q1, assistant('上一轮回答'), user('Q2')],
      }))
      // 新开 ACP 会话并重放历史：没有走 session/resume，也没有抛 ACP 会话不可恢复。
      expect(reply).toBe('reply:acp-session-1')
      expect(agent.resumedSessions).toEqual([])
      expect(agent.methods).toContain('session/new')
      await seeded.store.flush()
      expect(seeded.disk()[legacyKey]?.sessionId).toBe('acp-session-1')
    } finally {
      await teardown()
    }
  })
})
