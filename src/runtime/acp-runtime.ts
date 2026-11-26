/**
 * 方案 A：按 `(accountId, revision)` 维度的共享 ACP 进程管理器。
 *
 * 从旧 813 行 `src/index.ts` 抽离，彻底替代 `ConversationWorkers` + 多 worker 进程池：
 * - 同一账号下所有并发对话共享一条长生命周期官方 ACP 进程；
 * - 切换账号或重新登录后，下次建联自动回收旧进程并以新账号 HOME 启动；
 * - 并发首轮启动通过 `inflight` 去重，绝不双 spawn / 双弹授权；
 * - 负责 Windows Low 完整性诊断、凭据自动导入、进程异常回收与卸载清理闭环。
 */
import type { ClientCapabilities } from '@agentclientprotocol/sdk'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { ensureAcpCredentials } from '../auth/token-store.js'
import { AgentLink, agentStreamFromSubprocess, AGY_CLIENT_INFO, AGY_LINK_ERROR, launchAcpAgent } from '../protocol/agent-link.js'
import type { AgentLinkHandlers } from '../protocol/agent-link.js'
import {
  AGY_BINARY_ERROR,
  createRuntimeDirectory,
  defaultAgentArgs,
  DEFAULT_ACP_SERVER_VERSION,
  ensureAgentBinary,
  releaseRuntimeDirectory,
} from './binary.js'
import type { RuntimeDirectory } from './binary.js'
import { describeLowIntegrity, isLowIntegrityTarget } from './integrity.js'
import { ProxyConfigError, resolveProxy } from './proxy.js'
import { describeAuthWait, redactSensitiveText } from './redact.js'
import type { AntigravityHostConfig } from '../settings.js'
import type { ResolvedAccount } from '../accounts/types.js'

/** 向官方 agent 声明的 client 能力：一律关闭，工具全走私有 MCP 桥回到 DSH。 */
export const AGY_CLIENT_CAPABILITIES: ClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
}

export interface AcpRuntimeLog {
  info(message: string): void
  warn(message: string, error?: unknown): void
}

export interface AcpRuntimeManagerOptions {
  subprocess: SubprocessRuntime
  readConfig: () => AntigravityHostConfig
  resolveAccount: () => ResolvedAccount
  fetchImpl?: typeof fetch
  log?: AcpRuntimeLog
  /** 仅测试覆写：检查 Windows Low 完整性。 */
  checkLowIntegrity?: (executable: string) => Promise<boolean>
  /** 仅测试覆写：自定义凭据准备。 */
  prepareCredentials?: typeof ensureAcpCredentials
}

export class AcpRuntimeManager {
  #link: AgentLink | undefined
  #handle: SubprocessHandle | undefined
  #directory: RuntimeDirectory | undefined
  #accountId: string | undefined
  #accountRevision: number | undefined
  #inflight: Promise<AgentLink> | undefined
  #abort: AbortController | undefined
  #disposed = false
  readonly #options: AcpRuntimeManagerOptions

  constructor(options: AcpRuntimeManagerOptions) {
    this.#options = options
  }

  get currentLink(): AgentLink | undefined {
    return this.#link && !this.#link.closed ? this.#link : undefined
  }

  /** 获取当前账号对应的可用 `AgentLink`（按需冷启动，并发调用汇聚到同一次启动）。 */
  async getLink(handlers: AgentLinkHandlers, signal?: AbortSignal): Promise<AgentLink> {
    if (this.#disposed) throw new LlmError('Antigravity ACP 插件已卸载', AGY_LINK_ERROR.LINK_CLOSED)
    signal?.throwIfAborted()

    const account = this.#options.resolveAccount()

    // 若账号已切换或重新登录，且有旧链路，先安全回收旧链路再启动新链路。
    if (
      this.#link
      && !this.#link.closed
      && this.#accountId === account.id
      && this.#accountRevision === account.revision
    ) {
      return this.#link
    }

    if (this.#inflight) {
      const existing = await this.#inflight
      if (
        !existing.closed
        && this.#accountId === account.id
        && this.#accountRevision === account.revision
      ) {
        return existing
      }
    }

    if (this.#link) {
      await this.recycle(this.#link).catch(() => undefined)
    }

    const launch = this.#launch(handlers, account, signal)
    this.#inflight = launch
    try {
      return await launch
    } finally {
      if (this.#inflight === launch) this.#inflight = undefined
    }
  }

  /** 回收指定链路及其受管进程；旧链接调用不能误伤后来者。 */
  async recycle(link: AgentLink): Promise<void> {
    const isCurrent = this.#link === link
    const handle = isCurrent ? this.#handle : undefined
    const directory = isCurrent ? this.#directory : undefined
    if (isCurrent) {
      this.#link = undefined
      this.#handle = undefined
      this.#directory = undefined
    }
    handle?.terminate()
    await link.close().catch(() => undefined)
    if (handle) {
      const exited = await handle.waitForExit(AbortSignal.timeout(10_000)).catch(() => false)
      if (!exited) {
        throw new LlmError('Antigravity ACP 受管进程未能在回收期限内退出', AGY_LINK_ERROR.LINK_CLOSED)
      }
    }
    if (directory) {
      await releaseRuntimeDirectory(directory).catch(() => undefined)
    }
  }

  /** 插件卸载清理闭环：先切断链路/进程，再等待在途启动收尾，最后释放临时目录。 */
  async dispose(): Promise<void> {
    this.#disposed = true
    this.#abort?.abort(new Error('插件已卸载'))
    this.#handle?.terminate()
    await this.#link?.close().catch(() => undefined)
    await this.#inflight?.catch(() => undefined)
    const handle = this.#handle
    handle?.terminate()
    if (this.#directory && (!handle || await handle.waitForExit(AbortSignal.timeout(10_000)).catch(() => false))) {
      await releaseRuntimeDirectory(this.#directory).catch(() => undefined)
      this.#directory = undefined
    }
    this.#link = undefined
    this.#handle = undefined
  }

  /* ── 内部启动流程 ────────────────────────────────────────────────── */

  async #launch(
    handlers: AgentLinkHandlers,
    account: ResolvedAccount,
    signal?: AbortSignal,
  ): Promise<AgentLink> {
    const config = this.#options.readConfig()
    const abort = new AbortController()
    this.#abort = abort
    const onCallerAbort = (): void => abort.abort(signal?.reason ?? new Error('已取消'))
    signal?.addEventListener('abort', onCallerAbort, { once: true })
    if (signal?.aborted) onCallerAbort()

    let directory: RuntimeDirectory | undefined
    let handle: SubprocessHandle | undefined
    let link: AgentLink | undefined

    try {
      const proxy = this.#resolveProxyOrThrow(config)
      const binary = await ensureAgentBinary({
        binaryPath: config.binaryPath,
        version: config.acpVersion ?? DEFAULT_ACP_SERVER_VERSION,
      })

      const lowIntegrity = this.#options.checkLowIntegrity
        ? await this.#options.checkLowIntegrity(binary.executablePath)
        : await isLowIntegrityTarget(binary.executablePath, (target) => this.#runIcacls(target))
      if (lowIntegrity) {
        throw new LlmError(describeLowIntegrity(binary.executablePath), AGY_BINARY_ERROR.LOW_INTEGRITY)
      }

      const prepareCreds = this.#options.prepareCredentials ?? ensureAcpCredentials
      const cred = await prepareCreds({
        homeDir: account.home,
        fetchImpl: this.#options.fetchImpl,
      })
      if (!cred.ready) {
        this.#options.log?.warn(`antigravity-acp: 凭据导入未就绪（账号 ${account.id}）：${cred.note ?? '未知原因'}`)
      }

      abort.signal.throwIfAborted()
      directory = await createRuntimeDirectory()
      const extraArgs = [...defaultAgentArgs(), ...(config.extraArgs ?? [])]
      handle = launchAcpAgent(this.#options.subprocess, {
        executable: binary.executablePath,
        extraArgs,
        tmpDir: directory.tmpDir,
        proxy,
        ...(account.dir ? { homeDir: account.dir } : {}),
        signal: abort.signal,
      })

      link = new AgentLink({
        stream: agentStreamFromSubprocess(handle),
        clientInfo: AGY_CLIENT_INFO,
        requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
        handshakeTimeoutMs: config.handshakeTimeoutMs ?? 120_000,
        authTimeoutMs: config.authTimeoutMs ?? 300_000,
        handlers,
      })
      link.start()

      await link.initialize({ clientCapabilities: AGY_CLIENT_CAPABILITIES })
      if (!cred.ready) {
        try {
          await link.authenticate()
        } catch (authError) {
          const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
          const authWaitHint = describeAuthWait(stderr)
          if (authWaitHint) throw new LlmError(authWaitHint, AGY_LINK_ERROR.AUTH_TIMEOUT)
          throw authError
        }
      }

      if (this.#disposed) throw new LlmError('Antigravity ACP 插件已卸载', AGY_LINK_ERROR.LINK_CLOSED)

      this.#link = link
      this.#handle = handle
      this.#directory = directory
      this.#accountId = account.id
      this.#accountRevision = account.revision
      this.#options.log?.info(`antigravity-acp: 共享 ACP 进程就绪（账号=${account.id}，来源=${binary.source}）`)
      return link
    } catch (error) {
      handle?.terminate()
      await link?.close().catch(() => undefined)
      if (directory) {
        if (!handle || await handle.waitForExit(AbortSignal.timeout(5_000)).catch(() => false)) {
          await releaseRuntimeDirectory(directory).catch(() => undefined)
        }
      }
      if (error instanceof LlmError) throw error
      const stderr = handle?.collected.stderr?.readFrom(0).text ?? ''
      const detail = redactSensitiveText(error instanceof Error ? error.message : String(error))
      const tail = stderr.trim() ? `（stderr: ${redactSensitiveText(stderr.trim().slice(-240))}）` : ''
      throw new LlmError(`启动 Antigravity ACP 失败：${detail}${tail}`, AGY_LINK_ERROR.LAUNCH_FAILED)
    } finally {
      signal?.removeEventListener('abort', onCallerAbort)
      if (this.#abort === abort) this.#abort = undefined
    }
  }

  #resolveProxyOrThrow(config: AntigravityHostConfig) {
    try {
      return resolveProxy(config.proxyUrl ? { url: config.proxyUrl } : undefined)
    } catch (error) {
      if (error instanceof ProxyConfigError) throw new LlmError(error.message, 'AGY_PROXY_INVALID')
      throw error
    }
  }

  async #runIcacls(target: string): Promise<string | undefined> {
    try {
      const handle = this.#options.subprocess.spawn({
        argv: ['icacls', target],
        cwd: process.cwd(),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 32 * 1024 }, stderr: { maxBytes: 8 * 1024 } },
        graceMs: 3_000,
        signal: AbortSignal.timeout(5_000),
      })
      const outcome = await handle.done
      if (outcome.exitCode !== 0) return undefined
      return handle.collected.stdout?.readFrom(0).text
    } catch {
      return undefined
    }
  }
}
