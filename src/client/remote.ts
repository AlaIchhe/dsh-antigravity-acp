/**
 * Web Client 侧 `remote.antigravity` 挂载与调用封装。
 *
 * 复用 `src/shared/rpc-contract.ts` 的唯一契约（不再手写第二份 codec），
 * 通过短轮询等待已挂载的贡献型 remote 服务就绪（绝不把 `remote.antigravity` 写进 inject）。
 */
import {
  ANTIGRAVITY_REMOTE_INVOCATIONS,
  PACKAGE_NAME,
  REMOTE_SERVICE_NAME,
} from '../shared/rpc-contract.js'
import type {
  AccountIdRequest,
  AccountsResult,
  InstallCliResult,
  ListModelsRequest,
  ModelsResult,
  QuotaSnapshot,
  ReadQuotaRequest,
  StartLoginRequest,
  SubmitCallbackRequest,
} from '../shared/rpc-contract.js'

export interface RemoteEnvelope<T> {
  ok: boolean
  value?: T
  error?: { message?: string }
}

export function unwrapEnvelope<T>(result: T | RemoteEnvelope<T>): T {
  if (result && typeof result === 'object' && 'ok' in result) {
    const env = result as RemoteEnvelope<T>
    if (env.ok) return env.value as T
    throw new Error(env.error?.message || '未知错误')
  }
  return result as T
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    Promise.resolve(promise),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

export interface ClientContextLike {
  get?(name: string): unknown
  remote?: {
    $mount?(spec: { package: string; descriptors: unknown[] }): () => void
    $on?(event: string, listener: (ns?: string) => void): () => void
    settings?: {
      describe(): Promise<unknown>
      mutate(entryId: string, ops: Array<{ op: 'set'; path: string[]; value: unknown }>, revision: number): Promise<unknown>
    }
    llm?: {
      listProviders?(): Promise<unknown>
    }
  }
}

interface RawRemoteFace {
  readQuota?(req?: ReadQuotaRequest): Promise<unknown>
  listModels?(req?: ListModelsRequest): Promise<unknown>
  listAccounts?(): Promise<unknown>
  startAccountLogin?(req: StartLoginRequest): Promise<unknown>
  submitAccountCallback?(req: SubmitCallbackRequest): Promise<unknown>
  cancelAccountLogin?(): Promise<unknown>
  activateAccount?(req: AccountIdRequest): Promise<unknown>
  removeAccount?(req: AccountIdRequest): Promise<unknown>
  installCli?(): Promise<unknown>
}

export interface AntigravityClientApi {
  /** 读取当前账号额度并广播给额度药丸。 */
  readCurrentQuota(req?: Omit<ReadQuotaRequest, 'accountId'>): Promise<QuotaSnapshot>
  /** 读取指定账号额度（不广播给药丸，用于设置页逐账号卡片）。 */
  readAccountQuota(accountId: string, force?: boolean): Promise<QuotaSnapshot>
  /** 订阅当前账号最新额度（药丸用）。 */
  subscribeCurrentQuota(listener: (snapshot: QuotaSnapshot) => void): () => void
  /** 账号切换/登录/删除后通知药丸重新取数。 */
  notifyAccountChanged(): void
  subscribeAccountChanged(listener: () => void): () => void

  listModels(force?: boolean): Promise<ModelsResult>
  listAccounts(): Promise<AccountsResult>
  startAccountLogin(req: StartLoginRequest): Promise<AccountsResult>
  submitAccountCallback(callbackUrl: string): Promise<AccountsResult>
  cancelAccountLogin(): Promise<AccountsResult>
  activateAccount(id: string): Promise<AccountsResult>
  removeAccount(id: string): Promise<AccountsResult>
  installCli(): Promise<InstallCliResult>
}

const REMOTE_KEY = `remote.${REMOTE_SERVICE_NAME}`
const MOUNT_WAIT_MS = 6_000
const CALL_TIMEOUT_MS = 45_000

async function waitForRemoteFace(ctx: ClientContextLike): Promise<RawRemoteFace> {
  const deadline = Date.now() + MOUNT_WAIT_MS
  for (;;) {
    const face = ctx.get?.(REMOTE_KEY) as RawRemoteFace | undefined
    if (face && typeof face.readQuota === 'function') return face
    if (Date.now() >= deadline) {
      throw new Error(`宿主 ${REMOTE_KEY} 服务未就绪；请确认 Host 插件已启用且版本一致`)
    }
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
}

/** 挂载 `remote.antigravity` 客户端描述符（每包仅执行一次）。 */
export function mountAntigravityRemote(ctx: ClientContextLike): () => void {
  if (typeof ctx.remote?.$mount !== 'function') return () => undefined
  return ctx.remote.$mount({
    package: PACKAGE_NAME,
    descriptors: [...ANTIGRAVITY_REMOTE_INVOCATIONS],
  })
}

export function createAntigravityClientApi(ctx: ClientContextLike): AntigravityClientApi {
  const quotaListeners = new Set<(snapshot: QuotaSnapshot) => void>()
  const accountListeners = new Set<() => void>()

  const call = async <T>(
    invoke: (face: RawRemoteFace) => Promise<unknown> | undefined,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<T> => {
    const face = await waitForRemoteFace(ctx)
    const raw = invoke(face)
    if (!raw) throw new Error('远程方法不可用')
    return unwrapEnvelope<T>(await withTimeout(raw, timeoutMs, '请求 Host 超时，请稍后重试') as T | RemoteEnvelope<T>)
  }

  return {
    async readCurrentQuota(req) {
      const snapshot = await call<QuotaSnapshot>((face) => face.readQuota?.(req))
      if (snapshot.status === 'ok') {
        for (const listener of quotaListeners) listener(snapshot)
      }
      return snapshot
    },
    async readAccountQuota(accountId, force = false) {
      return call<QuotaSnapshot>((face) => face.readQuota?.({ accountId, force }))
    },
    subscribeCurrentQuota(listener) {
      quotaListeners.add(listener)
      return () => { quotaListeners.delete(listener) }
    },
    notifyAccountChanged() {
      for (const listener of accountListeners) listener()
    },
    subscribeAccountChanged(listener) {
      accountListeners.add(listener)
      return () => { accountListeners.delete(listener) }
    },
    listModels: (force = false) => call<ModelsResult>((face) => face.listModels?.({ force })),
    listAccounts: () => call<AccountsResult>((face) => face.listAccounts?.()),
    startAccountLogin: (req) => call<AccountsResult>((face) => face.startAccountLogin?.(req)),
    submitAccountCallback: (callbackUrl) => call<AccountsResult>((face) => face.submitAccountCallback?.({ callbackUrl })),
    cancelAccountLogin: () => call<AccountsResult>((face) => face.cancelAccountLogin?.()),
    activateAccount: (id) => call<AccountsResult>((face) => face.activateAccount?.({ id })),
    removeAccount: (id) => call<AccountsResult>((face) => face.removeAccount?.({ id })),
    installCli: () => call<InstallCliResult>((face) => face.installCli?.(), 180_000),
  }
}
