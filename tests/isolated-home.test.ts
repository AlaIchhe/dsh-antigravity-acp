/**
 * 账号 HOME 隔离：只靠 HOME 系列变量，不碰 DBUS。
 *
 * 回归背景（2026-11-22）：这里曾经把 `DBUS_SESSION_BUS_ADDRESS` 指到账号目录里
 * 一个不存在的路径，想阻止官方 CLI 读到主账号 token。实测证明它既无效（隔离本来
 * 就靠 HOME 生效）又有害（官方 CLI 自己的 keyring 降级链被绕过，单次调用多花 8
 * 秒，并制造出「keyring 可读、文件写不进」的空壳 token）。这些用例锁住「不碰
 * DBUS」这件事，避免它被重新加回来。
 */
import { describe, expect, it } from 'vitest'
import { isolatedHomeEnv } from '../src/runtime/isolated-home.js'

const REAL_HOME = '/root'

describe('isolatedHomeEnv', () => {
  it('系统账号：HOME 如实设置为真实 HOME', () => {
    const env = isolatedHomeEnv(REAL_HOME, 'linux')
    expect(env.HOME).toBe(REAL_HOME)
    expect(env.GEMINI_CLI_HOME).toBe('/root/.gemini')
    expect(env.ANTIGRAVITY_GEMINI_DIR).toBe('/root/.gemini')
    expect(env.ANTIGRAVITY_APP_DATA_DIR).toBe('/root/.gemini/antigravity-cli')
  })

  it('隔离账号：HOME 切到账号目录，官方 CLI 按它定位自己的 .gemini', () => {
    const env = isolatedHomeEnv('/root/.dsh/agy-accounts/acc_1', 'linux')
    expect(env.HOME).toBe('/root/.dsh/agy-accounts/acc_1')
    expect(env.GEMINI_CLI_HOME).toBe('/root/.dsh/agy-accounts/acc_1/.gemini')
    expect(env.ANTIGRAVITY_APP_DATA_DIR).toBe('/root/.dsh/agy-accounts/acc_1/.gemini/antigravity-cli')
  })

  it('任何平台都不改写 DBUS：这是官方 CLI 自己的事', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      for (const home of [REAL_HOME, '/root/.dsh/agy-accounts/acc_1', '/root/', 'D:\\accounts\\a1']) {
        expect(isolatedHomeEnv(home, platform).DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
      }
    }
  })

  it('Windows 上改写 USERPROFILE / HOMEDRIVE / HOMEPATH（libuv 只认这些）', () => {
    const env = isolatedHomeEnv('D:\\accounts\\a1', 'win32')
    expect(env.USERPROFILE).toBe('D:\\accounts\\a1')
    expect(env.HOMEDRIVE).toBe('D:')
    expect(env.HOMEPATH).toBe('\\accounts\\a1')
  })

  it('Windows 上 HOME 与 GEMINI_CLI_HOME 也一并设置', () => {
    const env = isolatedHomeEnv('C:\\Users\\me', 'win32')
    expect(env.HOME).toBe('C:\\Users\\me')
    expect(env.GEMINI_CLI_HOME).toContain('.gemini')
  })
})
