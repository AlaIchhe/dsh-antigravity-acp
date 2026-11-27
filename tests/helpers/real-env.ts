/**
 * 真实本机凭据与官方 `agy` 二进制测试辅助（绝不硬编码任何 token 或账号 ID）。
 *
 * 原则：
 * - 动态发现本机已安装的 `agy` CLI 与已有登录态（系统账号 `~/.gemini` 与 `~/.antigravity-acp-accounts`）；
 * - 严格只读用户真实凭据与真实账号目录，绝不修改或删除用户的真实文件；
 * - 本机有真实二进制与凭据时默认启用实机测试；无凭据环境（如 GitHub Actions CI）自动 skip，
 *   除非显式设置 `AGY_REAL_ACP=1`（强制运行）。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { resolveAccountsDir } from '../../src/accounts/paths.js'
import { loadAccountsFile } from '../../src/accounts/store.js'
import { ACP_HOME_SUBPATH, ACP_TOKEN_FILENAME, CLI_TOKEN_SUBPATH } from '../../src/auth/token-store.js'
import { agyCliCandidates } from '../../src/runtime/agy-cli.js'
import { createLiveProxiedFetch, resolveHttpsProxy } from '../../src/runtime/proxy.js'
import type { ManagedFetch } from '../../src/runtime/proxy.js'

export interface RealAccountProbe {
  id: string
  alias: string
  home: string
  dir?: string
  system: boolean
  hasCliToken: boolean
  hasAcpToken: boolean
}

export function findRealAgyBin(): string | undefined {
  const candidates = [
    process.env.AGY_ACP_BIN?.trim(),
    process.env.AGY_CLI_BIN?.trim(),
    ...agyCliCandidates(process.env, homedir()),
  ].filter((item): item is string => Boolean(item))
  return candidates.find((candidate) => existsSync(candidate))
}

export function discoverRealAccounts(): RealAccountProbe[] {
  const sysHome = homedir()
  const accounts: RealAccountProbe[] = [
    {
      id: 'primary',
      alias: '主账号（系统登录）',
      home: sysHome,
      system: true,
      hasCliToken: existsSync(join(sysHome, ...CLI_TOKEN_SUBPATH)),
      hasAcpToken: existsSync(join(sysHome, ...ACP_HOME_SUBPATH, ACP_TOKEN_FILENAME)),
    },
  ]
  try {
    const file = loadAccountsFile(resolveAccountsDir())
    for (const row of file.accounts) {
      if (!row.dir || !existsSync(row.dir)) continue
      accounts.push({
        id: row.id,
        alias: row.alias,
        home: row.dir,
        dir: row.dir,
        system: false,
        hasCliToken: existsSync(join(row.dir, ...CLI_TOKEN_SUBPATH)),
        hasAcpToken: existsSync(join(row.dir, ...ACP_HOME_SUBPATH, ACP_TOKEN_FILENAME)),
      })
    }
  } catch {
    // 无多账号文件时仅返回系统账号。
  }
  return accounts
}

export const REAL_AGY_BIN = findRealAgyBin()
export const REAL_ACCOUNTS = discoverRealAccounts()
export const REAL_READY_ACCOUNTS = REAL_ACCOUNTS.filter((a) => a.hasCliToken || a.hasAcpToken)
export const REAL_CLI_TOKEN_ACCOUNTS = REAL_ACCOUNTS.filter((a) => a.hasCliToken)

/**
 * 本机具备真实二进制与真实凭据时默认运行实机测试；
 * CI 环境无凭据自动跳过，`AGY_REAL_ACP=0` 可显式关闭，`AGY_REAL_ACP=1` 强制开启。
 */
export const REAL_TESTS_ENABLED = process.env.AGY_REAL_ACP === '0'
  ? false
  : process.env.AGY_REAL_ACP === '1'
    ? true
    : process.env.CI !== 'true' && REAL_AGY_BIN !== undefined && REAL_READY_ACCOUNTS.length > 0

export function createRealProxiedFetch(): ManagedFetch {
  return createLiveProxiedFetch(() => resolveHttpsProxy(undefined))
}

/** 用真实的 `node:child_process.spawn` 适配 DSH `SubprocessRuntime`（供实机测试驱动真实 `AcpRuntimeManager` 与 `agy` CLI）。 */
export function createRealSubprocessRuntime(): { runtime: SubprocessRuntime; killAll(): void } {
  const children = new Set<ChildProcess>()
  const runtime: SubprocessRuntime = {
    spawn(options: Parameters<SubprocessRuntime['spawn']>[0]) {
      const [cmd, ...args] = options.argv
      const stdioMode = options.stdio ?? {}
      const child = spawn(String(cmd), args.map(String), {
        cwd: options.cwd,
        env: options.env as NodeJS.ProcessEnv | undefined,
        stdio: [
          stdioMode.stdin === 'pipe' ? 'pipe' : 'ignore',
          stdioMode.stdout ? 'pipe' : 'ignore',
          stdioMode.stderr ? 'pipe' : 'ignore',
        ],
      })
      children.add(child)

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      const collectStdout = stdioMode.stdout && typeof stdioMode.stdout === 'object'
      const collectStderr = stdioMode.stderr && typeof stdioMode.stderr === 'object'
      if (collectStdout && child.stdout) {
        child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(Buffer.from(chunk)))
      }
      if (collectStderr && child.stderr) {
        child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)))
      }

      const onAbort = () => {
        if (child.exitCode === null) child.kill('SIGTERM')
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('exit', (code, sig) => {
          children.delete(child)
          options.signal?.removeEventListener('abort', onAbort)
          resolve({ exitCode: code, signal: sig })
        })
        child.once('error', () => {
          children.delete(child)
          options.signal?.removeEventListener('abort', onAbort)
          resolve({ exitCode: -1, signal: null })
        })
      })

      const makeBuffer = (chunks: Buffer[]) => ({
        readFrom(offset = 0) {
          const text = Buffer.concat(chunks).toString('utf8')
          return { text: text.slice(offset), nextOffset: text.length, truncated: false }
        },
      })

      const handle: SubprocessHandle = {
        stdin: stdioMode.stdin === 'pipe' ? child.stdin : null,
        stdout: stdioMode.stdout === 'pipe' ? child.stdout : null,
        stderr: stdioMode.stderr === 'pipe' ? child.stderr : null,
        control: undefined,
        collected: {
          ...(collectStdout ? { stdout: makeBuffer(stdoutChunks) } : {}),
          ...(collectStderr ? { stderr: makeBuffer(stderrChunks) } : {}),
        },
        done,
        terminate: () => {
          if (child.exitCode === null) child.kill('SIGTERM')
        },
        waitForExit: async (waitSignal?: AbortSignal) => {
          if (child.exitCode !== null) return true
          return new Promise<boolean>((resolve) => {
            const onExit = () => {
              waitSignal?.removeEventListener('abort', onWaitAbort)
              resolve(true)
            }
            const onWaitAbort = () => {
              child.removeListener('exit', onExit)
              if (child.exitCode === null) child.kill('SIGKILL')
              resolve(false)
            }
            child.once('exit', onExit)
            waitSignal?.addEventListener('abort', onWaitAbort, { once: true })
          })
        },
      } as unknown as SubprocessHandle
      return handle
    },
  } as unknown as SubprocessRuntime

  return {
    runtime,
    killAll() {
      for (const child of children) {
        if (child.exitCode === null) child.kill('SIGKILL')
      }
      children.clear()
    },
  }
}
