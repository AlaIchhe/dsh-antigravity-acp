/**
 * 设置页「连接与高级」标签：可视化编辑全部热更新配置项
 * （proxyUrl、agentMode、agyCliPath、cliQuotaEnabled、resumeSessions、idleRecycleMs、cancelGraceMs）。
 */
import React from 'react'
import type { TranslateFn } from '../i18n.js'

export interface AdvancedSettingsDraft {
  proxyUrl: string
  agentMode: string
  agyCliPath: string
  cliQuotaEnabled: boolean
  resumeSessions: boolean
  idleRecycleMs: string
  cancelGraceMs: string
}

export function extractAdvancedSettings(value: Record<string, unknown> | undefined): AdvancedSettingsDraft {
  const idleRaw = typeof value?.idleRecycleMs === 'number' && Number.isFinite(value.idleRecycleMs)
    ? String(Math.trunc(value.idleRecycleMs))
    : '900000'
  const graceRaw = typeof value?.cancelGraceMs === 'number' && Number.isFinite(value.cancelGraceMs)
    ? String(Math.trunc(value.cancelGraceMs))
    : '30000'
  return {
    proxyUrl: typeof value?.proxyUrl === 'string' ? value.proxyUrl : '',
    agentMode: typeof value?.agentMode === 'string' ? value.agentMode : '',
    agyCliPath: typeof value?.agyCliPath === 'string' ? value.agyCliPath : '',
    cliQuotaEnabled: value?.cliQuotaEnabled === true,
    resumeSessions: value?.resumeSessions !== false,
    idleRecycleMs: idleRaw,
    cancelGraceMs: graceRaw,
  }
}

export function sameAdvancedSettings(a: AdvancedSettingsDraft, b: AdvancedSettingsDraft): boolean {
  return (
    a.proxyUrl.trim() === b.proxyUrl.trim()
    && a.agentMode.trim() === b.agentMode.trim()
    && a.agyCliPath.trim() === b.agyCliPath.trim()
    && a.cliQuotaEnabled === b.cliQuotaEnabled
    && a.resumeSessions === b.resumeSessions
    && a.idleRecycleMs.trim() === b.idleRecycleMs.trim()
    && a.cancelGraceMs.trim() === b.cancelGraceMs.trim()
  )
}

export function parseBoundedInt(raw: string, min: number, max: number): number | undefined {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const num = Number.parseInt(trimmed, 10)
  if (!Number.isSafeInteger(num) || num < min || num > max) return undefined
  return num
}

export function AdvancedTab({
  draft,
  disabled,
  onChange,
  t,
}: {
  draft: AdvancedSettingsDraft
  disabled: boolean
  onChange: (next: AdvancedSettingsDraft) => void
  t: TranslateFn
}) {
  const idleValid = parseBoundedInt(draft.idleRecycleMs, 0, 3_600_000) !== undefined
  const graceValid = parseBoundedInt(draft.cancelGraceMs, 0, 60_000) !== undefined

  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      <span className="agy-muted" style={{ fontSize: '12px' }}>
        {t('advanced.hint')}
      </span>

      <label className="agy-field">
        <span className="agy-field-label">{t('advanced.proxyUrl.label')}</span>
        <input
          type="text"
          className="agy-input"
          disabled={disabled}
          placeholder={t('advanced.proxyUrl.placeholder')}
          value={draft.proxyUrl}
          onChange={(e) => onChange({ ...draft, proxyUrl: e.target.value })}
        />
        <span className="agy-field-desc">{t('advanced.proxyUrl.desc')}</span>
      </label>

      <label className="agy-field">
        <span className="agy-field-label">{t('advanced.agentMode.label')}</span>
        <input
          type="text"
          className="agy-input"
          disabled={disabled}
          placeholder={t('advanced.agentMode.placeholder')}
          value={draft.agentMode}
          onChange={(e) => onChange({ ...draft, agentMode: e.target.value })}
        />
        <span className="agy-field-desc">{t('advanced.agentMode.desc')}</span>
      </label>

      <label className="agy-field">
        <span className="agy-field-label">{t('advanced.agyCliPath.label')}</span>
        <input
          type="text"
          className="agy-input"
          disabled={disabled}
          placeholder={t('advanced.agyCliPath.placeholder')}
          value={draft.agyCliPath}
          onChange={(e) => onChange({ ...draft, agyCliPath: e.target.value })}
        />
      </label>

      <div className="agy-switch-row">
        <div className="agy-field">
          <span className="agy-field-label">{t('advanced.cliQuotaEnabled.label')}</span>
          <span className="agy-field-desc">{t('advanced.cliQuotaEnabled.desc')}</span>
        </div>
        <button
          type="button"
          role="switch"
          className="agy-switch"
          aria-label={t('advanced.cliQuotaEnabled.label')}
          aria-checked={draft.cliQuotaEnabled}
          disabled={disabled}
          onClick={() => onChange({ ...draft, cliQuotaEnabled: !draft.cliQuotaEnabled })}
        >
          <span className="agy-switch-thumb" />
        </button>
      </div>

      <div className="agy-switch-row">
        <div className="agy-field">
          <span className="agy-field-label">{t('advanced.resumeSessions.label')}</span>
          <span className="agy-field-desc">{t('advanced.resumeSessions.desc')}</span>
        </div>
        <button
          type="button"
          role="switch"
          className="agy-switch"
          aria-label={t('advanced.resumeSessions.label')}
          aria-checked={draft.resumeSessions}
          disabled={disabled}
          onClick={() => onChange({ ...draft, resumeSessions: !draft.resumeSessions })}
        >
          <span className="agy-switch-thumb" />
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' }}>
        <label className="agy-field">
          <span className="agy-field-label">{t('advanced.idleRecycleMs.label')}</span>
          <input
            type="number"
            min={0}
            max={3_600_000}
            step={60_000}
            className="agy-input"
            disabled={disabled}
            aria-invalid={!idleValid}
            value={draft.idleRecycleMs}
            onChange={(e) => onChange({ ...draft, idleRecycleMs: e.target.value })}
          />
          <span className="agy-field-desc">
            {idleValid ? t('advanced.idleRecycleMs.desc') : t('advanced.invalidRange')}
          </span>
        </label>

        <label className="agy-field">
          <span className="agy-field-label">{t('advanced.cancelGraceMs.label')}</span>
          <input
            type="number"
            min={0}
            max={60_000}
            step={1_000}
            className="agy-input"
            disabled={disabled}
            aria-invalid={!graceValid}
            value={draft.cancelGraceMs}
            onChange={(e) => onChange({ ...draft, cancelGraceMs: e.target.value })}
          />
          <span className="agy-field-desc">
            {graceValid ? t('advanced.cancelGraceMs.desc') : t('advanced.invalidRange')}
          </span>
        </label>
      </div>
    </div>
  )
}
