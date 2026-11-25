/**
 * ACP 回合用量与上下文水位对账（原创实现）。
 *
 * 依据 2026-11-25 真机探针实测（见 docs/claims.md）：
 * 1. `PromptResponse.usage` 是本回合内所有内部模型调用的求和，且四桶互斥：
 *    `inputTokens + cachedReadTokens + cachedWriteTokens + outputTokens === totalTokens`；
 * 2. `outputTokens` 已包含 `thoughtTokens`（`thoughtTokens <= outputTokens`）；
 * 3. 多步工具回合中，每次 `usage_update` 在对应 MCP `tools/call` 之前到达，其 `used`
 *    为该步当前上下文占用，且整轮各步 `usage_update.used` 之和等于 `PromptResponse.usage.totalTokens`。
 *
 * 设计策略：
 * - 单步无工具回合（K = 1）：零估算，100% 精确直出 `PromptResponse.usage`（用量、缓存读取/命中、
 *   思考 token、TPS、上下文水位全部真实）。
 * - 多步工具回合（K > 1）：
 *   - 中间步（Step 1..K-1）：以 `usage_update.used` 锚定每步实时上下文水位，`outputTokens` 留 0
 *     （不估算输出），避免字符估算偏差与 `reasoningTokens > outputTokens` 校验失败；
 *   - 末步（Step K）：将上游真实的 `outputTokens` 与 `thoughtTokens` 完整入账，输入桶按
 *     `PromptResponse.usage - Σ(Step 1..K-1)` 差额对账；若因内部重试等原因导致 `K_acp > K_dsh`
 *     使残余输入明显超出末步实测 `usage_update.used`（> 1.15×），按比例钳制到 `used`，
 *     优先保证宿主上下文压力环不爆。
 * - 每条输出样本均严格满足 DSH `dsh-token-meter/lib/types/turn-usage.js` 的全部校验条件。
 */
import type { Usage as AcpUsage } from '@agentclientprotocol/sdk'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** 末步差额输入允许相对实测 `usage_update.used` 浮动的上限系数，超过则判定为 K_acp > K_dsh 并钳制。 */
const FINAL_STEP_PRESSURE_GUARD_RATIO = 1.15
/** 多步工具回合第 2..K-1 步在缺乏单步缓存拆分时使用的保守缓存读取先验占比。 */
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

/**
 * 将 ACP `PromptResponse.usage` 规范化为严格满足 DSH `TokenUsage` 校验的样本。
 * 若缺少必填的 `inputTokens` / `outputTokens` 返回 undefined。
 */
export function normalizeAcpUsage(raw: AcpUsage | null | undefined): NormalizedAcpUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const inputTokens = asNonNegativeInt(raw.inputTokens)
  const outputTokens = asNonNegativeInt(raw.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const cacheReadTokens = asNonNegativeInt(raw.cachedReadTokens) ?? 0
  const cacheWriteTokens = asNonNegativeInt(raw.cachedWriteTokens) ?? 0
  const rawThought = asNonNegativeInt(raw.thoughtTokens)
  // DSH 严格校验 reasoningTokens <= outputTokens；实测 agy 的 outputTokens 已含 thoughtTokens，
  // 这里仍做上限钳制以防上游异常计数导致整轮样本被宿主丢弃。
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

/** 将三个非负输入桶按比例缩放到目标总和 `target`，保证整数守恒。 */
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

/**
 * 单个 ACP `session/prompt` 回合内的分步用量记账器。
 */
export class TurnUsageAccounting {
  #currentUsed: number | undefined
  #emittedSteps = 0
  #emittedInput = 0
  #emittedCacheRead = 0

  /** 记下最新观测到的 `usage_update.used`（忽略 0 与非法值）。 */
  noteObservedUsed(used: number): void {
    const valid = asNonNegativeInt(used)
    if (valid !== undefined && valid > 0) this.#currentUsed = valid
  }

  /**
   * 中间工具步（Step 1..K-1）封口时调用：
   * 返回当前步的上下文水位样本并累计已出账额度，`outputTokens` 留 0 交由末步统一出账。
   */
  emitIntermediateStep(): TokenUsage | undefined {
    const used = this.#currentUsed
    if (used === undefined || used <= 0) return undefined
    // 首步通常无缓存命中（实测新会话首步 cachedReadTokens=0），后续工具步按保守先验拆出部分 cacheRead，
    // 降低末步对账时 input 桶欠扣的风险。
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

  /**
   * 回合最终封口（Step K，收到 `PromptResponse`）时调用：
   * - K = 1（无中间步）：100% 精确直出 `PromptResponse.usage`；
   * - K > 1：真实输出全量入账，输入按差额对账并在超过末步实测水位 1.15× 时钳制防爆环；
   * - 若上游未返回 `PromptResponse.usage`：回退本步实测 `usage_update.used`。
   */
  reconcileFinalStep(rawUsage?: AcpUsage | null): TokenUsage | undefined {
    const full = normalizeAcpUsage(rawUsage)
    if (!full) {
      const used = this.#currentUsed
      if (used === undefined || used <= 0) return undefined
      return buildUsage({
        inputTokens: used,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      })
    }

    if (this.#emittedSteps === 0) {
      return buildUsage(full)
    }

    const fullPrompt = full.inputTokens + full.cacheReadTokens + full.cacheWriteTokens
    const emittedPrompt = this.#emittedInput + this.#emittedCacheRead
    let remPromptTotal = Math.max(0, fullPrompt - emittedPrompt)

    // 先按各桶理想残余分配，再保证三桶之和精确等于 remPromptTotal。
    const rawRemInput = Math.max(0, full.inputTokens - this.#emittedInput)
    const rawRemCacheRead = Math.max(0, full.cacheReadTokens - this.#emittedCacheRead)
    const rawRemCacheWrite = full.cacheWriteTokens
    let buckets = scalePromptBuckets(rawRemInput, rawRemCacheRead, rawRemCacheWrite, remPromptTotal)

    // 防爆环保护：若发生 K_acp > K_dsh（如上游内部重试），残余 prompt 会明显超过末步真实水位；
    // 此时优先保证宿主上下文压力环准确，将末步输入三桶按比例缩放到 currentUsed。
    const observedUsed = this.#currentUsed
    if (observedUsed !== undefined && observedUsed > 0) {
      const guardCeiling = Math.ceil(observedUsed * FINAL_STEP_PRESSURE_GUARD_RATIO)
      if (remPromptTotal > guardCeiling) {
        remPromptTotal = observedUsed
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
