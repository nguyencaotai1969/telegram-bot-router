import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeLiveSession } from '../src/claude-runner'
import type { ClaudeEvent, ResultEvent } from '../src/claude-stream-events'
import { type SessionUsage, TopicStore, topicKey } from '../src/topic-store'
import { FAKE_CLAUDE, waitFor } from './helpers/fake-telegram'

const dir = mkdtempSync(join(tmpdir(), 'store-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('topic store', () => {
  test('bindings and sessions survive a restart', () => {
    const file = join(dir, 'a.json')
    const store = new TopicStore(file)
    const key = topicKey(-100, 5)
    store.bind(key, 'D:\\p', 'Sky Farm')
    store.setSession(key, '8db377da-ce6a-40c8-8ff2-87b2bdf9e88f', 'D:\\p')
    store.setLastUpdateId(42)
    store.setLastUpdateId(7)
    const again = new TopicStore(file)
    expect(again.get(key)).toMatchObject({ cwd: 'D:\\p', name: 'Sky Farm', sessionId: '8db377da-ce6a-40c8-8ff2-87b2bdf9e88f' })
    expect(again.lastUpdateId).toBe(42)
    expect(again.listChat(-100)).toHaveLength(1)
    expect(again.get(topicKey(-100))).toBeUndefined()
  })

  test('a session from another folder or a bad id is not stored', () => {
    const store = new TopicStore(join(dir, 'b.json'))
    const key = topicKey(-100)
    store.bind(key, 'D:\\new')
    store.setSession(key, '8db377da-ce6a-40c8-8ff2-87b2bdf9e88f', 'D:\\old')
    store.setSession(key, 'not-a-uuid')
    expect(store.get(key)?.sessionId).toBeUndefined()
  })

  test('session usage counts messages, survives a restart and is dropped with the session', () => {
    // Arrange
    const file = join(dir, 'usage.json')
    const store = new TopicStore(file)
    const key = topicKey(-100, 9)
    const session = '8db377da-ce6a-40c8-8ff2-87b2bdf9e88f'
    store.bind(key, 'D:\\p')
    store.setSession(key, session, 'D:\\p')

    const seen: Array<SessionUsage | undefined> = []
    const count = (tokens: number) => (current: SessionUsage | undefined): SessionUsage => {
      seen.push(current)
      return { messages: (current?.messages ?? 0) + 1, contextTokens: tokens, contextWindow: 1_000_000, warned: true }
    }

    // Act
    const first = store.updateUsage(key, session, count(120_000))
    const second = store.updateUsage(key, session, count(130_000))
    const otherSession = store.updateUsage(key, crypto.randomUUID(), count(5))
    const reloaded = new TopicStore(file).get(key)?.usage
    const copy = store.get(key)?.usage
    if (copy) copy.messages = 99
    const afterOutsideChange = store.get(key)?.usage?.messages
    store.setSession(key, crypto.randomUUID(), 'D:\\p')

    // Assert
    expect(seen).toEqual([undefined, first])
    expect(second).toEqual({ messages: 2, contextTokens: 130_000, contextWindow: 1_000_000, warned: true })
    expect(otherSession).toBeUndefined()
    expect(reloaded).toEqual(second)
    expect(afterOutsideChange).toBe(2)
    expect(store.get(key)?.usage).toBeUndefined()
  })

  test('malformed usage in state.json is dropped, the session is kept', () => {
    // Arrange
    const file = join(dir, 'bad-usage.json')
    const session = '8db377da-ce6a-40c8-8ff2-87b2bdf9e88f'
    const topics = {
      '-100:1': { cwd: 'D:\\a', boundAt: 1, sessionId: session, usage: { messages: -1, contextTokens: 5 } },
      '-100:2': { cwd: 'D:\\b', boundAt: 1, sessionId: session, usage: 'junk' },
      '-100:3': { cwd: 'D:\\c', boundAt: 1, sessionId: session, usage: { messages: 2, contextTokens: 9, contextWindow: 'x', warned: 'yes' } },
    }
    writeFileSync(file, JSON.stringify({ lastUpdateId: 1, topics }))

    // Act
    const store = new TopicStore(file)

    // Assert
    expect(store.get('-100:1')?.sessionId).toBe(session)
    expect(store.get('-100:1')?.usage).toBeUndefined()
    expect(store.get('-100:2')?.usage).toBeUndefined()
    expect(store.get('-100:3')?.usage).toEqual({ messages: 2, contextTokens: 9 })
  })

  test('a broken file is kept aside and the bot starts empty', () => {
    const file = join(dir, 'c.json')
    writeFileSync(file, '{ broken')
    const store = new TopicStore(file)
    expect(store.lastUpdateId).toBe(0)
    expect(readdirSync(dir).some(name => name.startsWith('c.json.bad-'))).toBe(true)
    expect(existsSync(file)).toBe(false)
  })
})

describe('claude live session', () => {
  /** A live session on the fake claude that records its events. */
  function liveSession(cwd = dir) {
    const events: ClaudeEvent[] = []
    const live = new ClaudeLiveSession({ command: FAKE_CLAUDE, cwd, onEvent: event => events.push(event) })
    const results = () => events.filter((event): event is ResultEvent => event.kind === 'result')
    return { live, events, results }
  }

  test('one process answers several messages, one result per turn, in one session', async () => {
    // Arrange
    const { live, events, results } = liveSession()

    // Act
    live.send('one')
    await waitFor(() => results().length === 1)
    live.send('two')
    await waitFor(() => results().length === 2)
    live.kill()

    // Assert
    const [first, second] = results()
    expect(first?.text).toContain('echo:one')
    expect(second?.text).toContain('echo:two')
    expect(second?.sessionId).toBe(first?.sessionId)
    expect(events.filter(event => event.kind === 'replay')).toHaveLength(2)
  })

  test('kill ends a busy process quickly and says it was killed', async () => {
    // Arrange
    const { live } = liveSession()
    live.send('SLOW')
    await Bun.sleep(500)

    // Act
    const started = Date.now()
    live.kill()
    const end = await live.ended

    // Assert
    expect(end.killed).toBe(true)
    expect(end.sawInit).toBe(true)
    expect(live.alive).toBe(false)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  test('a process that exits on its own is not reported as killed, and a late kill changes nothing', async () => {
    // Arrange
    const { live, results } = liveSession()

    // Act
    live.send('EXIT_AFTER quick')
    const end = await live.ended
    live.kill()

    // Assert
    expect(end).toMatchObject({ exitCode: 0, killed: false, sawInit: true })
    expect(results()).toHaveLength(1)
    expect(live.send('too late')).toBe(false)
  })

  test('a spawn into a missing folder throws', () => {
    expect(() => liveSession(join(dir, 'missing'))).toThrow()
  })
})
