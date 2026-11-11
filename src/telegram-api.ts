import { basename } from 'node:path'
import { type FileOptions, type InlineButton, keyboard, type SendOptions, threadParams } from './telegram-send-options'
import type { TgMessage, TgUpdate, TgUser } from './telegram-types'

export { buttonRows, type FileOptions, type InlineButton, type SendOptions } from './telegram-send-options'

const API_ROOT = 'https://api.telegram.org'
/** Seconds a getUpdates call waits for news (long polling). */
const POLL_SECONDS = 50
const MAX_SEND_ATTEMPTS = 5
/** An upload that timed out may have arrived: tried twice at most, so a slow link never posts it five times. */
const MAX_UPLOAD_ATTEMPTS = 2
/** Upload time limit: a minute, plus a second per 256 KB (about 2 Mbit/s): 50 MB gets about 4 minutes. */
const uploadTimeoutMs = (bytes: number) => 60_000 + Math.ceil(bytes / 262_144) * 1000
const MAX_FLOOD_WAIT_SEC = 600

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly retryAfterSec?: number,
  ) {
    super(`${method}: ${code} ${description}`)
  }
}

export interface BotCommand {
  command: string
  description: string
}

interface Envelope<T> {
  ok: boolean
  result?: T
  error_code?: number
  description?: string
  parameters?: { retry_after?: number }
}

/** Minimal Bot API client over fetch. The token never appears in an error message. */
export class TelegramApi {
  /** Per chat: no send before this time (set by a 429). */
  private readonly floodUntil = new Map<number, number>()

  constructor(private readonly token: string) {}

  call<T>(method: string, params: object = {}, timeoutMs = 30_000): Promise<T> {
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) }
    return this.request<T>(method, init, timeoutMs)
  }

  getMe(): Promise<TgUser> {
    return this.call<TgUser>('getMe')
  }

  getUpdates(offset: number): Promise<TgUpdate[]> {
    const params = { offset, timeout: POLL_SECONDS, allowed_updates: ['message', 'callback_query'] }
    return this.call<TgUpdate[]>('getUpdates', params, (POLL_SECONDS + 15) * 1000)
  }

  /** The "/" menu Telegram suggests, for every group or every private chat with the bot. */
  setMyCommands(commands: BotCommand[], scope: 'all_group_chats' | 'all_private_chats'): Promise<boolean> {
    return this.call<boolean>('setMyCommands', { commands, scope: { type: scope } })
  }

  sendText(chatId: number, text: string, opts: SendOptions = {}): Promise<TgMessage> {
    const params = {
      chat_id: chatId,
      text,
      ...threadParams(opts),
      link_preview_options: { is_disabled: true },
    }
    return this.deliver(chatId, () => this.call<TgMessage>('sendMessage', params))
  }

  /** Without `buttons` the message's inline buttons go away. */
  editText(chatId: number, messageId: number, text: string, buttons?: InlineButton[][]): Promise<unknown> {
    const params = { chat_id: chatId, message_id: messageId, text, link_preview_options: { is_disabled: true }, ...keyboard(buttons) }
    return this.deliver(chatId, () => this.call('editMessageText', params))
  }

  /** Stops the spinner on a pressed button; `text` shows as a short toast. */
  answerCallback(queryId: string, text?: string): Promise<unknown> {
    return this.call('answerCallbackQuery', { callback_query_id: queryId, ...(text ? { text } : {}) })
  }

  sendDocument(chatId: number, fileName: string, content: string, opts: SendOptions = {}): Promise<TgMessage> {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    return this.upload(chatId, 'sendDocument', { field: 'document', blob, fileName }, opts)
  }

  /** Uploads a file from disk: as a photo (shown inline, ≤ 10 MB) or as a file (≤ 50 MB). */
  sendFile(chatId: number, path: string, opts: FileOptions = {}): Promise<TgMessage> {
    const field = opts.photo ? 'photo' : 'document'
    const extra: Record<string, string> = opts.caption ? { caption: opts.caption } : {}
    return this.upload(chatId, opts.photo ? 'sendPhoto' : 'sendDocument', { field, blob: Bun.file(path), fileName: basename(path) }, opts, extra)
  }

  private upload(
    chatId: number,
    method: string,
    file: { field: string; blob: Blob; fileName: string },
    opts: SendOptions,
    extra: Record<string, string> = {},
  ): Promise<TgMessage> {
    // A fresh form for every attempt: a body that was sent once is not sent again.
    const form = () => {
      const data = new FormData()
      data.set('chat_id', String(chatId))
      for (const [key, value] of Object.entries({ ...threadParams(opts), ...extra })) {
        data.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
      }
      data.set(file.field, file.blob, file.fileName)
      return data
    }
    const timeoutMs = uploadTimeoutMs(file.blob.size)
    return this.deliver(chatId, () => this.request<TgMessage>(method, { method: 'POST', body: form() }, timeoutMs), MAX_UPLOAD_ATTEMPTS)
  }

  async downloadFile(fileId: string, maxBytes: number): Promise<Uint8Array> {
    const file = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId })
    if (!file.file_path) throw new Error('Telegram không trả đường dẫn tệp')
    if ((file.file_size ?? 0) > maxBytes) throw new Error('Tệp quá lớn')
    let res: Response
    try {
      res = await fetch(`${API_ROOT}/file/bot${this.token}/${file.file_path}`, { signal: AbortSignal.timeout(120_000) })
    } catch (err) {
      throw new Error(`Tải tệp lỗi: ${this.redact(String(err))}`)
    }
    if (!res.ok) throw new Error(`Tải tệp lỗi: HTTP ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new Error('Tệp quá lớn')
    return bytes
  }

  private async request<T>(method: string, init: RequestInit, timeoutMs: number): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${API_ROOT}/bot${this.token}/${method}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      throw new TelegramApiError(method, 0, this.redact(err instanceof Error ? err.message : String(err)))
    }
    const body = (await res.json().catch(() => null)) as Envelope<T> | null
    if (!body?.ok) {
      const description = this.redact(body?.description ?? res.statusText)
      throw new TelegramApiError(method, body?.error_code ?? res.status, description, body?.parameters?.retry_after)
    }
    return body.result as T
  }

  /**
   * Sends to one chat through its flood gate: after a 429 every send to that chat waits the time
   * Telegram asked for; a network / server error is retried with a growing pause. Gives up after
   * MAX_SEND_ATTEMPTS, so an answer is only lost when Telegram stays unreachable for minutes.
   */
  private async deliver<T>(chatId: number, send: () => Promise<T>, maxAttempts = MAX_SEND_ATTEMPTS): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const wait = (this.floodUntil.get(chatId) ?? 0) - Date.now()
      if (wait > 0) await Bun.sleep(wait)
      try {
        return await send()
      } catch (err) {
        if (!(err instanceof TelegramApiError) || attempt >= maxAttempts) throw err
        if (err.code === 429) {
          const seconds = Math.min(err.retryAfterSec ?? 5, MAX_FLOOD_WAIT_SEC)
          this.floodUntil.set(chatId, Date.now() + seconds * 1000 + 250)
        } else if (err.code === 0 || err.code >= 500) {
          await Bun.sleep(1000 * 2 ** attempt)
        } else {
          throw err
        }
      }
    }
  }

  private redact(text: string): string {
    return text.split(this.token).join('***')
  }
}

/** What the router needs from Telegram (tests pass a fake). */
export type BotApi = Pick<TelegramApi, 'sendText' | 'editText' | 'sendDocument' | 'sendFile' | 'downloadFile' | 'answerCallback'>
