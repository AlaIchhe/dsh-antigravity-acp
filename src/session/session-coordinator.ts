/**
 * 单一权威的 ACP 会话协调器：统一内存句柄与持久化映射的复用/恢复决策。
 *
 * 彻底消除旧版 `#findReusableSession` 与 `#resumeSession` 两份平行且微妙分叉的校验逻辑，
 * 所有决策走同一个纯函数 `evaluateRecordContinuity`，结果显式分为四种：
 * - `reuse`：当前内存连接、账号与桥作用域均有效，直接增量发送；
 * - `resume`：历史合法，需走 `session/resume` 接回原 ACP 会话；
 * - `reset-fresh`：账号切换 / 无工具切有工具 / 仅思考档位变化 / 前缀压缩 / 异常中断 / 指纹升级 / 上轮失效会话清理后重试，
 *   丢弃旧映射并明确重开新会话（保留历史）；
 * - `unrecoverable`：模型或系统提示变化、历史不合法或映射缺失，直接报 `AGY_SESSION_UNRECOVERABLE`。
 */
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AgentLink } from '../protocol/agent-link.js'
import {
  hasCompactionCheckpoint,
  incrementalMessages,
  looksLikeInterruptedTurn,
  outputHash,
  outputMatches,
  prefixHash,
  prefixMatches,
  ROUTE_FINGERPRINT_VERSION,
  routeBaseFingerprint,
  routeFingerprint,
  routeSystemFingerprint,
  systemMessagesDigest,
  toolsDigest,
} from './session-reuse.js'
import type { SessionMapEntry, SessionStore } from './session-store.js'

export interface LiveSession {
  key: string
  sessionId: string
  link: AgentLink
  cwd: string
  sentCount: number
  sentHash: string
  outputHash?: string
  route: string
  routeBase?: string
  routeSystem?: string
  routeVersion: number
  accountId?: string
  accountRevision?: number
  usesTools: boolean
  toolsDigest?: string
  systemDigest?: string
  systemViaMeta: boolean
  cancelled?: boolean
  /** 仅内存态：该 ACP 会话连续以 error 结束的次数，达到阈值后放弃复用。 */
  consecutiveErrors?: number
}

export type SessionDecision =
  | { kind: 'reuse'; live: LiveSession }
  | { kind: 'resume'; entry: SessionMapEntry }
  | { kind: 'reset-fresh'; reason: string }
  | { kind: 'unrecoverable'; reason: string }

export type TurnDeliveryOutcome = 'delivered' | 'cancelled' | 'failed'

export interface EvaluatedRecord {
  sessionId: string
  cwd: string
  sentCount: number
  sentHash: string
  outputHash?: string
  route: string
  routeBase?: string
  routeSystem?: string
  routeVersion: number
  accountId?: string
  cancelled?: boolean
  inFlight?: boolean
}

/**
 * 内存与磁盘共用的纯校验函数。
 */
export function evaluateRecordContinuity(
  record: EvaluatedRecord,
  options: GenerateOptions,
  cwd: string,
  currentAccountId?: string,
): { ok: true } | { ok: false; kind: 'reset-fresh' | 'unrecoverable'; reason: string } {
  if (record.inFlight === true) {
    return { ok: false, kind: 'reset-fresh', reason: '上一轮在途时进程中断或未正常收尾，按新会话继续（历史保留）' }
  }
  if (record.cwd !== cwd) {
    return { ok: false, kind: 'reset-fresh', reason: '会话工作目录已变化，按新会话继续（历史保留）' }
  }
  if (record.routeVersion !== ROUTE_FINGERPRINT_VERSION) {
    return { ok: false, kind: 'reset-fresh', reason: '会话映射来自旧的路由指纹版本，按新会话重新开始' }
  }
  if (currentAccountId !== undefined && record.accountId !== undefined && record.accountId !== currentAccountId) {
    return { ok: false, kind: 'reset-fresh', reason: '当前账号已切换，按新会话继续（历史保留）' }
  }
  if (record.route !== routeFingerprint(options)) {
    // 思考档位是运行时可调的 config_option，用户随时会改，DSH 也会按 adapter 默认
    // 档位重解析；只变档位不该判死整个对话，新建一个 ACP 会话把历史带过去继续。
    if (record.routeBase !== undefined && record.routeBase === routeBaseFingerprint(options)) {
      return { ok: false, kind: 'reset-fresh', reason: '思考档位已变化，按新会话继续（历史保留）' }
    }
    // 同 provider 下切换模型（系统提示未变）：按新会话重放历史继续，不阻断 DSH 切模型能力。
    if (record.routeSystem !== undefined && record.routeSystem === routeSystemFingerprint(options)) {
      return { ok: false, kind: 'reset-fresh', reason: '模型已切换，按新会话继续（历史保留）' }
    }
    return { ok: false, kind: 'unrecoverable', reason: '模型、思考档位或系统提示已变化' }
  }
  if (options.messages.length <= record.sentCount) {
    // 上下文压缩（/compact）会把消息条数大幅缩减并插入 compact-checkpoint；
    // 必须在长度检查阶段识别，否则会被误判为「没有严格追加的新输入」而判死对话。
    if (hasCompactionCheckpoint(options.messages)) {
      return { ok: false, kind: 'reset-fresh', reason: '会话已触发上下文压缩，按新会话开始' }
    }
    return { ok: false, kind: 'unrecoverable', reason: '没有严格追加的新输入' }
  }
  if (!prefixMatches(options.messages, record.sentCount, record.sentHash)) {
    return { ok: false, kind: 'reset-fresh', reason: '历史前缀已变化（如触发上下文压缩），按新会话开始' }
  }
  const fresh = options.messages.slice(record.sentCount)
  if (record.cancelled !== true && !outputMatches(fresh, record.outputHash)) {
    if (looksLikeInterruptedTurn(fresh, record.outputHash)) {
      return { ok: false, kind: 'reset-fresh', reason: `上一轮疑似异常中断（映射停在 sent=${record.sentCount}），按新会话开始` }
    }
    return { ok: false, kind: 'unrecoverable', reason: '上一轮输出已变化或来自其他会话' }
  }
  if (record.cancelled !== true && fresh.some((message) => message.role === 'tool')) {
    return { ok: false, kind: 'unrecoverable', reason: '新增消息包含未匹配的工具结果' }
  }
  if (incrementalMessages(options.messages, record.sentCount, { skipToolResults: record.cancelled === true }).length === 0) {
    return { ok: false, kind: 'unrecoverable', reason: '没有可发送的增量消息' }
  }
  return { ok: true }
}

export class SessionCoordinator {
  readonly #live = new Map<string, LiveSession>()
  /** 记录刚因首轮上游错误或连续失败主动清理掉失效 ACP 会话的键，允许下一次明确以全新会话重试。 */
  readonly #recoverableFreshResets = new Set<string>()
  readonly #cwd: string
  #store: SessionStore | undefined

  constructor(cwd: string, store?: SessionStore) {
    this.#cwd = cwd
    this.#store = store
  }

  setStore(store: SessionStore | undefined): void {
    this.#store = store
  }

  getLive(key: string): LiveSession | undefined {
    return this.#live.get(key)
  }

  findBySessionId(sessionId: string): LiveSession | undefined {
    for (const item of this.#live.values()) {
      if (item.sessionId === sessionId) return item
    }
    return undefined
  }

  /**
   * 决定本轮聊天对指定 `key` 应走哪条路径。
   */
  async decide(input: {
    key: string
    options: GenerateOptions
    hasPriorHistory: boolean
    isSeededSession?: boolean
    resumeEnabled: boolean
    hasValidBridgeScope: (key: string) => boolean
    currentAccountId?: string
    currentAccountRevision?: number
    log?: { info(msg: string): void }
  }): Promise<SessionDecision> {
    const {
      key,
      options,
      hasPriorHistory,
      isSeededSession = false,
      resumeEnabled,
      hasValidBridgeScope,
      currentAccountId,
      currentAccountRevision,
      log,
    } = input
    const live = this.#live.get(key)

    // 1. 优先检查内存句柄
    if (live) {
      // 当前账号重新登录（同 accountId 但 revision 递增）：清掉旧句柄并新建会话以启用新凭据。
      if (
        currentAccountId !== undefined
        && live.accountId === currentAccountId
        && currentAccountRevision !== undefined
        && live.accountRevision !== undefined
        && live.accountRevision !== currentAccountRevision
      ) {
        this.drop(key, true)
        return { kind: 'reset-fresh', reason: '当前账号已重新登录，按新会话继续（历史保留）' }
      }
      const check = evaluateRecordContinuity(live, options, this.#cwd, currentAccountId)
      if (!check.ok) {
        this.drop(key, true)
        return { kind: check.kind, reason: check.reason }
      }
      // 第 1 轮未挂 MCP 桥，本轮首次带上工具：旧 ACP 会话上没有 dsh-tools server，必须重建挂载。
      const needsTools = (options.tools?.length ?? 0) > 0
      if (!live.usesTools && needsTools) {
        this.drop(key, true)
        return { kind: 'reset-fresh', reason: '当前会话首次启用工具，需新建 ACP 会话以挂载 MCP 桥' }
      }
      const linkAlive = !live.link.closed
      const bridgeValid = !live.usesTools || hasValidBridgeScope(key)
      if (linkAlive && bridgeValid) {
        const currentTools = toolsDigest(options.tools)
        if (live.toolsDigest !== undefined && live.toolsDigest !== currentTools) {
          log?.info(
            `antigravity-acp: 工具目录已变化（${live.toolsDigest.slice(0, 8)} → ${currentTools.slice(0, 8)}），`
            + '本轮仍复用原 ACP 会话；新工具从下一个新会话开始可用',
          )
        }
        const currentSystem = systemMessagesDigest(options.messages)
        if (live.systemDigest !== undefined && live.systemDigest !== currentSystem) {
          live.systemDigest = currentSystem
          log?.info(
            'antigravity-acp: 系统提示消息已刷新，本轮仍复用原 ACP 会话；'
            + '新系统提示从下一个新会话开始生效',
          )
        }
        return { kind: 'reuse', live }
      }
      // 链路已断或桥作用域失效：清内存句柄但保留磁盘映射，转入 resume 路径。
      this.#live.delete(key)
    }

    // 2. 没有历史的新对话直接开新会话
    if (!hasPriorHistory) {
      this.#recoverableFreshResets.delete(key)
      return { kind: 'reset-fresh', reason: '新对话首次请求' }
    }

    // 2.5 上一轮因新建会话首轮失败或连续上游失败主动丢弃了废 ACP 会话：允许干净重开，避免复用毒丸会话或误判不可恢复。
    if (this.#recoverableFreshResets.delete(key)) {
      return { kind: 'reset-fresh', reason: '上一轮失效的 ACP 会话已清理，按全新会话重试' }
    }

    // 3. 有历史：尝试从磁盘映射恢复
    if (!resumeEnabled) {
      const existing = await this.#store?.get(key)
      if (isSeededSession && !existing) {
        return { kind: 'reset-fresh', reason: '分叉会话首次接入 ACP，按新会话开始（历史保留）' }
      }
      this.#store?.delete(key)
      return { kind: 'unrecoverable', reason: 'resumeSessions 未开启' }
    }
    const entry = await this.#store?.get(key)
    if (!entry) {
      if (isSeededSession) {
        return { kind: 'reset-fresh', reason: '分叉会话首次接入 ACP，按新会话开始（历史保留）' }
      }
      return { kind: 'unrecoverable', reason: '没有可用的会话映射' }
    }
    const check = evaluateRecordContinuity(entry, options, this.#cwd, currentAccountId)
    if (!check.ok) {
      this.#store?.delete(key)
      return { kind: check.kind, reason: check.reason }
    }
    return { kind: 'resume', entry }
  }

  registerNew(input: {
    key: string
    sessionId: string
    link: AgentLink
    options: GenerateOptions
    systemViaMeta: boolean
    accountId?: string
    accountRevision?: number
  }): LiveSession {
    this.#recoverableFreshResets.delete(input.key)
    const live: LiveSession = {
      key: input.key,
      sessionId: input.sessionId,
      link: input.link,
      cwd: this.#cwd,
      sentCount: input.options.messages.length,
      sentHash: prefixHash(input.options.messages),
      route: routeFingerprint(input.options),
      routeBase: routeBaseFingerprint(input.options),
      routeSystem: routeSystemFingerprint(input.options),
      routeVersion: ROUTE_FINGERPRINT_VERSION,
      ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
      ...(input.accountRevision === undefined ? {} : { accountRevision: input.accountRevision }),
      usesTools: (input.options.tools?.length ?? 0) > 0,
      toolsDigest: toolsDigest(input.options.tools),
      systemDigest: systemMessagesDigest(input.options.messages),
      systemViaMeta: input.systemViaMeta,
    }
    this.#live.set(input.key, live)
    return live
  }

  registerResumed(input: {
    key: string
    entry: SessionMapEntry
    link: AgentLink
    usesTools: boolean
    /** 旧映射没有 `routeBase` 时用它补上（调用方按当前请求算）。 */
    routeBase?: string
    /** 旧映射没有 `routeSystem` 时用它补上（调用方按当前请求算）。 */
    routeSystem?: string
    systemDigest?: string
    accountId?: string
    accountRevision?: number
  }): LiveSession {
    this.#recoverableFreshResets.delete(input.key)
    const resolvedAccountId = input.entry.accountId ?? input.accountId
    const resolvedRouteBase = input.entry.routeBase ?? input.routeBase
    const resolvedRouteSystem = input.entry.routeSystem ?? input.routeSystem
    const live: LiveSession = {
      key: input.key,
      sessionId: input.entry.sessionId,
      link: input.link,
      cwd: input.entry.cwd,
      sentCount: input.entry.sentCount,
      sentHash: input.entry.sentHash,
      outputHash: input.entry.outputHash,
      route: input.entry.route,
      // 旧映射没有 routeBase/routeSystem 时由调用方按当前请求补齐；两处都没有则留空，
      // 判定退回「不可恢复」的保守语义。
      ...(resolvedRouteBase === undefined ? {} : { routeBase: resolvedRouteBase }),
      ...(resolvedRouteSystem === undefined ? {} : { routeSystem: resolvedRouteSystem }),
      routeVersion: input.entry.routeVersion,
      ...(resolvedAccountId === undefined ? {} : { accountId: resolvedAccountId }),
      ...(input.accountRevision === undefined ? {} : { accountRevision: input.accountRevision }),
      usesTools: input.usesTools,
      ...(input.systemDigest === undefined ? {} : { systemDigest: input.systemDigest }),
      systemViaMeta: true,
      ...(input.entry.cancelled === true ? { cancelled: true } : {}),
    }
    this.#live.set(input.key, live)
    return live
  }

  /**
   * 在 prompt 发出前将磁盘映射标记为 `inFlight: true` 并刷盘。
   *
   * 相比直接删条目：既保证进程崩溃/重启或取消宽限超时后绝不复用在途脏会话，
   * 又保留「该会话确实存在过且是在途中断」的证据，下一轮可安全 `reset-fresh` 而不是误报无映射。
   */
  async markInFlightBeforePrompt(live: LiveSession): Promise<void> {
    if (!this.#store) return
    this.#store.set(live.key, {
      sessionId: live.sessionId,
      cwd: live.cwd,
      sentCount: live.sentCount,
      sentHash: live.sentHash,
      outputHash: live.outputHash ?? outputHash([]),
      route: live.route,
      ...(live.routeBase === undefined ? {} : { routeBase: live.routeBase }),
      ...(live.routeSystem === undefined ? {} : { routeSystem: live.routeSystem }),
      routeVersion: live.routeVersion,
      ...(live.accountId === undefined ? {} : { accountId: live.accountId }),
      updatedAt: Date.now(),
      ...(live.cancelled === true ? { cancelled: true } : {}),
      inFlight: true,
    })
    await this.#store.flush()
  }

  /** 回合完成、取消或干净失败后推进已发送游标并落盘；异常/不可复用失败时丢弃映射。 */
  advance(
    live: LiveSession,
    options: GenerateOptions,
    emitted: readonly ContentBlock[],
    promptSettled: boolean,
    outcome: TurnDeliveryOutcome,
    advanceOptions?: { allowFreshRetry?: boolean },
  ): void {
    if (outcome === 'failed') {
      this.drop(live.key, true, { allowFreshRetry: advanceOptions?.allowFreshRetry })
      return
    }
    if (this.#live.get(live.key) !== live) return
    live.sentCount = options.messages.length
    live.sentHash = prefixHash(options.messages)
    live.outputHash = outputHash(emitted)
    live.systemDigest = systemMessagesDigest(options.messages)
    if (outcome === 'cancelled') {
      live.cancelled = true
    } else if (promptSettled) {
      delete live.cancelled
      delete live.consecutiveErrors
      this.#recoverableFreshResets.delete(live.key)
    }
    if (promptSettled) this.persist(live)
  }

  markCancelled(sessionId: string, promptSettled: boolean): void {
    const live = this.findBySessionId(sessionId)
    if (!live) return
    live.cancelled = true
    if (promptSettled) this.persist(live)
  }

  persist(live: LiveSession): void {
    if (!this.#store) return
    const hash = live.outputHash ?? (live.cancelled === true ? outputHash([]) : undefined)
    if (hash === undefined) return
    this.#store.set(live.key, {
      sessionId: live.sessionId,
      cwd: live.cwd,
      sentCount: live.sentCount,
      sentHash: live.sentHash,
      outputHash: hash,
      route: live.route,
      ...(live.routeBase === undefined ? {} : { routeBase: live.routeBase }),
      ...(live.routeSystem === undefined ? {} : { routeSystem: live.routeSystem }),
      routeVersion: live.routeVersion,
      ...(live.accountId === undefined ? {} : { accountId: live.accountId }),
      updatedAt: Date.now(),
      ...(live.cancelled === true ? { cancelled: true } : {}),
    })
  }

  /** 丢弃内存句柄；`deletePersisted=true` 时同步删磁盘映射。 */
  drop(key: string, deletePersisted: boolean, options?: { allowFreshRetry?: boolean }): LiveSession | undefined {
    const live = this.#live.get(key)
    this.#live.delete(key)
    if (deletePersisted) this.#store?.delete(key)
    if (options?.allowFreshRetry === true) this.#recoverableFreshResets.add(key)
    else this.#recoverableFreshResets.delete(key)
    return live
  }

  /** 链路异常断连：清掉该链接上的所有内存句柄，但保留磁盘映射以便后续 resume。 */
  evictForLink(link: AgentLink): LiveSession[] {
    const evicted: LiveSession[] = []
    for (const [key, live] of this.#live) {
      if (live.link === link) {
        this.#live.delete(key)
        evicted.push(live)
      }
    }
    return evicted
  }

  clearMemory(): LiveSession[] {
    const all = [...this.#live.values()]
    this.#live.clear()
    this.#recoverableFreshResets.clear()
    return all
  }
}
