import { afterAll, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { topicMessage, waitFor } from './helpers/fake-telegram'
import { fact, routerHarness as setup } from './helpers/router-harness'

type Env = ReturnType<typeof setup>

/** The first message the bot sent in this topic that starts with `prefix`. */
const firstSent = (env: Env, threadId: number, prefix: string) =>
  env.api.log.find(item => item.kind === 'send' && item.threadId === threadId && item.text.startsWith(prefix))

describe('what Claude says and sends besides its final answer', () => {
  const env = setup()
  afterAll(env.cleanUp)
  const sentIn = (threadId: number, prefix: string) => firstSent(env, threadId, prefix)

  test('a turn Claude begins by itself when its background task finishes is shown in the topic with its answer', async () => {
    // Arrange
    const topic = await env.boundTopic()
    await topic.send('BACKGROUND start the bot')
    await topic.answer('echo:BACKGROUND start the bot')

    // Act: the task finishes after the answer; Claude works again with no message from the user.
    const own = await waitFor(() => sentIn(topic.threadId, 'bg-done'), 8000)

    // Assert
    const status = sentIn(topic.threadId, '🔔 Claude tự làm tiếp')
    expect(status).toBeDefined()
    expect(own.replyTo).toBeUndefined()
    await waitFor(() => env.api.log.find(item => item.kind === 'edit' && item.messageId === status?.messageId && item.text.startsWith('✅ Xong')))
  })

  test('during a turn Claude began by itself, /new is refused and a message joins that turn', async () => {
    // Arrange
    const topic = await env.boundTopic()
    await topic.send('BACKGROUND_WAIT start the bot')
    const first = await topic.answer('echo:BACKGROUND_WAIT start the bot')
    await waitFor(() => sentIn(topic.threadId, '🔔 Claude tự làm tiếp'), 8000)

    // Act
    await topic.send('/new')
    await topic.send('is it running?')
    const own = await waitFor(() => sentIn(topic.threadId, 'bg-done'), 8000)
    await topic.send('after it')
    const after = await topic.answer('echo:after it')

    // Assert
    expect(sentIn(topic.threadId, '⛔ Topic đang chạy việc')).toBeDefined()
    expect(sentIn(topic.threadId, '📨 Đã gửi vào việc đang chạy')).toBeDefined()
    expect(own.text).toContain('echo:is it running?')
    expect(fact(after, 'session')).toBe(fact(first, 'session'))
  })

  test('a message read mid-turn gets the next thing Claude says as its own reply, before the turn ends', async () => {
    // Arrange
    const topic = await env.boundTopic()
    await topic.send('WAIT first part')
    const ask = topicMessage('ASK how far along?', { message_thread_id: topic.threadId })

    // Act
    await env.router.handle([ask])
    const final = await topic.answer('echo:WAIT first part + ASK how far along?')

    // Assert
    const reply = sentIn(topic.threadId, 'heard:ASK how far along?')
    expect(reply?.replyTo).toBe(ask.message_id)
    const order = (text: string) => env.api.log.findIndex(item => item.kind === 'send' && item.text === text)
    expect(order('heard:ASK how far along?')).toBeLessThan(order(final))
  })

  test('📎 lines send their files to the topic as photos and stay out of the answer; a missing file gets a note', async () => {
    // Arrange
    const topic = await env.boundTopic()
    const picture = join(topic.folder, 'pic.png')
    writeFileSync(picture, new Uint8Array(64))
    const ask = topicMessage(`ATTACH=${picture} show me`, { message_thread_id: topic.threadId })

    // Act
    await env.router.handle([ask])
    const answer = await topic.answer('echo:ATTACH=')
    await waitFor(() => sentIn(topic.threadId, '⚠️ Không gửi được tệp pic.png.missing.png'))

    // Assert
    const files = env.api.log.filter(item => item.kind === 'file' && item.threadId === topic.threadId)
    expect(files.map(item => item.text)).toEqual(['pic.png:photo:giữa chừng', 'pic.png:photo:cuối'])
    expect(files[1]?.replyTo).toBe(ask.message_id)
    expect(answer).not.toContain('📎')
    const at = (item: object | undefined) => env.api.log.indexOf(item as never)
    const answerItem = env.api.log.find(item => item.kind === 'send' && item.text === answer)
    expect(at(files[0])).toBeLessThan(at(answerItem))
    expect(at(answerItem)).toBeLessThan(at(files[1]))
  })

  test('a background sub-agent working around the result line starts no turn and makes nothing go out twice', async () => {
    // Arrange
    const topic = await env.boundTopic()
    const picture = join(topic.folder, 'sub.png')
    writeFileSync(picture, new Uint8Array(64))

    // Act: its calls land between Claude's final text and the result line, and after the result.
    await topic.send(`SUBAGENT ATTACH=${picture}`)
    await topic.answer('echo:SUBAGENT')
    await waitFor(() => sentIn(topic.threadId, '⚠️ Không gửi được tệp sub.png.missing.png'))
    await Bun.sleep(500)

    // Assert
    const files = env.api.log.filter(item => item.kind === 'file' && item.threadId === topic.threadId)
    expect(files.map(item => item.text)).toEqual(['sub.png:photo:giữa chừng', 'sub.png:photo:cuối'])
    const notes = env.api.log.filter(item => item.threadId === topic.threadId && item.text.startsWith('⚠️ Không gửi được tệp'))
    expect(notes).toHaveLength(1)
    expect(sentIn(topic.threadId, '🔔')).toBeUndefined()
    expect(env.conversations.busy(env.scheduler, topic.key)).toBe(false)
  })
})

describe('a turn Claude begins by itself, with one slot for the whole bot', () => {
  const env = setup({ maxParallelRuns: 1 })
  afterAll(env.cleanUp)

  test('it is shown at once, but a message sent meanwhile waits for the slot like any other', async () => {
    // Arrange: topic B's Claude begins a turn by itself while topic A holds the only slot.
    const a = await env.boundTopic()
    const b = await env.boundTopic()
    await b.send('BACKGROUND_WAIT start the bot')
    await b.answer('echo:BACKGROUND_WAIT start the bot')
    await a.send('SLOW holds the only slot')
    await a.started()
    await waitFor(() => firstSent(env, b.threadId, '🔔 Claude tự làm tiếp'), 8000)

    // Act
    await b.send('join me')
    const own = await waitFor(() => firstSent(env, b.threadId, 'bg-done'), 8000)
    await a.send('/stop')
    const joined = await b.answer('echo:join me')

    // Assert
    expect(firstSent(env, b.threadId, '🕒 Đang chờ lượt')).toBeDefined()
    expect(own.text).not.toContain('join me')
    expect(joined).toContain('echo:join me')
  })
})
