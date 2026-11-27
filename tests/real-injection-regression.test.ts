/**
 * 真机回归：`time-context` 注入落在工具循环中途**不得**让本轮失败。
 *
 * 历史背景：0.2.1 在续轮判定里只看 `messages` 尾部是否连续 tool 结果。DSH 的
 * pre-step 会把 time-context 注入追加到请求最后一条，于是尾部变成注入块、
 * `trailingToolResults()` 返回空数组、续轮假失败 → abandonTurn 丢弃 ACP 会话
 * → 整轮报 AGY_SESSION_UNRECOVERABLE（真机复现于 2026-11-18 19:20 的会话）。
 *
 * 本用例锁住修复后的行为：注入块被识别为上下文，既不破坏续轮判定，也不被
 * 当成模型输出。用例必须先跑 `AGY_REAL_ACP=1` 才执行。
 *
 * 前提：`AGY_REAL_ACP=1`（会 spawn 真 `agy acp`、消耗账号额度）。
 *
 * 场景对应 2026-11-18 19:20 的真实会话（session-c24eb895）：
 *   第 1 轮让 hydrogen 调工具 → 工具续轮建立可复用的 ACP 会话；
 *   第 2 轮再次进入工具循环，在**回喂工具结果的那次请求**尾部多带一条
 *   `source.kind = 'time-context'` 的注入块（dsh-time-context 默认 600s 到期的产物）。
 *
 * 两个用例各自独立开 adapter + sessionId，互不污染：
 *   - 对照组：尾部是纯 tool 结果 → 续轮正常，会话被复用；
 *   - 注入组：尾部额外挂一条 time-context → 必须与对照组同样正常收尾
 *     （修复前这里会 AGY_SESSION_UNRECOVERABLE，并把会话映射删掉）。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock, GenerateOptions, RequestMessage, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { createRealAdapter, type RealAdapter } from './helpers/real-adapter.js'

const ENABLED = process.env.AGY_REAL_ACP === '1'
const MODEL = process.env.AGY_REAL_MODEL ?? 'gemini-4-hydrogen'
const CWD = '/tmp'

const ECHO_TOOL: ToolSchema = {
  name: 'echo_probe',
  description: '回显传入的 text。本会话里这是唯一可用的工具。',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: '要回显的文本' } },
    required: ['text'],
  },
}

const instances: RealAdapter[] = []
async function adapterFor(): Promise<RealAdapter> {
  const created = await createRealAdapter({
    cwd: CWD,
    parkSettleMs: 400,
    promptTimeoutMs: 180_000,
  })
  instances.push(created)
  return created
}
afterAll(async () => { for (const item of instances) await item.dispose() })

interface Drained {
  blocks: ContentBlock[]
  finish: Extract<StreamChunk, { type: 'finish' }>['reason'] | undefined
  error?: string
}

/** 消费一次 stream，收集块与最终 finish（错误也收进来，方便断言）。 */
async function drain(stream: AsyncIterable<StreamChunk>): Promise<Drained> {
  const blocks: ContentBlock[] = []
  let finish: Drained['finish']
  let error: string | undefined
  try {
    for await (const chunk of stream) {
      if (chunk.type === 'block-end') blocks.push(chunk.block)
      if (chunk.type === 'finish') finish = chunk.reason
    }
  } catch (thrown) {
    error = thrown instanceof Error
      ? `${(thrown as { code?: string }).code ?? ''} ${thrown.message}`.trim()
      : String(thrown)
  }
  return { blocks, finish, error }
}

function toolCallOf(blocks: readonly ContentBlock[]): { id: string; name: string } | undefined {
  for (const block of blocks) {
    if (block.type === 'tool-call') return { id: String(block.id), name: block.name }
  }
  return undefined
}

function failureCode(result: Drained): string {
  if (result.finish?.kind === 'error') return result.finish.failure.code ?? result.finish.failure.message
  return result.error ?? ''
}

/** 与 dsh-time-context 完全一致的注入块形状。 */
function timeContext(text: string): RequestMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'time-context', form: 'snapshot', sections: [{ name: 'time-context', text }] },
  } as never) as RequestMessage
}

function userTurn(text: string): RequestMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function assistantTurn(base: GenerateOptions, blocks: readonly ContentBlock[]): RequestMessage {
  return createAssistantMessage({ content: [...blocks], source: { provider: base.provider, model: base.model } })
}

function toolResultOf(callId: string, text: string): RequestMessage {
  return createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text }], isError: false })
}

/** 把一轮跑到模型不再要求工具为止；返回最终 messages 与每次续轮的 finish 轨迹。 */
async function runToolLoop(
  target: RealAdapter,
  base: GenerateOptions,
  messages: RequestMessage[],
  maxBatches = 4,
): Promise<{ messages: RequestMessage[]; finishes: string[] }> {
  const finishes: string[] = []
  const history = [...messages]
  for (let round = 0; round < maxBatches; round += 1) {
    const result = await drain(target.adapter.stream({ ...base, messages: history }))
    finishes.push(result.finish?.kind === 'error' ? `error:${failureCode(result)}` : (result.finish?.kind ?? 'none'))
    if (result.finish?.kind === 'error' || result.finish?.kind === 'aborted') return { messages: history, finishes }
    const call = toolCallOf(result.blocks)
    if (result.finish?.kind !== 'tool-calls' || !call) {
      // 收尾（stop）或模型没有再要工具：把本轮输出并入历史后结束。
      if (result.blocks.length > 0) history.push(assistantTurn(base, result.blocks))
      return { messages: history, finishes }
    }
    history.push(assistantTurn(base, result.blocks), toolResultOf(call.id, 'pong:ping'))
  }
  return { messages: history, finishes }
}

/** 第 1 轮：让 hydrogen 真的调用一次工具并收尾，建立可复用的 ACP 会话。 */
async function establishSession(target: RealAdapter, base: GenerateOptions): Promise<RequestMessage[]> {
  const first = userTurn('请调用 echo_probe 工具，把 text 设为 "ping"。只做这一步，不要解释。')
  const loop = await runToolLoop(target, base, [first])
  expect(loop.finishes.some((kind) => kind === 'tool-calls'), `模型未调用工具：${loop.finishes.join(',')}`).toBe(true)
  return loop.messages
}

/** 第 2 轮：用户提出新问题，模型再次调用工具 → 进入续轮的临界点。 */
async function prepareSecondToolCall(
  target: RealAdapter,
  base: GenerateOptions,
  history: readonly RequestMessage[],
): Promise<{ history: RequestMessage[]; blocks: ContentBlock[]; call: { id: string }; finish: Drained['finish'] }> {
  const ask = userTurn('请再调用一次 echo_probe 工具，把 text 设为 "ping2"。只做这一步，不要解释。')
  const messages = [...history, ask]
  const result = await drain(target.adapter.stream({ ...base, messages }))
  const call = toolCallOf(result.blocks)
  return { history: messages, blocks: result.blocks, call: call ?? { id: '' }, finish: result.finish }
}

/** DSH 的 sessionId 是编译期 brand：真机路径必须带它，否则插件走「缺少会话键」分支。 */
function sessionIdOf(value: string): NonNullable<GenerateOptions['sessionId']> {
  return brandString(value as NonNullable<GenerateOptions['sessionId']>)
}

const baseOptions = (): GenerateOptions => ({
  provider: 'antigravity-acp',
  model: MODEL,
  reasoningEffort: 'low' as never,
  tools: [ECHO_TOOL],
  messages: [],
})

describe.skipIf(!ENABLED)('真机回归：工具循环中途的 time-context 注入', () => {
  it('对照组：尾部是纯工具结果时，续轮正常并复用同一 ACP 会话', async () => {
    const target = await adapterFor()
    await target.adapter.prepareCall('antigravity-acp', MODEL)
    const base: GenerateOptions = { ...baseOptions(), sessionId: sessionIdOf('session-real-control') }

    const history = await establishSession(target, base)
    const second = await prepareSecondToolCall(target, base, history)
    expect(second.finish?.kind, `第二轮没有进入工具循环：${JSON.stringify(second.finish)}`).toBe('tool-calls')

    const resumed = await drain(target.adapter.stream({
      ...base,
      messages: [
        ...second.history,
        assistantTurn(base, second.blocks),
        toolResultOf(second.call.id, 'pong:ping2'),
      ],
    }))
    const logs = target.logs.map((line) => line.message).join('\n')
    // eslint-disable-next-line no-console
    console.log('\n[对照组] 续轮 finish =', JSON.stringify(resumed.finish), 'error =', resumed.error ?? '-')
    expect(failureCode(resumed)).not.toContain('AGY_SESSION_UNRECOVERABLE')
    expect(logs).not.toContain('将新建会话并重放当前历史')
    expect(logs).toContain('reused=true')
  }, 900_000)

  it('注入组：尾部多一条 time-context → 仍然正常续轮（回归锁）', async () => {
    const target = await adapterFor()
    await target.adapter.prepareCall('antigravity-acp', MODEL)
    const base: GenerateOptions = { ...baseOptions(), sessionId: sessionIdOf('session-real-injected') }

    const history = await establishSession(target, base)
    const second = await prepareSecondToolCall(target, base, history)
    expect(second.finish?.kind, `第二轮没有进入工具循环：${JSON.stringify(second.finish)}`).toBe('tool-calls')

    // 与 DSH 的 pre-step 完全一致：注入块追加在请求 messages 的**最后一条**。
    const injected = timeContext(
      'Time sampled while preparing turn 2, step 10: 2026-11-18T19:20:20+08:00[Asia/Shanghai]\n'
      + 'Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.\n'
      + 'Elapsed since the preceding step context: 10m 0s.',
    )
    const broken = await drain(target.adapter.stream({
      ...base,
      messages: [
        ...second.history,
        assistantTurn(base, second.blocks),
        toolResultOf(second.call.id, 'pong:ping2'),
        injected,
      ],
    }))

    const logs = target.logs.map((line) => line.message).join('\n')
    // eslint-disable-next-line no-console
    console.log('\n[注入组] finish =', JSON.stringify(broken.finish), 'error =', broken.error ?? '-')
    // eslint-disable-next-line no-console
    console.log('[注入组] 完整 adapter 日志：\n' + logs)

    // 关键修复点：注入块不再让续轮假失败。
    expect(failureCode(broken)).not.toContain('AGY_SESSION_UNRECOVERABLE')
    expect(broken.finish?.kind, '注入组应正常收尾').toBe('stop')
    expect(logs).not.toContain('将新建会话并重放当前历史')
    // 第二轮仍复用了同一条 ACP 会话，没有被重置或报废。
    expect(logs).toContain('reused=true')
  }, 900_000)
})
