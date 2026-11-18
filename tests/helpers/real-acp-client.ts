/**
 * 真机集成测试用的最小 ACP 客户端。
 *
 * 不走插件的 AgentLink：直接对官方 `agy acp` 讲换行分隔的 JSON-RPC，用来验证
 * 上游行为（`docs/claims.md` 里的断言）。默认由集成测试按需创建，测试用例
 * 通过 `request()` 发请求、`texts` 收集 agent 文本增量。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'

export const REAL_ACP_ENABLED = process.env.AGY_REAL_ACP === '1'
export const REAL_ACP_BIN = process.env.AGY_ACP_BIN ?? '/root/.local/bin/agy'
export const REAL_ACP_CWD = process.env.AGY_REAL_ACP_CWD ?? '/tmp'

export interface RpcFailure extends Error { rpc?: { code?: number; message?: string } }

interface Waiter {
  resolve(value: unknown): void
  reject(error: unknown): void
  timer: NodeJS.Timeout
}

export class RealAcpClient {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #reader: readline.Interface
  readonly #waiters = new Map<number, Waiter>()
  readonly #texts: string[] = []
  #nextId = 1

  constructor(bin = REAL_ACP_BIN) {
    this.#child = spawn(bin, ['acp', '--dangerously-skip-permissions'], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#child.stderr.on('data', () => undefined)
    this.#reader = readline.createInterface({ input: this.#child.stdout })
    this.#reader.on('line', (line) => this.#onLine(line))
  }

  /** agent 到目前为止输出的文本增量（拼接后使用）。 */
  get texts(): readonly string[] { return this.#texts }

  #onLine(line: string): void {
    let message: { id?: number; result?: unknown; error?: { code?: number; message?: string }; method?: string; params?: any }
    try { message = JSON.parse(line) } catch { return }
    const id = message.id
    if (id !== undefined && this.#waiters.has(id)) {
      const waiter = this.#waiters.get(id)!
      this.#waiters.delete(id)
      clearTimeout(waiter.timer)
      if (message.error) {
        const failure = Object.assign(new Error(message.error.message ?? 'rpc failed'), { rpc: message.error }) as RpcFailure
        waiter.reject(failure)
      } else waiter.resolve(message.result)
      return
    }
    if (message.method === 'session/update') {
      const update = message.params?.update
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        this.#texts.push(String(update.content.text ?? ''))
      }
      return
    }
    // agent → client 请求（权限等）：集成测试不使用需要授权的原生能力，一律拒绝。
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

  async initialize(): Promise<any> {
    return await this.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'dsh-integration', version: '0' } })
  }

  async newSession(mcpServers: unknown[] = [], cwd = REAL_ACP_CWD): Promise<any> {
    return await this.request('session/new', { cwd, mcpServers })
  }

  async prompt(sessionId: string, text: string, timeoutMs = 240_000): Promise<any> {
    return await this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, timeoutMs)
  }

  clearTexts(): void { this.#texts.length = 0 }

  close(): void {
    this.#reader.close()
    this.#child.kill('SIGTERM')
  }
}
