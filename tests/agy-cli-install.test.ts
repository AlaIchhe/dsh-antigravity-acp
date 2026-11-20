import { describe, expect, it, vi } from 'vitest'
import { gzipSync } from 'node:zlib'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  AGY_CLI_INSTALL_ERROR, assertAgyCliUrl, extractExecutableFromTar,
  installAgyCli, parseAgyCliManifest, resolveAgyCliTarget,
} from '../src/runtime/agy-cli-install.js'

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

  it('完整安装：manifest → 下载 → 校验 → 解包 → 落盘', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agy-inst-'))
    try {
      const binary = Buffer.from('#!/bin/sh\necho agy\n')
      const tgz = gzipSync(tarWith('antigravity', binary))
      const sha = createHash('sha512').update(tgz).digest('hex')
      const stages: string[] = []
      const fetchImpl = vi.fn(async (url: string | URL) => {
        const href = String(url)
        if (href.endsWith('/manifests/linux_amd64.json')) {
          return new Response(JSON.stringify({
            version: '1.5.13',
            url: 'https://storage.googleapis.com/antigravity-public/agy.tar.gz',
            sha512: sha,
          }), { status: 200 })
        }
        if (href.includes('storage.googleapis.com')) return new Response(tgz, { status: 200 })
        return new Response('nope', { status: 404 })
      })
      const result = await installAgyCli({
        targetDir: dir, fetchImpl: fetchImpl as unknown as typeof fetch,
        target: { platform: 'linux_amd64', executable: 'agy' },
        onStage: (stage) => stages.push(stage),
      })
      expect(result.installed).toBe(true)
      expect(result.version).toBe('1.5.13')
      expect(stages.length).toBeGreaterThan(2)
      const written = await readFile(result.path, 'utf8')
      expect(written).toBe(binary.toString())
      expect(((await stat(result.path)).mode & 0o111) !== 0).toBe(true)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('校验不符时中止，不落盘', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agy-bad-'))
    try {
      const tgz = gzipSync(tarWith('antigravity', Buffer.from('x')))
      const fetchImpl = async (url: string | URL) => String(url).endsWith('.json')
        ? new Response(JSON.stringify({ version: '1', url: 'https://storage.googleapis.com/a.tar.gz', sha512: 'b'.repeat(128) }), { status: 200 })
        : new Response(tgz, { status: 200 })
      await expect(installAgyCli({
        targetDir: dir, fetchImpl: fetchImpl as unknown as typeof fetch,
        target: { platform: 'linux_amd64', executable: 'agy' },
      })).rejects.toMatchObject({ code: AGY_CLI_INSTALL_ERROR.CHECKSUM_MISMATCH })
      await expect(stat(join(dir, 'agy'))).rejects.toThrow()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('已存在时跳过下载', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agy-exist-'))
    try {
      await writeFile(join(dir, 'agy'), 'old', { mode: 0o755 })
      const fetchImpl = vi.fn()
      const result = await installAgyCli({
        targetDir: dir, fetchImpl: fetchImpl as unknown as typeof fetch,
        target: { platform: 'linux_amd64', executable: 'agy' },
        exists: async (path) => path === join(dir, 'agy'),
      })
      expect(result.installed).toBe(false)
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('manifest 服务不可达时报可读错误', async () => {
    await expect(installAgyCli({
      targetDir: '/tmp/unused',
      fetchImpl: (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch,
      target: { platform: 'linux_amd64', executable: 'agy' },
      exists: async () => false,
    })).rejects.toMatchObject({ code: AGY_CLI_INSTALL_ERROR.MANIFEST_UNAVAILABLE })
  })
})
