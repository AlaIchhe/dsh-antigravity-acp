/**
 * 全局唯一的模型目录与元数据仓库（取代各 worker 各自存一份再广播同步的设计）。
 *
 * 职责：
 * - 只观测，不自造：模型来自 ACP `session/new` / `config_option_update` 观测（或同版本磁盘缓存）
 *   与官方只读 `agy models` 清单并集；
 * - 统一管理 `thought_level` 档位元数据、实测上下文窗口容量与图像输入能力；
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

function effortRank(id: string): number {
  const index = (EFFORT_ORDER as readonly string[]).indexOf(id)
  return index === -1 ? EFFORT_ORDER.length : index
}

export class CatalogStore {
  #acpModels = new Map<string, CatalogModelEntry>()
  #cliModels = new Map<string, CatalogModelEntry>()
  #contextWindows = new Map<string, number>()
  #thoughtLevel: ThoughtLevelSelector | undefined
  #imageSupported: boolean | undefined
  #cacheLoaded = false
  #cacheLoading: Promise<void> | undefined
  readonly #options: CatalogStoreOptions

  constructor(options: CatalogStoreOptions) {
    this.#options = options
  }

  get thoughtLevel(): ThoughtLevelSelector | undefined {
    return this.#thoughtLevel
  }

  get imageSupported(): boolean | undefined {
    return this.#imageSupported
  }

  setImageSupported(supported: boolean): void {
    if (this.#imageSupported === supported) return
    this.#imageSupported = supported
    this.#options.onCatalogChanged?.()
  }

  noteContextWindow(modelId: string, size: number): void {
    if (!modelId || !Number.isFinite(size) || size <= 0) return
    const rounded = Math.trunc(size)
    if (this.#contextWindows.get(modelId) === rounded) return
    this.#contextWindows.set(modelId, rounded)
    const existing = this.#acpModels.get(modelId)
    if (existing) existing.contextWindow = rounded
    void this.#saveCache()
    this.#options.onCatalogChanged?.()
  }

  observeConfigOptions(configOptions: readonly SessionConfigOption[] | null | undefined): boolean {
    if (!configOptions?.length) return false
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

    const thought = findThoughtLevelSelector(configOptions)
    if (thought && thought.options.length > 0) {
      const prevKey = JSON.stringify(this.#thoughtLevel ?? null)
      const nextKey = JSON.stringify(thought)
      if (prevKey !== nextKey) {
        this.#thoughtLevel = thought
        changed = true
      }
    }

    if (changed) {
      void this.#saveCache()
      this.#options.onCatalogChanged?.()
    }
    return changed
  }

  /** 刷新 CLI 只读清单（用于补齐 ACP 尚未观测到的模型）。 */
  async refreshCliModels(force = false): Promise<void> {
    if (!this.#options.loadCliModels) return
    try {
      const rows = await this.#options.loadCliModels(force)
      const next = new Map<string, CatalogModelEntry>()
      for (const row of rows) {
        next.set(row.id, { id: row.id, name: row.name })
      }
      if (!sameModelMap(this.#cliModels, next)) {
        this.#cliModels = next
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
    const known = this.#acpModels.get(modelId) ?? this.#cliModels.get(modelId)
    const modalities = this.#inputModalities()
    const contextWindow = this.#contextWindows.get(modelId) ?? known?.contextWindow
    const reasoning = this.#buildReasoningInfo()
    return {
      provider,
      id: modelId,
      name: known?.name ?? modelId,
      ...(known?.description ? { description: known.description } : {}),
      ...(modalities === undefined ? {} : { inputModalities: modalities }),
      ...(contextWindow === undefined ? {} : { context: { contextWindow } }),
      ...(reasoning ? { reasoning } : {}),
    }
  }

  #inputModalities(): readonly ('text' | 'image')[] | undefined {
    if (!(this.#options.canReadImages?.() ?? false)) return ['text']
    if (this.#imageSupported === undefined) return undefined
    return this.#imageSupported ? ['text', 'image'] : ['text']
  }

  #buildReasoningInfo(): LlmModelReasoningInfo | undefined {
    const selector = this.#thoughtLevel
    if (!selector || selector.options.length === 0) return undefined
    const efforts = [...selector.options]
      .sort((a, b) => effortRank(a.value) - effortRank(b.value))
      .map((opt) => ({
        id: ReasoningEffortId(opt.value),
        name: opt.name,
        ...(opt.description ? { description: opt.description } : {}),
      }))
    const defaultValue = selector.currentValue ?? efforts.find((e) => e.id.toString() === 'medium')?.id.toString() ?? efforts[0]!.id.toString()
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
            if (!this.#acpModels.has(row.id)) {
              this.#acpModels.set(row.id, {
                id: row.id,
                name: row.name,
                ...(typeof row.description === 'string' ? { description: row.description } : {}),
                ...(typeof row.contextWindow === 'number' && row.contextWindow > 0 ? { contextWindow: row.contextWindow } : {}),
              })
            }
            if (typeof row.contextWindow === 'number' && row.contextWindow > 0 && !this.#contextWindows.has(row.id)) {
              this.#contextWindows.set(row.id, Math.trunc(row.contextWindow))
            }
          }
        }
        if (!this.#thoughtLevel && parsed.thoughtLevel && typeof parsed.thoughtLevel.configId === 'string' && Array.isArray(parsed.thoughtLevel.options) && parsed.thoughtLevel.options.length > 0) {
          this.#thoughtLevel = {
            configId: parsed.thoughtLevel.configId,
            options: parsed.thoughtLevel.options,
            ...(parsed.thoughtLevel.currentValue ? { currentValue: parsed.thoughtLevel.currentValue } : {}),
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

  async #saveCache(): Promise<void> {
    if (!this.#options.cacheDir || this.#acpModels.size === 0) return
    const payload: CatalogCacheFile = {
      format: CATALOG_CACHE_FORMAT,
      acpVersion: this.#options.acpVersion,
      models: [...this.#acpModels.values()],
      ...(this.#thoughtLevel
        ? {
            thoughtLevel: {
              configId: this.#thoughtLevel.configId,
              options: this.#thoughtLevel.options.map((opt) => ({
                value: opt.value,
                name: opt.name,
                ...(opt.description ? { description: opt.description } : {}),
              })),
              ...(this.#thoughtLevel.currentValue ? { currentValue: this.#thoughtLevel.currentValue } : {}),
            },
          }
        : {}),
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
