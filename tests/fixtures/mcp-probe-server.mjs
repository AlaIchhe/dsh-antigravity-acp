// 极简 MCP stdio server：initialize / tools/list / tools/call，用于验证 agent 的工具调用链路。
import fs from 'node:fs'
const LOG = '/tmp/acp-probe/mcp-calls.log'
const log = (s) => fs.appendFileSync(LOG, `${new Date().toISOString().slice(11, 23)} ${s}\n`)

let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    handle(msg)
  }
})
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

function handle(msg) {
  log(`recv method=${msg.method ?? 'response'} id=${msg.id ?? '-'}`)
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'probe-mcp', version: '0.0.1' } } })
    return
  }
  if (msg.method === 'notifications/initialized') return
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping', description: '返回 pong:<text>', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } })
    return
  }
  if (msg.method === 'tools/call') {
    const text = msg.params?.arguments?.text ?? '(none)'
    log(`tools/call ping text=${text}`)
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `pong:${text}` }], isError: false } })
    return
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} })
}
log('server started')
