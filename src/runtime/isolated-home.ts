/**
 * 账号隔离的 HOME 环境。
 *
 * 隔离账号各自有一个目录；官方 ACP server / CLI 都以它为 HOME 启动，从而读写
 * **该账号自己的** `~/.gemini`。注意各平台差异：
 * - Unix 上 `HOME` 足够；官方 CLI 还认 `GEMINI_CLI_HOME`。
 * - Windows 上 libuv / Go 从 `USERPROFILE`（或 `HOMEDRIVE`+`HOMEPATH`）解析 home，
 *   只改 `HOME` 会让所有账号悄悄共用真实用户目录；三者必须一起改。
 *
 * 这里**只设置 HOME 系列变量，不碰 `DBUS_SESSION_BUS_ADDRESS`**。
 *
 * 曾经的写法是把它指到账号目录里一个不存在的 `.no-dbus-session`，想「阻止官方
 * CLI 落到 Secret Service 读主账号 token」。2026-11-22 实测证明这条防御既无效
 * 又有害：
 * - **无效**：隔离本来就靠 HOME 生效。隔离账号配真实 DBUS 跑，官方 CLI 读到的
 *   仍是它自己 HOME 下的账号（报的是该账号自己的错误），没有读到主账号 token。
 * - **有害**：官方 CLI 自带完整的 keyring 降级链（`Using file-based token storage
 *   because a keyring timeout was recorded...`，并写 `<cache>/antigravity-keyring-unavailable`
 *   标记避免反复超时），外部强行指到一个连不上的地址只会让它每次都走超时分支：
 *   单次调用从 ~3.6s 涨到 ~12.2s。它还制造出「keyring 读得到旧 token、文件却写不进」
 *   的矛盾状态，2026-11-22 09:05 的 `{"token": null}` 就是这样产生的。
 */
import { join } from 'node:path'

export function isolatedHomeEnv(homeDir: string, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const geminiDir = join(homeDir, '.gemini')
  const env: Record<string, string> = {
    HOME: homeDir,
    GEMINI_CLI_HOME: geminiDir,
    ANTIGRAVITY_GEMINI_DIR: geminiDir,
    ANTIGRAVITY_APP_DATA_DIR: join(geminiDir, 'antigravity-cli'),
  }
  if (platform === 'win32') {
    env.USERPROFILE = homeDir
    const match = /^([A-Za-z]:)(.*)$/.exec(homeDir)
    if (match) {
      env.HOMEDRIVE = match[1] as string
      env.HOMEPATH = match[2] as string
    }
  }
  return env
}
