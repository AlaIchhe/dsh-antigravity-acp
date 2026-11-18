/**
 * 插件配置接口与 schemastery Schema。
 * schema 写法对准已安装 @deepseek-ai/schemastery 3.18.x 的实际导出。
 */
import Schema from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import { DEFAULT_ACP_SERVER_VERSION } from './runtime/binary.js'

/** 单个模型目录条目上的用户设置；键是 DSH 模型选择器里的模型 ID。 */
export interface ModelOverride {
  /** 是否出现在 DSH 模型选择器；省略等同启用。停用不删除目录条目，仍可被会话请求。 */
  enabled?: boolean
  /** 显示名覆盖；省略用官方目录名称。 */
  name?: string
  /** 映射到官方模型 ID，原样写入 ACP 会话，优先于家族 + 档位路由。 */
  target?: string
}

export interface AntigravityHostConfig {
  /** Maximum independent ACP workers, started on demand. */
  maxConcurrentSessions?: number
  /** Maximum wait for an available worker. */
  queueTimeoutMs?: number
  /** 会话模式：agent 声明的 mode id（官方 1.5.10：default / accept-edits / auto / plan）。空串沿用默认。 */
  agentMode?: string
  /** Explicit official CLI path, re-detected for manual reads. */
  agyCliPath?: string
  /** 插件启用时提前启动 ACP 连接并保留给聊天使用；不发送模型消息。 */
  /** 官方 agy-acp-server 可执行文件路径；优先级高于 AGY_ACP_BIN 与自动下载。 */
  binaryPath?: string
  /** 未找到本地二进制时是否自动从 dl.google.com 下载（默认 true）。 */
  /** 传给 ACP server 的额外命令行参数。 */
  extraArgs?: string[]
  /** 自动下载的目标版本（默认 1.4.0）。 */
  acpVersion?: string
  /** 单个 ACP 请求默认超时（毫秒）。 */
  requestTimeoutMs?: number
  /** initialize 握手等待上限（毫秒）；官方进程冷启动可达 1 分钟。 */
  handshakeTimeoutMs?: number
  /**
   * authenticate（oauth-personal，需人工在浏览器完成授权）的等待上限（毫秒）。
   * 独立于 requestTimeoutMs，默认 5 分钟。
   */
  authTimeoutMs?: number
  /** 单轮 session/prompt 的等待上限（毫秒）；ACP 回合可能很长，默认 30 分钟。 */
  promptTimeoutMs?: number
  /** 并发 MCP tools/call 的聚合窗口（毫秒），决定同一轮携带多少 tool-call block。 */
  bridgeParkSettleMs?: number
  /**
   * 按模型 ID 的目录设置：是否出现在 DSH 模型选择器、显示名与官方模型 ID 映射。
   * 思考强度不在配置里：它是模型的元数据，由 ACP agent 的 `thought_level`
   * 独立选项声明（旧 agent 才退回「档位编进模型 id」的目录推断）。
   * 只作用于目录中已存在的条目，不新增自造模型。
   */
  modelOverrides?: Record<string, ModelOverride>
  /**
   * 官方进程出网代理（如 http://127.0.0.1:7890）。留空继承宿主代理，宿主未配置才直连；
   * 填入后同时注入大小写两套 *_PROXY 与 NO_PROXY。
   */
  proxyUrl?: string
  /**
   * 代理排除列表（逗号分隔）。localhost/127.0.0.1/::1 始终自动排除，
   * 因为私有 MCP 桥与 OAuth 回调都在 loopback 上。
   */
  proxyBypass?: string
  /**
   * 复用同一个 ACP 会话：同一 DSH 对话的后续回合只发送新增消息，不再每轮
   * `session/new` 并重放全部历史。历史被压缩/回退、模型或工具目录变化时
   * 仍会受控重建。关闭后回到「每轮新会话 + 全量重放」的旧行为。
   */
  reuseSessions?: boolean
  /**
   * 跨进程恢复 ACP 会话：插件/宿主重启后，若上次留下会话映射，尝试用
   * `session/load` 恢复该对话而不是从零重建。依赖 agent 的 `loadSession`
   * 能力；agent 侧历史可能与 DSH 当前历史不一致，失败时自动回退重建。
   */
  resumeSessions?: boolean
  /**
   * 用户取消（停止按钮）后是否保留官方进程：默认关闭（立即回收，下一轮冷启动）。
   * 开启后先等 `cancelGraceMs` 让 agent 确认停止；确认了就只丢弃会话、保留进程。
   */
  keepProcessAfterCancel?: boolean
  /** 取消后的确认宽限（毫秒）；0 表示不等待、立即回收。 */
  cancelGraceMs?: number
  /** 保留进程的最长空闲时间（毫秒），超时回收；0 表示不设上限。 */
  idleRecycleMs?: number
  /**
   * 是否允许额度取数调用本机官方 agy CLI（默认关闭）。
   * 关闭时不 spawn agy：套餐额度走 Cloud Code Assist HTTP（读该账号 HOME 下
   * 的 CLI 登录态），AI Credits 不查询。
   * 开启后运行 `agy -p /usage` 与 `agy -p /credits`；未找到 CLI 时套餐额度
   * 回落 HTTP，AI Credits 报 `cli-unavailable`。
   */
  cliQuotaEnabled?: boolean
}

// Only fields owned by the custom settings card are live. Ordinary launch/pool
// configuration remains ordinary, so editing it still follows the host lifecycle.
export const LIVE_SETTING_KEYS = ['agentMode', 'reuseSessions', 'modelOverrides', 'proxyUrl', 'proxyBypass', 'agyCliPath', 'resumeSessions', 'keepProcessAfterCancel', 'cancelGraceMs', 'idleRecycleMs', 'cliQuotaEnabled'] as const
export type LiveSettingKey = typeof LIVE_SETTING_KEYS[number]
export type AntigravityPluginConfig = Omit<AntigravityHostConfig, LiveSettingKey> & {
  [K in LiveSettingKey]?: AntigravityHostConfig[K] | Volatile<AntigravityHostConfig[K]>
}

function readSetting(value: string | Volatile<string | undefined> | undefined): string | undefined
function readSetting(value: boolean | Volatile<boolean | undefined> | undefined): boolean | undefined
function readSetting(value: number | Volatile<number | undefined> | undefined): number | undefined
function readSetting(value: Record<string, ModelOverride> | Volatile<Record<string, ModelOverride> | undefined> | undefined): Record<string, ModelOverride> | undefined
function readSetting(value: string | boolean | number | Record<string, ModelOverride> | Volatile<string | boolean | number | Record<string, ModelOverride> | undefined> | undefined): string | boolean | number | Record<string, ModelOverride> | undefined {
  return typeof value === 'object' && value !== null && 'get' in value ? (value as Volatile<unknown>).get() as Record<string, ModelOverride> : value as string | boolean | number | Record<string, ModelOverride> | undefined
}

/** Keep references live; callers may spread this view to capture one operation. */
export function liveHostConfig(config: AntigravityPluginConfig): AntigravityHostConfig {
  return {
    ...config,
    get reuseSessions() { return readSetting(config.reuseSessions) },
    get modelOverrides() { return readSetting(config.modelOverrides) },
    get proxyUrl() { return readSetting(config.proxyUrl) },
    get proxyBypass() { return readSetting(config.proxyBypass) },
    get agentMode() { return readSetting(config.agentMode) },
    get agyCliPath() { return readSetting(config.agyCliPath) },
    get resumeSessions() { return readSetting(config.resumeSessions) },
    get keepProcessAfterCancel() { return readSetting(config.keepProcessAfterCancel) },
    get cancelGraceMs() { return readSetting(config.cancelGraceMs) },
    get idleRecycleMs() { return readSetting(config.idleRecycleMs) },
    get cliQuotaEnabled() { return readSetting(config.cliQuotaEnabled) },
  }
}

/**
 * modelOverrides 的 schema。
 *
 * TS2742 规避：`Schema.dict` 的推断类型引用 schemastery 依赖的 cosmokit
 * `Dict`；npm ci 在版本分叉时会把 cosmokit 嵌套进
 * `@deepseek-ai/schemastery/node_modules`，导出类型无法命名该路径（本机
 * 扁平提升才看不出来）。末尾的显式标注把 Config 的类型收敛到本包
 * `ModelOverride`，只经过可移植路径。
 */
const ModelOverrideSchema = Schema.object({
  enabled: Schema.boolean().default(true).description('是否出现在 DSH 模型选择器'),
  name: Schema.string().description('显示名覆盖'),
  target: Schema.string().description('映射到的官方模型 ID，优先于家族 + 档位路由'),
})

export const Config = Schema.object({
  maxConcurrentSessions: Schema.natural().min(1).max(4).default(2).description('最大并发 ACP 连接数（1–4），按需启动；不同对话互不占用工具审批回合'),
  queueTimeoutMs: Schema.natural().min(1000).default(120000).description('等待空闲 ACP 连接的最长时间（毫秒），排队期间可取消'),
  agentMode: Schema.string().volatile().description('会话模式（agent 声明的 mode id，如 plan）；留空沿用 agent 默认，只影响新建或恢复的会话'),
  agyCliPath: Schema.string().volatile().description('官方 agy CLI 路径；留空依次查 AGY_CLI_BIN、PATH 和默认安装目录'),
  binaryPath: Schema.string().description('官方 agy-acp-server 可执行文件路径；留空则按 AGY_ACP_BIN → 缓存 → 自动下载解析'),
  extraArgs: Schema.array(Schema.string()).default([]).description('传给 ACP server 的额外命令行参数'),
  acpVersion: Schema.string().default(DEFAULT_ACP_SERVER_VERSION).description('自动下载的 ACP server 版本'),
  requestTimeoutMs: Schema.natural().default(30_000).description('单个 ACP 请求默认超时（毫秒）'),
  handshakeTimeoutMs: Schema.natural().min(1000).default(120_000).description('initialize 握手等待上限（毫秒）；官方进程冷启动（解压、杀软扫描）可能超过 1 分钟'),
  authTimeoutMs: Schema.natural().default(300_000).description('authenticate（需人工在浏览器完成 OAuth 授权）的等待上限（毫秒）'),
  promptTimeoutMs: Schema.natural().default(1_800_000).description('单轮 session/prompt 的等待上限（毫秒）'),
  bridgeParkSettleMs: Schema.natural().default(50).description('并发 MCP tools/call 的聚合窗口（毫秒）'),
  modelOverrides: Schema.dict(ModelOverrideSchema).default({}).volatile().description('按模型 ID 的目录设置（是否显示、显示名、官方模型 ID 映射）；只作用于目录中已存在的模型') as Schema<
    Record<string, ModelOverride>,
    Record<string, ModelOverride>,
    'volatile-defined'
  >,
  proxyUrl: Schema.string().volatile().description('官方进程出网代理，如 http://127.0.0.1:7890（缺 scheme 按 http 处理）。留空继承宿主代理，宿主也未配置时才直连'),
  proxyBypass: Schema.string().volatile().description('代理排除列表，逗号分隔，如 example.internal,*.internal；不支持 CIDR。localhost/127.0.0.1/::1 始终自动排除'),
  reuseSessions: Schema.boolean().default(true).volatile().description('复用同一个 ACP 会话，后续回合只发送新增消息；历史被压缩/回退或模型、工具目录变化时自动重建。关闭则每轮新会话并重放全部历史'),
  resumeSessions: Schema.boolean().default(true).volatile().description('重启后用 session/resume 接上原 ACP 会话（唯一延续路径）；关掉它等于禁止历史会话跨进程继续'),
  keepProcessAfterCancel: Schema.boolean().default(false).volatile().description('用户取消后保留官方进程：宽限内确认 agent 已停止就只丢弃会话，下一轮不必冷启动；默认关闭'),
  cancelGraceMs: Schema.natural().max(60_000).default(30_000).volatile().description('取消后等待 agent 确认停止的上限（毫秒）；0 表示不等待、立即回收'),
  idleRecycleMs: Schema.natural().max(3_600_000).default(0).volatile().description('保留进程的最长空闲时间（毫秒），超时回收；默认 0 表示不回收。池上限就是 maxConcurrentSessions，常驻内存有界；回收的代价是下一轮冷启动并重放整段历史'),
  cliQuotaEnabled: Schema.boolean().default(false).volatile().description('允许额度取数调用本机 agy CLI（默认关闭）。关闭时不启动 agy，套餐额度走内置直连，AI Credits 不查询。开启后运行 agy -p /usage 与 agy -p /credits；未找到 CLI 时套餐额度回落直连'),
})
