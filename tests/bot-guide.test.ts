import { afterAll, describe, expect, test } from 'bun:test'
import { BOT_COMMANDS } from '../src/bot-commands'
import { GUIDE } from '../src/bot-guide'
import { splitForTelegram } from '../src/reply-text-chunks'
import { topicMessage } from './helpers/fake-telegram'
import { routerHarness } from './helpers/router-harness'

describe('the user guide', () => {
  const env = routerHarness()
  afterAll(env.cleanUp)

  test('it names every command of the "/" menu, so a new command can never be left out of the guide', () => {
    // Arrange / Act
    const missing = BOT_COMMANDS.map(c => c.command).filter(name => !GUIDE.includes(`/${name}`))

    // Assert
    expect(missing).toEqual([])
  })

  test('it never writes a command with a hyphen as the tappable form (Telegram only links up to the hyphen)', () => {
    // Arrange / Act
    const hyphenated = (GUIDE.match(/\/[a-z]+-[a-z]+/g) ?? []).filter(word => word !== '/enable-api' && word !== '/disable-api')

    // Assert
    expect(hyphenated).toEqual([])
    expect(GUIDE).toContain('/enable_api')
    expect(GUIDE).toContain('/disable_api')
  })

  test('/guide sends the whole guide in the topic, in messages Telegram accepts', async () => {
    // Arrange
    const topic = await env.boundTopic()
    const sentInTopic = () => env.api.log.filter(item => item.kind === 'send' && item.threadId === topic.threadId).map(item => item.text)
    const before = sentInTopic().length // the reply to /bind

    // Act
    await topic.send('/guide')

    // Assert
    const guide = sentInTopic().slice(before)
    expect(guide).toEqual(splitForTelegram(GUIDE))
    expect(guide.every(text => text.length <= 4096)).toBe(true)
    expect(guide.join('\n').replace(/\s+/g, ' ')).toBe(GUIDE.replace(/\s+/g, ' ').trim())
  })

  test('/guide also answers outside an allowed group, like /help: a newcomer can read it before any setup', async () => {
    // Arrange
    const message = { ...topicMessage('/guide'), chat: { id: 4242, type: 'private' as const } }

    // Act
    await env.router.handle([message])

    // Assert
    expect(env.api.log.some(item => item.chatId === 4242 && item.text.startsWith('📖 HƯỚNG DẪN'))).toBe(true)
  })

  test('/help points to /guide', async () => {
    // Arrange
    const topic = await env.boundTopic()

    // Act
    await topic.send('/help')

    // Assert
    expect(env.api.log.filter(item => item.threadId === topic.threadId).at(-1)?.text).toContain('/guide')
  })
})
