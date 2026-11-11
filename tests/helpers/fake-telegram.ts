import { basename, join } from 'node:path'
import type { RouterConfig } from '../../src/config'
import type { BotApi, FileOptions, InlineButton, SendOptions } from '../../src/telegram-api'
import type { TgMessage } from '../../src/telegram-types'

export const OWNER_ID = 111
export const GROUP_ID = -100123
export const TOPIC_ID = 7
export const FAKE_CLAUDE = [process.execPath, join(import.meta.dir, '..', 'fixtures', 'fake-claude.ts')]

export interface Sent {
  /** 'answer': a reply to a button press (messageId 0, text = its toast). 'file': an upload from disk. */
  kind: 'send' | 'edit' | 'document' | 'file' | 'answer'
  chatId: number
  messageId: number
  text: string
  threadId?: number
  replyTo?: number
  /** Inline buttons' callback data, row by row. */
  buttons?: string[][]
}

const buttonData = (buttons: InlineButton[][] | undefined) => buttons?.map(row => row.map(button => button.data))

/** Records what the router would send to Telegram. */
export class FakeBotApi implements BotApi {
  readonly log: Sent[] = []
  readonly files = new Map<string, Uint8Array>()
  private nextId = 5000

  /** Milliseconds a text takes to reach the group, e.g. to race a slow long answer against a later one. */
  sendDelay: (text: string) => number = () => 0

  async sendText(chatId: number, text: string, opts: SendOptions = {}): Promise<TgMessage> {
    const delay = this.sendDelay(text)
    if (delay > 0) await Bun.sleep(delay)
    const messageId = this.nextId++
    const buttons = buttonData(opts.buttons)
    this.log.push({ kind: 'send', chatId, messageId, text, threadId: opts.threadId, replyTo: opts.replyTo, buttons })
    return { message_id: messageId, date: 0, chat: { id: chatId, type: 'supergroup' } }
  }

  async editText(chatId: number, messageId: number, text: string, buttons?: InlineButton[][]): Promise<unknown> {
    this.log.push({ kind: 'edit', chatId, messageId, text, buttons: buttonData(buttons) })
    return true
  }

  /** Milliseconds Telegram takes to answer a button press with this query id. */
  answerDelay: (queryId: string) => number = () => 0

  async answerCallback(queryId: string, text?: string): Promise<unknown> {
    const delay = this.answerDelay(queryId)
    if (delay > 0) await Bun.sleep(delay)
    this.log.push({ kind: 'answer', chatId: 0, messageId: 0, text: `${queryId}:${text ?? ''}` })
    return true
  }

  async sendDocument(chatId: number, fileName: string, content: string, opts: SendOptions = {}): Promise<TgMessage> {
    const messageId = this.nextId++
    const text = `${fileName}:${content.length}`
    this.log.push({ kind: 'document', chatId, messageId, text, threadId: opts.threadId, replyTo: opts.replyTo })
    return { message_id: messageId, date: 0, chat: { id: chatId, type: 'supergroup' } }
  }

  /** An upload from disk, logged as "<file name>:<photo|document>:<caption>"; the file must exist, as for Telegram. */
  async sendFile(chatId: number, path: string, opts: FileOptions = {}): Promise<TgMessage> {
    if (!(await Bun.file(path).exists())) throw new Error(`no file ${path}`)
    const messageId = this.nextId++
    const text = `${basename(path)}:${opts.photo ? 'photo' : 'document'}:${opts.caption ?? ''}`
    this.log.push({ kind: 'file', chatId, messageId, text, threadId: opts.threadId, replyTo: opts.replyTo })
    return { message_id: messageId, date: 0, chat: { id: chatId, type: 'supergroup' } }
  }

  /** Slows downloads down, to race them against later commands. */
  downloadDelayMs = 0

  async downloadFile(fileId: string): Promise<Uint8Array> {
    if (this.downloadDelayMs) await Bun.sleep(this.downloadDelayMs)
    const bytes = this.files.get(fileId)
    if (!bytes) throw new Error(`no file ${fileId}`)
    return bytes
  }

  find(kind: Sent['kind'], needle: string): Sent | undefined {
    return this.log.find(item => item.kind === kind && item.text.includes(needle))
  }
}

let nextMessageId = 1

/** A text message from the owner in topic TOPIC_ID of the allowed group. */
export function topicMessage(text: string, extra: Partial<TgMessage> = {}): TgMessage {
  return {
    message_id: nextMessageId++,
    date: Math.floor(Date.now() / 1000),
    chat: { id: GROUP_ID, type: 'supergroup', is_forum: true },
    from: { id: OWNER_ID, is_bot: false, first_name: 'Owner' },
    message_thread_id: TOPIC_ID,
    is_topic_message: true,
    text,
    ...extra,
  }
}

export function testConfig(dataDir: string, extra: Partial<RouterConfig> = {}): RouterConfig {
  return {
    botToken: '123456:test-token-test-token-test-token-xx',
    allowedUserIds: new Set([OWNER_ID]),
    allowedChatIds: new Set([GROUP_ID]),
    claudeCommand: FAKE_CLAUDE,
    maxParallelRuns: 2,
    runTimeoutMs: 20_000,
    staleMessageMs: 10 * 60_000,
    contextWarnTokens: 200_000,
    sessionWarnMessages: 20,
    dataDir,
    claudeDir: join(dataDir, 'claude-home'),
    ...extra,
  }
}

export async function waitFor<T>(probe: () => T | undefined | false | null, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() > end) throw new Error('waitFor: timed out')
    await Bun.sleep(20)
  }
}
