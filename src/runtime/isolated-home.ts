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
 *   **只对隔离账号这样做**：系统账号用的就是真实 HOME，它的登录态本来就在
 *   真实 keyring 里；把 DBUS 掐掉会让官方 CLI 读不到 token，而它刷新后又会
 *   因为写 keyring 失败而只把 `{"token": null}` 落盘，下一步启动就变成
 *   「Authentication required」。
 */
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 规范化 HOME 便于比较（Windows 大小写不敏感，尾部分隔符忽略）。 */
function sameHome(a: string, b: string, platform: NodeJS.Platform): boolean {
  const norm = (value: string): string => {
    let out = value.replace(/[\\/]+$/, '')
    if (out === '') out = platform === 'win32' ? '\\' : '/'
    return platform === 'win32' ? out.toLowerCase() : out
  }
  return norm(a) === norm(b)
}

export function isolatedHomeEnv(
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
  realHome: string = homedir(),
): Record<string, string> {
  const geminiDir = join(homeDir, '.gemini')
  const env: Record<string, string> = {
    HOME: homeDir,
    GEMINI_CLI_HOME: geminiDir,
    ANTIGRAVITY_GEMINI_DIR: geminiDir,
    ANTIGRAVITY_APP_DATA_DIR: join(geminiDir, 'antigravity-cli'),
  }
  // 系统账号：HOME 就是真实 HOME，登录态属于它自己，必须让它照常访问真实 keyring。
  const isolated = !sameHome(homeDir, realHome, platform)
  if (platform === 'win32') {
    env.USERPROFILE = homeDir
    const match = /^([A-Za-z]:)(.*)$/.exec(homeDir)
    if (match) {
      env.HOMEDRIVE = match[1] as string
      env.HOMEPATH = match[2] as string
    }
  } else if (platform === 'linux' && isolated) {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(homeDir, '.no-dbus-session')}`
  }
  return env
}
