import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { BotApi } from './telegram-api'
import type { TgMessage } from './telegram-types'

/** Bot API download cap. */
const MAX_FILE_BYTES = 20 * 1024 * 1024

interface Attachment {
  fileId: string
  name: string
  size?: number
}

export function hasAttachment(message: TgMessage): boolean {
  return Boolean(message.photo?.length || message.document)
}

/** Saves the photos / files of the messages into `inboxDir`; returns their absolute paths. */
export async function downloadAttachments(api: BotApi, messages: TgMessage[], inboxDir: string): Promise<string[]> {
  const items = messages.flatMap(attachmentsOf)
  if (items.length === 0) return []
  mkdirSync(inboxDir, { recursive: true })
  const paths: string[] = []
  for (const item of items) {
    if ((item.size ?? 0) > MAX_FILE_BYTES) throw new Error(`Tệp quá lớn (tối đa 20 MB): ${item.name}`)
    const bytes = await api.downloadFile(item.fileId, MAX_FILE_BYTES)
    const path = join(inboxDir, `${Date.now()}-${paths.length}-${item.name}`)
    await Bun.write(path, bytes)
    paths.push(path)
  }
  return paths
}

/** Deletes inbox files older than `maxAgeMs`. */
export function pruneInbox(inboxDir: string, maxAgeMs: number): void {
  let names: string[]
  try {
    names = readdirSync(inboxDir)
  } catch {
    return
  }
  const cutoff = Date.now() - maxAgeMs
  for (const name of names) {
    const path = join(inboxDir, name)
    try {
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path)
    } catch {
      // in use or already gone
    }
  }
}

function attachmentsOf(message: TgMessage): Attachment[] {
  const items: Attachment[] = []
  const photo = message.photo?.at(-1) // largest size
  if (photo) items.push({ fileId: photo.file_id, name: `photo-${message.message_id}.jpg`, size: photo.file_size })
  if (message.document) {
    const name = safeFileName(message.document.file_name ?? `file-${message.message_id}`)
    items.push({ fileId: message.document.file_id, name, size: message.document.file_size })
  }
  return items
}

export function safeFileName(name: string): string {
  const clean = basename(name.replace(/\\/g, '/'))
    .replace(/[^\w.-]+/g, '_')
    .replace(/^[.]+/, '')
    .slice(-80)
  return clean || 'file'
}
