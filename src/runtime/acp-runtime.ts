/**
 * 方案 A：按 `(accountId, revision)` 维度的共享 ACP 进程管理器。
 *
 * 核心保障：
 * - 同一账号下所有并发对话共享一条长生命周期官方 ACP 进程；
 * - 并发首轮启动通过按 `(accountId, revision)` 键控的 `#inflight` 去重，绝不双 spawn / 双弹授权；
 * - 并发等待者各自独立取消（引用计数）：单个调用方 abort 不会误杀其他正在等待同一启动的对话；
 * - 切换账号或重新登录后：若旧链路上仍有在途对话，将其转入 `#retired` 优雅排空（不中断在途回合），
 *   旧链路空闲后自动回收；同时为新账号立即冷启动独立进程；
 * - 负责 Windows Low 完整性诊断、凭据自动导入、进程异常回收与卸载清理闭环。
 */
import type { ClientCapabilities } from '@agentclientprotocol/sdk'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { createSubprocessKeyringReader, ensureAcpCredentials } from '../auth/token-store.js'
import type { KeyringReader } from '../auth/token-store.js'
import { AgentLink, agentStreamFromSubprocess, AGY_CLIENT_INFO, AGY_LINK_ERROR, launchAcpAgent } from '../protocol/agent-link.js'
import type { AgentLinkHandlers } from '../protocol/agent-link.js'
import { withAbort } from './abort.js'
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
  /** 判断指定链路是否仍有在途对话；切换账号时用于保护旧链路优雅排空。 */
  isLinkBusy?: (link: AgentLink) => boolean
  fetchImpl?: typeof fetch
  log?: AcpRuntimeLog
  /** 仅系统账号使用：在 CLI token 文件缺失时只读回退系统钥匙串。 */
  readKeyring?: KeyringReader
  /** 仅测试覆写：检查 Windows Low 完整性。 */
  checkLowIntegrity?: (executable: string) => Promise<boolean>
  /** 仅测试覆写：自定义凭据准备。 */
  prepareCredentials?: typeof ensureAcpCredentials
}

interface ManagedRuntime {
  readonly link: AgentLink
  readonly handle: SubprocessHandle
  readonly directory: RuntimeDirectory
  readonly accountId: string
  readonly accountRevision: number
}

interface InflightLaunch {
  readonly accountId: string
  readonly accountRevision: number
  readonly abort: AbortController
  readonly promise: Promise<ManagedRuntime>
  waiters: number
}

export class AcpRuntimeManager {
  #current: ManagedRuntime | undefined
  readonly #retired = new Map<AgentLink, ManagedRuntime>()
  #inflight: InflightLaunch | undefined
  #disposed = false
  readonly #options: AcpRuntimeManagerOptions

  constructor(options: AcpRuntimeManagerOptions) {
    this.#options = options
  }

  get currentLink(): AgentLink | undefined {
    return this.#current && !this.#current.link.closed ? this.#current.link : undefined
  }

  get retiredCount(): number {
    return this.#retired.size
  }

  /** 获取当前账号对应的可用 `AgentLink`（按需冷启动，同账号并发调用汇聚到同一次启动）。 */
  async getLink(handlers: AgentLinkHandlers, signal?: AbortSignal): Promise<AgentLink> {
    if (this.#disposed) throw new LlmError('Antigravity ACP 插件已卸载', AGY_LINK_ERROR.LINK_CLOSED)
    signal?.throwIfAborted()

    const account = this.#options.resolveAccount()

    // 1. 当前链路与账号一致且存活：直接复用并补齐调用方回调。
    if (
      this.#current
      && !this.#current.link.closed
      && this.#current.accountId === account.id
      && this.#current.accountRevision === account.revision
    ) {
      this.#current.link.setHandlers(handlers)
      return this.#current.link
    }

    // 2. 已有同一 `(accountId, revision)` 的在途启动：共享等待，单方取消不误伤他人。
    if (
      this.#inflight
      && this.#inflight.accountId === account.id
      && this.#inflight.accountRevision === account.revision
    ) {
      const managed = await this.#awaitInflight(this.#inflight, signal)
      managed.link.setHandlers(handlers)
      return managed.link
    }

    // 3. 若已有旧链路（已断连或属于旧账号）：先移入 retired（空闲立即回收，在途则等排空）。
    if (this.#current) {
      this.#retireCurrent()
    }

    // 4. 同步登记新的 `#inflight`（在任何 await 之前完成，杜绝并发双 spawn）。
    const abort = new AbortController()
    const inflight: InflightLaunch = {
      accountId: account.id,
      accountRevision: account.revision,
      abort,
      waiters: 0,
      promise: Promise.resolve(undefined as unknown as ManagedRuntime),
    }
    const promise = this.#launch(handlers, account, abort.signal).then(
      (managed) => {
        if (this.#disposed) {
          void this.#recycleManaged(managed).catch(() => undefined)
          throw new LlmError('Antigravity ACP 插件已卸载', AGY_LINK_ERROR.LINK_CLOSED)
        }
        const latest = this.#options.resolveAccount()
        if (latest.id === managed.accountId && latest.revision === managed.accountRevision) {
          if (this.#current && this.#current !== managed) this.#retireCurrent()
          this.#current = managed
        } else {
          // 启动期间账号又切换了：先登记为 retired，让本次调用方用完后自然排空回收。
          this.#retired.set(managed.link, managed)
        }
        return managed
      },
    )
    ;(inflight as { promise: Promise<ManagedRuntime> }).promise = promise
    // 避免所有等待者提前取消后底层 promise 变成 unhandledRejection。
    promise.catch(() => undefined)
    this.#inflight = inflight

    try {
      const managed = await this.#awaitInflight(inflight, signal)
      return managed.link
    } finally {
      if (this.#inflight === inflight) this.#inflight = undefined
    }
  }

  /** 账号变更或重新登录后调用：立即将旧账号链路转入排空队列，空闲即回收。 */
  async retireIfAccountChanged(): Promise<void> {
    if (!this.#current) return
    const account = this.#options.resolveAccount()
    if (this.#current.accountId !== account.id || this.#current.accountRevision !== account.revision) {
      this.#retireCurrent()
      await this.drainRetired()
    }
  }

  /** 排空已退位且不再繁忙的旧账号链路（在回合结束或切账号时触发）。 */
  async drainRetired(): Promise<void> {
    const targets: ManagedRuntime[] = []
    for (const [link, managed] of this.#retired) {
      if (link.closed || !this.#options.isLinkBusy?.(link)) {
        this.#retired.delete(link)
        targets.push(managed)
      }
    }
    if (targets.length === 0) return
    await Promise.allSettled(targets.map((managed) => this.#recycleManaged(managed)))
  }

  /** 回收指定链路及其受管进程；旧链接调用不能误伤后来者。 */
  async recycle(link: AgentLink): Promise<void> {
    let managed: ManagedRuntime | undefined
    if (this.#current?.link === link) {
      managed = this.#current
      this.#current = undefined
    } else if (this.#retired.has(link)) {
      managed = this.#retired.get(link)
      this.#retired.delete(link)
    }
    if (managed) {
      await this.#recycleManaged(managed)
    } else {
      await link.close().catch(() => undefined)
    }
  }

  /** 插件卸载清理闭环：先切断链路/进程，再等待在途启动收尾，最后释放全部临时目录。 */
  async dispose(): Promise<void> {
    this.#disposed = true
    const inflight = this.#inflight
    this.#inflight = undefined
    inflight?.abort.abort(new Error('插件已卸载'))

    const toRecycle: ManagedRuntime[] = []
    if (this.#current) {
      toRecycle.push(this.#current)
      this.#current = undefined
    }
    for (const managed of this.#retired.values()) toRecycle.push(managed)
    this.#retired.clear()

    await Promise.allSettled([
      ...toRecycle.map((managed) => this.#recycleManaged(managed)),
      inflight ? inflight.promise.then((managed) => this.#recycleManaged(managed), () => undefined) : Promise.resolve(),
    ])
  }

  /* ── 内部方法 ────────────────────────────────────────────────────── */

  #retireCurrent(): void {
    const prev = this.#current
    if (!prev) return
    this.#current = undefined
    this.#retired.set(prev.link, prev)
    if (prev.link.closed || !this.#options.isLinkBusy?.(prev.link)) {
      void this.drainRetired()
    }
  }

  async #awaitInflight(inflight: InflightLaunch, signal?: AbortSignal): Promise<ManagedRuntime> {
    signal?.throwIfAborted()
    inflight.waiters += 1
    try {
      return await withAbort(inflight.promise, signal, '等待共享 Antigravity ACP 进程启动时被取消')
    } finally {
      inflight.waiters -= 1
      // 仅当所有等待者都取消（或插件卸载）时才中止底层启动，绝不因单方取消误杀同行者。
      if (inflight.waiters === 0 && signal?.aborted) {
        inflight.abort.abort(signal.reason ?? new Error('所有等待方已取消'))
      }
    }
  }

  async #recycleManaged(managed: ManagedRuntime): Promise<void> {
    managed.handle.terminate()
    await managed.link.close().catch(() => undefined)
    const exited = await managed.handle.waitForExit(AbortSignal.timeout(10_000)).catch(() => false)
    if (!exited) {
      throw new LlmError('Antigravity ACP 受管进程未能在回收期限内退出', AGY_LINK_ERROR.LINK_CLOSED)
    }
    await releaseRuntimeDirectory(managed.directory).catch(() => undefined)
  }

  async #launch(
    handlers: AgentLinkHandlers,
    account: ResolvedAccount,
    launchSignal: AbortSignal,
  ): Promise<ManagedRuntime> {
    const config = this.#options.readConfig()

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
      const readKeyring = account.system
        ? (this.#options.readKeyring ?? createSubprocessKeyringReader(this.#options.subprocess))
        : undefined
      const cred = await prepareCreds({
        homeDir: account.home,
        fetchImpl: this.#options.fetchImpl,
        ...(readKeyring ? { readKeyring } : {}),
      })
      if (!cred.ready) {
        this.#options.log?.warn(`antigravity-acp: 凭据导入未就绪（账号 ${account.id}）：${cred.note ?? '未知原因'}`)
      }

      launchSignal.throwIfAborted()
      directory = await createRuntimeDirectory()
      const extraArgs = [...defaultAgentArgs(), ...(config.extraArgs ?? [])]
      handle = launchAcpAgent(this.#options.subprocess, {
        executable: binary.executablePath,
        extraArgs,
        tmpDir: directory.tmpDir,
        proxy,
        ...(account.dir ? { homeDir: account.dir } : {}),
        signal: launchSignal,
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

      this.#options.log?.info(`antigravity-acp: 共享 ACP 进程就绪（账号=${account.id}，来源=${binary.source}）`)
      return {
        link,
        handle,
        directory,
        accountId: account.id,
        accountRevision: account.revision,
      }
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
