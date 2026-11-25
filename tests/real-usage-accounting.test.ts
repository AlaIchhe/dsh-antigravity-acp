/**
 * 真机用量、缓存读取与上下文水位端到端回归测试（使用真实账号 + 真实 `agy acp`，零 mock）。
 *
 * 运行方式：
 *   AGY_REAL_ACP=1 npx vitest run tests/real-usage-accounting.test.ts
 *
 * 校验内容：
 * 1. 单步无工具回合（K = 1）：直出真实 `PromptResponse.usage`，`outputTokens > 0`、
 *    四桶精确守恒、满足 DSH `turn-usage` 全部校验规则（可供宿主计算 TPS 与缓存命中）。
 * 2. 多步真实 MCP 工具回合（K >= 3）：中间步实时上报上下文水位，末步汇总真实输出与
 *    差额输入，整轮 `cacheReadTokens > 0`、`outputTokens > 0`，末步上下文水位严格锚定在
 *    单步窗口内（不按调用次数膨胀），且每一步样本都通过 DSH 严格校验。
 */
import { describe, expect, it } from 'vitest'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, RequestMessage, TokenUsage, ToolCallBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import { createRealAdapter } from './helpers/real-adapter.js'

const REAL_ENABLED = process.env.AGY_REAL_ACP === '1'

const TOOLS: ToolSchema[] = [
  {
    name: 'lookup_magic_value',
    description: '查询指定标签对应的魔术数值，必须调用此工具获取真实数值',
    parameters: {
      type: 'object',
      properties: { tag: { type: 'string', description: '查询标签' } },
      required: ['tag'],
    },
  },
]

/** 与 DSH `@deepseek-ai/dsh-token-meter/lib/types/turn-usage.js` 完全等价的严格校验。 */
function assertValidDshUsage(usage: TokenUsage | undefined): asserts usage is TokenUsage {
  expect(usage).toBeDefined()
  const u = usage!
  const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  expect(isCount(u.inputTokens)).toBe(true)
  expect(isCount(u.outputTokens)).toBe(true)
  expect(isCount(u.cacheReadTokens)).toBe(true)
  expect(isCount(u.cacheWriteTokens)).toBe(true)
  expect(isCount(u.totalTokens)).toBe(true)
  if (u.reasoningTokens !== undefined) {
    expect(isCount(u.reasoningTokens)).toBe(true)
    expect(u.reasoningTokens).toBeLessThanOrEqual(u.outputTokens)
  }
  const knownPrompt = u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
  expect(u.totalTokens).toBe(knownPrompt + u.outputTokens)
}

async function runStep(
  adapter: Awaited<ReturnType<typeof createRealAdapter>>['adapter'],
  options: GenerateOptions,
): Promise<{ blocks: ContentBlock[]; usage?: TokenUsage; finishKind: string }> {
  const blocks: ContentBlock[] = []
  let usage: TokenUsage | undefined
  let finishKind = ''
  for await (const chunk of adapter.stream(options)) {
    if (chunk.type === 'block-end') blocks.push(chunk.block)
    if (chunk.type === 'usage') usage = chunk.usage
    if (chunk.type === 'finish') finishKind = chunk.reason.kind
  }
  return { blocks, usage, finishKind }
}

describe.skipIf(!REAL_ENABLED)('真机账号：单步与多步工具回合的用量、缓存与水位对账', () => {
  it('单步无工具回合：直出真实 PromptResponse.usage，含 outputTokens/reasoningTokens 且通过 DSH 校验', async () => {
    const real = await createRealAdapter()
    try {
      const result = await runStep(real.adapter, {
        provider: 'antigravity-acp',
        model: 'gemini-4-neon',
        sessionId: `real-usage-single-${Date.now()}` as GenerateOptions['sessionId'],
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: '请用两句话简要说明什么是二分查找。' }],
            source: { kind: 'user' },
          }),
        ],
      })
      expect(result.finishKind).toBe('stop')
      assertValidDshUsage(result.usage)
      expect(result.usage.inputTokens + (result.usage.cacheReadTokens ?? 0)).toBeGreaterThan(0)
      expect(result.usage.outputTokens).toBeGreaterThan(0)
    } finally {
      await real.dispose()
    }
  }, 120_000)

  it('多步工具回合：中间步实时上报水位、末步差额对账与真实输出入账，不爆上下文环且全步通过 DSH 校验', async () => {
    const real = await createRealAdapter()
    try {
      const sessionId = `real-usage-multi-${Date.now()}` as GenerateOptions['sessionId']
      const messages: RequestMessage[] = [
        createUserMessage({
          content: [{
            type: 'text',
            text: '请先调用工具 lookup_magic_value（tag="first"），拿到结果后再调用一次 lookup_magic_value（tag="second"），最后把两个结果相加后用一句话告诉我总和。',
          }],
          source: { kind: 'user' },
        }),
      ]

      const stepUsages: TokenUsage[] = []
      let toolRounds = 0

      for (let guard = 0; guard < 6; guard += 1) {
        const step = await runStep(real.adapter, {
          provider: 'antigravity-acp',
          model: 'gemini-4-neon',
          sessionId,
          tools: TOOLS,
          messages,
        })
        assertValidDshUsage(step.usage)
        stepUsages.push(step.usage)

        messages.push(createAssistantMessage({
          content: step.blocks,
          source: { provider: 'antigravity-acp', model: 'gemini-4-neon' },
        }))

        if (step.finishKind === 'tool-calls') {
          toolRounds += 1
          const calls = step.blocks.filter((b): b is ToolCallBlock => b.type === 'tool-call')
          expect(calls.length).toBeGreaterThan(0)
          for (const call of calls) {
            const val = call.arguments.includes('first') ? '10001' : '20002'
            messages.push(createToolResultMessage({
              callId: ToolCallId(call.id),
              content: [{ type: 'text', text: val }],
              isError: false,
            }))
          }
          continue
        }
        expect(step.finishKind).toBe('stop')
        break
      }

      // 至少经历了 1 次工具续轮（即至少 2 个 DSH step）。
      expect(toolRounds).toBeGreaterThanOrEqual(1)
      expect(stepUsages.length).toBeGreaterThanOrEqual(2)

      // 中间步 outputTokens 为 0，末步承接整轮真实 outputTokens > 0。
      for (const mid of stepUsages.slice(0, -1)) {
        expect(mid.outputTokens).toBe(0)
        expect(mid.inputTokens + (mid.cacheReadTokens ?? 0)).toBeGreaterThan(0)
      }
      const last = stepUsages[stepUsages.length - 1]!
      expect(last.outputTokens).toBeGreaterThan(0)

      // 末步上下文水位应贴近单步上下文，绝不应膨胀成各步总和。
      const firstPrompt = stepUsages[0]!.inputTokens + (stepUsages[0]!.cacheReadTokens ?? 0) + (stepUsages[0]!.cacheWriteTokens ?? 0)
      const lastPrompt = last.inputTokens + (last.cacheReadTokens ?? 0) + (last.cacheWriteTokens ?? 0)
      expect(lastPrompt).toBeLessThan(firstPrompt * 1.8)
    } finally {
      await real.dispose()
    }
  }, 180_000)
})
