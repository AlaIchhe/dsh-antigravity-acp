/**
 * ACP 1.5+ 纯模型 / 思考档位 / 模式选择器路由。
 *
 * v1.0 破坏性清理：
 * - 只认显式 `category === 'model'` 与 `category === 'thought_level'`；
 * - 不再保留 `server-default` 占位 ID 与旧 agent 的档位后缀路由兼容路径；
 * - 思考档位不在 agent 声明选项内时直接抛 `AGY_EFFORT_UNSUPPORTED`（绝不静默收敛）。
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import type {
  SessionConfigOption,
  SessionConfigSelect,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from '@agentclientprotocol/sdk'
import type { AgentLink } from '../protocol/agent-link.js'

export const AGY_ROUTING_ERROR = {
  NO_MODEL_SELECTOR: 'AGY_NO_MODEL_SELECTOR',
  MODEL_SELECTION_MISMATCH: 'AGY_MODEL_SELECTION_MISMATCH',
  EFFORT_UNSUPPORTED: 'AGY_EFFORT_UNSUPPORTED',
} as const

export interface ModelSelector {
  configId: string
  options: readonly SessionConfigSelectOption[]
  currentValue?: string
}

export interface ThoughtLevelSelector {
  configId: string
  options: readonly SessionConfigSelectOption[]
  currentValue?: string
}

function isSelect(option: SessionConfigOption): option is SessionConfigOption & SessionConfigSelect & { type: 'select' } {
  return option.type === 'select'
}

export function flattenSelectOptions(options: SessionConfigSelect['options']): readonly SessionConfigSelectOption[] {
  if (!Array.isArray(options) || options.length === 0) return []
  const first = options[0] as SessionConfigSelectOption | SessionConfigSelectGroup | undefined
  if (!first) return []
  if ('group' in first) {
    const flat: SessionConfigSelectOption[] = []
    for (const group of options as SessionConfigSelectGroup[]) {
      for (const option of group.options) flat.push(option)
    }
    return flat
  }
  return [...(options as SessionConfigSelectOption[])]
}

export function findModelSelector(configOptions: readonly SessionConfigOption[] | null | undefined): ModelSelector | undefined {
  if (!configOptions?.length) return undefined
  const picked = configOptions.filter(isSelect).find((option) => option.category === 'model')
  if (!picked) return undefined
  return {
    configId: picked.id,
    options: flattenSelectOptions(picked.options),
    ...(picked.currentValue === undefined ? {} : { currentValue: picked.currentValue }),
  }
}

export function findThoughtLevelSelector(configOptions: readonly SessionConfigOption[] | null | undefined): ThoughtLevelSelector | undefined {
  if (!configOptions?.length) return undefined
  const picked = configOptions.filter(isSelect).find((option) => option.category === 'thought_level')
  if (!picked) return undefined
  return {
    configId: picked.id,
    options: flattenSelectOptions(picked.options),
    ...(picked.currentValue === undefined ? {} : { currentValue: picked.currentValue }),
  }
}

export function normalizeEffort(effort?: { toString(): string }): string | undefined {
  const raw = effort === undefined ? undefined : effort.toString().trim().toLowerCase()
  return raw === undefined || raw === '' ? undefined : raw
}

/**
 * 为新建或恢复的 ACP 会话设置模型与思考强度（ACP 1.5+ 双通道）。
 * 返回更新后的 configOptions（供 CatalogStore 同步）。
 */
export async function applySessionSelection(input: {
  link: AgentLink
  sessionId: string
  configOptions: readonly SessionConfigOption[] | null | undefined
  model: string
  effort?: { toString(): string }
  signal?: AbortSignal
  log?: { info(msg: string): void; warn(msg: string, err?: unknown): void }
}): Promise<readonly SessionConfigOption[] | undefined> {
  let latestOptions = input.configOptions ?? undefined
  const modelSelector = findModelSelector(latestOptions)
  if (!modelSelector) {
    throw new LlmError('ACP 会话未声明 model 配置选择器，无法设置模型', AGY_ROUTING_ERROR.NO_MODEL_SELECTOR)
  }

  // 1. 选模型（若当前会话值已一致则跳过无谓往返）。
  if (modelSelector.currentValue !== input.model) {
    const resp = await input.link.setConfigOption(
      { sessionId: input.sessionId, configId: modelSelector.configId, value: input.model },
      { signal: input.signal },
    )
    if (resp.configOptions?.length) latestOptions = resp.configOptions
    const confirmed = findModelSelector(latestOptions)?.currentValue
    if (confirmed !== undefined && confirmed !== input.model) {
      throw new LlmError(
        `ACP agent 未确认所选模型（请求=${input.model}，实际=${confirmed}）`,
        AGY_ROUTING_ERROR.MODEL_SELECTION_MISMATCH,
      )
    }
  }

  // 2. 选思考强度（仅当用户显式指定了档位）。
  const requestedEffort = normalizeEffort(input.effort)
  if (requestedEffort !== undefined) {
    const thoughtSelector = findThoughtLevelSelector(latestOptions)
    if (!thoughtSelector || thoughtSelector.options.length === 0) {
      throw new LlmError(
        `当前模型或 ACP agent 未声明 thought_level 档位通道，无法应用思考档位 ${requestedEffort}`,
        AGY_ROUTING_ERROR.EFFORT_UNSUPPORTED,
      )
    }
    const allowed = thoughtSelector.options.map((opt) => opt.value)
    if (!allowed.includes(requestedEffort)) {
      throw new LlmError(
        `agent 未声明思考档位 ${requestedEffort}（可选：${allowed.join(' / ')}）。请改选已声明的档位。`,
        AGY_ROUTING_ERROR.EFFORT_UNSUPPORTED,
      )
    }
    if (thoughtSelector.currentValue !== requestedEffort) {
      const resp = await input.link.setConfigOption(
        { sessionId: input.sessionId, configId: thoughtSelector.configId, value: requestedEffort },
        { signal: input.signal },
      )
      if (resp.configOptions?.length) latestOptions = resp.configOptions
    }
  }

  return latestOptions
}

export async function applyAgentMode(input: {
  link: AgentLink
  sessionId: string
  mode: string | undefined
  modes: { availableModes?: readonly { id: string }[] } | null | undefined
  signal?: AbortSignal
  log?: { info(msg: string): void; warn(msg: string, err?: unknown): void }
}): Promise<void> {
  const mode = input.mode?.trim() ?? ''
  if (!mode) return
  const declared = input.modes?.availableModes?.some((entry) => entry.id === mode) ?? false
  if (!declared) {
    input.log?.warn(`antigravity-acp: 会话模式 ${mode} 未被 agent 声明，沿用默认模式`)
    return
  }
  try {
    await input.link.setMode({ sessionId: input.sessionId, modeId: mode }, { signal: input.signal })
    input.log?.info(`antigravity-acp: 会话模式已设为 ${mode} session=${input.sessionId}`)
  } catch (error) {
    input.log?.warn(`antigravity-acp: session/set_mode 失败（mode=${mode}）`, error)
  }
}
