/**
 * 真机 adapter 夹具（v1.0 方案 A）：把真实 `AntigravityAcpAdapter` 接到真实 `agy acp`。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { AgentLink, AGY_CLIENT_INFO, agentStreamFromSubprocess } from '../../src/protocol/agent-link.js'
import type { AgentLink as AgentLinkType, AgentLinkHandlers } from '../../src/protocol/agent-link.js'
import { AntigravityAcpAdapter } from '../../src/session/adapter.js'
import { CatalogStore } from '../../src/session/catalog-store.js'
import { createFileSessionStore } from '../../src/session/session-store.js'

export const REAL_ADAPTER_BIN = process.env.AGY_ACP_BIN ?? '/root/.local/bin/agy'

function handleFor(child: ChildProcess): SubprocessHandle {
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    control: undefined,
    collected: {},
    done: new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal } as never))),
    terminate: () => { child.kill('SIGTERM') },
    waitForExit: async () => {
      if (child.exitCode !== null) return true
      child.kill('SIGKILL')
      await new Promise((resolve) => child.once('exit', resolve))
      return true
    },
  } as unknown as SubprocessHandle
}

export interface RealAdapterLogLine { level: 'info' | 'warn'; message: string }

export interface RealAdapter {
  adapter: AntigravityAcpAdapter
  logs: RealAdapterLogLine[]
  links: AgentLinkType[]
  cacheDir: string
  dispose(): Promise<void>
}

export async function createRealAdapter(
  options: { cwd?: string; cacheDir?: string; resumeSessions?: boolean; cancelGraceMs?: number; parkSettleMs?: number; promptTimeoutMs?: number } = {},
): Promise<RealAdapter> {
  const logs: RealAdapterLogLine[] = []
  const links: AgentLinkType[] = []
  const cacheDir = options.cacheDir ?? await fs.mkdtemp(join(tmpdir(), 'agy-real-'))
  const store = createFileSessionStore(cacheDir, () => undefined)
  const catalog = new CatalogStore({ cacheDir, acpVersion: '1.4.0' })
  const children: ChildProcess[] = []
  const runtimeDir = await fs.mkdtemp(join(tmpdir(), 'agy-run-'))

  let activeLink: AgentLinkType | undefined
  const getLink = async (handlers: AgentLinkHandlers, signal?: AbortSignal): Promise<AgentLinkType> => {
    signal?.throwIfAborted()
    if (activeLink && !activeLink.closed) return activeLink
    const child = spawn(REAL_ADAPTER_BIN, ['acp', '--dangerously-skip-permissions'], {
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...process.env,
        PATH: `/root/.local/bin:${process.env.PATH ?? ''}`,
        TEMP: runtimeDir,
        TMP: runtimeDir,
        TMPDIR: runtimeDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.push(child)
    child.stderr?.resume()
    const link = new AgentLink({
      stream: agentStreamFromSubprocess(handleFor(child)),
      clientInfo: AGY_CLIENT_INFO,
      requestTimeoutMs: 120_000,
      handshakeTimeoutMs: 120_000,
      authTimeoutMs: 300_000,
      handlers,
    })
    links.push(link)
    link.start()
    await link.initialize({ clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
    const tokenPath = join(process.env.HOME ?? '', '.gemini', 'antigravity-acp', 'acp_token.json')
    const ready = await fs.access(tokenPath).then(() => true, () => false)
    if (!ready) await link.authenticate()
    activeLink = link
    return link
  }

  const adapter = new AntigravityAcpAdapter({
    catalog,
    getLink,
    recycleLink: async (link) => {
      if (activeLink === link) activeLink = undefined
      await link.close().catch(() => undefined)
    },
    sessionStore: store,
    cwd: options.cwd ?? process.cwd(),
    readSettings: () => ({
      resumeSessions: options.resumeSessions ?? true,
      cancelGraceMs: options.cancelGraceMs ?? 5_000,
      idleRecycleMs: 0,
      ...(options.parkSettleMs === undefined ? {} : { bridgeParkSettleMs: options.parkSettleMs }),
      ...(options.promptTimeoutMs === undefined ? {} : { promptTimeoutMs: options.promptTimeoutMs }),
    }),
    log: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message, error) => logs.push({
        level: 'warn',
        message: `${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ''}`,
      }),
    },
  })

  return {
    adapter,
    logs,
    links,
    cacheDir,
    async dispose() {
      await adapter.dispose().catch(() => undefined)
      for (const child of children) child.kill('SIGKILL')
      await store.close().catch(() => undefined)
    },
  }
}
