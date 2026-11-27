/**
 * 方案 A 薄外观 LlmAdapter（替代原 2,273 行 `antigravity-adapter.ts` + `conversation-workers.ts`）。
 *
 * 核心特征：
 * - 单一共享 ACP 进程（按账号由 `AcpRuntimeManager` 管理）+ 单一全局多作用域 `McpToolBridge`；
 * - 同一 DSH 对话串行排队，不同对话真正并发执行、各自隔离 `PromptTurn` / `ContinuationState` / `BridgeScope`；
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

export interface AntigravityAdapterOptions {
  catalog: CatalogStore
  getLink: (handlers: AgentLinkHandlers, signal?: AbortSignal) => Promise<AgentLink>
  recycleLink: (link: AgentLink) => Promise<void>
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
  continuation: ContinuationState
  routeModel: string
  unsubBridge: () => void
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
  /** 用户取消后等待 agent 确认停止的宽限定时器（独立于活跃表，避免清理活跃句柄后泄漏）。 */
  readonly #cancelGraceTimers = new Map<PromptTurn, ReturnType<typeof setTimeout>>()
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
  get busy(): boolean { return this.#activeStreams > 0 || this.#turnsBySession.size > 0 }

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
    throwIfAborted(signal)
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
      this.#scheduleIdleTimer()
    }
  }

  /** 宿主销毁 DSH 会话时调用：同步清理内存句柄、MCP 作用域与持久化映射。 */
  releaseConversation(dshSessionId: string): void {
    const key = `${dshSessionId}::chat`
    const live = this.#coordinator.drop(key, true)
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
    for (const timer of this.#cancelGraceTimers.values()) clearTimeout(timer)
    this.#cancelGraceTimers.clear()
    for (const active of [...this.#turnsBySession.values()]) {
      active.turn.abort('adapter 已卸载')
      active.unsubBridge()
    }
    this.#turnsBySession.clear()
    this.#turnsByKey.clear()
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
        // 接受的续轮必须换一本新账本：旧账本的 #history 停在首个请求上，`#emitted`
        // 又会跨步累加，不轮换的话从第二段工具调用起 `accepts()` 必为假，
        // 整轮会被判成「接不上原 ACP 会话」而报废（v0.5.7 有此语义，rc.1 重构漏掉）。
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
    const chatKey = reusableSessionKey(options)
    const bridgeOwner = chatKey ?? lockKey
    const tools = options.tools ?? []
    const priorHistory = options.purpose === undefined && hasPriorConversation(options.messages)

    let live: LiveSession | undefined
    let reused = false

    if (chatKey !== undefined) {
      const decision = await this.#coordinator.decide({
        key: chatKey,
        options,
        hasPriorHistory: priorHistory,
        resumeEnabled: settings.resumeSessions !== false,
        hasValidBridgeScope: (k) => this.#bridge.hasScope(k),
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
        live = await this.#resumeSession(chatKey, bridgeOwner, decision.entry, options, settings)
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
        live = this.#coordinator.registerNew({ key: chatKey, sessionId, link, options, systemViaMeta })
      }
    }

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
        this.#catalog.observeConfigOptions(opts, { authoritative: options.purpose === undefined })
      },
      onUsageUpdate: (size) => {
        if (typeof size === 'number' && size > 0) this.#catalog.noteContextWindow(options.model, size)
      },
      onPromptSettled: (settledTurn, response) => {
        const timer = this.#cancelGraceTimers.get(settledTurn)
        if (timer) {
          clearTimeout(timer)
          this.#cancelGraceTimers.delete(settledTurn)
        }
        if (response) {
          const own = this.#coordinator.findBySessionId(settledTurn.sessionId)
          if (own?.cancelled) this.#coordinator.persist(own)
        } else if (settledTurn.terminated && (link.closed || this.#turnsBySession.size === 0)) {
          void this.#options.recycleLink(link).catch(() => undefined)
        }
      },
      onTerminate: (reason, info) => {
        const active = this.#turnsBySession.get(sessionId)
        const cancelled = info?.aborted === true && turn.promptStarted
        if (cancelled) {
          this.#coordinator.markCancelled(sessionId, turn.promptSettled)
          this.#bridge.resetPending(reason, bridgeOwner)
          if (active) this.#cleanupActive(lockKey, active)
          const graceMs = Math.max(0, settings.cancelGraceMs ?? 30_000)
          if (!turn.promptSettled && graceMs > 0) {
            const timer = setTimeout(() => {
              this.#cancelGraceTimers.delete(turn)
              if (!turn.promptSettled) {
                if (!link.closed && this.#turnsBySession.size > 0) {
                  void link.closeSession(sessionId).catch(() => undefined)
                } else {
                  void this.#options.recycleLink(link).catch(() => undefined)
                }
              }
            }, graceMs)
            timer.unref?.()
            this.#cancelGraceTimers.set(turn, timer)
          } else if (!turn.promptSettled && graceMs === 0) {
            if (!link.closed && this.#turnsBySession.size > 0) {
              void link.closeSession(sessionId).catch(() => undefined)
            } else {
              void this.#options.recycleLink(link).catch(() => undefined)
            }
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
        if (!link.closed && this.#turnsBySession.size > 0) {
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
    const active: ActiveConversation = { turn, continuation, routeModel: options.model, unsubBridge }
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
      if (chatKey === undefined) void link.closeSession(sessionId).catch(() => undefined)
      else if (live) this.#coordinator.drop(chatKey, true)
      throw error
    }

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
    try {
      for await (const chunk of drainTurn(turn)) {
        if (chunk.type === 'block-end') {
          continuation.emitted(chunk.block)
          emitted.push(structuredClone(chunk.block))
        }
        if (chunk.type === 'finish' && live) {
          const outcome = classifyTurnOutcome(chunk.reason.kind, turn.promptSettled)
          this.#coordinator.advance(live, options, emitted, turn.promptSettled, outcome)
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
    }
  }

  async *#runContinuation(
    lockKey: string,
    active: ActiveConversation,
    options: GenerateOptions,
    tail: readonly RequestMessage[],
  ): AsyncGenerator<StreamChunk> {
    const { turn } = active
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
    try {
      for await (const chunk of drainTurn(turn)) {
        if (chunk.type === 'block-end') {
          active.continuation.emitted(chunk.block)
          emitted.push(structuredClone(chunk.block))
        }
        if (chunk.type === 'finish' && live) {
          const outcome = classifyTurnOutcome(chunk.reason.kind, turn.promptSettled)
          this.#coordinator.advance(live, options, emitted, turn.promptSettled, outcome)
        }
        yield chunk
      }
    } finally {
      if (turn.promptSettled || turn.terminated) {
        this.#cleanupActive(lockKey, active)
      }
    }
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
    if (updated) this.#catalog.observeConfigOptions(updated, { authoritative })
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
      if (updated) this.#catalog.observeConfigOptions(updated, { authoritative: options.purpose === undefined })
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

function classifyTurnOutcome(
  kind: Extract<StreamChunk, { type: 'finish' }>['reason']['kind'],
  promptSettled: boolean,
): TurnDeliveryOutcome {
  if (kind === 'aborted') return 'cancelled'
  if (kind === 'error') return promptSettled ? 'cancelled' : 'failed'
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
