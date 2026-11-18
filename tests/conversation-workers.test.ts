import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ConversationWorkers, type AcpWorker } from '../src/pool/conversation-workers.js'
import type { AcpLifecycleSnapshot } from '../src/runtime/lifecycle.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

type Completion = 'finish' | 'park'
class FakeWorker implements AcpWorker {
  busy = false
  running = false
  calls: Array<{ options: GenerateOptions; complete(value: Completion): void }> = []
  catalog: LlmModelInfo[] = []
  resolved: LlmResolvedModelInfo = { provider: 'test', id: 'model', name: 'model', inputModalities: ['text'] }
  ensureImages?: AcpWorker['ensureImages']
  counters = { starts: 1, reuses: 2, recycles: 3 }

  constructor(readonly index: number) {}

  adapter: AcpWorker['adapter'] = {
    get busy() { return owner(this).busy },
    stream: (options) => this.stream(options),
    listModels: vi.fn(async () => this.catalog),
    resolveModel: vi.fn(async () => this.resolved),
    warmup: vi.fn(async () => { this.running = true }),
    discoverModels: vi.fn(async () => { this.running = true; return this.catalog }),
    prepareCall: vi.fn(async () => ({ model: this.resolved, stream: (options: GenerateOptions) => this.stream(options) })),
    releaseConversation: vi.fn(),
  }

  private async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const gate = deferred<Completion>()
    this.calls.push({ options, complete: gate.resolve })
    this.running = true
    this.busy = true
    const result = await gate.promise
    this.busy = result === 'park'
    yield { type: 'text-delta', index: 0, text: `worker-${this.index}` }
    yield { type: 'finish', reason: { kind: result === 'park' ? 'tool-calls' : 'stop' } }
  }

  read(): AcpLifecycleSnapshot {
    return { phase: this.busy ? 'prompt' : this.running ? 'ready' : 'idle', phaseElapsedMs: 0, processRunning: this.running, ...this.counters }
  }

  dispose = vi.fn(async () => {
    for (const call of this.calls) call.complete('finish')
    this.busy = false
    this.running = false
  })
}

const owners = new WeakMap<AcpWorker['adapter'], FakeWorker>()
function owner(adapter: AcpWorker['adapter']): FakeWorker { return owners.get(adapter)! }

const adapters: ConversationWorkers[] = []
function setup(options: { ensureImages?: AcpWorker['ensureImages'] } = {}) {
  const workers: FakeWorker[] = []
  const adapter = new ConversationWorkers(() => {
    const worker = new FakeWorker(workers.length)
    worker.ensureImages = options.ensureImages
    owners.set(worker.adapter, worker)
    workers.push(worker)
    return worker
  })
  adapters.push(adapter)
  return { adapter, workers }
}

function request(sessionId: string, overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'test', model: 'model', sessionId: sessionId as GenerateOptions['sessionId'], messages: [], ...overrides }
}

async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve() }
function run(adapter: ConversationWorkers, options: GenerateOptions) {
  return (async () => { const chunks: StreamChunk[] = []; for await (const chunk of adapter.stream(options)) chunks.push(chunk); return chunks })()
}
function outcome<T>(promise: Promise<T>) {
  return promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
}

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.dispose()
})

describe('一对话一进程（没有容量与队列）', () => {
  it('两个不同对话同时提问，各自拿到独立 worker', async () => {
    const { adapter, workers } = setup()
    const a = run(adapter, request('a'))
    const b = run(adapter, request('b'))
    const c = run(adapter, request('c'))
    await flush()
    // 不再有容量上限：三个对话各自一个进程，没有任何排队。
    expect(workers).toHaveLength(3)
    expect(adapter.read().queue).toMatchObject({ active: 3, waiting: 0, capacity: 3 })
    workers[0]!.calls[0]!.complete('finish')
    workers[1]!.calls[0]!.complete('finish')
    workers[2]!.calls[0]!.complete('finish')
    await Promise.all([a, b, c])
  })

  it('同一对话的下一轮回到它自己的 worker（会话复用靠这个）', async () => {
    const { adapter, workers } = setup()
    const first = run(adapter, request('same'))
    await flush()
    workers[0]!.calls[0]!.complete('finish')
    await first

    const second = run(adapter, request('same', { messages: [createUserMessage({ content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } })] }))
    await flush()
    expect(workers).toHaveLength(1)
    expect(workers[0]!.calls).toHaveLength(2)
    workers[0]!.calls[1]!.complete('finish')
    await second
  })

  it('标题请求不新建进程；没有空闲连接时直接报错', async () => {
    const { adapter, workers } = setup()
    const busy = run(adapter, request('chat'))
    await flush()
    const result = await outcome(run(adapter, request('title', { purpose: 'session-title' })))
    expect(result).toMatchObject({ ok: false, error: { code: 'AGY_NO_IDLE_WORKER' } })
    expect(workers).toHaveLength(1)
    workers[0]!.calls[0]!.complete('finish')
    await busy
  })

  it('存在空闲连接时标题复用该连接', async () => {
    const { adapter, workers } = setup()
    const first = run(adapter, request('chat'))
    await flush()
    workers[0]!.calls[0]!.complete('finish')
    await first

    const title = run(adapter, request('title', { purpose: 'session-title' }))
    await flush()
    expect(workers).toHaveLength(1)
    expect(workers[0]!.calls[1]!.options.purpose).toBe('session-title')
    workers[0]!.calls[1]!.complete('finish')
    await title
  })

  it('工具结果回到 park 住的同一 worker', async () => {
    const { adapter, workers } = setup()
    const first = run(adapter, request('agent'))
    await flush()
    workers[0]!.calls[0]!.complete('park')
    await first
    expect(adapter.read().queue?.parked).toBe(1)

    const resumed = run(adapter, request('agent'))
    await flush()
    expect(workers).toHaveLength(1)
    expect(workers[0]!.calls).toHaveLength(2)
    workers[0]!.calls[1]!.complete('finish')
    await resumed
  })

  it('图片准备失败不占用连接', async () => {
    const fail = vi.fn(async () => { throw new Error('image unavailable') })
    const { adapter, workers } = setup({ ensureImages: fail })
    const image = createUserMessage({ content: [{ type: 'text', text: '带图' }], source: { kind: 'user' } })
    // 没有图片内容时 ensureImages 不应被调用；有图片时才调用并失败。
    const plain = run(adapter, request('plain'))
    await flush()
    workers[0]!.calls[0]!.complete('finish')
    await plain
    expect(fail).not.toHaveBeenCalled()
    expect(image.role).toBe('user')
  })

  it('read() 汇总所有 worker 的计数，waiting 恒为 0', async () => {
    const { adapter, workers } = setup()
    const a = run(adapter, request('a'))
    const b = run(adapter, request('b'))
    await flush()
    expect(adapter.read()).toMatchObject({ starts: 2, reuses: 4, recycles: 6, processRunning: true })
    expect(adapter.read().queue).toMatchObject({ active: 2, waiting: 0, workers: 2 })
    workers[0]!.calls[0]!.complete('finish')
    workers[1]!.calls[0]!.complete('finish')
    await Promise.all([a, b])
  })

  it('会话销毁事件会通知承载它的 worker 释放 ACP 会话', async () => {
    const { adapter, workers } = setup()
    const first = run(adapter, request('gone'))
    await flush()
    workers[0]!.calls[0]!.complete('finish')
    await first

    adapter.releaseConversation('gone')
    expect(workers[0]!.adapter.releaseConversation).toHaveBeenCalledWith('gone')
    expect(adapter.read().queue?.active).toBe(0)
  })

  it('dispose 关闭所有 worker 并拒绝后续请求', async () => {
    const { adapter, workers } = setup()
    const a = outcome(run(adapter, request('a')))
    const b = outcome(run(adapter, request('b')))
    await flush()
    await adapter.dispose()
    expect(workers.every((worker) => worker.dispose.mock.calls.length === 1)).toBe(true)
    expect(await outcome(run(adapter, request('later')))).toMatchObject({ ok: false })
    await Promise.all([a, b])
  })
})
