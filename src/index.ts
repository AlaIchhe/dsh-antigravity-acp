/**
 * Cordis 插件入口（v1.0 纯装配根 Composition Root）。
 *
 * 只负责依赖装配、宿主事件接入与生命周期清理闭环：
 * - 单一 `AcpRuntimeManager`（方案 A：按账号共享常驻 ACP 进程）
 * - 单一 `CatalogStore`（全局模型目录与思考档位元数据）
 * - 单一 `AntigravityAcpAdapter`（多对话并发复用、会话恢复、MCP 桥）
 * - 单一 `AntigravityRemoteService`（`remote.antigravity` 统一 RPC 网关）
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { AccountsManager } from './accounts/manager.js'
import { resolveAccountsDir } from './accounts/paths.js'
import { AntigravityRemoteService, registerAntigravityRemote } from './remote/service.js'
import { AcpRuntimeManager } from './runtime/acp-runtime.js'
import { installAgyCli } from './runtime/agy-cli-install.js'
import { agyCliCandidates, createSubprocessCliRun, fetchAgyModels } from './runtime/agy-cli.js'
import { DEFAULT_ACP_SERVER_VERSION, resolveCacheDir } from './runtime/binary.js'
import { createLiveProxiedFetch, resolveHttpsProxy } from './runtime/proxy.js'
import { redactSensitiveText } from './runtime/redact.js'
import { AntigravityAcpAdapter, AGY_PROVIDER_ID } from './session/adapter.js'
import { CatalogStore } from './session/catalog-store.js'
import { createFileSessionStore } from './session/session-store.js'
import { liveHostConfig } from './settings.js'
import type { AntigravityHostConfig, AntigravityPluginConfig } from './settings.js'

export { AGY_PROVIDER_ID } from './session/adapter.js'
export { Config } from './settings.js'
export type { AntigravityHostConfig } from './settings.js'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/volatile-update'(paths: string[][]): void
  }
}

export const name = 'llm-antigravity-acp'
export const inject = ['llm', 'subprocess']

function openExternalUrl(subprocess: Context['subprocess'], url: string): Promise<boolean> {
  const argv = process.platform === 'darwin'
    ? ['open', url]
    : process.platform === 'win32'
      ? ['cmd', '/c', 'start', '', url]
      : ['xdg-open', url]
  return new Promise((resolve) => {
    try {
      const handle = subprocess.spawn({
        argv,
        cwd: homedir(),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
        graceMs: 2_000,
        signal: AbortSignal.timeout(5_000),
      })
      void handle.done.then((outcome) => resolve(outcome.exitCode === 0), () => resolve(false))
    } catch {
      resolve(false)
    }
  })
}

export function apply(ctx: Context, rawConfig: AntigravityPluginConfig = {}): void {
  const config = liveHostConfig(rawConfig)
  const cacheDir = resolveCacheDir()
  const acpVersion = config.acpVersion ?? DEFAULT_ACP_SERVER_VERSION

  const log = {
    info: (message: string) => ctx.logger?.info?.(message),
    warn: (message: string, error?: unknown) => {
      const detail = error ? `: ${error instanceof Error ? error.message : String(error)}` : ''
      ctx.logger?.warn?.(redactSensitiveText(`${message}${detail}`))
    },
  }

  const pluginFetch = createLiveProxiedFetch(() =>
    resolveHttpsProxy(config.proxyUrl ? { url: config.proxyUrl } : undefined),
  )

  const findCli = (): string | undefined =>
    agyCliCandidates(process.env, homedir(), config.agyCliPath).find((candidate) => existsSync(candidate))

  const cliRun = createSubprocessCliRun(
    ctx.subprocess,
    () => (config.proxyUrl ? { url: config.proxyUrl } : undefined),
  )

  const notifyCatalogChanged = (): void => {
    try {
      (ctx as unknown as { emit(event: string): void }).emit('llm/adapters-updated')
    } catch {
      // 无监听方时忽略。
    }
  }

  const accounts = new AccountsManager({
    baseDir: resolveAccountsDir(),
    fetchImpl: pluginFetch,
    openBrowser: (url) => openExternalUrl(ctx.subprocess, url),
    onChange: () => {
      notifyCatalogChanged()
    },
    log,
  })

  let attachmentStore: AttachmentStore | undefined

  const catalog = new CatalogStore({
    cacheDir,
    acpVersion,
    readHiddenModels: () => config.hiddenModels,
    canReadImages: () => attachmentStore !== undefined,
    loadCliModels: async () => {
      const cliPath = findCli()
      if (!cliPath) return []
      const account = accounts.active()
      return fetchAgyModels(cliRun, cliPath, account.dir)
    },
    onCatalogChanged: notifyCatalogChanged,
  })

  const sessionStore = createFileSessionStore(cacheDir, () => {
    log.warn('antigravity-acp: 会话映射读写失败（恢复能力已降级）')
  })

  const runtime = new AcpRuntimeManager({
    subprocess: ctx.subprocess,
    readConfig: () => config,
    resolveAccount: () => accounts.active(),
    fetchImpl: pluginFetch,
    log,
  })

  const adapter = new AntigravityAcpAdapter({
    catalog,
    getLink: (handlers, signal) => runtime.getLink(handlers, signal),
    recycleLink: (link) => runtime.recycle(link),
    sessionStore,
    readSettings: () => ({
      agentMode: config.agentMode,
      resumeSessions: config.resumeSessions,
      cancelGraceMs: config.cancelGraceMs,
      idleRecycleMs: config.idleRecycleMs,
      promptTimeoutMs: config.promptTimeoutMs,
      bridgeParkSettleMs: config.bridgeParkSettleMs,
    }),
    canReadImages: () => attachmentStore !== undefined,
    readImage: (ref, signal) => {
      if (!attachmentStore) throw new LlmError('宿主附件服务不可用，无法读取图片', 'AGY_IMAGE_UNAVAILABLE')
      return attachmentStore.readImage(ref, signal)
    },
    log,
  })

  // 弱依赖附件服务：动态感知图像输入能力。
  ctx.inject(['attachments'], (scope) => {
    const store = scope.attachments
    attachmentStore = store
    notifyCatalogChanged()
    scope.effect(() => () => {
      if (attachmentStore === store) {
        attachmentStore = undefined
        notifyCatalogChanged()
      }
    })
  })

  // 响应隐藏模型等即时设置变更，刷新宿主选择器。
  ctx.on('loader/volatile-update', (paths) => {
    if (paths.some((path) => path[0] === 'hiddenModels')) {
      notifyCatalogChanged()
    }
  })

  // 宿主销毁会话时同步释放 ACP 会话、MCP 作用域与磁盘映射。
  const sessionEvents = ctx as unknown as {
    on(event: 'session/disposed', listener: (session: { id: string }) => void): void
  }
  sessionEvents.on('session/disposed', (session) => {
    try { adapter.releaseConversation(String(session.id)) }
    catch (error) { log.warn('antigravity-acp: 释放已销毁会话失败', error) }
  })

  const unregisterAdapter = ctx.llm.registerAdapter([AGY_PROVIDER_ID], adapter)

  // 注册唯一 RPC 网关：`remote.antigravity`。
  registerAntigravityRemote(ctx)
  ctx.plugin(AntigravityRemoteService, {
    accounts,
    deps: { fetchImpl: pluginFetch },
    cliQuotaEnabled: () => config.cliQuotaEnabled === true,
    resolveCli: () => {
      const cliPath = findCli()
      return cliPath ? { run: cliRun, cliPath } : undefined
    },
    listModels: async (force) => {
      try {
        if (findCli()) await catalog.refreshCliModels(force)
        else if (force) await adapter.discoverModels()
        const models = await catalog.listAllModels(AGY_PROVIDER_ID)
        return {
          status: 'ok',
          models: models.map(({ id, name: modelName, inputModalities }) => ({
            id,
            name: modelName,
            ...(inputModalities ? { inputModalities } : {}),
          })),
        }
      } catch (error) {
        return {
          status: 'error',
          models: [],
          message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
        }
      }
    },
    installCli: async () => {
      const existing = findCli()
      if (existing) return { installed: false, message: `官方 CLI 已存在：${existing}` }
      const outcome = await installAgyCli({
        targetDir: join(homedir(), '.local', 'bin'),
        fetchImpl: pluginFetch as unknown as typeof fetch,
      })
      log.info(`antigravity-acp: 已安装官方 CLI ${outcome.version} → ${outcome.path}`)
      return { installed: true, message: `已安装官方 CLI ${outcome.version}（${outcome.path}）` }
    },
    log,
  })

  // 抑制自动表单生成，由自定义客户端卡片接管设置页。
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.get('settings') as {
      configure: (opts: { auto: boolean }, fiber: unknown) => () => void
    }
    settingsCtx.effect(() => settings.configure({ auto: false }, ctx.fiber), 'antigravity-acp: custom settings card')
  })

  // 卸载清理闭环（逆序释放）。
  ctx.effect(function* () {
    yield () => unregisterAdapter()
    yield async () => {
      try { await adapter.dispose() }
      finally {
        try { await runtime.dispose() }
        finally {
          try { await accounts.dispose() }
          finally {
            try { await sessionStore.close() }
            finally { await pluginFetch.close() }
          }
        }
      }
    }
  }, 'antigravity-acp: lifecycle teardown')
}
