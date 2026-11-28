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

/**
 * `agy 1.5+` 对单次 `eagerMcpServers` 暴露给模型的 MCP 工具清单有总字节预算（实测 ~64 KiB，
 * 超限时按体积从大到小静默丢弃工具，最先被裁掉的是 `bash` / `edit` / `subagent` 等描述较长的核心工具）。
 *
 * 为避免核心工具被静默淘汰：
 * - 总预算充足时原样透传，不做任何裁剪；
 * - 超出安全预算时按档位渐进压缩 `description` 文本，绝不改动工具名、参数名、`type` / `enum` / `required` / `items` 等结构字段。
 */
export const MCP_TOOLS_SAFE_BUDGET_BYTES = 52_000
export const MCP_TOOL_OVERHEAD_BYTES = 120
export const MCP_TOOLS_MIN_BUDGET_BYTES = 20_000

const COMPACT_TIERS: readonly { toolDesc: number; propDesc: number }[] = [
  { toolDesc: 180, propDesc: 96 },
  { toolDesc: 96, propDesc: 48 },
  { toolDesc: 56, propDesc: 0 },
  { toolDesc: 0, propDesc: 0 },
]

function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  return `${chars.slice(0, maxChars - 1).join('').trimEnd()}…`
}

function compactSchemaNode(node: unknown, maxPropDesc: number): unknown {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((item) => compactSchemaNode(item, maxPropDesc))
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'description' && typeof value === 'string') {
      if (maxPropDesc > 0) out[key] = truncateText(value, maxPropDesc)
      continue
    }
    out[key] = compactSchemaNode(value, maxPropDesc)
  }
  return out
}

function serializedToolsBytes(tools: readonly ToolSchema[]): number {
  return Buffer.byteLength(JSON.stringify(tools), 'utf8')
}

export function compactToolSchemas(
  tools: readonly ToolSchema[],
  options?: { maxBytes?: number; perToolOverheadBytes?: number },
): readonly ToolSchema[] {
  if (tools.length === 0) return tools
  const maxBytes = options?.maxBytes ?? MCP_TOOLS_SAFE_BUDGET_BYTES
  const overhead = options?.perToolOverheadBytes ?? MCP_TOOL_OVERHEAD_BYTES
  const budget = Math.max(MCP_TOOLS_MIN_BUDGET_BYTES, maxBytes - tools.length * overhead)
  if (serializedToolsBytes(tools) <= budget) return tools

  let current: readonly ToolSchema[] = tools
  for (const tier of COMPACT_TIERS) {
    current = tools.map((tool) => ({
      name: tool.name,
      description: tier.toolDesc > 0 ? truncateText(tool.description, tier.toolDesc) : '',
      parameters: compactSchemaNode(tool.parameters, tier.propDesc) as ToolSchema['parameters'],
    }))
    if (serializedToolsBytes(current) <= budget) return current
  }
  return current
}
