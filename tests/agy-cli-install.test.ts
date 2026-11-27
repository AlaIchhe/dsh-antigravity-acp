/**
 * 官方 CLI 一键安装测试：纯函数校验（平台、白名单、manifest、tar 提取）+ 实机访问官方 manifest 端点。
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGY_CLI_MANIFEST_BASE,
  assertAgyCliUrl,
  extractExecutableFromTar,
  installAgyCli,
  parseAgyCliManifest,
  resolveAgyCliTarget,
} from '../src/runtime/agy-cli-install.js'
import { createRealProxiedFetch, REAL_TESTS_ENABLED } from './helpers/real-env.js'

/** 造一个最小 ustar 归档，含一个名为 name 的普通文件。 */
function tarWith(name: string, body: Buffer): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 'utf8')
  header.write('0000644\0', 100, 'utf8')
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'utf8')
  header.write('0', 156, 'utf8')
  header.write('ustar\0', 257, 'utf8')
  header.write('00', 263, 'utf8')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8')
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512)
  return Buffer.concat([header, body, pad, Buffer.alloc(1024)])
}

describe('官方 CLI 一键安装', () => {
  it('平台识别与官方 install.sh 一致', () => {
    expect(resolveAgyCliTarget({ platform: 'linux', arch: 'x64' })).toEqual({ platform: 'linux_amd64', executable: 'agy' })
    expect(resolveAgyCliTarget({ platform: 'linux', arch: 'x64', isMusl: true }).platform).toBe('linux_amd64_musl')
    expect(resolveAgyCliTarget({ platform: 'linux', arch: 'arm64', isAndroid: true }).platform).toBe('android_arm64')
    expect(resolveAgyCliTarget({ platform: 'darwin', arch: 'arm64' }).platform).toBe('darwin_arm64')
    expect(() => resolveAgyCliTarget({ platform: 'linux', arch: 'ia32' })).toThrow(/64 位/)
    expect(() => resolveAgyCliTarget({ platform: 'win32', arch: 'x64' })).toThrow(/Windows/)
  })

  it('只接受白名单内的 https 地址', () => {
    expect(assertAgyCliUrl('https://storage.googleapis.com/a').hostname).toBe('storage.googleapis.com')
    expect(() => assertAgyCliUrl('https://evil.example.com/a')).toThrow(/白名单/)
    expect(() => assertAgyCliUrl('http://storage.googleapis.com/a')).toThrow(/https/)
    expect(() => assertAgyCliUrl('not-a-url')).toThrow()
  })

  it('manifest 缺字段或 sha512 形态不对一律拒绝', () => {
    expect(() => parseAgyCliManifest(undefined)).toThrow(/url|sha512/)
    expect(() => parseAgyCliManifest({ url: 'https://storage.googleapis.com/a' })).toThrow()
    expect(() => parseAgyCliManifest({ url: 'https://storage.googleapis.com/a', sha512: 'abc' })).toThrow()
    const ok = parseAgyCliManifest({ version: '1.2.3', url: 'https://storage.googleapis.com/a', sha512: 'a'.repeat(128) })
    expect(ok.version).toBe('1.2.3')
  })

  it('从 tar 里只取目标可执行文件', () => {
    const body = Buffer.from('#!/bin/sh\necho hi\n')
    const archive = tarWith('antigravity', body)
    expect(extractExecutableFromTar(archive, ['agy', 'antigravity']).toString()).toBe(body.toString())
    expect(() => extractExecutableFromTar(archive, ['agy'])).toThrow(/没有找到/)
  })

  it('目标文件已存在时直接跳过下载', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agy-exist-'))
    try {
      await writeFile(join(dir, 'agy'), '#!/bin/sh\n', { mode: 0o755 })
      const result = await installAgyCli({
        targetDir: dir,
        fetchImpl: (() => { throw new Error('不应触发网络下载') }) as unknown as typeof fetch,
        target: { platform: 'linux_amd64', executable: 'agy' },
      })
      expect(result.installed).toBe(false)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it.skipIf(!REAL_TESTS_ENABLED)('实机拉取官方 release manifest 并通过地址白名单与 sha512 校验', async () => {
    const realFetch = createRealProxiedFetch()
    try {
      const target = resolveAgyCliTarget()
      const resp = await realFetch(`${AGY_CLI_MANIFEST_BASE}/manifests/${target.platform}.json`, { redirect: 'error' })
      expect(resp.ok, `官方 manifest 返回 HTTP ${resp.status}`).toBe(true)
      const manifest = parseAgyCliManifest(await resp.json())
      expect(manifest.version.length).toBeGreaterThan(0)
      expect(manifest.sha512).toMatch(/^[a-f0-9]{128}$/)
      expect(assertAgyCliUrl(manifest.url).hostname).toBe('storage.googleapis.com')
    } finally {
      await realFetch.close()
    }
  }, 30_000)
})
