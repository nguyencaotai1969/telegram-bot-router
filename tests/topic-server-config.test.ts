import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { topicMessage } from './helpers/fake-telegram'
import { routerHarness } from './helpers/router-harness'
import { envValue, parseServerArgs, setEnvValues } from '../src/topic-server-config'

describe('parseServerArgs', () => {
  test('password with spaces and quotes is the rest of the line; port defaults to 22', () => {
    // Arrange
    const args = 'B admin@host.example.com p@ss w$rd "x\' `y`'

    // Act
    const account = parseServerArgs(args)

    // Assert
    expect(account).toEqual({ id: 'b', user: 'admin', host: 'host.example.com', port: 22, password: 'p@ss w$rd "x\' `y`' })
  })

  test('rejects a user or host ssh would read as an option, a bad port, a multi-line password, a missing part', () => {
    // Arrange
    const bad = [
      'a -oProxyCommand=calc@host pw',
      'a root@-oProxyCommand=calc pw',
      'a root@1.2.3.4:70000 pw',
      'a root@1.2.3.4:0 pw',
      'a root@1.2.3.4 line1\nline2',
      'c root@1.2.3.4 pw',
      'a root@1.2.3.4',
    ]

    // Act
    const results = bad.map(parseServerArgs)

    // Assert
    for (const result of results) expect(typeof result).toBe('string')
  })
})

describe('setEnvValues / envValue', () => {
  test('rewrites keys in place, appends missing ones, keeps other lines; reads back what ssh-to.sh reads', () => {
    // Arrange
    const before = '# comment\r\nOTHER=1\r\nSERVER_A_HOST=old\r\n'

    // Act
    const after = setEnvValues(before, { SERVER_A_HOST: '1.2.3.4', SERVER_A_PASSWORD: 'a=b c' })

    // Assert
    expect(after).toBe('# comment\nOTHER=1\nSERVER_A_HOST=1.2.3.4\nSERVER_A_PASSWORD=a=b c\n')
    expect(envValue(after, 'SERVER_A_PASSWORD')).toBe('a=b c')
    expect(envValue(after, 'SERVER_B_HOST')).toBeUndefined()
  })
})

describe('/server: server accounts set from Telegram', () => {
  const env = routerHarness()
  afterAll(() => env.cleanUp())
  const password = 'Te$t"pa\'ss#1 x`y'

  /** The bot's text answers in this topic, latest last. */
  const answers = (threadId: number) => env.api.log.filter(item => item.kind === 'send' && item.threadId === threadId).map(item => item.text)

  test('saves the account to .env.servers, deletes the message, adds the template, never echoes the password', async () => {
    // Arrange
    const topic = await env.boundTopic()
    const message = topicMessage(`/server a root@1.2.3.4:2222 ${password}`, { message_thread_id: topic.threadId })

    // Act
    await env.router.handle([message])
    await topic.send('/server')

    // Assert
    const saved = readFileSync(join(topic.folder, '.env.servers'), 'utf8')
    expect(envValue(saved, 'SERVER_A_HOST')).toBe('1.2.3.4')
    expect(envValue(saved, 'SERVER_A_PORT')).toBe('2222')
    expect(envValue(saved, 'SERVER_A_USER')).toBe('root')
    expect(envValue(saved, 'SERVER_A_PASSWORD')).toBe(password)
    expect(env.api.log.some(item => item.kind === 'delete' && item.messageId === message.message_id)).toBe(true)
    expect(existsSync(join(topic.folder, 'CLAUDE.md'))).toBe(true)
    expect(existsSync(join(topic.folder, 'ssh-to.sh'))).toBe(true)
    const [onSave, onShow] = answers(topic.threadId).slice(-2)
    expect(onSave).toContain('✅ Đã lưu server A: root@1.2.3.4:2222')
    expect(onShow).toContain('A: root@1.2.3.4:2222 · mật khẩu ✓')
    expect(onShow).toContain('B: chưa có')
    expect(answers(topic.threadId).join('\n')).not.toContain(password)
  })

  test('a folder with its own CLAUDE.md keeps it, and the answer says so', async () => {
    // Arrange
    const topic = await env.boundTopic()
    writeFileSync(join(topic.folder, 'CLAUDE.md'), '# Dự án riêng\n')

    // Act
    await topic.send('/server b deploy@5.6.7.8 pw')

    // Assert
    expect(readFileSync(join(topic.folder, 'CLAUDE.md'), 'utf8')).toBe('# Dự án riêng\n')
    expect(answers(topic.threadId).at(-1)).toContain('CLAUDE.md riêng')
  })

  test('when the bot cannot delete the message it still saves, and asks the user to delete it', async () => {
    // Arrange
    const topic = await env.boundTopic()
    env.api.canDelete = false

    // Act
    await topic.send('/server b deploy@5.6.7.8 pw')
    env.api.canDelete = true

    // Assert
    expect(envValue(readFileSync(join(topic.folder, '.env.servers'), 'utf8'), 'SERVER_B_USER')).toBe('deploy')
    expect(answers(topic.threadId).at(-1)).toContain('hãy tự xoá tin đó')
  })

  test('a folder inside a git repo is refused (the passwords could be committed), the message still deleted', async () => {
    // Arrange
    const topic = await env.boundTopic()
    mkdirSync(join(topic.folder, '.git'))
    const message = topicMessage('/server a root@1.2.3.4 pw', { message_thread_id: topic.threadId })

    // Act
    await env.router.handle([message])

    // Assert
    expect(existsSync(join(topic.folder, '.env.servers'))).toBe(false)
    expect(existsSync(join(topic.folder, 'CLAUDE.md'))).toBe(false)
    expect(answers(topic.threadId).at(-1)).toContain('repo git')
    expect(env.api.log.some(item => item.kind === 'delete' && item.messageId === message.message_id)).toBe(true)
  })

  test('a /server sent while the bot was off is skipped, but its password still leaves the chat', async () => {
    // Arrange
    const topic = await env.boundTopic()
    const message = topicMessage('/server a root@1.2.3.4 pw', { message_thread_id: topic.threadId, date: Math.floor(Date.now() / 1000) - 3600 })

    // Act
    await env.router.handle([message])

    // Assert
    expect(existsSync(join(topic.folder, '.env.servers'))).toBe(false)
    expect(answers(topic.threadId).at(-1)).toContain('Bỏ qua tin gửi lúc bot đang tắt')
    expect(env.api.log.some(item => item.kind === 'delete' && item.messageId === message.message_id)).toBe(true)
  })

  test('an unbound topic writes nothing but still deletes the message', async () => {
    // Arrange
    const message = topicMessage('/server a root@1.2.3.4 pw', { message_thread_id: 9001 })

    // Act
    await env.router.handle([message])

    // Assert
    expect(env.api.log.some(item => item.kind === 'delete' && item.messageId === message.message_id)).toBe(true)
    expect(answers(9001).at(-1)).toContain('chưa gắn thư mục')
  })
})
