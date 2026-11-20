import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestMessage, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { looksLikeInterruptedTurn, outputHash, prefixHash, prefixMatches } from '../src/adapter/session-reuse.js'

const call: ToolCallBlock = { type: 'tool-call', id: ToolCallId('c1'), name: 'read', arguments: '{}' }

function user(text: string): RequestMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}
function answer(text: string): RequestMessage {
  return createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'p', model: 'm' } })
}

describe('恢复路径只对真正不可恢复的情况失败', () => {
  it('前缀没变 + 输出对不上 → 判为中断遗留（不报错）', () => {
    const sent = [user('Q1'), answer('A1')]
    const hash = prefixHash(sent)
    const now = [...sent, answer('A2（上一轮没记完的输出）'), user('Q2')]
    // 前缀仍然一致 → 不是历史被改写。
    expect(prefixMatches(now, sent.length, hash)).toBe(true)
    expect(looksLikeInterruptedTurn(now.slice(sent.length), outputHash([{ type: 'text', text: 'A1' }]))).toBe(true)
  })

  it('前缀真的变了 → 由前缀校验拦下，走「按新会话开始」而非报错', () => {
    const sent = [user('Q1'), answer('A1')]
    const hash = prefixHash(sent)
    // 压缩检查点会替换早期历史，前缀不再匹配。
    expect(prefixMatches([user('压缩后的摘要')], sent.length, hash)).toBe(false)
  })

  it('工具结果在尾部时不影响前缀判定', () => {
    const sent = [user('Q1'), answer('A1')]
    const hash = prefixHash(sent)
    const now = [...sent,
      createAssistantMessage({ content: [call], source: { provider: 'p', model: 'm' } }),
      createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'r' }], isError: false }),
    ]
    expect(prefixMatches(now, sent.length, hash)).toBe(true)
  })
})
