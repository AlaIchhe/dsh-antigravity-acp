/**
 * Host 与 Web Client 共享的模型家族分组与隐藏列表规范化（纯函数，无 Node 依赖）。
 */

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
