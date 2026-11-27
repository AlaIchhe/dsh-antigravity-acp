/**
 * Antigravity ACP 设置卡片（账号 / 模型 / 连接与高级 三分页）。
 *
 * - 兼容带前缀的设置命名空间（如 `include:llm-antigravity-acp` 与 `llm-antigravity-acp`）；
 * - 切账号后自动联动刷新模型目录；隐藏账号分页时停止后台额度请求；
 * - 经 `remote.settings.mutate` 原子提交 `hiddenModels` 与全部热更新高级配置。
 */
import React from 'react'
import { canonicalHiddenModels, sameHiddenModels } from '../../shared/model-groups.js'
import { SETTINGS_ENTRY_ID, matchSettingsNamespace } from '../../shared/rpc-contract.js'
import type { ModelRowView, SettingsNamespaceLike } from '../../shared/rpc-contract.js'
import { useClientTranslator } from '../i18n.js'
import type { ClientLocaleServiceLike } from '../i18n.js'
import { unwrapEnvelope } from '../remote.js'
import type { AntigravityClientApi, ClientContextLike } from '../remote.js'
import { AccountsTab } from './AccountsTab.js'
import {
  AdvancedTab,
  extractAdvancedSettings,
  parseBoundedInt,
  sameAdvancedSettings,
} from './AdvancedTab.js'
import type { AdvancedSettingsDraft } from './AdvancedTab.js'
import { ModelsTab } from './ModelsTab.js'

export { matchSettingsNamespace }
export type SettingsNamespace = SettingsNamespaceLike

interface SettingsDocument {
  writable?: boolean
  namespaces?: SettingsNamespace[]
}

function isMatchingNamespaceId(ns: string | undefined, activeNs: string | null): boolean {
  if (!ns) return true
  if (activeNs && ns === activeNs) return true
  return ns === SETTINGS_ENTRY_ID || ns.endsWith(`:${SETTINGS_ENTRY_ID}`)
}

const DEFAULT_ADVANCED = extractAdvancedSettings(undefined)

export function AntigravitySettingsCard({
  remote,
  api,
  locale,
}: {
  remote: ClientContextLike['remote']
  api: AntigravityClientApi
  locale?: ClientLocaleServiceLike
}) {
  const t = useClientTranslator(locale)
  const [tab, setTab] = React.useState<'account' | 'models' | 'advanced'>('account')
  const [models, setModels] = React.useState<ModelRowView[]>([])
  const [refreshingModels, setRefreshingModels] = React.useState(false)
  const [matchedNs, setMatchedNs] = React.useState<string | null>(null)
  const [revision, setRevision] = React.useState<number | null>(null)
  const [writable, setWritable] = React.useState(false)
  const [baseline, setBaseline] = React.useState<string[]>([])
  const [draft, setDraft] = React.useState<string[]>([])
  const [advBaseline, setAdvBaseline] = React.useState<AdvancedSettingsDraft>(DEFAULT_ADVANCED)
  const [advDraft, setAdvDraft] = React.useState<AdvancedSettingsDraft>(DEFAULT_ADVANCED)
  const [saving, setSaving] = React.useState(false)
  const [status, setStatus] = React.useState<{ kind: 'ok' | 'error' | 'busy'; text: string } | null>(null)
  const alive = React.useRef(true)
  const baselineRef = React.useRef<string[]>([])
  const advBaselineRef = React.useRef<AdvancedSettingsDraft>(DEFAULT_ADVANCED)
  const matchedNsRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const loadSettings = React.useCallback(async () => {
    if (!remote?.settings?.describe) {
      setStatus({ kind: 'error', text: t('settings.noDescribe') })
      return
    }
    try {
      const doc = unwrapEnvelope(await remote.settings.describe()) as SettingsDocument
      if (!alive.current) return
      const ns = matchSettingsNamespace(doc.namespaces)
      const nsId = typeof ns?.ns === 'string' ? ns.ns : null
      matchedNsRef.current = nsId
      setMatchedNs(nsId)
      setWritable(doc.writable === true && nsId !== null)
      setRevision(typeof ns?.revision === 'number' ? ns.revision : null)

      const hidden = canonicalHiddenModels(ns?.value?.hiddenModels)
      const prevBaseline = baselineRef.current
      baselineRef.current = hidden
      setBaseline(hidden)
      setDraft((prev) => (sameHiddenModels(prev, prevBaseline) ? hidden : prev))

      const nextAdv = extractAdvancedSettings(ns?.value)
      const prevAdvBaseline = advBaselineRef.current
      advBaselineRef.current = nextAdv
      setAdvBaseline(nextAdv)
      setAdvDraft((prev) => (sameAdvancedSettings(prev, prevAdvBaseline) ? nextAdv : prev))
    } catch (error) {
      if (alive.current) setStatus({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }, [remote, t])

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
    const offSettings = remote?.$on?.('settings/document-updated', (ns) => {
      if (isMatchingNamespaceId(ns, matchedNsRef.current)) void loadSettings()
    })
    const offAccount = api.subscribeAccountChanged(() => {
      void loadModels(false)
    })
    return () => {
      if (typeof offSettings === 'function') offSettings()
      offAccount()
    }
  }, [api, loadSettings, loadModels, remote])

  const modelsDirty = !sameHiddenModels(draft, baseline)
  const advDirty = !sameAdvancedSettings(advDraft, advBaseline)
  const idleParsed = parseBoundedInt(advDraft.idleRecycleMs, 0, 3_600_000)
  const graceParsed = parseBoundedInt(advDraft.cancelGraceMs, 0, 60_000)
  const advValid = idleParsed !== undefined && graceParsed !== undefined

  const toggleModel = (id: string) => {
    if (saving) return
    setDraft((prev) => {
      const set = new Set(prev)
      if (set.has(id)) set.delete(id)
      else set.add(id)
      return canonicalHiddenModels([...set])
    })
  }

  const commitOps = async (
    ops: Array<{ op: 'set'; path: string[]; value: unknown }>,
    onSuccess: () => void,
  ) => {
    if (!writable || !matchedNs || revision === null || !remote?.settings?.mutate || saving) return
    setSaving(true)
    setStatus({ kind: 'busy', text: t('settings.saving') })
    try {
      unwrapEnvelope(await remote.settings.mutate(matchedNs, ops, revision))
      if (!alive.current) return
      onSuccess()
      setStatus({ kind: 'ok', text: t('settings.saved') })
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

  const saveModels = () => {
    if (!modelsDirty) return
    void commitOps([{ op: 'set', path: ['hiddenModels'], value: draft }], () => {
      baselineRef.current = draft
      setBaseline(draft)
    })
  }

  const saveAdvanced = () => {
    if (!advDirty || !advValid || idleParsed === undefined || graceParsed === undefined) return
    const ops: Array<{ op: 'set'; path: string[]; value: unknown }> = []
    if (advDraft.proxyUrl.trim() !== advBaseline.proxyUrl.trim()) {
      ops.push({ op: 'set', path: ['proxyUrl'], value: advDraft.proxyUrl.trim() })
    }
    if (advDraft.agentMode.trim() !== advBaseline.agentMode.trim()) {
      ops.push({ op: 'set', path: ['agentMode'], value: advDraft.agentMode.trim() })
    }
    if (advDraft.agyCliPath.trim() !== advBaseline.agyCliPath.trim()) {
      ops.push({ op: 'set', path: ['agyCliPath'], value: advDraft.agyCliPath.trim() })
    }
    if (advDraft.cliQuotaEnabled !== advBaseline.cliQuotaEnabled) {
      ops.push({ op: 'set', path: ['cliQuotaEnabled'], value: advDraft.cliQuotaEnabled })
    }
    if (advDraft.resumeSessions !== advBaseline.resumeSessions) {
      ops.push({ op: 'set', path: ['resumeSessions'], value: advDraft.resumeSessions })
    }
    if (advDraft.idleRecycleMs.trim() !== advBaseline.idleRecycleMs.trim()) {
      ops.push({ op: 'set', path: ['idleRecycleMs'], value: idleParsed })
    }
    if (advDraft.cancelGraceMs.trim() !== advBaseline.cancelGraceMs.trim()) {
      ops.push({ op: 'set', path: ['cancelGraceMs'], value: graceParsed })
    }
    if (ops.length === 0) return
    const normalized: AdvancedSettingsDraft = {
      proxyUrl: advDraft.proxyUrl.trim(),
      agentMode: advDraft.agentMode.trim(),
      agyCliPath: advDraft.agyCliPath.trim(),
      cliQuotaEnabled: advDraft.cliQuotaEnabled,
      resumeSessions: advDraft.resumeSessions,
      idleRecycleMs: String(idleParsed),
      cancelGraceMs: String(graceParsed),
    }
    void commitOps(ops, () => {
      advBaselineRef.current = normalized
      setAdvBaseline(normalized)
      setAdvDraft(normalized)
      if (normalized.cliQuotaEnabled !== advBaseline.cliQuotaEnabled) {
        api.notifyAccountChanged()
      }
    })
  }

  return (
    <div className="agy-card antigravity-settings-card">
      <div className="agy-tabs" role="tablist" aria-label={t('settings.tablist')}>
        <button type="button" role="tab" className="agy-tab" aria-selected={tab === 'account'} onClick={() => setTab('account')}>
          {t('settings.tab.account')}
        </button>
        <button type="button" role="tab" className="agy-tab" aria-selected={tab === 'models'} onClick={() => setTab('models')}>
          {t('settings.tab.models')}
        </button>
        <button type="button" role="tab" className="agy-tab" aria-selected={tab === 'advanced'} onClick={() => setTab('advanced')}>
          {t('settings.tab.advanced')}
        </button>
      </div>

      <div style={{ display: tab === 'account' ? 'block' : 'none' }}>
        <AccountsTab api={api} active={tab === 'account'} t={t} />
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
          t={t}
        />
        {modelsDirty ? (
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" className="agy-btn agy-btn-primary" disabled={saving} onClick={saveModels}>
              {saving ? t('settings.saving') : t('settings.saveModels')}
            </button>
            <button type="button" className="agy-btn" disabled={saving} onClick={() => setDraft(baseline)}>
              {t('settings.discard')}
            </button>
          </div>
        ) : null}
      </div>

      <div style={{ display: tab === 'advanced' ? 'grid' : 'none', gap: '12px' }}>
        {status ? <p className="agy-notice" data-kind={status.kind} role={status.kind === 'error' ? 'alert' : 'status'}>{status.text}</p> : null}
        {!writable ? (
          <p className="agy-notice" data-kind="busy" role="status">{t('settings.readonly')}</p>
        ) : null}
        <AdvancedTab
          draft={advDraft}
          disabled={!writable || saving}
          onChange={setAdvDraft}
          t={t}
        />
        {advDirty ? (
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" className="agy-btn agy-btn-primary" disabled={saving || !advValid || !writable} onClick={saveAdvanced}>
              {saving ? t('settings.saving') : t('settings.saveAdvanced')}
            </button>
            <button type="button" className="agy-btn" disabled={saving} onClick={() => setAdvDraft(advBaseline)}>
              {t('settings.discard')}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
