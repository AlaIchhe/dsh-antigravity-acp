/**
 * ACP 回合用量与上下文水位对账（保留 2026-11-25 真机实测验证的对账模型）。
 */
import type { Usage as AcpUsage } from '@agentclientprotocol/sdk'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

const FINAL_STEP_PRESSURE_GUARD_RATIO = 1.15
const INTERMEDIATE_CACHE_READ_PRIOR = 0.4

interface NormalizedAcpUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens?: number
  totalTokens: number
}

function asNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  const rounded = Math.trunc(value)
  return Number.isSafeInteger(rounded) ? rounded : undefined
}

export function normalizeAcpUsage(raw: AcpUsage | null | undefined): NormalizedAcpUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const inputTokens = asNonNegativeInt(raw.inputTokens)
  const outputTokens = asNonNegativeInt(raw.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const cacheReadTokens = asNonNegativeInt(raw.cachedReadTokens) ?? 0
  const cacheWriteTokens = asNonNegativeInt(raw.cachedWriteTokens) ?? 0
  const rawThought = asNonNegativeInt(raw.thoughtTokens)
  const reasoningTokens = rawThought === undefined ? undefined : Math.min(rawThought, outputTokens)
  const totalTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens
  if (!Number.isSafeInteger(totalTokens)) return undefined
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    totalTokens,
  }
}

function scalePromptBuckets(
  input: number,
  cacheRead: number,
  cacheWrite: number,
  target: number,
): { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } {
  const safeTarget = Math.max(0, Math.trunc(target))
  const sum = input + cacheRead + cacheWrite
  if (safeTarget === 0 || sum <= 0) {
    return { inputTokens: safeTarget, cacheReadTokens: 0, cacheWriteTokens: 0 }
  }
  const scaledCacheRead = Math.min(safeTarget, Math.round((cacheRead / sum) * safeTarget))
  const remainingAfterRead = safeTarget - scaledCacheRead
  const scaledCacheWrite = Math.min(remainingAfterRead, Math.round((cacheWrite / sum) * safeTarget))
  const scaledInput = Math.max(0, safeTarget - scaledCacheRead - scaledCacheWrite)
  return {
    inputTokens: scaledInput,
    cacheReadTokens: scaledCacheRead,
    cacheWriteTokens: scaledCacheWrite,
  }
}

function buildUsage(parts: {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens?: number
}): TokenUsage {
  const inputTokens = Math.max(0, Math.trunc(parts.inputTokens))
  const outputTokens = Math.max(0, Math.trunc(parts.outputTokens))
  const cacheReadTokens = Math.max(0, Math.trunc(parts.cacheReadTokens))
  const cacheWriteTokens = Math.max(0, Math.trunc(parts.cacheWriteTokens))
  const reasoningTokens = parts.reasoningTokens === undefined
    ? undefined
    : Math.min(Math.max(0, Math.trunc(parts.reasoningTokens)), outputTokens)
  const totalTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    totalTokens,
  }
}

export class TurnUsageAccounting {
  #currentUsed: number | undefined
  #emittedSteps = 0
  #emittedInput = 0
  #emittedCacheRead = 0

  noteObservedUsed(used: number): void {
    const valid = asNonNegativeInt(used)
    if (valid !== undefined && valid > 0) this.#currentUsed = valid
  }

  emitIntermediateStep(): TokenUsage | undefined {
    const used = this.#currentUsed
    if (used === undefined || used <= 0) return undefined
    const cacheRead = this.#emittedSteps === 0
      ? 0
      : Math.min(used, Math.round(used * INTERMEDIATE_CACHE_READ_PRIOR))
    const input = used - cacheRead
    this.#emittedSteps += 1
    this.#emittedInput += input
    this.#emittedCacheRead += cacheRead
    return buildUsage({
      inputTokens: input,
      outputTokens: 0,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    })
  }

  reconcileFinalStep(rawUsage?: AcpUsage | null): TokenUsage | undefined {
    const full = normalizeAcpUsage(rawUsage)
    if (!full) {
      const used = this.#currentUsed
      if (used === undefined || used <= 0) return undefined
      return buildUsage({ inputTokens: used, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    }
    if (this.#emittedSteps === 0) return buildUsage(full)

    const fullPrompt = full.inputTokens + full.cacheReadTokens + full.cacheWriteTokens
    const emittedPrompt = this.#emittedInput + this.#emittedCacheRead
    let remPromptTotal = Math.max(0, fullPrompt - emittedPrompt)
    const rawRemInput = Math.max(0, full.inputTokens - this.#emittedInput)
    const rawRemCacheRead = Math.max(0, full.cacheReadTokens - this.#emittedCacheRead)
    const rawRemCacheWrite = full.cacheWriteTokens
    let buckets = scalePromptBuckets(rawRemInput, rawRemCacheRead, rawRemCacheWrite, remPromptTotal)

    const observedUsed = this.#currentUsed
    if (observedUsed !== undefined && observedUsed > 0) {
      const guardCeiling = Math.ceil(observedUsed * FINAL_STEP_PRESSURE_GUARD_RATIO)
      if (remPromptTotal > guardCeiling) {
        buckets = scalePromptBuckets(buckets.inputTokens, buckets.cacheReadTokens, buckets.cacheWriteTokens, observedUsed)
      }
    }

    return buildUsage({
      inputTokens: buckets.inputTokens,
      outputTokens: full.outputTokens,
      cacheReadTokens: buckets.cacheReadTokens,
      cacheWriteTokens: buckets.cacheWriteTokens,
      ...(full.reasoningTokens === undefined ? {} : { reasoningTokens: full.reasoningTokens }),
    })
  }
}
