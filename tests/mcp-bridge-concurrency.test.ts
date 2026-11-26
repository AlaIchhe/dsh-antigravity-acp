import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { AGY_BRIDGE_ERROR, McpToolBridge } from '../src/bridge/mcp-bridge.js'
import type { BridgeParkedCall } from '../src/bridge/mcp-bridge.js'

const READ_TOOL: ToolSchema = {
  name: 'read_note',
  description: 'Read a note by path',
  parameters: {
    type: 'object',
    properties: { file_path: { type: 'string' } },
    required: ['file_path'],
  },
}

const bridges: McpToolBridge[] = []
const clients: Client[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined)
  for (const bridge of bridges.splice(0)) await bridge.close().catch(() => undefined)
})

async function connectClient(url: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name: 'test-agent', version: '1.0.0' })
  await client.connect(transport)
  clients.push(client)
  return client
}

describe('Plan A concurrent multi-scope McpToolBridge', () => {
  it('supports two conversations running concurrent tool calls and deliveries without interference', async () => {
    const bridge = new McpToolBridge()
    bridges.push(bridge)
    await bridge.start()

    bridge.beginRound([READ_TOOL], 'conv-A::chat')
    bridge.beginRound([READ_TOOL], 'conv-B::chat')

    const parkedA: BridgeParkedCall[] = []
    const parkedB: BridgeParkedCall[] = []
    bridge.onParked('conv-A::chat', (call) => parkedA.push(call))
    bridge.onParked('conv-B::chat', (call) => parkedB.push(call))

    const clientA = await connectClient(bridge.url!, bridge.tokenFor('conv-A::chat'))
    const clientB = await connectClient(bridge.url!, bridge.tokenFor('conv-B::chat'))

    // 同时发起两个对话的工具调用
    const callA = clientA.callTool({ name: 'read_note', arguments: { file_path: 'a.txt' } })
    const callB = clientB.callTool({ name: 'read_note', arguments: { file_path: 'b.txt' } })

    await new Promise((r) => setTimeout(r, 30))
    expect(parkedA).toHaveLength(1)
    expect(parkedB).toHaveLength(1)
    expect(parkedA[0]!.arguments).toContain('a.txt')
    expect(parkedB[0]!.arguments).toContain('b.txt')

    // 取消 conv-A 不应影响 conv-B 的待回喂调用
    bridge.resetPending('A cancelled', 'conv-A::chat')
    const resA = await callA
    expect(resA.isError).toBe(true)
    expect(bridge.hasPending(parkedB[0]!.callId)).toBe(true)

    await bridge.deliverResults([{ callId: parkedB[0]!.callId, text: 'content-of-b', isError: false }])
    const resB = await callB
    expect(resB.isError).not.toBe(true)
    expect(JSON.stringify(resB.content)).toContain('content-of-b')
  })

  it('rejects calls missing required arguments immediately without parking', async () => {
    const bridge = new McpToolBridge()
    bridges.push(bridge)
    await bridge.start()
    bridge.beginRound([READ_TOOL], 'conv-C::chat')

    const parked: BridgeParkedCall[] = []
    bridge.onParked('conv-C::chat', (call) => parked.push(call))

    const client = await connectClient(bridge.url!, bridge.tokenFor('conv-C::chat'))
    const result = await client.callTool({ name: 'read_note', arguments: {} })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain(AGY_BRIDGE_ERROR.INVALID_ARGUMENTS)
    expect(parked).toHaveLength(0)
  })
})
