/**
 * 账号列表的持久化：原子写、坏文件回退 last-good、路径包含性校验。
 *
 * 设计口径与 `session-map.ts` / `catalog-cache.ts` 一致：临时文件用 pid + UUID
 * 唯一名（`wx` 防撞名），先自检 JSON 再 rename；目录里的账号目录只允许位于
 * 账号根目录之下——`accounts.json` 是允许手改的，不能因为一个 `dir` 字段就把
 * 任意目录交给删除逻辑。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { accountsFilePath } from './paths.js'
import { SYSTEM_ACCOUNT_ID, type AccountRecord } from './types.js'

const FILE_VERSION = 1

export interface AccountsFile {
  version: number
  accounts: AccountRecord[]
  activeAccountId?: string
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/

/** 账号 id 只允许出现在文件名里的安全字符，且不能是系统账号的保留 id。 */
export function isValidAccountId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id) && id !== SYSTEM_ACCOUNT_ID
}

/** `dir` 必须真实位于账号根目录之下（防 `../`、绝对路径与符号链接表面值）。 */
export function isContainedDir(baseDir: string, dir: unknown): dir is string {
  if (typeof dir !== 'string' || dir.length === 0) return false
  const root = resolve(baseDir)
  const target = resolve(dir)
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** 只保留结构合法的隔离账号；系统账号永远来自真实 HOME，不读文件。 */
export function normalizeAccounts(baseDir: string, raw: unknown): AccountRecord[] {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const rows = Array.isArray(source.accounts) ? source.accounts : []
  const seen = new Set<string>()
  const accounts: AccountRecord[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const value = row as Record<string, unknown>
    const id = value.id
    if (!isValidAccountId(id) || seen.has(id)) continue
    const dir = value.dir
    if (!isContainedDir(baseDir, dir)) continue
    const alias = typeof value.alias === 'string' && value.alias.trim() ? value.alias.trim().slice(0, 80) : `账号 ${accounts.length + 2}`
    const email = typeof value.email === 'string' && value.email.trim() ? value.email.trim().slice(0, 254) : undefined
    const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : Date.now()
    const lastUsedAt = typeof value.lastUsedAt === 'number' && Number.isFinite(value.lastUsedAt) ? value.lastUsedAt : undefined
    seen.add(id)
    accounts.push({ id, alias, ...(email ? { email } : {}), dir, createdAt, ...(lastUsedAt === undefined ? {} : { lastUsedAt }) })
  }
  return accounts
}

function readFile(file: string): AccountsFile | undefined {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    // 没有文件就是首次运行；其他读取错误直接抛出，不装作「还没有账号」。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`账号文件结构无效（不是对象）: ${file}`)
  }
  const value = parsed as Record<string, unknown>
  if (!Array.isArray(value.accounts)) throw new Error(`账号文件缺少 accounts 数组: ${file}`)
  return {
    version: FILE_VERSION,
    accounts: value.accounts as AccountRecord[],
    ...(typeof value.activeAccountId === 'string' ? { activeAccountId: value.activeAccountId } : {}),
  }
}

/** 读账号列表；没有文件即首次运行，文件损坏则直接抛错（没有 last-good 回退）。 */
export function loadAccountsFile(baseDir: string): AccountsFile {
  const file = accountsFilePath(baseDir)
  const primary = readFile(file)
  if (primary) return { ...primary, accounts: normalizeAccounts(baseDir, primary) }
  return { version: FILE_VERSION, accounts: [] }
}

function writeAtomic(file: string, body: string): void {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    JSON.parse(readFileSync(temp, 'utf8'))
    renameSync(temp, file)
  } catch (error) {
    try { rmSync(temp, { force: true }) } catch { /* 清理失败不掩盖原始错误 */ }
    throw error
  }
}

/**
 * 保存账号列表。
 *
 * 多个 Host（web + headless）会共享同一份文件：`knownIds` 是**本进程见过**的账号，
 * 磁盘上不在其中的记录视为其它进程新增，保存时合并保留而不是覆盖。当前账号仍以
 * 本次写入为准。
 */
export function saveAccountsFile(baseDir: string, data: AccountsFile, knownIds?: ReadonlySet<string>): void {
  mkdirSync(baseDir, { recursive: true, mode: 0o700 })
  const own = normalizeAccounts(baseDir, data)
  const accounts = [...own]
  if (knownIds) {
    const seen = new Set(own.map((row) => row.id))
    for (const row of loadAccountsFile(baseDir).accounts) {
      if (knownIds.has(row.id) || seen.has(row.id)) continue
      accounts.push(row)
      seen.add(row.id)
    }
  }
  const payload: AccountsFile = {
    version: FILE_VERSION,
    accounts,
    ...(data.activeAccountId ? { activeAccountId: data.activeAccountId } : {}),
  }
  writeAtomic(accountsFilePath(baseDir), `${JSON.stringify(payload, null, 2)}\n`)
}

export function accountDirFor(baseDir: string, id: string): string {
  return join(baseDir, id)
}
