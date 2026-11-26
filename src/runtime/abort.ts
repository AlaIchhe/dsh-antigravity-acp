/**
 * 统一的 AbortSignal 辅助原语。
 * 合并此前分散在 antigravity-adapter.ts 与 conversation-workers.ts 的重复实现。
 */
import { LlmError } from '@deepseek-ai/dsh-llm'

export const AGY_ABORTED_CODE = 'AGY_ABORTED'

export function throwIfAborted(signal?: AbortSignal, message = 'Antigravity ACP 请求已取消'): void {
  if (signal?.aborted) throw new LlmError(message, AGY_ABORTED_CODE)
}

/**
 * 等待一个 promise，但允许调用方通过 signal 提前中止等待；不丢失原 promise 的错误清理。
 */
export function withAbort<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
  message = 'Antigravity ACP 请求已取消',
): Promise<T> {
  if (!signal) return pending
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      cleanup()
      reject(new LlmError(message, AGY_ABORTED_CODE))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(
      (value) => { cleanup(); resolve(value) },
      (error) => { cleanup(); reject(error) },
    )
    if (signal.aborted) onAbort()
  })
}
