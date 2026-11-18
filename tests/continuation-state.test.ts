import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestMessage, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { ContinuationState } from '../src/adapter/continuation-state.js'

const call: ToolCallBlock = { type: 'tool-call', id: ToolCallId('call-1'), name: 'read', arguments: '{"path":"a"}' }
function initial(): GenerateOptions {
  return {
    provider: 'antigravity-acp', model: 'gemini', system: 'obey policy',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'read a' }], source: { kind: 'user' } })],
    tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  }
}
function continuation(base: GenerateOptions): GenerateOptions {
  return { ...base, messages: [
    ...base.messages,
    createAssistantMessage({ content: [call], source: { provider: base.provider, model: base.model } }),
    createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'result' }], isError: false }),
  ] }
}

describe('continuation request integrity', () => {
  it('accepts unchanged context plus exactly the emitted blocks and tool results', () => {
    const base = initial()
    const state = new ContinuationState(base)
    state.emitted(call)
    expect(state.accepts(continuation(base), 1)).toBe(true)
  })
  it.each(['model', 'reasoning', 'system', 'history', 'inserted-system', 'schema', 'assistant'] as const)('rejects changed %s', (kind) => {
    const base = initial()
    const state = new ContinuationState(base)
    state.emitted(call)
    const next = continuation(base)
    if (kind === 'model') next.model = 'other'
    if (kind === 'reasoning') next.reasoningEffort = ReasoningEffortId('high')
    if (kind === 'system') next.system = 'new policy'
    if (kind === 'history') next.messages[0] = createUserMessage({ content: [{ type: 'text', text: 'changed' }], source: { kind: 'user' } })
    if (kind === 'inserted-system') next.messages.splice(1, 0, createSystemMessage('new policy'))
    if (kind === 'schema') next.tools = [{ ...next.tools![0]!, parameters: { type: 'object' } }]
    if (kind === 'assistant') next.messages[1] = createAssistantMessage({ content: [{ ...call, arguments: '{"path":"other"}' }], source: { provider: base.provider, model: base.model } })
    expect(state.accepts(next, 1)).toBe(false)
  })
  it('rejects edits to previously delivered tool results during later batches', () => {
    const base = continuation(initial())
    const state = new ContinuationState(base)
    state.emitted(call)
    const next = continuation(base)
    next.messages[2] = createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'rewritten' }], isError: false })
    expect(state.accepts(next, 1)).toBe(false)
  })
})

describe('注入块不参与续轮前缀比较', () => {
  function injected(text: string): RequestMessage {
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'time-context', form: 'snapshot', sections: [{ name: 'time-context', text }] },
    } as never) as RequestMessage
  }

  it('尾部注入块仍可续轮（真机 AGY_SESSION_UNRECOVERABLE 的离线锁）', () => {
    const base = initial()
    const state = new ContinuationState(base)
    state.emitted(call)
    const next = continuation(base)
    // 注入块落在工具结果之后：DSH pre-step 的真实位置。
    next.messages = [...next.messages, injected('Time sampled while preparing turn 2, step 10: ...')]
    // resultCount 只数尾部真实 tool 结果，不看被注入块挡住的那些。
    expect(state.accepts(next, 1)).toBe(true)
  })

  it('历史中间的注入块同样不破坏前缀', () => {
    const base = initial()
    const state = new ContinuationState(base)
    state.emitted(call)
    const next = continuation(base)
    next.messages = [
      next.messages[0]!,
      injected('中间快照'),
      ...next.messages.slice(1),
    ]
    expect(state.accepts(next, 1)).toBe(true)
  })

  it('真实用户消息仍然破坏前缀（注入豁免不能变成任意篡改）', () => {
    const base = initial()
    const state = new ContinuationState(base)
    state.emitted(call)
    const next = continuation(base)
    next.messages = [
      ...next.messages,
      createUserMessage({ content: [{ type: 'text', text: '插入的用户消息' }], source: { kind: 'user' } }),
    ]
    expect(state.accepts(next, 1)).toBe(false)
  })

  it('注入块被剔除后不影响「实际交付块」的判定', () => {
    const base = initial()
    const state = new ContinuationState(base)
    state.emitted(call)
    // 把**交付的块**本身换掉必须拒绝：注入豁免不能掩盖真实输出被改。
    const tampered = continuation(base)
    tampered.messages[1] = createAssistantMessage({
      content: [{ ...call, arguments: '{"path":"other"}' }],
      source: { provider: base.provider, model: base.model },
    })
    expect(state.accepts(tampered, 1)).toBe(false)
  })
})
