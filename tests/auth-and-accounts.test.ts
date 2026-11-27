/**
 * 认证与多账号域测试：零 mock fetch。
 * - 纯函数部分（PKCE、授权 URL、手动回调校验、目录包含性）离线验证；
 * - 凭据导入与 Cloud Code Assist 额度取数使用本机真实凭据直连 Google 端点（严格只读用户真实文件）；
 * - AccountsManager 使用临时目录 + 真实 loopback 回调服务器验证完整生命周期。
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildAuthorizeUrl,
  generatePkce,
  parseManualCallback,
  resolveOAuthClient,
} from '../src/auth/oauth-client.js'
import {
  CLI_TOKEN_SUBPATH,
  ensureAcpCredentials,
  isTokenUsable,
  parseTokenState,
} from '../src/auth/token-store.js'
import { fetchQuotaSnapshot, parseQuotaSummary } from '../src/auth/code-assist.js'
import { isContainedDir, loadAccountsFile, saveAccountsFile } from '../src/accounts/store.js'
import { AccountsManager } from '../src/accounts/manager.js'
import { SYSTEM_ACCOUNT_ID } from '../src/accounts/types.js'
import {
  createRealProxiedFetch,
  REAL_CLI_TOKEN_ACCOUNTS,
  REAL_TESTS_ENABLED,
} from './helpers/real-env.js'

const dirs: string[] = []
function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('auth & accounts domain (pure invariants)', () => {
  it('oauth-client generates PKCE, resolves client without binary scan, and validates manual callbacks', () => {
    const pkce = generatePkce()
    expect(pkce.verifier.length).toBeGreaterThan(20)
    expect(pkce.challenge.length).toBeGreaterThan(20)

    const envClient = resolveOAuthClient({ AGY_OAUTH_CLIENT_ID: 'cid', AGY_OAUTH_CLIENT_SECRET: 'csec' })
    expect(envClient).toEqual({ clientId: 'cid', clientSecret: 'csec' })
    const defaultClient = resolveOAuthClient({})
    expect(defaultClient.clientId.length).toBeGreaterThan(5)

    const url = buildAuthorizeUrl({ clientId: 'cid', challenge: pkce.challenge, state: 'st123' })
    expect(url).toContain('code_challenge_method=S256')
    expect(url).not.toContain('openid')

    expect(parseManualCallback('http://localhost:51121/oauth-callback?code=abc&state=st123', 'st123')).toEqual({ ok: true, code: 'abc' })
    expect(parseManualCallback('http://localhost:51121/oauth-callback?code=abc&state=wrong', 'st123').ok).toBe(false)
    expect(parseManualCallback('http://localhost:51121/oauth-callback?error=access_denied', 'st123').ok).toBe(false)

    expect(isTokenUsable(parseTokenState({ access_token: 'tok', expiry: new Date(Date.now() + 300_000).toISOString() }))).toBe(true)
    expect(isTokenUsable(parseTokenState({ access_token: 'tok', expiry: new Date(Date.now() - 1_000).toISOString() }))).toBe(false)
    expect(parseQuotaSummary({}).length).toBe(0)
  })

  it('accounts store enforces directory containment and real loopback OAuth listener starts & cancels cleanly', async () => {
    const baseDir = makeTemp('agy-accounts-')
    const sysHome = makeTemp('agy-syshome-')

    expect(isContainedDir(baseDir, join(baseDir, 'acc_1'))).toBe(true)
    expect(isContainedDir(baseDir, join(baseDir, '..', 'escape'))).toBe(false)

    const disposableDir = join(baseDir, 'acc_disposable')
    mkdirSync(disposableDir, { recursive: true })
    saveAccountsFile(baseDir, {
      version: 1,
      accounts: [{ id: 'acc_disposable', alias: 'Disposable', dir: disposableDir, createdAt: 1 }],
    })
    expect(loadAccountsFile(baseDir).accounts).toHaveLength(1)

    const manager = new AccountsManager({
      baseDir,
      homeDir: sysHome,
      loginPort: 0,
      openBrowser: async () => false,
    })
    try {
      const started = await manager.startLogin({ mode: 'add', alias: 'Work' })
      expect(started.snapshot.auth.phase).toBe('waiting')
      const authUrl = new URL(started.snapshot.auth.authUrl!)
      expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')
      expect(authUrl.searchParams.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+\/oauth-callback$/)

      // 真实 loopback HTTP 服务器响应非法 state 拒绝
      const badResp = await fetch(`${authUrl.searchParams.get('redirect_uri')}?code=x&state=wrong`)
      expect(badResp.status).toBe(400)

      // 取消登录释放端口
      const cancelled = await manager.cancelLogin()
      expect(cancelled.snapshot.auth.phase).toBe('cancelled')

      // 切换与删除临时账号，系统账号受保护
      manager.activate('acc_disposable')
      expect(manager.active().id).toBe('acc_disposable')
      await manager.remove('acc_disposable')
      expect(manager.active().id).toBe(SYSTEM_ACCOUNT_ID)
      await expect(manager.remove(SYSTEM_ACCOUNT_ID)).rejects.toThrow('系统账号不可删除')
    } finally {
      await manager.dispose()
    }
  })
})

describe.skipIf(!REAL_TESTS_ENABLED || REAL_CLI_TOKEN_ACCOUNTS.length === 0)('auth & accounts domain (real credentials)', () => {
  it('token-store imports real CLI token read-only and exchanges a fresh access token with Google OAuth', async () => {
    const sourceAccount = REAL_CLI_TOKEN_ACCOUNTS[0]!
    const srcCliFile = join(sourceAccount.home, ...CLI_TOKEN_SUBPATH)
    const tempHome = makeTemp('agy-real-home-')
    const copiedCliFile = join(tempHome, ...CLI_TOKEN_SUBPATH)
    mkdirSync(dirname(copiedCliFile), { recursive: true })
    copyFileSync(srcCliFile, copiedCliFile)
    const beforeCli = readFileSync(copiedCliFile, 'utf8')

    const realFetch = createRealProxiedFetch()
    try {
      const res = await ensureAcpCredentials({ homeDir: tempHome, fetchImpl: realFetch })
      expect(res.ready, `ensureAcpCredentials failed: ${res.note ?? ''}`).toBe(true)
      expect(res.status).toBe('imported')
      // CLI 原始文件严格只读、未被修改
      expect(readFileSync(copiedCliFile, 'utf8')).toBe(beforeCli)
      const acpToken = JSON.parse(readFileSync(res.tokenPath, 'utf8')) as { token?: string; refresh_token?: string }
      expect(typeof acpToken.token).toBe('string')
      expect(acpToken.token!.length).toBeGreaterThan(20)
      expect(typeof acpToken.refresh_token).toBe('string')
    } finally {
      await realFetch.close()
    }
  }, 60_000)

  it('code-assist fetches real quota summary from Cloud Code Assist for every logged-in account', async () => {
    const realFetch = createRealProxiedFetch()
    try {
      for (const account of REAL_CLI_TOKEN_ACCOUNTS) {
        const snap = await fetchQuotaSnapshot({
          homedir: () => account.home,
          fetchImpl: realFetch,
        })
        expect(snap.status, `账号 ${account.id} 取数失败: ${snap.error?.message ?? ''}`).toBe('ok')
        expect(snap.groups.length).toBeGreaterThan(0)
        const totalBuckets = snap.groups.reduce((sum, g) => sum + g.buckets.length, 0)
        expect(totalBuckets).toBeGreaterThan(0)
      }
    } finally {
      await realFetch.close()
    }
  }, 60_000)
})
