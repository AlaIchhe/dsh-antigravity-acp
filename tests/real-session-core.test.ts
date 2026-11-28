/**
 * v1.0 方案 A 端到端实机回归套件（零 mock、零假 agent、使用本机真实 `agy acp` 与真实凭据）。
 *
 * 完整覆盖本轮重构的 5 个核心状态机修复与 rc.2 / rc.3 回归：
 * 1. 分模型 `thought_level` + CLI 家族档位并集 + 后台 `purpose='session-title'` 不污染默认档位 + 切档位 `reset-fresh`；
 * 2. 无工具会话 → 首次带工具触发 `reset-fresh` 挂载 MCP 桥 + 同 prompt 连续两段 MCP 工具调用（`rotateContinuation`）；
 * 3. 用户取消后**立刻**续聊（`#pendingCancels` 等待 agent 确认，不撞 `wait for it to finish`）；
 * 4. `AcpRuntimeManager.getLink()` 并发冷启动时单方取消不误伤同行者 + 双对话真并发共享同一 ACP 进程；
 * 5. 多账号切换（当本机存在 ≥2 个已登录账号时）：旧账号在途回合不被中断、空闲后自动排空旧进程、
 *    老对话切账号后平滑 `reset-fresh`（历史保留）并在 `sessions.json` 落盘新 `accountId`。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ReasoningEffortId,
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, RequestMessage, ToolCallBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ResolvedAccount } from '../src/accounts/types.js'
import { AcpRuntimeManager } from '../src/runtime/acp-runtime.js'
import { createSubprocessCliRun, fetchAgyModels } from '../src/runtime/agy-cli.js'
import { resolveHttpsProxy } from '../src/runtime/proxy.js'
import { AntigravityAcpAdapter } from '../src/session/adapter.js'
import { CatalogStore } from '../src/session/catalog-store.js'
import { createFileSessionStore, readSessionMap } from '../src/session/session-store.js'
import {
  createRealProxiedFetch,
  createRealSubprocessRuntime,
  REAL_AGY_BIN,
  REAL_READY_ACCOUNTS,
  REAL_TESTS_ENABLED,
} from './helpers/real-env.js'

const MODEL = process.env.AGY_REAL_MODEL ?? 'gemini-4-neon'
const dirs: string[] = []
const disposers: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) {
    try { await dispose() } catch { /* ignore */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface RealStack {
  runtime: AcpRuntimeManager
  adapter: AntigravityAcpAdapter
  catalog: CatalogStore
  cacheDir: string
  logs: string[]
  setAccount(next: ResolvedAccount): Promise<void>
}

async function createRealStack(initialAccount: ResolvedAccount, cancelGraceMs = 15_000): Promise<RealStack> {
  const cacheDir = mkdtempSync(join(tmpdir(), 'agy-real-stack-'))
  dirs.push(cacheDir)
  const { runtime: subprocess, killAll } = createRealSubprocessRuntime()
  const realFetch = createRealProxiedFetch()
  const cliRun = createSubprocessCliRun(subprocess, () => resolveHttpsProxy(undefined))
  const logs: string[] = []
  const log = {
    info: (m: string) => { logs.push(m) },
    warn: (m: string, e?: unknown) => { logs.push(`WARN ${m}${e ? `: ${e instanceof Error ? e.message : String(e)}` : ''}`) },
  }

  let currentAccount = initialAccount
  let adapterRef: AntigravityAcpAdapter | undefined

  const catalog = new CatalogStore({
    cacheDir,
    acpVersion: '1.4.0',
    loadCliModels: () => fetchAgyModels(cliRun, REAL_AGY_BIN!, currentAccount.dir),
  })
  const sessionStore = createFileSessionStore(cacheDir)
  const runtime = new AcpRuntimeManager({
    subprocess,
    readConfig: () => ({ binaryPath: REAL_AGY_BIN!, acpVersion: '1.4.0', cancelGraceMs, idleRecycleMs: 0 }),
    resolveAccount: () => currentAccount,
    isLinkBusy: (link) => adapterRef?.isLinkBusy(link) ?? false,
    fetchImpl: realFetch,
    log,
  })
  const adapter = new AntigravityAcpAdapter({
    catalog,
    getLink: (handlers, signal) => runtime.getLink(handlers, signal),
    recycleLink: (link) => runtime.recycle(link),
    resolveAccount: () => currentAccount,
    onLinkIdle: () => { void runtime.drainRetired().catch(() => undefined) },
    sessionStore,
    cwd: process.cwd(),
    readSettings: () => ({
      resumeSessions: true,
      cancelGraceMs,
      idleRecycleMs: 0,
      promptTimeoutMs: 180_000,
      bridgeParkSettleMs: 150,
    }),
    log,
  })
  adapterRef = adapter

  disposers.push(async () => {
    await adapter.dispose().catch(() => undefined)
    await runtime.dispose().catch(() => undefined)
    await sessionStore.close().catch(() => undefined)
    await realFetch.close().catch(() => undefined)
    killAll()
  })

  return {
    runtime,
    adapter,
    catalog,
    cacheDir,
    logs,
    async setAccount(next: ResolvedAccount) {
      currentAccount = next
      await runtime.retireIfAccountChanged()
    },
  }
}

async function runStream(adapter: AntigravityAcpAdapter, options: GenerateOptions) {
  const blocks: ContentBlock[] = []
  let text = ''
  let finishKind = ''
  let failureCode: string | undefined
  for await (const chunk of adapter.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'block-end') blocks.push(chunk.block)
    if (chunk.type === 'finish') {
      finishKind = chunk.reason.kind
      if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
        failureCode = chunk.reason.failure?.code
      }
    }
  }
  return { blocks, text, finishKind, failureCode }
}

function toResolvedAccount(probe: (typeof REAL_READY_ACCOUNTS)[number], revision = 0): ResolvedAccount {
  return {
    id: probe.id,
    alias: probe.alias,
    system: probe.system,
    home: probe.home,
    ...(probe.dir ? { dir: probe.dir } : {}),
    revision,
  }
}

describe.skipIf(!REAL_TESTS_ENABLED || REAL_READY_ACCOUNTS.length === 0)('v1.0 real-ACP state-machine end-to-end regressions', () => {
  it('isolates per-model thought_level, prevents background title pollution, and resets cleanly on effort change', async () => {
    const stack = await createRealStack(toResolvedAccount(REAL_READY_ACCOUNTS[0]!))
    await stack.catalog.refreshCliModels(true)

    // 实机 CLI 目录：Neon 含 xhigh，Claude Sonnet 5.5 不含 xhigh，Orchestrator 无档位
    const neonMeta = await stack.catalog.resolveModel('antigravity-acp', 'gemini-4-neon')
    const claudeMeta = await stack.catalog.resolveModel('antigravity-acp', 'claude-sonnet-5-5')
    const orchMeta = await stack.catalog.resolveModel('antigravity-acp', 'gemini-pro-orchestrator')
    expect(neonMeta.reasoning?.efforts.map((e) => e.id.toString())).toContain('xhigh')
    expect(claudeMeta.reasoning?.efforts.map((e) => e.id.toString())).not.toContain('xhigh')
    expect(orchMeta.reasoning).toBeUndefined()

    const sid = `real-effort-${Date.now()}` as GenerateOptions['sessionId']
    const u1 = createUserMessage({ content: [{ type: 'text', text: '记住暗号 ALPHA-99，只回两个字：记住' }], source: { kind: 'user' } })
    const r1 = await runStream(stack.adapter, {
      provider: 'antigravity-acp',
      model: MODEL,
      reasoningEffort: ReasoningEffortId('high'),
      sessionId: sid,
      messages: [u1],
    })
    expect(r1.finishKind).toBe('stop')
    expect((await stack.catalog.resolveModel('antigravity-acp', MODEL)).reasoning?.defaultEffort?.toString()).toBe('high')

    // 模拟 DSH 后台标题请求（同模型 + low + purpose='session-title'）
    const titleRes = await runStream(stack.adapter, {
      provider: 'antigravity-acp',
      model: MODEL,
      reasoningEffort: ReasoningEffortId('low'),
      purpose: 'session-title',
      sessionId: sid,
      messages: [createUserMessage({ content: [{ type: 'text', text: '给上面的对话起一个四个字以内的标题' }], source: { kind: 'user' } })],
    })
    expect(titleRes.finishKind).toBe('stop')
    // 绝不能把聊天默认档位污染成 low
    expect((await stack.catalog.resolveModel('antigravity-acp', MODEL)).reasoning?.defaultEffort?.toString()).toBe('high')

    // 聊天续轮（同档位 high）→ 正常复用
    const a1 = createAssistantMessage({ content: r1.blocks, source: { provider: 'antigravity-acp', model: MODEL } })
    const u2 = createUserMessage({ content: [{ type: 'text', text: '刚才的暗号是什么？只回暗号。' }], source: { kind: 'user' } })
    const r2 = await runStream(stack.adapter, {
      provider: 'antigravity-acp',
      model: MODEL,
      reasoningEffort: ReasoningEffortId('high'),
      sessionId: sid,
      messages: [u1, a1, u2],
    })
    expect(r2.finishKind).toBe('stop')
    expect(r2.text).toContain('ALPHA-99')
    expect(stack.logs.some((l) => l.includes('reused=true'))).toBe(true)

    // 主动切思考档位（high → low）→ 走 reset-fresh，保留历史，不报 AGY_SESSION_UNRECOVERABLE
    const a2 = createAssistantMessage({ content: r2.blocks, source: { provider: 'antigravity-acp', model: MODEL } })
    const u3 = createUserMessage({ content: [{ type: 'text', text: '再说一次暗号，只回暗号本身。' }], source: { kind: 'user' } })
    const r3 = await runStream(stack.adapter, {
      provider: 'antigravity-acp',
      model: MODEL,
      reasoningEffort: ReasoningEffortId('low'),
      sessionId: sid,
      messages: [u1, a1, u2, a2, u3],
    })
    expect(r3.finishKind).toBe('stop')
    expect(r3.text).toContain('ALPHA-99')
    expect(stack.logs.some((l) => l.includes('思考档位已变化'))).toBe(true)
  }, 240_000)

  it('transitions from no-tools to with-tools via reset-fresh and completes consecutive 2-step MCP tool calls', async () => {
    const stack = await createRealStack(toResolvedAccount(REAL_READY_ACCOUNTS[0]!))
    const sid = `real-tools-${Date.now()}` as GenerateOptions['sessionId']

    // 第 1 轮：无工具（usesTools = false）
    const u1 = createUserMessage({ content: [{ type: 'text', text: '只回两个字：收到' }], source: { kind: 'user' } })
    const r1 = await runStream(stack.adapter, {
      provider: 'antigravity-acp',
      model: MODEL,
      reasoningEffort: ReasoningEffortId('low'),
      sessionId: sid,
      messages: [u1],
    })
    expect(r1.finishKind).toBe('stop')

    // 第 2 轮：首次带上工具，并要求连续调用两次工具（验证 usesTools false→true 重建 + rc.2 续轮账本轮换）
    const TOOL: ToolSchema = {
      name: 'fetch_code',
      description: '按 key 查询密文；必须分步调用两次，先查 first 再查 second',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: '查询键（first 或 second）' } },
        required: ['key'],
      },
    }
    const a1 = createAssistantMessage({ content: r1.blocks, source: { provider: 'antigravity-acp', model: MODEL } })
    const u2 = createUserMessage({
      content: [{
        type: 'text',
        text: '请先调用一次 fetch_code(key="first")，拿到结果后再调用一次 fetch_code(key="second")，最后把两个返回值用短横线拼起来回复我。',
      }],
      source: { kind: 'user' },
    })

    const messages: RequestMessage[] = [u1, a1, u2]
    let toolBatches = 0
    let finalText = ''

    for (let guard = 0; guard < 6; guard += 1) {
      const step = await runStream(stack.adapter, {
        provider: 'antigravity-acp',
        model: MODEL,
        reasoningEffort: ReasoningEffortId('low'),
        sessionId: sid,
        tools: [TOOL],
        messages,
      })
      expect(step.failureCode).toBeUndefined()
      messages.push(createAssistantMessage({ content: step.blocks, source: { provider: 'antigravity-acp', model: MODEL } }))

      if (step.finishKind === 'tool-calls') {
        toolBatches += 1
        const calls = step.blocks.filter((b): b is ToolCallBlock => b.type === 'tool-call')
        expect(calls.length).toBeGreaterThan(0)
        for (const call of calls) {
          const val = call.arguments.includes('first') ? 'K101' : 'K202'
          messages.push(createToolResultMessage({
            callId: ToolCallId(call.id),
            content: [{ type: 'text', text: val }],
            isError: false,
          }))
        }
        continue
      }
      expect(step.finishKind).toBe('stop')
      finalText = step.text
      break
    }

    expect(stack.logs.some((l) => l.includes('首次启用工具'))).toBe(true)
    expect(toolBatches).toBeGreaterThanOrEqual(2)
    expect(finalText).toContain('K101')
    expect(finalText).toContain('K202')
  }, 240_000)

  it('waits for cancel settlement when user immediately continues after aborting mid-stream', async () => {
    const stack = await createRealStack(toResolvedAccount(REAL_READY_ACCOUNTS[0]!), 20_000)
    const sid = `real-cancel-${Date.now()}` as GenerateOptions['sessionId']

    // 发起长回答并在收到首批流式块后立刻取消
    const ac = new AbortController()
    const u1 = createUserMessage({
      content: [{ type: 'text', text: '用四十段话详细讲解操作系统的虚拟内存、页表与页面置换算法，不要使用任何工具。' }],
      source: { kind: 'user' },
    })
    let abortedKind = ''
    for await (const chunk of stack.adapter.stream({
      provider: 'antigravity-acp',
      model: MODEL,
      reasoningEffort: ReasoningEffortId('low'),
      sessionId: sid,
      signal: ac.signal,
      messages: [u1],
    })) {
      if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && !ac.signal.aborted) {
        ac.abort('user-stop')
      }
      if (chunk.type === 'finish') abortedKind = chunk.reason.kind
    }
    expect(abortedKind).toBe('aborted')

    // 零延迟立刻发下一条消息：必须由 #pendingCancels 等待上轮取消确认，绝不撞 wait for it to finish
    const u2 = createUserMessage({ content: [{ type: 'text', text: '忽略上文，只回两个字：继续' }], source: { kind: 'user' } })
    const r2 = await runStream(stack.adapter, {
      provider: 'antigravity-acp',
      model: MODEL,
      reasoningEffort: ReasoningEffortId('low'),
      sessionId: sid,
      messages: [u1, u2],
    })
    expect(r2.failureCode).toBeUndefined()
    expect(r2.finishKind).toBe('stop')
    expect(r2.text.trim().length).toBeGreaterThan(0)
  }, 240_000)

  it('isolates caller abort during concurrent cold-start getLink and runs two real conversations concurrently on one link', async () => {
    const stack = await createRealStack(toResolvedAccount(REAL_READY_ACCOUNTS[0]!))

    // 并发冷启动：Caller 1 立刻 abort，Caller 2 必须正常拿到共享链路
    const ac1 = new AbortController()
    const p1 = stack.runtime.getLink({}, ac1.signal)
    const p2 = stack.runtime.getLink({})
    ac1.abort('caller-1-cancelled')
    await expect(p1).rejects.toThrow()
    const sharedLink = await p2
    expect(sharedLink.initialized).toBe(true)

    // 同一共享进程上两条真实对话并发执行
    const [resA, resB] = await Promise.all([
      runStream(stack.adapter, {
        provider: 'antigravity-acp',
        model: MODEL,
        reasoningEffort: ReasoningEffortId('low'),
        sessionId: `real-conc-a-${Date.now()}` as GenerateOptions['sessionId'],
        messages: [createUserMessage({ content: [{ type: 'text', text: '只回两个字：甲组' }], source: { kind: 'user' } })],
      }),
      runStream(stack.adapter, {
        provider: 'antigravity-acp',
        model: MODEL,
        reasoningEffort: ReasoningEffortId('low'),
        sessionId: `real-conc-b-${Date.now()}` as GenerateOptions['sessionId'],
        messages: [createUserMessage({ content: [{ type: 'text', text: '只回两个字：乙组' }], source: { kind: 'user' } })],
      }),
    ])
    expect(resA.finishKind).toBe('stop')
    expect(resB.finishKind).toBe('stop')
    expect(resA.text).toContain('甲组')
    expect(resB.text).toContain('乙组')
  }, 240_000)

  it.skipIf(REAL_READY_ACCOUNTS.length < 2)(
    'drains old account link cleanly without killing in-flight turn and resets session cleanly on new account',
    async () => {
      const accountA = toResolvedAccount(REAL_READY_ACCOUNTS[0]!)
      const accountB = toResolvedAccount(REAL_READY_ACCOUNTS[1]!)
      const stack = await createRealStack(accountA)

      const sidA = `real-acct-a-${Date.now()}` as GenerateOptions['sessionId']
      const sidB = `real-acct-b-${Date.now()}` as GenerateOptions['sessionId']
      const uA1 = createUserMessage({ content: [{ type: 'text', text: '记住暗号 MULTI-77，只回两个字：记住' }], source: { kind: 'user' } })

      // 1. 账号 A 发起第 1 轮，在途期间切到账号 B 并同时在账号 B 发起对话
      let switched = false
      let textA1 = ''
      const blocksA1: ContentBlock[] = []
      let finishA1 = ''
      let promiseB: ReturnType<typeof runStream> | undefined

      for await (const chunk of stack.adapter.stream({
        provider: 'antigravity-acp',
        model: MODEL,
        reasoningEffort: ReasoningEffortId('low'),
        sessionId: sidA,
        messages: [uA1],
      })) {
        if (chunk.type === 'text-delta') textA1 += chunk.text
        if (chunk.type === 'block-end') blocksA1.push(chunk.block)
        if (!switched && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')) {
          switched = true
          // 切到账号 B：账号 A 的在途回合绝不能被杀，而是优雅排空
          await stack.setAccount(accountB)
          promiseB = runStream(stack.adapter, {
            provider: 'antigravity-acp',
            model: MODEL,
            reasoningEffort: ReasoningEffortId('low'),
            sessionId: sidB,
            messages: [createUserMessage({ content: [{ type: 'text', text: '只回两个字：新号' }], source: { kind: 'user' } })],
          })
        }
        if (chunk.type === 'finish') finishA1 = chunk.reason.kind
      }

      if (!switched) {
        await stack.setAccount(accountB)
        promiseB = runStream(stack.adapter, {
          provider: 'antigravity-acp',
          model: MODEL,
          reasoningEffort: ReasoningEffortId('low'),
          sessionId: sidB,
          messages: [createUserMessage({ content: [{ type: 'text', text: '只回两个字：新号' }], source: { kind: 'user' } })],
        })
      }

      expect(finishA1).toBe('stop')
      expect(textA1.trim().length).toBeGreaterThan(0)

      const resB = await promiseB!
      expect(resB.finishKind).toBe('stop')
      expect(resB.text).toContain('新号')

      // 旧账号链路排空后自动回收
      await new Promise((r) => setTimeout(r, 200))
      expect(stack.runtime.retiredCount).toBe(0)

      // 2. 对话 A 在账号 B 下继续发第 2 轮：必须平滑 reset-fresh（历史保留），不能报 AGY_SESSION_UNRECOVERABLE
      const aA1 = createAssistantMessage({ content: blocksA1, source: { provider: 'antigravity-acp', model: MODEL } })
      const uA2 = createUserMessage({ content: [{ type: 'text', text: '刚才的暗号是什么？只回暗号。' }], source: { kind: 'user' } })
      const resA2 = await runStream(stack.adapter, {
        provider: 'antigravity-acp',
        model: MODEL,
        reasoningEffort: ReasoningEffortId('low'),
        sessionId: sidA,
        messages: [uA1, aA1, uA2],
      })
      expect(resA2.failureCode).toBeUndefined()
      expect(resA2.finishKind).toBe('stop')
      expect(resA2.text).toContain('MULTI-77')

      // sessions.json 必须记录新账号 ID
      await new Promise((r) => setTimeout(r, 100))
      const persisted = await readSessionMap(stack.cacheDir)
      expect(persisted[`${sidA}::chat`]?.accountId).toBe(accountB.id)
    },
    300_000,
  )
})
