/** ACP 会话的输入前缀、已交付输出与上下文去重。DSH 始终是历史权威。 */
import { createHash } from 'node:crypto'
import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import { isInjectedContext, messageSourceForm, messageSourceKind, messageValue, stable } from './continuation-state.js'

export function reusableSessionKey(options: Pick<GenerateOptions, 'sessionId' | 'purpose'>): string | undefined {
  if (options.purpose !== undefined || !options.sessionId) return undefined
  return `${options.sessionId}::chat`
}

// 注入块判定是会话复用与续轮校验的共同前提，实现集中在 continuation-state.ts，
// 这里只做再导出，避免两处判定漂移。
export { isInjectedContext, messageSourceForm, messageSourceKind }

/** assistant 只有通过 outputMatches 验证后才可跳过；context form 本身不是丢弃依据。 */
export function shouldSendIncrement(message: RequestMessage): boolean {
  return message.role !== 'assistant'
}

/**
 * 上下文去重用的键：由 `source.kind` 与 `source.form` 共同确定。
 *
 * 这里**刻意比 `isInjectedContext()` 更窄**：只对确定「重复发送无信息量损失」的
 * 快照 / 目录 / 指令 / 召回材料去重。`notice` 类（`tool-jobs`、`plan-mode` 等）
 * 虽然也算注入，但每条都是一次真实事件通知——去重会让模型漏看「后台任务已完成」，
 * 省下的 token 换不来这个风险，因此每次都发送。
 *
 * 带图片的消息同样永不去重：`ptc-mode` 这类来源既可能是宿主通知，也可能装着
 * 用户真实上传的图片引用；内容里一旦有非文本块，就按用户内容对待。
 */
function contextKey(message: RequestMessage): string | undefined {
  if (!isInjectedContext(message)) return undefined
  if (message.content.some((block) => block.type !== 'text')) return undefined
  const form = messageSourceForm(message)
  if (!['snapshot', 'catalog', 'instructions', 'recall'].includes(form ?? '')) return undefined
  return stable([messageSourceKind(message), form])
}

/**
 * 只省略确实已经发送的相同上下文。快照/目录跟踪最近版本，A→B→A 仍须发送 A；
 * 指令也可能撤回/恢复旧版本，未知文件身份时保守按最近版本判断；仅召回材料按完整内容去重。
 */
export function incrementalMessages(messages: readonly RequestMessage[], sentCount: number): RequestMessage[] {
  const latest = new Map<string, string>()
  const seen = new Set<string>()
  const result: RequestMessage[] = []
  for (const [index, message] of messages.entries()) {
    const key = contextKey(message)
    let duplicate = false
    if (key !== undefined) {
      const fingerprint = messageFingerprint(message)
      const stateful = messageSourceForm(message) !== 'recall'
      duplicate = stateful ? latest.get(key) === fingerprint : seen.has(`${key}\0${fingerprint}`)
      latest.set(key, fingerprint)
      seen.add(`${key}\0${fingerprint}`)
    }
    if (index >= sentCount && shouldSendIncrement(message) && !duplicate) result.push(message)
  }
  // 当前用户请求最后强调；其余新增消息的相对顺序保持不变。
  const latestUser = result.findLastIndex(message => message.role === 'user'
    && (messageSourceKind(message) === undefined || messageSourceKind(message) === 'user'))
  if (latestUser >= 0 && latestUser < result.length - 1) result.push(...result.splice(latestUser, 1))
  return result
}

export function messageFingerprint(message: RequestMessage): string {
  return stable(messageValue(message))
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
