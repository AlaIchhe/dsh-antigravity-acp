/**
 * 设置页「账号」标签：多账号卡片（切换 / 登录 / 重新登录 / 删除）、无头手动回调粘贴、
 * 逐账号自动读取额度与官方 CLI 一键安装按钮。
 */
import React from 'react'
import type { AccountView, AccountsResult, QuotaSnapshot } from '../../shared/rpc-contract.js'
import type { AntigravityClientApi } from '../remote.js'
import { QuotaDetails } from '../quota-view.js'

function AccountQuotaBlock({ api, account }: { api: AntigravityClientApi; account: AccountView }) {
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

  React.useEffect(() => {
    void load(false)
    return () => { versionRef.current += 1 }
  }, [load])

  return (
    <div style={{ display: 'grid', gap: '6px', paddingTop: '6px', borderTop: '1px solid rgba(128,128,128,.16)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontSize: '11px', opacity: 0.8 }}>
          {data?.plan ? `套餐：${data.plan}` : '套餐额度'}
        </span>
        <button type="button" className="agy-btn" disabled={refreshing} onClick={() => { void load(true) }}>
          {refreshing ? '刷新中…' : '刷新额度'}
        </button>
      </div>
      <QuotaDetails data={data} showCredits={true} />
    </div>
  )
}

export function AccountsTab({ api }: { api: AntigravityClientApi }) {
  const [state, setState] = React.useState<AccountsResult | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState<{ kind: 'ok' | 'error' | 'busy'; text: string } | null>(null)
  const [newAlias, setNewAlias] = React.useState('')
  const [callbackUrl, setCallbackUrl] = React.useState('')
  const [installingCli, setInstallingCli] = React.useState(false)
  const aliveRef = React.useRef(true)

  React.useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  const refresh = React.useCallback(async () => {
    try {
      const result = await api.listAccounts()
      if (aliveRef.current) setState(result)
    } catch (error) {
      if (aliveRef.current) setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }, [api])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  // 等待浏览器授权或换码期间轮询登录状态
  const authPhase = state?.auth.phase
  React.useEffect(() => {
    if (authPhase !== 'preparing' && authPhase !== 'waiting' && authPhase !== 'exchanging') return
    const timer = setInterval(() => {
      void api.listAccounts().then((next) => {
        setState(next)
        if (next.auth.phase === 'done') {
          setNotice({ kind: 'ok', text: next.auth.message ?? '登录成功' })
          setCallbackUrl('')
          api.notifyAccountChanged()
        } else if (next.auth.phase === 'failed') {
          setNotice({ kind: 'error', text: next.auth.message ?? '登录失败' })
        }
      }).catch(() => undefined)
    }, 1_500)
    return () => clearInterval(timer)
  }, [api, authPhase])

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
    setNotice({ kind: 'busy', text: '正在下载并校验官方 agy CLI…' })
    try {
      const outcome = await api.installCli()
      setNotice({ kind: 'ok', text: outcome.message })
      await refresh()
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setInstallingCli(false)
    }
  }

  const auth = state?.auth
  const authInFlight = auth?.phase === 'preparing' || auth?.phase === 'waiting' || auth?.phase === 'exchanging'

  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      {notice ? <p className="agy-notice" data-kind={notice.kind} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</p> : null}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
        <input
          type="text"
          className="agy-input"
          style={{ flex: '1 1 160px', width: 'auto' }}
          placeholder="新账号备注名（可选）"
          value={newAlias}
          disabled={busy || authInFlight}
          onChange={(e) => setNewAlias(e.target.value)}
        />
        <button
          type="button"
          className="agy-btn agy-btn-primary"
          disabled={busy || authInFlight}
          onClick={() => {
            const alias = newAlias.trim()
            setNewAlias('')
            void runAction(() => api.startAccountLogin({ mode: 'add', ...(alias ? { alias } : {}) }))
          }}
        >
          新增账号登录
        </button>
        {state && !state.cliInstalled ? (
          <button type="button" className="agy-btn" disabled={installingCli} onClick={() => { void handleInstallCli() }}>
            {installingCli ? '安装中…' : '安装官方 CLI'}
          </button>
        ) : null}
      </div>

      {authInFlight ? (
        <section className="agy-account-card" aria-label="进行中的授权流程">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
            <strong>{auth?.message ?? '等待完成 Google 授权…'}</strong>
            <button type="button" className="agy-btn" onClick={() => { void runAction(() => api.cancelAccountLogin()) }}>
              取消登录
            </button>
          </div>
          {auth?.authUrl ? (
            <div style={{ display: 'grid', gap: '8px' }}>
              <a href={auth.authUrl} target="_blank" rel="noreferrer" style={{ fontSize: '12px', wordBreak: 'break-all' }}>
                打开 Google 授权页面
              </a>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  type="text"
                  className="agy-input"
                  placeholder="无头主机：粘贴浏览器跳转后的完整回调地址（http://localhost:51121/oauth-callback?...）"
                  value={callbackUrl}
                  onChange={(e) => setCallbackUrl(e.target.value)}
                />
                <button
                  type="button"
                  className="agy-btn agy-btn-primary"
                  disabled={!callbackUrl.trim() || busy}
                  onClick={() => { void runAction(() => api.submitAccountCallback(callbackUrl.trim())) }}
                >
                  提交回调
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      <div style={{ display: 'grid', gap: '10px' }}>
        {(state?.accounts ?? []).map((account) => (
          <article key={account.id} className="agy-account-card" data-active={account.active ? 'true' : 'false'}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px' }}>
                <strong>{account.alias}</strong>
                {account.email ? <span style={{ fontSize: '12px', opacity: 0.78 }}>{account.email}</span> : null}
                {account.active ? <span className="agy-tag agy-tag-ok">当前使用</span> : null}
                <span className="agy-tag">{account.ready ? '已登录' : '未登录'}</span>
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                {!account.active ? (
                  <button
                    type="button"
                    className="agy-btn agy-btn-primary"
                    disabled={busy}
                    onClick={() => { void runAction(() => api.activateAccount(account.id), true) }}
                  >
                    使用此账号
                  </button>
                ) : null}
                {!account.system ? (
                  <>
                    <button
                      type="button"
                      className="agy-btn"
                      disabled={busy || authInFlight}
                      onClick={() => { void runAction(() => api.startAccountLogin({ mode: 'relogin', id: account.id })) }}
                    >
                      重新登录
                    </button>
                    <button
                      type="button"
                      className="agy-btn agy-btn-danger"
                      disabled={busy}
                      onClick={() => { void runAction(() => api.removeAccount(account.id), true) }}
                    >
                      删除
                    </button>
                  </>
                ) : null}
              </div>
            </div>
            <AccountQuotaBlock api={api} account={account} />
          </article>
        ))}
      </div>
    </div>
  )
}
