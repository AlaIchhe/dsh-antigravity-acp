/**
 * 浏览器 overlay Portal 适配：按需通过打包器注入的 `__optionalRequire` 加载宿主 `react-dom`，
 * 将 fixed 弹层 portal 到 `document.body`（避免被 composer 容器裁切），
 * 无 DOM / 单元测试环境下优雅回退为内联渲染。
 */
import type React from 'react'

type OptionalRequire = (id: string) => unknown
type CreatePortalFn = (children: React.ReactNode, container: Element) => React.ReactPortal

let optionalRequire: OptionalRequire | undefined
let resolvedCreatePortal: CreatePortalFn | null | undefined

export function setOptionalRequire(fn: OptionalRequire): void {
  optionalRequire = fn
  resolvedCreatePortal = undefined
}

function getCreatePortal(): CreatePortalFn | null {
  if (resolvedCreatePortal !== undefined) return resolvedCreatePortal
  if (typeof document === 'undefined' || !document.body) return null
  try {
    const mod = optionalRequire?.('react-dom') as { createPortal?: CreatePortalFn; default?: { createPortal?: CreatePortalFn } } | undefined
    const fn = mod?.createPortal ?? mod?.default?.createPortal
    resolvedCreatePortal = typeof fn === 'function' ? fn : null
  } catch {
    resolvedCreatePortal = null
  }
  return resolvedCreatePortal
}

export function renderInBodyPortal(children: React.ReactNode): React.ReactNode {
  if (typeof document === 'undefined' || !document.body) return children
  const createPortal = getCreatePortal()
  return createPortal ? createPortal(children, document.body) : children
}
