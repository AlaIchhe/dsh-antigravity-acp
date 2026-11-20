import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createFileSessionMapStore, readSessionMap, SessionMapStore, writeSessionMap } from '../src/runtime/session-map.js'
import type { SessionMapEntry } from '../src/runtime/session-map.js'

const dirs: string[] = []
async function directory() { const path = await mkdtemp(join(tmpdir(), 'agy-session-map-')); dirs.push(path); return path }
afterEach(async () => {
  for (const path of dirs.splice(0)) {
    const absolute = resolve(path)
    if (!absolute.startsWith(resolve(tmpdir())) || !absolute.includes('agy-session-map-')) throw new Error('Unexpected test cleanup path')
    await rm(absolute, { recursive: true, force: true })
  }
})
function entry(index = 1): SessionMapEntry {
  return { sessionId: `acp-${index}`, cwd: '/workspace', sentCount: index, sentHash: 'a'.repeat(64), outputHash: 'b'.repeat(64), route: 'c'.repeat(64), updatedAt: index }
}

describe('会话映射文件', () => {
  it('往返、只存指纹、缺文件与坏 JSON 安全降级', async () => {
    const dir = await directory()
    expect(await readSessionMap(dir)).toEqual({})
    expect(await writeSessionMap(dir, { chat: entry() })).toBe(true)
    expect(await readSessionMap(dir)).toEqual({ chat: entry() })
    expect(await readdir(dir)).toEqual(['sessions.json'])
    const text = await readFile(join(dir, 'sessions.json'), 'utf8')
    expect(JSON.parse(text).format).toBe(2)
    expect(text).not.toContain('system')
    await writeFile(join(dir, 'sessions.json'), '{')
    expect(await readSessionMap(dir)).toEqual({})
  })
  it('拒绝旧格式、非法计数/指纹，只保留有效条目', async () => {
    const dir = await directory()
    const file = join(dir, 'sessions.json')
    await writeFile(file, JSON.stringify({ format: 1, entries: { old: entry() } }))
    expect(await readSessionMap(dir)).toEqual({})
    await writeFile(file, JSON.stringify({ format: 2, entries: {
      good: entry(), negative: { ...entry(), sentCount: -1 }, fractional: { ...entry(), sentCount: 0.5 },
      invalid: { ...entry(), outputHash: 'bogus' }, missing: { ...entry(), route: null },
    } }))
    expect(await readSessionMap(dir)).toEqual({ good: entry() })
  })
  })

describe('文件存储不再有跨进程锁', () => {
  it('同一目录下的两个 store 都能正常读写，且不产生 sessions.lock', async () => {
    const dir = await directory()
    const first = createFileSessionMapStore(dir), second = createFileSessionMapStore(dir)
    const a = Symbol(), b = Symbol()
    try {
      await first.claim('chat', a); first.set('chat', a, entry(1)); await first.flush()
      // 第二个 store 读得到第一个写的条目（锁已删除，不再互相屏蔽）。
      expect(await second.claim('chat', b)).toEqual(entry(1))
      // set 必须先 claim 该键，否则被所有权检查丢弃（这是既有契约）。
      await second.claim('other', b)
      second.set('other', b, entry(2)); await second.flush()
      // 两个 key 都在：写入是合并而非互斥屏蔽。
      expect(await readSessionMap(dir)).toEqual({ chat: entry(1), other: entry(2) })
      // 全程没有锁文件。
      expect(await readdir(dir)).not.toContain('sessions.lock')
    } finally { await first.close(); await second.close() }
    expect((await readdir(dir)).sort()).toEqual(['sessions.json'])
  })

  it('重启后能读回已写入的映射（残留锁导致写不进的回归）', async () => {
    const dir = await directory()
    const before = createFileSessionMapStore(dir)
    const owner = Symbol()
    try {
      await before.claim('chat', owner)
      before.set('chat', owner, entry(1))
      await before.flush()
    } finally { await before.close() }

    // 关键：即便目录里躺着一个「上个进程崩溃留下的」锁文件，也照样能读能写。
    await writeFile(join(dir, 'sessions.lock'), JSON.stringify({ pid: 99999, token: 'stale' }), 'utf8')
    const after = createFileSessionMapStore(dir)
    const next = Symbol()
    try {
      expect(await after.claim('chat', next)).toEqual(entry(1))
      after.set('chat', next, entry(2))
      await after.flush()
      expect(await readSessionMap(dir)).toEqual({ chat: entry(2) })
    } finally { await after.close() }
  })
})

describe('共享 SessionMapStore 所有权与串行提交', () => {
  it('并发 claim/set 不丢条目，save 严格串行且快照隔离', async () => {
    let disk: Record<string, SessionMapEntry> = {}, active = 0, maximum = 0
    const store = new SessionMapStore({ load: async () => ({}), save: async rows => {
      maximum = Math.max(maximum, ++active)
      await new Promise<void>(done => setTimeout(done, 2))
      disk = rows; active--
    } })
    const a = Symbol(), b = Symbol()
    await Promise.all([store.claim('a', a), store.claim('b', b)])
    store.set('a', a, entry(1)); store.set('b', b, entry(2)); await store.flush()
    expect(maximum).toBe(1)
    expect(disk).toEqual({ a: entry(1), b: entry(2) })
  })
  it('旧 worker 不得覆盖或删除已被接管的键，接管不恢复仍在旧进程里的会话', async () => {
    let disk: Record<string, SessionMapEntry> = {}
    const store = new SessionMapStore({ load: async () => ({}), save: rows => { disk = rows } })
    const a = Symbol(), b = Symbol()
    await store.claim('chat', a); store.set('chat', a, entry(1))
    expect(await store.claim('chat', b)).toBeUndefined()
    store.set('chat', b, entry(3)); store.set('chat', a, entry(1)); store.delete('chat', a)
    await store.claim('other', a); store.set('other', a, entry(2)); await store.flush()
    expect(disk.chat?.sentCount).toBe(3)
    expect(disk.other?.sentCount).toBe(2)
  })
  it('卸载 release 保留磁盘记录，新的 owner 可恢复；坏写入不毒化队列', async () => {
    let disk = { chat: entry(1) } as Record<string, SessionMapEntry>
    const onError = vi.fn(), save = vi.fn().mockRejectedValueOnce(new Error('full')).mockImplementation(async rows => { disk = rows })
    const store = new SessionMapStore({ load: async () => disk, save, onError })
    const a = Symbol(), b = Symbol()
    expect(await store.claim('chat', a)).toEqual(entry(1))
    store.set('chat', a, entry(2)); await store.flush()
    expect(onError).toHaveBeenCalledTimes(1)
    store.set('chat', a, entry(3)); await store.flush(); store.release(a)
    expect(await store.claim('chat', b)).toEqual(entry(3))
    expect(disk.chat).toEqual(entry(3))
  })

  it('unclaim 只归还所有权并保留条目，失败路径不会把键永久挂在本 worker 名下', async () => {
    const disk = { chat: entry(1) } as Record<string, SessionMapEntry>
    const store = new SessionMapStore({ load: async () => disk, save: rows => { Object.assign(disk, rows) } })
    const a = Symbol(), b = Symbol()
    expect(await store.claim('chat', a)).toEqual(entry(1))
    expect(store.owns('chat', a)).toBe(true)
    store.unclaim('chat', a)
    expect(store.owns('chat', a)).toBe(false)
    // 另一个 worker 立刻可以接管同一条目（条目内容没被否定）。
    expect(await store.claim('chat', b)).toEqual(entry(1))
    expect(store.owns('chat', b)).toBe(true)
    // 非 owner 的 unclaim 是空操作，不会抢走当前所有权。
    store.unclaim('chat', a)
    expect(store.owns('chat', b)).toBe(true)
  })
})
