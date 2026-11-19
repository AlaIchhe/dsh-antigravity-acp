/**
 * 真机实验：跨「进程重启」的会话恢复（resumeSessions）。
 *
 * 这是 id 纳入指纹后最危险的路径：sessions.json 存的是 prefixHash，
 * 若新进程从日志派生出的 message id 与旧进程不同，哈希必然不匹配，
 * 所有老会话都会恢复失败。
 *
 * 做法：第一个 adapter 跑一轮建立映射并落盘；**销毁它**（连同 ACP 进程）；
 * 再用第二个 adapter + 同一 sessionStore 恢复同一 DSH 会话。
 */
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock, GenerateOptions, RequestMessage, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { createRealAdapter } from './helpers/real-adapter.js'

const ENABLED = process.env.AGY_REAL_ACP === '1'
const MODEL = process.env.AGY_REAL_MODEL ?? 'gemini-4-hydrogen'

const ECHO_TOOL: ToolSchema = {
  name: 'echo_probe',
  description: '回显传入的 text。',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
}

function sid(v: string): NonNullable<GenerateOptions['sessionId']> {
  return brandString(v as NonNullable<GenerateOptions['sessionId']>)
}
function userTurn(text: string): RequestMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}
async function drain(stream: AsyncIterable<StreamChunk>) {
  const blocks: ContentBlock[] = []
  let finish: Extract<StreamChunk, { type: 'finish' }>['reason'] | undefined
  let error: string | undefined
  try {
    for await (const chunk of stream) {
      if (chunk.type === 'block-end') blocks.push(chunk.block)
      if (chunk.type === 'finish') finish = chunk.reason
    }
  } catch (thrown) {
    error = thrown instanceof Error ? `${(thrown as { code?: string }).code ?? ''} ${thrown.message}`.trim() : String(thrown)
  }
  return { blocks, finish, error }
}
function failCode(r: Awaited<ReturnType<typeof drain>>): string {
  if (r.finish?.kind === 'error') return r.finish.failure.code ?? r.finish.failure.message
  return r.error ?? ''
}

describe.skipIf(!ENABLED)('跨进程恢复：id 纳入指纹后仍然可用', () => {
  it('销毁 adapter 后用新实例 + 同一映射恢复同一会话', async () => {
    const cacheDir = '/tmp/agy-restart-probe'
    await import('node:fs/promises').then((fs) => fs.rm(cacheDir, { recursive: true, force: true }))
    const base: GenerateOptions = {
      provider: 'antigravity-acp', model: MODEL, reasoningEffort: 'low' as never,
      tools: [ECHO_TOOL], sessionId: sid('session-restart-probe'), messages: [],
    }

    // ── 进程 1：建立会话、跑完工具循环、把映射写入磁盘 ──────────────────
    const first = await createRealAdapter({ cwd: '/tmp', cacheDir, parkSettleMs: 400, promptTimeoutMs: 180_000 })
    await first.adapter.prepareCall('antigravity-acp', MODEL)
    // 先用一条具名消息对象发出；后面重建历史时**复用同一个对象**，
    // 与 DSH 从会话日志原样返回同一条消息（同 id）一致。
    const opening = userTurn('只回两个字：收到')
    const r1 = await drain(first.adapter.stream({ ...base, messages: [opening] }))
    expect(failCode(r1)).toBe('')
    const history: RequestMessage[] = [
      opening,
      ...(r1.blocks.length > 0
        ? [createAssistantMessage({ content: r1.blocks, source: { provider: base.provider, model: base.model } })]
        : []),
    ]
    const acpSessionId = first.logs.map((l) => /session=([0-9a-f-]+)/.exec(l.message)?.[1]).find(Boolean)
    console.log('[进程1] ACP session =', acpSessionId, '| 日志条数', first.logs.length)
    await first.dispose()   // 关闭 ACP 进程，模拟宿主重启

    // 映射应当已落盘（上一轮是正常收尾，不是 prompt 在途）。
    const mapFile = `${cacheDir}/sessions.json`
    const mapRaw = await import('node:fs/promises').then((fs) => fs.readFile(mapFile, 'utf8').catch(() => ''))
    console.log('[进程1] 落盘映射:', mapRaw.replace(/\s+/g, ' ').slice(0, 260) || '(空)')

    // ── 进程 2：全新 adapter，靠磁盘映射恢复 ────────────────────────────
    const second = await createRealAdapter({ cwd: '/tmp', cacheDir, parkSettleMs: 400, promptTimeoutMs: 180_000 })
    await second.adapter.prepareCall('antigravity-acp', MODEL)
    const r2 = await drain(second.adapter.stream({
      ...base,
      messages: [...history, userTurn('刚才让你做什么？只回关键动词')],
    }))
    const logs = second.logs.map((l) => l.message).join('\n')
    console.log('[进程2] finish =', JSON.stringify(r2.finish), '| error =', r2.error ?? '-')
    console.log('[进程2] 恢复相关日志:\n' + logs.split('\n').filter((l) => /恢复|复用|放弃|失败/.test(l)).join('\n'))
    await second.dispose()

    // 核心断言：不得报「会话映射缺失」。模型是否记得内容取决于上游，不作断言。
    expect(failCode(r2)).not.toContain('AGY_SESSION_UNRECOVERABLE')
  }, 900_000)
})
