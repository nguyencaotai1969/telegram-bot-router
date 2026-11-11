import { runCommand, SETUP_COMMANDS } from './bot-commands'
import { parseCommand } from './command-parse'
import { hasAttachment } from './telegram-attachments'
import type { TgCallbackQuery, TgMessage } from './telegram-types'
import { onModelButton } from './topic-model-choice'
import { onSkillButton } from './topic-skill-choice'
import { topicKey } from './topic-store'
import { errorText, type RunDeps, type TopicContext } from './topic-run'

export interface RouterDeps extends RunDeps {
  botUsername: string
}

const MAX_LOGGED_REJECTS = 200

/** Decides what one message (or one album) is: ignored, a command, or work for the topic's project. */
export class MessageRouter {
  private readonly loggedRejects = new Set<string>()

  constructor(private readonly deps: RouterDeps) {}

  async handle(messages: TgMessage[]): Promise<void> {
    const message = messages.find(m => textOf(m)) ?? messages[0]
    if (!message) return
    try {
      await this.route(message, messages)
    } catch (err) {
      console.error(`Lỗi xử lý tin ${message.message_id}: ${errorText(err)}`)
      if (this.deps.config.allowedUserIds.has(message.from?.id ?? 0)) {
        await this.reply(contextOf(message), `⚠️ Lỗi: ${errorText(err)}`).catch(() => {})
      }
    }
  }

  /** A press on one of the bot's inline buttons (the /model and /skills panels): same access rules as messages. */
  async handleButton(query: TgCallbackQuery): Promise<void> {
    const { api, config } = this.deps
    const message = query.message
    try {
      if (!config.allowedUserIds.has(query.from.id) || !message || !config.allowedChatIds.has(message.chat.id)) {
        this.logReject(`nút bấm của người dùng ${query.from.id} trong chat ${message?.chat.id ?? '?'}`)
        await api.answerCallback(query.id, '⛔ Không được phép.')
        return
      }
      if (message.date === 0) {
        // Too old for Telegram to say which topic it is in: acting on it would hit the General topic.
        await api.answerCallback(query.id, '⌛ Bảng chọn này đã cũ: gõ lại lệnh (/model, /skills) để mở bảng mới.')
        return
      }
      const panel = contextOf(message)
      const data = query.data ?? ''
      const handled = (await onModelButton(this.deps, panel, data, query.id)) || (await onSkillButton(this.deps, panel, data, query.id, message.text))
      if (!handled) await api.answerCallback(query.id)
    } catch (err) {
      console.error(`Lỗi xử lý nút bấm: ${errorText(err)}`)
    }
  }

  /**
   * Everything up to the enqueue is synchronous: a later message of the same topic (/stop,
   * /bind, the next instruction) can never overtake this one. Files are downloaded by the job.
   */
  private async route(message: TgMessage, album: TgMessage[]): Promise<void> {
    const { config, store } = this.deps
    const from = message.from
    if (!from || from.is_bot) return
    if (!config.allowedUserIds.has(from.id)) {
      this.logReject(`người dùng ${from.id} (@${from.username ?? from.first_name}) trong chat ${message.chat.id}`)
      return
    }
    const ctx = contextOf(message)
    if (Date.now() - message.date * 1000 > config.staleMessageMs) {
      await this.reply(ctx, '⏭️ Bỏ qua tin gửi lúc bot đang tắt. Gửi lại nếu vẫn cần.')
      return
    }
    const text = textOf(message)
    const command = text.startsWith('/') ? parseCommand(text, this.deps.botUsername) : null
    if (command === 'other-bot') return
    if (command && SETUP_COMMANDS.has(command.name)) {
      await runCommand(this.deps, ctx, command, from.id)
      return
    }
    if (message.chat.type === 'private') {
      await this.reply(ctx, 'Bot chỉ nhận việc trong group có Topics. Gõ /help để xem cách dùng.')
      return
    }
    if (!config.allowedChatIds.has(message.chat.id)) {
      this.logReject(`group ${message.chat.id} (${message.chat.title ?? ''}) chưa có trong ALLOWED_CHAT_IDS`)
      await this.reply(ctx, `⛔ Group này chưa được phép. Thêm ${message.chat.id} vào ALLOWED_CHAT_IDS trong .env rồi chạy lại bot.`)
      return
    }
    const topicName = message.reply_to_message?.forum_topic_created?.name
    if (topicName) store.setName(ctx.key, topicName)
    if (command) {
      await runCommand(this.deps, ctx, command, from.id, topicName)
      return
    }
    // Every part of an album must come from the same person, in the same topic.
    const parts = album.filter(m => m.from?.id === from.id && contextOf(m).key === ctx.key)
    if (!text && !parts.some(hasAttachment)) return // sticker, poll, service message…
    if (!store.get(ctx.key)) {
      await this.reply(ctx, '📌 Topic này chưa gắn dự án. Gõ: /bind D:\\nodejs\\ten-du-an')
      return
    }
    this.deps.conversations.deliver(this.deps, ctx, { text, messages: parts })
  }

  private reply(ctx: TopicContext, text: string): Promise<unknown> {
    return this.deps.api.sendText(ctx.chatId, text, { threadId: ctx.threadId, replyTo: ctx.messageId })
  }

  private logReject(what: string): void {
    const clean = what.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 200)
    if (this.loggedRejects.has(clean)) return
    if (this.loggedRejects.size >= MAX_LOGGED_REJECTS) this.loggedRejects.clear()
    this.loggedRejects.add(clean)
    console.warn(`⛔ Bỏ qua tin từ ${clean}`)
  }
}

function textOf(message: TgMessage): string {
  return (message.text ?? message.caption ?? '').trim()
}

function contextOf(message: TgMessage): TopicContext & { messageId: number } {
  // message_thread_id is also set on reply threads of plain groups: only a real topic counts.
  const threadId = message.is_topic_message ? message.message_thread_id : undefined
  return { chatId: message.chat.id, threadId, messageId: message.message_id, key: topicKey(message.chat.id, threadId) }
}
