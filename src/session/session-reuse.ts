/**
 * 统一的会话复用与工具续轮指纹判定。
 *
 * v1.0 关键修复：
 * - `ContinuationState` 与 `SessionCoordinator` 共享同一个 `routeFingerprint`；
 * - 工具目录不参与任何路由或续轮指纹（只作 `toolsDigest` 诊断日志），彻底解决
 *   回合中途或跨轮动态注入工具（如 `bcdp_*`）导致会话或工具续轮中断的问题。
 */
import { createHash } from 'node:crypto'
import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'

export const ROUTE_FINGERPRINT_VERSION = 3

export function messageId(message: RequestMessage): string {
  const id = (message as { readonly id?: unknown }).id
  return typeof id === 'string' ? id : ''
}

export function messageSourceKind(message: RequestMessage): string | undefined {
  const source = (message as { readonly source?: { readonly kind?: unknown } }).source
  return source && typeof source.kind === 'string' ? source.kind : undefined
}

export function messageValue(message: RequestMessage): unknown {
  return message.role === 'tool'
    ? { role: message.role, content: message.content, toolCallId: message.toolCallId, isError: message.isError === true }
    : { role: message.role, content: message.content }
}

/** 键序无关的稳定 JSON 序列化。 */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
  })
}

export function reusableSessionKey(options: Pick<GenerateOptions, 'sessionId' | 'purpose'>): string | undefined {
  if (options.purpose !== undefined || !options.sessionId) return undefined
  return `${options.sessionId}::chat`
}

/**
 * 唯一路由指纹：只覆盖建会话后不可热改的维度（provider / model / effort / system）。
 * 工具目录刻意不参与，由 `toolsDigest` 单独记诊断日志。
 */
export function routeFingerprint(
  options: Pick<GenerateOptions, 'provider' | 'model' | 'reasoningEffort' | 'system'>,
): string {
  return createHash('sha256').update(stableJson({
    provider: options.provider,
    model: options.model,
    effort: options.reasoningEffort?.toString(),
    system: options.system ?? '',
  })).digest('hex')
}

export function toolsDigest(tools: GenerateOptions['tools'] | undefined): string {
  return createHash('sha256').update(stableJson(
    [...(tools ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
  )).digest('hex')
}

export function messageFingerprint(message: RequestMessage): string {
  return stableJson({ id: messageId(message), value: messageValue(message) })
}

export function prefixHash(messages: readonly RequestMessage[], count: number = messages.length): string {
  const hash = createHash('sha256')
  for (const message of messages.slice(0, count)) hash.update(messageFingerprint(message)).update('\0')
  return hash.digest('hex')
}

export function prefixMatches(messages: readonly RequestMessage[], sentCount: number, sentHash: string): boolean {
  return Number.isSafeInteger(sentCount) && sentCount >= 0 && sentCount <= messages.length
    && prefixHash(messages, sentCount) === sentHash
}

export function outputHash(blocks: readonly ContentBlock[]): string {
  return createHash('sha256').update(stableJson(blocks)).digest('hex')
}

export function outputMatches(fresh: readonly RequestMessage[], expected: string | undefined): boolean {
  if (expected === undefined) return false
  const blocks: ContentBlock[] = []
  let inputSeen = false
  for (const message of fresh) {
    if (message.role === 'assistant') {
      if (inputSeen) return false
      blocks.push(...message.content)
    } else {
      inputSeen = true
    }
  }
  return outputHash(blocks) === expected
}

export function looksLikeInterruptedTurn(fresh: readonly RequestMessage[], expected: string | undefined): boolean {
  if (expected === undefined) return false
  return fresh.some((message) => message.role === 'assistant')
}

export function incrementalMessages(
  messages: readonly RequestMessage[],
  sentCount: number,
  options?: { skipToolResults?: boolean },
): RequestMessage[] {
  const skipTools = options?.skipToolResults === true
  const seen = new Set<string>()
  for (const message of messages.slice(0, sentCount)) {
    const id = messageId(message)
    if (id !== '') seen.add(id)
  }
  const result: RequestMessage[] = []
  for (const [index, message] of messages.entries()) {
    if (index < sentCount) continue
    if (message.role === 'assistant') continue
    if (skipTools && message.role === 'tool') continue
    const id = messageId(message)
    if (id !== '' && seen.has(id)) continue
    if (id !== '') seen.add(id)
    result.push(message)
  }
  const latestUser = result.findLastIndex((message) =>
    message.role === 'user' && (messageSourceKind(message) === undefined || messageSourceKind(message) === 'user'),
  )
  if (latestUser >= 0 && latestUser < result.length - 1) result.push(...result.splice(latestUser, 1))
  return result
}

/* ── 工具续轮完整性状态 ────────────────────────────────────────────── */

interface HistoryEntry {
  id: string
  value: string
}

export class ContinuationState {
  readonly #route: string
  readonly #history: HistoryEntry[]
  readonly #knownIds: Set<string>
  readonly #emitted: ContentBlock[] = []

  constructor(options: GenerateOptions) {
    // 与会话复用共享同一个路由指纹（不含 tools），确保回合中途动态注入工具不打断续轮。
    this.#route = routeFingerprint(options)
    this.#history = options.messages.map((message) => ({
      id: messageId(message),
      value: stableJson(messageValue(message)),
    }))
    this.#knownIds = new Set(this.#history.map((entry) => entry.id))
  }

  emitted(block: ContentBlock): void {
    this.#emitted.push(structuredClone(block))
  }

  isHostContext(message: RequestMessage): boolean {
    if (message.role !== 'user') return false
    if (messageSourceKind(message) === 'user') return false
    return !this.#knownIds.has(messageId(message))
  }

  trimTrailingHostContext(messages: readonly RequestMessage[]): readonly RequestMessage[] {
    let end = messages.length
    while (end > 0 && this.isHostContext(messages[end - 1]!)) end -= 1
    return end === messages.length ? messages : messages.slice(0, end)
  }

  accepts(options: GenerateOptions, resultCount: number): boolean {
    if (routeFingerprint(options) !== this.#route) return false
    const current = this.trimTrailingHostContext(options.messages)
    const prefix = current.slice(0, -resultCount)
    if (prefix.length < this.#history.length) return false
    for (const [index, entry] of this.#history.entries()) {
      const message = prefix[index]
      if (message === undefined) return false
      if (messageId(message) !== entry.id) return false
      if (stableJson(messageValue(message)) !== entry.value) return false
    }
    const appended = prefix.slice(this.#history.length).filter((message) => !this.isHostContext(message))
    if (appended.some((message) => message.role !== 'assistant')) return false
    return stableJson(appended.flatMap((message) => [...message.content])) === stableJson(this.#emitted)
  }
}
