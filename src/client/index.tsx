/**
 * Web Client 插件入口（经 rolldown 打包成单文件 `dist/client.js`）。
 *
 * 硬契约：
 * - 不得导入任何 Node 原生模块（`tsconfig.client.json` 编译期锁定）；
 * - `remote.settings` / `remote.llm` 逐个声明在 `inject` 中；
 * - `remote.antigravity` 绝不写进 `inject`（贡献型 remote 须在 `$mount` 后按需查询）。
 */
import {
  registerComposerQuotaSlot,
  registerProviderSettings,
  setPortalRequire,
} from 'dsh-provider-ui'
import type { SlotsServiceLike } from 'dsh-provider-ui'
import { PACKAGE_NAME } from '../shared/rpc-contract.js'
import { registerClientLocales } from './i18n.js'
import type { ClientLocaleServiceLike } from './i18n.js'
import { AgYQuotaPill } from './quota-view.js'
import type { ModelDirectoryStoreLike } from './quota-view.js'
import { createAntigravityClientApi, mountAntigravityRemote } from './remote.js'
import type { ClientContextLike } from './remote.js'
import { AntigravitySettingsCard } from './settings/SettingsCard.js'

interface ClientCordisContext extends ClientContextLike {
  slots: SlotsServiceLike
  modelDirectories?: { directoryFor(sessionId: string): { store: ModelDirectoryStoreLike } }
  effect(fn: () => (() => void) | void, label?: string): void
  inject(deps: string[], fn: (scope: ClientCordisContext) => void): void
}

const clientPlugin = {
  name: PACKAGE_NAME,
  inject: ['slots', 'remote', 'remote.settings', 'remote.llm'],
  __setOptionalRequire: setPortalRequire,
  apply(ctx: ClientCordisContext): void {
    const getLocale = (): ClientLocaleServiceLike | undefined =>
      ctx.get?.('locale') as ClientLocaleServiceLike | undefined

    ctx.effect(() => registerClientLocales(getLocale()), 'antigravity-acp: locales')

    try {
      const unmount = mountAntigravityRemote(ctx)
      ctx.effect(() => unmount, 'antigravity-acp: mount remote')
    } catch (error) {
      console.error(`[${PACKAGE_NAME}] remote 客户端挂载失败:`, error)
    }

    const api = createAntigravityClientApi(ctx)

    registerProviderSettings(
      ctx,
      {
        id: 'antigravity-acp',
        order: 42,
        label: () => 'Antigravity ACP',
        inject: () => ({ remote: ctx.remote, api, locale: getLocale() }),
      },
      AntigravitySettingsCard,
    )

    ctx.inject(['slots', 'modelDirectories'], (scope) => {
      registerComposerQuotaSlot(
        scope,
        {
          id: 'antigravity-quota',
          order: 1002,
          inject: (sessionId: string) => ({
            store: scope.modelDirectories!.directoryFor(sessionId).store,
            api,
            locale: getLocale(),
          }),
        },
        AgYQuotaPill,
      )
    })
  },
}

export default clientPlugin
