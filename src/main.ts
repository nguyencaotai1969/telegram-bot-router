import { join } from 'node:path'
import { BOT_COMMANDS, PRIVATE_COMMANDS } from './bot-commands'
import { knownModels } from './claude-model-list'
import { killAllRunsSync } from './claude-process-kill'
import { loadConfig } from './config'
import { MediaGroupCollector } from './media-group-collector'
import { MessageRouter } from './message-router'
import { RunScheduler } from './run-scheduler'
import { acquireSingleInstanceLock } from './single-instance-lock'
import { TelegramApi, TelegramApiError } from './telegram-api'
import { pruneInbox } from './telegram-attachments'
import type { TgUpdate } from './telegram-types'
import { TopicConversations } from './topic-conversations'
import { TopicStore } from './topic-store'
import { errorText } from './topic-run'

const INBOX_MAX_AGE_MS = 7 * 24 * 3600_000
const DAY_MS = 24 * 3600_000

async function main(): Promise<void> {
  const config = loadConfig()
  const releaseLock = acquireSingleInstanceLock(join(config.dataDir, 'router.lock'))
  // However the router ends (a crash too), no Claude it started outlives it.
  process.on('exit', () => {
    killAllRunsSync()
    releaseLock()
  })
  installShutdown()

  const api = new TelegramApi(config.botToken)
  const store = new TopicStore(join(config.dataDir, 'state.json'))
  const scheduler = new RunScheduler(config.maxParallelRuns)
  const inboxDir = join(config.dataDir, 'inbox')
  pruneInbox(inboxDir, INBOX_MAX_AGE_MS)
  setInterval(() => pruneInbox(inboxDir, INBOX_MAX_AGE_MS), DAY_MS).unref()

  const me = await api.getMe()
  if (!me.username) throw new Error('Bot không có username')
  for (const [commands, scope] of [
    [BOT_COMMANDS, 'all_group_chats'],
    [PRIVATE_COMMANDS, 'all_private_chats'],
  ] as const) {
    await api.setMyCommands(commands, scope).catch(err => console.warn(`Không đặt được menu lệnh (${scope}): ${errorText(err)}`))
  }

  knownModels(config) // starts asking Claude Code now, so the first /model panel lists every model
  const conversations = new TopicConversations()
  const router = new MessageRouter({ api, config, store, scheduler, conversations, inboxDir, botUsername: me.username })
  const collector = new MediaGroupCollector(messages => void router.handle(messages))

  console.log(`✅ Bot @${me.username} đang chạy.`)
  console.log(`   Claude: ${config.claudeCommand.join(' ')}`)
  console.log(`   Group được phép: ${[...config.allowedChatIds].join(', ') || '(chưa có: nhắn trong group để lấy ID)'}`)
  console.log('   Đóng cửa sổ này hoặc Ctrl+C để tắt.')
  await pollForever(api, store, update => {
    if (update.message) collector.push(update.message)
    else if (update.callback_query) void router.handleButton(update.callback_query)
  })
}

/**
 * Ctrl+C, Ctrl+Break, closing the console window: end every running Claude and what it
 * started (dev servers, test runners), synchronously, before the process goes.
 */
function installShutdown(): void {
  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`Đang tắt (${signal}): dừng các việc đang chạy…`)
    killAllRunsSync()
    process.exit(0)
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    try {
      process.on(signal, () => shutdown(signal))
    } catch {
      // signal not supported on this platform
    }
  }
}

/** Long polling. The offset is saved before a batch is handled, so a crash never runs a message twice. */
async function pollForever(api: TelegramApi, store: TopicStore, onUpdate: (update: TgUpdate) => void): Promise<never> {
  let backoffMs = 1000
  for (;;) {
    try {
      const updates = await api.getUpdates(store.lastUpdateId + 1)
      if (updates.length > 0) store.setLastUpdateId(Math.max(...updates.map(update => update.update_id)))
      for (const update of updates) onUpdate(update)
      backoffMs = 1000
    } catch (err) {
      if (err instanceof TelegramApiError && err.code === 401) throw new Error('Token bot sai (401). Kiểm tra TELEGRAM_BOT_TOKEN.')
      const conflict = err instanceof TelegramApiError && err.code === 409
      console.error(
        conflict
          ? '⚠️ 409: bot này đang được chương trình khác nhận tin (ví dụ plugin Telegram của Claude Code). Mỗi bot chỉ dùng ở một nơi.'
          : `⚠️ Lỗi nhận tin: ${errorText(err)}`,
      )
      await Bun.sleep(backoffMs)
      backoffMs = Math.min(backoffMs * 2, 30_000)
    }
  }
}

main().catch(err => {
  console.error(`❌ ${errorText(err)}`)
  process.exit(1)
})
