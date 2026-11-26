/**
 * 设置页「模型」标签：按家族分组的模型显示/隐藏开关（读写 `hiddenModels`）。
 */
import React from 'react'
import { MODEL_GROUPS, modelGroupFor } from '../../shared/model-groups.js'
import type { ModelRowView } from '../../shared/rpc-contract.js'

export function ModelsTab({
  models,
  hiddenModels,
  disabled,
  refreshing,
  onToggle,
  onRefresh,
}: {
  models: readonly ModelRowView[]
  hiddenModels: readonly string[]
  disabled: boolean
  refreshing: boolean
  onToggle: (id: string) => void
  onRefresh: () => void
}) {
  const hiddenSet = new Set(hiddenModels)
  const known = new Set(models.map((m) => m.id))
  const rows: Array<ModelRowView & { inCatalog: boolean }> = [
    ...models.map((m) => ({ ...m, inCatalog: true })),
    ...hiddenModels.filter((id) => !known.has(id)).map((id) => ({ id, name: id, inCatalog: false })),
  ]

  const families = [
    ...MODEL_GROUPS.map((group) => ({ ...group, rows: rows.filter((row) => modelGroupFor(row.id) === group.key) })),
    { key: 'other' as const, name: '其它', rows: rows.filter((row) => modelGroupFor(row.id) === undefined) },
  ].filter((group) => group.rows.length > 0)

  const hiddenCount = rows.filter((row) => hiddenSet.has(row.id)).length

  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontSize: '12px', opacity: 0.85 }}>点击模型切换是否在 DSH 模型选择器中显示</span>
        <button type="button" className="agy-btn" disabled={refreshing} onClick={onRefresh}>
          {refreshing ? '刷新目录中…' : '刷新模型目录'}
        </button>
      </div>

      {rows.length === 0 ? (
        <p role="status" style={{ margin: 0, fontSize: '12px', opacity: 0.8 }}>
          模型目录为空；请点击「刷新模型目录」或先发起一次对话。
        </p>
      ) : (
        <div style={{ display: 'grid', gap: '10px' }}>
          {families.map((family) => (
            <section key={family.key} aria-label={`${family.name} 模型`}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginBottom: '6px' }}>
                <strong style={{ fontSize: '12px' }}>{family.name}</strong>
                <span style={{ fontSize: '11px', opacity: 0.7 }}>{family.rows.length}</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {family.rows.map((row) => {
                  const isHidden = hiddenSet.has(row.id)
                  return (
                    <button
                      key={row.id}
                      type="button"
                      className="agy-btn agy-chip"
                      title={row.inCatalog ? row.id : `${row.id} · 不在当前目录`}
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
            <p role="status" style={{ margin: 0, fontSize: '11px', color: '#d99b28' }}>
              全部隐藏后，Antigravity 将从模型选择器中消失。
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}
