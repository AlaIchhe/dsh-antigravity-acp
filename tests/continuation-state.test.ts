import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestMessage, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { ContinuationState, isInjectedContext } from '../src/adapter/continuation-state.js'

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

describe('注入块剔除必须两侧对称', () => {
  function injected(text: string): RequestMessage {
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'time-context', form: 'snapshot', sections: [{ name: 'time-context', text }] },
    } as never) as RequestMessage
  }

  it('构造时历史里已有注入块 → 仍能续轮（2026-11-19 真机回归）', () => {
    // 真机首轮请求就带 time-context；若构造侧不剔除，history 比 prefix 多一条，
    // 索引错位导致每次工具续轮都失败。
    const base: GenerateOptions = {
      ...initial(),
      messages: [
        ...initial().messages,
        injected('Time sampled while preparing turn 1, step 1: ...'),
      ],
    }
    const state = new ContinuationState(base)
    state.emitted(call)
    const next: GenerateOptions = { ...base, messages: [
      ...base.messages,
      createAssistantMessage({ content: [call], source: { provider: base.provider, model: base.model } }),
      createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'result' }], isError: false }),
    ] }
    expect(state.accepts(next, 1)).toBe(true)
  })

  it('两侧都剔除后，真实内容变化仍被拒绝', () => {
    const base: GenerateOptions = {
      ...initial(),
      messages: [...initial().messages, injected('快照 A')],
    }
    const state = new ContinuationState(base)
    state.emitted(call)
    // 把真实用户消息改掉（注入块之外的内容）必须仍然拒绝。
    const next: GenerateOptions = { ...base, messages: [
      createUserMessage({ content: [{ type: 'text', text: '改过的输入' }], source: { kind: 'user' } }),
      injected('快照 A'),
      createAssistantMessage({ content: [call], source: { provider: base.provider, model: base.model } }),
      createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'result' }], isError: false }),
    ] }
    expect(state.accepts(next, 1)).toBe(false)
  })
})

describe('注入块判定按来源，不按 form 白名单', () => {
  /** 真实历史里出现过的 form 取值（含白名单之外）。 */
  const shapes: Array<[string, string | undefined, boolean]> = [
    ['time-context', 'snapshot', true],
    ['runtime-context', 'snapshot', true],
    ['skill-catalog', 'catalog', true],
    ['agent-instructions', 'instructions', true],
    ['tool-jobs', 'notice', true],
    ['model-selection', 'notice', true],
    ['plan-mode', 'notice', true],
    ['goal', undefined, true],
    ['schedule', undefined, true],
    ['working-directory', undefined, true],
    ['user', undefined, false],
    ['compact-checkpoint', undefined, false],
  ]

  it.each(shapes)('kind=%s form=%s → 注入=%s', (kind, form, expected) => {
    const message = createUserMessage({
      content: [{ type: 'text', text: 'x' }],
      source: form === undefined ? { kind } : { kind, form },
    } as never) as RequestMessage
    expect(isInjectedContext(message)).toBe(expected)
  })

  it('无 source 的裸消息与 assistant/tool 都不算注入', () => {
    expect(isInjectedContext(createUserMessage({ content: [{ type: 'text', text: 'hi' }] } as never) as RequestMessage)).toBe(false)
    expect(isInjectedContext(createAssistantMessage({
      content: [{ type: 'text', text: 'a' }], source: { provider: 'p', model: 'm' },
    }))).toBe(false)
  })

  it('tool-jobs 出现在尾部时续轮仍成立（2026-11-19 12:30 真机回归）', () => {
    const base = initial()
    const notice = createUserMessage({
      content: [{ type: 'text', text: 'background job pty-send-123 finished. Read its output with job_output.' }],
      source: { kind: 'tool-jobs', form: 'notice' },
    } as never) as RequestMessage
    const state = new ContinuationState(base)
    state.emitted(call)
    const next: GenerateOptions = { ...base, messages: [
      ...base.messages,
      createAssistantMessage({ content: [call], source: { provider: base.provider, model: base.model } }),
      createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'r' }], isError: false }),
      notice,
    ] }
    expect(state.accepts(next, 1)).toBe(true)
  })
})
