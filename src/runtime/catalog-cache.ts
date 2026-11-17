/**
 * 模型目录的磁盘缓存（只存模型 id/name/description/contextWindow，不含任何凭据）。
 *
 * 为什么需要：ACP v1 没有「不建会话、不认证」的只读目录方法，真实目录只能从
 * `session/new` 之后观测到。插件或官方进程一旦重启，内存目录归零，模型选择器
 * 就退回到占位项 `server-default` —— 用户登录前选的 id 登录后不再出现在列表里。
 *
 * 缓存语义（刻意保守）：
 * - **只缓存**观测到的目录，不预置任何「猜测的模型清单」；
 * - 键含 ACP server 版本与插件 major/minor，官方换版或目录形状变化即失效；
 * - 读取失败、JSON 损坏、字段不符一律静默降级为「没有缓存」，绝不抛错影响
 *   `listModels`；
 * - 落盘内容是纯模型元数据，绝不写入 stderr、授权 URL 或任何凭据片段。
 */
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/** 缓存文件的形状；额外字段一律忽略。 */
interface CatalogCacheFile {
  acpVersion: string
  format: number
  models: CachedModelRow[]
  thoughtLevel?: CachedThoughtLevel
}

/** 单条缓存记录；contextWindow 来自实测（usage_update.size），可缺省。 */
interface CachedModelRow {
  id: string
  name: string
  description?: string
  contextWindow?: number
}

/** 缓存的思考强度选择器：agent 声明过的档位与当时的值。 */
export interface CachedThoughtLevel {
  /** `session/set_config_option` 用的 configId。 */
  configId: string
  /** agent 声明的档位，按声明顺序（可能含 `xhigh` 等非三档值）。 */
  options: Array<{ value: string; name: string; description?: string }>
  currentValue?: string
}

/** 一份观测快照：模型目录 + 当时的思考强度选择器。 */
export interface CachedCatalog {
  models: CachedModelRow[]
  thoughtLevel?: CachedThoughtLevel
}

/**
 * 缓存格式版本：字段语义变化时 +1，旧文件自然作废。
 * 2：加入 `thoughtLevel`（ACP 1.5 起档位是独立 config option）。
 */
const CACHE_FORMAT = 2

/** 读取观测过的模型目录；任何异常都返回 undefined（调用方降级为占位模型）。 */
export async function readCachedCatalog(options: {
  cacheDir: string
  acpVersion: string
  /** 缓存文件名（默认 catalog.json）；CLI 清单另存一份时用它区分。 */
  fileName?: string
}): Promise<CachedCatalog | undefined> {
  const file = join(options.cacheDir, options.fileName ?? 'catalog.json')
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as CatalogCacheFile
    if (parsed.format !== CACHE_FORMAT) return undefined
    if (parsed.acpVersion !== options.acpVersion) return undefined
    if (!Array.isArray(parsed.models) || parsed.models.length === 0) return undefined
    const models = parsed.models.filter((entry): entry is CachedModelRow => (
      typeof entry?.id === 'string' && entry.id !== '' && typeof entry.name === 'string'
    ))
    if (models.length === 0) return undefined
    const thoughtLevel = normalizeThoughtLevel(parsed.thoughtLevel)
    return thoughtLevel === undefined ? { models } : { models, thoughtLevel }
  } catch {
    return undefined
  }
}

/** 缓存里的档位选择器同样是「读坏了就当没有」，不因为一条脏数据让整份目录作废。 */
function normalizeThoughtLevel(input: unknown): CachedThoughtLevel | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as CachedThoughtLevel
  if (typeof record.configId !== 'string' || record.configId === '') return undefined
  if (!Array.isArray(record.options)) return undefined
  const options = record.options.filter((entry): entry is { value: string; name: string; description?: string } => (
    typeof entry?.value === 'string' && entry.value !== '' && typeof entry.name === 'string' && entry.name !== ''
  ))
  if (options.length === 0) return undefined
  return {
    configId: record.configId,
    options,
    ...(typeof record.currentValue === 'string' && record.currentValue !== '' ? { currentValue: record.currentValue } : {}),
  }
}

/**
 * 写入观测到的模型目录。写入失败（只读缓存目录、磁盘满、文件被占用）静默忽略：
 * 缓存是优化，不是功能，失败不得影响本轮对话。
 */
export async function writeCachedCatalog(options: {
  cacheDir: string
  acpVersion: string
  models: readonly CachedModelRow[]
  /** 观测到的思考强度选择器；没有（旧 agent）时不写这一项。 */
  thoughtLevel?: CachedThoughtLevel
  /** 缓存文件名（默认 catalog.json）。 */
  fileName?: string
}): Promise<void> {
  if (options.models.length === 0) return
  const payload: CatalogCacheFile = {
    acpVersion: options.acpVersion,
    format: CACHE_FORMAT,
    ...(options.thoughtLevel === undefined ? {} : { thoughtLevel: options.thoughtLevel }),
    models: options.models.map((model) => ({
      id: model.id,
      name: model.name,
      ...(model.description === undefined ? {} : { description: model.description }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    })),
  }
  const file = join(options.cacheDir, options.fileName ?? 'catalog.json')
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`)
  let ownsTemporary = false
  try {
    await mkdir(dirname(file), { recursive: true })
    // Each writer owns a different sibling. Readers only see a complete old or new snapshot.
    // open(wx) lets cleanup distinguish our partially written file from an unlikely collision.
    const handle = await open(temporary, 'wx', 0o600)
    ownsTemporary = true
    try {
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
    ownsTemporary = false
  } catch {
    // 缓存写不进去不影响功能。
  } finally {
    if (ownsTemporary) await unlink(temporary).catch(() => undefined)
  }
}
