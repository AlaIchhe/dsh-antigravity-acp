/**
 * 设置页「账号」标签：多账号卡片（切换 / 登录 / 重新登录 / 二次确认删除）、
 * 无头手动回调粘贴、已登录账号按需读取额度与官方 CLI 一键安装按钮。
 */
import React from 'react'
import { Button, Card, CodeBlock, ConfirmButton, Notice, Tag, TextInput } from 'dsh-provider-ui'
import type { AccountView, AccountsResult, QuotaSnapshot } from '../../shared/rpc-contract.js'
import { createStaticTranslator } from '../i18n.js'
import type { TranslateFn } from '../i18n.js'
import type { AntigravityClientApi } from '../remote.js'
import { QuotaDetails } from '../quota-view.js'

const DEFAULT_T = createStaticTranslator('zh')

function AccountQuotaBlock({
  api,
  account,
  active,
  t,
}: {
  api: AntigravityClientApi
  account: AccountView
  active: boolean
  t: TranslateFn
}) {
  const [data, setData] = React.useState<QuotaSnapshot | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)
  const versionRef = React.useRef(0)

  const load = React.useCallback(async (force: boolean) => {
    const version = ++versionRef.current
    setRefreshing(true)
    try {
      const value = await api.readAccountQuota(account.id, force)
      if (version === versionRef.current) setData(value)
    } catch (error) {
      if (version === versionRef.current) {
        setData({
          status: 'error',
          updatedAt: new Date().toISOString(),
          groups: [],
          error: { code: 'request-failed', message: error instanceof Error ? error.message : String(error) },
        })
      }
    } finally {
      if (version === versionRef.current) setRefreshing(false)
    }
  }, [api, account.id])

  // 仅当账号标签可见且账号已登录时自动取数，避免隐藏标签或未登录账号触发无效报错请求。
  React.useEffect(() => {
    if (!active || !account.ready) return
    void load(false)
    return () => { versionRef.current += 1 }
  }, [active, account.ready, load])

  return (
    <div style={{ display: 'grid', gap: '6px', paddingTop: '6px', borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.16))' }}>
      <div className="dpui-row-between">
        <span className="dpui-field-desc">
          {data?.plan ? `${t('accounts.planPrefix')}${data.plan}` : t('accounts.planQuota')}
        </span>
        <Button disabled={refreshing} onClick={() => { void load(true) }}>
          {refreshing ? t('accounts.refreshing') : t('accounts.refreshQuota')}
        </Button>
      </div>
      {!account.ready && !data ? (
        <span className="dpui-field-desc">{t('accounts.notReadyQuotaHint')}</span>
      ) : (
        <QuotaDetails data={data} showCredits={true} t={t} />
      )}
    </div>
  )
}

export function AccountsTab({
  api,
  active = true,
  t = DEFAULT_T,
}: {
  api: AntigravityClientApi
  active?: boolean
  t?: TranslateFn
}) {
  const [state, setState] = React.useState<AccountsResult | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState<{ kind: 'ok' | 'error' | 'busy'; text: string } | null>(null)
  const [newAlias, setNewAlias] = React.useState('')
  const [callbackUrl, setCallbackUrl] = React.useState('')
  const [copiedState, setCopiedState] = React.useState<'idle' | 'copied' | 'failed'>('idle')
  const [installingCli, setInstallingCli] = React.useState(false)
  const aliveRef = React.useRef(true)
  const copyTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  React.useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      if (copyTimerRef.current !== undefined) clearTimeout(copyTimerRef.current)
    }
  }, [])

  const refresh = React.useCallback(async () => {
    try {
      const result = await api.listAccounts()
      if (aliveRef.current) {
        setState(result)
        setNotice((prev) => (prev?.kind === 'error' ? null : prev))
      }
    } catch (error) {
      if (aliveRef.current) setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }, [api])

  React.useEffect(() => {
    if (!active) return
    void refresh()
  }, [active, refresh])

  // 等待浏览器授权或换码期间轮询登录状态
  const authPhase = state?.auth.phase
  React.useEffect(() => {
    if (authPhase !== 'preparing' && authPhase !== 'waiting' && authPhase !== 'exchanging') return
    const timer = setInterval(() => {
      void api.listAccounts().then((next) => {
        if (!aliveRef.current) return
        setState(next)
        if (next.auth.phase === 'done') {
          setNotice({ kind: 'ok', text: next.auth.message ?? t('accounts.loginSuccess') })
          setCallbackUrl('')
          api.notifyAccountChanged()
        } else if (next.auth.phase === 'failed') {
          setNotice({ kind: 'error', text: next.auth.message ?? t('accounts.loginFailed') })
        }
      }).catch(() => undefined)
    }, 1_500)
    return () => clearInterval(timer)
  }, [api, authPhase, t])

  const runAction = async (fn: () => Promise<AccountsResult>, notifyPill = false) => {
    setBusy(true)
    try {
      const next = await fn()
      if (!aliveRef.current) return
      setState(next)
      if (next.auth.phase === 'done') setCallbackUrl('')
      if (next.message) setNotice({ kind: 'ok', text: next.message })
      if (notifyPill || next.auth.phase === 'done') api.notifyAccountChanged()
    } catch (error) {
      if (aliveRef.current) setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }

  const handleInstallCli = async () => {
    setInstallingCli(true)
    setNotice({ kind: 'busy', text: t('accounts.installingCliNotice') })
    try {
      const outcome = await api.installCli()
      if (!aliveRef.current) return
      setNotice({ kind: 'ok', text: outcome.message })
      await refresh()
    } catch (error) {
      if (aliveRef.current) setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      if (aliveRef.current) setInstallingCli(false)
    }
  }

  const copyAuthUrl = (url: string) => {
    const done = (ok: boolean) => {
      if (!aliveRef.current) return
      setCopiedState(ok ? 'copied' : 'failed')
      if (copyTimerRef.current !== undefined) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = undefined
        if (aliveRef.current) setCopiedState('idle')
      }, 2_000)
    }
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (clipboard && typeof clipboard.writeText === 'function') {
      void clipboard.writeText(url).then(() => done(true), () => done(false))
    } else {
      done(false)
    }
  }

  const auth = state?.auth
  const authInFlight = auth?.phase === 'preparing' || auth?.phase === 'waiting' || auth?.phase === 'exchanging'

  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      {notice ? (
        <Notice kind={notice.kind}>
          <div className="dpui-row-between">
            <span>{notice.text}</span>
            {!state && notice.kind === 'error' ? (
              <Button onClick={() => { void refresh() }}>
                {t('accounts.retry')}
              </Button>
            ) : null}
          </div>
        </Notice>
      ) : null}

      <div className="dpui-row">
        <TextInput
          type="text"
          style={{ flex: '1 1 160px', width: 'auto' }}
          placeholder={t('accounts.newAliasPlaceholder')}
          value={newAlias}
          disabled={busy || authInFlight}
          onChange={(e) => setNewAlias(e.target.value)}
        />
        <Button
          variant="primary"
          disabled={busy || authInFlight}
          onClick={() => {
            const alias = newAlias.trim()
            setNewAlias('')
            void runAction(() => api.startAccountLogin({ mode: 'add', ...(alias ? { alias } : {}) }))
          }}
        >
          {t('accounts.addLogin')}
        </Button>
        {state && !state.cliInstalled ? (
          <Button disabled={installingCli} onClick={() => { void handleInstallCli() }}>
            {installingCli ? t('accounts.installingCli') : t('accounts.installCli')}
          </Button>
        ) : null}
      </div>

      {authInFlight ? (
        <Card aria-label={t('accounts.authInProgress')}>
          <div className="dpui-row-between">
            <strong>{auth?.message ?? t('accounts.waitingAuth')}</strong>
            <Button onClick={() => { void runAction(() => api.cancelAccountLogin()) }}>
              {t('accounts.cancelLogin')}
            </Button>
          </div>
          {auth?.authUrl ? (
            <div style={{ display: 'grid', gap: '8px' }}>
              <div className="dpui-row">
                <Button onClick={() => copyAuthUrl(auth.authUrl!)}>
                  {copiedState === 'copied'
                    ? t('accounts.copied')
                    : copiedState === 'failed'
                      ? t('accounts.copyFailed')
                      : t('accounts.copyAuthUrl')}
                </Button>
                <a href={auth.authUrl} target="_blank" rel="noreferrer noopener" style={{ fontSize: '12px' }}>
                  {t('accounts.openAuthPage')}
                </a>
              </div>
              <CodeBlock>{auth.authUrl}</CodeBlock>
              <div className="dpui-row">
                <TextInput
                  type="text"
                  style={{ flex: '1 1 200px', width: 'auto' }}
                  placeholder={t('accounts.callbackPlaceholder')}
                  value={callbackUrl}
                  onChange={(e) => setCallbackUrl(e.target.value)}
                />
                <Button
                  variant="primary"
                  disabled={!callbackUrl.trim() || busy}
                  onClick={() => { void runAction(() => api.submitAccountCallback(callbackUrl.trim())) }}
                >
                  {t('accounts.submitCallback')}
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}

      <div style={{ display: 'grid', gap: '10px' }}>
        {(state?.accounts ?? []).map((account) => (
          <Card key={account.id} as="article" active={account.active}>
            <div className="dpui-row-between">
              <div className="dpui-row">
                <strong>{account.alias}</strong>
                {account.email ? <span className="dpui-muted">{account.email}</span> : null}
                {account.active ? <Tag tone="ok">{t('accounts.activeTag')}</Tag> : null}
                <Tag>{account.ready ? t('accounts.readyTag') : t('accounts.notReadyTag')}</Tag>
              </div>
              <div className="dpui-row">
                {!account.active ? (
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() => { void runAction(() => api.activateAccount(account.id), true) }}
                  >
                    {t('accounts.useAccount')}
                  </Button>
                ) : null}
                {!account.system ? (
                  <>
                    <Button
                      disabled={busy || authInFlight}
                      onClick={() => { void runAction(() => api.startAccountLogin({ mode: 'relogin', id: account.id })) }}
                    >
                      {t('accounts.relogin')}
                    </Button>
                    <ConfirmButton
                      label={t('accounts.delete')}
                      confirmLabel={t('accounts.confirmDelete')}
                      disabled={busy}
                      onConfirm={() => { void runAction(() => api.removeAccount(account.id), true) }}
                    />
                  </>
                ) : null}
              </div>
            </div>
            <AccountQuotaBlock api={api} account={account} active={active} t={t} />
          </Card>
        ))}
      </div>
    </div>
  )
}
