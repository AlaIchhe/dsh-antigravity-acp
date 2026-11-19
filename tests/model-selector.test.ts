import { describe, expect, it } from 'vitest'
import { findModelSelector, findThoughtLevelSelector, flattenSelectOptions } from '../src/adapter/model-catalog.js'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'

/** 造一个 select 选项（形状与真机 `session/new` 返回一致）。 */
function select(input: {
  id: string
  name?: string
  category?: string
  currentValue?: string
  values?: string[]
}): SessionConfigOption {
  return {
    id: input.id,
    name: input.name ?? input.id,
    type: 'select',
    ...(input.category === undefined ? {} : { category: input.category }),
    ...(input.currentValue === undefined ? {} : { currentValue: input.currentValue }),
    options: (input.values ?? []).map((value) => ({ value, name: value })),
  } as unknown as SessionConfigOption
}

describe('模型/档位选择器只认 category，不猜名字', () => {
  it('真机形态：三个 select 各带 category', () => {
    const options = [
      select({ id: 'model', name: 'Model', category: 'model', currentValue: 'gemini-4-neon', values: ['gemini-4-neon', 'gemini-4-hydrogen'] }),
      select({ id: 'thought_level', name: 'Thinking Level', category: 'thought_level', currentValue: 'high', values: ['low', 'medium', 'high', 'xhigh'] }),
      select({ id: 'mode', name: 'Mode', category: 'mode', currentValue: 'default', values: ['default', 'plan'] }),
    ]
    expect(findModelSelector(options)?.configId).toBe('model')
    expect(findThoughtLevelSelector(options)?.configId).toBe('thought_level')
    // 档位以 agent 声明为准：xhigh 被如实带出来。
    expect(findThoughtLevelSelector(options)?.options.map((o) => o.value)).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('没有 category 时返回 undefined，不回退到名字猜测', () => {
    // 名字里带 model，但没有 category —— 旧启发式会误认成模型选择器。
    const noCategory = [select({ id: 'model', name: 'Model', values: ['a'] })]
    expect(findModelSelector(noCategory)).toBeUndefined()

    // 名字里带 thought，但没有 category。
    const thoughtNoCategory = [select({ id: 'thought', name: 'Thought Effort', values: ['low'] })]
    expect(findThoughtLevelSelector(thoughtNoCategory)).toBeUndefined()
  })

  it('名字误导时以 category 为准', () => {
    const options = [
      // id 里没有 model，但 category 声明它就是模型选择器。
      select({ id: 'primary', name: 'Primary', category: 'model', values: ['m1'] }),
      // id 里含 model，但 category 说是别的 —— 不能被当成模型选择器。
      select({ id: 'model_notes', name: 'Model Notes', category: 'mode', values: ['x'] }),
    ]
    expect(findModelSelector(options)?.configId).toBe('primary')
  })

  it('非 select 类型不参与', () => {
    const text = { id: 'model', name: 'Model', type: 'text', category: 'model' } as unknown as SessionConfigOption
    expect(findModelSelector([text])).toBeUndefined()
  })

  it('分组选项按声明顺序展平', () => {
    const grouped = {
      id: 'model', name: 'Model', type: 'select', category: 'model',
      options: [
        { group: 'fast', name: 'Fast', options: [{ value: 'a', name: 'A' }] },
        { group: 'deep', name: 'Deep', options: [{ value: 'b', name: 'B' }, { value: 'c', name: 'C' }] },
      ],
    } as unknown as SessionConfigOption
    expect(flattenSelectOptions((grouped as unknown as { options: never }).options)).toEqual([
      { value: 'a', name: 'A' }, { value: 'b', name: 'B' }, { value: 'c', name: 'C' },
    ])
  })
})
