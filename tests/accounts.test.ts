import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountsManager } from '../src/accounts/manager.js'
import { OAUTH_TOKEN_URL, OAUTH_USERINFO_URL } from '../src/accounts/oauth.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function tempBase(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agy-accounts-'))
  roots.push(dir)
  return dir
}

/** 轮询到登录流程进入目标阶段（真实 loopback + 微任务需要等）。 */
async function waitPhase(manager: AccountsManager, phase: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (manager.snapshot().auth.phase === phase) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timeout waiting for auth phase ${phase}, got ${manager.snapshot().auth.phase}`)
}

function fakeFetch(): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input)
    if (url === OAUTH_TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url === OAUTH_USERINFO_URL) {
      return new Response(JSON.stringify({ email: 'second@example.com' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
}

describe('AccountsManager', () => {
  it('系统账号恒在、默认被选中，且不能删除', async () => {
    const baseDir = await tempBase()
    const manager = new AccountsManager({ baseDir, homeDir: await tempBase() })
    const snapshot = manager.snapshot()
    expect(snapshot.accounts.map((row) => row.id)).toEqual(['primary'])
    expect(snapshot.activeAccountId).toBe('primary')
    expect(snapshot.accounts[0]).toMatchObject({ system: true, active: true, ready: false })
    await expect(manager.handle({ action: 'remove', id: 'primary' })).rejects.toThrow('系统账号不能删除')
    await manager.dispose()
  })

  it('面板登录：回调完成换码、写 token、创建隔离账号并自动成为当前账号', async () => {
    const baseDir = await tempBase()
    const homeDir = await tempBase()
    const writeCredentials = vi.fn(async (_input: { home: string; client: { clientId: string; clientSecret: string }; tokens: { accessToken: string } }) => undefined)
    const manager = new AccountsManager({
      baseDir,
      homeDir,
      fetchImpl: fakeFetch(),
      loginPort: 0,
      resolveClient: async () => ({ clientId: 'client-id', clientSecret: 'client-secret' }),
      writeCredentials,
      openBrowser: async () => true,
    })
    await manager.handle({ action: 'add-account' })
    await waitPhase(manager, 'waiting')
    const authUrl = new URL(manager.snapshot().auth.authUrl as string)
    const state = authUrl.searchParams.get('state') as string
    const redirect = new URL(authUrl.searchParams.get('redirect_uri') as string)
    const callback = await fetch(`http://127.0.0.1:${redirect.port}/oauth-callback?code=auth-code&state=${state}`)
    expect(callback.status).toBe(200)
    await waitPhase(manager, 'done')
    const snapshot = manager.snapshot()
    const created = snapshot.accounts.find((row) => !row.system)
    expect(created).toMatchObject({ alias: '账号 2', email: 'second@example.com', ready: true, active: true })
    expect(snapshot.activeAccountId).toBe(created!.id)
    expect(writeCredentials).toHaveBeenCalledTimes(1)
    expect(writeCredentials.mock.calls[0]?.[0]).toMatchObject({ home: join(baseDir, created!.id) })
    const tokenFile = join(baseDir, created!.id, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    expect(existsSync(tokenFile)).toBe(true)
    const token = JSON.parse(await readFile(tokenFile, 'utf8')) as { token: { refresh_token: string } }
    expect(token.token.refresh_token).toBe('refresh-1')
    const file = JSON.parse(await readFile(join(baseDir, 'accounts.json'), 'utf8')) as { activeAccountId: string }
    expect(file.activeAccountId).toBe(created!.id)
    await manager.dispose()
  })

  it('state 不匹配的回调不消耗流程，取消后清理暂存目录', async () => {
    const baseDir = await tempBase()
    const manager = new AccountsManager({
      baseDir, homeDir: await tempBase(), fetchImpl: fakeFetch(), loginPort: 0,
      resolveClient: async () => ({ clientId: 'c', clientSecret: 's' }),
      writeCredentials: async () => undefined,
      openBrowser: async () => false,
    })
    await manager.handle({ action: 'add-account' })
    await waitPhase(manager, 'waiting')
    const authUrl = new URL(manager.snapshot().auth.authUrl as string)
    const redirect = new URL(authUrl.searchParams.get('redirect_uri') as string)
    const bad = await fetch(`http://127.0.0.1:${redirect.port}/oauth-callback?code=x&state=wrong`)
    expect(bad.status).toBe(400)
    expect(manager.snapshot().auth.phase).toBe('waiting')
    await manager.handle({ action: 'cancel-add' })
    expect(manager.snapshot().auth.phase).toBe('cancelled')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(manager.snapshot().accounts).toHaveLength(1)
    await manager.dispose()
  })

  it('切换与删除账号：删除当前账号回落到系统账号，跨目录记录被拒绝', async () => {
    const baseDir = await tempBase()
    const homeDir = await tempBase()
    const dirA = join(baseDir, 'acc_a')
    const dirB = join(baseDir, 'acc_b')
    for (const dir of [dirA, dirB]) await mkdir(join(dir, '.gemini', 'antigravity-cli'), { recursive: true })
    await writeFile(join(baseDir, 'accounts.json'), JSON.stringify({
      version: 1,
      activeAccountId: 'acc_a',
      accounts: [
        { id: 'acc_a', alias: 'A', dir: dirA, createdAt: 1 },
        { id: 'acc_b', alias: 'B', dir: dirB, createdAt: 2 },
        { id: 'acc_bad', alias: 'Bad', dir: join(homeDir, 'outside'), createdAt: 3 },
      ],
    }))
    const manager = new AccountsManager({ baseDir, homeDir })
    const ids = manager.snapshot().accounts.map((row) => row.id)
    expect(ids).toEqual(['primary', 'acc_a', 'acc_b'])
    expect(manager.active()).toMatchObject({ id: 'acc_a', dir: dirA })
    await manager.handle({ action: 'activate', id: 'acc_b' })
    expect(manager.active()).toMatchObject({ id: 'acc_b', dir: dirB })
    await manager.handle({ action: 'remove', id: 'acc_b' })
    expect(manager.active().id).toBe('primary')
    expect(existsSync(dirB)).toBe(false)
    expect(existsSync(dirA)).toBe(true)
    await manager.dispose()
  })

  it('保存时保留其它 Host 新增的账号，不把共享文件覆盖回旧列表', async () => {
    const baseDir = await tempBase()
    const homeDir = await tempBase()
    const dir = join(baseDir, 'acc_local')
    await mkdir(join(dir, '.gemini', 'antigravity-cli'), { recursive: true })
    await writeFile(join(baseDir, 'accounts.json'), JSON.stringify({
      version: 1, accounts: [{ id: 'acc_local', alias: 'Local', dir, createdAt: 1 }],
    }))
    const manager = new AccountsManager({ baseDir, homeDir })
    // 另一个 Host 在两次保存之间新增了账号。
    await writeFile(join(baseDir, 'accounts.json'), JSON.stringify({
      version: 1,
      accounts: [
        { id: 'acc_local', alias: 'Local', dir, createdAt: 1 },
        { id: 'acc_foreign', alias: 'Foreign', dir: join(baseDir, 'acc_foreign'), createdAt: 2 },
      ],
    }))
    await manager.handle({ action: 'activate', id: 'acc_local' })
    const saved = JSON.parse(await readFile(join(baseDir, 'accounts.json'), 'utf8')) as { accounts: Array<{ id: string }> }
    expect(saved.accounts.map((row) => row.id).sort()).toEqual(['acc_foreign', 'acc_local'])
    await manager.dispose()
  })

  it('系统账号不允许通过面板重新登录（官方 CLI 登录文件保持只读）', async () => {
    const manager = new AccountsManager({ baseDir: await tempBase(), homeDir: await tempBase() })
    await expect(manager.handle({ action: 'relogin', id: 'primary' })).rejects.toThrow('系统账号')
    await manager.dispose()
  })
})

// isolatedHomeEnv 的行为集中在 tests/isolated-home.test.ts（含「不碰 DBUS」的回归用例）。

describe('额度按账号隔离', () => {
  it('每个账号用各自 HOME 取数并按账号缓存，互不覆盖', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const { AgYQuotaService, AGY_QUOTA_SERVICE } = await import('../src/quota/quota-remote.js')
    const homes: Record<string, string> = { primary: '/h/primary', acc_a: '/h/a', acc_b: '/h/b' }
    const accounts = {
      active: () => ({ id: 'primary', home: homes.primary }),
      resolve: (id?: string) => (id && homes[id] ? { id, home: homes[id] } : undefined),
    }
    const requests: Array<{ argv: readonly string[]; homeDir?: string }> = []
    const run = async (request: { argv: readonly string[]; homeDir?: string }) => {
      requests.push(request)
      if (request.argv.includes('/credits')) {
        return { exitCode: 0, stdout: JSON.stringify({ status: 'SUCCESS', command: { name: 'credits', data: { remaining_credits: 5 } } }), stderr: '' }
      }
      return {
        exitCode: 0, stderr: '',
        stdout: JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets: [{ name: '5h', window: '5h', remaining_fraction: 0.5 }] }] } } }),
      }
    }
    const ctx = new Context()
    ctx.plugin(AgYQuotaService, {
      accounts: accounts as never,
      cli: { run: run as never, cliPath: '/fake/agy' },
      cliQuotaEnabled: () => true,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const service = ctx.get(AGY_QUOTA_SERVICE) as InstanceType<typeof AgYQuotaService>
    const a = await service.read({ accountId: 'acc_a', force: true })
    expect(a.status).toBe('ok')
    expect(requests.map((request) => request.homeDir).sort()).toEqual(['/h/a', '/h/a'])
    await service.read({ accountId: 'acc_b', force: true })
    expect(requests.filter((request) => request.homeDir === '/h/b')).toHaveLength(2)
    const before = requests.length
    await service.read({ accountId: 'acc_a' })
    expect(requests.length).toBe(before)
    await service.read()
    expect(requests.slice(before).every((request) => request.homeDir === '/h/primary')).toBe(true)
  })
})

describe('面板登录写入 ACP 凭据', () => {
  it('直接按登录 client 写 acp_token.json 与 settings.json，不依赖官方二进制', async () => {
    const home = await tempBase()
    const { writeAcpCredentialFiles } = await import('../src/runtime/credentials.js')
    await writeAcpCredentialFiles(home, { clientId: 'client-id', clientSecret: 'client-secret' }, {
      accessToken: 'access-1', refreshToken: 'refresh-1', expiry: '2026-11-17T16:00:00.000+08:00',
    })
    const token = JSON.parse(await readFile(join(home, '.gemini', 'antigravity-acp', 'acp_token.json'), 'utf8')) as Record<string, unknown>
    expect(token).toMatchObject({
      client_id: 'client-id', client_secret: 'client-secret', refresh_token: 'refresh-1',
      token: 'access-1', expiry: '2026-11-17T16:00:00.000+08:00',
    })
    const settings = JSON.parse(await readFile(join(home, '.gemini', 'antigravity-acp', 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(settings).toEqual({ auth: { type: 'oauth-personal' } })
  })
})
