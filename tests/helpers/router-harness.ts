import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouterConfig } from '../../src/config'
import { MessageRouter } from '../../src/message-router'
import { RunScheduler } from '../../src/run-scheduler'
import { TopicConversations } from '../../src/topic-conversations'
import { TopicStore, topicKey } from '../../src/topic-store'
import { FakeBotApi, GROUP_ID, OWNER_ID, testConfig, topicMessage, waitFor } from './fake-telegram'

/** One `name:value` fact of the fake claude's answer. */
export const fact = (text: string | undefined, name: string) => text?.split('|').find(part => part.startsWith(`${name}:`))

/** A router on the fake claude in a temp folder, and fresh topics bound to their own project folders. */
export function routerHarness(extra: Partial<RouterConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'router-harness-'))
  const api = new FakeBotApi()
  const store = new TopicStore(join(dir, 'state.json'))
  const config = testConfig(dir, extra)
  const scheduler = new RunScheduler(config.maxParallelRuns)
  const conversations = new TopicConversations()
  const router = new MessageRouter({ api, config, store, scheduler, conversations, botUsername: 'router_bot', inboxDir: join(dir, 'inbox') })
  let nextThreadId = 200
  let nextQueryId = 1

  async function boundTopic() {
    const threadId = nextThreadId++
    const folder = join(dir, `project-${threadId}`)
    mkdirSync(folder)
    const key = topicKey(GROUP_ID, threadId)
    const send = (text: string) => router.handle([topicMessage(text, { message_thread_id: threadId })])
    await send(`/bind ${folder}`)
    const answer = (needle: string) => waitFor(() => api.find('send', needle)?.text)
    const idle = () => waitFor(() => !scheduler.status(key).busy)
    /** Claude has started this topic's session (its process is up and working). */
    const started = () => waitFor(() => store.get(key)?.sessionId)
    /** Presses the inline button with `data` on the bot message `messageId` of this topic, as it reads now. */
    const press = (messageId: number, data: string, fromId = OWNER_ID) =>
      router.handleButton({
        id: `q${nextQueryId++}`,
        from: { id: fromId, is_bot: false, first_name: 'Someone' },
        data,
        message: {
          message_id: messageId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: GROUP_ID, type: 'supergroup', is_forum: true },
          message_thread_id: threadId,
          is_topic_message: true,
          text: api.log.filter(item => (item.kind === 'send' || item.kind === 'edit') && item.messageId === messageId).at(-1)?.text,
        },
      })
    return { threadId, key, folder, send, answer, idle, started, press }
  }

  const cleanUp = async () => {
    await conversations.shutDownAll()
    scheduler.stopAll()
    // A helper claude (e.g. one asked for the model list) may hold the folder a moment longer on Windows.
    for (let attempt = 1; ; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        return
      } catch (err) {
        if (attempt >= 60) throw err
        await Bun.sleep(100)
      }
    }
  }
  return { api, store, scheduler, conversations, router, boundTopic, cleanUp }
}
