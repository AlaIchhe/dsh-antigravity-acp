/** 账号根目录与文件路径。 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 可用环境变量覆盖账号根目录（测试与多 profile 隔离）。 */
export const ACCOUNTS_DIR_ENV = 'AGY_ACP_ACCOUNTS_DIR'

/**
 * 账号根目录：默认 `~/.antigravity-acp-accounts`。
 *
 * 刻意**不放在** `$DSH_HOME` 下：Windows 上 DSH 会把整棵 `$DSH_HOME` 标成 Low
 * 强制完整性，官方 ACP server 在那里写登录态会被 MIC 拒绝；账号目录需要在
 * 普通用户 profile 里。也不放进缓存目录，避免被清理工具当作可丢弃数据。
 */
export function resolveAccountsDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  const override = env[ACCOUNTS_DIR_ENV]?.trim()
  return override ? override : join(home, '.antigravity-acp-accounts')
}

export const ACCOUNTS_FILE = 'accounts.json'

export function accountsFilePath(baseDir: string): string {
  return join(baseDir, ACCOUNTS_FILE)
}

/** 隔离账号的 HOME 目录（id 已在 manager 侧校验过字符集）。 */
export function accountDir(baseDir: string, id: string): string {
  return join(baseDir, id)
}
