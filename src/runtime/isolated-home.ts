/**
 * 账号隔离的 HOME 环境。
 *
 * 隔离账号各自有一个目录；官方 ACP server / CLI 都以它为 HOME 启动，从而读写
 * **该账号自己的** `~/.gemini`。注意各平台差异：
 * - Unix 上 `HOME` 足够；官方 CLI 还认 `GEMINI_CLI_HOME`。
 * - Windows 上 libuv / Go 从 `USERPROFILE`（或 `HOMEDRIVE`+`HOMEPATH`）解析 home，
 *   只改 `HOME` 会让所有账号悄悄共用真实用户目录；三者必须一起改。
 * - Linux 上把 `DBUS_SESSION_BUS_ADDRESS` 指到账号目录内一个不存在的路径，
 *   阻止官方 CLI 落到桌面 Secret Service（gnome-keyring）读主账号 token。
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
  } else if (platform === 'linux') {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(homeDir, '.no-dbus-session')}`
  }
  return env
}
