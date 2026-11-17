import { describe, expect, it, beforeEach } from 'vitest'
import { detectSystemProxy, resetSystemProxyCache } from '../src/runtime/system-proxy.js'

const noRun = () => {
  throw new Error('should not run')
}

describe('detectSystemProxy', () => {
  beforeEach(() => resetSystemProxyCache())

  it('环境变量优先，且 HTTPS 先于 HTTP/ALL', () => {
    expect(detectSystemProxy({
      platform: 'linux',
      env: { HTTP_PROXY: 'http://http:1', HTTPS_PROXY: 'http://https:2', ALL_PROXY: 'socks5://all:3' },
      run: noRun,
    })).toBe('http://https:2')
    resetSystemProxyCache()
    expect(detectSystemProxy({
      platform: 'linux',
      env: { ALL_PROXY: 'socks5://all:3' },
      run: noRun,
    })).toBe('socks5://all:3')
  })

  it('Windows 注册表读取 ProxyEnable / ProxyServer', () => {
    const raw = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7890
`
    expect(detectSystemProxy({
      platform: 'win32', env: {}, run: () => raw,
    })).toBe('http://127.0.0.1:7890')
  })

  it('Windows ProxyEnable=0 时不使用代理', () => {
    const raw = 'ProxyEnable    REG_DWORD    0x0\nProxyServer    REG_SZ    127.0.0.1:7890\n'
    expect(detectSystemProxy({ platform: 'win32', env: {}, run: () => raw })).toBeUndefined()
  })

  it('macOS scutil 读取 HTTPS / HTTP / SOCKS', () => {
    const raw = `
<dictionary> {
  HTTPSEnable : 1
  HTTPSProxy : 127.0.0.1
  HTTPSPort : 7890
  HTTPEnable : 0
}`
    expect(detectSystemProxy({ platform: 'darwin', env: {}, run: () => raw })).toBe('http://127.0.0.1:7890')
  })

  it('Linux GNOME manual 代理', () => {
    const values: Record<string, string> = {
      'org.gnome.system.proxy mode': "'manual'",
      'org.gnome.system.proxy.https host': "'127.0.0.1'",
      'org.gnome.system.proxy.https port': '7890',
    }
    expect(detectSystemProxy({
      platform: 'linux',
      env: {},
      run: (command, args) => {
        expect(command).toBe('gsettings')
        return values[args.slice(1).join(' ')] ?? ''
      },
    })).toBe('http://127.0.0.1:7890')
  })

  it('Linux GNOME none 或命令缺失时返回 undefined', () => {
    expect(detectSystemProxy({
      platform: 'linux', env: {}, run: () => "'none'",
    })).toBeUndefined()
    resetSystemProxyCache()
    expect(detectSystemProxy({
      platform: 'linux', env: {}, run: () => { throw new Error('no gsettings') },
    })).toBeUndefined()
  })

  it('非法代理字符串被忽略', () => {
    expect(detectSystemProxy({
      platform: 'linux', env: { HTTPS_PROXY: 'http://' }, run: noRun,
    })).toBeUndefined()
  })
})
