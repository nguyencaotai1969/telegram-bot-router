import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeProcessFor, startClaudeProcess } from '../src/topic-claude-process'
import type { Conversation } from '../src/topic-conversations'
import type { RunDeps } from '../src/topic-run'
import { TopicStore, topicKey } from '../src/topic-store'
import { GROUP_ID, testConfig, topicMessage, waitFor } from './helpers/fake-telegram'
import { fact, routerHarness as setup } from './helpers/router-harness'

describe('warm Claude process per topic', () => {
  const env = setup()
  afterAll(env.cleanUp)

  test('the second message reuses the warm process, and /status says it is up', async () => {
    // Arrange
    const topic = await env.boundTopic()
    await topic.send('warm one')
    const first = await topic.answer('echo:warm one')
    await topic.idle()

    // Act
    await topic.send('/status')
    await topic.send('warm two')
    const second = await topic.answer('echo:warm two')

    // Assert
    expect(fact(second, 'pid')).toBe(fact(first, 'pid'))
    expect(fact(second, 'resumed')).toBe('resumed:-')
    expect(env.api.find('send', '🔥 Claude: đang chạy sẵn')).toBeDefined()
  })

  test('a message sent while Claude works joins the running turn: acked at once, answered together', async () => {
    // Arrange
    const topic = await env.boundTopic()
    await topic.send('WAIT first part')

    // Act
    await topic.send('second part')
    const reply = await topic.answer('echo:WAIT first part')
    await topic.idle()

    // Assert
    expect(reply).toContain('echo:WAIT first part + second part')
    const ack = env.api.log.find(item => item.kind === 'send' && item.text.startsWith('📨 Đã gửi vào việc đang chạy'))
    expect(ack?.threadId).toBe(topic.threadId)
    expect(env.api.log.some(item => item.kind === 'edit' && item.messageId === ack?.messageId && item.text.startsWith('📨 Claude đã đọc'))).toBe(true)
    const answers = env.api.log.filter(item => item.kind === 'send' && item.threadId === topic.threadId && item.text.includes('echo:'))
    expect(answers).toHaveLength(1)
  })

  test('/stop with nothing running frees the warm process; the next message resumes the session in a new one', async () => {
    // Arrange
    const topic = await env.boundTopic()
    await topic.send('before stop')
    const before = await topic.answer('echo:before stop')
    await topic.idle()

    // Act
    await topic.send('/stop')
    const stateAfterStop = env.conversations.state(topic.key)
    await topic.send('after stop')
    const after = await topic.answer('echo:after stop')

    // Assert
    expect(env.api.find('send', '⏹️ Đã tắt Claude của topic này')).toBeDefined()
    expect(stateAfterStop).toBe('off')
    expect(fact(after, 'pid')).not.toBe(fact(before, 'pid'))
    expect(fact(after, 'resumed')).toBe(`resumed:${fact(before, 'session')?.slice('session:'.length)}`)
  })

  test('a process that died between messages is replaced by the next message, in the same session', async () => {
    // Arrange
    const topic = await env.boundTopic()
    await topic.send('EXIT_AFTER bye')
    const before = await topic.answer('echo:EXIT_AFTER bye')
    await topic.idle()
    await waitFor(() => env.conversations.state(topic.key) === 'off')

    // Act
    await topic.send('back again')
    const after = await topic.answer('echo:back again')

    // Assert
    expect(fact(after, 'pid')).not.toBe(fact(before, 'pid'))
    expect(fact(after, 'session')).toBe(fact(before, 'session'))
  })
})

describe('stop, then carry on', () => {
  const env = setup()
  afterAll(env.cleanUp)

  test('a message sent right after /stop is answered once the old work has stopped', async () => {
    // Arrange
    const topic = await env.boundTopic()
    await topic.send('SLOW old work')
    await topic.started()

    // Act
    await topic.send('/stop')
    await topic.send('do this instead')
    const reply = await topic.answer('echo:do this instead')

    // Assert
    expect(reply).not.toContain('old work')
    expect(env.api.find('edit', '⏹️ Đã dừng ·')).toBeDefined()
    expect(env.api.find('edit', '⏹️ Đã bỏ')).toBeUndefined()
  })

  test('two turns in a row: the first answer is posted in full before the second one', async () => {
    // Arrange: the long first answer goes out slowly, chunk by chunk.
    const topic = await env.boundTopic()
    env.api.sendDelay = text => (text.startsWith('y'.repeat(50)) ? 400 : 0)
    const first = topicMessage('MEDIUM first', { message_thread_id: topic.threadId })
    await env.router.handle([first])
    const status = await waitFor(() => env.api.log.find(item => item.kind === 'send' && item.replyTo === first.message_id))
    await waitFor(() => env.api.log.find(item => item.kind === 'edit' && item.messageId === status.messageId && item.text.startsWith('✅')))

    // Act: the second request comes while the first answer is still being posted.
    try {
      await topic.send('quick second')
      await topic.answer('echo:quick second')
      await topic.answer('echo:MEDIUM first')
    } finally {
      env.api.sendDelay = () => 0
    }

    // Assert
    const posted = env.api.log.filter(item => item.kind === 'send' && item.threadId === topic.threadId)
    const lastOfFirst = posted.findIndex(item => item.text.includes('echo:MEDIUM first'))
    const second = posted.findIndex(item => item.text.includes('echo:quick second'))
    expect(lastOfFirst).toBeGreaterThanOrEqual(0)
    expect(second).toBeGreaterThan(lastOfFirst)
  })
})

describe('one slot for the whole bot', () => {
  const env = setup({ maxParallelRuns: 1 })
  afterAll(env.cleanUp)

  test('/stop of a topic still waiting for the slot drops its work; what is sent after starts fresh', async () => {
    // Arrange
    const holder = await env.boundTopic()
    const waiting = await env.boundTopic()
    await holder.send('SLOW holds the only slot')
    await holder.started()
    await waiting.send('first waiting')

    // Act
    await waiting.send('/stop')
    await waiting.send('second waiting')
    await holder.send('/stop')
    const second = await waiting.answer('echo:second waiting')

    // Assert
    expect(second).not.toContain('first waiting')
    expect(env.api.find('send', 'echo:first waiting')).toBeUndefined()
  })
})

describe('the topic process a busy period gets', () => {
  test('a stop that comes while the old process is dying starts no new Claude', async () => {
    // Arrange: a topic whose process is busy, and a period that owns it.
    const dir = mkdtempSync(join(tmpdir(), 'proc-test-'))
    const store = new TopicStore(join(dir, 'state.json'))
    const key = topicKey(GROUP_ID, 1)
    store.bind(key, dir)
    const deps = { store, config: testConfig(dir) } as unknown as RunDeps
    const conv: Conversation = { key, reporting: Promise.resolve() }
    const owner = { stopped: false, finished: false, onEvent: () => {}, onEnd: () => {} }
    const first = startClaudeProcess(deps, conv, owner, dir, undefined)
    if (typeof first === 'string') throw new Error(first)
    first.live.send('SLOW busy')

    // Act: the time limit kills it; a new message asks for the process; then /stop.
    first.live.kill()
    const asked = claudeProcessFor(deps, conv, owner, true)
    owner.stopped = true
    const got = await asked

    // Assert
    try {
      expect(got).toBe('⏹️ Đã bỏ (lệnh /stop).')
      expect(conv.process).toBeUndefined()
    } finally {
      if (typeof got !== 'string') got.live.kill()
      if (typeof got !== 'string') await got.live.ended
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('warm process time limit', () => {
  const env = setup({ runTimeoutMs: 1500 })
  afterAll(env.cleanUp)

  test('a turn past its time limit is stopped with its process, and the topic works again after', async () => {
    // Arrange
    const topic = await env.boundTopic()

    // Act
    await topic.send('SLOW never ends')
    await waitFor(() => env.api.find('edit', '⌛ Quá'))
    await topic.idle()
    await topic.send('next one')
    const next = await topic.answer('echo:next one')

    // Assert
    expect(env.api.find('send', 'echo:SLOW never ends')).toBeUndefined()
    expect(fact(next, 'turn')).toBe('turn:1')
  })

  test('a message arriving while a timed-out process is still dying gets its own turn; the old one shows ⌛', async () => {
    // Arrange: the turn opens right after this message is written; its 1.5 s limit kills the process.
    const topic = await env.boundTopic()
    const slow = topicMessage('SLOW will time out', { message_thread_id: topic.threadId })
    const quick = topicMessage('quick after timeout', { message_thread_id: topic.threadId })

    // Act: the next message lands a moment after the kill, before the process is gone.
    await env.router.handle([slow])
    await Bun.sleep(1530)
    await env.router.handle([quick])
    const answer = await waitFor(() => env.api.find('send', 'echo:quick after timeout'))
    await topic.idle()

    // Assert
    const slowStatus = env.api.log.find(item => item.kind === 'send' && item.replyTo === slow.message_id)
    const slowEdits = env.api.log.filter(item => item.kind === 'edit' && item.messageId === slowStatus?.messageId)
    expect(slowEdits.at(-1)?.text).toStartWith('⌛')
    expect(answer.replyTo).toBe(quick.message_id)
    expect(answer.text).not.toContain('SLOW will time out')
  })
})
