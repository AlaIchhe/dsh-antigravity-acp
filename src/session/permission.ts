/**
 * ACP 权限请求识别（私有 MCP 桥放行）与固定词表脱敏诊断。
 * 合并原 permission-handoff.ts 与 permission-diagnostic.ts。
 */
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

const INPUT_FIELDS = [
  'ServerName', 'ToolName', 'Arguments', 'name', 'tool_name', 'toolName',
  'server_name', 'serverName', 'args', 'input', 'arguments', 'parameters',
  'tool_input', 'toolInput',
] as const
const TOOL_KINDS = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'])
const OPTION_KINDS = ['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function parsePermissionHandoff(
  request: RequestPermissionRequest,
  context: { sessionId: string; serverName: string; tools: readonly ToolSchema[] },
): { name: string; arguments: string } | undefined {
  if (request.sessionId !== context.sessionId || !request.toolCall.toolCallId) return undefined
  const meta = asRecord(request.toolCall._meta)
  const mcp = asRecord(meta?.mcp)
  const input = asRecord(request.toolCall.rawInput) ?? {}
  const wrappedMcp = meta?.is_mcp_tool_call === true
  const tool = wrappedMcp
    ? mcp?.server === context.serverName ? context.tools.find((item) => item.name === mcp?.tool) : undefined
    : context.tools.find((item) =>
        request.toolCall.title === `Run ${item.name}?`
        || request.toolCall.title === `Run ${context.serverName}_${item.name}?`,
      )
  if (!tool) return undefined
  const name = request.toolCall.name
  if (name != null && name !== 'call_mcp_tool' && name !== tool.name) return undefined
  if (!wrappedMcp) return { name: tool.name, arguments: JSON.stringify(input) }

  const properties = asRecord(asRecord(tool.parameters)?.properties)
  const args = properties && Object.hasOwn(properties, 'arguments')
    ? input
    : asRecord(input.arguments) ?? input
  return { name: tool.name, arguments: JSON.stringify(args) }
}

function shape(value: unknown): string {
  if (value === null || value === undefined) return 'absent'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function inputSummary(value: unknown, serverName: string, toolNames: readonly string[]) {
  const input = asRecord(value)
  return {
    shape: shape(value),
    fields: INPUT_FIELDS.filter((key) => input && Object.hasOwn(input, key)),
    serverMatches: input?.ServerName === serverName || input?.server_name === serverName || input?.serverName === serverName,
    toolAdvertised: [input?.ToolName, input?.tool_name, input?.toolName].some(
      (name) => typeof name === 'string' && toolNames.includes(name),
    ),
  }
}

export function describePermissionRequest(
  request: RequestPermissionRequest,
  context: { sessionId: string; serverName: string; toolNames: readonly string[] },
) {
  const call = request.toolCall
  const input = asRecord(call.rawInput)
  const meta = asRecord(call._meta)
  const mcp = asRecord(meta?.mcp)
  return {
    sessionMatches: request.sessionId === context.sessionId,
    programmaticName: call.name === 'call_mcp_tool' ? 'mcp-wrapper' : call.name == null ? 'absent' : 'other',
    kind: call.kind == null ? 'absent' : TOOL_KINDS.has(call.kind) ? call.kind : 'unrecognized',
    titlePresent: typeof call.title === 'string',
    metaPresent: request._meta != null || call._meta != null,
    mcpMeta: {
      marked: meta?.is_mcp_tool_call === true,
      serverMatches: mcp?.server === context.serverName,
      toolAdvertised: typeof mcp?.tool === 'string' && context.toolNames.includes(mcp.tool),
    },
    input: inputSummary(call.rawInput, context.serverName, context.toolNames),
    nested: ['args', 'input', 'arguments', 'parameters', 'tool_input', 'toolInput']
      .filter((key) => input && Object.hasOwn(input, key))
      .map((key) => ({ field: key, ...inputSummary(input?.[key], context.serverName, context.toolNames) })),
    options: OPTION_KINDS.filter((kind) => request.options.some((option) => option.kind === kind)),
  }
}

export type PermissionDiagnostic = ReturnType<typeof describePermissionRequest>
