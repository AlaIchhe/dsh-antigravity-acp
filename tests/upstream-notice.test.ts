import { describe, expect, it } from 'vitest'
import type { PromptResponse, SessionNotification } from '@agentclientprotocol/sdk'
import type { LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AGY_TURN_ERROR, PromptTurn, describeUpstreamErrorNotice } from '../src/adapter/prompt-turn.js'
import type { PromptTurnOptions } from '../src/adapter/prompt-turn.js'
import type { AgentLink } from '../src/protocol/agent-link.js'
import type { McpToolBridge } from '../src/bridge/mcp-bridge.js'

const NOTICE = '\n⚠ RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).\n'

describe('上游错误被 agent 当正文返回', () => {
  it('只有一条错误通告时识别为失败，并带上状态码原文', () => {
    const message = describeUpstreamErrorNotice(NOTICE, false)
    expect(message).toBeDefined()
    expect(message).toContain('RESOURCE_EXHAUSTED')
    expect(message).toContain('429')
    expect(message).toContain('Resource has been exhausted')
    // 必须提示「可能不是额度」，否则用户只会去等额度恢复。
    expect(message).toContain('不一定是额度')
  })

  it('正文里还有别的文字时不判（那可能是真回复）', () => {
    expect(describeUpstreamErrorNotice(`这里是分析结果。\n${NOTICE}`, false)).toBeUndefined()
    expect(describeUpstreamErrorNotice(`${NOTICE}补充说明`, false)).toBeUndefined()
  })

  it('本轮出现过工具调用时不判', () => {
    expect(describeUpstreamErrorNotice(NOTICE, true)).toBeUndefined()
  })

  it('普通正文与空正文都不判', () => {
    expect(describeUpstreamErrorNotice('ok', false)).toBeUndefined()
    expect(describeUpstreamErrorNotice('', false)).toBeUndefined()
    expect(describeUpstreamErrorNotice('\n  \n', false)).toBeUndefined()
  })

  it('过长原文被截断，避免把整个错误体塞进回合错误', () => {
    const long = `\n⚠ INTERNAL (code 500): ${'x'.repeat(400)}\n`
    const message = describeUpstreamErrorNotice(long, false)
    expect(message).toBeDefined()
    expect(message!.length).toBeLessThan(400)
    expect(message).toContain('…')
  })

  it('识别其它状态码形态（不是只有 429）', () => {
    const message = describeUpstreamErrorNotice('\n⚠ UNAVAILABLE (code 503): backend down\n', false)
    expect(message).toContain('UNAVAILABLE')
    expect(message).toContain('503')
  })
})

/** 只实现本用例用到的部分：prompt 应答由测试控制。 */
function fakeTurn(): {
  turn: PromptTurn
  settle(response: PromptResponse): void
  feed(text: string): void
  drain(): Promise<StreamChunk[]>
} {
  let settle!: (response: PromptResponse) => void
  const response = new Promise<PromptResponse>((resolve) => { settle = resolve })
  const link = { prompt: () => response } as unknown as AgentLink
  const bridge = {
    hasPending: () => false,
    resetPending: () => undefined,
    invalidateRound: () => undefined,
    hasScope: () => true,
  } as unknown as McpToolBridge
  const options: PromptTurnOptions = {
    link,
    bridge,
    promptTimeoutMs: 5_000,
    parkSettleMs: 5,
    onTerminate: () => undefined,
  }
  const turn = new PromptTurn('s-notice', options)
  const feed = (text: string): void => {
    const notification: SessionNotification = {
      sessionId: 's-notice',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    }
    turn.handleSessionUpdate(notification)
  }
  const drain = async (): Promise<StreamChunk[]> => {
    const chunks: StreamChunk[] = []
    for (;;) {
      const chunk = await turn.nextChunk()
      if (chunk === undefined) return chunks
      chunks.push(chunk)
    }
  }
  return { turn, settle, feed, drain }
}

function finishFailure(chunks: readonly StreamChunk[]): LlmFailure | undefined {
  const finish = chunks.find((chunk) => chunk.type === 'finish')
  if (finish?.type !== 'finish' || finish.reason.kind !== 'error') return undefined
  return finish.reason.failure
}

describe('PromptTurn 的回合收尾', () => {
  it('end_turn + 纯错误通告 → 以 AGY_UPSTREAM_ERROR_NOTICE 收尾，而不是成功', async () => {
    const { turn, settle, feed, drain } = fakeTurn()
    turn.startPrompt([{ type: 'text', text: 'hi' }])
    feed(NOTICE)
    settle({ stopReason: 'end_turn' })
    const failure = finishFailure(await drain())
    expect(failure?.code).toBe(AGY_TURN_ERROR.UPSTREAM_ERROR_NOTICE)
    expect(failure?.message).toContain('429')
  })

  it('end_turn + 正常正文 → 仍然是成功回合', async () => {
    const { turn, settle, feed, drain } = fakeTurn()
    turn.startPrompt([{ type: 'text', text: 'hi' }])
    feed('ultrafast-ok')
    settle({ stopReason: 'end_turn' })
    const chunks = await drain()
    const finish = chunks.find((chunk) => chunk.type === 'finish')
    expect(finish?.type).toBe('finish')
    expect(finish?.type === 'finish' ? finish.reason.kind : undefined).toBe('stop')
  })
})
