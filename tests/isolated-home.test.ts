/**
 * 账号 HOME 隔离：系统账号必须保留真实 keyring 访问权。
 *
 * 回归背景（2026-11-22）：`isolatedHomeEnv()` 对**所有**账号都掐掉 DBUS，系统账号
 * 也一样。官方 CLI 因此读不到 gnome-keyring 里的登录态，刷新 token 后写 keyring
 * 失败、降级写文件时只落 `{"token": null}`，下一次启动就报
 * `session/resume ... Authentication required`，整个对话报废。
 */
import { describe, expect, it } from 'vitest'
import { isolatedHomeEnv } from '../src/runtime/isolated-home.js'

const REAL_HOME = '/root'

describe('isolatedHomeEnv', () => {
  it('系统账号保留真实 DBUS：否则官方 CLI 读不到也写不进 keyring', () => {
    const env = isolatedHomeEnv(REAL_HOME, 'linux', REAL_HOME)
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
    // HOME 仍如实设置为该账号的 home。
    expect(env.HOME).toBe(REAL_HOME)
    expect(env.GEMINI_CLI_HOME).toBe('/root/.gemini')
  })

  it('隔离账号阻断 keyring：避免读到主账号 token', () => {
    const env = isolatedHomeEnv('/root/.dsh/agy-accounts/acc_1', 'linux', REAL_HOME)
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/root/.dsh/agy-accounts/acc_1/.no-dbus-session')
    expect(env.HOME).toBe('/root/.dsh/agy-accounts/acc_1')
  })

  it('尾部斜杠不影响系统账号判定', () => {
    expect(isolatedHomeEnv('/root/', 'linux', REAL_HOME).DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
    expect(isolatedHomeEnv(REAL_HOME, 'linux', '/root/').DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
  })

  it('Windows 上系统账号同样不改 USERPROFILE 语义', () => {
    const env = isolatedHomeEnv('C:\\Users\\me', 'win32', 'C:\\Users\\me')
    expect(env.USERPROFILE).toBe('C:\\Users\\me')
    // Windows 分支本来就不碰 DBUS。
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
  })

  it('Windows 隔离账号仍改写 USERPROFILE / HOMEDRIVE / HOMEPATH', () => {
    const env = isolatedHomeEnv('D:\\accounts\\a1', 'win32', 'C:\\Users\\me')
    expect(env.USERPROFILE).toBe('D:\\accounts\\a1')
    expect(env.HOMEDRIVE).toBe('D:')
    expect(env.HOMEPATH).toBe('\\accounts\\a1')
  })

  it('Windows 判等忽略大小写', () => {
    const env = isolatedHomeEnv('c:\\users\\ME', 'win32', 'C:\\Users\\me')
    // 判为同一个 home：不阻断（Windows 分支无 DBUS），但 HOME 仍是传入值。
    expect(env.HOME).toBe('c:\\users\\ME')
  })
})
