/**
 * Host 与 Web Client 共享的模型家族分组、额度分组与隐藏列表规范化（纯函数，无 Node 依赖）。
 */
import type { QuotaBucket, QuotaSnapshot } from './rpc-contract.js'

export type ModelFamilyKey = 'gemini' | 'claude' | 'argon'

export interface ModelGroupMeta {
  readonly key: ModelFamilyKey
  readonly name: string
  readonly matchGroup: RegExp
  readonly matchModel: RegExp
}

export const MODEL_GROUPS: readonly ModelGroupMeta[] = [
  { key: 'gemini', name: 'Gemini', matchGroup: /gemini/i, matchModel: /gemini/i },
  { key: 'claude', name: 'Claude / GPT', matchGroup: /claude|gpt/i, matchModel: /claude|gpt/i },
  { key: 'argon', name: 'Argon', matchGroup: /argon/i, matchModel: /argon/i },
]

/** 根据模型 ID 归类所属额度家族（Argon 优先于 Gemini 匹配）。 */
export function modelGroupFor(id: string | undefined | null): ModelFamilyKey | undefined {
  if (!id) return undefined
  if (/argon/i.test(id)) return 'argon'
  if (/gemini/i.test(id)) return 'gemini'
  if (/claude|gpt/i.test(id)) return 'claude'
  return undefined
}

/** 根据额度组名归类所属家族。 */
export function quotaGroupKeyFor(name: string | undefined | null): ModelFamilyKey | undefined {
  if (!name) return undefined
  if (/argon/i.test(name)) return 'argon'
  if (/gemini/i.test(name)) return 'gemini'
  if (/claude|gpt/i.test(name)) return 'claude'
  return undefined
}

/** 规范化隐藏模型列表：去空白、去重、字典序排序，确保脏值比较与序列化稳定。 */
export function canonicalHiddenModels(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const unique = new Set<string>()
  for (const item of input) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed) unique.add(trimmed)
  }
  return [...unique].sort()
}

export function sameHiddenModels(a: unknown, b: unknown): boolean {
  const left = canonicalHiddenModels(a)
  const right = canonicalHiddenModels(b)
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

export interface GroupedQuotaEntry {
  key: string
  name: string
  buckets: QuotaBucket[]
}

/**
 * 将后端返回的额度组按预设家族聚合，同时保留未命中预设家族的原始组（绝不静默丢弃）。
 */
export function groupedQuotas(
  data: QuotaSnapshot | null | undefined,
  fallbackOtherName = '其他额度',
): GroupedQuotaEntry[] {
  const byKnownKey = new Map<string, QuotaBucket[]>()
  const unknownGroups = new Map<string, { name: string; buckets: QuotaBucket[] }>()

  for (const group of data?.groups ?? []) {
    if (!group.buckets || group.buckets.length === 0) continue
    const key = quotaGroupKeyFor(group.name)
    if (key) {
      const list = byKnownKey.get(key) ?? []
      list.push(...group.buckets)
      byKnownKey.set(key, list)
      continue
    }
    const displayName = group.name?.trim() || fallbackOtherName
    const unknownKey = `other:${displayName.toLowerCase()}`
    const existing = unknownGroups.get(unknownKey)
    if (existing) {
      existing.buckets.push(...group.buckets)
    } else {
      unknownGroups.set(unknownKey, { name: displayName, buckets: [...group.buckets] })
    }
  }

  const knownEntries: GroupedQuotaEntry[] = MODEL_GROUPS.map((meta) => ({
    key: meta.key,
    name: meta.name,
    buckets: byKnownKey.get(meta.key) ?? [],
  })).filter((entry) => entry.buckets.length > 0)

  const extraEntries: GroupedQuotaEntry[] = [...unknownGroups.entries()].map(([key, entry]) => ({
    key,
    name: entry.name,
    buckets: entry.buckets,
  }))

  return [...knownEntries, ...extraEntries]
}

/** 为给定模型匹配最相关的额度组（优先已知家族，其次按模型词元匹配未知组）。 */
export function matchQuotaGroupForModel(
  groups: readonly GroupedQuotaEntry[],
  model: string | undefined,
): GroupedQuotaEntry | undefined {
  const family = modelGroupFor(model)
  if (family) return groups.find((entry) => entry.key === family)
  if (!model || groups.length === 0) return undefined
  const tokens = model
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !/^\d+$/.test(token))
  for (const group of groups) {
    const lowerName = group.name.toLowerCase()
    if (tokens.some((token) => lowerName.includes(token))) return group
  }
  return groups.find((entry) => entry.key.startsWith('other:'))
}
