/**
 * 持久化 ACP 会话映射表（format v3）。
 *
 * v1.0 核心简化与修复：
 * - 修复了旧版 `readSessionMap` 漏读 `routeVersion` 导致重启后所有会话全部软失效的 Bug；
 * - 方案 A 下进程内只有一个共享 `SessionCoordinator`，彻底移除跨 worker 的 `symbol`
 *   所有权/claim/unclaim 复杂度；
 * - 复用 `atomic-json.ts` 统一原子写。
 */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomicJson } from '../storage/atomic-json.js'

export interface SessionMapEntry {
  sessionId: string
  cwd: string
  sentCount: number
  sentHash: string
  outputHash: string
  route: string
  routeVersion: number
  updatedAt: number
  cancelled?: boolean
}

interface SessionMapFile {
  format: number
  entries: Record<string, SessionMapEntry>
}

export const SESSION_MAP_FORMAT = 3
const FILE_NAME = 'sessions.json'

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

export async function readSessionMap(cacheDir: string): Promise<Record<string, SessionMapEntry>> {
  const file = join(cacheDir, FILE_NAME)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SessionMapFile>
    if (parsed.format !== SESSION_MAP_FORMAT || !parsed.entries || typeof parsed.entries !== 'object') {
      return {}
    }
    const entries: Record<string, SessionMapEntry> = {}
    for (const [key, entry] of Object.entries(parsed.entries)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
      if (!entry || typeof entry !== 'object') continue
      const row = entry as Partial<SessionMapEntry>
      if (typeof row.sessionId !== 'string' || row.sessionId === '') continue
      if (typeof row.cwd !== 'string' || row.cwd === '') continue
      if (!Number.isSafeInteger(row.sentCount) || row.sentCount === undefined || row.sentCount < 0) continue
      if (!isHash(row.sentHash) || !isHash(row.outputHash) || !isHash(row.route)) continue
      const routeVersion = typeof row.routeVersion === 'number' && Number.isSafeInteger(row.routeVersion)
        ? row.routeVersion
        : 0
      entries[key] = {
        sessionId: row.sessionId,
        cwd: row.cwd,
        sentCount: row.sentCount,
        sentHash: row.sentHash,
        outputHash: row.outputHash,
        route: row.route,
        routeVersion,
        updatedAt: typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
        ...(row.cancelled === true ? { cancelled: true } : {}),
      }
    }
    return entries
  } catch {
    return {}
  }
}

export async function writeSessionMap(
  cacheDir: string,
  entries: Record<string, SessionMapEntry>,
  deletedKeys?: ReadonlySet<string>,
): Promise<boolean> {
  const onDisk = await readSessionMap(cacheDir).catch(() => ({} as Record<string, SessionMapEntry>))
  const merged: Record<string, SessionMapEntry> = { ...onDisk }
  if (deletedKeys) {
    for (const key of deletedKeys) delete merged[key]
  }
  for (const [key, entry] of Object.entries(entries)) {
    const existing = merged[key]
    if (existing === undefined || entry.updatedAt >= existing.updatedAt) merged[key] = entry
  }
  const ordered = Object.fromEntries(
    Object.entries(merged).sort(([, a], [, b]) => b.updatedAt - a.updatedAt),
  )
  try {
    await mkdir(cacheDir, { recursive: true })
    await writeAtomicJson(join(cacheDir, FILE_NAME), { format: SESSION_MAP_FORMAT, entries: ordered }, 0o600)
    return true
  } catch {
    return false
  }
}

export interface SessionStoreBackend {
  load(): Promise<Record<string, SessionMapEntry>>
  save(entries: Record<string, SessionMapEntry>, deletedKeys?: ReadonlySet<string>): Promise<void> | void
  onError?(): void
}

export class SessionStore {
  #entries: Record<string, SessionMapEntry> = {}
  readonly #deleted = new Map<string, number>()
  #deleteSeq = 0
  #ready?: Promise<void>
  #writes: Promise<void> = Promise.resolve()
  #errorReported = false

  constructor(private readonly backend: SessionStoreBackend) {}

  async get(key: string): Promise<SessionMapEntry | undefined> {
    await this.#ensureLoaded()
    const entry = this.#entries[key]
    return entry ? { ...entry } : undefined
  }

  set(key: string, entry: SessionMapEntry): void {
    this.#deleted.delete(key)
    this.#entries[key] = { ...entry }
    this.#enqueue()
  }

  delete(key: string): void {
    delete this.#entries[key]
    this.#deleted.set(key, ++this.#deleteSeq)
    this.#enqueue()
  }

  async flush(): Promise<void> {
    await this.#writes
  }

  async close(): Promise<void> {
    await this.#ready
    await this.flush()
  }

  async #ensureLoaded(): Promise<void> {
    this.#ready ??= this.backend.load().then(
      (entries) => { this.#entries = { ...entries, ...this.#entries } },
      () => { this.#reportError() },
    )
    await this.#ready
  }

  #enqueue(): void {
    const snapshot = structuredClone(this.#entries)
    const deletedSnapshot = new Map(this.#deleted)
    const deletedKeys = deletedSnapshot.size > 0 ? new Set(deletedSnapshot.keys()) : undefined
    this.#writes = this.#writes.then(async () => {
      await this.#ensureLoaded()
      await this.backend.save(snapshot, deletedKeys)
      for (const [key, seq] of deletedSnapshot) {
        if (this.#deleted.get(key) === seq) this.#deleted.delete(key)
      }
      this.#errorReported = false
    }).catch(() => {
      this.#reportError()
    })
  }

  #reportError(): void {
    if (!this.#errorReported) this.backend.onError?.()
    this.#errorReported = true
  }
}

export function createFileSessionStore(cacheDir: string, onError?: () => void): SessionStore {
  return new SessionStore({
    load: () => readSessionMap(cacheDir),
    save: async (entries, deletedKeys) => {
      if (!await writeSessionMap(cacheDir, entries, deletedKeys)) throw new Error('Session map write failed')
    },
    onError,
  })
}
