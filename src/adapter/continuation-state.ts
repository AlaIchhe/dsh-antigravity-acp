import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'

/**
 * 一条消息的稳定身份。
 *
 * DSH 在消息创建时生成一次 `randomUUID()`，写进会话日志，之后每次派生历史都
 * 原样返回同一个对象（`dsh-session/src/surface.ts` 的 `case 'user/message':
 * return event.data`），跨进程重启也不变。
 *
 * 因此**身份由 id 确定，内容由 content 确定**——两者分开比较，就不需要再猜
 * 「这条消息是模型输出还是宿主注入」。
 */
export function messageId(message: RequestMessage): string {
  const id = (message as { readonly id?: unknown }).id
  return typeof id === 'string' ? id : ''
}

/** 读消息的 `source.kind`；无 source 时返回 undefined。 */
export function messageSourceKind(message: RequestMessage): string | undefined {
  const source = (message as { readonly source?: { readonly kind?: unknown } }).source
  return source && typeof source.kind === 'string' ? source.kind : undefined
}

/** Only model-visible values participate here; identity is compared separately by id. */
export function messageValue(message: RequestMessage): unknown {
  return message.role === 'tool'
    ? { role: message.role, content: message.content, toolCallId: message.toolCallId, isError: message.isError === true }
    : { role: message.role, content: message.content }
}

/** Deterministic JSON: object keys sorted, so fingerprints survive property order. */
export function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
  })
}

function configuration(options: GenerateOptions): string {
  return stable({
    provider: options.provider, model: options.model, effort: options.reasoningEffort?.toString(),
    system: options.system ?? '',
    tools: [...(options.tools ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
  })
}

interface HistoryEntry {
  id: string
  value: string
}

/**
 * 续轮完整性：历史必须是「我们实际发出去的那份」的纯追加。
 *
 * 判定不再依赖消息来源分类，只依赖两条硬事实：
 *
 * 1. **id**：已经发出去的消息带着确定的 id，之后每次请求都会原样出现；
 * 2. **id 是否见过**：一条 `user` 角色、id 又不在已发送集合里的消息，只可能是
 *    宿主要在请求生成时追加的上下文（`time-context`、`runtime-context`、
 *    技能目录、后台任务通知……）。这类消息的位置与数量都不由模型决定，
 *    因此既不参与前缀比较，也不阻挡续轮。
 *
 * 这样就不需要枚举 DSH 的来源类型——新增任何来源都会自动落入「id 没见过」
 * 这一条，不需要改代码。
 */
export class ContinuationState {
  readonly #configuration: string
  readonly #history: HistoryEntry[]
  readonly #knownIds: Set<string>
  readonly #emitted: ContentBlock[] = []

  constructor(options: GenerateOptions) {
    this.#configuration = configuration(options)
    this.#history = options.messages.map((message) => ({
      id: messageId(message),
      value: stable(messageValue(message)),
    }))
    this.#knownIds = new Set(this.#history.map((entry) => entry.id))
  }

  emitted(block: ContentBlock): void { this.#emitted.push(structuredClone(block)) }

  /**
   * 这条消息是否是宿主在请求生成时追加的上下文。
   *
   * 两个条件必须同时成立：
   * 1. **id 从未发出去过**——已发送的消息无论被重建多少次 id 都不变，所以
   *    「没见过」才可能是新增内容；
   * 2. **来源不是真实用户输入**——`source.kind === 'user'` 是 DSH 对真实用户
   *    消息的明确标记。只靠第 1 条会把用户新发的一条消息也当成注入放行。
   *
   * 第 2 条刻意写成「不是 user」，而不是枚举「是哪种注入」：DSH 的注入来源
   * 随版本和插件增长（实测已有 14 种），枚举一定会漏；而 `user` 这个值是
   * 稳定契约，不需要跟着长。
   */
  isHostContext(message: RequestMessage): boolean {
    if (message.role !== 'user') return false
    if (messageSourceKind(message) === 'user') return false
    return !this.#knownIds.has(messageId(message))
  }

  /**
   * 去掉尾部的宿主上下文（注入块总是追加在请求末尾）。
   * @param messages - 本次请求的消息序列。
   * @returns 去掉尾部宿主上下文后的视图。
   */
  trimTrailingHostContext(messages: readonly RequestMessage[]): readonly RequestMessage[] {
    let end = messages.length
    while (end > 0 && this.isHostContext(messages[end - 1]!)) end -= 1
    return end === messages.length ? messages : messages.slice(0, end)
  }

  accepts(options: GenerateOptions, resultCount: number): boolean {
    if (configuration(options) !== this.#configuration) return false
    // 先去掉尾部注入块，再取固定长度的前缀；顺序不能反，否则会把工具结果算丢。
    const current = this.trimTrailingHostContext(options.messages)
    const prefix = current.slice(0, -resultCount)
    if (prefix.length < this.#history.length) return false
    for (const [index, entry] of this.#history.entries()) {
      const message = prefix[index]
      if (message === undefined) return false
      if (messageId(message) !== entry.id) return false
      if (stable(messageValue(message)) !== entry.value) return false
    }
    // 已发送前缀之后、工具结果之前的空隙里可能还夹着新的注入块（工具循环中途
    // 到期的那种）。它们同样按「id 没见过」识别，不参与「只能是 assistant」的判定。
    const appended = prefix.slice(this.#history.length).filter((message) => !this.isHostContext(message))
    if (appended.some((message) => message.role !== 'assistant')) return false
    return stable(appended.flatMap((message) => [...message.content])) === stable(this.#emitted)
  }
}
