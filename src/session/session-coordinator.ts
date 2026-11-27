/**
 * 单一权威的 ACP 会话协调器：统一内存句柄与持久化映射的复用/恢复决策。
 *
 * 彻底消除旧版 `#findReusableSession` 与 `#resumeSession` 两份平行且微妙分叉的校验逻辑，
 * 所有决策走同一个纯函数 `evaluateRecordContinuity`，结果显式分为四种：
 * - `reuse`：当前内存连接与桥作用域均有效，直接增量发送；
 * - `resume`：历史合法，需走 `session/resume` 接回原 ACP 会话；
 * - `reset-fresh`：历史前缀已压缩/上轮异常中断/指纹版本升级，丢弃旧映射并明确重开新会话；
 * - `unrecoverable`：路由变更、历史不合法或无法接续，直接报 `AGY_SESSION_UNRECOVERABLE`。
 */
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AgentLink } from '../protocol/agent-link.js'
import {
  incrementalMessages,
  looksLikeInterruptedTurn,
  outputHash,
  outputMatches,
  prefixHash,
  prefixMatches,
  ROUTE_FINGERPRINT_VERSION,
  routeBaseFingerprint,
  routeFingerprint,
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
  routeVersion: number
  usesTools: boolean
  toolsDigest?: string
  systemViaMeta: boolean
  cancelled?: boolean
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
  routeVersion: number
  cancelled?: boolean
}

/**
 * 内存与磁盘共用的纯校验函数。
 */
export function evaluateRecordContinuity(
  record: EvaluatedRecord,
  options: GenerateOptions,
  cwd: string,
): { ok: true } | { ok: false; kind: 'reset-fresh' | 'unrecoverable'; reason: string } {
  if (record.cwd !== cwd) {
    return { ok: false, kind: 'unrecoverable', reason: '会话工作目录与当前不一致' }
  }
  if (record.routeVersion !== ROUTE_FINGERPRINT_VERSION) {
    return { ok: false, kind: 'reset-fresh', reason: '会话映射来自旧的路由指纹版本，按新会话重新开始' }
  }
  if (record.route !== routeFingerprint(options)) {
    // 思考档位是运行时可调的 config_option，用户随时会改，DSH 也会按 adapter 默认
    // 档位重解析；只变档位不该判死整个对话，新建一个 ACP 会话把历史带过去继续。
    if (record.routeBase !== undefined && record.routeBase === routeBaseFingerprint(options)) {
      return { ok: false, kind: 'reset-fresh', reason: '思考档位已变化，按新会话继续（历史保留）' }
    }
    return { ok: false, kind: 'unrecoverable', reason: '模型、思考档位或系统提示已变化' }
  }
  if (options.messages.length <= record.sentCount) {
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
    resumeEnabled: boolean
    hasValidBridgeScope: (key: string) => boolean
    log?: { info(msg: string): void }
  }): Promise<SessionDecision> {
    const { key, options, hasPriorHistory, resumeEnabled, hasValidBridgeScope, log } = input
    const live = this.#live.get(key)

    // 1. 优先检查内存句柄
    if (live) {
      const linkAlive = !live.link.closed
      const bridgeValid = !live.usesTools || hasValidBridgeScope(key)
      const check = evaluateRecordContinuity(live, options, this.#cwd)
      if (!check.ok) {
        this.drop(key, true)
        return { kind: check.kind, reason: check.reason }
      }
      if (linkAlive && bridgeValid) {
        const currentTools = toolsDigest(options.tools)
        if (live.toolsDigest !== undefined && live.toolsDigest !== currentTools) {
          log?.info(
            `antigravity-acp: 工具目录已变化（${live.toolsDigest.slice(0, 8)} → ${currentTools.slice(0, 8)}），`
            + '本轮仍复用原 ACP 会话；新工具从下一个新会话开始可用',
          )
        }
        return { kind: 'reuse', live }
      }
      // 链路已断或桥作用域失效：清内存句柄但保留磁盘映射，转入 resume 路径。
      this.#live.delete(key)
    }

    // 2. 没有历史的新对话直接开新会话
    if (!hasPriorHistory) {
      return { kind: 'reset-fresh', reason: '新对话首次请求' }
    }

    // 3. 有历史：尝试从磁盘映射恢复
    if (!resumeEnabled) {
      this.#store?.delete(key)
      return { kind: 'unrecoverable', reason: 'resumeSessions 未开启' }
    }
    const entry = await this.#store?.get(key)
    if (!entry) {
      return { kind: 'unrecoverable', reason: '没有可用的会话映射' }
    }
    const check = evaluateRecordContinuity(entry, options, this.#cwd)
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
  }): LiveSession {
    const live: LiveSession = {
      key: input.key,
      sessionId: input.sessionId,
      link: input.link,
      cwd: this.#cwd,
      sentCount: input.options.messages.length,
      sentHash: prefixHash(input.options.messages),
      route: routeFingerprint(input.options),
      routeBase: routeBaseFingerprint(input.options),
      routeVersion: ROUTE_FINGERPRINT_VERSION,
      usesTools: (input.options.tools?.length ?? 0) > 0,
      toolsDigest: toolsDigest(input.options.tools),
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
  }): LiveSession {
    const live: LiveSession = {
      key: input.key,
      sessionId: input.entry.sessionId,
      link: input.link,
      cwd: input.entry.cwd,
      sentCount: input.entry.sentCount,
      sentHash: input.entry.sentHash,
      outputHash: input.entry.outputHash,
      route: input.entry.route,
      // 旧映射没有 routeBase 时由调用方按当前请求补齐；两处都没有则留空，
      // 判定退回「不可恢复」的保守语义。
      ...(input.entry.routeBase ?? input.routeBase) === undefined
        ? {}
        : { routeBase: (input.entry.routeBase ?? input.routeBase)! },
      routeVersion: input.entry.routeVersion,
      usesTools: input.usesTools,
      systemViaMeta: true,
      ...(input.entry.cancelled === true ? { cancelled: true } : {}),
    }
    this.#live.set(input.key, live)
    return live
  }

  /** 在 prompt 发出前清除旧磁盘游标，避免进程崩溃后拿到过期游标。 */
  async clearPersistedBeforePrompt(key: string): Promise<void> {
    if (!this.#store) return
    this.#store.delete(key)
    await this.#store.flush()
  }

  /** 回合完成、取消或干净失败后推进已发送游标并落盘；异常失败时丢弃映射。 */
  advance(
    live: LiveSession,
    options: GenerateOptions,
    emitted: readonly ContentBlock[],
    promptSettled: boolean,
    outcome: TurnDeliveryOutcome,
  ): void {
    if (outcome === 'failed') {
      this.drop(live.key, true)
      return
    }
    if (this.#live.get(live.key) !== live) return
    live.sentCount = options.messages.length
    live.sentHash = prefixHash(options.messages)
    live.outputHash = outputHash(emitted)
    if (outcome === 'cancelled') {
      live.cancelled = true
    } else if (promptSettled) {
      delete live.cancelled
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
      routeBase: live.routeBase,
      routeVersion: live.routeVersion,
      updatedAt: Date.now(),
      ...(live.cancelled === true ? { cancelled: true } : {}),
    })
  }

  /** 丢弃内存句柄；`deletePersisted=true` 时同步删磁盘映射。 */
  drop(key: string, deletePersisted: boolean): LiveSession | undefined {
    const live = this.#live.get(key)
    this.#live.delete(key)
    if (deletePersisted) this.#store?.delete(key)
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
    return all
  }
}
