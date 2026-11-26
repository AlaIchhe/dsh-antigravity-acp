/**
 * 多账号领域内部类型（对外视图统一复用 `src/shared/rpc-contract.ts`）。
 */
export type { AccountAuthPhase, AccountAuthView, AccountView } from '../shared/rpc-contract.js'

export const SYSTEM_ACCOUNT_ID = 'primary'
export const SYSTEM_ACCOUNT_ALIAS = '主账号（系统登录）'

export interface AccountRecord {
  id: string
  alias: string
  email?: string
  dir?: string
  system?: boolean
  createdAt: number
  lastUsedAt?: number
}

export interface ResolvedAccount {
  id: string
  alias: string
  system: boolean
  home: string
  dir?: string
  revision: number
}
