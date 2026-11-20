/** ACP 会话的输入前缀、已交付输出与上下文去重。DSH 始终是历史权威。 */
import { createHash } from 'node:crypto'
import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import { messageId, messageSourceKind, messageValue, stable } from './continuation-state.js'

export function reusableSessionKey(options: Pick<GenerateOptions, 'sessionId' | 'purpose'>): string | undefined {
  if (options.purpose !== undefined || !options.sessionId) return undefined
  return `${options.sessionId}::chat`
}

/** assistant 只有通过 outputMatches 验证后才可跳过；其它角色都是要发的增量。 */
export function shouldSendIncrement(message: RequestMessage): boolean {
  return message.role !== 'assistant'
}

/**
 * 只发送确实还没发过的消息。
 *
 * 判据是 **id**，不是内容、也不是来源类型：DSH 给每条消息生成一次稳定的 id
 * 并写进会话日志，派生历史时原样返回。同一条消息无论被重建多少次，id 都不变；
 * 而不同的消息即使文本完全相同，id 也不同——这正是内容去重做不到的。
 *
 * 这样就不需要判断「这条是宿主注入还是用户输入」：注入块只要发过一次，之后
 * 同 id 的重复出现自然被跳过；没见过的 id 一律发送。
 */
export function incrementalMessages(messages: readonly RequestMessage[], sentCount: number): RequestMessage[] {
  const seen = new Set<string>()
  for (const message of messages.slice(0, sentCount)) {
    const id = messageId(message)
    if (id !== '') seen.add(id)
  }
  const result: RequestMessage[] = []
  for (const [index, message] of messages.entries()) {
    if (index < sentCount) continue
    if (!shouldSendIncrement(message)) continue
    const id = messageId(message)
    // 没有 id 的消息无法证明已发送，保守重发。
    if (id !== '' && seen.has(id)) continue
    if (id !== '') seen.add(id)
    result.push(message)
  }
  // 当前用户请求最后强调；其余新增消息的相对顺序保持不变。
  // 必须只认 `source.kind === 'user'` 的真实输入：注入块也是 user 角色，
  // 混进来会把「最新用户请求」定位到注入块上，导致真正的问题被排到前面。
  const latestUser = result.findLastIndex(message => message.role === 'user'
    && (messageSourceKind(message) === undefined || messageSourceKind(message) === 'user'))
  if (latestUser >= 0 && latestUser < result.length - 1) result.push(...result.splice(latestUser, 1))
  return result
}

/** 消息指纹：身份 + 内容。身份用 id，内容用 role/content 的稳定序列化。 */
export function messageFingerprint(message: RequestMessage): string {
  return stable({ id: messageId(message), value: messageValue(message) })
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

/** 存储实际交付的 blocks 指纹，不落盘输出正文。 */
export function outputHash(blocks: readonly ContentBlock[]): string {
  return createHash('sha256').update(stable(blocks)).digest('hex')
}

/** 新历史中的 assistant 必须正好是上一步交付的输出，且位于所有新输入之前。 */
export function outputMatches(fresh: readonly RequestMessage[], expected: string | undefined): boolean {
  if (expected === undefined) return false
  const blocks: ContentBlock[] = []
  let inputSeen = false
  for (const message of fresh) {
    if (message.role === 'assistant') {
      if (inputSeen) return false
      blocks.push(...message.content)
    } else inputSeen = true
  }
  return outputHash(blocks) === expected
}

export function routeFingerprint(
  options: Pick<GenerateOptions, 'provider' | 'model' | 'reasoningEffort' | 'system' | 'tools'>,
  override?: { target?: string; effort?: string },
): string {
  return createHash('sha256').update(stable({
    provider: options.provider, model: options.model, effort: options.reasoningEffort?.toString(),
    // 公开模型 ID 不变时，设置页的官方映射或默认档位仍可能改变实际路由。
    override,
    system: options.system ?? '',
    tools: [...(options.tools ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
  })).digest('hex')
}

/**
 * 上一轮是否**异常中断**（进程被杀、连接断开、网络崩溃），而不是历史被改写。
 *
 * 判据是「已发送前缀完全一致，但前缀之后的 assistant 输出对不上」。这两种情况
 * 在数据上看起来很像，但成因完全不同：
 *
 * - **异常中断**：ACP 会话里其实已经产生了本轮输出，只是插件没来得及把它记进
 *   `sessions.json`（进程在 `#advanceSession` 之前就死了）。前缀本身没动过。
 * - **历史被改写**：用户编辑、回退、压缩检查点替换了早期消息。这时前缀会变。
 *
 * 调用方必须**先**用 `prefixMatches()` 确认前缀没变，再调用本函数；前缀变了
 * 就不该走到这里。满足这个前提时，`outputMatches` 失败只可能是前者。
 *
 * @param fresh - `sentCount` 之后的新增消息。
 * @param expected - 映射里记录的上一轮输出指纹。
 * @returns true 表示「前缀没变、只有输出对不上」，即中断遗留。
 */
export function looksLikeInterruptedTurn(
  fresh: readonly RequestMessage[],
  expected: string | undefined,
): boolean {
  if (expected === undefined) return false
  // 没有 assistant 输出却对不上：说明期望的 hash 不是空输出的 hash，
  // 但新历史里也没有可供交付的输出——更像是被外部追加了非 assistant 内容，
  // 不按中断处理（保守）。
  return fresh.some((message) => message.role === 'assistant')
}
