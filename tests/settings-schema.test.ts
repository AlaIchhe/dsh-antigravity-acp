import { isVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { describe, expect, it } from 'vitest'
import { Config, LIVE_SETTING_KEYS, liveHostConfig } from '../src/settings.js'

describe('live settings schema and runtime references', () => {
  it('宿主提交即时引用后可读取下一次操作配置，同时保持已捕获快照不变', () => {
    const parsed = Config({ modelOverrides: { before: { enabled: false } }, proxyUrl: 'http://old:7890' })
    const config = liveHostConfig(parsed)
    const snapshot = { ...config }
    const next = Config({ modelOverrides: { after: { target: 'gemini-3-pro-high' } }, proxyUrl: '', reuseSessions: false, resumeSessions: true, keepProcessAfterCancel: true, cancelGraceMs: 0, idleRecycleMs: 0, agyCliPath: '/new/agy', proxyBypass: '*.internal' })
    for (const key of LIVE_SETTING_KEYS) {
      const beforeRef = parsed[key]
      const afterRef = next[key]
      expect(isVolatile(beforeRef)).toBe(true)
      expect(isVolatile(afterRef)).toBe(true)
      if (!isVolatile(beforeRef) || !isVolatile(afterRef)) throw new Error('Setting is not volatile: ' + key)
      // Same reference commit primitive used by the host's Loader reconciliation,
      // rather than Fiber.update(), which intentionally restarts a plugin.
      updateVolatile(beforeRef, afterRef)
      expect(parsed[key]).toBe(beforeRef)
    }
    expect(config).toMatchObject({ modelOverrides: { after: { enabled: true, target: 'gemini-3-pro-high' } }, proxyUrl: '', reuseSessions: false, resumeSessions: true, keepProcessAfterCancel: true, cancelGraceMs: 0, idleRecycleMs: 0, agyCliPath: '/new/agy', proxyBypass: '*.internal' })
    expect(snapshot.modelOverrides).toEqual({ before: { enabled: false } })
    expect(snapshot.proxyUrl).toBe('http://old:7890')
  })

  it('启动、并发等普通配置仍保持普通类型，默认开关和零值正确', () => {
    const config = liveHostConfig(Config({ cancelGraceMs: 0, idleRecycleMs: 0 }))
    expect(config.reuseSessions).toBe(true)
    expect(config.resumeSessions).toBe(true)
    expect(config.keepProcessAfterCancel).toBe(false)
    expect(config.cliQuotaEnabled).toBe(false)
    expect(config.cancelGraceMs).toBe(0)
    expect(config.idleRecycleMs).toBe(0)
    expect(config.maxConcurrentSessions).toBe(2)
    expect(config.handshakeTimeoutMs).toBe(120000)
    expect(config.extraArgs).toEqual([])
    expect(config.modelOverrides).toEqual({})
  })

  it('模型设置缺省启用；档位不再是配置字段，手写配置里的 effort 被保留但不参与路由', () => {
    expect(Config({ modelOverrides: { 'gemini-3-pro': {} } }).modelOverrides.get()).toEqual({ 'gemini-3-pro': { enabled: true } })
    // 兼容旧配置文件：多出来的键不报错，也不会被静默改写成某个档位。
    const legacy = { modelOverrides: { 'gemini-3-pro': { effort: 'max' } } } as unknown as Parameters<typeof Config>[0]
    expect(() => Config(legacy)).not.toThrow()
  })
})
