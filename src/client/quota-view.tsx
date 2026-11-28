/**
 * 额度展示与输入框旁额度药丸（基于 dsh-provider-ui 统一组件）。
 *
 * - 保留未知额度组（不静默丢弃），支持前端切模型零重复请求；
 * - 额度药丸支持点击弹出 fixed popover（经 portal 挂载到 `document.body`）查看全部额度组与手动刷新。
 */
import React from 'react'
import { ComposerQuotaPill, KeyValueRow, Notice, QuotaProgressBar, resolveQuotaTone } from 'dsh-provider-ui'
import { MODEL_GROUPS, groupedQuotas as groupQuotaEntries, matchQuotaGroupForModel, modelGroupFor } from '../shared/model-groups.js'
import type { GroupedQuotaEntry } from '../shared/model-groups.js'
import { PROVIDER_ID } from '../shared/rpc-contract.js'
import type { CreditsSnapshot, QuotaBucket, QuotaSnapshot } from '../shared/rpc-contract.js'
import { createStaticTranslator, useClientTranslator } from './i18n.js'
import type { ClientLocaleServiceLike, TranslateFn } from './i18n.js'
import type { AntigravityClientApi } from './remote.js'

const POLL_INTERVAL_MS = 180_000
const DEFAULT_T = createStaticTranslator('zh')

export { matchQuotaGroupForModel }
export type { GroupedQuotaEntry }

export function bucketPercentage(bucket: QuotaBucket): number | undefined {
  if (typeof bucket.remainingPct === 'number' && Number.isFinite(bucket.remainingPct)) {
    return Math.max(0, Math.min(100, bucket.remainingPct))
  }
  if (typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction)) {
    return Math.max(0, Math.min(100, bucket.remainingFraction * 100))
  }
  return undefined
}

export function windowLabel(bucket: QuotaBucket, t: TranslateFn = DEFAULT_T): string {
  const win = bucket.window?.toLowerCase()
  if (win === '5h' || /five\s*hour|5\s*h/i.test(bucket.name)) return t('quota.window5h')
  if (win === 'weekly' || win === '7d' || /week/i.test(bucket.name)) return t('quota.windowWeekly')
  return bucket.name || t('quota.windowDefault')
}

function resetCountdown(resetTime: string | undefined, t: TranslateFn): string {
  if (!resetTime) return ''
  const target = Date.parse(resetTime)
  if (!Number.isFinite(target)) return resetTime
  const diffMs = target - Date.now()
  if (diffMs <= 0) return t('quota.resetSoon')
  const minutes = Math.ceil(diffMs / 60_000)
  if (minutes < 60) return t('quota.resetMin', { m: minutes })
  const hours = Math.floor(minutes / 60)
  const remMin = minutes % 60
  if (hours < 24) return remMin > 0 ? t('quota.resetHourMin', { h: hours, m: remMin }) : t('quota.resetHour', { h: hours })
  const days = Math.floor(hours / 24)
  return t('quota.resetDayHour', { d: days, h: hours % 24 })
}

/**
 * 将后端返回的额度组按预设家族聚合，同时保留未命中预设家族的原始组（绝不静默丢弃）。
 */
export function groupedQuotas(
  data: QuotaSnapshot | null | undefined,
  t: TranslateFn = DEFAULT_T,
): GroupedQuotaEntry[] {
  return groupQuotaEntries(data, t('quota.otherGroup'))
}

export function CreditsDetails({
  credits,
  pending,
  t = DEFAULT_T,
}: {
  credits?: CreditsSnapshot
  pending: boolean
  t?: TranslateFn
}) {
  if (credits?.error?.code === 'cli-disabled') return null
  const valid = credits?.status === 'ok' && typeof credits.remainingCredits === 'number' && Number.isSafeInteger(credits.remainingCredits) && credits.remainingCredits >= 0
  const label = valid
    ? credits.remainingCredits!.toLocaleString()
    : pending
      ? t('quota.loading')
      : credits?.status === 'error'
        ? t('quota.queryFailed')
        : t('quota.notProvided')
  return (
    <section
      aria-label={t('quota.creditsAria')}
      style={{ padding: '8px 0 0', borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.16))' }}
    >
      <KeyValueRow label={<strong>{t('quota.creditsLabel')}</strong>} value={label} />
      {!valid && credits?.error?.message ? (
        <div className="dpui-field-desc" style={{ marginTop: '2px' }}>{credits.error.message}</div>
      ) : null}
    </section>
  )
}

export function QuotaDetails({
  data,
  showCredits = true,
  t = DEFAULT_T,
}: {
  data: QuotaSnapshot | null
  showCredits?: boolean
  t?: TranslateFn
}) {
  const groups = groupedQuotas(data, t)
  return (
    <div style={{ display: 'grid', gap: '10px' }}>
      {data?.status === 'error' && data.error?.message ? (
        <Notice kind="error">{data.error.message}</Notice>
      ) : null}
      {groups.length > 0 ? (
        groups.map((group) => (
          <section key={group.key} aria-label={group.name} style={{ display: 'grid', gap: '6px' }}>
            <strong style={{ fontSize: '12px' }}>{group.name}</strong>
            <div style={{ display: 'grid', gap: '6px' }}>
              {group.buckets.map((bucket, idx) => {
                const pct = bucketPercentage(bucket)
                const value = bucket.disabled ? t('quota.disabled') : pct === undefined ? t('quota.unknown') : `${Math.round(pct)}%`
                return (
                  <div key={`${group.key}-${idx}`} style={{ display: 'grid', gap: '3px' }}>
                    <KeyValueRow label={windowLabel(bucket, t)} value={value} />
                    <QuotaProgressBar
                      pct={pct}
                      disabled={bucket.disabled}
                      label={`${group.name} ${windowLabel(bucket, t)}${t('quota.remainingSuffix')}`}
                    />
                    {bucket.resetTime || bucket.disabled ? (
                      <div className="dpui-field-desc">
                        {bucket.disabled ? (bucket.description ?? t('quota.disabledWindow')) : resetCountdown(bucket.resetTime, t)}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </section>
        ))
      ) : data?.status !== 'error' ? (
        <span className="dpui-field-desc">{data ? t('quota.noData') : t('quota.loadingQuota')}</span>
      ) : null}
      {showCredits ? <CreditsDetails credits={data?.credits} pending={!data} t={t} /> : null}
    </div>
  )
}

export interface ModelDirectoryStoreLike {
  subscribe(listener: () => void): () => void
  getSnapshot(): { current?: { provider?: string; model?: string } } | undefined
}

export function AgYQuotaPill({
  store,
  api,
  locale,
}: {
  store: ModelDirectoryStoreLike
  api: AntigravityClientApi
  locale?: ClientLocaleServiceLike
}) {
  const t = useClientTranslator(locale)
  const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const isAcp = snapshot?.current?.provider === PROVIDER_ID
  const model = snapshot?.current?.model
  const [data, setData] = React.useState<QuotaSnapshot | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)
  const loadRef = React.useRef<((force: boolean) => Promise<void>) | undefined>(undefined)

  // 同账号下切模型不重发 RPC：单次快照已含所有额度组，仅前端切换展示分组。
  React.useEffect(() => {
    if (!isAcp) return
    let alive = true
    const load = async (force: boolean) => {
      if (alive && force) setRefreshing(true)
      try {
        const value = await api.readCurrentQuota({ force })
        if (alive) setData(value)
      } catch (error) {
        if (alive) {
          setData({
            status: 'error',
            updatedAt: new Date().toISOString(),
            groups: [],
            error: { code: 'request-failed', message: error instanceof Error ? error.message : String(error) },
          })
        }
      } finally {
        if (alive && force) setRefreshing(false)
      }
    }
    loadRef.current = load
    void load(false)
    const offQuota = api.subscribeCurrentQuota((next) => { if (alive) setData(next) })
    const offAccount = api.subscribeAccountChanged(() => { void load(true) })
    const timer = setInterval(() => { void load(false) }, POLL_INTERVAL_MS)
    return () => {
      alive = false
      loadRef.current = undefined
      offQuota()
      offAccount()
      clearInterval(timer)
    }
  }, [api, isAcp])

  if (!isAcp) return null

  const groups = groupedQuotas(data, t)
  const group = matchQuotaGroupForModel(groups, model ?? data?.requestedModel)
  const buckets = group?.buckets ?? []
  const usable = buckets.filter((b) => !b.disabled && bucketPercentage(b) !== undefined)
  const worst = usable.length > 0 ? Math.min(...usable.map((b) => bucketPercentage(b)!)) : undefined
  const failed = data?.status === 'error'
  const knownFamily = modelGroupFor(model ?? data?.requestedModel)
  const familyName = group?.name
    ?? MODEL_GROUPS.find((entry) => entry.key === knownFamily)?.name
    ?? t('quota.windowDefault')
  const value = failed
    ? t('quota.readFailed')
    : !data
      ? t('quota.reading')
      : !group
        ? t('quota.unknown')
        : worst === undefined
          ? (buckets.some((b) => b.disabled) ? t('quota.disabled') : t('quota.unknown'))
          : `${Math.round(worst)}%`
  const tone = failed ? 'error' : resolveQuotaTone(worst)
  const label = failed
    ? `${familyName} ${t('quota.readFailed')}${data?.error?.message ? `：${data.error.message}` : ''}`
    : `${familyName} ${value}${buckets.length ? ` · ${buckets.map((b) => `${windowLabel(b, t)} ${b.disabled ? t('quota.disabled') : bucketPercentage(b) === undefined ? t('quota.unknown') : `${Math.round(bucketPercentage(b)!)}%`}`).join(' · ')}` : ''}`

  return (
    <ComposerQuotaPill
      className="antigravity-usage-pill"
      label={familyName}
      value={value}
      ariaLabel={label}
      title={label}
      tone={tone}
      miniBars={buckets.map((bucket) => ({
        pct: bucketPercentage(bucket),
        disabled: bucket.disabled,
        label: `${familyName} ${windowLabel(bucket, t)}${t('quota.remainingSuffix')}`,
      }))}
      popoverTitle={data?.plan ? `${t('accounts.planPrefix')}${data.plan}` : t('quota.popoverTitle')}
      popoverAriaLabel={t('quota.popoverTitle')}
      onRefresh={() => { void loadRef.current?.(true) }}
      refreshing={refreshing}
      refreshLabel={t('quota.refresh')}
      refreshingLabel={t('accounts.refreshing')}
      closeLabel={t('quota.close')}
    >
      <QuotaDetails data={data} showCredits={true} t={t} />
    </ComposerQuotaPill>
  )
}
