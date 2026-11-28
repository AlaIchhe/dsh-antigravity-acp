/**
 * 单个 ACP prompt 回合状态机：session/update → DSH StreamChunk、
 * MCP 工具 park 聚合、权限路由、用量对账与上游错误通告拦截。
 */
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { LlmFailure, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type {
  ConfigOptionUpdate,
  ContentBlock,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
  SessionUpdate,
  StopReason,
} from '@agentclientprotocol/sdk'
import type { AgentLink, RequestTimerControl } from '../protocol/agent-link.js'
import type { BridgeParkedCall, BridgeToolResult, McpToolBridge } from '../bridge/mcp-bridge.js'
import { BRIDGE_MCP_SERVER_NAME } from '../bridge/mcp-bridge.js'
import { describePermissionRequest, parsePermissionHandoff } from './permission.js'
import type { PermissionDiagnostic } from './permission.js'
import { inspectToolArguments, safeKeyNames } from './tool-args.js'
import { TurnUsageAccounting } from './usage-accounting.js'

export const AGY_TURN_ERROR = {
  PERMISSION_DENIED: 'AGY_PERMISSION_DENIED',
  NATIVE_ACTIVITY_REFUSED: 'AGY_NATIVE_ACTIVITY_REFUSED',
  ABORTED: 'AGY_ABORTED',
  REFUSED: 'AGY_AGENT_REFUSED',
  NO_PENDING_TOOL_CALL: 'AGY_NO_PENDING_TOOL_CALL',
  EMPTY_RESPONSE: 'AGY_EMPTY_RESPONSE',
  UPSTREAM_ERROR_NOTICE: 'AGY_UPSTREAM_ERROR_NOTICE',
} as const

export const AGY_TURN_UNEXPECTED = 'AGY_UNEXPECTED'

type FinishChunk = Extract<StreamChunk, { type: 'finish' }>

interface OpenBlock {
  index: number
  blockType: 'text' | 'reasoning'
  messageId: string | undefined
  parts: string[]
}

export type PromptContent = ContentBlock[]

export interface PromptTurnOptions {
  link: AgentLink
  bridge: McpToolBridge
  /** MCP 桥作用域键（并发多对话隔离）。 */
  bridgeOwner: string
  promptTimeoutMs: number
  parkSettleMs: number
  oneShot?: boolean
  onConfigOptions?(options: readonly SessionConfigOption[]): void
  onUsageUpdate?(size: number | undefined, used: number | undefined): void
  onTerminate(reason: string, info?: { clean?: boolean; aborted?: boolean }): void
  onPromptSettled?(turn: PromptTurn, response?: PromptResponse): void
  onNativeRefusal?(info: { kind: 'permission' | 'request'; detail: string; count: number }): void
  onPermissionDiagnostic?(diagnostic: PermissionDiagnostic): void
  onBridgePermission?(tool: string): void
  onArgumentIssues?(info: { tool: string; missing: string[]; unknown: string[]; unknownCount: number }): void
}

export class PromptTurn {
  readonly sessionId: string
  readonly bridgeOwner: string
  readonly #link: AgentLink
  readonly #bridge: McpToolBridge
  readonly #promptTimeoutMs: number
  readonly #parkSettleMs: number
  readonly #oneShot: boolean
  readonly #queue: StreamChunk[] = []
  #waiters: Array<() => void> = []
  readonly #parked: BridgeParkedCall[] = []
  #settledWaiters: Array<() => void> = []
  readonly #usage = new TurnUsageAccounting()
  #nextIndex = 0
  #open: OpenBlock | undefined
  #producerDone = false
  #roundEnded = false
  #promptSettled = false
  #promptStarted = false
  #failure: LlmFailure | undefined
  #aborted = false
  #truncated = false
  #parkTimer: ReturnType<typeof setTimeout> | undefined
  #promptTimer: RequestTimerControl | undefined
  #abortCleanup: (() => void) | undefined
  #terminated = false
  #hasOutput = false
  #nativeRefusals = 0
  readonly #textParts: string[] = []
  #toolCallSeen = false
  readonly #permissionIds = new Set<string>()
  #deferred: Array<{ kind: 'call'; call: BridgeParkedCall } | { kind: 'update'; update: SessionUpdate }> = []
  readonly #callbacks: Pick<
    PromptTurnOptions,
    'onConfigOptions' | 'onUsageUpdate' | 'onTerminate' | 'onPromptSettled' | 'onNativeRefusal' | 'onPermissionDiagnostic' | 'onBridgePermission' | 'onArgumentIssues'
  >

  constructor(sessionId: string, options: PromptTurnOptions) {
    this.sessionId = sessionId
    this.bridgeOwner = options.bridgeOwner
    this.#link = options.link
    this.#bridge = options.bridge
    this.#promptTimeoutMs = options.promptTimeoutMs
    this.#parkSettleMs = options.parkSettleMs
    this.#oneShot = options.oneShot === true
    this.#callbacks = options
  }

  get promptSettled(): boolean { return this.#promptSettled }
  get promptStarted(): boolean { return this.#promptStarted }
  get terminated(): boolean { return this.#terminated }
  get parkedCalls(): readonly BridgeParkedCall[] { return this.#parked }
  get awaitingToolResults(): boolean {
    return !this.#terminated && this.#roundEnded && this.#parked.some((call) => this.#bridge.hasPending(call.callId))
  }

  handleSessionUpdate(notification: SessionNotification): void {
    if (notification.sessionId !== this.sessionId || this.#terminated || this.#promptSettled) return
    this.#promptTimer?.touch()
    if (notification.update.sessionUpdate === 'usage_update') {
      const update = notification.update as { size?: number; used?: number }
      if (typeof update.used === 'number' && Number.isFinite(update.used) && update.used > 0) {
        this.#usage.noteObservedUsed(update.used)
      }
      this.#callbacks.onUsageUpdate?.(update.size, update.used)
      return
    }
    if (this.#roundEnded) {
      this.#deferred.push({ kind: 'update', update: notification.update })
      return
    }
    this.#applyUpdate(notification.update)
  }

  handleRequestPermission(request: RequestPermissionRequest): RequestPermissionResponse {
    if (request.sessionId !== this.sessionId || this.#terminated || this.#promptSettled) {
      this.#reportPermissionDiagnostic(request)
      return { outcome: { outcome: 'cancelled' } }
    }
    this.#promptTimer?.touch()
    const rejection = request.options.find((option) => option.kind === 'reject_once')
      ?? request.options.find((option) => option.kind === 'reject_always')
    const handoff = parsePermissionHandoff(request, {
      sessionId: this.sessionId,
      serverName: BRIDGE_MCP_SERVER_NAME,
      tools: this.#bridge.toolSchemas(this.bridgeOwner),
    })
    const allowance = request.options.find((option) => option.kind === 'allow_once')
    if (handoff && allowance) {
      if (this.#permissionIds.has(request.toolCall.toolCallId)) return { outcome: { outcome: 'cancelled' } }
      this.#permissionIds.add(request.toolCall.toolCallId)
      this.#reportArgumentIssues(handoff)
      this.#callbacks.onBridgePermission?.(handoff.name)
      return { outcome: { outcome: 'selected', optionId: allowance.optionId } }
    }
    this.#reportPermissionDiagnostic(request)
    this.#recordNativeRefusal('permission', 'session/request_permission')
    return rejection
      ? { outcome: { outcome: 'selected', optionId: rejection.optionId } }
      : { outcome: { outcome: 'cancelled' } }
  }

  handleUnexpectedNativeRequest(method: string): void {
    if (this.#terminated || this.#promptSettled) return
    this.#recordNativeRefusal('request', method)
  }

  handleParkedCall(call: BridgeParkedCall): void {
    if (this.#terminated || this.#promptSettled) return
    this.#promptTimer?.touch()
    if (this.#oneShot) {
      this.#fail({
        code: AGY_TURN_ERROR.NATIVE_ACTIVITY_REFUSED,
        message: '一次性辅助请求（标题/压缩）不允许发起工具调用，已拒绝',
      })
      return
    }
    if (this.#roundEnded) {
      this.#deferred.push({ kind: 'call', call })
      return
    }
    this.#acceptParkedCall(call)
  }

  startPrompt(prompt: PromptContent, signal?: AbortSignal): void {
    this.#promptStarted = true
    if (signal) this.#attachAbort(signal)
    if (this.#terminated) return
    const response = this.#link.prompt(
      { sessionId: this.sessionId, prompt },
      {
        timeoutMs: this.#promptTimeoutMs,
        onTimerControl: (control) => { this.#promptTimer = control },
      },
    )
    void this.#drive(response)
  }

  resume(signal?: AbortSignal): void {
    if (this.#terminated) return
    this.#roundEnded = false
    this.#producerDone = false
    this.#nextIndex = 0
    this.#open = undefined
    this.#abortCleanup?.()
    this.#abortCleanup = undefined
    if (signal) this.#attachAbort(signal)
    const deferred = this.#deferred
    this.#deferred = []
    for (const item of deferred) {
      if (this.#roundEnded || this.#terminated) {
        this.#deferred.push(item)
        continue
      }
      if (item.kind === 'update') this.#applyUpdate(item.update)
      else this.#acceptParkedCall(item.call)
    }
  }

  async deliverToolResults(results: readonly BridgeToolResult[]): Promise<void> {
    for (const result of results) {
      if (!this.#bridge.hasPending(result.callId)) {
        throw new Error(`${AGY_TURN_ERROR.NO_PENDING_TOOL_CALL}: 本回合没有等待回喂的工具调用 ${result.callId}`)
      }
    }
    await this.#bridge.deliverResults(results)
    this.#promptTimer?.resume()
  }

  abort(reason: string): void {
    if (this.#terminated) return
    this.#aborted = true
    this.#fail({ code: AGY_TURN_ERROR.ABORTED, message: reason })
  }

  async nextChunk(): Promise<StreamChunk | undefined> {
    for (;;) {
      const chunk = this.#queue.shift()
      if (chunk !== undefined) return chunk
      if (this.#producerDone) return undefined
      await new Promise<void>((resolve) => this.#waiters.push(resolve))
    }
  }

  async settled(): Promise<void> {
    if (this.#promptSettled) return
    await new Promise<void>((resolve) => this.#settledWaiters.push(resolve))
  }

  dispose(): void {
    if (this.#parkTimer) {
      clearTimeout(this.#parkTimer)
      this.#parkTimer = undefined
    }
    this.#promptTimer = undefined
    this.#abortCleanup?.()
    this.#abortCleanup = undefined
  }

  finishRound(usage?: TokenUsage): void {
    if (this.#roundEnded) return
    this.#roundEnded = true
    this.closeOpenBlock()
    if (usage) this.#push({ type: 'usage', usage })
    this.#push({ type: 'finish', reason: this.#resolveFinish() })
    this.#producerDone = true
    this.#wake()
    if (this.#parkTimer) clearTimeout(this.#parkTimer)
    this.#parkTimer = undefined
    if (this.#promptSettled) this.dispose()
    else if (this.awaitingToolResults) this.#promptTimer?.pause()
  }

  closeOpenBlock(): void {
    const open = this.#open
    if (!open) return
    this.#open = undefined
    this.#push({ type: 'block-end', index: open.index, block: { type: open.blockType, text: open.parts.join('') } })
  }

  /* ── 内部方法 ────────────────────────────────────────────────────── */

  #acceptParkedCall(call: BridgeParkedCall): void {
    this.#parked.push(call)
    this.#emitToolCallBlock(call)
    if (this.#parkTimer) clearTimeout(this.#parkTimer)
    this.#parkTimer = setTimeout(() => {
      this.#parkTimer = undefined
      this.finishRound(this.#usage.emitIntermediateStep())
    }, this.#parkSettleMs)
  }

  #recordNativeRefusal(kind: 'permission' | 'request', detail: string): void {
    this.#nativeRefusals += 1
    this.#callbacks.onNativeRefusal?.({ kind, detail, count: this.#nativeRefusals })
  }

  #reportPermissionDiagnostic(request: RequestPermissionRequest): void {
    this.#callbacks.onPermissionDiagnostic?.(describePermissionRequest(request, {
      sessionId: this.sessionId,
      serverName: BRIDGE_MCP_SERVER_NAME,
      toolNames: this.#bridge.toolNames(this.bridgeOwner),
    }))
  }

  #reportArgumentIssues(handoff: { name: string; arguments: string }): void {
    if (!this.#callbacks.onArgumentIssues) return
    const tool = this.#bridge.toolSchemas(this.bridgeOwner).find((item) => item.name === handoff.name)
    if (!tool) return
    let args: unknown
    try { args = JSON.parse(handoff.arguments) } catch { return }
    const { missing, unknown } = inspectToolArguments(tool, args)
    if (missing.length === 0 && unknown.length === 0) return
    this.#callbacks.onArgumentIssues({
      tool: handoff.name,
      missing: safeKeyNames(missing),
      unknown: safeKeyNames(unknown),
      unknownCount: unknown.length,
    })
  }

  async #drive(prompt: Promise<PromptResponse>): Promise<void> {
    try {
      const response = await prompt
      this.#markPromptSettled(response)
      this.#finishWith(response)
    } catch (error) {
      this.#markPromptSettled()
      this.#fail({
        code: readErrorCode(error),
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  #markPromptSettled(response?: PromptResponse): void {
    this.#promptSettled = true
    this.dispose()
    const waiters = this.#settledWaiters
    this.#settledWaiters = []
    for (const resolve of waiters) resolve()
    this.#callbacks.onPromptSettled?.(this, response)
  }

  #finishWith(response: PromptResponse): void {
    const reason = this.#mapStopReason(response.stopReason)
    if (reason) {
      this.#fail(reason, true)
      return
    }
    if (response.stopReason === 'end_turn' && !this.#hasOutput) {
      if (this.#nativeRefusals > 0) {
        this.#fail({
          code: AGY_TURN_ERROR.NATIVE_ACTIVITY_REFUSED,
          message: `Antigravity ACP 本轮因拒绝了 ${this.#nativeRefusals} 次非预期原生能力或未识别工具权限请求而空结束回合`,
        }, true)
        return
      }
      this.#fail({
        code: AGY_TURN_ERROR.EMPTY_RESPONSE,
        message: 'Antigravity ACP 已结束回合，但没有返回可见文本或工具调用；本次不是成功回复',
      }, true)
      return
    }
    if (response.stopReason === 'end_turn') {
      const notice = describeUpstreamErrorNotice(this.#textParts.join(''), this.#toolCallSeen)
      if (notice !== undefined) {
        this.#fail({ code: AGY_TURN_ERROR.UPSTREAM_ERROR_NOTICE, message: notice }, true)
        return
      }
    }
    this.finishRound(this.#usage.reconcileFinalStep(response.usage ?? undefined))
  }

  #mapStopReason(stopReason: StopReason): LlmFailure | undefined {
    if (this.#failure) return this.#failure
    switch (stopReason) {
      case 'end_turn':
        return undefined
      case 'refusal':
        return { code: AGY_TURN_ERROR.REFUSED, message: 'Antigravity ACP agent 拒绝了本轮请求（stopReason=refusal）' }
      case 'cancelled':
        return { code: AGY_TURN_UNEXPECTED, message: 'Antigravity ACP agent 在未收到调用方 abort 的情况下取消了本轮（stopReason=cancelled）' }
      case 'max_tokens':
      case 'max_turn_requests':
        this.#truncated = true
        return undefined
      default:
        return { code: AGY_TURN_UNEXPECTED, message: `Antigravity ACP 返回未知的 stopReason: ${String(stopReason)}` }
    }
  }

  #fail(failure: LlmFailure, clean = false): void {
    if (this.#failure) return
    this.#failure = failure
    this.finishRound()
    this.dispose()
    this.#deferred = []
    this.#terminated = true
    if (!this.#promptSettled) void this.#link.cancel(this.sessionId).catch(() => undefined)
    this.#callbacks.onTerminate(failure.message, {
      ...(clean ? { clean: true } : {}),
      ...(this.#aborted ? { aborted: true } : {}),
    })
  }

  #resolveFinish(): FinishChunk['reason'] {
    if (this.#failure) {
      return this.#aborted
        ? { kind: 'aborted', failure: this.#failure }
        : { kind: 'error', failure: this.#failure }
    }
    if (this.#parked.some((call) => this.#bridge.hasPending(call.callId))) return { kind: 'tool-calls' }
    if (this.#truncated) return { kind: 'max-tokens' }
    return { kind: 'stop' }
  }

  #applyUpdate(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.#appendText('text', update.messageId ?? undefined, update.content)
        return
      case 'agent_thought_chunk':
        this.#appendText('reasoning', update.messageId ?? undefined, update.content)
        return
      case 'config_option_update': {
        const configUpdate: ConfigOptionUpdate = update
        this.#callbacks.onConfigOptions?.(configUpdate.configOptions)
        return
      }
      case 'tool_call':
      case 'tool_call_update':
        this.#toolCallSeen = true
        return
      default:
        return
    }
  }

  #appendText(blockType: 'text' | 'reasoning', messageId: string | undefined, content: unknown): void {
    if (content && typeof content === 'object' && 'type' in content && content.type !== 'text') {
      this.#fail({ code: 'AGY_UNSUPPORTED_CONTENT', message: 'ACP 返回了当前 DSH 输出通道尚不能保存的非文本内容' })
      return
    }
    const text = renderContentText(content)
    if (text === undefined) return
    if (blockType === 'text') this.#textParts.push(text)
    if (blockType === 'text' && text.trim().length > 0) this.#hasOutput = true
    if (this.#open && (this.#open.blockType !== blockType || this.#open.messageId !== messageId)) {
      this.closeOpenBlock()
    }
    if (!this.#open) {
      this.#open = { index: this.#nextIndex++, blockType, messageId, parts: [] }
      this.#push({ type: 'block-start', index: this.#open.index, blockType })
    }
    this.#open.parts.push(text)
    this.#push(blockType === 'text'
      ? { type: 'text-delta', index: this.#open.index, text }
      : { type: 'reasoning-delta', index: this.#open.index, text })
  }

  #emitToolCallBlock(call: BridgeParkedCall): void {
    this.#hasOutput = true
    this.#toolCallSeen = true
    this.closeOpenBlock()
    const index = this.#nextIndex++
    this.#push({ type: 'block-start', index, blockType: 'tool-call' })
    this.#push({
      type: 'block-end',
      index,
      block: { type: 'tool-call', id: ToolCallId(call.callId), name: call.name, arguments: call.arguments },
    })
  }

  #push(chunk: StreamChunk): void {
    if (this.#producerDone) return
    this.#queue.push(chunk)
    this.#wake()
  }

  #wake(): void {
    const waiters = this.#waiters
    this.#waiters = []
    for (const resolve of waiters) resolve()
  }

  #attachAbort(signal: AbortSignal): void {
    if (signal.aborted) {
      this.abort(String(signal.reason ?? 'aborted'))
      return
    }
    const onAbort = (): void => this.abort(String(signal.reason ?? 'aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    this.#abortCleanup = () => signal.removeEventListener('abort', onAbort)
  }
}

export function describeUpstreamErrorNotice(text: string, toolCallSeen: boolean): string | undefined {
  if (toolCallSeen) return undefined
  const match = /^\s*⚠\s+([A-Z][A-Z0-9_]*)\s+\(code\s+(\d{3})\)\s*:\s*([^\n]*?)\s*$/.exec(text)
  if (match === null) return undefined
  const status = match[1] ?? ''
  const code = match[2] ?? ''
  const rawDetail = match[3] ?? ''
  const detail = rawDetail.length > 200 ? `${rawDetail.slice(0, 200)}…` : rawDetail
  return `上游以 ${status} (HTTP ${code}) 结束了本轮，正文只有这条通告：${detail}`
    + ' 上游失败被 agent 当成正文返回，本轮没有任何产出；先检查本轮注入的指令或稍后重试'
}

function readErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code
  return AGY_TURN_UNEXPECTED
}

function renderContentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (content && typeof content === 'object' && 'type' in content) {
    const block = content as { type: string; text?: unknown }
    if (block.type === 'text' && typeof block.text === 'string') return block.text
  }
  return undefined
}
