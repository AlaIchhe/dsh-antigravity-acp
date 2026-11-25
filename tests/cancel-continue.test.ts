/**
 * 用户中断（abort / cancel）后继续发送的回归测试（对齐 agy 中断语义）。
 *
 * 锁定 2026-11-25 复现的 4 个断点：
 * 1. 带工具会话在 Step 1 中断：保留 MCP 桥作用域与内存会话，下一轮直接复用原 ACP 会话；
 * 2. 工具续轮 Step 2（#runContinuation）中断：finally 不误删 cancelled 会话，下一轮直接续上；
 * 3. DSH 工具执行期间中断（未进续轮，#abandonTurn 路径）：忽略中断遗留的 tool 结果并续发新用户输入；
 * 4. 中断确认后写回磁盘恢复映射（cancelled: true）：即便后续换新 adapter / 链接回收，仍可 session/resume 接回。
 */
import { describe, expect, it } from 'vitest'
import type { AnyMessage, Stream } from '@agentclientprotocol/sdk'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { AgentLink } from '../src/protocol/agent-link.js'
import { AntigravityAcpAdapter } from '../src/adapter/antigravity-adapter.js'
import { SessionMapStore } from '../src/runtime/session-map.js'
import type { SessionMapEntry } from '../src/runtime/session-map.js'

const TOOLS: ToolSchema[] = [
  {
    name: 'ping',
    description: '回声工具',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  },
]

function user(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function assistant(content: ContentBlock[]) {
  return createAssistantMessage({ content, source: { provider: 'antigravity-acp', model: 'gemini-4-neon' } })
}

interface McpServerInfo {
  url: string
  headers?: Array<{ name: string; value: string }>
}

interface ScriptedAgent {
  stream: Stream
  closedSessions: string[]
  resumedSessions: string[]
  promptTexts: string[]
  /** 下一次 session/prompt 的行为脚本。 */
  enqueuePrompt(handler: (ctx: {
    id: string | number
    sessionId: string
    mcpServer?: McpServerInfo
    sendUpdate: (update: Record<string, unknown>) => Promise<void>
    reply: (result: Record<string, unknown>) => Promise<void>
    waitForCancel: () => Promise<void>
  }) => Promise<void>): void
}

function createScriptedAgent(): ScriptedAgent {
  const agentToClient = new TransformStream<AnyMessage, AnyMessage>()
  const clientToAgent = new TransformStream<AnyMessage, AnyMessage>()
  const reader = clientToAgent.readable.getReader()
  const writer = agentToClient.writable.getWriter()
  const closedSessions: string[] = []
  const resumedSessions: string[] = []
  const promptTexts: string[] = []
  const queue: Array<Parameters<ScriptedAgent['enqueuePrompt']>[0]> = []
  const cancelWaiters = new Map<string, Array<() => void>>()
  const mcpBySession = new Map<string, McpServerInfo>()
  let seq = 0

  const sendUpdate = async (sessionId: string, update: Record<string, unknown>) => {
    await writer.write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })
  }

  void (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const msg = value as AnyMessage & { method?: string; id?: string | number | null; params?: Record<string, unknown> }
      if (msg.method === 'initialize') {
        await writer.write({
          jsonrpc: '2.0',
          id: msg.id!,
          result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } },
        })
      } else if (msg.method === 'session/new') {
        const sessionId = `acp-session-${++seq}`
        const servers = (msg.params?.mcpServers as McpServerInfo[] | undefined) ?? []
        if (servers[0]) mcpBySession.set(sessionId, servers[0])
        const configOptions = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }] }]
        await writer.write({ jsonrpc: '2.0', id: msg.id!, result: { sessionId, configOptions } })
      } else if (msg.method === 'session/resume') {
        const sessionId = String(msg.params?.sessionId ?? '')
        resumedSessions.push(sessionId)
        const servers = (msg.params?.mcpServers as McpServerInfo[] | undefined) ?? []
        if (servers[0]) mcpBySession.set(sessionId, servers[0])
        const configOptions = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }] }]
        await writer.write({ jsonrpc: '2.0', id: msg.id!, result: { configOptions } })
      } else if (msg.method === 'session/close') {
        closedSessions.push(String(msg.params?.sessionId ?? ''))
        await writer.write({ jsonrpc: '2.0', id: msg.id!, result: {} })
      } else if (msg.method === 'session/cancel') {
        const sessionId = String(msg.params?.sessionId ?? '')
        const waiters = cancelWaiters.get(sessionId) ?? []
        cancelWaiters.delete(sessionId)
        for (const wake of waiters) wake()
      } else if (msg.method === 'session/prompt') {
        const sessionId = String(msg.params?.sessionId ?? '')
        const promptBlocks = (msg.params?.prompt as Array<{ type: string; text?: string }> | undefined) ?? []
        promptTexts.push(promptBlocks.map((b) => b.text ?? '').join('\n'))
        const handler = queue.shift()
        const reply = async (result: Record<string, unknown>) => {
          await writer.write({ jsonrpc: '2.0', id: msg.id!, result })
        }
        if (handler) {
          void handler({
            id: msg.id!,
            sessionId,
            mcpServer: mcpBySession.get(sessionId),
            sendUpdate: (update) => sendUpdate(sessionId, update),
            reply,
            waitForCancel: () => new Promise<void>((resolve) => {
              const list = cancelWaiters.get(sessionId) ?? []
              list.push(resolve)
              cancelWaiters.set(sessionId, list)
            }),
          })
        } else {
          await sendUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `ok:${sessionId}` } })
          await reply({ stopReason: 'end_turn' })
        }
      }
    }
  })()

  return {
    stream: { writable: clientToAgent.writable, readable: agentToClient.readable },
    closedSessions,
    resumedSessions,
    promptTexts,
    enqueuePrompt: (handler) => { queue.push(handler) },
  }
}

async function callMcpTool(server: McpServerInfo, name: string, args: Record<string, unknown>): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  for (const h of server.headers ?? []) headers[h.name] = h.value
  const initRes = await fetch(server.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } }),
  })
  const mcpSessionId = initRes.headers.get('mcp-session-id')
  const callHeaders = mcpSessionId ? { ...headers, 'mcp-session-id': mcpSessionId } : headers
  const res = await fetch(server.url, {
    method: 'POST',
    headers: callHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
  })
  return await res.text()
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<{ text: string; blocks: ContentBlock[]; finish?: StreamChunk & { type: 'finish' } }> {
  let text = ''
  const blocks: ContentBlock[] = []
  let finish: (StreamChunk & { type: 'finish' }) | undefined
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'block-end') blocks.push(chunk.block)
    if (chunk.type === 'finish') finish = chunk
  }
  return { text, blocks, finish }
}

function makeAdapter(agent: ScriptedAgent, sharedDisk?: { data: Record<string, SessionMapEntry> }) {
  const disk = sharedDisk ?? { data: {} }
  const store = new SessionMapStore({
    load: async () => ({ ...disk.data }),
    save: (rows) => { disk.data = { ...rows } },
  })
  let cachedLink: AgentLink | undefined
  let bridgeTeardown: (() => Promise<void>) | undefined
  const adapter = new AntigravityAcpAdapter({
    resumeSessions: true,
    sessionStore: store,
    cancelGraceMs: 5_000,
    parkSettleMs: 10,
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
  return { adapter, store, disk, teardown }
}

function opts(sessionId: string, messages: GenerateOptions['messages'], signal?: AbortSignal): GenerateOptions {
  return {
    provider: 'antigravity-acp',
    model: 'gemini-4-neon',
    sessionId: sessionId as GenerateOptions['sessionId'],
    messages,
    tools: TOOLS,
    ...(signal ? { signal } : {}),
  }
}

describe('用户中断后继续发送（对齐 agy 语义）', () => {
  it('带工具会话在 Step 1 中断后，保留桥作用域与会话，下一轮直接复用原 ACP 会话', async () => {
    const agent = createScriptedAgent()
    const { adapter, teardown } = makeAdapter(agent)
    try {
      // Turn 1 正常完成
      const u1 = user('hello')
      const r1 = await collect(adapter.stream(opts('session-cancel-1', [u1])))
      expect(r1.text).toBe('ok:acp-session-1')
      const a1 = assistant(r1.blocks)

      // Turn 2 中途用户中断
      const controller = new AbortController()
      agent.enqueuePrompt(async ({ sendUpdate, waitForCancel, reply }) => {
        await sendUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } })
        controller.abort(new Error('user aborted'))
        await waitForCancel()
        await reply({ stopReason: 'cancelled' })
      })
      const u2 = user('question 2')
      const r2 = await collect(adapter.stream(opts('session-cancel-1', [u1, a1, u2], controller.signal)))
      expect(r2.finish?.reason.kind).toBe('aborted')

      // Turn 3 继续发送：必须复用 acp-session-1，不关会话、不报 AGY_SESSION_UNRECOVERABLE
      const u3 = user('follow up after cancel')
      const r3 = await collect(adapter.stream(opts('session-cancel-1', [u1, a1, u2, u3])))
      expect(r3.text).toBe('ok:acp-session-1')
      expect(agent.closedSessions).toEqual([])
      expect(agent.resumedSessions).toEqual([])
    } finally {
      await teardown()
    }
  })

  it('工具续轮 Step 2 中断后，不误删会话，下一轮直接复用原 ACP 会话', async () => {
    const agent = createScriptedAgent()
    const { adapter, teardown } = makeAdapter(agent)
    try {
      const controller = new AbortController()
      agent.enqueuePrompt(async ({ mcpServer, waitForCancel, reply }) => {
        expect(mcpServer).toBeDefined()
        // 发起 MCP 工具调用，等待 DSH 回喂
        await callMcpTool(mcpServer!, 'ping', { value: 'v1' })
        // 收到工具结果后进入 Step 2 生成期间被用户中断
        controller.abort(new Error('user aborted during continuation'))
        await waitForCancel()
        await reply({ stopReason: 'cancelled' })
      })

      const u1 = user('run ping')
      const step1 = await collect(adapter.stream(opts('session-cancel-2', [u1])))
      expect(step1.finish?.reason.kind).toBe('tool-calls')
      const toolBlock = step1.blocks.find((b) => b.type === 'tool-call')
      expect(toolBlock).toBeDefined()
      if (!toolBlock || toolBlock.type !== 'tool-call') throw new Error('expected tool-call')

      const a1 = assistant(step1.blocks)
      const t1 = createToolResultMessage({ callId: toolBlock.id, content: [{ type: 'text', text: 'pong:v1' }], isError: false })
      const step2 = await collect(adapter.stream(opts('session-cancel-2', [u1, a1, t1], controller.signal)))
      expect(step2.finish?.reason.kind).toBe('aborted')

      // 下一轮用户继续发送：复用同一个 acp-session-1
      const u2 = user('我是tailscale子网的设备')
      const turn2 = await collect(adapter.stream(opts('session-cancel-2', [u1, a1, t1, u2])))
      expect(turn2.text).toBe('ok:acp-session-1')
      expect(agent.closedSessions).toEqual([])
    } finally {
      await teardown()
    }
  })

  it('工具执行期间中断（未进续轮）后，下一轮忽略中断遗留的 tool 结果并复用原 ACP 会话', async () => {
    const agent = createScriptedAgent()
    const { adapter, teardown } = makeAdapter(agent)
    try {
      agent.enqueuePrompt(async ({ mcpServer, waitForCancel, reply }) => {
        expect(mcpServer).toBeDefined()
        const mcpCall = callMcpTool(mcpServer!, 'ping', { value: 'v1' }).catch(() => undefined)
        await waitForCancel()
        await mcpCall
        await reply({ stopReason: 'cancelled' })
      })

      const u1 = user('run ping')
      const step1 = await collect(adapter.stream(opts('session-cancel-3', [u1])))
      expect(step1.finish?.reason.kind).toBe('tool-calls')
      const toolBlock = step1.blocks.find((b) => b.type === 'tool-call')
      if (!toolBlock || toolBlock.type !== 'tool-call') throw new Error('expected tool-call')

      // 用户在工具执行阶段中断，DSH 把被中断的 tool 结果写进历史，随后用户直接发新消息
      const a1 = assistant(step1.blocks)
      const t1 = createToolResultMessage({ callId: toolBlock.id, content: [{ type: 'text', text: 'aborted' }], isError: true })
      const u2 = user('换个方案吧')
      const turn2 = await collect(adapter.stream(opts('session-cancel-3', [u1, a1, t1, u2])))
      expect(turn2.text).toBe('ok:acp-session-1')
      expect(agent.closedSessions).toEqual([])
      expect(agent.promptTexts.at(-1)).toContain('换个方案吧')
      expect(agent.promptTexts.at(-1)).not.toContain('aborted')
    } finally {
      await teardown()
    }
  })

  it('取消确认后补写磁盘映射，换新 adapter 后仍能通过 session/resume 接回', async () => {
    const sharedDisk = { data: {} as Record<string, SessionMapEntry> }
    const agent1 = createScriptedAgent()
    const first = makeAdapter(agent1, sharedDisk)
    const u1 = user('turn 1')
    let a1: ReturnType<typeof assistant>
    const u2 = user('turn 2 cancelled')
    try {
      const r1 = await collect(first.adapter.stream(opts('session-cancel-4', [u1])))
      a1 = assistant(r1.blocks)

      const controller = new AbortController()
      agent1.enqueuePrompt(async ({ sendUpdate, waitForCancel, reply }) => {
        await sendUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'half' } })
        controller.abort(new Error('user aborted'))
        await waitForCancel()
        await reply({ stopReason: 'cancelled' })
      })
      const r2 = await collect(first.adapter.stream(opts('session-cancel-4', [u1, a1, u2], controller.signal)))
      expect(r2.finish?.reason.kind).toBe('aborted')
      // 等 agent 的 cancelled 应答落地并写回磁盘映射
      await new Promise((r) => setTimeout(r, 30))
      await first.store.flush()
      expect(sharedDisk.data['session-cancel-4::chat']?.sessionId).toBe('acp-session-1')
      expect(sharedDisk.data['session-cancel-4::chat']?.cancelled).toBe(true)
    } finally {
      await first.teardown()
    }

    // 换全新的 adapter（模拟进程重启或空闲回收），应通过 session/resume 接回 acp-session-1
    const agent2 = createScriptedAgent()
    const second = makeAdapter(agent2, sharedDisk)
    try {
      const u3 = user('turn 3 after restart')
      const r3 = await collect(second.adapter.stream(opts('session-cancel-4', [u1, a1, u2, u3])))
      expect(r3.text).toBe('ok:acp-session-1')
      expect(agent2.resumedSessions).toEqual(['acp-session-1'])
    } finally {
      await second.teardown()
    }
  })
})
