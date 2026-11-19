import { describe, expect, it } from 'vitest'
import { foldAgyModelFamilies, modelFamilyId, registerTierSuffix, tierForModelId } from '../src/runtime/agy-cli.js'

describe('档位后缀识别不写死清单', () => {
  it('已知档位仍被识别', () => {
    expect(tierForModelId('claude-opus-5-5-high')).toBe('high')
    expect(tierForModelId('gemini-4-hydrogen-xhigh')).toBe('xhigh')
    expect(modelFamilyId('gemini-4-hydrogen-xhigh')).toBe('gemini-4-hydrogen')
  })

  it('没有后缀的 id 原样返回', () => {
    expect(tierForModelId('gemini-4-neon')).toBeUndefined()
    expect(modelFamilyId('gemini-4-neon')).toBe('gemini-4-neon')
  })

  it('名称里含档位词但不是后缀，不误判', () => {
    expect(tierForModelId('gemini-low-flash')).toBeUndefined()
    expect(tierForModelId('low')).toBeUndefined()
  })

  it('agent 声明新档位后立即生效（不需要改代码）', () => {
    // 模拟官方将来新增一个档位名。
    expect(tierForModelId('claude-opus-6-ultra')).toBeUndefined()
    registerTierSuffix(['ultra'])
    expect(tierForModelId('claude-opus-6-ultra')).toBe('ultra')
    expect(modelFamilyId('claude-opus-6-ultra')).toBe('claude-opus-6')
  })

  it('新档位能被折叠进家族，而不是显示成独立模型', () => {
    registerTierSuffix(['ultra'])
    const folded = foldAgyModelFamilies([
      { id: 'claude-opus-6-ultra', name: 'Claude Opus 6 (Ultra)' },
      { id: 'claude-opus-6-high', name: 'Claude Opus 6 (High)' },
    ])
    expect(folded.models.map((m) => m.id)).toEqual(['claude-opus-6'])
    expect([...(folded.tiers.get('claude-opus-6') ?? [])].sort()).toEqual(['high', 'ultra'])
  })
})
