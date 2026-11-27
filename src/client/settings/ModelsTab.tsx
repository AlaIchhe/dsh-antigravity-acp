/**
 * 设置页「模型」标签：按家族分组的模型显示/隐藏开关（读写 `hiddenModels`）。
 */
import React from 'react'
import { MODEL_GROUPS, modelGroupFor } from '../../shared/model-groups.js'
import type { ModelRowView } from '../../shared/rpc-contract.js'
import { createStaticTranslator } from '../i18n.js'
import type { TranslateFn } from '../i18n.js'

const DEFAULT_T = createStaticTranslator('zh')

export function ModelsTab({
  models,
  hiddenModels,
  disabled,
  refreshing,
  onToggle,
  onRefresh,
  t = DEFAULT_T,
}: {
  models: readonly ModelRowView[]
  hiddenModels: readonly string[]
  disabled: boolean
  refreshing: boolean
  onToggle: (id: string) => void
  onRefresh: () => void
  t?: TranslateFn
}) {
  const hiddenSet = new Set(hiddenModels)
  const known = new Set(models.map((m) => m.id))
  const rows: Array<ModelRowView & { inCatalog: boolean }> = [
    ...models.map((m) => ({ ...m, inCatalog: true })),
    ...hiddenModels.filter((id) => !known.has(id)).map((id) => ({ id, name: id, inCatalog: false })),
  ]

  const families = [
    ...MODEL_GROUPS.map((group) => ({ ...group, rows: rows.filter((row) => modelGroupFor(row.id) === group.key) })),
    { key: 'other' as const, name: t('models.otherFamily'), rows: rows.filter((row) => modelGroupFor(row.id) === undefined) },
  ].filter((group) => group.rows.length > 0)

  const hiddenCount = rows.filter((row) => hiddenSet.has(row.id)).length

  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
        <span className="agy-muted" style={{ fontSize: '12px' }}>{t('models.hint')}</span>
        <button type="button" className="agy-btn" disabled={refreshing} onClick={onRefresh}>
          {refreshing ? t('models.refreshing') : t('models.refresh')}
        </button>
      </div>

      {rows.length === 0 ? (
        <p role="status" className="agy-muted" style={{ margin: 0, fontSize: '12px' }}>
          {t('models.empty')}
        </p>
      ) : (
        <div style={{ display: 'grid', gap: '10px' }}>
          {families.map((family) => (
            <section key={family.key} aria-label={`${family.name}${t('models.familyAriaSuffix')}`}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginBottom: '6px' }}>
                <strong style={{ fontSize: '12px' }}>{family.name}</strong>
                <span className="agy-muted" style={{ fontSize: '11px' }}>{family.rows.length}</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {family.rows.map((row) => {
                  const isHidden = hiddenSet.has(row.id)
                  return (
                    <button
                      key={row.id}
                      type="button"
                      className="agy-btn agy-chip"
                      title={row.inCatalog ? row.id : `${row.id} · ${t('models.notInCatalog')}`}
                      disabled={disabled}
                      aria-pressed={!isHidden}
                      onClick={() => onToggle(row.id)}
                    >
                      {row.name}
                    </button>
                  )
                })}
              </div>
            </section>
          ))}
          {hiddenCount === rows.length ? (
            <p role="status" style={{ margin: 0, fontSize: '11px', color: 'var(--dsw-alias-state-warn-primary, #d99b28)' }}>
              {t('models.allHiddenWarn')}
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}
