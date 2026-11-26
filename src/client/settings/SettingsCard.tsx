/**
 * Antigravity ACP 设置卡片（账号 / 模型 双分页）。
 * 只编辑 `hiddenModels`（volatile 字段），经 `remote.settings.mutate` 原子提交。
 */
import React from 'react'
import { canonicalHiddenModels, sameHiddenModels } from '../../shared/model-groups.js'
import { SETTINGS_ENTRY_ID } from '../../shared/rpc-contract.js'
import type { ModelRowView } from '../../shared/rpc-contract.js'
import { unwrapEnvelope } from '../remote.js'
import type { AntigravityClientApi, ClientContextLike } from '../remote.js'
import { AccountsTab } from './AccountsTab.js'
import { ModelsTab } from './ModelsTab.js'

interface SettingsDocument {
  writable?: boolean
  namespaces?: Array<{ ns?: string; revision?: number; value?: Record<string, unknown> }>
}

export function AntigravitySettingsCard({
  remote,
  api,
}: {
  remote: ClientContextLike['remote']
  api: AntigravityClientApi
}) {
  const [tab, setTab] = React.useState<'account' | 'models'>('account')
  const [models, setModels] = React.useState<ModelRowView[]>([])
  const [refreshingModels, setRefreshingModels] = React.useState(false)
  const [revision, setRevision] = React.useState<number | null>(null)
  const [writable, setWritable] = React.useState(false)
  const [baseline, setBaseline] = React.useState<string[]>([])
  const [draft, setDraft] = React.useState<string[]>([])
  const [saving, setSaving] = React.useState(false)
  const [status, setStatus] = React.useState<{ kind: 'ok' | 'error' | 'busy'; text: string } | null>(null)
  const alive = React.useRef(true)
  const baselineRef = React.useRef<string[]>([])

  React.useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const loadSettings = React.useCallback(async () => {
    if (!remote?.settings?.describe) {
      setStatus({ kind: 'error', text: '宿主未提供 settings.describe，无法编辑模型显示设置' })
      return
    }
    try {
      const doc = unwrapEnvelope(await remote.settings.describe()) as SettingsDocument
      if (!alive.current) return
      const ns = (doc.namespaces ?? []).find((item) => item?.ns === SETTINGS_ENTRY_ID)
      setWritable(doc.writable === true && ns !== undefined)
      setRevision(typeof ns?.revision === 'number' ? ns.revision : null)
      const hidden = canonicalHiddenModels(ns?.value?.hiddenModels)
      const prevBaseline = baselineRef.current
      baselineRef.current = hidden
      setBaseline(hidden)
      setDraft((prev) => (sameHiddenModels(prev, prevBaseline) ? hidden : prev))
    } catch (error) {
      if (alive.current) setStatus({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }, [remote])

  const loadModels = React.useCallback(async (force = false) => {
    setRefreshingModels(true)
    try {
      const result = await api.listModels(force)
      if (!alive.current) return
      setModels(result.models)
      if (result.status === 'error' && result.message) {
        setStatus({ kind: 'error', text: result.message })
      }
    } catch (error) {
      if (alive.current) setStatus({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      if (alive.current) setRefreshingModels(false)
    }
  }, [api])

  React.useEffect(() => {
    void loadSettings()
    void loadModels(false)
    const off = remote?.$on?.('settings/document-updated', (ns) => {
      if (!ns || ns === SETTINGS_ENTRY_ID) void loadSettings()
    })
    return () => { if (typeof off === 'function') off() }
  }, [loadSettings, loadModels, remote])

  const dirty = !sameHiddenModels(draft, baseline)

  const toggleModel = (id: string) => {
    if (saving) return
    setDraft((prev) => {
      const set = new Set(prev)
      if (set.has(id)) set.delete(id)
      else set.add(id)
      return canonicalHiddenModels([...set])
    })
  }

  const save = async () => {
    if (!dirty || !writable || revision === null || !remote?.settings?.mutate || saving) return
    setSaving(true)
    setStatus({ kind: 'busy', text: '保存中…' })
    try {
      unwrapEnvelope(await remote.settings.mutate(
        SETTINGS_ENTRY_ID,
        [{ op: 'set', path: ['hiddenModels'], value: draft }],
        revision,
      ))
      if (!alive.current) return
      baselineRef.current = draft
      setBaseline(draft)
      setStatus({ kind: 'ok', text: '已保存；进行中的会话不受影响。' })
      await loadSettings()
    } catch (error) {
      if (alive.current) {
        setStatus({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
        await loadSettings()
      }
    } finally {
      if (alive.current) setSaving(false)
    }
  }

  return (
    <div className="agy-card antigravity-settings-card">
      <div className="agy-tabs" role="tablist" aria-label="Antigravity 设置分页">
        <button type="button" role="tab" className="agy-tab" aria-selected={tab === 'account'} onClick={() => setTab('account')}>
          账号
        </button>
        <button type="button" role="tab" className="agy-tab" aria-selected={tab === 'models'} onClick={() => setTab('models')}>
          模型
        </button>
      </div>

      <div style={{ display: tab === 'account' ? 'block' : 'none' }}>
        <AccountsTab api={api} />
      </div>

      <div style={{ display: tab === 'models' ? 'grid' : 'none', gap: '12px' }}>
        {status ? <p className="agy-notice" data-kind={status.kind} role={status.kind === 'error' ? 'alert' : 'status'}>{status.text}</p> : null}
        <ModelsTab
          models={models}
          hiddenModels={draft}
          disabled={!writable || saving}
          refreshing={refreshingModels}
          onToggle={toggleModel}
          onRefresh={() => { void loadModels(true) }}
        />
        {dirty ? (
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" className="agy-btn agy-btn-primary" disabled={saving} onClick={() => { void save() }}>
              {saving ? '保存中…' : '保存模型列表'}
            </button>
            <button type="button" className="agy-btn" disabled={saving} onClick={() => setDraft(baseline)}>
              放弃修改
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
