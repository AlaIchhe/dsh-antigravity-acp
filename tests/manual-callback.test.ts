import { describe, expect, it } from 'vitest'
import { parseManualCallback } from '../src/accounts/oauth.js'

const STATE = 'abc123'

describe('手动回填授权回调（无头主机）', () => {
  it('完整地址 + 匹配 state → 取出 code', () => {
    const outcome = parseManualCallback(
      `http://localhost:51121/oauth-callback?code=4/0Ab_xyz&state=${STATE}&scope=email`,
      STATE,
    )
    expect(outcome).toEqual({ ok: true, code: '4/0Ab_xyz' })
  })

  it('前后带空格也能解析（从终端复制常带换行）', () => {
    const outcome = parseManualCallback(`  http://localhost:51121/oauth-callback?code=C1&state=${STATE}\n`, STATE)
    expect(outcome).toMatchObject({ ok: true })
  })

  it('state 不匹配 → 拒绝（防止过期标签页或别的流程）', () => {
    const outcome = parseManualCallback('http://localhost:51121/oauth-callback?code=C1&state=other', STATE)
    expect(outcome.ok).toBe(false)
    expect((outcome as { reason: string }).reason).toContain('state 不匹配')
  })

  it('缺 code / 缺 state / 空 / 非法地址 → 各有可读原因', () => {
    const cases: Array<[string, RegExp]> = [
      ['', /为空/],
      ['不是地址', /完整地址/],
      [`http://localhost:51121/oauth-callback?state=${STATE}`, /没有 code/],
      ['http://localhost:51121/oauth-callback?code=C1', /没有 state/],
    ]
    for (const [input, pattern] of cases) {
      const outcome = parseManualCallback(input, STATE)
      expect(outcome.ok, `应拒绝：${input}`).toBe(false)
      expect((outcome as { reason: string }).reason).toMatch(pattern)
    }
  })

  it('Google 明确报错时优先返回错误', () => {
    const outcome = parseManualCallback(
      `http://localhost:51121/oauth-callback?error=access_denied&state=${STATE}`,
      STATE,
    )
    expect(outcome.ok).toBe(false)
    expect((outcome as { reason: string }).reason).toContain('access_denied')
  })

  it('用户取消授权（error）即使没有 code 也能给出原因', () => {
    const outcome = parseManualCallback(`http://localhost:51121/oauth-callback?error=access_denied`, STATE)
    expect((outcome as { reason: string }).reason).toContain('access_denied')
  })
})
