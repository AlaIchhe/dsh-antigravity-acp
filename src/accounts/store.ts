/**
 * 账号列表的持久化：统一经 `atomic-json.ts` 原子写，严格校验目录包含性。
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { writeAtomicJsonSync } from '../storage/atomic-json.js'
import { accountsFilePath } from './paths.js'
import { SYSTEM_ACCOUNT_ID, type AccountRecord } from './types.js'

const FILE_VERSION = 1

export interface AccountsFile {
  version: number
  accounts: AccountRecord[]
  activeAccountId?: string
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/

export function isValidAccountId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id) && id !== SYSTEM_ACCOUNT_ID
}

export function isContainedDir(baseDir: string, dir: unknown): dir is string {
  if (typeof dir !== 'string' || dir.length === 0) return false
  const root = resolve(baseDir)
  const target = resolve(dir)
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

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
    const alias = typeof value.alias === 'string' && value.alias.trim()
      ? value.alias.trim().slice(0, 80)
      : `账号 ${accounts.length + 2}`
    const email = typeof value.email === 'string' && value.email.trim()
      ? value.email.trim().slice(0, 254)
      : undefined
    const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : Date.now()
    const lastUsedAt = typeof value.lastUsedAt === 'number' && Number.isFinite(value.lastUsedAt) ? value.lastUsedAt : undefined
    seen.add(id)
    accounts.push({
      id,
      alias,
      ...(email ? { email } : {}),
      dir,
      createdAt,
      ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
    })
  }
  return accounts
}

function readAccountsFile(file: string): AccountsFile | undefined {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
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

export function loadAccountsFile(baseDir: string): AccountsFile {
  const primary = readAccountsFile(accountsFilePath(baseDir))
  if (primary) return { ...primary, accounts: normalizeAccounts(baseDir, primary) }
  return { version: FILE_VERSION, accounts: [] }
}

export function saveAccountsFile(baseDir: string, data: AccountsFile, knownIds?: ReadonlySet<string>): void {
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
  writeAtomicJsonSync(accountsFilePath(baseDir), payload, 0o600)
}

export function accountDirFor(baseDir: string, id: string): string {
  return join(baseDir, id)
}
