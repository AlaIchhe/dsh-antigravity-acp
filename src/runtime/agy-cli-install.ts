/**
 * 官方 Antigravity CLI（`agy`）的一键安装。
 *
 * 为什么由插件自己实现，而不是执行官方那条
 * `curl -fsSL https://antigravity.google/cli/install.sh | bash`：
 *
 * 1. **不执行远端脚本**。`curl | bash` 把网络的返回直接交给 shell，等于让远端
 *    决定本机执行什么；插件里出现这种调用之后，任何上游跳转或镜像劫持都能直接
 *    变成代码执行。这里只复制该脚本的**行为**：查 manifest、下载、校验、落盘。
 * 2. **校验是硬性的**。官方 manifest 带 `sha512`，脚本也是先校验再安装；这里
 *    保持同样顺序，且校验失败一律不落盘。
 * 3. **可以只装到用户目录**。安装目标是 `~/.local/bin/agy`（与官方脚本默认一致），
 *    不需要 root，也不碰 DSH home（后者在 Windows 上带低完整性标签）。
 *
 * 与官方脚本的差异（刻意为之）：
 * - 不跑 `agy install` 那一步（它改 shell rc 文件），插件只保证二进制可用；
 * - 解包只取单个可执行文件，不展开整个归档；
 * - 下载限制在 {@link AGY_CLI_DOWNLOAD_HOSTS} 白名单内，且拒绝重定向。
 */

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzip as gunzipCallback } from 'node:zlib'
import { promisify } from 'node:util'

const gunzipAsync = promisify(gunzipCallback)

/** 官方 release manifest 的服务端点（与官方 install.sh 的 DOWNLOAD_BASE_URL 一致）。 */
export const AGY_CLI_MANIFEST_BASE = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app'

/**
 * 允许下载的域名。
 *
 * manifest 服务给出真实下载地址，落在 Google 的公共存储桶上；两处都必须显式列出，
 * 否则一次被篡改的 manifest 就能把下载引到任意主机。
 */
export const AGY_CLI_DOWNLOAD_HOSTS: ReadonlySet<string> = new Set([
  'antigravity-cli-auto-updater-974169037036.us-central1.run.app',
  'storage.googleapis.com',
])

export const AGY_CLI_INSTALL_ERROR = {
  UNSUPPORTED_PLATFORM: 'AGY_CLI_UNSUPPORTED_PLATFORM',
  MANIFEST_UNAVAILABLE: 'AGY_CLI_MANIFEST_UNAVAILABLE',
  MANIFEST_INVALID: 'AGY_CLI_MANIFEST_INVALID',
  DOWNLOAD_REJECTED: 'AGY_CLI_DOWNLOAD_REJECTED',
  DOWNLOAD_FAILED: 'AGY_CLI_DOWNLOAD_FAILED',
  CHECKSUM_MISMATCH: 'AGY_CLI_CHECKSUM_MISMATCH',
  EXTRACT_FAILED: 'AGY_CLI_EXTRACT_FAILED',
  INSTALL_FAILED: 'AGY_CLI_INSTALL_FAILED',
} as const

export class AgyCliInstallError extends Error {
  constructor(readonly code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AgyCliInstallError'
  }
}

export interface AgyCliManifest {
  version: string
  url: string
  sha512: string
}

export interface AgyCliTarget {
  /** manifest 里的 platform 段名，例如 `linux_amd64`、`darwin_arm64`、`linux_amd64_musl`。 */
  platform: string
  /** 安装后的文件名。 */
  executable: string
}

/**
 * 按 OS / 架构 / libc 决定要下载哪个平台包。
 *
 * 规则逐条对齐官方 install.sh：Termux（`uname -o` 为 Android）用 Bionic 包，
 * musl 系统用 `_musl` 变体，其余用 glibc 包。
 *
 * @param input - 平台事实（默认取本进程）。
 * @returns 目标平台段名与可执行文件名。
 * @throws AgyCliInstallError 平台不受支持时。
 */
export function resolveAgyCliTarget(input: {
  platform?: NodeJS.Platform
  arch?: string
  isMusl?: boolean
  isAndroid?: boolean
} = {}): AgyCliTarget {
  const platform = input.platform ?? process.platform
  const arch = input.arch ?? process.arch
  const normalizedArch = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : undefined
  if (normalizedArch === undefined) {
    throw new AgyCliInstallError(
      AGY_CLI_INSTALL_ERROR.UNSUPPORTED_PLATFORM,
      `官方 CLI 只提供 64 位包，当前架构是 ${arch}`,
    )
  }
  if (platform === 'win32') {
    throw new AgyCliInstallError(
      AGY_CLI_INSTALL_ERROR.UNSUPPORTED_PLATFORM,
      'Windows 请用官方安装包；这里的一键安装只覆盖 macOS 与 Linux',
    )
  }
  if (platform === 'darwin') {
    return { platform: `darwin_${normalizedArch}`, executable: 'agy' }
  }
  if (platform === 'linux') {
    if (input.isAndroid === true) {
      return { platform: `android_${normalizedArch}`, executable: 'agy' }
    }
    return {
      platform: input.isMusl === true ? `linux_${normalizedArch}_musl` : `linux_${normalizedArch}`,
      executable: 'agy',
    }
  }
  throw new AgyCliInstallError(
    AGY_CLI_INSTALL_ERROR.UNSUPPORTED_PLATFORM,
    `不支持的平台：${platform}`,
  )
}

/** 只接受 https 且主机在白名单内的地址。 */
export function assertAgyCliUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new AgyCliInstallError(AGY_CLI_INSTALL_ERROR.DOWNLOAD_REJECTED, `下载地址不是合法 URL：${raw}`)
  }
  if (url.protocol !== 'https:') {
    throw new AgyCliInstallError(AGY_CLI_INSTALL_ERROR.DOWNLOAD_REJECTED, `下载地址必须是 https：${raw}`)
  }
  if (!AGY_CLI_DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new AgyCliInstallError(
      AGY_CLI_INSTALL_ERROR.DOWNLOAD_REJECTED,
      `下载地址主机不在白名单内：${url.hostname}`,
    )
  }
  return url
}

/** 解析 manifest；字段缺失或类型不对一律拒绝，不猜默认值。 */
export function parseAgyCliManifest(payload: unknown): AgyCliManifest {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined
  const version = record?.version
  const url = record?.url
  const sha512 = record?.sha512
  if (typeof url !== 'string' || url === '' || typeof sha512 !== 'string' || !/^[a-f0-9]{128}$/i.test(sha512)) {
    throw new AgyCliInstallError(
      AGY_CLI_INSTALL_ERROR.MANIFEST_INVALID,
      'manifest 缺少可用的 url 或 sha512，已放弃安装',
    )
  }
  return {
    version: typeof version === 'string' && version !== '' ? version : 'unknown',
    url,
    sha512: sha512.toLowerCase(),
  }
}

/** 安装结果；`installed: false` 表示已存在、本次未改动。 */
export interface AgyCliInstallResult {
  installed: boolean
  path: string
  version: string
  /** 安装前的版本（已存在时才有）。 */
  existingVersion?: string
}

export interface AgyCliInstallOptions {
  /** 安装目录；默认 `$HOME/.local/bin`，与官方脚本一致。 */
  targetDir: string
  /** manifest 抓取；注入便于测试与代理复用。 */
  fetchImpl: typeof fetch
  /** 平台事实覆盖（测试用）。 */
  target?: AgyCliTarget
  signal?: AbortSignal
  /** 进度回调：`stage` 是给用户看的短句。 */
  onStage?: (stage: string) => void
  /** 已存在的二进制探测（默认读文件存在性）。 */
  exists?: (path: string) => Promise<boolean>
}

/** tar 头长度（USTAR）。 */
const TAR_BLOCK = 512

/** 从 tar 头里读一个字段，去掉 NUL 与结尾空白。 */
function tarField(header: Buffer, offset: number, length: number): string {
  const slice = header.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8').trim()
}

/** 读八进制长度字段；非八进制返回 NaN。 */
function tarSize(header: Buffer): number {
  const raw = tarField(header, 124, 12)
  return raw === '' ? 0 : Number.parseInt(raw, 8)
}

/**
 * 从 `.tar.gz` 里取出唯一需要的可执行文件。
 *
 * 只支持 ustar 的普通文件条目（官方包就是这种），遇到 PAX/GNU 扩展头直接跳过
 * 并按名字匹配；不整包解压，避免压缩炸弹与无关文件落盘。
 *
 * @param archive - 已解压的 tar 字节。
 * @param candidates - 可接受的条目文件名（basename 匹配）。
 * @returns 命中的文件内容。
 * @throws AgyCliInstallError 找不到目标条目时。
 */
export function extractExecutableFromTar(archive: Uint8Array, candidates: readonly string[]): Buffer {
  const buffer = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength)
  let offset = 0
  while (offset + TAR_BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK)
    // 全零块表示归档结束。
    if (header.every((byte) => byte === 0)) break
    const name = tarField(header, 0, 100)
    const prefix = tarField(header, 345, 155)
    const fullName = prefix === '' ? name : `${prefix}/${name}`
    const base = fullName.split('/').at(-1) ?? ''
    const size = tarSize(header)
    const typeFlag = String.fromCharCode(header[156] ?? 0)
    const dataStart = offset + TAR_BLOCK
    if (!Number.isFinite(size) || size < 0) {
      throw new AgyCliInstallError(AGY_CLI_INSTALL_ERROR.EXTRACT_FAILED, `tar 条目长度非法：${fullName}`)
    }
    // 普通文件且名字匹配 → 取出；把 x 位一并交给调用方 chmod。
    if ((typeFlag === '0' || typeFlag === '\0') && candidates.includes(base)) {
      return buffer.subarray(dataStart, dataStart + size)
    }
    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
  }
  throw new AgyCliInstallError(
    AGY_CLI_INSTALL_ERROR.EXTRACT_FAILED,
    `归档里没有找到可执行文件（期望 ${candidates.join(' 或 ')}）`,
  )
}

/** 抓 manifest；HTTP 非 2xx、JSON 非法都归一成可读错误。 */
async function fetchManifest(options: AgyCliInstallOptions, target: AgyCliTarget): Promise<AgyCliManifest> {
  const url = assertAgyCliUrl(`${AGY_CLI_MANIFEST_BASE}/manifests/${target.platform}.json`)
  let response: Response
  try {
    response = await options.fetchImpl(url, { signal: options.signal, redirect: 'error' } as RequestInit)
  } catch (error) {
    throw new AgyCliInstallError(
      AGY_CLI_INSTALL_ERROR.MANIFEST_UNAVAILABLE,
      `无法连接官方安装服务（${target.platform}）：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  if (!response.ok) {
    throw new AgyCliInstallError(
      AGY_CLI_INSTALL_ERROR.MANIFEST_UNAVAILABLE,
      `官方安装服务返回 HTTP ${response.status}（${target.platform}）`,
    )
  }
  const payload = await response.json().catch(() => undefined)
  return parseAgyCliManifest(payload)
}

/** 下载并流式计算 SHA-512；超过上限立即取消流，避免在内存中无界缓冲。 */
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024

async function download(
  options: AgyCliInstallOptions,
  rawUrl: string,
  maxBytes: number = MAX_DOWNLOAD_BYTES,
): Promise<{ bytes: Buffer; sha512: string }> {
  const url = assertAgyCliUrl(rawUrl)
  let response: Response
  try {
    response = await options.fetchImpl(url, { signal: options.signal, redirect: 'error' } as RequestInit)
  } catch (error) {
    throw new AgyCliInstallError(
      AGY_CLI_INSTALL_ERROR.DOWNLOAD_FAILED,
      `下载失败：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  if (!response.ok) {
    throw new AgyCliInstallError(AGY_CLI_INSTALL_ERROR.DOWNLOAD_FAILED, `下载失败：HTTP ${response.status}`)
  }
  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10)
  if (Number.isSafeInteger(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new AgyCliInstallError(AGY_CLI_INSTALL_ERROR.DOWNLOAD_FAILED, `安装包过大（${declared} 字节）`)
  }

  const hash = createHash('sha512')
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined)
          throw new AgyCliInstallError(AGY_CLI_INSTALL_ERROR.DOWNLOAD_FAILED, `安装包过大（>${maxBytes} 字节）`)
        }
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        hash.update(chunk)
        chunks.push(chunk)
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined)
      if (error instanceof AgyCliInstallError) throw error
      throw new AgyCliInstallError(
        AGY_CLI_INSTALL_ERROR.DOWNLOAD_FAILED,
        `下载流读取失败：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    } finally {
      reader.releaseLock()
    }
    return { bytes: Buffer.concat(chunks, total), sha512: hash.digest('hex') }
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength > maxBytes) {
    throw new AgyCliInstallError(AGY_CLI_INSTALL_ERROR.DOWNLOAD_FAILED, `安装包过大（${bytes.byteLength} 字节）`)
  }
  hash.update(bytes)
  return { bytes, sha512: hash.digest('hex') }
}

/**
 * 安装官方 CLI 到 `targetDir`，返回最终路径。
 *
 * 流程与官方脚本一致：manifest → 下载 → SHA512 校验 → 解包 → 原子替换。
 * 校验在落盘**之前**完成；已存在且版本相同时直接返回，不重复下载。
 *
 * @param options - 目标目录、fetch 实现与平台覆盖。
 * @returns 安装结果。
 */
export async function installAgyCli(options: AgyCliInstallOptions): Promise<AgyCliInstallResult> {
  const target = options.target ?? resolveAgyCliTarget()
  const destination = join(options.targetDir, target.executable)
  const exists = options.exists ?? (async (path: string) => {
    try {
      await access(path, constants.X_OK)
      return true
    } catch {
      return false
    }
  })
  if (await exists(destination)) {
    return { installed: false, path: destination, version: 'unknown' }
  }

  options.onStage?.('读取官方发布信息…')
  const manifest = await fetchManifest(options, target)

  options.onStage?.(`下载 ${manifest.version}…`)
  const { bytes: payload, sha512: digest } = await download(options, manifest.url)

  options.onStage?.('校验安装包…')
  if (digest !== manifest.sha512) {
    throw new AgyCliInstallError(
      AGY_CLI_INSTALL_ERROR.CHECKSUM_MISMATCH,
      '安装包 SHA-512 与官方清单不符，已中止（文件可能损坏或被篡改）',
    )
  }

  options.onStage?.('解包…')
  let executable: Buffer
  if (/\.tar\.gz(\?|$)/i.test(manifest.url)) {
    const unpacked = await gunzipAsync(payload)
    executable = extractExecutableFromTar(unpacked, ['agy', 'antigravity'])
  } else {
    executable = payload
  }

  options.onStage?.('写入安装目录…')
  await mkdir(options.targetDir, { recursive: true })
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, executable, { mode: 0o755 })
    await chmod(temporary, 0o755).catch(() => undefined)
    await rename(temporary, destination)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw new AgyCliInstallError(
      AGY_CLI_INSTALL_ERROR.INSTALL_FAILED,
      `写入 ${destination} 失败：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  return { installed: true, path: destination, version: manifest.version }
}
