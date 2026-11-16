import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { envValue } from '../src/topic-server-config'
import { topicMessage } from './helpers/fake-telegram'
import { routerHarness } from './helpers/router-harness'

describe('/server buttons: step-by-step server setup in the topic', () => {
  const env = routerHarness()
  afterAll(() => env.cleanUp())
  const password = 'Te$t"pa\'ss#1 x`y'

  /** A bound topic with its /server panel open; `say` sends a message there and returns it. */
  async function openPanel() {
    const topic = await env.boundTopic()
    await topic.send('/server')
    const panel = env.api.log.find(item => item.kind === 'send' && item.threadId === topic.threadId && item.buttons)
    const say = async (text: string) => {
      const message = topicMessage(text, { message_thread_id: topic.threadId })
      await env.router.handle([message])
      return message
    }
    const lastAnswer = () => env.api.log.filter(item => item.kind === 'send' && item.threadId === topic.threadId).at(-1)?.text ?? ''
    return { topic, panel, say, lastAnswer }
  }

  const deleted = (messageId: number) => env.api.log.some(item => item.kind === 'delete' && item.messageId === messageId)

  test('the panel has a button per server; four answers save the account, only the password message is deleted', async () => {
    // Arrange
    const { topic, panel, say, lastAnswer } = await openPanel()

    // Act
    await topic.press(panel?.messageId ?? -1, 'server:a')
    const askHost = lastAnswer()
    const host = await say('1.2.3.4')
    const port = await say('2222')
    const user = await say('root')
    const secret = await say(password)

    // Assert
    expect(panel?.buttons).toEqual([['server:a', 'server:b']])
    expect(askHost).toContain('Bước 1/4')
    expect(lastAnswer()).toContain('✅ Đã lưu server A: root@1.2.3.4:2222')
    const saved = readFileSync(join(topic.folder, '.env.servers'), 'utf8')
    expect(envValue(saved, 'SERVER_A_PASSWORD')).toBe(password)
    expect(existsSync(join(topic.folder, 'ssh-to.sh'))).toBe(true)
    expect(deleted(secret.message_id)).toBe(true)
    expect([host, port, user].some(message => deleted(message.message_id))).toBe(false)
    expect(env.store.get(topic.key)?.sessionId).toBeUndefined() // no answer went to Claude
    expect(env.api.log.map(item => item.text).join('\n')).not.toContain(password)
  })

  test('a wrong answer is asked again, the setup stays on that step', async () => {
    // Arrange
    const { topic, panel, say, lastAnswer } = await openPanel()
    await topic.press(panel?.messageId ?? -1, 'server:b')

    // Act
    await say('-oProxyCommand=calc')
    const afterBadHost = lastAnswer()
    await say('5.6.7.8')
    await say('99999')
    const afterBadPort = lastAnswer()

    // Assert
    expect(afterBadHost).toContain('⛔ Host')
    expect(afterBadHost).toContain('Bước 1/4')
    expect(afterBadPort).toContain('⛔ Port')
    expect(afterBadPort).toContain('Bước 2/4')
    expect(existsSync(join(topic.folder, '.env.servers'))).toBe(false)
  })

  test('any command ends the setup: the next message is work for Claude again', async () => {
    // Arrange
    const { topic, panel, say } = await openPanel()
    await topic.press(panel?.messageId ?? -1, 'server:a')

    // Act
    await say('/status')
    await say('1.2.3.4')

    // Assert
    await topic.started()
    await topic.idle()
    expect(existsSync(join(topic.folder, '.env.servers'))).toBe(false)
  })
})
