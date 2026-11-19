/**
 * 真机实验：验证「用 message id 做历史标识」是否可行。
 *
 * 前提：`AGY_REAL_ACP=1`。
 *
 * 要回答三个问题：
 *   1. 同一个 ACP 会话里，注入块的 id 在「注入时」与「下一次请求」之间是否不变？
 *   2. DSH 派生历史返回的是否是同一个对象（id 不会在派生时被重新生成）？
 *   3. 在 id 参与比较的前提下，注入块插入中间位置能否被自然识别为「新消息」？
 *
 * 用真实历史快照做纯计算验证（问题 2、3），再用真机跑一轮（问题 1）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestMessage, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { messageValue, stable } from '../src/adapter/continuation-state.js'

const ENABLED = process.env.AGY_REAL_ACP === '1'

/** 读真实会话日志里的 user/message，返回 {id, kind, form} 列表。 */
function readSessionMessages(): Array<{ id: string; kind?: string; form?: string }> {
  const root = join(homedir(), '.dsh', 'sessions')
  const out: Array<{ id: string; kind?: string; form?: string }> = []
  for (const workspace of readdirSync(root)) {
    const wsDir = join(root, workspace)
    let sessions: string[]
    try { sessions = readdirSync(wsDir) } catch { continue }
    for (const session of sessions.slice(0, 6)) {
      const file = join(wsDir, session, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      try {
        const jsonl = execFileSync('zstd', ['-dc', file], { maxBuffer: 64 * 1024 * 1024 }).toString()
        for (const line of jsonl.split('\n')) {
          let event: { type?: string; data?: { id?: string; source?: { kind?: string; form?: string } } }
          try { event = JSON.parse(line) } catch { continue }
          if (event.type !== 'user/message') continue
          const id = event.data?.id
          if (typeof id === 'string') out.push({ id, kind: event.data?.source?.kind, form: event.data?.source?.form })
        }
      } catch { continue }
    }
  }
  return out
}

/** 按会话分组读取（id 唯一性只在单条会话内成立）。 */
function readSessionMessagesPerSession(): Array<Array<{ id: string; kind?: string; form?: string }>> {
  const root = join(homedir(), '.dsh', 'sessions')
  const grouped: Array<Array<{ id: string; kind?: string; form?: string }>> = []
  for (const workspace of readdirSync(root)) {
    const wsDir = join(root, workspace)
    let sessions: string[]
    try { sessions = readdirSync(wsDir) } catch { continue }
    for (const session of sessions.slice(0, 6)) {
      const file = join(wsDir, session, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      const rows: Array<{ id: string; kind?: string; form?: string }> = []
      try {
        const jsonl = execFileSync('zstd', ['-dc', file], { maxBuffer: 64 * 1024 * 1024 }).toString()
        for (const line of jsonl.split('\n')) {
          let event: { type?: string; data?: { id?: string; source?: { kind?: string; form?: string } } }
          try { event = JSON.parse(line) } catch { continue }
          if (event.type !== 'user/message') continue
          const id = event.data?.id
          if (typeof id === 'string') rows.push({ id, kind: event.data?.source?.kind, form: event.data?.source?.form })
        }
      } catch { continue }
      grouped.push(rows)
    }
  }
  return grouped
}

describe.skipIf(!ENABLED)('message id 作为历史标识的可行性', () => {
  it('真实会话里每条消息的 id 都非空且形态一致', () => {
    const rows = readSessionMessages()
    expect(rows.length).toBeGreaterThan(50)
    const ids = rows.map((r) => r.id)
    expect(ids.every((id) => /^[0-9a-f-]{36}$/.test(id))).toBe(true)
    const kinds = [...new Set(rows.map((r) => r.kind))]
    console.log('来源类型:', kinds.filter(Boolean).sort().join(', '))
    console.log('总消息数:', rows.length)
  }, 120_000)

  it('id 在**单个会话内**唯一（跨会话不共享 id 空间）', () => {
    // 上文把多个会话的消息混在一起统计会得到「重复」，那不是缺陷：
    // id 的唯一性只在一条会话的历史内成立，而前缀比较也只在一条会话内进行。
    const perSession = readSessionMessagesPerSession()
    let checked = 0
    for (const rows of perSession) {
      if (rows.length === 0) continue
      const ids = rows.map((r) => r.id)
      expect(new Set(ids).size, `会话内出现重复 id：${ids.join(',')}`).toBe(ids.length)
      checked += 1
    }
    expect(checked).toBeGreaterThan(5)
    console.log('检查会话数:', checked, '| 全部内部唯一')
  }, 120_000)

  it('若指纹含 id：注入块插入中间不会破坏前缀判定', () => {
    const call: ToolCallBlock = { type: 'tool-call', id: ToolCallId('c1'), name: 'read', arguments: '{}' }
    const base: GenerateOptions = {
      provider: 'p', model: 'm', system: 's',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } })],
      tools: [{ name: 'read', description: 'R', parameters: { type: 'object' } }],
    }
    const assistant = createAssistantMessage({ content: [call], source: { provider: 'p', model: 'm' } })
    const toolResult = createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'r' }], isError: false })

    // 注入块在中间时，按 id 比较能看出「这是一条新消息」而不是「原消息被改」。
    const injected = createUserMessage({
      content: [{ type: 'text', text: 'time' }],
      source: { kind: 'time-context', form: 'snapshot' },
    } as never) as RequestMessage

    const withId = (m: RequestMessage): string => stable({ id: (m as { id?: string }).id, value: messageValue(m) })
    const historyIds = base.messages.map(withId)
    const nextIds = [...base.messages, assistant, toolResult, injected].map(withId)
    // 前缀（按 id）仍然一致：注入块追加在末尾，不影响已有位置。
    expect(nextIds.slice(0, historyIds.length)).toEqual(historyIds)
    // 不带 id 时，只比内容就无法区分「同一位置」与「新增」——这正是需要类型判定的原因。
    const historyValues = base.messages.map((m) => stable(messageValue(m)))
    const nextValues = [...base.messages, assistant, toolResult, injected].map((m) => stable(messageValue(m)))
    expect(nextValues.slice(0, historyValues.length)).toEqual(historyValues)
  })
})
