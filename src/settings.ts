/**
 * 插件配置唯一定义（v1.0 破坏性精简版）。
 *
 * 移除了历史兼容字段（`proxyBypass`、`modelOverrides.{name,target}`）：
 * - 模型列表只管理显示/隐藏（`hiddenModels`）；
 * - 思考强度属于模型元数据，由 ACP 1.5+ `thought_level` 驱动；
 * - 额度开关如实描述：`cliQuotaEnabled` 打开后仅走 `agy` CLI，找不到 CLI 时明确报错。
 */
import Schema from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import { DEFAULT_ACP_SERVER_VERSION } from './runtime/binary.js'

export interface AntigravityHostConfig {
  /** 隐藏的模型 ID 列表（不出现在 DSH 模型选择器中；进行中的会话不受影响）。 */
  hiddenModels?: string[]
  /** 会话模式（agent 声明的 mode id，如 plan / auto / accept-edits）；留空沿用默认。 */
  agentMode?: string
  /** 官方 agy CLI 路径；留空依次查 AGY_CLI_BIN、PATH 和默认安装目录。 */
  agyCliPath?: string
  /** 官方 agy-acp-server 可执行文件路径；优先级高于 AGY_ACP_BIN 与缓存目录。 */
  binaryPath?: string
  /** 传给 ACP server 的额外命令行参数。 */
  extraArgs?: string[]
  /** 期望的 ACP server 版本（用于匹配缓存目录与目录缓存，不触发下载）。 */
  acpVersion?: string
  /** 单个 ACP 请求默认超时（毫秒）。 */
  requestTimeoutMs?: number
  /** initialize 握手等待上限（毫秒）。 */
  handshakeTimeoutMs?: number
  /** authenticate（浏览器 OAuth）等待上限（毫秒）。 */
  authTimeoutMs?: number
  /** `session/prompt` 无活动超时上限（毫秒）；收到流式更新/权限/工具回喂时自动续期，宿主执行工具期间暂停计时。 */
  promptTimeoutMs?: number
  /** 并发 MCP tools/call 聚合窗口（毫秒）。 */
  bridgeParkSettleMs?: number
  /** 出网代理地址（如 http://127.0.0.1:7890）；留空继承宿主代理，宿主未配置时直连。 */
  proxyUrl?: string
  /** 跨进程恢复 ACP 会话（`session/resume`）。 */
  resumeSessions?: boolean
  /** 用户取消后等待 agent 确认停止的上限（毫秒）；0 表示立即回收。 */
  cancelGraceMs?: number
  /** 空闲 ACP 进程保留时长（毫秒）；超时回收，下次按 `session/resume` 接回。0 表示不回收。 */
  idleRecycleMs?: number
  /** 允许额度取数调用本机 agy CLI（默认关闭）。开启后仅走 `agy -p /usage` 与 `/credits`，未找到 CLI 时明确报错。 */
  cliQuotaEnabled?: boolean
}

export const LIVE_SETTING_KEYS = [
  'hiddenModels',
  'agentMode',
  'agyCliPath',
  'proxyUrl',
  'resumeSessions',
  'cancelGraceMs',
  'idleRecycleMs',
  'cliQuotaEnabled',
] as const

export type LiveSettingKey = (typeof LIVE_SETTING_KEYS)[number]

export type AntigravityPluginConfig = Omit<AntigravityHostConfig, LiveSettingKey> & {
  [K in LiveSettingKey]?: AntigravityHostConfig[K] | Volatile<AntigravityHostConfig[K]>
}

function readSetting<T>(value: T | Volatile<T>): T {
  if (value !== null && typeof value === 'object' && 'get' in value && typeof (value as Volatile<T>).get === 'function') {
    return (value as Volatile<T>).get() as T
  }
  return value as T
}

/** 把含 Volatile 的插件配置包装为每次读取都取最新值的普通只读视图。 */
export function liveHostConfig(config: AntigravityPluginConfig): AntigravityHostConfig {
  return {
    ...config,
    get hiddenModels() { return readSetting(config.hiddenModels) },
    get agentMode() { return readSetting(config.agentMode) },
    get agyCliPath() { return readSetting(config.agyCliPath) },
    get proxyUrl() { return readSetting(config.proxyUrl) },
    get resumeSessions() { return readSetting(config.resumeSessions) },
    get cancelGraceMs() { return readSetting(config.cancelGraceMs) },
    get idleRecycleMs() { return readSetting(config.idleRecycleMs) },
    get cliQuotaEnabled() { return readSetting(config.cliQuotaEnabled) },
  }
}

export const Config = Schema.object({
  hiddenModels: Schema.array(Schema.string()).default([]).volatile().description('不出现在 DSH 模型选择器中的模型 ID 列表'),
  agentMode: Schema.string().volatile().description('会话模式（agent 声明的 mode id，如 plan）；留空沿用默认，只影响新建或恢复的会话'),
  agyCliPath: Schema.string().volatile().description('官方 agy CLI 路径；留空依次查 AGY_CLI_BIN、PATH 和默认安装目录'),
  binaryPath: Schema.string().description('官方 agy-acp-server 可执行文件路径；留空按 AGY_ACP_BIN → 缓存目录解析，找不到直接报错'),
  extraArgs: Schema.array(Schema.string()).default([]).description('传给 ACP server 的额外命令行参数'),
  acpVersion: Schema.string().default(DEFAULT_ACP_SERVER_VERSION).description('期望的 ACP server 版本；用于匹配缓存目录与目录缓存'),
  requestTimeoutMs: Schema.natural().default(30_000).description('单个 ACP 请求默认超时（毫秒）'),
  handshakeTimeoutMs: Schema.natural().min(1000).default(120_000).description('initialize 握手等待上限（毫秒）'),
  authTimeoutMs: Schema.natural().default(300_000).description('authenticate 等待上限（毫秒）'),
  promptTimeoutMs: Schema.natural().default(1_800_000).description('session/prompt 无活动超时上限（毫秒）；流式进展与工具往返自动续期，宿主执行工具期间暂停计时'),
  bridgeParkSettleMs: Schema.natural().default(50).description('并发 MCP tools/call 的聚合窗口（毫秒）'),
  proxyUrl: Schema.string().volatile().description('出网代理地址（如 http://127.0.0.1:7890）；留空继承宿主代理'),
  resumeSessions: Schema.boolean().default(true).volatile().description('重启后用 session/resume 接回原 ACP 会话'),
  cancelGraceMs: Schema.natural().max(60_000).default(30_000).volatile().description('取消后等待 agent 确认停止的上限（毫秒）；0 表示立即回收'),
  idleRecycleMs: Schema.natural().max(3_600_000).default(900_000).volatile().description('空闲 ACP 进程保留时长（毫秒）；默认 15 分钟后回收，0 表示不回收'),
  cliQuotaEnabled: Schema.boolean().default(false).volatile().description('允许额度取数调用本机 agy CLI（默认关闭）。开启后运行 agy -p /usage 与 /credits，找不到 CLI 时明确报错'),
})
