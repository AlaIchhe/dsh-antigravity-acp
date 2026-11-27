import { describe, expect, it } from 'vitest'
import { isVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { Config, LIVE_SETTING_KEYS, liveHostConfig } from '../src/settings.js'
import {
  canonicalHiddenModels,
  groupedQuotas,
  matchQuotaGroupForModel,
  modelGroupFor,
  quotaGroupKeyFor,
  sameHiddenModels,
} from '../src/shared/model-groups.js'
import {
  ANTIGRAVITY_REMOTE_INVOCATIONS,
  PACKAGE_NAME,
  REMOTE_SERVICE_NAME,
  matchSettingsNamespace,
  parseAccountIdRequest,
  parseReadQuotaRequest,
  parseStartLoginRequest,
  parseSubmitCallbackRequest,
} from '../src/shared/rpc-contract.js'

describe('v1.0 settings schema & shared contracts', () => {
  it('Config exposes slimmed volatile fields and reflects live updates', () => {
    const parsed = Config({ hiddenModels: ['model-a'], cliQuotaEnabled: false })
    const live = liveHostConfig(parsed)
    expect(live.hiddenModels).toEqual(['model-a'])
    expect(live.cliQuotaEnabled).toBe(false)
    expect(live.resumeSessions).toBe(true)

    const next = Config({ hiddenModels: ['model-b'], cliQuotaEnabled: true })
    for (const key of ['hiddenModels', 'cliQuotaEnabled'] as const) {
      if (isVolatile(parsed[key]) && isVolatile(next[key])) {
        updateVolatile(parsed[key], next[key])
      }
    }
    expect(live.hiddenModels).toEqual(['model-b'])
    expect(live.cliQuotaEnabled).toBe(true)
    expect(LIVE_SETTING_KEYS).not.toContain('proxyBypass')
    expect(LIVE_SETTING_KEYS).not.toContain('modelOverrides')
  })

  it('canonicalHiddenModels trims, deduplicates and sorts stably', () => {
    expect(canonicalHiddenModels([' b ', 'a', '', 'a', 123])).toEqual(['a', 'b'])
    expect(sameHiddenModels(['b', 'a'], ['a', 'b', 'a'])).toBe(true)
    expect(sameHiddenModels(['a'], ['b'])).toBe(false)
  })

  it('modelGroupFor & quotaGroupKeyFor prioritize argon over gemini', () => {
    expect(modelGroupFor('gemini-4-argon')).toBe('argon')
    expect(modelGroupFor('gemini-4-neon')).toBe('gemini')
    expect(modelGroupFor('claude-opus-5-5')).toBe('claude')
    expect(modelGroupFor('unknown-model')).toBeUndefined()
    expect(quotaGroupKeyFor('Gemini 4 Argon')).toBe('argon')
    expect(quotaGroupKeyFor('Gemini Models')).toBe('gemini')
    expect(quotaGroupKeyFor('Claude and GPT models')).toBe('claude')
  })

  it('RPC contract defines unified remote.antigravity methods with strict codecs and exact arity', () => {
    expect(ANTIGRAVITY_REMOTE_INVOCATIONS.map((d) => d.id)).toEqual([
      `${PACKAGE_NAME}#${REMOTE_SERVICE_NAME}/readQuota`,
      `${PACKAGE_NAME}#${REMOTE_SERVICE_NAME}/listModels`,
      `${PACKAGE_NAME}#${REMOTE_SERVICE_NAME}/listAccounts`,
      `${PACKAGE_NAME}#${REMOTE_SERVICE_NAME}/startAccountLogin`,
      `${PACKAGE_NAME}#${REMOTE_SERVICE_NAME}/submitAccountCallback`,
      `${PACKAGE_NAME}#${REMOTE_SERVICE_NAME}/cancelAccountLogin`,
      `${PACKAGE_NAME}#${REMOTE_SERVICE_NAME}/activateAccount`,
      `${PACKAGE_NAME}#${REMOTE_SERVICE_NAME}/removeAccount`,
      `${PACKAGE_NAME}#${REMOTE_SERVICE_NAME}/installCli`,
    ])
    const arities = Object.fromEntries(
      ANTIGRAVITY_REMOTE_INVOCATIONS.map((d) => [d.method, d.parameters.length]),
    )
    expect(arities).toEqual({
      readQuota: 1,
      listModels: 1,
      listAccounts: 0,
      startAccountLogin: 1,
      submitAccountCallback: 1,
      cancelAccountLogin: 0,
      activateAccount: 1,
      removeAccount: 1,
      installCli: 0,
    })
    expect(parseReadQuotaRequest({ force: true, model: ' gemini-4-neon ' })).toEqual({ force: true, model: 'gemini-4-neon' })
    expect(() => parseReadQuotaRequest({ force: 'yes' })).toThrow(TypeError)
    expect(() => parseStartLoginRequest({ mode: 'relogin' })).toThrow(TypeError)
    expect(parseStartLoginRequest({ mode: 'add', alias: 'Work' })).toEqual({ mode: 'add', alias: 'Work' })
    expect(parseAccountIdRequest({ id: ' acc_1 ' })).toEqual({ id: 'acc_1' })
    expect(() => parseSubmitCallbackRequest({})).toThrow(TypeError)
  })

  it('groupedQuotas preserves unknown quota groups and matchSettingsNamespace supports prefixed ns', () => {
    const groups = groupedQuotas({
      status: 'ok',
      updatedAt: new Date().toISOString(),
      groups: [
        { name: 'Gemini Models', buckets: [{ name: '5h', window: '5h', remainingPct: 80, disabled: false }] },
        { name: 'Vela Experimental', buckets: [{ name: '5h', window: '5h', remainingPct: 45, disabled: false }] },
      ],
    })
    expect(groups.map((g) => g.name)).toEqual(['Gemini', 'Vela Experimental'])
    expect(matchQuotaGroupForModel(groups, 'vela-2-pro')?.name).toBe('Vela Experimental')

    expect(matchSettingsNamespace([{ ns: 'include:llm-antigravity-acp', revision: 2 }])?.ns).toBe('include:llm-antigravity-acp')
    expect(matchSettingsNamespace([{ ns: 'llm-antigravity-acp', revision: 1 }])?.ns).toBe('llm-antigravity-acp')
    expect(matchSettingsNamespace([{ ns: 'custom:row', plugin: PACKAGE_NAME, revision: 3 }])?.ns).toBe('custom:row')
  })
})
