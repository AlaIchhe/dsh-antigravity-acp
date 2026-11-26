/**
 * 使用 rolldown 将 `src/client/index.tsx` 打包成 DSH `window.__ModuleLoader__.load` 单文件 `dist/client.js`。
 * 外部化 `react`（由宿主 shell 提供），并静态断言产物中不包含任何 Node 原生模块导入。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'src', 'client', 'index.tsx')
const outFile = join(root, 'dist', 'client.js')

const bundle = await rolldown({
  input: entry,
  external: ['react'],
  platform: 'browser',
  transform: {
    jsx: { runtime: 'classic' },
  },
})

const { output } = await bundle.generate({
  format: 'cjs',
  exports: 'auto',
})
await bundle.close()

const chunk = output.find((item) => item.type === 'chunk')
if (!chunk) throw new Error('rolldown 未生成客户端代码产物')

if (/require\(["']node:/.test(chunk.code)) {
  throw new Error('客户端产物禁止引用 Node 原生模块（node:*）')
}

const wrapped = [
  '/* Generated from src/client/index.tsx via scripts/build-client.mjs */',
  'window.__ModuleLoader__.load({',
  "  id: 'dsh-bundle-antigravity-acp',",
  '  factory: (require) => {',
  '    const exports = {};',
  '    const module = { exports };',
  chunk.code,
  '    return module.exports && module.exports.__esModule ? module.exports.default : module.exports;',
  '  },',
  '});',
  '',
].join('\n')

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, wrapped, 'utf8')
console.log(`Built ${outFile} (${Buffer.byteLength(wrapped, 'utf8')} bytes)`)
