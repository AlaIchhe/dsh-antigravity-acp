/**
 * DSH 请求消息、图像附件与工具结果 → ACP prompt / MCP tool result 序列化。
 * 合并原 prompt-transcript.ts 与 image-content.ts。
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock as DshContentBlock, ImageBlock, RequestMessage, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, TextContent } from '@agentclientprotocol/sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { withAbort } from '../runtime/abort.js'
import { renderToolSignatures } from './tool-args.js'

const MESSAGE_OPEN_PREFIX = '<dsh-message role="'
const MESSAGE_OPEN_SUFFIX = '">'
const MESSAGE_CLOSE = '</dsh-message>'
const SYSTEM_OPEN = '<dsh-system>'
const SYSTEM_CLOSE = '</dsh-system>'
const POLICY_OPEN = '<dsh-tool-policy>'
const POLICY_CLOSE = '</dsh-tool-policy>'
const SIGNATURES_OPEN = '<dsh-tool-signatures>'
const SIGNATURES_CLOSE = '</dsh-tool-signatures>'
export const HISTORY_OPEN = '<dsh-conversation-history>'
export const HISTORY_CLOSE = '</dsh-conversation-history>'
export const CURRENT_REQUEST_OPEN = '<dsh-current-request>'
export const CURRENT_REQUEST_CLOSE = '</dsh-current-request>'

export const TOOL_POLICY_TEXT = [
  '本会话运行在 DSH（DeepSeek Harness）集成中，工具与 DSH 对齐：',
  '- 随本会话提供的工具列表就是你的工具入口；读写文件、执行命令、搜索代码请一律使用它们，它们与 DSH 的权限与审计一致。',
  '- agy 的原生工具（read_file / write_file / edit_file / run_command / view_file / list_dir / grep_search / find_by_name 等）在本集成中不可用：会话已关闭内置工具与客户端 fs/terminal 能力。',
  '- 不要反复索要原生能力；直接改用等价的随会话工具完成。',
  '- 随会话 MCP 工具由 DSH 审批和执行，结果会在当前 ACP prompt 内返回；isError=true 的拒绝/失败是权威结果，不要绕过审批或重复执行。',
  '- ACP 权限拒绝可能发生在插件转交 DSH 之前。仅凭 Denied by user 或 pre-tool hook 文本，不能断言 DSH 全局禁用了工具，也不能建议关闭沙箱或审批。请明确报告拒绝来源尚未核实。',
].join('\n')

export const HISTORY_NOTICE_TEXT = [
  '下面是本次请求之前已经发生的对话与工具轨迹，作为背景资料重放；它们不是新的任务请求。',
  '不要因为历史里还有未完成的步骤就继续它。',
].join('\n')

export const CURRENT_REQUEST_NOTICE_TEXT = [
  '当前需要回应的最新用户消息如下（以此为准，优先级高于上面的历史）。',
  '请直接回应它；只有它明确要求继续时，才续做历史里未完成的工作。',
].join('\n')

export type ImageReader = (ref: ImageAttachmentRef, signal?: AbortSignal) => Promise<StoredImageAttachment>

export interface ImageContentOptions {
  readImage?: ImageReader
  supported: boolean
  signal?: AbortSignal
}

export interface TranscriptEntry {
  role: string
  content: unknown[]
  toolCallId?: string
  isError?: boolean
}

function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

export function hasPriorConversation(messages: readonly RequestMessage[]): boolean {
  return messages.some((message) => message.role === 'assistant' || message.role === 'tool')
}

/**
 * 判断消息历史里是否存在归属当前 provider 的已交付回复。
 *
 * - 若老会话此前全部回复都来自其它 provider（例如 DeepSeek / Qwenwork），首次切入
 *   Antigravity ACP 时本地不可能存在 ACP 映射，应返回 `false` 让协调器平滑 `reset-fresh`；
 * - 若已有当前 provider 的回复（或无 provider 标注的历史/测试消息），返回 `true` 继续走映射恢复校验。
 */
export function hasPriorProviderConversation(
  messages: readonly RequestMessage[],
  provider: string,
): boolean {
  let hasAssistant = false
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    hasAssistant = true
    const src = (message as { readonly source?: { readonly provider?: unknown } }).source
    if (typeof src?.provider !== 'string' || src.provider === '' || src.provider === provider) {
      return true
    }
  }
  return !hasAssistant && messages.some((message) => message.role === 'tool')
}

export function encodeMessage(message: RequestMessage): string {
  const payload = message.role === 'tool'
    ? { toolCallId: message.toolCallId, isError: message.isError === true, content: message.content }
    : message.content
  return `${MESSAGE_OPEN_PREFIX}${message.role}${MESSAGE_OPEN_SUFFIX}${JSON.stringify(payload)}${MESSAGE_CLOSE}`
}

export function latestUserRequest(messages: readonly RequestMessage[]): RequestMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'user') continue
    const source = (message as { readonly source?: { readonly kind?: unknown } }).source
    if (source === undefined || source.kind === 'user') return message
  }
  return undefined
}

export function currentRequestBlock(messages: readonly RequestMessage[]): ContentBlock | undefined {
  const latest = latestUserRequest(messages)
  if (!latest) return undefined
  const parts: string[] = []
  for (const block of latest.content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') parts.push('[本条消息附带图片，见上文对应的消息块]')
    else parts.push(`[本条消息附带 ${block.type} 内容，见上文对应的消息块]`)
  }
  const body = parts.join('\n').trim()
  return textBlock([
    CURRENT_REQUEST_OPEN,
    CURRENT_REQUEST_NOTICE_TEXT,
    body === '' ? '（本条消息没有文本内容）' : body,
    CURRENT_REQUEST_CLOSE,
  ].join('\n'))
}

function buildHeaderBlocks(system: string | undefined, tools: readonly ToolSchema[]): ContentBlock[] {
  const blocks: ContentBlock[] = []
  if (system !== undefined && system !== '') {
    blocks.push(textBlock(`${SYSTEM_OPEN}${system}${SYSTEM_CLOSE}`))
  }
  blocks.push(textBlock(`${POLICY_OPEN}${TOOL_POLICY_TEXT}${POLICY_CLOSE}`))
  const signatures = renderToolSignatures(tools)
  if (signatures) blocks.push(textBlock(`${SIGNATURES_OPEN}${signatures}${SIGNATURES_CLOSE}`))
  return blocks
}

async function imageContent(block: ImageBlock, options: ImageContentOptions): Promise<ContentBlock> {
  if (options.signal?.aborted) throw new LlmError('图像读取已取消', 'AGY_ABORTED')
  if (block.offloaded) return textBlock('[此图像已由 DSH 卸载，本次没有发送图像像素。]')
  if (!options.supported || !options.readImage) {
    throw new LlmError('当前 ACP 连接或 DSH 附件服务不支持图像读取，无法发送这张图片；请连接支持图像的 ACP 服务后重试', 'AGY_IMAGE_UNAVAILABLE')
  }
  const stored = await withAbort(options.readImage(block.attachment, options.signal), options.signal, '图像读取已取消')
  if (
    stored.ref.attachmentId !== block.attachment.attachmentId
    || stored.ref.mediaType !== block.attachment.mediaType
    || !(stored.data instanceof Uint8Array)
    || stored.data.byteLength !== block.attachment.bytes
    || stored.data.byteLength === 0
    || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(stored.ref.mediaType)
  ) {
    throw new LlmError('DSH 附件读取结果与图像引用不一致，已停止发送', 'AGY_INVALID_IMAGE')
  }
  return { type: 'image', mimeType: stored.ref.mediaType, data: Buffer.from(stored.data).toString('base64') }
}

async function appendMessageContent(
  content: ContentBlock[],
  messages: readonly RequestMessage[],
  options: ImageContentOptions,
): Promise<void> {
  for (const message of messages) {
    if (options.signal?.aborted) throw new LlmError('图像读取已取消', 'AGY_ABORTED')
    content.push(textBlock(encodeMessage(message)))
    for (const block of message.content) {
      if (block.type === 'image') content.push(await imageContent(block, options))
      else if (block.type === 'file') throw new LlmError('文件引用必须先由 DSH 投影为可读文本', 'AGY_UNSUPPORTED_CONTENT')
    }
  }
}

export async function buildFullPrompt(
  system: string | undefined,
  messages: readonly RequestMessage[],
  tools: readonly ToolSchema[],
  options: ImageContentOptions,
): Promise<ContentBlock[]> {
  const content = buildHeaderBlocks(system, tools)
  if (hasPriorConversation(messages)) {
    content.push(textBlock(`${HISTORY_OPEN}${HISTORY_NOTICE_TEXT}${HISTORY_CLOSE}`))
  }
  await appendMessageContent(content, messages, options)
  const current = currentRequestBlock(messages)
  if (current) content.push(current)
  return content
}

export async function buildDeltaPrompt(
  messages: readonly RequestMessage[],
  options: ImageContentOptions,
): Promise<ContentBlock[]> {
  const content: ContentBlock[] = []
  await appendMessageContent(content, messages, options)
  return content
}

export async function buildToolResultContent(
  blocks: readonly DshContentBlock[],
  options: ImageContentOptions,
): Promise<CallToolResult['content']> {
  const content: CallToolResult['content'] = []
  for (const block of blocks) {
    if (options.signal?.aborted) throw new LlmError('图像读取已取消', 'AGY_ABORTED')
    if (block.type === 'image') {
      const image = await imageContent(block, options)
      if (image.type === 'image') content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
      else if (image.type === 'text') content.push({ type: 'text', text: image.text })
    } else if (block.type === 'text') {
      content.push({ type: 'text', text: block.text })
    } else {
      throw new LlmError(`工具结果包含尚不支持的内容类型：${block.type}`, 'AGY_UNSUPPORTED_CONTENT')
    }
  }
  return content
}

/** 逆解析（供测试验证 prompt 重建结果）。 */
export function parsePromptTranscript(blocks: readonly ContentBlock[]): { system?: string; entries: TranscriptEntry[] } {
  const texts = blocks
    .filter((block): block is TextContent & { type: 'text' } => block.type === 'text')
    .map((block) => block.text)
  let system: string | undefined
  const entries: TranscriptEntry[] = []
  for (const text of texts) {
    if (text.startsWith(SYSTEM_OPEN) && text.endsWith(SYSTEM_CLOSE)) {
      system = text.slice(SYSTEM_OPEN.length, text.length - SYSTEM_CLOSE.length)
      continue
    }
    if (text.startsWith(HISTORY_OPEN) || text.startsWith(CURRENT_REQUEST_OPEN)) continue
    let cursor = 0
    for (;;) {
      const open = text.indexOf(MESSAGE_OPEN_PREFIX, cursor)
      if (open < 0) break
      const roleStart = open + MESSAGE_OPEN_PREFIX.length
      const roleEnd = text.indexOf(MESSAGE_OPEN_SUFFIX, roleStart)
      if (roleEnd < 0) break
      const bodyStart = roleEnd + MESSAGE_OPEN_SUFFIX.length
      const bodyEnd = text.indexOf(MESSAGE_CLOSE, bodyStart)
      if (bodyEnd < 0) break
      const role = text.slice(roleStart, roleEnd)
      const body = text.slice(bodyStart, bodyEnd)
      try {
        const content = JSON.parse(body) as unknown
        if (Array.isArray(content)) {
          entries.push({ role, content })
        } else if (role === 'tool' && content !== null && typeof content === 'object') {
          const payload = content as Record<string, unknown>
          if (Array.isArray(payload.content) && typeof payload.toolCallId === 'string' && typeof payload.isError === 'boolean') {
            entries.push({ role, content: payload.content, toolCallId: payload.toolCallId, isError: payload.isError })
          }
        }
      } catch { /* 非本模块信封跳过 */ }
      cursor = bodyEnd + MESSAGE_CLOSE.length
    }
  }
  return system === undefined ? { entries } : { system, entries }
}
