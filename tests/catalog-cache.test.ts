import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCachedCatalog, writeCachedCatalog } from '../src/runtime/catalog-cache.js'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agy-catalog-'))
}

const MODELS = [
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', description: 'fast' },
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro' },
]

describe('catalog cache', () => {
  it('首次缓存目录尚不存在时自动创建父目录并完整落盘', async () => {
    const root = await tempDir()
    const dir = join(root, 'new', 'catalog')
    try {
      await writeCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0', models: MODELS })
      await expect(readCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0' })).resolves.toEqual({ models: MODELS })
      await expect(readdir(dir)).resolves.toEqual(['catalog.json'])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('多worker并写时读者始终看到完整快照，写完不留下临时文件', async () => {
    const dir = await tempDir()
    const snapshots = Array.from({ length: 16 }, (_, index) => [{
      id: `model-${index}`, name: `Model ${index}`, description: `${index}:`.repeat(1000 + index * 1500),
    }])
    try {
      await writeCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0', models: MODELS })
      const valid = new Set([JSON.stringify({ models: MODELS }), ...snapshots.map((models) => JSON.stringify({ models }))])
      await Promise.all([
        ...snapshots.map((models) => writeCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0', models })),
        (async () => {
          for (let index = 0; index < 40; index++) {
            const observed = await readCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0' })
            expect(valid.has(JSON.stringify(observed))).toBe(true)
          }
        })(),
      ])
      // Windows can reject replacement while readFile holds the target open. Such
      // failures preserve the old valid cache; without readers, parallel writers
      // must still produce one complete new snapshot.
      await Promise.all(snapshots.map((models) => writeCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0', models })))
      const final = await readCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0' })
      expect(snapshots.map((models) => JSON.stringify({ models }))).toContain(JSON.stringify(final))
      await expect(readdir(dir)).resolves.toEqual(['catalog.json'])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('rename失败不影响请求，只清理本次拥有的临时文件', async () => {
    const dir = await tempDir()
    try {
      await mkdir(join(dir, 'catalog.json'))
      const other = '.catalog.json.other-writer.tmp'
      await writeFile(join(dir, other), 'other writer', 'utf8')
      await expect(writeCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0', models: MODELS })).resolves.toBeUndefined()
      expect((await readdir(dir)).sort()).toEqual([other, 'catalog.json'].sort())
      await expect(readFile(join(dir, other), 'utf8')).resolves.toBe('other writer')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('写入后可读回同形状目录', async () => {
    const dir = await tempDir()
    try {
      await writeCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0', models: MODELS })
      await expect(readCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0' })).resolves.toEqual({ models: MODELS })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('ACP 版本变化即失效（官方换版后不展示旧档位）', async () => {
    const dir = await tempDir()
    try {
      await writeCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0', models: MODELS })
      await expect(readCachedCatalog({ cacheDir: dir, acpVersion: '1.5.0' })).resolves.toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('空目录不写盘（避免把空缓存当成有效目录）', async () => {
    const dir = await tempDir()
    try {
      await writeCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0', models: [] })
      await expect(readCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0' })).resolves.toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('缺失 / 损坏 / 格式不符的文件一律静默降级为无缓存', async () => {
    const dir = await tempDir()
    try {
      await expect(readCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0' })).resolves.toBeUndefined()
      await writeFile(join(dir, 'catalog.json'), 'not json at all', 'utf8')
      await expect(readCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0' })).resolves.toBeUndefined()
      await writeFile(join(dir, 'catalog.json'), JSON.stringify({ format: 999, acpVersion: '1.4.0', models: MODELS }), 'utf8')
      await expect(readCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0' })).resolves.toBeUndefined()
      // 旧格式（无 thoughtLevel 的 v1 文件）同样作废，避免把档位当模型。
      await writeFile(join(dir, 'catalog.json'), JSON.stringify({ format: 1, acpVersion: '1.4.0', models: MODELS }), 'utf8')
      await expect(readCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0' })).resolves.toBeUndefined()
      await writeFile(join(dir, 'catalog.json'), JSON.stringify({ format: 2, acpVersion: '1.4.0', models: [{ id: 1 }] }), 'utf8')
      await expect(readCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0' })).resolves.toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('思考强度选择器随目录一起落盘并可读回（含 xhigh 这种非三档值）', async () => {
    const dir = await tempDir()
    const thoughtLevel = {
      configId: 'thought_level',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'xhigh', name: 'Extra' },
      ],
      currentValue: 'xhigh',
    }
    try {
      await writeCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0', models: MODELS, thoughtLevel })
      await expect(readCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0' })).resolves.toEqual({ models: MODELS, thoughtLevel })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('档位选择器读坏时只丢这一项，模型目录仍然可用', async () => {
    const dir = await tempDir()
    try {
      await writeFile(join(dir, 'catalog.json'), JSON.stringify({
        format: 2, acpVersion: '1.4.0', models: MODELS,
        thoughtLevel: { configId: '', options: [{ value: '', name: '' }] },
      }), 'utf8')
      await expect(readCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0' })).resolves.toEqual({ models: MODELS })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('落盘内容只有模型元数据，不含凭据字段', async () => {
    const dir = await tempDir()
    try {
      await writeCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0', models: MODELS })
      const raw = await readFile(join(dir, 'catalog.json'), 'utf8')
      expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['acpVersion', 'format', 'models'])
      expect(raw).not.toMatch(/token|secret|code_challenge|oauth/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
