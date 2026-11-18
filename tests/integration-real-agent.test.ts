/**
 * 真机集成测试：直接对官方 `agy acp` 讲话，不经过任何假 agent。
 *
 * 默认 **skip**（`npm test` 仍然离线、秒级）：只有设置 `AGY_REAL_ACP=1` 才跑。
 * 前提：本机有已登录的官方 CLI（`AGY_ACP_BIN` 或 PATH 里的 `agy`）、允许出网、
 * 并且接受每个用例消耗一点账号额度。
 *
 * 每个用例对应 docs/claims.md 的一条或多条断言；改插件里对应的行为前先跑这里。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { RealAcpClient, REAL_ACP_ENABLED, REAL_ACP_CWD } from './helpers/real-acp-client.js'

const MCP_FIXTURE = fileURLToPath(new URL('./fixtures/mcp-probe-server.mjs', import.meta.url))

const clients: RealAcpClient[] = []
function client(): RealAcpClient {
  const created = new RealAcpClient()
  clients.push(created)
  return created
}
afterAll(() => { for (const item of clients) item.close() })

describe.skipIf(!REAL_ACP_ENABLED)('真机 ACP 集成（AGY_REAL_ACP=1 才运行）', () => {
  it('initialize 声明 resume / list，并给出 agent 身份', async () => {
    const init = await client().initialize()
    expect(init.agentInfo?.name ?? '').toContain('Antigravity')
    expect(init.agentCapabilities?.sessionCapabilities?.resume).toBeDefined()
    expect(init.agentCapabilities?.sessionCapabilities?.list).toBeDefined()
  }, 60_000)

  it('新会话声明 model / thought_level / mode 选项，且档位与模式可设置', async () => {
    const target = client()
    await target.initialize()
    const session = await target.newSession()
    const options: Array<{ id?: string; category?: string; options?: Array<{ value?: string }> }> = session.configOptions ?? []
    const ids = options.map((option) => option.id ?? option.category)
    expect(ids).toContain('model')
    expect(ids).toContain('thought_level')
    const thought = options.find((option) => option.id === 'thought_level' || option.category === 'thought_level')
    expect((thought?.options ?? []).map((entry) => entry.value)).toEqual(expect.arrayContaining(['low', 'medium', 'high']))

    const modes = session.modes?.availableModes ?? []
    expect(modes.length).toBeGreaterThan(0)
    await expect(target.request('session/set_mode', { sessionId: session.sessionId, modeId: modes[0].id })).resolves.toBeTruthy()
  }, 120_000)

  it('同一会话的第二次 prompt 记得第一次的暗号（会话上下文保留）', async () => {
    const target = client()
    await target.initialize()
    const session = await target.newSession()
    await target.prompt(session.sessionId, '记住暗号 ZEBRA-731。只回两个字：记住')
    target.clearTexts()
    const second = await target.prompt(session.sessionId, '刚才的暗号是什么？只回暗号本身。')
    expect(second.stopReason).toBe('end_turn')
    expect(target.texts.join('')).toContain('ZEBRA-731')
  }, 180_000)

  it('取消返回 cancelled；确认前发新 prompt 会被 agent 拒绝', async () => {
    const target = client()
    await target.initialize()
    const session = await target.newSession()
    const running = target.prompt(session.sessionId, '用四十句话详细讲 TCP 拥塞控制，不要使用工具。')
    await new Promise((resolve) => setTimeout(resolve, 4000))
    target.notify('session/cancel', { sessionId: session.sessionId })
    const early = await target.prompt(session.sessionId, '只回两个字：好').then(() => 'accepted', (error: Error) => error.message)
    expect(early).toContain('wait for it to finish')
    expect((await running).stopReason).toBe('cancelled')
  }, 240_000)

  it('取消确认后同一会话可以继续，且仍在 session/list 里、可 resume', async () => {
    const target = client()
    await target.initialize()
    const session = await target.newSession()
    const running = target.prompt(session.sessionId, '用四十句话详细讲 TCP 拥塞控制，不要使用工具。')
    await new Promise((resolve) => setTimeout(resolve, 4000))
    target.notify('session/cancel', { sessionId: session.sessionId })
    expect((await running).stopReason).toBe('cancelled')

    const list = await target.request<{ sessions?: Array<{ sessionId: string }> }>('session/list', {}, 30_000)
    expect((list.sessions ?? []).some((entry) => entry.sessionId === session.sessionId)).toBe(true)
    const resumed = await target.request<{ sessionId?: string }>('session/resume', { sessionId: session.sessionId, cwd: REAL_ACP_CWD, mcpServers: [] }, 60_000)
    expect(resumed.sessionId).toBe(session.sessionId)
    expect((await target.prompt(session.sessionId, '只回两个字：好')).stopReason).toBe('end_turn')
  }, 240_000)

  it('session/close 之后仍能 resume 并继续对话', async () => {
    const target = client()
    await target.initialize()
    const session = await target.newSession()
    await target.prompt(session.sessionId, '只回两个字：收到')
    await target.request('session/close', { sessionId: session.sessionId }, 30_000)
    const resumed = await target.request<{ sessionId?: string }>('session/resume', { sessionId: session.sessionId, cwd: REAL_ACP_CWD, mcpServers: [] }, 60_000)
    expect(resumed.sessionId).toBe(session.sessionId)
    expect((await target.prompt(session.sessionId, '只回两个字：还活着')).stopReason).toBe('end_turn')
  }, 180_000)

  it('MCP 工具：agent 调用工具并在同一 prompt 内拿到结果继续（工具续轮）', async () => {
    const target = client()
    await target.initialize()
    const session = await target.newSession([{ type: 'stdio', name: 'probe', command: process.execPath, args: [MCP_FIXTURE] }])
    expect(session.sessionId).toBeTruthy()
    const result = await target.prompt(
      session.sessionId,
      '请调用名为 ping 的工具（参数 text="hello"），然后只回复工具返回的内容。不要使用其它工具。',
      240_000,
    )
    expect(result.stopReason).toBe('end_turn')
    expect(target.texts.join('')).toContain('pong:hello')
  }, 300_000)
})
