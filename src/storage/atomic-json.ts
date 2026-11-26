/**
 * 统一的原子文件写入原语（tmp + wx + rename + 失败清理）。
 * 取代此前分散在 accounts/store、catalog-cache、session-map、credentials 的四份重复实现。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/** 异步原子写文本文件（默认 0600 权限）。 */
export async function writeAtomicText(filePath: string, content: string, mode = 0o600): Promise<void> {
  const dir = dirname(filePath)
  const temp = join(dir, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  let ownsTemp = false
  try {
    await mkdir(dir, { recursive: true })
    const handle = await open(temp, 'wx', mode)
    ownsTemp = true
    try {
      await handle.writeFile(content, 'utf8')
    } finally {
      await handle.close()
    }
    await rename(temp, filePath)
    ownsTemp = false
  } finally {
    if (ownsTemp) await unlink(temp).catch(() => undefined)
  }
}

/** 异步原子写 JSON 文件（格式化 + 尾换行）。 */
export async function writeAtomicJson(filePath: string, payload: unknown, mode = 0o600): Promise<void> {
  await writeAtomicText(filePath, `${JSON.stringify(payload, null, 2)}\n`, mode)
}

/** 同步原子写 JSON 文件（写完回读自检再 rename，供 accounts/store 同步持久化使用）。 */
export function writeAtomicJsonSync(filePath: string, payload: unknown, mode = 0o600): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temp = join(dir, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  const body = `${JSON.stringify(payload, null, 2)}\n`
  try {
    writeFileSync(temp, body, { encoding: 'utf8', mode, flag: 'wx' })
    JSON.parse(readFileSync(temp, 'utf8'))
    renameSync(temp, filePath)
  } catch (error) {
    try { rmSync(temp, { force: true }) } catch { /* 不掩盖原始错误 */ }
    throw error
  }
}
