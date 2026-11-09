import { statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, resolve } from 'node:path'
import { type BotApi, TelegramApiError } from './telegram-api'

/**
 * A line "📎 <path>" or "📎 <path> | caption" in what Claude writes (also as a list item): a file it
 * wants the user to get. Not inside a ``` block, where it is an example, nor in a > quote.
 */
const FILE_LINE = /^[ \t]*(?:(?:[-*•]|\d+[.)])[ \t]+)?📎️?[ \t]*(.*?)[ \t]*$/u
const FENCE = /^[ \t]*(```|~~~)/
/** Never uploaded, whoever names them: secrets (tokens, keys) a prompt injection could ask for. */
const SECRET_NAME = /^(\.env(\..*)?|id_(rsa|dsa|ecdsa|ed25519)|.*\.(pem|key|p12|pfx))$/i
const SECRET_DIR = /[\\/](\.ssh|\.gnupg|\.aws|\.claude[\\/]channels)[\\/]/i
/** Sent as photos (shown inline); anything else goes as a file. */
const PHOTO_TYPES = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const MAX_PHOTO_BYTES = 10 * 1024 * 1024
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_CAPTION_CHARS = 1000

export interface OutgoingFile {
  path: string
  caption?: string
}

/** Where a file goes: the topic, and the message it answers. */
export interface FilePlace {
  chatId: number
  threadId?: number
  replyTo?: number
}

/**
 * Splits Claude's text into the words to post and the files its 📎 lines name. A path may be
 * relative (to the project folder), start with ~, or be Git Bash style (/d/nodejs/…) on Windows.
 */
export function takeOutgoingFiles(text: string, cwd: string): { text: string; files: OutgoingFile[] } {
  const files: OutgoingFile[] = []
  const kept: string[] = []
  let inFence = false
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence
    const spec = inFence ? undefined : FILE_LINE.exec(line)?.[1]
    if (spec === undefined) {
      kept.push(line)
      continue
    }
    const [rawPath = '', ...captionParts] = spec.split(' | ')
    const path = rawPath.trim().replace(/^[`'"<*]+|[`'">*]+$/g, '').trim()
    const caption = captionParts.join(' | ').trim().slice(0, MAX_CAPTION_CHARS)
    if (path) files.push({ path: resolvePath(path, cwd), ...(caption ? { caption } : {}) })
  }
  if (kept.length === text.split('\n').length) return { text, files }
  // Only where 📎 lines came out are the blank lines they leave squeezed.
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), files }
}

function resolvePath(path: string, cwd: string): string {
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) return resolve(homedir(), path.slice(2))
  if (process.platform === 'win32') {
    // Git Bash spellings: /tmp/… is the temp folder, /d/… is drive D:.
    if (path === '/tmp' || path.startsWith('/tmp/')) return resolve(tmpdir(), path.slice(5))
    const drive = /^\/([a-zA-Z])(\/.*)?$/.exec(path)
    if (drive) return resolve(`${drive[1]?.toUpperCase()}:${drive[2] ?? '/'}`)
  }
  return resolve(cwd, path)
}

/** Uploads each file to the topic; one that cannot go gets a short note there instead. Never throws. */
export async function sendOutgoingFiles(api: BotApi, place: FilePlace, files: OutgoingFile[]): Promise<void> {
  for (const file of files) {
    try {
      await sendOne(api, place, file)
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      console.error(`Gửi tệp ${file.path} lỗi: ${why}`)
      await api
        .sendText(place.chatId, `⚠️ Không gửi được tệp ${basename(file.path)}: ${why}`, { threadId: place.threadId, replyTo: place.replyTo })
        .catch(() => {})
    }
  }
}

async function sendOne(api: BotApi, place: FilePlace, file: OutgoingFile): Promise<void> {
  if (SECRET_NAME.test(basename(file.path)) || SECRET_DIR.test(file.path)) throw new Error('tệp bí mật (token, khoá), bot không gửi')
  let size: number
  try {
    const stat = statSync(file.path)
    if (!stat.isFile()) throw new Error()
    size = stat.size
  } catch {
    throw new Error(`không có tệp ${file.path}`)
  }
  if (size > MAX_FILE_BYTES) throw new Error('quá 50 MB (giới hạn của bot Telegram)')
  const opts = { threadId: place.threadId, replyTo: place.replyTo, caption: file.caption }
  if (!PHOTO_TYPES.has(extname(file.path).toLowerCase()) || size > MAX_PHOTO_BYTES) {
    await api.sendFile(place.chatId, file.path, opts)
    return
  }
  try {
    await api.sendFile(place.chatId, file.path, { ...opts, photo: true })
  } catch (err) {
    // Telegram refuses some images as photos (size in pixels, odd ratio): they still go as a file.
    if (!(err instanceof TelegramApiError) || err.code !== 400) throw err
    await api.sendFile(place.chatId, file.path, opts)
  }
}
