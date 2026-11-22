import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AcpLifecycleSnapshot } from '../runtime/lifecycle.js'
import type { AntigravityAcpAdapter } from '../adapter/antigravity-adapter.js'
import { AGY_TURN_ERROR } from '../adapter/prompt-turn.js'

/**
 * 每个对话一个官方 ACP 进程，按需启动、不设并发上限。
 *
 * 这里**不是并发池**：没有容量、没有等待队列、没有排队超时。真机探针确认
 * 官方 agent 单进程本身就能并发多个会话，但插件侧仍按「一对话一链接」分配，
 * 原因是每条链接各自持有 MCP 桥、工具授权代次与 prompt 生命周期——共享一个
 * 进程会让一次卡死/崩溃带走所有对话。会话数量不设限，靠空闲回收 + `session/resume`
 * 把进程数收敛到「活跃对话数」。
 */
export interface AcpWorker {
  adapter: Pick<AntigravityAcpAdapter, 'busy' | 'stream' | 'listModels' | 'resolveModel' | 'warmup' | 'discoverModels'> & Partial<Pick<AntigravityAcpAdapter, 'prepareCall' | 'releaseConversation' | 'ownsSession'>>
  ensureImages?: (signal?: AbortSignal) => Promise<void>
  read(): AcpLifecycleSnapshot
  dispose(): Promise<void>
}

interface Slot {
  worker: AcpWorker
  leased: boolean
  owner?: Pick<GenerateOptions, 'sessionId' | 'purpose'>
  /** 最近一次服务过的 DSH 对话：新对话优先用没服务过任何对话的 worker。 */
  lastOwner?: string
}

export class ConversationWorkers extends LlmAdapter {
  private readonly slots: Slot[] = []
  /** DSH 对话 → 承载它的 worker 下标：会话复用记录在 worker 内部，换 worker 即丢失。 */
  private readonly affinity = new Map<string, number>()
  private closed = false
  private readonly readSessionAffinity: () => boolean
  private get sessionAffinity(): boolean { return this.readSessionAffinity() }
  private preparation?: Promise<void>
  private preparationAbort?: AbortController
  private preparationWaiters = 0
  private prepared = false
  private preparationGeneration = 0
  private disposal?: Promise<void>

  constructor(private readonly create: () => AcpWorker, options: { sessionAffinity?: boolean | (() => boolean) } = {}) {
    super()
    const affinity = options.sessionAffinity ?? true
    this.readSessionAffinity = typeof affinity === 'function' ? affinity : () => affinity
    // 预先造一个 worker 对象（不 spawn 进程）：首个对话不必等惰性创建，也保证
    // 生命周期快照与设置热更新始终有可读取的 worker。
    this.addSlot()
  }

  get busy(): boolean { return this.slots.some(s => s.leased || s.worker.adapter.busy) }
  override providerInfo(provider: string) { return { id: provider, name: 'Antigravity (ACP)' } }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const lists = await Promise.all(this.slots.map(s => s.worker.adapter.listModels(provider)))
    return [...new Map(lists.flat().map(m => [m.id, m])).values()]
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const models = await Promise.all(this.slots.map(s => s.worker.adapter.resolveModel(provider, model, signal)))
    const first = models[0]
    if (!first) throw new LlmError('ACP 没有可用的模型元数据', 'AGY_MODEL_UNAVAILABLE')
    const known = models.find(m => m.name !== m.id)
    const reasoning = mergeReasoning(models)
    const modalities = models.every(m => m.inputModalities !== undefined)
      ? models.map(m => m.inputModalities!).reduce((supported, entries) => supported.filter(entry => entries.includes(entry)))
      : undefined
    return {
      ...first,
      inputModalities: undefined,
      ...(modalities === undefined ? {} : { inputModalities: modalities }),
      ...(known ? { name: known.name, ...(known.description === undefined ? {} : { description: known.description }) } : {}),
      ...(models.some(m => m.context !== undefined) ? { context: models.find(m => m.context !== undefined)!.context } : {}),
      ...(reasoning ? { reasoning } : {}),
    }
  }

  /** Recheck capabilities when host services change, without interrupting active callers. */
  invalidatePreparation(): void {
    this.preparationGeneration++
    this.prepared = false
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    if (this.closed) throw new LlmError('ACP 插件已卸载', 'AGY_LINK_CLOSED')
    if (signal?.aborted) throw new LlmError('ACP 请求已取消', AGY_TURN_ERROR.ABORTED)
    while (!this.prepared) {
      if (this.closed) throw new LlmError('ACP 插件已卸载', 'AGY_LINK_CLOSED')
      if (signal?.aborted) throw new LlmError('ACP 请求已取消', AGY_TURN_ERROR.ABORTED)
      if (!this.preparation) {
        const controller = new AbortController()
        const generation = this.preparationGeneration
        this.preparationAbort = controller
        const preparation = (async () => {
          const slot = this.takeWorker(undefined)
          try {
            await slot.worker.adapter.prepareCall?.(provider, model, controller.signal)
            if (!controller.signal.aborted && !this.closed && generation === this.preparationGeneration) this.prepared = true
          } finally { slot.leased = false }
        })().finally(() => {
          if (this.preparation === preparation) { this.preparation = undefined; this.preparationAbort = undefined }
        })
        this.preparation = preparation
      }
      this.preparationWaiters++
      try { await waitWithSignal(this.preparation, signal) }
      finally {
        this.preparationWaiters--
        if (!this.preparationWaiters && !this.prepared) this.preparationAbort?.abort()
      }
    }
    if (this.closed) throw new LlmError('ACP 插件已卸载', 'AGY_LINK_CLOSED')
    return { model: await this.resolveModel(provider, model, signal), stream: options => this.stream(options) }
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (this.closed) throw new LlmError('ACP 插件已卸载', 'AGY_LINK_CLOSED')
    if (options.signal?.aborted) throw new LlmError('ACP 请求在发起前已取消', AGY_TURN_ERROR.ABORTED)
    const slot = this.takeWorker(options)
    try {
      // 握手失败或取消也必须归还连接，不能把某条链接永久占住。
      if (slot.worker.ensureImages && hasImageInput(options)) await slot.worker.ensureImages(options.signal)
      slot.owner = { sessionId: options.sessionId, purpose: options.purpose }
      const affinityKey = this.affinityKey(options)
      if (affinityKey !== undefined) this.rememberAffinity(affinityKey, this.slots.indexOf(slot))
      yield* slot.worker.adapter.stream(options)
    } finally {
      slot.leased = false
      if (!slot.worker.adapter.busy) slot.owner = undefined
      if (this.sessionAffinity && options.sessionId !== undefined && options.purpose === undefined) slot.lastOwner = options.sessionId
    }
  }

  async warmup(signal?: AbortSignal): Promise<void> {
    if (this.busy) return
    const slot = this.takeWorker(undefined)
    try { await slot.worker.adapter.warmup(signal) }
    finally { slot.leased = false }
  }

  async discoverModels(signal?: AbortSignal, interactive = true): Promise<readonly LlmModelInfo[]> {
    const slot = this.takeWorker(undefined)
    try { return await slot.worker.adapter.discoverModels(signal, interactive) }
    finally { slot.leased = false }
  }

  /** DSH 会话被销毁：通知承载它的 worker 释放 ACP 会话与映射。 */
  releaseConversation(dshSessionId: string): void {
    const index = this.affinity.get(dshSessionId)
    const slot = index === undefined ? undefined : this.slots[index]
    slot?.worker.adapter.releaseConversation?.(dshSessionId)
    this.affinity.delete(dshSessionId)
  }

  read(): AcpLifecycleSnapshot {
    const rows = this.slots.map(s => s.worker.read())
    const index = this.slots.findIndex(s => s.leased || s.worker.adapter.busy)
    const current = rows[index >= 0 ? index : rows.findIndex(r => r.processRunning)] ?? rows[0]
    const base: AcpLifecycleSnapshot = current ?? {
      phase: 'idle', phaseElapsedMs: 0, processRunning: false, starts: 0, reuses: 0, recycles: 0,
    }
    return {
      ...base,
      starts: rows.reduce((n, r) => n + r.starts, 0),
      reuses: rows.reduce((n, r) => n + r.reuses, 0),
      recycles: rows.reduce((n, r) => n + r.recycles, 0),
      processRunning: rows.some(r => r.processRunning),
      queue: {
        active: this.slots.filter(s => s.leased).length,
        waiting: 0,
        capacity: this.slots.length,
        workers: rows.filter(r => r.processRunning).length,
        parked: this.slots.filter(s => !s.leased && s.worker.adapter.busy).length,
      },
    }
  }

  dispose(): Promise<void> {
    this.disposal ??= this.disposeWorkers()
    return this.disposal
  }

  private async disposeWorkers(): Promise<void> {
    this.closed = true
    this.preparationAbort?.abort()
    const results = await Promise.allSettled(this.slots.map(s => s.worker.dispose()))
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) throw failed.reason
  }

  private addSlot(): Slot {
    const slot: Slot = { worker: this.create(), leased: false }
    this.slots.push(slot)
    return slot
  }

  /**
   * 取一个 worker 并立即租用：优先同一对话的驻留链接，其次空闲链接，最后按需新建。
   * 标题这类一次性请求**不新建进程**，没有空闲链接时直接报错，让宿主保留兜底标题。
   */
  private takeWorker(options?: GenerateOptions): Slot {
    if (this.closed) throw new LlmError('ACP 插件已卸载', 'AGY_LINK_CLOSED')
    const slot = this.select(options)
    if (slot) { slot.leased = true; return slot }
    throw new LlmError('没有空闲的 ACP 连接，标题请求已跳过', 'AGY_NO_IDLE_WORKER')
  }

  /** 只有普通聊天轮参与粘性；标题/压缩等一次性请求不占用会话绑定。 */
  private affinityKey(options?: GenerateOptions): string | undefined {
    if (!this.sessionAffinity || !options?.sessionId || options.purpose !== undefined) return undefined
    return options.sessionId
  }

  private rememberAffinity(key: string, index: number): void {
    if (index < 0) return
    this.affinity.delete(key)
    this.affinity.set(key, index)
    while (this.affinity.size > 512) {
      const oldest = this.affinity.keys().next().value
      if (oldest === undefined) break
      this.affinity.delete(oldest)
    }
  }

  private select(options?: GenerateOptions): Slot | undefined {
    const owner = options && this.slots.find(s => s.owner
      && (s.leased || s.worker.adapter.busy)
      && s.owner.sessionId === options.sessionId
      && (s.owner.purpose === options.purpose || options.purpose === 'compaction'))
    if (owner) return owner.leased ? undefined : owner

    const affinityKey = this.affinityKey(options)
    if (affinityKey !== undefined) {
      const pinned = this.slots[this.affinity.get(affinityKey) ?? -1]
      if (pinned && !pinned.leased && !pinned.worker.adapter.busy) return pinned
      // affinity 只是缓存：真丢了就按「谁真正持有该会话映射」重新定位。
      // 否则会把对话派给另一个 worker，那边认领不到映射只能报
      // AGY_SESSION_UNRECOVERABLE，而持有者就在旁边闲着。
      const holder = this.slots.find(s => !s.leased && !s.worker.adapter.busy
        && s.worker.adapter.ownsSession?.(affinityKey) === true)
      if (holder) {
        this.rememberAffinity(affinityKey, this.slots.indexOf(holder))
        return holder
      }
      // 持有者正忙（例如上一轮的工具续轮还没收尾）：等它，而不是另起一个
      // 没有映射的 worker 把对话判死。返回 undefined 让上层报「连接忙」，
      // 宿主会重试；这比 AGY_SESSION_UNRECOVERABLE 好得多——后者是不可恢复的。
      const busyHolder = this.slots.find(s => s.worker.adapter.ownsSession?.(affinityKey) === true)
      if (busyHolder) {
        this.rememberAffinity(affinityKey, this.slots.indexOf(busyHolder))
        return undefined
      }
    }

    const free = this.slots.filter(s => !s.leased && !s.worker.adapter.busy)
    if (free.length > 0) {
      if (affinityKey !== undefined) {
        const unbound = free.find(s => s.lastOwner === undefined)
        if (unbound) return unbound
      }
      return free[0]
    }
    // 标题是纯装饰请求：不新建进程，直接放弃。
    if (options?.purpose === 'session-title') return undefined
    return this.addSlot()
  }
}

function hasImageInput(options: GenerateOptions): boolean {
  return options.messages.some(message => message.role === 'tool'
    ? message.content.some(block => block.type === 'image')
    : Array.isArray(message.content) && message.content.some(block => block.type === 'image'))
}

/** 已知档位的强弱顺序；agent 声明的其它值（含 xhigh）排在最后，不参与猜测。 */
const effortOrder: Record<string, number> = { low: 0, medium: 1, high: 2, xhigh: 3 }
function mergeReasoning(models: readonly LlmResolvedModelInfo[]): LlmResolvedModelInfo['reasoning'] {
  const known = models.filter(model => model.reasoning !== undefined)
  if (known.length === 0) return undefined
  const efforts = [...new Map(known.flatMap(model => model.reasoning!.efforts).map(entry => [entry.id.toString(), entry])).values()]
    .sort((a, b) => (effortOrder[a.id.toString()] ?? 99) - (effortOrder[b.id.toString()] ?? 99))
  const preferred = known.map(model => model.reasoning!.defaultEffort?.toString()).find(value => value !== undefined)
  const fallback = efforts.find(entry => entry.id.toString() === preferred) ?? efforts.find(entry => entry.id.toString() === 'medium')
  return { efforts, ...(fallback ? { defaultEffort: fallback.id } : {}) }
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = (): void => { cleanup(); reject(new LlmError('ACP 请求已取消', AGY_TURN_ERROR.ABORTED)) }
    const cleanup = (): void => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    if (signal.aborted) abort()
  })
}
