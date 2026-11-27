/**
 * 私有 loopback MCP 桥（v1.0 真正多会话并发版）。
 *
 * 相比旧版的核心改造（方案 A）：
 * - 每个对话作用域（`owner`）独立拥有 Bearer token、工具目录、HTTP 会话表、
 *   `pending` 挂起调用队列与 `onParked` 监听器；
 * - 彻底移除全局单一 `#activeOwner` 瓶颈：同一共享 ACP 进程上的多个并发对话
 *   可同时运行回合、同时 park 工具调用、独立回喂与独立取消，互不干扰。
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer as AcpMcpServer } from '@agentclientprotocol/sdk'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { inspectToolArguments, renderToolSignature, safeKeyNames } from '../session/tool-args.js'

export const AGY_BRIDGE_ERROR = {
  NOT_LISTENING: 'AGY_BRIDGE_NOT_LISTENING',
  UNAUTHORIZED: 'AGY_BRIDGE_UNAUTHORIZED',
  UNKNOWN_TOOL: 'AGY_BRIDGE_UNKNOWN_TOOL',
  CLOSED: 'AGY_BRIDGE_CLOSED',
  UNKNOWN_SESSION: 'AGY_BRIDGE_UNKNOWN_SESSION',
  ALREADY_ATTACHED: 'AGY_BRIDGE_ALREADY_ATTACHED',
  INVALID_ARGUMENTS: 'AGY_BRIDGE_INVALID_ARGUMENTS',
} as const

export const BRIDGE_MCP_SERVER_NAME = 'dsh-tools'
export const BRIDGE_AUTH_HEADER = 'authorization'
export const BRIDGE_SESSION_HEADER = 'mcp-session-id'

const DEFAULT_SCOPE_OWNER = '__default__'
const MAX_SCOPES = 128

export function matchesBridgeToken(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== 'string') return false
  const expected = Buffer.from(`Bearer ${token}`, 'utf8')
  const actual = Buffer.from(header, 'utf8')
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

export interface BridgeParkedCall {
  callId: string
  name: string
  arguments: string
}

export interface BridgeToolResult {
  callId: string
  text: string
  content?: CallToolResult['content']
  isError: boolean
}

interface PendingEntry {
  owner: string
  call: BridgeParkedCall
  settle: (result: CallToolResult) => void
}

interface BridgeChannel {
  server: McpServer
  transport: Transport
}

interface HttpChannel extends BridgeChannel {
  transport: StreamableHTTPServerTransport
}

interface BridgeScope {
  readonly owner: string
  token: string
  generation: number
  valid: boolean
  tools: readonly ToolSchema[]
  readonly sessions: Map<string, HttpChannel>
  readonly pending: Map<string, PendingEntry>
  readonly listeners: Set<(call: BridgeParkedCall) => void>
}

export interface McpToolBridgeOptions {
  port?: number
  token?: string
}

export class McpToolBridge {
  readonly #requestedPort: number
  readonly #scopes = new Map<string, BridgeScope>()
  readonly #callOwners = new Map<string, string>()
  #attached: BridgeChannel | undefined
  #http: Server | undefined
  #starting: Promise<void> | undefined
  #bound = false
  #closed = false
  #address: string | undefined
  #callSeq = 0
  #httpError: Error | undefined

  constructor(options: McpToolBridgeOptions = {}) {
    this.#requestedPort = options.port ?? 0
    this.#getOrCreateScope(DEFAULT_SCOPE_OWNER, options.token)
  }

  get url(): string | undefined { return this.#address }
  get listening(): boolean { return this.#bound }
  get lastHttpError(): Error | undefined { return this.#httpError }

  tokenFor(owner = DEFAULT_SCOPE_OWNER): string {
    return this.#getOrCreateScope(owner).token
  }

  /** 订阅指定对话作用域的 park 事件；返回退订函数。 */
  onParked(ownerOrListener: string | ((call: BridgeParkedCall) => void), maybeListener?: (call: BridgeParkedCall) => void): () => void {
    const owner = typeof ownerOrListener === 'string' ? ownerOrListener : DEFAULT_SCOPE_OWNER
    const listener = typeof ownerOrListener === 'function' ? ownerOrListener : maybeListener!
    const scope = this.#getOrCreateScope(owner)
    scope.listeners.add(listener)
    return () => { scope.listeners.delete(listener) }
  }

  publishTools(tools: readonly ToolSchema[], owner = DEFAULT_SCOPE_OWNER): void {
    const scope = this.#getOrCreateScope(owner)
    scope.tools = [...tools]
  }

  toolSchemas(owner = DEFAULT_SCOPE_OWNER): readonly ToolSchema[] {
    return this.#scopes.get(owner)?.tools ?? []
  }

  toolNames(owner = DEFAULT_SCOPE_OWNER): string[] {
    return this.toolSchemas(owner).map((tool) => tool.name)
  }

  hasScope(owner: string): boolean {
    return this.#scopes.get(owner)?.valid === true
  }

  /** 为新 ACP 会话准备隔离作用域：轮换该 owner 的 token 与代次，绝不影响其他并发对话。 */
  beginRound(tools: readonly ToolSchema[], owner = DEFAULT_SCOPE_OWNER): void {
    this.resetPending('已切换 ACP 回合', owner)
    const existing = this.#scopes.get(owner)
    if (existing) {
      existing.generation += 1
      existing.token = randomBytes(32).toString('hex')
      existing.valid = true
      existing.tools = [...tools]
      this.#closeScopeChannels(existing)
      this.#touchScope(existing)
    } else {
      const created = this.#getOrCreateScope(owner)
      created.tools = [...tools]
    }
  }

  /** 复用已有 ACP 会话：仅刷新该作用域的工具目录，保留 token 与既有 MCP 通道。 */
  activateRound(tools: readonly ToolSchema[], owner: string): boolean {
    const scope = this.#scopes.get(owner)
    if (!scope || !scope.valid) return false
    this.resetPending('已切换 ACP 回合', owner)
    scope.tools = [...tools]
    this.#touchScope(scope)
    return true
  }

  /** 作废指定作用域的凭证、挂起调用与 HTTP 通道（不触碰其他对话）。 */
  invalidateScope(owner: string, reason: string): void {
    const scope = this.#scopes.get(owner)
    if (!scope) return
    scope.generation += 1
    scope.token = randomBytes(32).toString('hex')
    scope.valid = false
    scope.tools = []
    this.resetPending(reason, owner)
    this.#closeScopeChannels(scope)
  }

  /** 彻底释放指定对话作用域及其全部 HTTP 通道。 */
  releaseScope(owner: string): void {
    if (owner === DEFAULT_SCOPE_OWNER) return
    const scope = this.#scopes.get(owner)
    if (!scope) return
    this.resetPending('对话作用域已释放', owner)
    scope.generation += 1
    scope.valid = false
    scope.tools = []
    scope.listeners.clear()
    this.#closeScopeChannels(scope)
    this.#scopes.delete(owner)
  }

  acpRegistration(owner = DEFAULT_SCOPE_OWNER): AcpMcpServer[] {
    if (!this.#address) {
      throw new Error(`${AGY_BRIDGE_ERROR.NOT_LISTENING}: MCP 桥尚未监听，无法生成 ACP 注册信息`)
    }
    const scope = this.#getOrCreateScope(owner)
    return [{
      type: 'http',
      name: BRIDGE_MCP_SERVER_NAME,
      url: this.#address,
      headers: [{ name: BRIDGE_AUTH_HEADER, value: `Bearer ${scope.token}` }],
    }]
  }

  pendingCallIds(owner?: string): string[] {
    if (owner !== undefined) return [...(this.#scopes.get(owner)?.pending.keys() ?? [])]
    return [...this.#callOwners.keys()]
  }

  hasPending(callId: string): boolean {
    return this.#callOwners.has(callId)
  }

  async deliverResults(results: readonly BridgeToolResult[]): Promise<void> {
    if (this.#closed) throw new Error(`${AGY_BRIDGE_ERROR.CLOSED}: MCP 桥已关闭，无法回喂工具结果`)
    for (const result of results) {
      const owner = this.#callOwners.get(result.callId)
      const scope = owner === undefined ? undefined : this.#scopes.get(owner)
      const entry = scope?.pending.get(result.callId)
      if (!entry || !scope) {
        throw new Error(`${AGY_BRIDGE_ERROR.UNKNOWN_TOOL}: 未登记的 park 调用 ${result.callId}`)
      }
      scope.pending.delete(result.callId)
      this.#callOwners.delete(result.callId)
      entry.settle({
        content: result.content ?? [{ type: 'text', text: result.text }],
        isError: result.isError,
      })
    }
  }

  resetPending(reason: string, owner?: string): void {
    const scopes = owner === undefined
      ? [...this.#scopes.values()]
      : (this.#scopes.has(owner) ? [this.#scopes.get(owner)!] : [])
    for (const scope of scopes) {
      for (const [callId, entry] of scope.pending) {
        this.#callOwners.delete(callId)
        entry.settle({ content: [{ type: 'text', text: reason }], isError: true })
      }
      scope.pending.clear()
    }
  }

  async attach(transport: Transport, owner = DEFAULT_SCOPE_OWNER): Promise<void> {
    if (this.#attached) {
      throw new Error(`${AGY_BRIDGE_ERROR.ALREADY_ATTACHED}: 桥已绑定一条 MCP transport，请先 close() 再重新 attach`)
    }
    const scope = this.#getOrCreateScope(owner)
    const server = this.#createServer(scope)
    const channel: BridgeChannel = { server, transport }
    this.#attached = channel
    transport.onclose = () => {
      if (this.#attached === channel) this.#attached = undefined
      void server.close().catch(() => undefined)
    }
    await server.connect(transport)
    this.#bound = true
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error(`${AGY_BRIDGE_ERROR.CLOSED}: MCP 桥已关闭`)
    if (this.#bound) return
    if (this.#starting) return this.#starting
    const run = (async () => {
      const http = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.#handleHttp(req, res).catch(() => {
          if (!res.headersSent) res.statusCode = 500
          if (!res.writableEnded) res.end()
        })
      })
      http.on('error', (error: Error) => { this.#httpError = error })
      try {
        await new Promise<void>((resolve, reject) => {
          http.once('error', reject)
          http.listen(this.#requestedPort, '127.0.0.1', () => {
            http.removeListener('error', reject)
            resolve()
          })
        })
      } catch (error) {
        await new Promise<void>((resolve) => http.close(() => resolve())).catch(() => undefined)
        throw error
      }
      if (this.#closed) {
        await new Promise<void>((resolve) => {
          http.close(() => resolve())
          http.closeIdleConnections?.()
          http.closeAllConnections?.()
        })
        throw new Error(`${AGY_BRIDGE_ERROR.CLOSED}: MCP 桥在启动期间已关闭`)
      }
      this.#http = http
      const address = http.address() as AddressInfo | null
      this.#address = `http://127.0.0.1:${address?.port ?? this.#requestedPort}/mcp`
      this.#bound = true
    })()
    this.#starting = run
    try {
      await run
    } finally {
      if (this.#starting === run) this.#starting = undefined
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#starting?.catch(() => undefined)
    this.resetPending(`${AGY_BRIDGE_ERROR.CLOSED}: MCP 桥已关闭，未执行的工具调用作废`)
    const http = this.#http
    this.#http = undefined
    if (http) {
      await new Promise<void>((resolve) => {
        http.close(() => resolve())
        http.closeIdleConnections?.()
        http.closeAllConnections?.()
      })
    }
    const channels: BridgeChannel[] = []
    for (const scope of this.#scopes.values()) {
      channels.push(...scope.sessions.values())
      scope.sessions.clear()
      scope.listeners.clear()
      scope.valid = false
      scope.tools = []
    }
    if (this.#attached) {
      channels.push(this.#attached)
      this.#attached = undefined
    }
    await Promise.all(channels.map((channel) => channel.transport.close().catch(() => undefined)))
    await Promise.all(channels.map((channel) => channel.server.close().catch(() => undefined)))
    this.#address = undefined
    this.#bound = false
  }

  /* ── 内部实现 ────────────────────────────────────────────────────── */

  #getOrCreateScope(owner: string, initialToken?: string): BridgeScope {
    const existing = this.#scopes.get(owner)
    if (existing) {
      this.#touchScope(existing)
      return existing
    }
    const created: BridgeScope = {
      owner,
      token: initialToken ?? randomBytes(32).toString('hex'),
      generation: 0,
      valid: true,
      tools: [],
      sessions: new Map(),
      pending: new Map(),
      listeners: new Set(),
    }
    this.#scopes.set(owner, created)
    this.#evictOverflowScopes()
    return created
  }

  #touchScope(scope: BridgeScope): void {
    this.#scopes.delete(scope.owner)
    this.#scopes.set(scope.owner, scope)
  }

  #evictOverflowScopes(): void {
    while (this.#scopes.size > MAX_SCOPES) {
      let victim: BridgeScope | undefined
      for (const candidate of this.#scopes.values()) {
        if (candidate.owner === DEFAULT_SCOPE_OWNER) continue
        if (candidate.pending.size > 0 || candidate.listeners.size > 0) continue
        victim = candidate
        break
      }
      if (!victim) break
      victim.generation += 1
      victim.valid = false
      victim.tools = []
      this.#closeScopeChannels(victim)
      this.#scopes.delete(victim.owner)
    }
  }

  #closeScopeChannels(scope: BridgeScope): void {
    const channels = [...scope.sessions.values()]
    scope.sessions.clear()
    for (const channel of channels) {
      void channel.transport.close().catch(() => undefined)
      void channel.server.close().catch(() => undefined)
    }
  }

  #resolveScopeByAuth(header: string | string[] | undefined): BridgeScope | undefined {
    let matched: BridgeScope | undefined
    for (const scope of this.#scopes.values()) {
      if (scope.valid && matchesBridgeToken(header, scope.token)) matched = scope
    }
    return matched
  }

  async #handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const scope = this.#resolveScopeByAuth(req.headers[BRIDGE_AUTH_HEADER])
    if (!scope) {
      res.statusCode = 401
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: AGY_BRIDGE_ERROR.UNAUTHORIZED }, id: null }))
      return
    }
    let channel: HttpChannel | undefined
    const sessionId = req.headers[BRIDGE_SESSION_HEADER]
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      channel = scope.sessions.get(sessionId)
      if (!channel) {
        res.statusCode = 404
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: `${AGY_BRIDGE_ERROR.UNKNOWN_SESSION}: 未知的 MCP 会话` },
          id: null,
        }))
        return
      }
    } else {
      channel = await this.#createHttpChannel(scope)
    }
    try {
      await channel.transport.handleRequest(req, res)
    } catch {
      if (!res.headersSent) {
        res.statusCode = 500
        res.end()
      }
    } finally {
      if (!channel.transport.sessionId) {
        await channel.transport.close().catch(() => undefined)
      }
    }
  }

  async #createHttpChannel(scope: BridgeScope): Promise<HttpChannel> {
    const server = this.#createServer(scope)
    let channel: HttpChannel | undefined
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        if (channel) scope.sessions.set(sessionId, channel)
      },
    })
    channel = { server, transport }
    transport.onclose = () => {
      const closedId = transport.sessionId
      if (closedId && scope.sessions.get(closedId) === channel) scope.sessions.delete(closedId)
      void server.close().catch(() => undefined)
    }
    await server.connect(transport)
    return channel
  }

  #createServer(scope: BridgeScope): McpServer {
    const generation = scope.generation
    const server = new McpServer({ name: BRIDGE_MCP_SERVER_NAME, version: '1.0.0' }, { capabilities: { tools: {} } })
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: scope.valid && generation === scope.generation ? this.#mcpTools(scope) : [],
    }))
    server.server.setRequestHandler(CallToolRequestSchema, (request) =>
      this.#parkCall(scope, request.params.name, request.params.arguments, generation),
    )
    return server
  }

  #mcpTools(scope: BridgeScope): Tool[] {
    return scope.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as Tool['inputSchema'],
    }))
  }

  #parkCall(
    scope: BridgeScope,
    name: string,
    args: Record<string, unknown> | undefined,
    generation: number,
  ): Promise<CallToolResult> {
    if (
      this.#closed
      || !scope.valid
      || generation !== scope.generation
      || !scope.tools.some((tool) => tool.name === name)
    ) {
      return Promise.resolve({
        content: [{ type: 'text', text: `${this.#closed ? AGY_BRIDGE_ERROR.CLOSED : AGY_BRIDGE_ERROR.UNKNOWN_TOOL}: ${name}` }],
        isError: true,
      })
    }
    const tool = scope.tools.find((item) => item.name === name)
    const { missing } = tool ? inspectToolArguments(tool, args ?? {}) : { missing: [] }
    if (tool && missing.length > 0) {
      return Promise.resolve({
        content: [{
          type: 'text',
          text: `${AGY_BRIDGE_ERROR.INVALID_ARGUMENTS}: ${name} 缺少必填参数 ${safeKeyNames(missing).join(', ')}。正确签名：${renderToolSignature(tool)}。请补齐后重新调用。`,
        }],
        isError: true,
      })
    }
    const callId = `${BRIDGE_MCP_SERVER_NAME}-${++this.#callSeq}`
    const call: BridgeParkedCall = { callId, name, arguments: JSON.stringify(args ?? {}) }
    return new Promise<CallToolResult>((resolve) => {
      scope.pending.set(callId, { owner: scope.owner, call, settle: resolve })
      this.#callOwners.set(callId, scope.owner)
      for (const listener of scope.listeners) listener(call)
    })
  }
}
