import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  writeCliTokenFile,
} from '../src/auth/token-store.js'
import { fetchQuotaSnapshot, parseQuotaSummary } from '../src/auth/code-assist.js'
import { isContainedDir, loadAccountsFile, saveAccountsFile } from '../src/accounts/store.js'
import { AccountsManager } from '../src/accounts/manager.js'
import { SYSTEM_ACCOUNT_ID } from '../src/accounts/types.js'

const dirs: string[] = []
function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('auth & accounts domain', () => {
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
  })

  it('token-store imports CLI token read-only and prepares acp_token.json + settings.json', async () => {
    const home = makeTemp('agy-home-')
    await writeCliTokenFile(home, { accessToken: 'old-access', refreshToken: 'ref-1', expiresAt: 1_000 })
    const cliPath = join(home, ...CLI_TOKEN_SUBPATH)
    const beforeCli = readFileSync(cliPath, 'utf8')

    expect(isTokenUsable(parseTokenState({ access_token: 'tok', expiry: new Date(Date.now() + 300_000).toISOString() }))).toBe(true)
    expect(isTokenUsable(parseTokenState({ access_token: 'tok', expiry: new Date(Date.now() - 1_000).toISOString() }))).toBe(false)

    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'fresh-access',
      expires_in: 3600,
    }), { status: 200 }))

    const res = await ensureAcpCredentials({ homeDir: home, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(res.ready).toBe(true)
    expect(res.status).toBe('imported')
    // CLI 文件严格只读、未被修改
    expect(readFileSync(cliPath, 'utf8')).toBe(beforeCli)
    const acpToken = JSON.parse(readFileSync(res.tokenPath, 'utf8'))
    expect(acpToken.token).toBe('fresh-access')
    expect(acpToken.refresh_token).toBe('ref-1')
  })

  it('code-assist fetches quota summary and retries once after 401 refresh', async () => {
    const home = makeTemp('agy-quota-')
    await writeCliTokenFile(home, {
      accessToken: 'stale-access',
      refreshToken: 'ref-quota',
      expiresAt: Date.now() + 600_000,
    })

    let calls = 0
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      calls += 1
      if (url.includes(':loadCodeAssist') && calls === 1) {
        return new Response('unauthorized', { status: 401 })
      }
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'refreshed-access', expires_in: 3600 }), { status: 200 })
      }
      if (url.includes(':loadCodeAssist')) {
        return new Response(JSON.stringify({
          cloudaicompanionProject: 'proj-1',
          paidTier: { name: 'Google AI Pro' },
        }), { status: 200 })
      }
      if (url.includes(':retrieveUserQuotaSummary')) {
        return new Response(JSON.stringify({
          groups: [{ displayName: 'Gemini Models', buckets: [{ displayName: '5h', window: '5h', remainingFraction: 0.85, disabled: false }] }],
        }), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })

    const snap = await fetchQuotaSnapshot({
      homedir: () => home,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(snap.status).toBe('ok')
    expect(snap.plan).toBe('Google AI Pro')
    expect(snap.groups[0]?.buckets[0]?.remainingPct).toBe(85)
    expect(parseQuotaSummary({}).length).toBe(0)
  })

  it('accounts store rejects escaped dirs and AccountsManager completes manual OAuth login lifecycle', async () => {
    const baseDir = makeTemp('agy-accounts-')
    const sysHome = makeTemp('agy-syshome-')

    expect(isContainedDir(baseDir, join(baseDir, 'acc_1'))).toBe(true)
    expect(isContainedDir(baseDir, join(baseDir, '..', 'escape'))).toBe(false)

    saveAccountsFile(baseDir, {
      version: 1,
      accounts: [{ id: 'acc_good', alias: 'Good', dir: join(baseDir, 'acc_good'), createdAt: 1 }],
    })
    expect(loadAccountsFile(baseDir).accounts).toHaveLength(1)

    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'tok-new', refresh_token: 'ref-new', expires_in: 3600 }), { status: 200 })
      }
      return new Response(JSON.stringify({ email: 'alice@example.com' }), { status: 200 })
    })

    const manager = new AccountsManager({
      baseDir,
      homeDir: sysHome,
      loginPort: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openBrowser: async () => false,
    })
    try {
      const started = await manager.startLogin({ mode: 'add', alias: 'Work' })
      expect(started.snapshot.auth.phase).toBe('waiting')
      const authUrl = new URL(started.snapshot.auth.authUrl!)
      const state = authUrl.searchParams.get('state')!
      const redirectUri = authUrl.searchParams.get('redirect_uri')!

      manager.submitCallback(`${redirectUri}?code=test-code&state=${state}`)
      // 等异步换码落地
      await vi.waitFor(() => {
        expect(manager.snapshot().auth.phase).toBe('done')
      })

      const snap = manager.snapshot()
      const added = snap.accounts.find((a) => a.alias === 'Work')
      expect(added).toBeDefined()
      expect(added?.email).toBe('alice@example.com')
      expect(added?.ready).toBe(true)
      // 系统账号无登录态时，新账号自动成为当前账号
      expect(snap.activeAccountId).toBe(added?.id)

      manager.activate(SYSTEM_ACCOUNT_ID)
      expect(manager.active().id).toBe(SYSTEM_ACCOUNT_ID)

      await manager.remove(added!.id)
      expect(manager.snapshot().accounts.some((a) => a.id === added?.id)).toBe(false)
      await expect(manager.remove(SYSTEM_ACCOUNT_ID)).rejects.toThrow('系统账号不可删除')
    } finally {
      await manager.dispose()
    }
  })
})
