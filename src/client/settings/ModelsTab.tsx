/**
 * 设置页「模型」标签：按家族分组的模型显示/隐藏开关（读写 `hiddenModels`）。
 */
import React from 'react'
import { ModelList } from 'dsh-provider-ui'
import type { ModelListItem } from 'dsh-provider-ui'
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

  const familyOrder = [
    ...MODEL_GROUPS.map((group) => ({ key: group.key, name: group.name })),
    { key: 'other' as const, name: t('models.otherFamily') },
  ]

  const items: ModelListItem[] = []
  for (const family of familyOrder) {
    const groupRows = rows.filter((row) => {
      const k = modelGroupFor(row.id) ?? 'other'
      return k === family.key
    })
    for (const row of groupRows) {
      items.push({
        id: row.id,
        name: row.name,
        group: family.name,
        enabled: !hiddenSet.has(row.id),
        title: row.inCatalog ? row.id : `${row.id} · ${t('models.notInCatalog')}`,
        meta: row.inCatalog ? [row.id] : [row.id, t('models.notInCatalog')],
      })
    }
  }

  const hiddenCount = rows.filter((row) => hiddenSet.has(row.id)).length

  return (
    <ModelList
      items={items}
      disabled={disabled}
      hint={t('models.hint')}
      emptyText={t('models.empty')}
      onRefresh={onRefresh}
      refreshing={refreshing}
      refreshLabel={t('models.refresh')}
      refreshingLabel={t('models.refreshing')}
      onToggle={(id) => onToggle(id)}
      warning={rows.length > 0 && hiddenCount === rows.length ? t('models.allHiddenWarn') : undefined}
    />
  )
}
