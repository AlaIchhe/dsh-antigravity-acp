/**
 * 方案 A 薄外观 LlmAdapter（替代原 2,273 行 `antigravity-adapter.ts` + `conversation-workers.ts`）。
 *
 * 核心特征：
 * - 单一共享 ACP 进程（按账号由 `AcpRuntimeManager` 管理）+ 单一全局多作用域 `McpToolBridge`；
 * - 同一 DSH 对话串行排队，不同对话真正并发执行、各自隔离 `PromptTurn` / `ContinuationState` / `BridgeScope`；
 * - 取消宽限等待（`#pendingCancels`）：用户取消后立即续聊时，等待上轮 agent 确认 `cancelled` 再复用，
 *   彻底避免撞上 `wait for it to finish` 误报报废；
 * - 账号切换隔离：与 `SessionCoordinator` / `AcpRuntimeManager` 协作，在途回合不中断、空闲后自动排空旧链路、
 *   切账号后老对话平滑 `reset-fresh`（历史保留）；
 * - 所有入站 `session/update` 与 `session/request_permission` 按 `sessionId` 精准路由到对应回合；
 * - 空闲超时后回收进程，后续对话通过 `SessionCoordinator` 自动 `session/resume` 接回。
 */
import { randomUUID } from 'node:crypto'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  RequestMessage,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AnyRequest, McpServer as AcpMcpServer, RequestPermissionRequest, SessionNotification } from '@agentclientprotocol/sdk'
import type { AgentLink, AgentLinkHandlers } from '../protocol/agent-link.js'
import { BRIDGE_MCP_SERVER_NAME, McpToolBridge } from '../bridge/mcp-bridge.js'
import type { BridgeToolResult } from '../bridge/mcp-bridge.js'
import { PROVIDER_ID } from '../shared/rpc-contract.js'
import { throwIfAborted, withAbort } from '../runtime/abort.js'
import type { CatalogStore } from './catalog-store.js'
import { applyAgentMode, applySessionSelection } from './model-router.js'
import { SessionCoordinator } from './session-coordinator.js'
import type { LiveSession, TurnDeliveryOutcome } from './session-coordinator.js'
import {
  ContinuationState,
  incrementalMessages,
  reusableSessionKey,
  rotateContinuation,
  routeBaseFingerprint,
  systemMessagesDigest,
} from './session-reuse.js'
import type { SessionStore } from './session-store.js'
import { buildDeltaPrompt, buildFullPrompt, buildToolResultContent, hasPriorConversation } from './transcript.js'
import type { ImageReader } from './transcript.js'
import { AGY_TURN_ERROR, PromptTurn } from './turn-runner.js'
import type { PromptContent } from './turn-runner.js'

export const AGY_PROVIDER_ID = PROVIDER_ID

export const AGY_ADAPTER_ERROR = {
  SESSION_UNRECOVERABLE: 'AGY_SESSION_UNRECOVERABLE',
} as const

export interface AdapterLog {
  info(message: string): void
  warn(message: string, error?: unknown): void
}

export interface AdapterAccountRef {
  id: string
  revision?: number
}

export interface AntigravityAdapterOptions {
  catalog: CatalogStore
  getLink: (handlers: AgentLinkHandlers, signal?: AbortSignal) => Promise<AgentLink>
  recycleLink: (link: AgentLink) => Promise<void>
  resolveAccount?: () => AdapterAccountRef
  onLinkIdle?: (link: AgentLink) => void
  sessionStore?: SessionStore
  cwd?: string
  readSettings: () => {
    agentMode?: string
    resumeSessions?: boolean
    cancelGraceMs?: number
    idleRecycleMs?: number
    promptTimeoutMs?: number
    bridgeParkSettleMs?: number
  }
  readImage?: ImageReader
  canReadImages?: () => boolean
  log?: AdapterLog
}

interface ActiveConversation {
  turn: PromptTurn
  link: AgentLink
  continuation: ContinuationState
  routeModel: string
  unsubBridge: () => void
}

interface PendingCancel {
  readonly turn: PromptTurn
  readonly link: AgentLink
  readonly sessionId: string
  readonly promise: Promise<void>
  readonly timer: ReturnType<typeof setTimeout> | undefined
}

export class AntigravityAcpAdapter extends LlmAdapter {
  readonly #bridge = new McpToolBridge()
  readonly #catalog: CatalogStore
  readonly #coordinator: SessionCoordinator
  readonly #options: AntigravityAdapterOptions
  readonly #cwd: string
  readonly #handlers: AgentLinkHandlers
  /** 按 ACP sessionId 索引当前活跃回合（支持多对话并发路由）。 */
  readonly #turnsBySession = new Map<string, ActiveConversation>()
  /** 按 DSH 对话 key 索引当前活跃回合（供工具续轮查找）。 */
  readonly #turnsByKey = new Map<string, ActiveConversation>()
  /** 按对话 key 串行化同一对话的请求，不同对话完全并发。 */
  readonly #locks = new Map<string, Promise<void>>()
  /** 按 ACP sessionId 跟踪等待取消确认的回合，阻止下一轮抢在 agent 确认前发新 prompt。 */
  readonly #pendingCancels = new Map<string, PendingCancel>()
  /** 按链路统计正在运行的流数量，精确告知 AcpRuntimeManager 某条链路是否繁忙。 */
  readonly #streamsByLink = new Map<AgentLink, number>()
  #currentLink: AgentLink | undefined
  #idleTimer: ReturnType<typeof setTimeout> | undefined
  #activeStreams = 0
  #disposed = false

  constructor(options: AntigravityAdapterOptions) {
    super()
    this.#options = options
    this.#catalog = options.catalog
    this.#cwd = options.cwd ?? process.cwd()
    this.#coordinator = new SessionCoordinator(this.#cwd, options.sessionStore)
    this.#handlers = {
      onSessionUpdate: (notification) => this.#dispatchUpdate(notification),
      onRequestPermission: (request) => this.#dispatchPermission(request),
      onUnexpectedAgentRequest: (_method, request) => this.#dispatchUnexpected(request),
    }
  }

  get bridge(): McpToolBridge { return this.#bridge }
  get busy(): boolean { return this.#activeStreams > 0 || this.#turnsBySession.size > 0 || this.#pendingCancels.size > 0 }

  /** 指定 `AgentLink` 上是否仍有活跃流、挂起工具续轮或未确认取消。 */
  isLinkBusy(link: AgentLink): boolean {
    if ((this.#streamsByLink.get(link) ?? 0) > 0) return true
    for (const active of this.#turnsBySession.values()) {
      if (active.link === link) return true
    }
    for (const pending of this.#pendingCancels.values()) {
      if (pending.link === link) return true
    }
    return false
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Antigravity (ACP)' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.#catalog.listVisibleModels(provider)
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return this.#catalog.resolveModel(provider, model)
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    if ((this.#options.canReadImages?.() ?? false) && this.#catalog.imageSupported === undefined) {
      const link = await this.#options.getLink(this.#handlers, signal)
      this.#observeLink(link)
    }
    const resolved = await this.resolveModel(provider, model)
    return {
      model: resolved,
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  /** 显式拉取 ACP 模型目录（不发任何聊天 prompt）。 */
  async discoverModels(signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    if (this.#disposed) throw new LlmError('Antigravity ACP adapter 已卸载', 'AGY_LINK_CLOSED')
    this.#clearIdleTimer()
    const link = await this.#options.getLink(this.#handlers, signal)
    this.#observeLink(link)
    this.#retainLinkStream(link)
    throwIfAborted(signal)
    try {
      const session = await link.newSession({
        cwd: this.#cwd,
        mcpServers: [],
        _meta: { antigravity: { enabledTools: [], eagerMcpServers: [] } },
      }, { signal })
      try {
        // 探针会话只为读模型清单：它的 currentValue 是 agent 自己的默认档位，
        // 不是用户的思考强度选择，绝不能写进 defaultEffort。
        this.#catalog.observeConfigOptions(session.configOptions, { authoritative: false })
        return await this.#catalog.listVisibleModels(AGY_PROVIDER_ID)
      } finally {
        void link.closeSession(session.sessionId).catch(() => undefined)
      }
    } finally {
      this.#releaseLinkStream(link)
      this.#scheduleIdleTimer()
    }
  }

  /**
   * 宿主卸载内存活会话（如 `session/disposed`：进程关闭/重启或 live → cold 切换）时调用。
   *
   * 默认仅清理内存句柄、MCP 作用域并关闭 ACP 进程侧活跃会话，保留磁盘持久化映射以便
   * 重新打开或重启后通过 `session/resume` 接回；仅当显式传入 `deletePersisted: true` 时才删磁盘映射。
   */
  releaseConversation(dshSessionId: string, options?: { deletePersisted?: boolean }): void {
    const key = `${dshSessionId}::chat`
    const live = this.#coordinator.drop(key, options?.deletePersisted === true)
    this.#bridge.releaseScope(key)
    if (live && !live.link.closed) {
      void live.link.closeSession(live.sessionId).catch(() => undefined)
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const unsupported: string[] = []
    if (options.temperature !== undefined) unsupported.push('temperature')
    if (options.stop !== undefined) unsupported.push('stop')
    if (unsupported.length > 0) {
      this.#options.log?.warn(`antigravity-acp: 忽略不支持的请求项 ${unsupported.join('、')}（ACP v1 无对应通道）`)
    }
    if (options.signal?.aborted) {
      yield {
        type: 'finish',
        reason: { kind: 'aborted', failure: { code: AGY_TURN_ERROR.ABORTED, message: 'Antigravity ACP 请求在发起前已取消' } },
      }
      return
    }

    const lockKey = reusableSessionKey(options) ?? `ephemeral:${randomUUID()}`
    const releaseLock = await this.#acquireConversationLock(lockKey, options.signal)
    this.#activeStreams += 1
    this.#clearIdleTimer()

    let handedOff = false
    try {
      for await (const chunk of this.#streamSerialized(lockKey, options)) {
        if (chunk.type === 'finish') handedOff = true
        yield chunk
      }
    } finally {
      if (!handedOff) {
        const active = this.#turnsByKey.get(lockKey)
        if (active && !active.turn.terminated && !active.turn.promptSettled) {
          active.turn.abort('消费者提前关闭流，取消未完成回合')
        }
      }
      this.#activeStreams -= 1
      this.#scheduleIdleTimer()
      releaseLock()
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#clearIdleTimer()
    for (const pending of this.#pendingCancels.values()) {
      if (pending.timer) clearTimeout(pending.timer)
    }
    this.#pendingCancels.clear()
    for (const active of [...this.#turnsBySession.values()]) {
      active.turn.abort('adapter 已卸载')
      active.unsubBridge()
    }
    this.#turnsBySession.clear()
    this.#turnsByKey.clear()
    this.#streamsByLink.clear()
    this.#coordinator.clearMemory()
    await this.#bridge.close()
  }

  /* ── 核心回合编排 ────────────────────────────────────────────────── */

  async *#streamSerialized(lockKey: string, options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (this.#disposed) throw new LlmError('Antigravity ACP adapter 已卸载', 'AGY_LINK_CLOSED')

    // 1. 检查是否是正在等待工具回喂的续轮
    const existing = this.#turnsByKey.get(lockKey)
    if (existing && !existing.turn.terminated && !existing.turn.promptSettled) {
      const tail = trailingToolResults(options.messages, existing.continuation)
      if (matchesParkedCalls(existing.turn, tail, this.#bridge) && existing.continuation.accepts(options, tail.length)) {
        rotateContinuation(existing, options)
        yield* this.#runContinuation(lockKey, existing, options, tail)
        return
      }
      // 不能续接：终止旧回合再开新轮
      existing.turn.abort('输入已偏离当前工具续轮，放弃旧回合')
      this.#cleanupActive(lockKey, existing)
    }

    // 2. 走新回合（可能复用内存会话 / 跨进程 resume / 新开会话）
    yield* this.#runNewRound(lockKey, options)
  }

  async *#runNewRound(lockKey: string, options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const settings = this.#options.readSettings()
    const account = this.#options.resolveAccount?.()
    const chatKey = reusableSessionKey(options)
    const bridgeOwner = chatKey ?? lockKey
    const tools = options.tools ?? []
    const priorHistory = options.purpose === undefined && hasPriorConversation(options.messages)

    // 若该对话上一轮刚取消且 agent 尚未确认停止，先等宽限期收尾，
    // 绝不抢在确认前向同一 sessionId 发新 prompt（实测 agent 会直接拒成 wait for it to finish）。
    if (chatKey !== undefined) {
      const existingLive = this.#coordinator.getLive(chatKey)
      const pendingCancel = existingLive ? this.#pendingCancels.get(existingLive.sessionId) : undefined
      if (pendingCancel) {
        await withAbort(pendingCancel.promise, options.signal, 'Antigravity ACP 请求在等待上轮取消确认时被取消')
      }
    }

    let live: LiveSession | undefined
    let reused = false

    if (chatKey !== undefined) {
      const decision = await this.#coordinator.decide({
        key: chatKey,
        options,
        hasPriorHistory: priorHistory,
        resumeEnabled: settings.resumeSessions !== false,
        hasValidBridgeScope: (k) => this.#bridge.hasScope(k),
        currentAccountId: account?.id,
        currentAccountRevision: account?.revision,
        log: this.#options.log,
      })
      if (decision.kind === 'unrecoverable') {
        throw new LlmError(
          `无法接上原 ACP 会话（${decision.reason}）。请新开一个会话后再试。`,
          AGY_ADAPTER_ERROR.SESSION_UNRECOVERABLE,
        )
      }
      if (decision.kind === 'reuse') {
        live = decision.live
        reused = true
        if (tools.length > 0) this.#bridge.activateRound(tools, bridgeOwner)
        else this.#bridge.resetPending('已切换 ACP 回合', bridgeOwner)
      } else if (decision.kind === 'resume') {
        live = await this.#resumeSession(chatKey, bridgeOwner, decision.entry, options, settings, account)
        reused = live !== undefined
      } else if (priorHistory) {
        this.#options.log?.info(`antigravity-acp: ${decision.reason}（将新建会话并重放当前历史）`)
      }
    }

    let link: AgentLink
    let sessionId: string
    let systemViaMeta = false

    if (live) {
      link = live.link
      sessionId = live.sessionId
      systemViaMeta = live.systemViaMeta
    } else {
      const prepared = await this.#openNewSession(bridgeOwner, options, settings)
      link = prepared.link
      sessionId = prepared.sessionId
      systemViaMeta = prepared.systemViaMeta
      if (chatKey !== undefined) {
        live = this.#coordinator.registerNew({
          key: chatKey,
          sessionId,
          link,
          options,
          systemViaMeta,
          accountId: account?.id,
          accountRevision: account?.revision,
        })
      }
    }

    this.#retainLinkStream(link)
    const continuation = new ContinuationState(options)
    const turn = new PromptTurn(sessionId, {
      link,
      bridge: this.#bridge,
      bridgeOwner,
      promptTimeoutMs: purposeTimeoutMs(options.purpose, settings.promptTimeoutMs ?? 1_800_000),
      parkSettleMs: settings.bridgeParkSettleMs ?? 50,
      oneShot: options.purpose !== undefined,
      // 标题 / 压缩这类一次性回合会用自己的廉价档位新建 ACP 会话，
      // 它们无权改写用户聊天路由的默认思考强度。
      onConfigOptions: (opts) => {
        this.#catalog.observeConfigOptions(opts, { authoritative: options.purpose === undefined, modelId: options.model })
      },
      onUsageUpdate: (size) => {
        if (typeof size === 'number' && size > 0) this.#catalog.noteContextWindow(options.model, size)
      },
      onPromptSettled: (settledTurn, response) => {
        this.#resolvePendingCancel(settledTurn)
        if (response) {
          const own = this.#coordinator.findBySessionId(settledTurn.sessionId)
          if (own?.cancelled) this.#coordinator.persist(own)
        } else if (settledTurn.terminated && (link.closed || !this.isLinkBusy(link))) {
          void this.#options.recycleLink(link).catch(() => undefined)
        }
        this.#notifyIdleIfUnused(link)
      },
      onTerminate: (reason, info) => {
        const active = this.#turnsBySession.get(sessionId)
        const cancelled = info?.aborted === true && turn.promptStarted
        if (cancelled) {
          this.#coordinator.markCancelled(sessionId, turn.promptSettled)
          this.#bridge.resetPending(reason, bridgeOwner)
          if (active) this.#cleanupActive(lockKey, active)
          if (!turn.promptSettled) {
            this.#trackPendingCancel(chatKey, sessionId, link, turn, Math.max(0, settings.cancelGraceMs ?? 30_000))
          }
          return
        }
        if (info?.clean === true) {
          this.#bridge.resetPending(reason, bridgeOwner)
          if (active) this.#cleanupActive(lockKey, active)
          return
        }
        this.#bridge.invalidateScope(bridgeOwner, reason)
        if (chatKey !== undefined) this.#coordinator.drop(chatKey, true)
        if (active) this.#cleanupActive(lockKey, active)
        // 方案 A 故障隔离：若共享链路仍存活且有其它并发对话运行中，只关闭故障会话，不误杀其它会话。
        if (!link.closed && this.#hasOtherActiveTurnsOnLink(link, sessionId)) {
          void link.closeSession(sessionId).catch(() => undefined)
        } else {
          void this.#options.recycleLink(link).catch(() => undefined)
        }
      },
      onBridgePermission: (tool) => {
        this.#options.log?.info(`antigravity-acp: 私有 MCP 桥放行 tool=${tool}（审批与执行由 DSH 负责）`)
      },
      onArgumentIssues: (info) => {
        this.#options.log?.warn(`antigravity-acp: 工具参数预检 tool=${info.tool} missing=[${info.missing.join(',')}] unknown=${info.unknownCount}`)
      },
      onPermissionDiagnostic: (diag) => {
        this.#options.log?.warn(`antigravity-acp: 权限请求诊断 ${JSON.stringify(diag)}`)
      },
      onNativeRefusal: (info) => {
        this.#options.log?.warn(`antigravity-acp: 拒绝原生能力请求 ${info.detail}（第 ${info.count} 次）`)
      },
    })

    const unsubBridge = this.#bridge.onParked(bridgeOwner, (call) => turn.handleParkedCall(call))
    const active: ActiveConversation = { turn, link, continuation, routeModel: options.model, unsubBridge }
    this.#turnsBySession.set(sessionId, active)
    this.#turnsByKey.set(lockKey, active)

    let promptContent: PromptContent
    try {
      const imageOpts = this.#imageOptions(options.signal)
      if (reused && live) {
        const delta = incrementalMessages(options.messages, live.sentCount, { skipToolResults: live.cancelled === true })
        promptContent = await buildDeltaPrompt(delta, imageOpts)
      } else {
        const systemBlock = systemViaMeta ? undefined : options.system
        promptContent = await buildFullPrompt(systemBlock, options.messages, tools, imageOpts)
      }
    } catch (error) {
      this.#bridge.invalidateScope(bridgeOwner, 'prompt 构造失败')
      this.#cleanupActive(lockKey, active)
      this.#releaseLinkStream(link)
      if (chatKey === undefined) void link.closeSession(sessionId).catch(() => undefined)
      else if (live) this.#coordinator.drop(chatKey, true)
      throw error
    }

    try {
      if (live) await withAbort(this.#coordinator.clearPersistedBeforePrompt(live.key), options.signal)
      if (this.#disposed) {
        turn.abort('adapter 已卸载')
        throw new LlmError('Antigravity ACP adapter 已卸载', 'AGY_LINK_CLOSED')
      }

      this.#options.log?.info(
        `antigravity-acp: 回合开始 model=${options.model} purpose=${options.purpose ?? 'chat'} session=${sessionId} tools=${tools.length}`
        + `${reused ? ' reused=true' : ''}`,
      )

      turn.startPrompt(promptContent, options.signal)
      const emitted: ContentBlock[] = []
      for await (const chunk of drainTurn(turn)) {
        if (chunk.type === 'block-end') {
          continuation.emitted(chunk.block)
          emitted.push(structuredClone(chunk.block))
        }
        if (chunk.type === 'finish' && live) {
          const outcome = classifyTurnOutcome(chunk.reason.kind, turn.promptSettled, {
            reused,
            consecutiveErrors: live.consecutiveErrors,
          })
          if (chunk.reason.kind === 'error' && outcome === 'cancelled') {
            live.consecutiveErrors = (live.consecutiveErrors ?? 0) + 1
          }
          this.#coordinator.advance(live, options, emitted, turn.promptSettled, outcome, {
            allowFreshRetry: chunk.reason.kind === 'error' && turn.promptSettled,
          })
          if (outcome === 'failed') {
            this.#bridge.invalidateScope(bridgeOwner, '回合失败，清理失效 ACP 会话')
            if (!link.closed) void link.closeSession(sessionId).catch(() => undefined)
          }
        }
        yield chunk
      }
    } finally {
      if (turn.promptSettled || turn.terminated) {
        this.#cleanupActive(lockKey, active)
        if (chatKey === undefined) {
          this.#bridge.releaseScope(bridgeOwner)
          void link.closeSession(sessionId).catch(() => undefined)
        }
      }
      this.#releaseLinkStream(link)
    }
  }

  async *#runContinuation(
    lockKey: string,
    active: ActiveConversation,
    options: GenerateOptions,
    tail: readonly RequestMessage[],
  ): AsyncGenerator<StreamChunk> {
    const { turn, link } = active
    this.#retainLinkStream(link)
    try {
      this.#bridge.publishTools(options.tools ?? [], turn.bridgeOwner)
      const imageOpts = this.#imageOptions(options.signal)
      const results: BridgeToolResult[] = []
      for (const message of tail) {
        if (message.role !== 'tool') continue
        const content = await buildToolResultContent(message.content, imageOpts)
        const text = content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join('\n')
        results.push({ callId: message.toolCallId, text, content, isError: message.isError === true })
      }

      turn.resume(options.signal)
      await turn.deliverToolResults(results)

      const chatKey = reusableSessionKey(options)
      const live = chatKey ? this.#coordinator.getLive(chatKey) : undefined
      const emitted: ContentBlock[] = []
      for await (const chunk of drainTurn(turn)) {
        if (chunk.type === 'block-end') {
          active.continuation.emitted(chunk.block)
          emitted.push(structuredClone(chunk.block))
        }
        if (chunk.type === 'finish' && live) {
          const outcome = classifyTurnOutcome(chunk.reason.kind, turn.promptSettled, {
            reused: true,
            consecutiveErrors: live.consecutiveErrors,
          })
          if (chunk.reason.kind === 'error' && outcome === 'cancelled') {
            live.consecutiveErrors = (live.consecutiveErrors ?? 0) + 1
          }
          this.#coordinator.advance(live, options, emitted, turn.promptSettled, outcome, {
            allowFreshRetry: chunk.reason.kind === 'error' && turn.promptSettled,
          })
          if (outcome === 'failed') {
            this.#bridge.invalidateScope(turn.bridgeOwner, '工具续轮失败，清理失效 ACP 会话')
            if (!link.closed) void link.closeSession(turn.sessionId).catch(() => undefined)
          }
        }
        yield chunk
      }
    } finally {
      if (turn.promptSettled || turn.terminated) {
        this.#cleanupActive(lockKey, active)
      }
      this.#releaseLinkStream(link)
    }
  }

  /* ── 取消宽限追踪 ────────────────────────────────────────────────── */

  #trackPendingCancel(
    chatKey: string | undefined,
    sessionId: string,
    link: AgentLink,
    turn: PromptTurn,
    graceMs: number,
  ): void {
    const dropLiveOnTimeout = () => {
      if (chatKey !== undefined) {
        const live = this.#coordinator.getLive(chatKey)
        if (live?.sessionId === sessionId) this.#coordinator.drop(chatKey, false)
      }
    }

    const forceReclaim = async (): Promise<void> => {
      dropLiveOnTimeout()
      if (!link.closed && this.#hasOtherActiveTurnsOnLink(link, sessionId)) {
        await link.closeSession(sessionId).catch(() => undefined)
      } else {
        await this.#options.recycleLink(link).catch(() => undefined)
      }
    }

    if (graceMs === 0) {
      const promise = forceReclaim().finally(() => {
        if (this.#pendingCancels.get(sessionId)?.turn === turn) this.#pendingCancels.delete(sessionId)
        this.#notifyIdleIfUnused(link)
      })
      this.#pendingCancels.set(sessionId, { turn, link, sessionId, promise, timer: undefined })
      return
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const promise = new Promise<void>((resolve) => {
      let finished = false
      const done = () => {
        if (finished) return
        finished = true
        if (timer) { clearTimeout(timer); timer = undefined }
        if (this.#pendingCancels.get(sessionId)?.turn === turn) this.#pendingCancels.delete(sessionId)
        this.#notifyIdleIfUnused(link)
        resolve()
      }
      void turn.settled().then(done)
      timer = setTimeout(() => {
        timer = undefined
        if (turn.promptSettled) {
          done()
          return
        }
        void forceReclaim().finally(done)
      }, graceMs)
      timer.unref?.()
    })
    this.#pendingCancels.set(sessionId, { turn, link, sessionId, promise, timer })
  }

  #resolvePendingCancel(turn: PromptTurn): void {
    const entry = this.#pendingCancels.get(turn.sessionId)
    if (!entry || entry.turn !== turn) return
    if (entry.timer) clearTimeout(entry.timer)
    this.#pendingCancels.delete(turn.sessionId)
  }

  /* ── ACP 会话建立与恢复 ──────────────────────────────────────────── */

  async #openNewSession(
    bridgeOwner: string,
    options: GenerateOptions,
    settings: ReturnType<AntigravityAdapterOptions['readSettings']>,
  ): Promise<{ link: AgentLink; sessionId: string; systemViaMeta: boolean }> {
    const link = await this.#options.getLink(this.#handlers, options.signal)
    this.#observeLink(link)
    throwIfAborted(options.signal)

    const tools = options.tools ?? []
    let mcpServers: AcpMcpServer[] = []
    if (tools.length > 0) {
      this.#bridge.beginRound(tools, bridgeOwner)
      if (!this.#bridge.listening) await this.#bridge.start()
      throwIfAborted(options.signal)
      mcpServers = this.#bridge.acpRegistration(bridgeOwner)
    }

    const systemViaMeta = Boolean(options.system) && link.supportsSystemPromptAppend()
    const session = await link.newSession({
      cwd: this.#cwd,
      mcpServers,
      _meta: {
        antigravity: {
          enabledTools: [],
          eagerMcpServers: tools.length > 0 ? [BRIDGE_MCP_SERVER_NAME] : [],
          ...(systemViaMeta ? { systemPrompt: { append: options.system } } : {}),
        },
      },
    }, { signal: options.signal })
    throwIfAborted(options.signal)

    const authoritative = options.purpose === undefined
    this.#catalog.observeConfigOptions(session.configOptions, { authoritative })
    const updated = await applySessionSelection({
      link,
      sessionId: session.sessionId,
      configOptions: session.configOptions,
      model: options.model,
      effort: options.reasoningEffort,
      signal: options.signal,
      log: this.#options.log,
    })
    if (updated) this.#catalog.observeConfigOptions(updated, { authoritative, modelId: options.model })
    await applyAgentMode({
      link,
      sessionId: session.sessionId,
      mode: settings.agentMode,
      modes: session.modes,
      signal: options.signal,
      log: this.#options.log,
    })

    return { link, sessionId: session.sessionId, systemViaMeta }
  }

  async #resumeSession(
    chatKey: string,
    bridgeOwner: string,
    entry: import('./session-store.js').SessionMapEntry,
    options: GenerateOptions,
    settings: ReturnType<AntigravityAdapterOptions['readSettings']>,
    account: AdapterAccountRef | undefined,
  ): Promise<LiveSession | undefined> {
    const link = await this.#options.getLink(this.#handlers, options.signal)
    this.#observeLink(link)
    if (!link.supportsResumeSession()) {
      this.#options.log?.info('antigravity-acp: agent 未声明 session/resume，改按新会话继续')
      return undefined
    }

    const tools = options.tools ?? []
    let mcpServers: AcpMcpServer[] = []
    if (tools.length > 0) {
      this.#bridge.beginRound(tools, bridgeOwner)
      if (!this.#bridge.listening) await this.#bridge.start()
      mcpServers = this.#bridge.acpRegistration(bridgeOwner)
    }

    try {
      const timeoutMs = Math.min(settings.promptTimeoutMs ?? 1_800_000, 120_000)
      const response = await link.resumeSession({
        sessionId: entry.sessionId,
        cwd: this.#cwd,
        mcpServers,
        _meta: { antigravity: { enabledTools: [], eagerMcpServers: tools.length > 0 ? [BRIDGE_MCP_SERVER_NAME] : [] } },
      }, { signal: options.signal, timeoutMs })

      this.#catalog.observeConfigOptions(response.configOptions, { authoritative: options.purpose === undefined })
      const updated = await applySessionSelection({
        link,
        sessionId: entry.sessionId,
        configOptions: response.configOptions,
        model: options.model,
        effort: options.reasoningEffort,
        signal: options.signal,
        log: this.#options.log,
      })
      if (updated) this.#catalog.observeConfigOptions(updated, { authoritative: options.purpose === undefined, modelId: options.model })
      await applyAgentMode({
        link,
        sessionId: entry.sessionId,
        mode: settings.agentMode,
        modes: response.modes,
        signal: options.signal,
        log: this.#options.log,
      })

      this.#options.log?.info(`antigravity-acp: 已恢复 ACP 会话 session=${entry.sessionId} sent=${entry.sentCount}`)
      return this.#coordinator.registerResumed({
        key: chatKey,
        entry,
        link,
        usesTools: tools.length > 0,
        routeBase: routeBaseFingerprint(options),
        systemDigest: systemMessagesDigest(options.messages),
        accountId: account?.id,
        accountRevision: account?.revision,
      })
    } catch (error) {
      this.#bridge.invalidateScope(bridgeOwner, '恢复失败')
      this.#coordinator.drop(chatKey, true)
      throwIfAborted(options.signal)
      throw new LlmError(
        `无法接上原 ACP 会话（session/resume 失败：${error instanceof Error ? error.message : String(error)}）。请新开会话后再试。`,
        AGY_ADAPTER_ERROR.SESSION_UNRECOVERABLE,
      )
    }
  }

  /* ── 入站事件按 sessionId 路由 ───────────────────────────────────── */

  #dispatchUpdate(notification: SessionNotification): void {
    const active = this.#turnsBySession.get(notification.sessionId)
    if (active) {
      active.turn.handleSessionUpdate(notification)
      return
    }
    if (notification.update.sessionUpdate === 'config_option_update') {
      // 无法确认这是哪一类回合：只学习档位选项表，不改写用户聊天路由的默认档位。
      this.#catalog.observeConfigOptions(notification.update.configOptions, { authoritative: false })
    }
  }

  #dispatchPermission(request: RequestPermissionRequest) {
    const active = this.#turnsBySession.get(request.sessionId)
    if (active) return active.turn.handleRequestPermission(request)
    return { outcome: { outcome: 'cancelled' as const } }
  }

  #dispatchUnexpected(request: AnyRequest): void {
    const params = request.params as { sessionId?: unknown } | undefined
    const sid = typeof params?.sessionId === 'string' ? params.sessionId : undefined
    if (sid) {
      this.#turnsBySession.get(sid)?.turn.handleUnexpectedNativeRequest(request.method)
      return
    }
    for (const active of this.#turnsBySession.values()) {
      active.turn.handleUnexpectedNativeRequest(request.method)
    }
  }

  /* ── 并发锁、空闲回收与清理 ──────────────────────────────────────── */

  #observeLink(link: AgentLink): void {
    this.#currentLink = link
    const imageSupported = link.initializeResponse?.agentCapabilities?.promptCapabilities?.image === true
    this.#catalog.setImageSupported(imageSupported)
  }

  #retainLinkStream(link: AgentLink): void {
    this.#streamsByLink.set(link, (this.#streamsByLink.get(link) ?? 0) + 1)
  }

  #releaseLinkStream(link: AgentLink): void {
    const next = (this.#streamsByLink.get(link) ?? 0) - 1
    if (next <= 0) this.#streamsByLink.delete(link)
    else this.#streamsByLink.set(link, next)
    this.#notifyIdleIfUnused(link)
  }

  #hasOtherActiveTurnsOnLink(link: AgentLink, excludeSessionId: string): boolean {
    for (const [sid, active] of this.#turnsBySession) {
      if (sid !== excludeSessionId && active.link === link) return true
    }
    return false
  }

  #notifyIdleIfUnused(link: AgentLink): void {
    if (!this.isLinkBusy(link)) this.#options.onLinkIdle?.(link)
  }

  #imageOptions(signal?: AbortSignal) {
    return {
      readImage: this.#options.readImage,
      supported: this.#catalog.imageSupported === true && (this.#options.canReadImages?.() ?? false),
      signal,
    }
  }

  #cleanupActive(lockKey: string, active: ActiveConversation): void {
    active.unsubBridge()
    if (this.#turnsBySession.get(active.turn.sessionId) === active) {
      this.#turnsBySession.delete(active.turn.sessionId)
    }
    if (this.#turnsByKey.get(lockKey) === active) {
      this.#turnsByKey.delete(lockKey)
    }
    this.#notifyIdleIfUnused(active.link)
  }

  async #acquireConversationLock(key: string, signal?: AbortSignal): Promise<() => void> {
    const previous = this.#locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => current)
    this.#locks.set(key, tail)
    try {
      await withAbort(previous, signal, 'Antigravity ACP 请求在等待同对话锁时被取消')
    } catch (error) {
      release()
      if (this.#locks.get(key) === tail) this.#locks.delete(key)
      throw error
    }
    return () => {
      release()
      if (this.#locks.get(key) === tail) this.#locks.delete(key)
    }
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer)
      this.#idleTimer = undefined
    }
  }

  #scheduleIdleTimer(): void {
    this.#clearIdleTimer()
    if (this.#disposed || this.busy || !this.#currentLink || this.#currentLink.closed) return
    const idleMs = this.#options.readSettings().idleRecycleMs ?? 0
    if (idleMs <= 0) return
    const link = this.#currentLink
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined
      if (this.#disposed || this.busy || this.#currentLink !== link) return
      this.#coordinator.evictForLink(link)
      void this.#options.recycleLink(link).catch(() => undefined)
    }, idleMs)
    this.#idleTimer.unref?.()
  }
}

async function* drainTurn(turn: PromptTurn): AsyncGenerator<StreamChunk> {
  for (;;) {
    const chunk = await turn.nextChunk()
    if (chunk === undefined) return
    yield chunk
  }
}

export function classifyTurnOutcome(
  kind: Extract<StreamChunk, { type: 'finish' }>['reason']['kind'],
  promptSettled: boolean,
  context?: { reused?: boolean; consecutiveErrors?: number },
): TurnDeliveryOutcome {
  if (kind === 'aborted') return 'cancelled'
  if (kind === 'error') {
    if (!promptSettled) return 'failed'
    // 新建会话首轮即以 error 结束（例如冷重放超大历史触发 429 UPSTREAM_ERROR_NOTICE）：
    // 该 ACP 会话从未成功建立有效状态，绝不保留复用，避免下一轮「继续」重复踩坑。
    if (context?.reused === false) return 'failed'
    // 复用的老会话连续两次以 error 结束：说明该 ACP 会话自身已无法推进，放弃复用。
    if ((context?.consecutiveErrors ?? 0) >= 1) return 'failed'
    return 'cancelled'
  }
  return 'delivered'
}

function purposeTimeoutMs(purpose: string | undefined, fallback: number): number {
  if (purpose === 'session-title') return Math.min(fallback, 90_000)
  if (purpose === 'compaction') return Math.min(fallback, 600_000)
  return fallback
}

function trailingToolResults(messages: readonly RequestMessage[], state: ContinuationState): RequestMessage[] {
  const trimmed = state.trimTrailingHostContext(messages)
  const tail: RequestMessage[] = []
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    const message = trimmed[index]
    if (!message || message.role !== 'tool') break
    tail.unshift(message)
  }
  return tail
}

function matchesParkedCalls(turn: PromptTurn, tail: readonly RequestMessage[], bridge: McpToolBridge): boolean {
  if (tail.length === 0) return false
  const parked = turn.parkedCalls.filter((call) => bridge.hasPending(call.callId))
  if (parked.length !== tail.length) return false
  const remaining = new Set(parked.map((call) => call.callId))
  return tail.every((message) => message.role === 'tool' && remaining.delete(message.toolCallId))
}
