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
 * 这条消息是否为 DSH 在请求生成时注入的上下文/通知块，而不是对话内容本身。
 *
 * 判定按 `source.form` 做**白名单之外的枚举**是错的：DSH 的 form 取值随版本与
 * 插件增长，实测至少还有 `notice`（`tool-jobs` / `model-selection` / `plan-mode`
 * / `ptc-mode` 等，单机历史里 143 条）。漏掉一种，那条消息就会被当成「历史被
 * 改写」，让整轮报 `AGY_SESSION_UNRECOVERABLE`。
 *
 * 因此这里改为**认定「注入」而不是认定「正常」**：只要消息带 `source`、不是
 * 真实用户输入，就按注入处理。真实用户输入的唯一可靠标志是 `kind: 'user'`
 * （无论有无 `rpcId`）。
 *
 * 刻意**不**按 kind 做黑名单：`ptc-mode` 里既可能是宿主通知，也可能装着用户
 * 真实上传的图片引用——按 kind 一刀切会把用户内容误当噪声丢掉。
 *
 * 参与前缀比较的真实消息：无 `source` 的裸消息、`kind: 'user'`、压缩检查点
 * （它是历史的一部分，位置与内容都由宿主确定但语义上取代了早期历史）。
 */
export function isInjectedContext(message: RequestMessage): boolean {
  if (message.role !== 'user') return false
  const source = (message as { readonly source?: { readonly kind?: unknown } }).source
  // 没有 source：adapter 反序列化出的裸消息，按真实内容处理。
  if (source === undefined || typeof source !== 'object') return false
  const kind = (source as { readonly kind?: unknown }).kind
  if (typeof kind !== 'string') return false
  // 真实用户输入。
  if (kind === 'user') return false
  // 压缩检查点虽由宿主生成，但它是早期历史的替身：必须参与前缀比较，否则
  // 压缩前后的历史会被当成「同一份」。
  if (kind === 'compact-checkpoint') return false
  return true
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
    // 与 accepts() 用同一套剔除规则：构造时也要把注入块去掉。
    // 只改 accepts 一侧会让两个序列长度不等，索引整体错位——首轮请求里只要
    // 有一条 time-context，之后每次工具续轮都会失败（真机 2026-11-19 09:10 复现）。
    this.#history = withoutInjections(options.messages).map((message) => stable(messageValue(message)))
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
