import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageRouter } from '../src/message-router'
import { RunScheduler } from '../src/run-scheduler'
import { TopicConversations } from '../src/topic-conversations'
import { TopicStore, topicKey } from '../src/topic-store'
import { FakeBotApi, GROUP_ID, OWNER_ID, TOPIC_ID, testConfig, topicMessage, waitFor } from './helpers/fake-telegram'

const dir = mkdtempSync(join(tmpdir(), 'router-test-'))
const project = join(dir, 'project')
mkdirSync(project)
const api = new FakeBotApi()
const store = new TopicStore(join(dir, 'state.json'))
const scheduler = new RunScheduler(2)
const conversations = new TopicConversations()
const config = testConfig(dir)
const router = new MessageRouter({ api, config, store, scheduler, conversations, botUsername: 'router_bot', inboxDir: join(dir, 'inbox') })
const key = topicKey(GROUP_ID, TOPIC_ID)

const send = (text: string, extra = {}) => router.handle([topicMessage(text, extra)])
const answer = (needle: string) => waitFor(() => api.find('send', needle))
/** One `name:value` fact of the fake claude's answer. */
const fact = (text: string | undefined, name: string) => text?.split('|').find(part => part.startsWith(`${name}:`))

beforeAll(() => {
  process.env.TELEGRAM_BOT_TOKEN = 'must-not-reach-claude'
  process.env.CLAUDECODE = '1'
})
afterAll(async () => {
  await conversations.shutDownAll()
  scheduler.stopAll()
  rmSync(dir, { recursive: true, force: true })
})

describe('message router', () => {
  test('ignores people who are not allowed', async () => {
    await send('hello', { from: { id: 999, is_bot: false, first_name: 'Stranger' } })
    expect(api.log).toHaveLength(0)
  })

  test('tells the owner the id of a group that is not allowed yet', async () => {
    await send('hello', { chat: { id: -100999, type: 'supergroup', is_forum: true } })
    expect(api.find('send', '-100999')?.text).toContain('ALLOWED_CHAT_IDS')
  })

  test('an unbound topic asks for /bind', async () => {
    await send('hello')
    expect(api.find('send', 'chưa gắn dự án')).toBeDefined()
  })

  test('/bind refuses a missing folder and binds a real one', async () => {
    await send(`/bind ${join(dir, 'nope')}`)
    expect(api.find('send', 'Không thấy thư mục')).toBeDefined()
    await send(`/bind@router_bot "${project}"`)
    expect(api.find('send', '✅ Topic này giờ làm việc ở')).toBeDefined()
    expect(store.get(key)?.cwd).toBe(project)
  })

  test('a message runs Claude in the project, in the topic, without the bot token', async () => {
    const message = topicMessage('hello')
    await router.handle([message])
    const reply = await answer('echo:hello')
    expect(reply.threadId).toBe(TOPIC_ID)
    expect(reply.replyTo).toBe(message.message_id)
    expect(reply.text.toLowerCase()).toContain(`cwd:${project.toLowerCase()}`)
    expect(reply.text).toContain('token:none')
    expect(reply.text).toContain('nested:no')
    expect(reply.text).toContain('perm:skip')
    expect(reply.text).toContain(`plugin:${join(dir, 'telegram-plugin-off')}`)
    expect(reply.text).toContain('resumed:-')
    await waitFor(() => api.find('edit', '✅ Xong'))
    expect(api.find('edit', '💻 Bash: npm test')).toBeDefined()
    expect(store.get(key)?.sessionId).toBeString()
  })

  test('the next message goes to the same warm Claude process, in the same session', async () => {
    // Arrange
    const first = api.find('send', 'echo:hello')?.text
    await waitFor(() => !scheduler.status(key).busy)

    // Act
    await send('again')
    const second = (await answer('echo:again')).text

    // Assert
    expect(fact(second, 'pid')).toBe(fact(first, 'pid'))
    expect(fact(second, 'turn')).toBe('turn:2')
    expect(fact(second, 'session')).toBe(`session:${store.get(key)?.sessionId}`)
  })

  test('/new ends the process and the next message starts a fresh session', async () => {
    // Arrange
    const before = api.find('send', 'echo:again')?.text
    await waitFor(() => !scheduler.status(key).busy)

    // Act
    await send('/new')
    await send('fresh')
    const reply = (await answer('echo:fresh')).text

    // Assert
    expect(fact(reply, 'resumed')).toBe('resumed:-')
    expect(fact(reply, 'pid')).not.toBe(fact(before, 'pid'))
    expect(fact(reply, 'session')).not.toBe(fact(before, 'session'))
  })

  test('a session Claude no longer has is dropped and the message runs fresh', async () => {
    // Arrange: the router restarted, and the session it remembers is gone from Claude.
    await waitFor(() => !scheduler.status(key).busy)
    conversations.shutDown(key)
    store.setSession(key, 'deadbeef-0000-4000-8000-000000000000')

    // Act
    await send('after restart')
    const reply = (await answer('echo:after restart')).text

    // Assert
    expect(fact(reply, 'resumed')).toBe('resumed:-')
    expect(store.get(key)?.sessionId).not.toStartWith('deadbeef')
    expect(api.find('edit', '🆕 Phiên cũ không còn')).toBeDefined()
  })

  test('a finished run is never run again, whatever its stderr says', async () => {
    await send('NOISY_STDERR task')
    await answer('echo:NOISY_STDERR task')
    await waitFor(() => !scheduler.status(key).busy)
    await Bun.sleep(300)
    expect(api.log.filter(item => item.kind === 'send' && item.text.includes('echo:NOISY_STDERR'))).toHaveLength(1)
  })

  test('/stop right after a photo stops it, even while the photo still downloads', async () => {
    api.downloadDelayMs = 600
    api.files.set('photo-stop', new Uint8Array([1]))
    const photo = [{ file_id: 'photo-stop', width: 1, height: 1 }]
    await send('', { text: undefined, caption: 'PHOTO_STOP', photo })
    await send(`/bind ${project}`)
    expect(api.find('send', '⛔ Topic đang chạy việc')).toBeDefined()
    await send('/stop')
    expect(api.log.filter(item => item.text.startsWith('⏹️ Đã dừng.'))).toHaveLength(1)
    await waitFor(() => !scheduler.status(key).busy)
    api.downloadDelayMs = 0
    await Bun.sleep(300)
    expect(api.find('send', 'echo:PHOTO_STOP')).toBeUndefined()
  })

  test('a folder serves one topic only, and a forwarded text is marked as someone else’s', async () => {
    await send(`/bind ${project}`, { message_thread_id: TOPIC_ID + 1 })
    expect(api.find('send', '⛔ Thư mục này đã gắn với topic')).toBeDefined()
    await send('please check', { forward_origin: { type: 'user' } })
    expect((await answer('echo:[Tin chuyển tiếp')).text).toContain('please check')
  })

  test('/stop ends a running job', async () => {
    // Arrange: the job's turn is open (its status message shows "⏳ … đang làm").
    const job = topicMessage('SLOW job')
    await router.handle([job])
    const status = await waitFor(() => api.log.find(item => item.kind === 'send' && item.replyTo === job.message_id))
    await waitFor(() => api.log.find(item => item.kind === 'edit' && item.messageId === status.messageId && item.text.startsWith('⏳')))

    // Act
    await send('/stop')

    // Assert
    expect(api.find('send', '⏹️ Đã dừng')).toBeDefined()
    await waitFor(() => api.log.find(item => item.kind === 'edit' && item.messageId === status.messageId && item.text.startsWith('⏹️ Đã dừng ·')))
    await waitFor(() => !scheduler.status(key).busy)
  })

  test('a long answer is sent as a file', async () => {
    await send('LONG')
    const doc = await waitFor(() => api.log.find(item => item.kind === 'document'))
    expect(doc.text).toBe('ket-qua.txt:30000')
  })

  test('a crash shows what Claude printed', async () => {
    await send('CRASH now')
    expect((await answer('boom: something broke')).threadId).toBe(TOPIC_ID)
    await waitFor(() => api.find('edit', 'thoát bất thường (mã 3)'))
  })

  test('a photo is saved and its path handed to Claude', async () => {
    api.files.set('photo-1', new Uint8Array([1, 2, 3]))
    const photo = [{ file_id: 'photo-1', width: 10, height: 10, file_size: 3 }]
    await send('', { text: undefined, caption: 'look at this', photo })
    const reply = await answer('echo:look at this')
    expect(reply.text).toContain(join(dir, 'inbox'))
  })

  test('commands for another bot and messages sent while the bot was off are skipped', async () => {
    const before = api.log.length
    await send('/status@other_bot')
    expect(api.log).toHaveLength(before)
    await send('old work', { date: Math.floor(Date.now() / 1000) - 3600 })
    expect(api.find('send', 'Bỏ qua tin gửi lúc bot đang tắt')).toBeDefined()
  })

  test('/id answers anywhere for the owner', async () => {
    await send('/id', { chat: { id: OWNER_ID, type: 'private' }, is_topic_message: false })
    expect(api.find('send', `user_id: ${OWNER_ID}`)).toBeDefined()
  })
})
