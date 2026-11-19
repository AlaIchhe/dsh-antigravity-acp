import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, RequestMessage } from '@deepseek-ai/dsh-llm'
import { incrementalMessages, outputHash, outputMatches, prefixHash, prefixMatches } from '../src/adapter/session-reuse.js'

function user(text: string): RequestMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}
function context(text: string, form: string, kind = 'context'): RequestMessage {
  return { ...user(text), source: { kind, form } } as unknown as RequestMessage
}
function answer(text: string): RequestMessage {
  return createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'test', model: 'test' } })
}
const blocks: ContentBlock[] = [{ type: 'text', text: 'A1' }]

describe('会话历史与实际交付输出一致性', () => {
  it('已交付的回答可被跳过；编辑、缺失或额外回答不可跳过', () => {
    expect(outputMatches([answer('A1'), user('Q2')], outputHash(blocks))).toBe(true)
    expect(outputMatches([answer('EDITED'), user('Q2')], outputHash(blocks))).toBe(false)
    expect(outputMatches([user('Q2')], outputHash(blocks))).toBe(false)
    expect(outputMatches([answer('A1'), user('外部问题'), answer('外部回答'), user('Q3')], outputHash(blocks))).toBe(false)
    expect(outputMatches([answer('A1')], undefined)).toBe(false)
  })
  it('空回复只允许没有新增 assistant 的历史', () => {
    expect(outputMatches([user('重试')], outputHash([]))).toBe(true)
    expect(outputMatches([answer('未知输出'), user('重试')], outputHash([]))).toBe(false)
  })
  it('拒绝非法计数与改写前缀', () => {
    const history = [user('Q1')]
    expect(prefixMatches(history, 1, prefixHash(history))).toBe(true)
    for (const count of [-1, 0.5, Infinity, 2]) expect(prefixMatches(history, count, prefixHash(history))).toBe(false)
    expect(prefixMatches([user('改写')], 1, prefixHash(history))).toBe(false)
  })
})

describe('增量按 message id 判定，不按内容或类别', () => {
  it('已发送过的同一条消息（同 id）不再发送', () => {
    const notice = context('后台任务完成', 'notice')
    const q = user('Q')
    // notice 在 sentCount=1 之内，视为已发送。
    expect(incrementalMessages([notice, q], 1)).toEqual([q])
  })

  it('内容相同但 id 不同 → 视为两条新消息都发', () => {
    const a = context('状态', 'snapshot')
    const b = context('状态', 'snapshot')
    expect(a.id).not.toBe(b.id)
    expect(incrementalMessages([a, b], 1)).toEqual([b])
  })

  it('任何类别的新消息都发送，不按 form 丢弃', () => {
    const fresh = [context('通知', 'notice'), context('未知', 'future-form'), user('问题')]
    expect(incrementalMessages([context('旧', 'snapshot'), ...fresh], 1)).toEqual(fresh)
  })

  it('两条内容完全相同的真实用户消息都会发送（id 不同）', () => {
    const first = user('相同问题')
    const second = user('相同问题')
    expect(first.id).not.toBe(second.id)
    expect(incrementalMessages([first, second], 1)).toEqual([second])
  })

  it('assistant 永不作为增量重发', () => {
    const q2 = user('Q2')
    expect(incrementalMessages([user('Q'), answer('A'), q2], 1)).toEqual([q2])
  })

  it('最新用户消息重排到末尾', () => {
    const request = user('当前问题')
    const notice = context('目标变化', 'notice')
    // 两种排列都归一到「注入在前、当前请求在最后」：模型最后看到的必须是用户请求。
    expect(incrementalMessages([user('Q1'), request, notice], 1).map((m) => (m.content[0] as { text: string }).text))
      .toEqual(['目标变化', '当前问题'])
    expect(incrementalMessages([user('Q1'), notice, request], 1).map((m) => (m.content[0] as { text: string }).text))
      .toEqual(['目标变化', '当前问题'])
  })
})
