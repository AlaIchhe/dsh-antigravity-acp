/**
 * 工具参数签名渲染与参数预检（纯函数，无 IO）。
 */
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

export interface ToolArgumentIssues {
  missing: string[]
  unknown: string[]
}

const MAX_ENUM_VALUES = 6
const MAX_UNION_PARTS = 4

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function requiredKeys(parameters: unknown): string[] {
  const required = asRecord(parameters)?.required
  return Array.isArray(required) ? required.filter((key): key is string => typeof key === 'string') : []
}

function renderType(schema: unknown, depth = 0): string {
  const node = asRecord(schema)
  if (!node) return 'any'
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const values = node.enum.slice(0, MAX_ENUM_VALUES).map((value) => JSON.stringify(value))
    return node.enum.length > MAX_ENUM_VALUES ? `${values.join('|')}|…` : values.join('|')
  }
  if (node.const !== undefined) return JSON.stringify(node.const)
  for (const key of ['anyOf', 'oneOf'] as const) {
    const parts = node[key]
    if (Array.isArray(parts) && parts.length > 0 && depth < 2) {
      return parts.slice(0, MAX_UNION_PARTS).map((part) => renderType(part, depth + 1)).join('|')
    }
  }
  const type = node.type
  if (Array.isArray(type)) return type.filter((item): item is string => typeof item === 'string').join('|') || 'any'
  if (type === 'array') return depth < 2 ? `${renderType(node.items, depth + 1)}[]` : 'array'
  if (typeof type === 'string') return type
  return 'any'
}

export function renderToolSignature(tool: ToolSchema): string {
  const parameters = asRecord(tool.parameters)
  const properties = asRecord(parameters?.properties) ?? {}
  const required = new Set(requiredKeys(parameters))
  const names = Object.keys(properties)
  const ordered = [
    ...requiredKeys(parameters).filter((name, index, all) => all.indexOf(name) === index),
    ...names.filter((name) => !required.has(name)),
  ]
  const parts = ordered.map((name) => `${name}${required.has(name) ? '' : '?'}: ${renderType(properties[name])}`)
  return `${tool.name}(${parts.join(', ')})`
}

export function renderToolSignatures(tools: readonly ToolSchema[]): string | undefined {
  if (tools.length === 0) return undefined
  return [
    '随会话工具的参数签名（参数名必须与此逐字一致）：',
    '- 工具在 agent 侧的名字是 `mcp_dsh-tools_<会话后缀>_<短名>`（以 agent 声明的工具列表为准）；下面按短名列出，参数形状相同。',
    '- 若 agent 的工具声明还包含额外参数（例如 toolSummary），按声明一并提供；那类参数属于 agent 自己的元数据，不会转交给 DSH。',
    '- 不带 ? 的参数是必填项，不得省略；带 ? 的是可选项。',
    '- 不要沿用 agy 原生工具的参数名（如 path / AbsolutePath / CommandLine），也不要自造别名。',
    '- 调用前先对照签名补齐全部必填参数；说明类必填参数（如 description）也必须提供。',
    ...tools.map((tool) => `- ${renderToolSignature(tool)}`),
  ].join('\n')
}

export function inspectToolArguments(tool: Pick<ToolSchema, 'parameters'>, args: unknown): ToolArgumentIssues {
  const input = asRecord(args) ?? {}
  const properties = asRecord(asRecord(tool.parameters)?.properties)
  const missing = requiredKeys(tool.parameters).filter((key) => !Object.hasOwn(input, key) || input[key] === undefined)
  const unknown = properties ? Object.keys(input).filter((key) => !Object.hasOwn(properties, key)) : []
  return { missing: [...new Set(missing)], unknown }
}

export function safeKeyNames(keys: readonly string[], limit = 8): string[] {
  return keys.filter((key) => /^[A-Za-z_][\w.-]{0,39}$/.test(key)).slice(0, limit)
}
