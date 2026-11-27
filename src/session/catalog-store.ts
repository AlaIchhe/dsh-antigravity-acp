/**
 * 全局唯一的模型目录与元数据仓库（取代各 worker 各自存一份再广播同步的设计）。
 *
 * 职责：
 * - 只观测，不自造：模型来自 ACP `session/new` / `config_option_update` 观测（或同版本磁盘缓存）
 *   与官方只读 `agy models` 清单并集；
 * - 按模型维度隔离 `thought_level` 档位元数据（并集官方 CLI 家族档位，避免 Hydrogen/Neon 的
 *   `xhigh` 串台到 Carbon/Claude 或被其它模型冲掉）；
 * - 统一管理实测上下文窗口容量与图像输入能力；
 * - 统一应用 `hiddenModels` 过滤，对设置页提供未过滤的完整行。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmModelReasoningInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { canonicalHiddenModels } from '../shared/model-groups.js'
import { PROVIDER_ID } from '../shared/rpc-contract.js'
import { writeAtomicJson } from '../storage/atomic-json.js'
import { findModelSelector, findThoughtLevelSelector } from './model-router.js'
import type { ThoughtLevelSelector } from './model-router.js'
import type { CliModelEntry } from '../runtime/agy-cli.js'

const CATALOG_CACHE_FORMAT = 3
const CATALOG_FILE = 'catalog.json'

export interface CatalogModelEntry {
  id: string
  name: string
  description?: string
  contextWindow?: number
}

export interface CachedThoughtLevel {
  configId: string
  options: Array<{ value: string; name: string; description?: string }>
  currentValue?: string
}

interface CatalogCacheFile {
  format: number
  acpVersion: string
  models: CatalogModelEntry[]
  thoughtLevel?: CachedThoughtLevel
  modelThoughtLevels?: Record<string, CachedThoughtLevel>
}

export interface CatalogStoreOptions {
  cacheDir?: string
  acpVersion: string
  readHiddenModels?: () => readonly string[] | undefined
  canReadImages?: () => boolean
  loadCliModels?: (force?: boolean) => Promise<readonly CliModelEntry[]>
  onCatalogChanged?: () => void
}

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const TIER_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
}

const DEFAULT_GEMINI_CONTEXT_WINDOW = 1_048_576
const DEFAULT_CLAUDE_CONTEXT_WINDOW = 200_000
const DEFAULT_FALLBACK_CONTEXT_WINDOW = 128_000

/**
 * 尚未拿到真实会话 `usage_update.size` 前的保守默认上下文窗口，避免已有会话首次切入
 * Antigravity 模型时被 DSH `compaction-basic` 的 `no context capacity` 检查直接阻断。
 * 仅作内存兜底，绝不写入 `catalog.json`；一旦收到上游实测值即被精确覆盖。
 */
export function defaultContextWindowFor(modelId: string): number {
  if (/gemini/i.test(modelId)) return DEFAULT_GEMINI_CONTEXT_WINDOW
  if (/claude/i.test(modelId)) return DEFAULT_CLAUDE_CONTEXT_WINDOW
  return DEFAULT_FALLBACK_CONTEXT_WINDOW
}

function effortRank(id: string): number {
  const index = (EFFORT_ORDER as readonly string[]).indexOf(id)
  return index === -1 ? EFFORT_ORDER.length : index
}

/**
 * 非权威观测时要保留的 `currentValue`：只在它仍是这个模型声明的档位时才留下。
 * 指向未声明档位的默认值会被 DSH 判为非法元数据，整条模型不可用。
 */
function keepDeclared(
  current: string | undefined,
  options: readonly { value: string }[],
): string | undefined {
  if (current === undefined) return undefined
  return options.some((opt) => opt.value === current) ? current : undefined
}

function serializeThoughtLevel(selector: ThoughtLevelSelector): CachedThoughtLevel {
  return {
    configId: selector.configId,
    options: selector.options.map((opt) => ({
      value: opt.value,
      name: opt.name,
      ...(opt.description ? { description: opt.description } : {}),
    })),
    ...(selector.currentValue ? { currentValue: selector.currentValue } : {}),
  }
}

export class CatalogStore {
  #acpModels = new Map<string, CatalogModelEntry>()
  #cliModels = new Map<string, CatalogModelEntry>()
  #cliFamilyTiers = new Map<string, readonly string[]>()
  #contextWindows = new Map<string, number>()
  #thoughtLevel: ThoughtLevelSelector | undefined
  #modelThoughtLevels = new Map<string, ThoughtLevelSelector>()
  #imageSupported: boolean | undefined
  #cacheLoaded = false
  #cacheLoading: Promise<void> | undefined
  #writes: Promise<void> = Promise.resolve()
  readonly #options: CatalogStoreOptions

  constructor(options: CatalogStoreOptions) {
    this.#options = options
  }

  get thoughtLevel(): ThoughtLevelSelector | undefined {
    return this.#thoughtLevel
  }

  thoughtLevelFor(modelId: string): ThoughtLevelSelector | undefined {
    return this.#modelThoughtLevels.get(modelId)
  }

  get imageSupported(): boolean | undefined {
    return this.#imageSupported
  }

  setImageSupported(supported: boolean): void {
    if (this.#imageSupported === supported) return
    this.#imageSupported = supported
    this.#options.onCatalogChanged?.()
  }

  clearCliModels(): void {
    if (this.#cliModels.size === 0 && this.#cliFamilyTiers.size === 0) return
    this.#cliModels.clear()
    this.#cliFamilyTiers.clear()
  }

  noteContextWindow(modelId: string, size: number): void {
    if (!modelId || !Number.isFinite(size) || size <= 0) return
    const rounded = Math.trunc(size)
    if (this.#contextWindows.get(modelId) === rounded) return
    this.#contextWindows.set(modelId, rounded)
    const existing = this.#acpModels.get(modelId)
    if (existing) existing.contextWindow = rounded
    this.#enqueueSave()
    this.#options.onCatalogChanged?.()
  }

  /**
   * 吸收一次 agent `session/new` / `set_config_option` / `config_option_update` 返回的 configOptions。
   *
   * - `currentValue`（思考档位）会成为模型元数据的 `defaultEffort`，**只有聊天会话有权写它**
   *   （标题 / 压缩 / 探针等 `authoritative: false` 观测只学选项表、保留已有 `currentValue`）。
   * - 同时按 `modelSelector.currentValue` 分模型记录 `#modelThoughtLevels`，彻底避免
   *   Hydrogen/Neon 的 `xhigh` 串台到 Carbon/Claude 或被低档位模型覆盖。
   */
  observeConfigOptions(
    configOptions: readonly SessionConfigOption[] | null | undefined,
    options?: { readonly authoritative?: boolean; readonly modelId?: string },
  ): boolean {
    if (!configOptions?.length) return false
    const authoritative = options?.authoritative !== false
    let changed = false

    const modelSelector = findModelSelector(configOptions)
    if (modelSelector && modelSelector.options.length > 0) {
      const next = new Map<string, CatalogModelEntry>()
      for (const opt of modelSelector.options) {
        const prevWindow = this.#contextWindows.get(opt.value)
        next.set(opt.value, {
          id: opt.value,
          name: opt.name,
          ...(opt.description ? { description: opt.description } : {}),
          ...(prevWindow === undefined ? {} : { contextWindow: prevWindow }),
        })
      }
      if (!sameModelMap(this.#acpModels, next)) {
        this.#acpModels = next
        changed = true
      }
    }

    const activeModelId = modelSelector?.currentValue ?? options?.modelId
    const thought = findThoughtLevelSelector(configOptions)
    if (thought && thought.options.length > 0) {
      // 1. 按模型维度精准记录该模型声明的 thought_level
      if (activeModelId) {
        const prevModel = this.#modelThoughtLevels.get(activeModelId)
        const modelCurrent = authoritative
          ? thought.currentValue
          : keepDeclared(prevModel?.currentValue, thought.options)
        const nextModel: ThoughtLevelSelector = {
          configId: thought.configId,
          options: thought.options,
          ...(modelCurrent === undefined ? {} : { currentValue: modelCurrent }),
        }
        if (JSON.stringify(prevModel ?? null) !== JSON.stringify(nextModel)) {
          this.#modelThoughtLevels.set(activeModelId, nextModel)
          changed = true
        }
      }

      // 2. 更新全局兜底槽（仅用于尚未观测且无 CLI 档位清单的模型）
      const fallbackCurrent = authoritative
        ? thought.currentValue
        : keepDeclared(this.#thoughtLevel?.currentValue, thought.options)
      const nextFallback: ThoughtLevelSelector = {
        configId: thought.configId,
        options: thought.options,
        ...(fallbackCurrent === undefined ? {} : { currentValue: fallbackCurrent }),
      }
      if (JSON.stringify(this.#thoughtLevel ?? null) !== JSON.stringify(nextFallback)) {
        this.#thoughtLevel = nextFallback
        changed = true
      }
    }

    if (changed) {
      this.#enqueueSave()
      this.#options.onCatalogChanged?.()
    }
    return changed
  }

  /** 等待所有排队的目录缓存落盘完成。 */
  async flush(): Promise<void> {
    await this.#writes
  }

  /** 刷新 CLI 只读清单（用于补齐 ACP 尚未观测到的模型以及每个家族的实际思考档位）。 */
  async refreshCliModels(force = false): Promise<void> {
    if (!this.#options.loadCliModels) return
    if (!force && this.#cliModels.size > 0) return
    try {
      const rows = await this.#options.loadCliModels(force)
      const next = new Map<string, CatalogModelEntry>()
      const nextTiers = new Map<string, readonly string[]>()
      for (const row of rows) {
        next.set(row.id, { id: row.id, name: row.name })
        if (row.tiers !== undefined) nextTiers.set(row.id, [...row.tiers])
      }
      const tiersChanged = !sameTiersMap(this.#cliFamilyTiers, nextTiers)
      if (!sameModelMap(this.#cliModels, next) || tiersChanged) {
        this.#cliModels = next
        this.#cliFamilyTiers = nextTiers
        this.#options.onCatalogChanged?.()
      }
    } catch {
      // CLI 补齐失败不阻断目录读取。
    }
  }

  /** 给 DSH 模型选择器的列表（已过滤 `hiddenModels`）。 */
  async listVisibleModels(provider = PROVIDER_ID): Promise<LlmModelInfo[]> {
    const all = await this.listAllModels(provider)
    const hidden = new Set(canonicalHiddenModels(this.#options.readHiddenModels?.()))
    return all.filter((model) => !hidden.has(model.id))
  }

  /** 给设置页展示的完整模型列表（不含隐藏过滤，以便重新启用）。 */
  async listAllModels(provider = PROVIDER_ID): Promise<LlmModelInfo[]> {
    await this.#ensureCacheLoaded()
    if (this.#acpModels.size === 0 && this.#cliModels.size === 0) {
      await this.refreshCliModels(false)
    }
    const merged = new Map<string, CatalogModelEntry>()
    for (const [id, entry] of this.#acpModels) merged.set(id, entry)
    for (const [id, entry] of this.#cliModels) {
      if (!merged.has(id)) merged.set(id, entry)
    }
    const modalities = this.#inputModalities()
    return [...merged.values()].map((entry) => ({
      provider,
      id: entry.id,
      name: entry.name,
      ...(entry.description ? { description: entry.description } : {}),
      ...(modalities === undefined ? {} : { inputModalities: modalities }),
    }))
  }

  async resolveModel(provider: string, modelId: string): Promise<LlmResolvedModelInfo> {
    await this.#ensureCacheLoaded()
    if (this.#cliModels.size === 0 && this.#cliFamilyTiers.size === 0 && this.#options.loadCliModels) {
      await this.refreshCliModels(false)
    }
    const known = this.#acpModels.get(modelId) ?? this.#cliModels.get(modelId)
    const modalities = this.#inputModalities()
    const contextWindow = this.#contextWindows.get(modelId)
      ?? known?.contextWindow
      ?? defaultContextWindowFor(modelId)
    const reasoning = this.#buildReasoningInfo(modelId)
    return {
      provider,
      id: modelId,
      name: known?.name ?? modelId,
      ...(known?.description ? { description: known.description } : {}),
      ...(modalities === undefined ? {} : { inputModalities: modalities }),
      context: { contextWindow },
      ...(reasoning ? { reasoning } : {}),
    }
  }

  #inputModalities(): readonly ('text' | 'image')[] | undefined {
    if (!(this.#options.canReadImages?.() ?? false)) return ['text']
    if (this.#imageSupported === undefined) return undefined
    return this.#imageSupported ? ['text', 'image'] : ['text']
  }

  #buildReasoningInfo(modelId: string): LlmModelReasoningInfo | undefined {
    const exact = this.#modelThoughtLevels.get(modelId)
    const cliTiers = this.#cliFamilyTiers.get(modelId)

    // CLI 明确表明该家族没有任何档位（如 gemini-pro-orchestrator）且 ACP 也未为其单独观测过档位：
    // 绝不借用其它模型的全局 thoughtLevel。
    if (!exact && cliTiers !== undefined && cliTiers.length === 0) return undefined

    const optionByValue = new Map<string, { value: string; name: string; description?: string }>()
    const labelLookup = new Map<string, { name: string; description?: string }>()
    for (const opt of this.#thoughtLevel?.options ?? []) {
      labelLookup.set(opt.value, { name: opt.name, ...(opt.description ? { description: opt.description } : {}) })
    }
    for (const opt of exact?.options ?? []) {
      labelLookup.set(opt.value, { name: opt.name, ...(opt.description ? { description: opt.description } : {}) })
    }

    if (exact) {
      for (const opt of exact.options) {
        optionByValue.set(opt.value, { value: opt.value, name: opt.name, ...(opt.description ? { description: opt.description } : {}) })
      }
      // 并上官方 CLI 目录里该家族真实存在的档位（如 Hydrogen / Neon 的 xhigh）。
      for (const tier of cliTiers ?? []) {
        if (!optionByValue.has(tier)) {
          const meta = labelLookup.get(tier)
          optionByValue.set(tier, { value: tier, name: meta?.name ?? TIER_LABELS[tier] ?? tier, ...(meta?.description ? { description: meta.description } : {}) })
        }
      }
    } else if (cliTiers !== undefined && cliTiers.length > 0) {
      // 未直接跑过该模型，但 CLI 已给出该家族的精确档位表：严格只暴露它自己的档位，
      // 防止 Hydrogen/Neon 的 xhigh 串台到 Carbon/Argon/Claude/Flash。
      for (const tier of cliTiers) {
        const meta = labelLookup.get(tier)
        optionByValue.set(tier, { value: tier, name: meta?.name ?? TIER_LABELS[tier] ?? tier, ...(meta?.description ? { description: meta.description } : {}) })
      }
    } else if (this.#thoughtLevel && this.#thoughtLevel.options.length > 0) {
      for (const opt of this.#thoughtLevel.options) {
        optionByValue.set(opt.value, { value: opt.value, name: opt.name, ...(opt.description ? { description: opt.description } : {}) })
      }
    } else {
      return undefined
    }

    const efforts = [...optionByValue.values()]
      .sort((a, b) => effortRank(a.value) - effortRank(b.value))
      .map((opt) => ({
        id: ReasoningEffortId(opt.value),
        name: opt.name,
        ...(opt.description ? { description: opt.description } : {}),
      }))
    if (efforts.length === 0) return undefined

    const preferred = keepDeclared(exact?.currentValue, optionByValue.size > 0 ? [...optionByValue.values()] : [])
      ?? keepDeclared(this.#thoughtLevel?.currentValue, [...optionByValue.values()])
    const defaultValue = preferred
      ?? efforts.find((e) => e.id.toString() === 'medium')?.id.toString()
      ?? efforts[0]!.id.toString()

    return {
      efforts,
      defaultEffort: ReasoningEffortId(defaultValue),
    }
  }

  async #ensureCacheLoaded(): Promise<void> {
    if (this.#cacheLoaded || !this.#options.cacheDir) return
    this.#cacheLoading ??= (async () => {
      try {
        const raw = await readFile(join(this.#options.cacheDir!, CATALOG_FILE), 'utf8')
        const parsed = JSON.parse(raw) as Partial<CatalogCacheFile>
        if (parsed.format !== CATALOG_CACHE_FORMAT || parsed.acpVersion !== this.#options.acpVersion) return
        if (Array.isArray(parsed.models)) {
          for (const row of parsed.models) {
            if (!row || typeof row.id !== 'string' || !row.id || typeof row.name !== 'string') continue
            const diskWindow = typeof row.contextWindow === 'number' && row.contextWindow > 0
              ? Math.trunc(row.contextWindow)
              : undefined
            if (diskWindow !== undefined && !this.#contextWindows.has(row.id)) {
              this.#contextWindows.set(row.id, diskWindow)
            }
            const effectiveWindow = this.#contextWindows.get(row.id) ?? diskWindow
            if (!this.#acpModels.has(row.id)) {
              this.#acpModels.set(row.id, {
                id: row.id,
                name: row.name,
                ...(typeof row.description === 'string' ? { description: row.description } : {}),
                ...(effectiveWindow === undefined ? {} : { contextWindow: effectiveWindow }),
              })
            } else if (effectiveWindow !== undefined) {
              const existing = this.#acpModels.get(row.id)!
              if (existing.contextWindow === undefined) existing.contextWindow = effectiveWindow
            }
          }
        }
        if (!this.#thoughtLevel && parsed.thoughtLevel && typeof parsed.thoughtLevel.configId === 'string' && Array.isArray(parsed.thoughtLevel.options) && parsed.thoughtLevel.options.length > 0) {
          const currentValue = keepDeclared(parsed.thoughtLevel.currentValue, parsed.thoughtLevel.options)
          this.#thoughtLevel = {
            configId: parsed.thoughtLevel.configId,
            options: parsed.thoughtLevel.options,
            ...(currentValue === undefined ? {} : { currentValue }),
          }
        }
        if (parsed.modelThoughtLevels && typeof parsed.modelThoughtLevels === 'object' && !Array.isArray(parsed.modelThoughtLevels)) {
          for (const [modelId, entry] of Object.entries(parsed.modelThoughtLevels)) {
            if (!modelId || this.#modelThoughtLevels.has(modelId)) continue
            if (!entry || typeof entry.configId !== 'string' || !Array.isArray(entry.options) || entry.options.length === 0) continue
            const currentValue = keepDeclared(entry.currentValue, entry.options)
            this.#modelThoughtLevels.set(modelId, {
              configId: entry.configId,
              options: entry.options,
              ...(currentValue === undefined ? {} : { currentValue }),
            })
          }
        }
      } catch {
        // 缓存缺失或损坏静默忽略。
      } finally {
        this.#cacheLoaded = true
      }
    })()
    await this.#cacheLoading
  }

  #enqueueSave(): void {
    if (!this.#options.cacheDir) return
    this.#writes = this.#writes.then(async () => {
      await this.#ensureCacheLoaded()
      await this.#saveCache()
    }).catch(() => {
      // 缓存写失败不影响正常对话。
    })
  }

  async #saveCache(): Promise<void> {
    if (!this.#options.cacheDir || this.#acpModels.size === 0) return
    const modelThoughtLevels: Record<string, CachedThoughtLevel> = {}
    for (const [modelId, selector] of this.#modelThoughtLevels) {
      modelThoughtLevels[modelId] = serializeThoughtLevel(selector)
    }
    const payload: CatalogCacheFile = {
      format: CATALOG_CACHE_FORMAT,
      acpVersion: this.#options.acpVersion,
      models: [...this.#acpModels.values()].map((entry) => {
        const win = this.#contextWindows.get(entry.id) ?? entry.contextWindow
        return win === undefined ? entry : { ...entry, contextWindow: win }
      }),
      ...(this.#thoughtLevel ? { thoughtLevel: serializeThoughtLevel(this.#thoughtLevel) } : {}),
      ...(Object.keys(modelThoughtLevels).length > 0 ? { modelThoughtLevels } : {}),
    }
    try {
      await writeAtomicJson(join(this.#options.cacheDir, CATALOG_FILE), payload, 0o600)
    } catch {
      // 缓存写失败不影响正常对话。
    }
  }
}

function sameModelMap(a: Map<string, CatalogModelEntry>, b: Map<string, CatalogModelEntry>): boolean {
  if (a.size !== b.size) return false
  for (const [id, entry] of a) {
    const other = b.get(id)
    if (!other || other.name !== entry.name || other.description !== entry.description || other.contextWindow !== entry.contextWindow) {
      return false
    }
  }
  return true
}

function sameTiersMap(a: Map<string, readonly string[]>, b: Map<string, readonly string[]>): boolean {
  if (a.size !== b.size) return false
  for (const [id, tiers] of a) {
    const other = b.get(id)
    if (!other || other.length !== tiers.length || other.some((v, idx) => v !== tiers[idx])) return false
  }
  return true
}
