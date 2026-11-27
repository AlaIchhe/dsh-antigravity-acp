/**
 * 额度展示与输入框旁额度药丸（TSX 版）。
 *
 * - 保留未知额度组（不静默丢弃），支持前端切模型零重复请求；
 * - 额度药丸支持点击弹出 fixed popover（经 portal 挂载到 `document.body`）查看全部额度组与手动刷新；
 * - 全量适配 DSH Theme Tokens（`--dsw-alias-*`）与 Client locale 服务。
 */
import React from 'react'
import { MODEL_GROUPS, groupedQuotas as groupQuotaEntries, matchQuotaGroupForModel, modelGroupFor } from '../shared/model-groups.js'
import type { GroupedQuotaEntry } from '../shared/model-groups.js'
import { PROVIDER_ID } from '../shared/rpc-contract.js'
import type { CreditsSnapshot, QuotaBucket, QuotaSnapshot } from '../shared/rpc-contract.js'
import { createStaticTranslator, useClientTranslator } from './i18n.js'
import type { ClientLocaleServiceLike, TranslateFn } from './i18n.js'
import { renderInBodyPortal } from './portal.js'
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

function barColor(pct: number | undefined, disabled: boolean): string {
  if (disabled || pct === undefined) return 'var(--dsw-alias-state-idle-primary, #8b909a)'
  if (pct <= 10) return 'var(--dsw-alias-state-error-primary, #e5534b)'
  if (pct <= 25) return 'var(--dsw-alias-state-warn-primary, #d99b28)'
  return 'var(--dsw-alias-state-success-primary, #25b879)'
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

function RemainingBar({
  bucket,
  mini,
  height,
  label,
}: {
  bucket: QuotaBucket
  mini?: boolean
  height?: number
  label: string
}) {
  const pct = bucketPercentage(bucket)
  const width = bucket.disabled || pct === undefined ? 0 : Math.max(0, Math.min(100, pct))
  const h = height ?? (mini ? 4 : 6)
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct === undefined ? undefined : Math.round(pct)}
      style={{
        display: 'block',
        width: mini ? '28px' : '100%',
        height: `${h}px`,
        borderRadius: '99px',
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.22))',
        overflow: 'hidden',
      }}
    >
      <span
        style={{
          display: 'block',
          width: `${width}%`,
          height: '100%',
          background: barColor(pct, bucket.disabled),
          borderRadius: '99px',
        }}
      />
    </span>
  )
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px' }}>
        <strong style={{ fontSize: '12px' }}>{t('quota.creditsLabel')}</strong>
        <span style={{ fontSize: '12px', fontVariantNumeric: 'tabular-nums', opacity: valid ? 1 : 0.7 }}>{label}</span>
      </div>
      {!valid && credits?.error?.message ? (
        <div style={{ fontSize: '11px', opacity: 0.75, marginTop: '2px' }}>{credits.error.message}</div>
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
        <p className="agy-notice" data-kind="error" role="alert">
          {data.error.message}
        </p>
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
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', gap: '8px' }}>
                      <span>{windowLabel(bucket, t)}</span>
                      <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.9 }}>{value}</span>
                    </div>
                    <RemainingBar bucket={bucket} label={`${group.name} ${windowLabel(bucket, t)}${t('quota.remainingSuffix')}`} />
                    {bucket.resetTime || bucket.disabled ? (
                      <div style={{ fontSize: '11px', opacity: 0.72 }}>
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
        <span style={{ fontSize: '11px', opacity: 0.75 }}>{data ? t('quota.noData') : t('quota.loadingQuota')}</span>
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
  const [open, setOpen] = React.useState(false)
  const [popoverPos, setPopoverPos] = React.useState<{ left: number; bottom: number }>({ left: 16, bottom: 56 })
  const pillRef = React.useRef<HTMLButtonElement | null>(null)
  const popoverRef = React.useRef<HTMLDivElement | null>(null)
  const loadRef = React.useRef<((force: boolean) => Promise<void>) | undefined>(undefined)

  // 同账号下切模型不重发 RPC：单次快照已含所有额度组，仅前端切换展示分组。
  React.useEffect(() => {
    if (!isAcp) {
      setOpen(false)
      return
    }
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

  const updatePopoverPosition = React.useCallback(() => {
    if (typeof window === 'undefined' || !pillRef.current) return
    const rect = pillRef.current.getBoundingClientRect()
    const width = Math.min(320, Math.max(220, window.innerWidth - 24))
    const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))
    const bottom = Math.max(12, window.innerHeight - rect.top + 8)
    setPopoverPos({ left, bottom })
  }, [])

  React.useEffect(() => {
    if (!open || typeof document === 'undefined' || typeof window === 'undefined') return
    updatePopoverPosition()
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (pillRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onReposition = () => updatePopoverPosition()
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onReposition)
    window.addEventListener('scroll', onReposition, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
    }
  }, [open, updatePopoverPosition])

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
  const tone = failed || (worst !== undefined && worst <= 10)
    ? 'error'
    : worst !== undefined && worst <= 25
      ? 'warn'
      : undefined
  const label = failed
    ? `${familyName} ${t('quota.readFailed')}${data?.error?.message ? `：${data.error.message}` : ''}`
    : `${familyName} ${value}${buckets.length ? ` · ${buckets.map((b) => `${windowLabel(b, t)} ${b.disabled ? t('quota.disabled') : bucketPercentage(b) === undefined ? t('quota.unknown') : `${Math.round(bucketPercentage(b)!)}%`}`).join(' · ')}` : ''}`
  const miniBuckets = buckets.slice(0, 5)
  const miniHeight = miniBuckets.length <= 1 ? 6 : miniBuckets.length === 2 ? 5 : miniBuckets.length === 3 ? 4 : 3

  const popover = open
    ? renderInBodyPortal(
        <div
          ref={popoverRef}
          className="agy-popover"
          role="dialog"
          aria-label={t('quota.popoverTitle')}
          style={{ left: `${popoverPos.left}px`, bottom: `${popoverPos.bottom}px` }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
            <strong>{data?.plan ? `${t('accounts.planPrefix')}${data.plan}` : t('quota.popoverTitle')}</strong>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                type="button"
                className="agy-btn"
                disabled={refreshing}
                onClick={() => { void loadRef.current?.(true) }}
              >
                {refreshing ? t('accounts.refreshing') : t('quota.refresh')}
              </button>
              <button type="button" className="agy-btn" onClick={() => setOpen(false)}>
                {t('quota.close')}
              </button>
            </div>
          </div>
          <QuotaDetails data={data} showCredits={true} t={t} />
        </div>,
      )
    : null

  return (
    <>
      <button
        ref={pillRef}
        type="button"
        className="agy-pill antigravity-usage-pill"
        data-tone={tone}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{familyName}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
        {miniBuckets.length > 0 ? (
          <span aria-hidden={true} style={{ display: 'grid', gap: miniBuckets.length <= 2 ? '3px' : '2px' }}>
            {miniBuckets.map((bucket, idx) => (
              <RemainingBar key={idx} bucket={bucket} mini height={miniHeight} label={`${familyName} ${windowLabel(bucket, t)}${t('quota.remainingSuffix')}`} />
            ))}
          </span>
        ) : null}
      </button>
      {popover}
    </>
  )
}
