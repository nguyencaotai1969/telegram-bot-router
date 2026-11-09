import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TgMessage } from '../src/telegram-types'
import { TopicStore, topicKey } from '../src/topic-store'
import { GROUP_ID, OWNER_ID } from './helpers/fake-telegram'
import { fact, routerHarness } from './helpers/router-harness'

const OWNER = { id: OWNER_ID, is_bot: false, first_name: 'Owner' }
/** A bot message in topic `threadId` of the allowed group, as a button press carries it. */
const panelMessage = (threadId: number): TgMessage => ({
  message_id: 0,
  date: Math.floor(Date.now() / 1000),
  chat: { id: GROUP_ID, type: 'supergroup', is_forum: true },
  message_thread_id: threadId,
  is_topic_message: true,
})

describe('model per topic', () => {
  const env = routerHarness()
  afterAll(env.cleanUp)

  test('/model shows the model with buttons; a press saves it and the next message runs on it, same session', async () => {
    // Arrange: a warm process on the default model.
    const topic = await env.boundTopic()
    await topic.send('before switch')
    const before = await topic.answer('echo:before switch')
    await topic.idle()
    await topic.send('/model')
    const panel = env.api.log.find(item => item.kind === 'send' && item.threadId === topic.threadId && item.buttons)

    // Act
    await topic.press(panel?.messageId ?? -1, 'model:sonnet')
    await topic.send('after switch')
    const after = await topic.answer('echo:after switch')

    // Assert: one button per model Claude Code lists, older versions included, two per row.
    expect(panel?.text).toContain('🤖 Model: mặc định (Sonnet Test) · đang chạy: claude-default-test')
    expect(panel?.buttons).toEqual([
      ['model:default', 'model:opus'],
      ['model:sonnet', 'model:haiku'],
      ['model:claude-opus-4-8'],
    ])
    const redrawn = env.api.log.find(item => item.kind === 'edit' && item.messageId === panel?.messageId)
    expect(redrawn?.text).toStartWith('✅ Đã chọn Sonnet Test. Tin sau dùng model này')
    expect(redrawn?.buttons?.flat()).toHaveLength(5)
    expect(env.api.log.some(item => item.kind === 'answer' && item.text.includes('Đã chọn Sonnet Test'))).toBe(true)
    expect(env.store.get(topic.key)?.model).toBe('sonnet')
    expect(fact(before, 'model')).toBe('model:-')
    expect(fact(after, 'model')).toBe('model:sonnet')
    expect(fact(after, 'session')).toBe(fact(before, 'session'))
    // Switched in place: the warm process (and whatever Claude left running) lives on.
    expect(fact(after, 'pid')).toBe(fact(before, 'pid'))
  })

  test('an older version and back to the default both switch in place, same process and session', async () => {
    // Arrange
    const topic = await env.boundTopic()
    await topic.send('/model claude-opus-4-8')
    await topic.send('on opus 4.8')
    const older = await topic.answer('echo:on opus 4.8')
    await topic.idle()

    // Act
    await topic.send('/model default')
    await topic.send('on default')
    const back = await topic.answer('echo:on default')

    // Assert
    expect(fact(older, 'model')).toBe('model:claude-opus-4-8')
    expect(fact(back, 'model')).toBe('model:-')
    expect(fact(back, 'pid')).toBe(fact(older, 'pid'))
    expect(fact(back, 'session')).toBe(fact(older, 'session'))
  })

  test('a message right behind /model, in the same batch, already runs on the new model', async () => {
    // Arrange
    const topic = await env.boundTopic()

    // Act: one getUpdates batch hands both over without waiting in between.
    await Promise.all([topic.send('/model opus'), topic.send('right behind')])
    const reply = await topic.answer('echo:right behind')

    // Assert
    expect(fact(reply, 'model')).toBe('model:opus')
    expect(env.api.find('send', 'Đã chọn Opus Test. Tin sau dùng model này')).toBeDefined()
  })

  test('a model Claude Code does not list is refused', async () => {
    // Arrange
    const topic = await env.boundTopic()

    // Act
    await topic.send('/model claude-opus-4-1')

    // Assert
    expect(env.api.find('send', '⛔ Claude Code không có model "claude-opus-4-1"')).toBeDefined()
    expect(env.store.get(topic.key)?.model).toBeUndefined()
  })

  test('a press on a panel too old for Telegram to tell its topic changes nothing, and says so', async () => {
    // Arrange: the group's General topic is bound too; an old panel's press carries no topic.
    const topic = await env.boundTopic()
    const general = topicKey(GROUP_ID)
    env.store.bind(general, topic.folder)
    const chat = { id: GROUP_ID, type: 'supergroup' as const }

    // Act
    await env.router.handleButton({ id: 'old', from: OWNER, data: 'model:haiku', message: { message_id: 1, date: 0, chat } })

    // Assert
    expect(env.store.get(general)?.model).toBeUndefined()
    expect(env.api.log.some(item => item.kind === 'answer' && item.text.startsWith('old:') && item.text.includes('/model'))).toBe(true)
  })

  test('a press in a group that is not allowed, or without its message, changes nothing', async () => {
    // Arrange
    const topic = await env.boundTopic()
    const otherChat = { id: -100999, type: 'supergroup' as const, is_forum: true }
    const elsewhere = { message_id: 1, date: Math.floor(Date.now() / 1000), chat: otherChat, message_thread_id: topic.threadId, is_topic_message: true }

    // Act
    await env.router.handleButton({ id: 'elsewhere', from: OWNER, data: 'model:haiku', message: elsewhere })
    await env.router.handleButton({ id: 'nomessage', from: OWNER, data: 'model:haiku' })

    // Assert
    expect(env.store.get(topic.key)?.model).toBeUndefined()
    const refused = env.api.log.filter(item => item.kind === 'answer' && /^(elsewhere|nomessage):⛔/.test(item.text))
    expect(refused).toHaveLength(2)
  })

  test('two quick presses: the panel ends on the second choice even when the first answer is slow', async () => {
    // Arrange
    const topic = await env.boundTopic()
    await topic.send('/model')
    const panel = env.api.log.find(item => item.kind === 'send' && item.threadId === topic.threadId && item.buttons)
    env.api.answerDelay = id => (id === 'slow' ? 300 : 0)

    // Act
    const pressPanel = (id: string, data: string) =>
      env.router.handleButton({ id, from: OWNER, data, message: { ...panelMessage(topic.threadId), message_id: panel?.messageId ?? -1 } })
    const first = pressPanel('slow', 'model:opus')
    const second = pressPanel('fast', 'model:sonnet')
    await Promise.all([first, second])
    env.api.answerDelay = () => 0

    // Assert
    const edits = env.api.log.filter(item => item.kind === 'edit' && item.messageId === panel?.messageId)
    expect(env.store.get(topic.key)?.model).toBe('sonnet')
    expect(edits.at(-1)?.text).toContain('🤖 Model: Sonnet Test')
  })

  test('a model that cannot be saved is not applied either', async () => {
    // Arrange
    const topic = await env.boundTopic()
    await topic.send('/model opus')
    const writable = env.store as unknown as { save(): void }
    const save = writable.save
    writable.save = () => {
      throw new Error('EPERM: state.json is locked')
    }

    // Act
    try {
      await topic.send('/model haiku')
    } finally {
      writable.save = save
    }

    // Assert
    expect(env.api.find('send', '⚠️ Không lưu được')).toBeDefined()
    expect(env.store.get(topic.key)?.model).toBe('opus')
  })

  test('a model picked while Claude works does not interrupt it and applies to the next work', async () => {
    // Arrange
    const topic = await env.boundTopic()
    await topic.send('WAIT busy work')
    await topic.started()

    // Act
    await topic.send('/model haiku')
    await topic.send('joined while busy')
    const during = await topic.answer('echo:WAIT busy work + joined while busy')
    await topic.idle()
    await topic.send('after the work')
    const later = await topic.answer('echo:after the work')

    // Assert
    expect(env.api.find('send', '⏳ Áp dụng khi Claude xong việc đang làm.')).toBeDefined()
    expect(fact(during, 'model')).toBe('model:-')
    expect(fact(later, 'model')).toBe('model:haiku')
    expect(fact(later, 'session')).toBe(fact(during, 'session'))
  })

  test('/model by name, back to default, a bad name refused; /status shows the model', async () => {
    // Arrange
    const topic = await env.boundTopic()

    // Act
    await topic.send('/model Opus')
    const named = env.store.get(topic.key)?.model
    await topic.send('/status')
    await topic.send('/model rm -rf /')
    const afterBad = env.store.get(topic.key)?.model
    await topic.send('/model default')

    // Assert
    expect(named).toBe('opus')
    expect(env.api.log.some(item => item.threadId === topic.threadId && item.text.includes('🤖 Model: Opus Test'))).toBe(true)
    expect(env.api.find('send', '⛔ Tên model không hợp lệ.')).toBeDefined()
    expect(afterBad).toBe('opus')
    expect(env.store.get(topic.key)?.model).toBeUndefined()
  })

  test('a button press from someone not allowed changes nothing', async () => {
    // Arrange
    const topic = await env.boundTopic()
    await topic.send('/model')
    const panel = env.api.log.find(item => item.kind === 'send' && item.threadId === topic.threadId && item.buttons)

    // Act
    await topic.press(panel?.messageId ?? -1, 'model:haiku', 999)

    // Assert
    expect(env.store.get(topic.key)?.model).toBeUndefined()
    expect(env.api.log.some(item => item.kind === 'answer' && item.text.endsWith('⛔ Không được phép.'))).toBe(true)
  })
})

describe('when Claude Code cannot list its models', () => {
  // A "claude" that exits at once: it never answers `initialize`.
  const env = routerHarness({ claudeCommand: [process.execPath, '-e', 'process.exit(0)'] })
  afterAll(env.cleanUp)

  test('the panel offers the aliases of the latest models, and any valid name is accepted', async () => {
    // Arrange
    const topic = await env.boundTopic()

    // Act
    await topic.send('/model')
    await topic.send('/model claude-opus-4-1')

    // Assert
    const panel = env.api.log.find(item => item.kind === 'send' && item.threadId === topic.threadId && item.buttons)
    expect(panel?.buttons?.flat()).toEqual(['model:default', 'model:fable', 'model:opus', 'model:sonnet', 'model:haiku'])
    expect(env.store.get(topic.key)?.model).toBe('claude-opus-4-1')
  })
})

describe('when Claude Code is slow to list its models', () => {
  // A "claude" that never answers `initialize` (and goes away by itself after 3 s).
  const env = routerHarness({ claudeCommand: [process.execPath, join(import.meta.dir, 'fixtures', 'silent-claude.ts')] })
  afterAll(env.cleanUp)

  test('/status never waits for the list, and /model waits only briefly before offering the aliases', async () => {
    // Arrange
    const topic = await env.boundTopic()

    // Act
    const statusStarted = Date.now()
    await topic.send('/status')
    const statusMs = Date.now() - statusStarted
    const panelStarted = Date.now()
    await topic.send('/model')
    const panelMs = Date.now() - panelStarted

    // Assert
    expect(statusMs).toBeLessThan(1000)
    expect(panelMs).toBeLessThan(4000)
    const panel = env.api.log.find(item => item.kind === 'send' && item.threadId === topic.threadId && item.buttons)
    expect(panel?.buttons?.flat()).toEqual(['model:default', 'model:fable', 'model:opus', 'model:sonnet', 'model:haiku'])
  })
})

describe('model in the topic store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-store-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('the topic model survives a restart and a /bind to another folder; a bad one in state.json is dropped', () => {
    // Arrange
    const file = join(dir, 'state.json')
    const store = new TopicStore(file)
    store.bind('-100:1', 'D:\\a')
    store.setModel('-100:1', 'sonnet')

    // Act
    store.bind('-100:1', 'D:\\b')
    const reloaded = new TopicStore(file).get('-100:1')
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ lastUpdateId: 1, topics: { '-100:2': { cwd: 'D:\\c', boundAt: 1, model: 'x; rm' } } }))
    const bad = new TopicStore(join(dir, 'bad.json')).get('-100:2')

    // Assert
    expect(reloaded).toMatchObject({ cwd: 'D:\\b', model: 'sonnet' })
    expect(bad?.cwd).toBe('D:\\c')
    expect(bad?.model).toBeUndefined()
    expect(store.setModel('-100:9', 'opus')).toBe(false)
  })
})
