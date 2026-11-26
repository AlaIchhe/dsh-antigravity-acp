/**
 * 额度展示与输入框旁额度药丸（TSX 版，移除所有已废弃的 stale 死分支）。
 */
import React from 'react'
import { MODEL_GROUPS, modelGroupFor, quotaGroupKeyFor } from '../shared/model-groups.js'
import { PROVIDER_ID } from '../shared/rpc-contract.js'
import type { CreditsSnapshot, QuotaBucket, QuotaSnapshot } from '../shared/rpc-contract.js'
import type { AntigravityClientApi } from './remote.js'

const POLL_INTERVAL_MS = 180_000

export function bucketPercentage(bucket: QuotaBucket): number | undefined {
  if (typeof bucket.remainingPct === 'number' && Number.isFinite(bucket.remainingPct)) {
    return Math.max(0, Math.min(100, bucket.remainingPct))
  }
  if (typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction)) {
    return Math.max(0, Math.min(100, bucket.remainingFraction * 100))
  }
  return undefined
}

export function windowLabel(bucket: QuotaBucket): string {
  const win = bucket.window?.toLowerCase()
  if (win === '5h' || /five\s*hour|5\s*h/i.test(bucket.name)) return '5 小时'
  if (win === 'weekly' || win === '7d' || /week/i.test(bucket.name)) return '每周'
  return bucket.name || '额度'
}

function resetCountdown(resetTime: string | undefined): string {
  if (!resetTime) return ''
  const target = Date.parse(resetTime)
  if (!Number.isFinite(target)) return resetTime
  const diffMs = target - Date.now()
  if (diffMs <= 0) return '即将重置'
  const minutes = Math.ceil(diffMs / 60_000)
  if (minutes < 60) return `${minutes} 分钟后重置`
  const hours = Math.floor(minutes / 60)
  const remMin = minutes % 60
  if (hours < 24) return remMin > 0 ? `${hours} 小时 ${remMin} 分后重置` : `${hours} 小时后重置`
  const days = Math.floor(hours / 24)
  return `${days} 天 ${hours % 24} 小时后重置`
}

function barColor(pct: number | undefined, disabled: boolean): string {
  if (disabled || pct === undefined) return '#8b909a'
  if (pct <= 10) return '#e5534b'
  if (pct <= 25) return '#d99b28'
  return '#25b879'
}

export function groupedQuotas(data: QuotaSnapshot | null | undefined) {
  const byKey = new Map<string, QuotaBucket[]>()
  for (const group of data?.groups ?? []) {
    const key = quotaGroupKeyFor(group.name)
    if (!key) continue
    const list = byKey.get(key) ?? []
    list.push(...group.buckets)
    byKey.set(key, list)
  }
  return MODEL_GROUPS.map((meta) => ({
    key: meta.key,
    name: meta.name,
    buckets: byKey.get(meta.key) ?? [],
  })).filter((entry) => entry.buckets.length > 0)
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
        background: 'rgba(128,128,128,.22)',
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

export function CreditsDetails({ credits, pending }: { credits?: CreditsSnapshot; pending: boolean }) {
  if (credits?.error?.code === 'cli-disabled') return null
  const valid = credits?.status === 'ok' && typeof credits.remainingCredits === 'number' && Number.isSafeInteger(credits.remainingCredits) && credits.remainingCredits >= 0
  const label = valid
    ? credits.remainingCredits!.toLocaleString()
    : pending
      ? '正在读取…'
      : credits?.status === 'error'
        ? '查询失败'
        : '未提供'
  return (
    <section aria-label="AI Credits 余额" style={{ padding: '8px 0 0', borderTop: '1px solid rgba(128,128,128,.16)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px' }}>
        <strong style={{ fontSize: '12px' }}>AI Credits</strong>
        <strong style={{ fontSize: valid ? '16px' : '12px', fontVariantNumeric: 'tabular-nums' }}>{label}</strong>
      </div>
      {credits?.error?.message ? (
        <p role={credits.status === 'error' ? 'alert' : 'status'} style={{ margin: '4px 0 0', fontSize: '11px', overflowWrap: 'anywhere' }}>
          {credits.error.message}
        </p>
      ) : null}
    </section>
  )
}

export function QuotaDetails({
  data,
  model,
  showCredits = true,
}: {
  data: QuotaSnapshot | null
  model?: string
  showCredits?: boolean
}) {
  const groups = groupedQuotas(data)
  const activeGroup = modelGroupFor(model)
  return (
    <div style={{ display: 'grid', gap: '8px' }}>
      {data?.status === 'error' ? (
        <p role="alert" style={{ margin: 0, color: '#e5534b', fontSize: '11px', overflowWrap: 'anywhere' }}>
          {data.error?.message ?? '额度读取失败'}
        </p>
      ) : null}
      {groups.length > 0 ? (
        groups.map((group) => (
          <section key={group.key} aria-label={`${group.name}额度`} style={{ paddingBottom: '6px', borderBottom: '1px solid rgba(128,128,128,.14)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '5px' }}>
              <strong style={{ fontSize: '12px' }}>{group.name}</strong>
              {group.key === activeGroup ? <span className="agy-tag agy-tag-ok">当前模型</span> : null}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(115px, 1fr))', gap: '8px 12px' }}>
              {group.buckets.map((bucket, idx) => {
                const pct = bucketPercentage(bucket)
                return (
                  <div key={idx} style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '6px', marginBottom: '3px' }}>
                      <span style={{ fontSize: '11px' }}>{windowLabel(bucket)}</span>
                      <strong style={{ fontSize: bucket.disabled ? '11px' : '14px', fontVariantNumeric: 'tabular-nums' }}>
                        {bucket.disabled ? '已停用' : pct === undefined ? '未知' : `${Math.round(pct)}%`}
                      </strong>
                    </div>
                    <RemainingBar bucket={bucket} label={`${group.name} ${windowLabel(bucket)}剩余额度`} />
                    {bucket.disabled || bucket.resetTime ? (
                      <div style={{ fontSize: '10px', opacity: 0.78, marginTop: '3px' }}>
                        {bucket.disabled ? (bucket.description ?? '此窗口不可用') : resetCountdown(bucket.resetTime)}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </section>
        ))
      ) : data?.status !== 'error' ? (
        <span style={{ fontSize: '11px', opacity: 0.75 }}>{data ? '未提供额度数据' : '正在读取额度…'}</span>
      ) : null}
      {showCredits ? <CreditsDetails credits={data?.credits} pending={!data} /> : null}
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
}: {
  store: ModelDirectoryStoreLike
  api: AntigravityClientApi
}) {
  const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const isAcp = snapshot?.current?.provider === PROVIDER_ID
  const model = snapshot?.current?.model
  const [data, setData] = React.useState<QuotaSnapshot | null>(null)

  React.useEffect(() => {
    if (!isAcp) return
    let alive = true
    const load = async (force: boolean) => {
      try {
        const value = await api.readCurrentQuota({ force, ...(model ? { model } : {}) })
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
      }
    }
    void load(false)
    const offQuota = api.subscribeCurrentQuota((next) => { if (alive) setData(next) })
    const offAccount = api.subscribeAccountChanged(() => { void load(true) })
    const timer = setInterval(() => { void load(false) }, POLL_INTERVAL_MS)
    return () => {
      alive = false
      offQuota()
      offAccount()
      clearInterval(timer)
    }
  }, [api, isAcp, model])

  if (!isAcp) return null

  const groups = groupedQuotas(data)
  const family = modelGroupFor(model ?? data?.requestedModel)
  const group = family ? groups.find((entry) => entry.key === family) : undefined
  const buckets = group?.buckets ?? []
  const usable = buckets.filter((b) => !b.disabled && bucketPercentage(b) !== undefined)
  const worst = usable.length > 0 ? Math.min(...usable.map((b) => bucketPercentage(b)!)) : undefined
  const failed = data?.status === 'error'
  const familyName = MODEL_GROUPS.find((entry) => entry.key === family)?.name ?? '额度'
  const value = failed
    ? '读取失败'
    : !data
      ? '读取中'
      : !group
        ? '未知'
        : worst === undefined
          ? (buckets.some((b) => b.disabled) ? '已停用' : '未知')
          : `${Math.round(worst)}%`
  const accent = failed || (worst !== undefined && worst <= 10)
    ? '#e5534b'
    : worst !== undefined && worst <= 25
      ? '#d99b28'
      : undefined
  const label = failed
    ? `${familyName} 额度读取失败${data?.error?.message ? `：${data.error.message}` : ''}`
    : `${familyName} ${value}${buckets.length ? ` · ${buckets.map((b) => `${windowLabel(b)} ${b.disabled ? '已停用' : bucketPercentage(b) === undefined ? '未知' : `${Math.round(bucketPercentage(b)!)}%`}`).join(' · ')}` : ''}`
  const miniBuckets = buckets.slice(0, 5)
  const miniHeight = miniBuckets.length <= 1 ? 6 : miniBuckets.length === 2 ? 5 : miniBuckets.length === 3 ? 4 : 3

  return (
    <span
      className="agy-pill antigravity-usage-pill"
      role="status"
      aria-label={label}
      title={label}
      style={accent ? { borderColor: `${accent}73`, background: `${accent}1a` } : undefined}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{familyName}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      {miniBuckets.length > 0 ? (
        <span aria-hidden={true} style={{ display: 'grid', gap: miniBuckets.length <= 2 ? '3px' : '2px' }}>
          {miniBuckets.map((bucket, idx) => (
            <RemainingBar key={idx} bucket={bucket} mini height={miniHeight} label={`${familyName} ${windowLabel(bucket)}剩余额度`} />
          ))}
        </span>
      ) : null}
    </span>
  )
}
