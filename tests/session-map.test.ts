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
  it('describe 区分「磁盘没有」与「被他人持有」：两者的处置方式完全不同', async () => {
    const store = new SessionMapStore({ load: async () => ({ chat: entry(1) }), save: () => {} })
    const a = Symbol(), b = Symbol()
    // 还没 load 过：describe 走 no-entry（内存视图里确实没有）。
    expect(store.describe('chat')).toBe('no-entry')
    expect(await store.claim('chat', a)).toEqual(entry(1))
    expect(store.describe('chat')).toBe('held-by-other')
    // 同一 owner 再 claim 时 describe 仍是 held-by-other（这是「有人持有」，不是归属判断）。
    expect(await store.claim('chat', b)).toBeUndefined()
    expect(store.describe('chat')).toBe('held-by-other')
    // 释放后变 idle：映射还在，下一段旅程可以接管。
    store.release(a)
    expect(store.describe('chat')).toBe('idle')
    expect(await store.claim('chat', b)).toEqual(entry(1))
  })

  it('另一个 worker 持有时 claim 不删除映射：条目必须留给持有者与后续接管', async () => {
    // 2026-11-22 真机回归：turn 27 正常写入 sent=396，16 分钟后 turn 28 报
    // 「没有可用的会话映射」，磁盘却完好。原因是 claim 换 owner 时 delete 了内存
    // 条目，而 load() 只跑一次，之后永久拿不到——对话就此报废。
    let disk: Record<string, SessionMapEntry> = {}
    const store = new SessionMapStore({ load: async () => ({}), save: rows => { disk = rows } })
    const a = Symbol(), b = Symbol()
    await store.claim('chat', a); store.set('chat', a, entry(1)); await store.flush()
    // 别的 worker 认领：拒绝并原样返回 undefined，但**条目不许被删**。
    expect(await store.claim('chat', b)).toBeUndefined()
    expect(disk.chat).toEqual(entry(1))
    // 持有者仍可继续用；释放后下一位仍能接管到同一条目。
    expect(await store.claim('chat', a)).toEqual(entry(1))
    store.release(a)
    expect(await store.claim('chat', b)).toEqual(entry(1))
  })

  it('旧 worker 不得覆盖或删除仍在他人手中的键', async () => {
    let disk: Record<string, SessionMapEntry> = {}
    const store = new SessionMapStore({ load: async () => ({}), save: rows => { disk = rows } })
    const a = Symbol(), b = Symbol()
    await store.claim('chat', a); store.set('chat', a, entry(1))
    // b 拿不到所有权：claim 拒绝，随后 b 的 set/delete 全部被所有权检查丢弃。
    expect(await store.claim('chat', b)).toBeUndefined()
    store.set('chat', b, entry(3)); store.delete('chat', b)
    await store.claim('other', a); store.set('other', a, entry(2)); await store.flush()
    // chat 仍是 a 写的 entry(1)，没有被 b 篡改或删除。
    expect(disk.chat).toEqual(entry(1))
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
