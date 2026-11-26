/**
 * 统一的子进程最小环境变量构造（供 ACP server 与只读 agy CLI 共用）。
 *
 * 合并原 isolated-home.ts、agent-link.ts(officialAgentEnv) 与 agy-cli.ts(cliEnv)：
 * - DSH subprocess 会 scrub 父环境，这里只白名单转发系统必需键，不透传 DSH_* 内部键；
 * - 隔离账号覆盖 HOME / GEMINI_CLI_HOME / USERPROFILE 等变量（不碰 DBUS_SESSION_BUS_ADDRESS）；
 * - 出网代理最后合并：显式配置优先，留空继承宿主代理，始终确保 loopback 绕过。
 */
import { delimiter, join } from 'node:path'
import { ambientProxyEnv, buildProxyEnv } from './proxy.js'
import type { ProxySettings } from './proxy.js'

const FORWARD_SYSTEM_KEYS = [
  'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'windir', 'WINDIR',
  'COMSPEC', 'ComSpec', 'PATHEXT', 'PATH',
  'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'USERNAME', 'USER', 'USERDOMAIN',
  'LOCALAPPDATA', 'APPDATA',
  'TEMP', 'TMP', 'TMPDIR',
] as const

export function isolatedHomeEnv(
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
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

export interface SubprocessEnvOptions {
  /** 可选：追加到 PATH 前部的二进制目录（ACP server sibling 依赖）。 */
  binaryDir?: string
  /** 可选：覆盖 TEMP/TMP/TMPDIR（PyInstaller 冻结二进制需要独立可写目录）。 */
  tmpDir?: string
  /** 可选：隔离账号 HOME。 */
  homeDir?: string
  /** 可选：显式代理配置；未传时继承 parent 中的代理环境。 */
  proxy?: ProxySettings | undefined
  parent?: Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
}

export function buildSubprocessEnv(options: SubprocessEnvOptions = {}): Record<string, string> {
  const parent = options.parent ?? process.env
  const platform = options.platform ?? process.platform
  const env: Record<string, string> = {}

  for (const key of FORWARD_SYSTEM_KEYS) {
    const value = parent[key]
    if (value !== undefined && value !== '') env[key] = value
  }

  if (options.binaryDir) {
    const pathPrefix = `${options.binaryDir}${delimiter}`
    const parentPath = env.PATH ?? ''
    env.PATH = parentPath.startsWith(pathPrefix) ? parentPath : `${pathPrefix}${parentPath}`
  }

  if (options.tmpDir) {
    env.TEMP = options.tmpDir
    env.TMP = options.tmpDir
    env.TMPDIR = options.tmpDir
  }

  if (!env.SystemRoot && platform === 'win32') {
    env.SystemRoot = 'C:\\Windows'
  }

  if (options.homeDir) {
    Object.assign(env, isolatedHomeEnv(options.homeDir, platform))
  }

  const proxyEnv = options.proxy ? buildProxyEnv(options.proxy) : ambientProxyEnv(parent)
  if (proxyEnv) {
    for (const [key, value] of Object.entries(proxyEnv)) {
      if (typeof value === 'string' && value !== '') env[key] = value
    }
  }

  return env
}
