import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'

/** 读消息的 `source.kind`（DSH 注入块的身份标记之一）。 */
export function messageSourceKind(message: RequestMessage): string | undefined {
  const source = (message as { readonly source?: { readonly kind?: unknown } }).source
  return source && typeof source.kind === 'string' ? source.kind : undefined
}

/** 读消息的 `source.form`（注入块的形态：snapshot / catalog / instructions / recall）。 */
export function messageSourceForm(message: RequestMessage): string | undefined {
  const source = (message as { readonly source?: { readonly form?: unknown } }).source
  return source && typeof source.form === 'string' ? source.form : undefined
}

/**
 * 这条消息是否为 DSH 注入的上下文块，而不是对话内容本身。
 *
 * 注入块由宿主的 pre-step 在**请求生成时**追加（`time-context` 按 600s 墙钟
 * 到期、`runtime-context` 随服务变化、技能目录与工作区指令随快照刷新），因此
 * 它们可以出现在任意两条真实消息之间，位置与数量都不由模型决定。
 *
 * 真实用户输入（`kind: 'user'` 或无 source）、压缩检查点与模型选择记录**不是**
 * 注入块：它们参与历史前缀比较。未知来源同样保守按真实消息处理。
 */
export function isInjectedContext(message: RequestMessage): boolean {
  if (message.role !== 'user') return false
  const kind = messageSourceKind(message)
  if (!kind || kind === 'user' || kind === 'compact-checkpoint' || kind === 'model-selection') return false
  const form = messageSourceForm(message)
  return ['snapshot', 'catalog', 'instructions', 'recall'].includes(form ?? '')
}

/** Only model-visible values participate; durable message IDs are not prompt content. */
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

/** A continuation must be the exact request plus the assistant blocks we emitted and new tool results. */
export class ContinuationState {
  readonly #configuration: string
  readonly #history: string[]
  readonly #emitted: ContentBlock[] = []

  constructor(options: GenerateOptions) {
    this.#configuration = configuration(options)
    this.#history = options.messages.map((message) => stable(messageValue(message)))
  }

  emitted(block: ContentBlock): void { this.#emitted.push(structuredClone(block)) }

  accepts(options: GenerateOptions, resultCount: number): boolean {
    if (configuration(options) !== this.#configuration) return false
    // 注入块不参与前缀比较：它们由宿主在请求生成时追加，既不是已发送历史的一部分，
    // 也不是本轮模型产出的 assistant 块。剔除后剩下的必须仍是「原历史的纯追加 +
    // 我们实际交付的 assistant 块 + 尾部 resultCount 条工具结果」。
    const prefix = withoutInjections(options.messages).slice(0, -resultCount)
    if (prefix.length < this.#history.length) return false
    if (!this.#history.every((value, index) => value === stable(messageValue(prefix[index]!)))) return false
    const appended = prefix.slice(this.#history.length)
    if (appended.some((message) => message.role !== 'assistant')) return false
    return stable(appended.flatMap((message) => [...message.content])) === stable(this.#emitted)
  }
}

/**
 * 剔除非尾部之外的注入块，只为前缀比较服务。
 *
 * 只剔除 `isInjectedContext` 认定的块；真实用户消息、assistant 输出与工具结果
 * 原样保留。返回值是新数组，不修改调用方历史。
 */
export function withoutInjections(messages: readonly RequestMessage[]): RequestMessage[] {
  return messages.filter((message) => !isInjectedContext(message))
}
