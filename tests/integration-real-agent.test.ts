/**
 * 真机集成测试：直接对官方 `agy acp` 讲话，不经过任何假 agent。
 *
 * 默认 **skip**（`npm test` 仍然离线、秒级）：只有显式设置
 * `AGY_REAL_ACP=1` 时才跑。运行前提：
 * - 本机有已登录的官方 CLI（`AGY_ACP_BIN` 或 PATH 里的 `agy`）；
 * - 允许出网（必要时用 HTTPS_PROXY）；
 * - 会真的消耗一点账号额度（每个用例一次很短的生成）。
 *
 * 覆盖假 agent 无法证明的部分：能力声明、取消语义（cancelled 应答、确认前
 * 拒绝新 prompt）、取消后同会话继续、session/list、session/resume。
 */
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { afterAll, describe, expect, it } from 'vitest'

const ENABLED = process.env.AGY_REAL_ACP === '1'
const BIN = process.env.AGY_ACP_BIN ?? '/root/.local/bin/agy'
const CWD = process.env.AGY_REAL_ACP_CWD ?? '/tmp'

interface RpcError { message: string }

/** 最小 ACP 客户端：换行分隔 JSON-RPC，够用于集成断言。 */
class RealAgentClient {
  readonly #child
  readonly #rl
  readonly #waiters = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; timer: NodeJS.Timeout }>()
  #nextId = 1

  constructor() {
    this.#child = spawn(BIN, ['acp', '--dangerously-skip-permissions'], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#child.stderr.on('data', () => undefined)
    this.#rl = readline.createInterface({ input: this.#child.stdout })
    this.#rl.on('line', (line) => this.#onLine(line))
  }

  #onLine(line: string): void {
    let message: { id?: number; result?: unknown; error?: RpcError; method?: string }
    try { message = JSON.parse(line) } catch { return }
    const id = message.id
    if (id !== undefined && this.#waiters.has(id)) {
      const waiter = this.#waiters.get(id)!
      this.#waiters.delete(id)
      clearTimeout(waiter.timer)
      message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result)
      return
    }
    // agent → client 请求（权限/fs）：一律拒绝，集成测试不使用工具。
    if (message.method !== undefined && id !== undefined) {
      this.#send({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } })
    }
  }

  #send(payload: unknown): void {
    this.#child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  request<T = any>(method: string, params: unknown, timeoutMs = 180_000): Promise<T> {
    const id = this.#nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(id)
        reject(new Error(`timeout ${method}`))
      }, timeoutMs)
      this.#waiters.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      this.#send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: '2.0', method, params })
  }

  close(): void {
    this.#rl.close()
    this.#child.kill('SIGTERM')
  }
}

const clients: RealAgentClient[] = []
function client(): RealAgentClient {
  const created = new RealAgentClient()
  clients.push(created)
  return created
}
afterAll(() => { for (const item of clients) item.close() })

async function newSession(target: RealAgentClient): Promise<string> {
  const response = await target.request<{ sessionId: string }>('session/new', { cwd: CWD, mcpServers: [] })
  expect(response.sessionId).toBeTruthy()
  return response.sessionId
}

async function ask(target: RealAgentClient, sessionId: string, text: string): Promise<{ stopReason: string }> {
  return await target.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
}

describe.skipIf(!ENABLED)('真机 ACP 集成（AGY_REAL_ACP=1 才运行）', () => {
  it('initialize 声明 resume / list，并给出 agent 身份', async () => {
    const target = client()
    const init = await target.request<{
      agentInfo?: { name?: string }
      agentCapabilities?: { sessionCapabilities?: Record<string, unknown> }
    }>('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'dsh-integration', version: '0' } })
    expect(init.agentInfo?.name ?? '').toContain('Antigravity')
    expect(init.agentCapabilities?.sessionCapabilities?.resume).toBeDefined()
    expect(init.agentCapabilities?.sessionCapabilities?.list).toBeDefined()
  })

  it('新会话一次短 prompt 返回 end_turn', async () => {
    const target = client()
    await target.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'dsh-integration', version: '0' } })
    const sessionId = await newSession(target)
    const result = await ask(target, sessionId, '只回两个字：收到')
    expect(result.stopReason).toBe('end_turn')
  }, 180_000)

  it('取消返回 cancelled；确认前发新 prompt 会被 agent 拒绝', async () => {
    const target = client()
    await target.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'dsh-integration', version: '0' } })
    const sessionId = await newSession(target)
    const running = ask(target, sessionId, '用四十句话详细讲 TCP 拥塞控制，不要使用工具。')
    await new Promise((resolve) => setTimeout(resolve, 4000))
    // 先 cancel，再在同一 tick 发新 prompt：官方 agent 会明确拒绝。
    target.notify('session/cancel', { sessionId })
    const early = await ask(target, sessionId, '只回两个字：好').then(() => 'accepted', (error: Error) => error.message)
    expect(early).toContain('wait for it to finish')
    const cancelled = await running
    expect(cancelled.stopReason).toBe('cancelled')
  }, 240_000)

  it('取消确认后同一会话可以继续，并且仍在 session/list 里', async () => {
    const target = client()
    await target.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'dsh-integration', version: '0' } })
    const sessionId = await newSession(target)
    const running = ask(target, sessionId, '用四十句话详细讲 TCP 拥塞控制，不要使用工具。')
    await new Promise((resolve) => setTimeout(resolve, 4000))
    target.notify('session/cancel', { sessionId })
    expect((await running).stopReason).toBe('cancelled')

    const list = await target.request<{ sessions?: Array<{ sessionId: string }> }>('session/list', {}, 30_000)
    expect((list.sessions ?? []).some((entry) => entry.sessionId === sessionId)).toBe(true)

    const resumed = await target.request<{ sessionId?: string }>('session/resume', { sessionId, cwd: CWD, mcpServers: [] }, 60_000)
    expect(resumed.sessionId).toBe(sessionId)
    expect((await ask(target, sessionId, '只回两个字：好')).stopReason).toBe('end_turn')
  }, 240_000)
})
