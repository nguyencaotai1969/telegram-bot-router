import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { ParsedCommand } from './command-parse'
import { splitForTelegram } from './reply-text-chunks'
import { describeUsage, isOverLimit } from './session-size-warning'
import type { BotCommand } from './telegram-api'
import type { TopicClaudeState } from './topic-conversations'
import { modelCommand, modelLine, type Reply } from './topic-model-choice'
import type { RunDeps, TopicContext } from './topic-run'
import { skillsCommand } from './topic-skill-choice'

/** Shown in Telegram's "/" menu of the group. */
export const BOT_COMMANDS: BotCommand[] = [
  { command: 'bind', description: 'Gắn topic với thư mục dự án' },
  { command: 'status', description: 'Dự án, phiên, việc đang chạy' },
  { command: 'new', description: 'Cuộc trò chuyện mới (quên ngữ cảnh cũ)' },
  { command: 'model', description: 'Chọn model cho topic này' },
  { command: 'skills', description: 'Cài skill (Ponytail, ClaudeKit) cho dự án' },
  { command: 'stop', description: 'Dừng việc, tắt Claude của topic' },
  { command: 'topics', description: 'Các topic đã gắn trong group' },
  { command: 'unbind', description: 'Bỏ gắn topic' },
  { command: 'id', description: 'Xem ID chat / topic / người dùng' },
  { command: 'help', description: 'Hướng dẫn' },
]

const HELP = [
  '🤖 Mỗi topic = 1 dự án. Gắn 1 lần, sau đó nhắn bình thường là Claude làm việc trong thư mục đó (không cần @bot).',
  '',
  '/bind D:\\nodejs\\ten-du-an — gắn topic với thư mục dự án',
  '/status — dự án, phiên, việc đang chạy',
  '/new — cuộc trò chuyện mới (quên ngữ cảnh cũ)',
  '/model — chọn model cho topic này (mọi model Claude Code có, kể cả bản cũ)',
  '/skills — bấm chọn skill (Ponytail, ClaudeKit) để cài vào dự án, bấm lại để gỡ',
  '/stop — dừng việc đang chạy, tắt Claude của topic (tin sau mở lại, vẫn nhớ ngữ cảnh)',
  '/topics — các topic đã gắn trong group',
  '/unbind — bỏ gắn',
  '/id — xem ID chat / topic / người dùng',
  '',
  'Gửi ảnh hoặc tệp (kèm lời nhắn) để Claude xem.',
  '⚠️ Claude chạy với toàn quyền trên máy: không hỏi trước khi chạy lệnh hay sửa tệp.',
].join('\n')

const CLAUDE_STATE: Record<TopicClaudeState, string> = {
  working: 'đang làm (tin mới được đưa thẳng vào việc đang chạy)',
  warm: 'đang chạy sẵn (tin sau trả lời nhanh)',
  off: 'chưa mở (tin sau khởi động vài giây)',
}

/** Commands any allowed user may use outside an allowed group (setup). */
export const SETUP_COMMANDS = new Set(['id', 'help', 'start'])

/** The "/" menu of a private chat with the bot: only what answers there. */
export const PRIVATE_COMMANDS: BotCommand[] = BOT_COMMANDS.filter(c => SETUP_COMMANDS.has(c.command))

/** Answers one command in the topic it came from. */
export async function runCommand(
  deps: RunDeps,
  ctx: TopicContext,
  command: ParsedCommand,
  userId: number,
  topicName?: string,
): Promise<void> {
  const answer = await commandAnswer(deps, ctx, command, userId, topicName)
  if (typeof answer !== 'string') {
    await deps.api.sendText(ctx.chatId, answer.text, { threadId: ctx.threadId, replyTo: ctx.messageId, buttons: answer.buttons })
    return
  }
  for (const [index, chunk] of splitForTelegram(answer).entries()) {
    await deps.api.sendText(ctx.chatId, chunk, { threadId: ctx.threadId, replyTo: index === 0 ? ctx.messageId : undefined })
  }
}

async function commandAnswer(
  deps: RunDeps,
  ctx: TopicContext,
  command: ParsedCommand,
  userId: number,
  topicName?: string,
): Promise<string | Reply> {
  const { store, scheduler, conversations } = deps
  switch (command.name) {
    case 'bind':
      return bindTopic(deps, ctx, command.args, topicName)
    case 'unbind':
      if (conversations.busy(scheduler, ctx.key)) return '⛔ Topic đang chạy việc. Gõ /stop hoặc đợi xong.'
      conversations.shutDown(ctx.key)
      return store.unbind(ctx.key) ? '✅ Đã bỏ gắn topic này.' : 'Topic này chưa gắn dự án.'
    case 'new':
      if (!store.get(ctx.key)) return 'Topic này chưa gắn dự án. Gõ /bind trước.'
      if (conversations.busy(scheduler, ctx.key)) return '⛔ Topic đang chạy việc. Gõ /stop hoặc đợi xong rồi /new.'
      conversations.shutDown(ctx.key)
      store.setSession(ctx.key, undefined)
      return '🆕 Tin nhắn tiếp theo sẽ bắt đầu cuộc trò chuyện mới.'
    case 'stop': {
      // Work (running or waiting for its slot): stop it and what it started. Idle: free the warm process.
      const stopped = conversations.stop(scheduler, ctx.key)
      if (stopped === 'work') return '⏹️ Đã dừng.'
      if (stopped === 'process') return '⏹️ Đã tắt Claude của topic này. Tin sau mở lại, vẫn nhớ ngữ cảnh.'
      return 'Không có việc nào đang chạy.'
    }
    case 'model':
      return modelCommand(deps, ctx, command.args)
    case 'skills':
      return skillsCommand(deps, ctx)
    case 'status':
      return statusText(deps, ctx)
    case 'topics':
      return topicsText(deps, ctx.chatId)
    case 'id':
      return `chat_id: ${ctx.chatId}\ntopic: ${ctx.threadId ?? 'General'}\nuser_id: ${userId}`
    case 'help':
    case 'start':
      return HELP
    default:
      return `Không biết lệnh /${command.name}. Gõ /help.`
  }
}

function bindTopic(deps: RunDeps, ctx: TopicContext, args: string, topicName?: string): string {
  const current = deps.store.get(ctx.key)
  const raw = args.replace(/^(["'])(.*)\1$/s, '$2').trim()
  if (!raw) return current ? `📌 Đang gắn: ${current.cwd}` : 'Cách dùng: /bind D:\\nodejs\\ten-du-an'
  if (deps.conversations.busy(deps.scheduler, ctx.key)) return '⛔ Topic đang chạy việc. Gõ /stop hoặc đợi xong rồi /bind lại.'
  if (!isAbsolute(raw)) return '⛔ Cần đường dẫn đầy đủ, ví dụ D:\\nodejs\\sky-farm'
  const cwd = resolve(raw)
  let isDirectory = false
  try {
    isDirectory = statSync(cwd).isDirectory()
  } catch {
    // missing
  }
  if (!isDirectory) return `⛔ Không thấy thư mục: ${cwd}`
  const other = deps.store.keysForCwd(cwd).find(key => key !== ctx.key)
  if (other) {
    const where = deps.store.get(other)?.name ?? other
    return `⛔ Thư mục này đã gắn với topic "${where}". Mỗi thư mục chỉ một topic, để hai phiên Claude không cùng sửa một chỗ. Gõ /unbind ở topic đó trước.`
  }
  deps.conversations.shutDown(ctx.key)
  deps.store.bind(ctx.key, cwd, topicName)
  return `✅ Topic này giờ làm việc ở:\n${cwd}\nNhắn bình thường để giao việc (không cần @bot).`
}

function statusText(deps: RunDeps, ctx: TopicContext): string {
  const binding = deps.store.get(ctx.key)
  const usage = binding?.usage
  const lines = [
    binding ? `📌 Dự án: ${binding.cwd}` : '📌 Chưa gắn dự án (/bind)',
    `🧵 Phiên: ${binding?.sessionId ? `${binding.sessionId.slice(0, 8)}…` : 'mới'}`,
    ...(usage ? [`🧠 Ngữ cảnh: ${describeUsage(usage)}${isOverLimit(usage, deps.config) ? ' ⚠️ nên /new' : ''}`] : []),
    modelLine(deps, ctx.key),
    `🔥 Claude: ${CLAUDE_STATE[deps.conversations.busy(deps.scheduler, ctx.key) ? 'working' : deps.conversations.state(ctx.key)]}`,
    `⚙️ Cả bot: ${deps.scheduler.activeCount}/${deps.config.maxParallelRuns} việc đang chạy`,
  ]
  return lines.join('\n')
}

function topicsText(deps: RunDeps, chatId: number): string {
  const entries = deps.store.listChat(chatId)
  if (entries.length === 0) return 'Chưa topic nào gắn dự án.'
  const lines = entries.map(([key, binding]) => {
    const thread = key.slice(key.indexOf(':') + 1)
    const label = binding.name ?? (thread === 'general' ? 'General' : `Topic ${thread}`)
    return `• ${label} → ${binding.cwd}`
  })
  return lines.join('\n')
}
