/**
 * Web Client 国际化支持：接入宿主 `ctx.get('locale')` 服务并内置完整中英文词典。
 * 宿主未提供 locale 服务（如独立单元测试）时默认回退中文词典。
 */
import React from 'react'

export const CLIENT_LOCALE_NS = 'dsh-bundle-antigravity-acp'

export interface ClientLocaleServiceLike {
  getLocale?(): { active?: string; revision?: number }
  getSnapshot?(): { active?: string; revision?: number }
  subscribe?(fn: () => void): () => void
  register?(ns: string, locale: string, dict: Record<string, string>): () => void
  bind?(ns: string): (key: string, params?: Record<string, string | number>) => string
}

export const CLIENT_LOCALE_ZH: Record<string, string> = {
  'settings.label': 'Antigravity ACP',
  'settings.tablist': 'Antigravity 设置分页',
  'settings.tab.account': '账号',
  'settings.tab.models': '模型',
  'settings.tab.advanced': '连接与高级',
  'settings.noDescribe': '宿主未提供 settings.describe，无法编辑插件设置',
  'settings.saving': '保存中…',
  'settings.saved': '已保存；进行中的会话不受影响。',
  'settings.saveModels': '保存模型列表',
  'settings.saveAdvanced': '保存高级配置',
  'settings.discard': '放弃修改',
  'settings.readonly': '当前配置只读或未找到插件配置条目，无法在线保存。',

  'accounts.newAliasPlaceholder': '新账号备注名（可选）',
  'accounts.addLogin': '新增账号登录',
  'accounts.installCli': '安装官方 CLI',
  'accounts.installingCli': '安装中…',
  'accounts.installingCliNotice': '正在下载并校验官方 agy CLI…',
  'accounts.retry': '重试',
  'accounts.authInProgress': '进行中的授权流程',
  'accounts.waitingAuth': '等待完成 Google 授权…',
  'accounts.cancelLogin': '取消登录',
  'accounts.copyAuthUrl': '复制授权链接',
  'accounts.copied': '已复制',
  'accounts.copyFailed': '复制失败，请手动选中',
  'accounts.openAuthPage': '打开 Google 授权页面',
  'accounts.callbackPlaceholder': '无头主机：粘贴浏览器跳转后的完整回调地址（http://localhost:51121/oauth-callback?...）',
  'accounts.submitCallback': '提交回调',
  'accounts.activeTag': '当前使用',
  'accounts.readyTag': '已登录',
  'accounts.notReadyTag': '未登录',
  'accounts.useAccount': '使用此账号',
  'accounts.relogin': '重新登录',
  'accounts.delete': '删除',
  'accounts.confirmDelete': '确认删除',
  'accounts.loginSuccess': '登录成功',
  'accounts.loginFailed': '登录失败',
  'accounts.planPrefix': '套餐：',
  'accounts.planQuota': '套餐额度',
  'accounts.refreshQuota': '刷新额度',
  'accounts.refreshing': '刷新中…',
  'accounts.notReadyQuotaHint': '未登录，完成登录后将自动读取额度',

  'models.hint': '点击模型切换是否在 DSH 模型选择器中显示',
  'models.refresh': '刷新模型目录',
  'models.refreshing': '刷新目录中…',
  'models.empty': '模型目录为空；请点击「刷新模型目录」或先发起一次对话。',
  'models.otherFamily': '其它',
  'models.notInCatalog': '不在当前目录',
  'models.allHiddenWarn': '全部隐藏后，Antigravity 将从模型选择器中消失。',
  'models.familyAriaSuffix': ' 模型',

  'advanced.hint': '以下配置支持热更新，保存后立即生效（无需重启 DSH）。',
  'advanced.proxyUrl.label': '出网代理地址',
  'advanced.proxyUrl.placeholder': 'http://127.0.0.1:7890（留空继承宿主代理）',
  'advanced.proxyUrl.desc': '支持 HTTP/HTTPS/SOCKS5；始终自动绕过 localhost / 127.0.0.1 / ::1。',
  'advanced.agentMode.label': '会话模式（agentMode）',
  'advanced.agentMode.placeholder': '留空沿用默认，如 auto / plan / accept-edits',
  'advanced.agentMode.desc': '仅作用于新建或恢复的 ACP 会话。',
  'advanced.agyCliPath.label': '官方 agy CLI 路径',
  'advanced.agyCliPath.placeholder': '留空依次查 AGY_CLI_BIN、PATH 和默认安装目录',
  'advanced.cliQuotaEnabled.label': '启用 CLI 额度取数（cliQuotaEnabled）',
  'advanced.cliQuotaEnabled.desc': '开启后改走 agy -p /usage 与 /credits（含 AI Credits）；未找到 CLI 时直接报错，不回落 HTTP。',
  'advanced.resumeSessions.label': '跨进程恢复会话（resumeSessions）',
  'advanced.resumeSessions.desc': '重启或空闲回收后通过 session/resume 接回原 ACP 会话。',
  'advanced.idleRecycleMs.label': '空闲回收时长（毫秒）',
  'advanced.idleRecycleMs.desc': '默认 900000（15 分钟），范围 0–3600000；0 表示不自动回收。',
  'advanced.cancelGraceMs.label': '取消宽限等待（毫秒）',
  'advanced.cancelGraceMs.desc': '默认 30000，范围 0–60000；0 表示取消后立即回收。',
  'advanced.invalidRange': '请输入合法范围内的整数值。',

  'quota.window5h': '5 小时',
  'quota.windowWeekly': '每周',
  'quota.windowDefault': '额度',
  'quota.resetSoon': '即将重置',
  'quota.resetMin': '{m} 分钟后重置',
  'quota.resetHourMin': '{h} 小时 {m} 分后重置',
  'quota.resetHour': '{h} 小时后重置',
  'quota.resetDayHour': '{d} 天 {h} 小时后重置',
  'quota.creditsAria': 'AI Credits 余额',
  'quota.creditsLabel': 'AI Credits 余额',
  'quota.loading': '正在读取…',
  'quota.loadingQuota': '正在读取额度…',
  'quota.queryFailed': '查询失败',
  'quota.notProvided': '未提供',
  'quota.noData': '未提供额度数据',
  'quota.disabled': '已停用',
  'quota.disabledWindow': '此窗口不可用',
  'quota.unknown': '未知',
  'quota.readFailed': '读取失败',
  'quota.reading': '读取中',
  'quota.otherGroup': '其他额度',
  'quota.popoverTitle': 'Antigravity 额度详情',
  'quota.refresh': '刷新',
  'quota.close': '关闭',
  'quota.remainingSuffix': '剩余额度',
}

export const CLIENT_LOCALE_EN: Record<string, string> = {
  'settings.label': 'Antigravity ACP',
  'settings.tablist': 'Antigravity settings tabs',
  'settings.tab.account': 'Accounts',
  'settings.tab.models': 'Models',
  'settings.tab.advanced': 'Connection & advanced',
  'settings.noDescribe': 'Host did not expose settings.describe; unable to edit plugin settings.',
  'settings.saving': 'Saving…',
  'settings.saved': 'Saved; active conversations are not affected.',
  'settings.saveModels': 'Save model list',
  'settings.saveAdvanced': 'Save advanced settings',
  'settings.discard': 'Discard changes',
  'settings.readonly': 'Settings are read-only or the plugin config entry was not found.',

  'accounts.newAliasPlaceholder': 'Account label (optional)',
  'accounts.addLogin': 'Add account',
  'accounts.installCli': 'Install agy CLI',
  'accounts.installingCli': 'Installing…',
  'accounts.installingCliNotice': 'Downloading and verifying official agy CLI…',
  'accounts.retry': 'Retry',
  'accounts.authInProgress': 'Active sign-in flow',
  'accounts.waitingAuth': 'Waiting for Google authorization…',
  'accounts.cancelLogin': 'Cancel sign-in',
  'accounts.copyAuthUrl': 'Copy auth URL',
  'accounts.copied': 'Copied',
  'accounts.copyFailed': 'Copy failed; select manually',
  'accounts.openAuthPage': 'Open Google authorization page',
  'accounts.callbackPlaceholder': 'Headless host: paste full callback URL (http://localhost:51121/oauth-callback?...)',
  'accounts.submitCallback': 'Submit callback',
  'accounts.activeTag': 'Active',
  'accounts.readyTag': 'Signed in',
  'accounts.notReadyTag': 'Not signed in',
  'accounts.useAccount': 'Use account',
  'accounts.relogin': 'Sign in again',
  'accounts.delete': 'Delete',
  'accounts.confirmDelete': 'Confirm delete',
  'accounts.loginSuccess': 'Sign-in complete',
  'accounts.loginFailed': 'Sign-in failed',
  'accounts.planPrefix': 'Plan: ',
  'accounts.planQuota': 'Plan quota',
  'accounts.refreshQuota': 'Refresh quota',
  'accounts.refreshing': 'Refreshing…',
  'accounts.notReadyQuotaHint': 'Not signed in yet; quota will load after sign-in.',

  'models.hint': 'Click a model to toggle visibility in the DSH model selector',
  'models.refresh': 'Refresh catalog',
  'models.refreshing': 'Refreshing…',
  'models.empty': 'Model catalog is empty; click "Refresh catalog" or start a conversation first.',
  'models.otherFamily': 'Other',
  'models.notInCatalog': 'Not in current catalog',
  'models.allHiddenWarn': 'Hiding all models removes Antigravity from the model selector.',
  'models.familyAriaSuffix': ' models',

  'advanced.hint': 'These settings hot-reload immediately on save without restarting DSH.',
  'advanced.proxyUrl.label': 'Outbound proxy URL',
  'advanced.proxyUrl.placeholder': 'http://127.0.0.1:7890 (empty inherits host proxy)',
  'advanced.proxyUrl.desc': 'Supports HTTP/HTTPS/SOCKS5; localhost / 127.0.0.1 / ::1 are always bypassed.',
  'advanced.agentMode.label': 'Session mode (agentMode)',
  'advanced.agentMode.placeholder': 'Empty uses default, e.g. auto / plan / accept-edits',
  'advanced.agentMode.desc': 'Applies to newly created or resumed ACP sessions only.',
  'advanced.agyCliPath.label': 'Official agy CLI path',
  'advanced.agyCliPath.placeholder': 'Empty checks AGY_CLI_BIN, PATH, and default install directories',
  'advanced.cliQuotaEnabled.label': 'Use agy CLI for quota (cliQuotaEnabled)',
  'advanced.cliQuotaEnabled.desc': 'Runs agy -p /usage and /credits (for AI Credits); errors if CLI is missing without HTTP fallback.',
  'advanced.resumeSessions.label': 'Resume sessions across restarts (resumeSessions)',
  'advanced.resumeSessions.desc': 'Reconnects prior ACP sessions via session/resume after restart or idle recycle.',
  'advanced.idleRecycleMs.label': 'Idle recycle timeout (ms)',
  'advanced.idleRecycleMs.desc': 'Default 900000 (15 min), range 0–3600000; 0 disables auto-recycle.',
  'advanced.cancelGraceMs.label': 'Cancel grace period (ms)',
  'advanced.cancelGraceMs.desc': 'Default 30000, range 0–60000; 0 recycles immediately on cancel.',
  'advanced.invalidRange': 'Enter an integer within the allowed range.',

  'quota.window5h': '5h',
  'quota.windowWeekly': 'Weekly',
  'quota.windowDefault': 'Quota',
  'quota.resetSoon': 'Resets soon',
  'quota.resetMin': 'Resets in {m}m',
  'quota.resetHourMin': 'Resets in {h}h {m}m',
  'quota.resetHour': 'Resets in {h}h',
  'quota.resetDayHour': 'Resets in {d}d {h}h',
  'quota.creditsAria': 'AI Credits balance',
  'quota.creditsLabel': 'AI Credits',
  'quota.loading': 'Loading…',
  'quota.loadingQuota': 'Loading quota…',
  'quota.queryFailed': 'Query failed',
  'quota.notProvided': 'Unavailable',
  'quota.noData': 'No quota data provided',
  'quota.disabled': 'Disabled',
  'quota.disabledWindow': 'Window unavailable',
  'quota.unknown': 'Unknown',
  'quota.readFailed': 'Failed',
  'quota.reading': 'Loading',
  'quota.otherGroup': 'Other quota',
  'quota.popoverTitle': 'Antigravity quota',
  'quota.refresh': 'Refresh',
  'quota.close': 'Close',
  'quota.remainingSuffix': ' remaining',
}

export type TranslateFn = (key: string, params?: Record<string, string | number>) => string

function formatTemplate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    params[name] === undefined ? `{${name}}` : String(params[name]),
  )
}

export function createStaticTranslator(lang: 'zh' | 'en' = 'zh'): TranslateFn {
  const dict = lang === 'en' ? CLIENT_LOCALE_EN : CLIENT_LOCALE_ZH
  return (key, params) => formatTemplate(dict[key] ?? CLIENT_LOCALE_ZH[key] ?? key, params)
}

export function registerClientLocales(locale: ClientLocaleServiceLike | undefined): () => void {
  if (!locale || typeof locale.register !== 'function') return () => undefined
  const disposers: Array<() => void> = []
  try {
    disposers.push(locale.register(CLIENT_LOCALE_NS, 'zh', CLIENT_LOCALE_ZH))
  } catch { /* 忽略重复或不支持的注册 */ }
  try {
    disposers.push(locale.register(CLIENT_LOCALE_NS, 'en', CLIENT_LOCALE_EN))
  } catch { /* 忽略重复或不支持的注册 */ }
  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* ignore */ }
    }
  }
}

function resolveLangFromService(locale: ClientLocaleServiceLike | undefined): 'zh' | 'en' {
  const active = locale?.getSnapshot?.()?.active ?? locale?.getLocale?.()?.active
  if (!active) return 'zh'
  return active.toLowerCase().startsWith('en') ? 'en' : 'zh'
}

export function useClientTranslator(locale?: ClientLocaleServiceLike): TranslateFn {
  const subscribe = React.useCallback(
    (onStoreChange: () => void) => (typeof locale?.subscribe === 'function' ? locale.subscribe(onStoreChange) : () => undefined),
    [locale],
  )
  const getSnapshot = React.useCallback(() => {
    const snap = locale?.getSnapshot?.() ?? locale?.getLocale?.()
    return `${snap?.active ?? 'zh'}:${snap?.revision ?? 0}`
  }, [locale])

  React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return React.useMemo(() => {
    const lang = resolveLangFromService(locale)
    const fallback = createStaticTranslator(lang)
    const bound = typeof locale?.bind === 'function' ? locale.bind(CLIENT_LOCALE_NS) : undefined
    return (key, params) => {
      if (bound) {
        try {
          const translated = bound(key, params)
          if (translated && translated !== key) return formatTemplate(translated, params)
        } catch {
          // 回退内置词典
        }
      }
      return fallback(key, params)
    }
  }, [locale, getSnapshot()])
}
