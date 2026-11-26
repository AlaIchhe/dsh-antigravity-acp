/**
 * 官方 Antigravity ACP server 二进制定位与临时运行目录管理（v1.0 精简版）。
 *
 * 解析顺序：config.binaryPath → 环境变量 AGY_ACP_BIN → 缓存目录中已安装的对应版本。
 * 不执行自动下载，找不到直接报 AGY_BINARY_MISSING。
 */
import { access, chmod, mkdir, readdir, rm } from 'node:fs/promises'
import { homedir as osHomedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const DEFAULT_ACP_SERVER_VERSION = '1.4.0'
export const CACHE_SUBPATH = ['cache', 'antigravity-acp'] as const
export const INSTALL_DIR_NAME = 'dsh-antigravity-host'
export const INSTALL_ROOT_ENV = 'AGY_ACP_HOME'

export const AGY_BINARY_ERROR = {
  INVALID_VERSION: 'AGY_INVALID_VERSION',
  ARCHIVE_LAYOUT: 'AGY_ARCHIVE_LAYOUT',
  BINARY_MISSING: 'AGY_BINARY_MISSING',
  PLATFORM_UNSUPPORTED: 'AGY_PLATFORM_UNSUPPORTED',
  LOW_INTEGRITY: 'AGY_BINARY_LOW_INTEGRITY',
} as const

export class AgyBinaryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'AgyBinaryError'
  }
}

export type AcpPlatform = 'windows' | 'darwin' | 'linux'
export type AcpArch = 'x86_64' | 'aarch64'
export type ExecutableFlavor = 'windows' | 'posix'

export const ACP_DISTRIBUTIONS = {
  windows: { directory: 'windows', executable: 'agy_acp_server.exe', defaultArgs: [] },
  darwin: { directory: 'macos', executable: 'agy_acp_server.par', defaultArgs: [] },
  linux: { directory: 'linux', executable: 'agy_acp_server.par', defaultArgs: ['--uid='] },
} as const

export function defaultAgentArgs(platform: NodeJS.Platform = process.platform): readonly string[] {
  return platform === 'linux' ? [...ACP_DISTRIBUTIONS.linux.defaultArgs] : []
}

export function mapNodePlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): { platform: AcpPlatform; arch: AcpArch } {
  const mappedPlatform: AcpPlatform | undefined =
    platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : undefined
  const mappedArch: AcpArch | undefined =
    arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : undefined
  if (!mappedPlatform || !mappedArch) {
    throw new AgyBinaryError(
      AGY_BINARY_ERROR.PLATFORM_UNSUPPORTED,
      `当前平台/架构不受支持（platform=${platform}, arch=${arch}）`,
    )
  }
  return { platform: mappedPlatform, arch: mappedArch }
}

/** 校验版本字符串，防止路径穿越。 */
export function assertValidVersion(version: string): string {
  const trimmed = version.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed) || trimmed.includes('..')) {
    throw new AgyBinaryError(AGY_BINARY_ERROR.INVALID_VERSION, `acpVersion 格式不合法: ${version}`)
  }
  return trimmed
}

/** 数据缓存目录（模型目录缓存、会话映射等非可执行文件）。 */
export function resolveCacheDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = osHomedir(),
): string {
  const dshHome = env.DSH_HOME?.trim() || join(home, '.dsh')
  return join(dshHome, ...CACHE_SUBPATH)
}

/**
 * 可执行文件安装根目录（刻意避开 Windows 上带 Low 完整性标签的 `$DSH_HOME`）。
 */
export function resolveInstallRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = osHomedir(),
): string {
  const override = env[INSTALL_ROOT_ENV]?.trim()
  if (override) return resolve(override)
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim() || join(home, 'AppData', 'Local')
    return join(localAppData, INSTALL_DIR_NAME)
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', INSTALL_DIR_NAME)
  }
  const xdgData = env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share')
  return join(xdgData, INSTALL_DIR_NAME)
}

export function versionCachePaths(installRoot: string, version: string): { versionDir: string; extractDir: string } {
  const safeVersion = assertValidVersion(version)
  const versionDir = join(installRoot, safeVersion)
  return { versionDir, extractDir: join(versionDir, `extract-${safeVersion}`) }
}

export function pickExecutablePath(entries: readonly string[], flavor: ExecutableFlavor): string {
  const candidates = entries.filter((entry) => {
    if (entry.endsWith('/')) return false
    const base = entry.split('/').at(-1) ?? ''
    if (flavor === 'windows') return /^(agy_acp_server|agy-acp-server)\.exe$/i.test(base)
    return base === 'agy_acp_server.par' || base === 'agy-acp-server' || base === 'agy_acp_server'
  })
  if (candidates.length === 0) {
    throw new AgyBinaryError(
      AGY_BINARY_ERROR.ARCHIVE_LAYOUT,
      `目录内未找到 ACP server 可执行文件（flavor=${flavor}，条目数=${entries.length}）`,
    )
  }
  const depth = (entry: string): number => entry.split('/').length
  return candidates.slice().sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0))[0]!
}

export interface RuntimeDirectory {
  root: string
  tmpDir: string
}

export async function createRuntimeDirectory(baseDir = tmpdir()): Promise<RuntimeDirectory> {
  const root = join(baseDir, `agy-acp-run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const tmpDir = join(root, 'tmp')
  await mkdir(tmpDir, { recursive: true, mode: 0o700 })
  return { root, tmpDir }
}

export async function releaseRuntimeDirectory(directory: RuntimeDirectory): Promise<void> {
  await rm(directory.root, { recursive: true, force: true })
}

export interface AgentBinaryResolution {
  executablePath: string
  source: 'config' | 'env' | 'cache'
  version?: string
}

export interface AgentBinaryOptions {
  binaryPath?: string
  version?: string
  env?: Readonly<Record<string, string | undefined>>
  cacheDir?: string
  platform?: NodeJS.Platform
  arch?: string
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function findExtractedExecutable(extractDir: string, flavor: ExecutableFlavor): Promise<string | undefined> {
  if (!(await fileExists(extractDir))) return undefined
  const walk = async (dir: string, prefix: string): Promise<string[]> => {
    const items = await readdir(dir, { withFileTypes: true })
    const files: string[] = []
    for (const item of items) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name
      if (item.isDirectory()) files.push(...(await walk(join(dir, item.name), rel)))
      else files.push(rel)
    }
    return files
  }
  const entries = await walk(extractDir, '')
  try {
    return join(extractDir, pickExecutablePath(entries, flavor))
  } catch {
    return undefined
  }
}

export async function ensureAgentBinary(options: AgentBinaryOptions = {}): Promise<AgentBinaryResolution> {
  const env = options.env ?? process.env
  const version = options.version ?? DEFAULT_ACP_SERVER_VERSION
  const platform = options.platform ?? process.platform
  const installRoot = options.cacheDir ?? resolveInstallRoot(env, platform)

  if (options.binaryPath && options.binaryPath.trim().length > 0) {
    const candidate = options.binaryPath.trim()
    if (!(await fileExists(candidate))) {
      throw new AgyBinaryError(AGY_BINARY_ERROR.BINARY_MISSING, `config.binaryPath 不存在: ${candidate}`)
    }
    return { executablePath: resolve(candidate), source: 'config' }
  }

  const envPath = env.AGY_ACP_BIN?.trim()
  if (envPath) {
    if (!(await fileExists(envPath))) {
      throw new AgyBinaryError(AGY_BINARY_ERROR.BINARY_MISSING, `环境变量 AGY_ACP_BIN 指向的文件不存在: ${envPath}`)
    }
    return { executablePath: resolve(envPath), source: 'env' }
  }

  const mapped = mapNodePlatform(platform, options.arch ?? process.arch)
  const flavor: ExecutableFlavor = mapped.platform === 'windows' ? 'windows' : 'posix'
  const { extractDir } = versionCachePaths(installRoot, version)
  const cached = await findExtractedExecutable(extractDir, flavor)
  if (cached) {
    if (flavor === 'posix') await chmod(cached, 0o755).catch(() => undefined)
    return { executablePath: cached, source: 'cache', version }
  }

  throw new AgyBinaryError(
    AGY_BINARY_ERROR.BINARY_MISSING,
    `未找到 ACP server 二进制（binaryPath 未配置、AGY_ACP_BIN 未设置、缓存无 ${version} 版本）。`,
  )
}
