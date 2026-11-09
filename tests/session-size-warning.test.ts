import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageRouter } from '../src/message-router'
import { RunScheduler } from '../src/run-scheduler'
import { describeUsage, formatTokens, isOverLimit } from '../src/session-size-warning'
import { TopicConversations } from '../src/topic-conversations'
import { TopicStore, topicKey } from '../src/topic-store'
import { FakeBotApi, GROUP_ID, testConfig, topicMessage, waitFor } from './helpers/fake-telegram'

const limits = { contextWarnTokens: 150_000, sessionWarnMessages: 3 }

describe('session size helpers', () => {
  test('token counts read as short numbers', () => {
    expect([950, 1_000, 209_824, 999_600, 1_000_000, 1_260_000].map(formatTokens)).toEqual(['950', '1k', '210k', '1M', '1M', '1.3M'])
  })

  test('usage reads as size, share of the window and message count', () => {
    expect(describeUsage({ messages: 18, contextTokens: 209_824, contextWindow: 1_000_000 })).toBe('210k token (21% của 1M) · 18 tin')
    expect(describeUsage({ messages: 1, contextTokens: 900 })).toBe('900 token · 1 tin')
  })

  test('a session is over the limit by context or by messages, and a limit of 0 is off', () => {
    expect(isOverLimit({ messages: 1, contextTokens: 149_999 }, limits)).toBe(false)
    expect(isOverLimit({ messages: 1, contextTokens: 150_000 }, limits)).toBe(true)
    expect(isOverLimit({ messages: 3, contextTokens: 1_000 }, limits)).toBe(true)
    expect(isOverLimit({ messages: 99, contextTokens: 999_999 }, { contextWarnTokens: 0, sessionWarnMessages: 0 })).toBe(false)
  })
})

describe('session size warning in the topic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'size-test-'))
  const api = new FakeBotApi()
  const store = new TopicStore(join(dir, 'state.json'))
  const scheduler = new RunScheduler(2)
  const conversations = new TopicConversations()
  const router = new MessageRouter({
    api,
    config: testConfig(dir, limits),
    store,
    scheduler,
    conversations,
    botUsername: 'router_bot',
    inboxDir: join(dir, 'inbox'),
  })
  let nextThreadId = 100

  /** A fresh topic bound to its own project folder: every test has its own session. */
  async function boundTopic() {
    const threadId = nextThreadId++
    const folder = join(dir, `project-${threadId}`)
    mkdirSync(folder)
    const key = topicKey(GROUP_ID, threadId)
    const send = (text: string) => router.handle([topicMessage(text, { message_thread_id: threadId })])
    await send(`/bind ${folder}`)
    /** Sends one request and waits until its run (answer and any warning) is over. */
    const runToEnd = async (text: string) => {
      await send(text)
      await waitFor(() => api.find('send', `echo:${text}`))
      await waitFor(() => !scheduler.status(key).busy)
    }
    const warnings = () =>
      api.log.filter(item => item.kind === 'send' && item.threadId === threadId && item.text.startsWith('⚠️ Phiên này đã nặng'))
    return { threadId, key, send, runToEnd, warnings }
  }

  afterAll(async () => {
    await conversations.shutDownAll()
    scheduler.stopAll()
    rmSync(dir, { recursive: true, force: true })
  })

  test('a big context warns once in the topic, later runs only remind on the summary line', async () => {
    // Arrange
    const topic = await boundTopic()

    // Act
    await topic.runToEnd('CONTEXT=160000 big first')
    await topic.runToEnd('CONTEXT=170000 big second')

    // Assert
    const [warning, ...more] = topic.warnings()
    expect(more).toHaveLength(0)
    expect(warning?.text).toContain('160k token (16% của 1M) · 1 tin')
    expect(warning?.text).toContain('/new')
    expect(api.find('edit', '🧠 170k\n⚠️ Phiên đã nặng: gõ /new')).toBeDefined()
    // The background sub-agent's 999 999-token call does not count as the session's context.
    expect(store.get(topic.key)?.usage).toMatchObject({ messages: 2, contextTokens: 170_000, contextWindow: 1_000_000 })
  })

  test('a context that dips under the limit and climbs back is not warned twice in one session', async () => {
    // Arrange
    const topic = await boundTopic()
    await topic.runToEnd('CONTEXT=160000 dip one')

    // Act
    await topic.runToEnd('CONTEXT=100000 dip two')
    await topic.runToEnd('CONTEXT=165000 dip three')

    // Assert
    expect(topic.warnings()).toHaveLength(1)
  })

  test('/status shows the session size and /new forgets it, so the next heavy session warns again', async () => {
    // Arrange
    const topic = await boundTopic()
    await topic.runToEnd('CONTEXT=170000 status run')

    // Act
    await topic.send('/status')
    await topic.send('/new@router_bot')
    const afterNew = store.get(topic.key)?.usage
    await topic.runToEnd('CONTEXT=155000 after new')

    // Assert
    expect(api.find('send', '🧠 Ngữ cảnh: 170k token (17% của 1M) · 1 tin ⚠️ nên /new')).toBeDefined()
    expect(afterNew).toBeUndefined()
    expect(topic.warnings()).toHaveLength(2)
  })

  test('a long session with a small context warns once when it reaches the message limit', async () => {
    // Arrange
    const topic = await boundTopic()
    await topic.runToEnd('small one')
    await topic.runToEnd('small two')
    const beforeLimit = topic.warnings().length

    // Act
    await topic.runToEnd('small three')
    await topic.runToEnd('small four')

    // Assert
    expect(beforeLimit).toBe(0)
    expect(topic.warnings()).toHaveLength(1)
    expect(topic.warnings()[0]?.text).toContain('1k token (0% của 1M) · 3 tin')
    expect(api.find('edit', '· 🧠 1k')?.text).toStartWith('✅ Xong')
  })

  test('a stopped run still counts the context it reached', async () => {
    // Arrange
    const topic = await boundTopic()
    await topic.send('SLOW CONTEXT=300000 stopped')
    // Claude has started this topic's session; its first step (with the context size) comes in the same breath.
    await waitFor(() => store.get(topic.key)?.sessionId)
    await Bun.sleep(300)

    // Act
    await topic.send('/stop')
    await waitFor(() => !scheduler.status(topic.key).busy)

    // Assert
    expect(store.get(topic.key)?.usage).toMatchObject({ messages: 1, contextTokens: 299_500 })
    expect(api.find('edit', '⏹️ Đã dừng ·')?.text).toContain('🧠 300k')
    expect(topic.warnings()).toHaveLength(1)
  })

  test('when state.json cannot be written, the answer still arrives and the run finishes', async () => {
    // Arrange
    const topic = await boundTopic()
    const writable = store as unknown as { save(): void }
    const save = writable.save
    writable.save = () => {
      throw new Error('EPERM: state.json is locked')
    }

    // Act
    try {
      await topic.send('CONTEXT=170000 locked disk')
      await waitFor(() => api.find('send', 'echo:CONTEXT=170000 locked disk'))
      await waitFor(() => !scheduler.status(topic.key).busy)
    } finally {
      writable.save = save
    }

    // Assert: this run's own status message ended on its summary, not on "⏳ … đang làm".
    const status = api.log.find(item => item.kind === 'send' && item.threadId === topic.threadId && item.text === '⏳ Bắt đầu…')
    const edits = api.log.filter(item => item.kind === 'edit' && item.messageId === status?.messageId)
    expect(edits.at(-1)?.text).toStartWith('✅ Xong')
  })
})
