import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCommand } from '../src/command-parse'
import { apiEnv } from '../src/topic-api-settings'
import { TopicStore } from '../src/topic-store'
import { topicMessage } from './helpers/fake-telegram'
import { fact, routerHarness } from './helpers/router-harness'

const TOKEN = 'sk-test-TOKEN-1234567890'

/** A stand-in API server on this machine: what it answers to `GET /v1/models` is set per test. */
type Mode = 'ok' | 'deny' | 'slow' | 'no-models' | 'broken' | 'redirect'
const api = { mode: 'ok' as Mode, hits: [] as Array<{ path: string; auth: string | null }>, elsewhere: 0 }
const elsewhere = Bun.serve({ port: 0, fetch: () => ((api.elsewhere += 1), new Response('{}')) })
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    api.hits.push({ path: new URL(request.url).pathname, auth: request.headers.get('authorization') })
    if (api.mode === 'deny') return new Response('{}', { status: 401 })
    if (api.mode === 'no-models') return new Response('nope', { status: 404 })
    if (api.mode === 'broken') return new Response('boom', { status: 502 })
    if (api.mode === 'redirect') return Response.redirect(`http://127.0.0.1:${elsewhere.port}/v1/models`, 302)
    if (api.mode === 'slow') await Bun.sleep(1500)
    return new Response('{"data":[]}')
  },
})
const HOST = '127.0.0.1'
const PORT = server.port as number
const BASE_URL = `http://${HOST}:${PORT}`

/** A port nothing listens on: it was free a moment ago. */
function closedPort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = probe.port as number
  probe.stop(true)
  return port
}

describe('/api: API server per topic with test, on / off switch', () => {
  const env = routerHarness({ apiTestTimeoutMs: 600 })
  afterAll(async () => {
    server.stop(true)
    elsewhere.stop(true)
    await env.cleanUp()
  })

  /** A bound topic with helpers: `say` sends a message there, `panel` is the latest /api panel the bot drew. */
  async function apiTopic() {
    api.mode = 'ok'
    api.hits.length = 0
    api.elsewhere = 0
    const topic = await env.boundTopic()
    const say = async (text: string) => {
      const message = topicMessage(text, { message_thread_id: topic.threadId })
      await env.router.handle([message])
      return message
    }
    const sent = () => env.api.log.filter(item => item.kind === 'send' && item.threadId === topic.threadId)
    const lastAnswer = () => sent().at(-1)?.text ?? ''
    const panel = () => sent().filter(item => item.buttons).at(-1)
    const deleted = (messageId: number) => env.api.log.some(item => item.kind === 'delete' && item.messageId === messageId)
    const tap = (data: string) => topic.press(panel()?.messageId ?? -1, data)
    /** The panel's text after the last press: its latest edit. */
    const panelNow = () => env.api.log.filter(item => item.kind === 'edit' && item.messageId === panel()?.messageId).at(-1)?.text ?? ''
    /** Sends a work message and returns Claude's facts for it. */
    const work = async (text: string) => {
      await topic.send(text)
      const reply = await topic.answer(`echo:${text}`)
      await topic.idle()
      return reply
    }
    return { topic, say, lastAnswer, panel, panelNow, deleted, tap, work }
  }

  test('the panel offers to fill in the API; three answers on Telegram save it, turn it on and test it; only the token message is deleted', async () => {
    // Arrange
    const { topic, say, lastAnswer, panel, deleted, tap } = await apiTopic()
    await topic.send('/api')
    const emptyPanel = panel()

    // Act
    await tap('api:edit')
    const askHost = lastAnswer()
    const host = await say(HOST)
    const port = await say(String(PORT))
    const secret = await say(TOKEN)

    // Assert
    expect(emptyPanel?.buttons).toEqual([['api:edit']])
    expect(emptyPanel?.text).toContain('chưa cấu hình')
    expect(askHost).toContain('Bước 1/3')
    expect(env.store.get(topic.key)?.api).toEqual({ enabled: true, baseUrl: BASE_URL, token: TOKEN })
    expect(lastAnswer()).toContain(`BẬT → ${BASE_URL}`)
    expect(lastAnswer()).toContain('✅ Kết nối được')
    expect(api.hits).toEqual([{ path: '/v1/models', auth: `Bearer ${TOKEN}` }])
    expect(panel()?.buttons).toEqual([['api:toggle', 'api:test'], ['api:edit', 'api:clear']])
    expect(deleted(secret.message_id)).toBe(true)
    expect([host, port].some(message => deleted(message.message_id))).toBe(false)
    expect(env.store.get(topic.key)?.sessionId).toBeUndefined() // no answer went to Claude
    expect(env.api.log.map(item => item.text).join('\n')).not.toContain(TOKEN)
  })

  test('a wrong answer is asked again; a https:// host keeps its scheme', async () => {
    // Arrange
    const { topic, say, lastAnswer, tap } = await apiTopic()
    await topic.send('/api')
    await tap('api:edit')

    // Act
    await say('bad host; rm -rf')
    const afterBadHost = lastAnswer()
    await say(`https://${HOST}`)
    await say('99999')
    const afterBadPort = lastAnswer()
    await say(String(PORT))
    await say('two words')
    const afterBadToken = lastAnswer()
    await say(TOKEN)

    // Assert
    expect(afterBadHost).toContain('⛔ Host')
    expect(afterBadPort).toContain('⛔ Port')
    expect(afterBadToken).toContain('⛔ Token')
    expect(env.store.get(topic.key)?.api?.baseUrl).toBe(`https://${HOST}:${PORT}`)
  })

  test('the test button tells whether the API answers, per outcome; the token is never shown; a redirect is not followed', async () => {
    // Arrange
    const { topic, say, tap, panelNow } = await apiTopic()
    await say(`/api ${BASE_URL} ${TOKEN}`)
    await topic.send('/api')
    const outcomes: Record<string, string> = {}

    // Act
    for (const mode of ['ok', 'deny', 'no-models', 'broken', 'redirect', 'slow'] as const) {
      api.mode = mode
      await tap('api:test')
      outcomes[mode] = panelNow()
    }
    env.store.setApi(topic.key, { enabled: true, baseUrl: `http://${HOST}:${closedPort()}`, token: TOKEN })
    await tap('api:test')
    outcomes.refused = panelNow()

    // Assert
    expect(outcomes.ok).toContain('✅ Kết nối được, server chấp nhận token (HTTP 200')
    expect(outcomes.deny).toContain('⚠️ Server trả lời nhưng từ chối token (HTTP 401)')
    expect(outcomes['no-models']).toContain('chưa kiểm được token')
    expect(outcomes.broken).toContain('Server báo lỗi (HTTP 502)')
    expect(outcomes.redirect).toContain('chuyển hướng (HTTP 302)')
    expect(outcomes.slow).toContain('❌ Không thấy server trả lời sau 1 giây')
    expect(outcomes.refused).toContain('❌ Server từ chối kết nối')
    expect(Object.values(outcomes).join('\n')).not.toContain(TOKEN)
    expect(api.elsewhere).toBe(0) // the token never travels on to another host
    expect(env.api.log.some(item => item.kind === 'answer' && item.text.includes('Đang kiểm tra'))).toBe(true)
  })

  test('the test button first shows that it is checking in the panel itself, then the result', async () => {
    // Arrange
    const { topic, say, tap } = await apiTopic()
    await say(`/api ${BASE_URL} ${TOKEN}`)
    await topic.send('/api')
    api.mode = 'slow'

    // Act
    await tap('api:test')

    // Assert
    const shown = env.api.log.filter(item => item.kind === 'edit').map(item => item.text)
    expect(shown.at(-2)).toContain('⏳ Đang kiểm tra kết nối')
    expect(shown.at(-1)).toContain('❌ Không thấy server trả lời')
  })

  test('when the panel cannot be edited, the test result still reaches the topic as a new message', async () => {
    // Arrange
    const { topic, say, tap, lastAnswer } = await apiTopic()
    await say(`/api ${BASE_URL} ${TOKEN}`)
    await topic.send('/api')
    env.api.editError = new Error('Bad Request: message to edit not found')

    // Act
    try {
      await tap('api:test')
    } finally {
      env.api.editError = undefined
    }

    // Assert
    expect(lastAnswer()).toContain('✅ Kết nối được')
    expect(lastAnswer()).not.toContain(TOKEN)
  })

  test('pressing test twice gives two different answers, so Telegram never refuses the second as "not modified"', async () => {
    // Arrange
    const { topic, say, tap, panelNow } = await apiTopic()
    await say(`/api ${BASE_URL} ${TOKEN}`)
    await topic.send('/api')
    api.mode = 'no-models' // a fixed answer, with no varying milliseconds in it

    // Act
    await tap('api:test')
    const first = panelNow()
    await Bun.sleep(1100)
    await tap('api:test')
    const second = panelNow()

    // Assert
    expect(second).not.toBe(first)
  })

  test('/enable-api and /disable-api switch the saved API; enabling tests it; the hyphen and underscore spellings both work', async () => {
    // Arrange
    const { topic, say, lastAnswer } = await apiTopic()
    await say(`/api ${BASE_URL} ${TOKEN}`)

    // Act
    await say('/disable-api')
    const off = env.store.get(topic.key)?.api?.enabled
    const offAnswer = lastAnswer()
    api.hits.length = 0
    await say('/enable-api')
    const on = env.store.get(topic.key)?.api?.enabled
    const onAnswer = lastAnswer()
    await say('/disable_api')
    const offAgain = env.store.get(topic.key)?.api?.enabled

    // Assert
    expect(off).toBe(false)
    expect(offAnswer).toContain('Đã tắt API')
    expect(offAnswer).toContain(`TẮT (đã lưu ${BASE_URL})`)
    expect(on).toBe(true)
    expect(onAnswer).toContain('Đã bật API')
    expect(onAnswer).toContain('✅ Kết nối được')
    expect(api.hits).toHaveLength(1) // turning it off does not test; turning it on does
    expect(offAgain).toBe(false)
  })

  test('/enable-api without a saved API says so; in an unbound topic it says /bind', async () => {
    // Arrange
    const { say, lastAnswer } = await apiTopic()

    // Act
    await say('/enable-api')
    const noApi = lastAnswer()
    await env.router.handle([topicMessage('/enable-api', { message_thread_id: 999 })])

    // Assert
    expect(noApi).toContain('⛔ Chưa có cấu hình API')
    expect(env.api.log.some(item => item.threadId === 999 && item.text.includes('/bind'))).toBe(true)
    expect(api.hits).toEqual([])
  })

  test('/help and the /api panel name every API command in a form Telegram makes tappable (no hyphen), so the "/" menu is not needed', async () => {
    // Arrange
    const { topic, panel } = await apiTopic()

    // Act
    await topic.send('/help')
    const help = env.api.log.filter(item => item.kind === 'send' && item.threadId === topic.threadId).at(-1)?.text ?? ''
    await topic.send('/api')

    // Assert
    for (const text of [help, panel()?.text ?? '']) {
      expect(text).toContain('/enable_api')
      expect(text).toContain('/disable_api')
    }
    expect(help).toContain('/api —')
    expect(help.match(/\/(?:enable|disable)_api/g)).toHaveLength(2)
  })

  test('only the two API switches take a hyphen; any other /some-name is not a command (it is for Claude)', () => {
    // Arrange / Act / Assert
    expect(parseCommand('/enable-api', 'bot')).toEqual({ name: 'enable_api', args: '' })
    expect(parseCommand('/Disable-API@bot', 'bot')).toEqual({ name: 'disable_api', args: '' })
    expect(parseCommand('/enable_api', 'bot')).toEqual({ name: 'enable_api', args: '' })
    expect(parseCommand('/code-review now', 'bot')).toBeNull()
    expect(parseCommand('/enable-api@other', 'bot')).toBe('other-bot')
  })

  test('while on, Claude runs on that API through a settings file outside the project; off and on again switch it, same session', async () => {
    // Arrange: a warm Claude on the machine's own login.
    const { topic, work, say } = await apiTopic()
    const plain = await work('before api')
    await say(`/api ${BASE_URL} ${TOKEN}`)

    // Act
    const on = await work('with api')
    await say('/disable-api')
    const off = await work('api turned off')
    await say('/enable-api')
    const onAgain = await work('api back on')

    // Assert
    expect(fact(plain, 'api')).toBe('api:-')
    expect(fact(on, 'api')).toBe(`api:${BASE_URL}`)
    expect(fact(on, 'apitoken')).toBe(`apitoken:${TOKEN}`)
    expect(fact(off, 'api')).toBe('api:-')
    expect(fact(onAgain, 'api')).toBe(`api:${BASE_URL}`)
    expect(fact(on, 'session')).toBe(fact(plain, 'session'))
    expect(fact(onAgain, 'session')).toBe(fact(plain, 'session'))
    expect(fact(on, 'pid')).not.toBe(fact(plain, 'pid')) // the API cannot change inside a running Claude
    expect(readdirSync(topic.folder)).toEqual([]) // the token never lands in the project
  })

  test('/disable-api means the machine login even when the project sets its own API in .claude/settings.local.json; /api clear gives the project its own back', async () => {
    // Arrange
    const { topic, work, say } = await apiTopic()
    const PROJECT_API = 'http://project-own-api:1'
    mkdirSync(join(topic.folder, '.claude'))
    const projectEnv = { env: { ANTHROPIC_BASE_URL: PROJECT_API, ANTHROPIC_AUTH_TOKEN: 'project-token' } }
    writeFileSync(join(topic.folder, '.claude', 'settings.local.json'), JSON.stringify(projectEnv))
    await say(`/api ${BASE_URL} ${TOKEN}`)

    // Act
    const on = await work('router api on')
    await say('/disable-api')
    const off = await work('router api off')
    await say('/api clear')
    const cleared = await work('router api cleared')

    // Assert
    expect(fact(on, 'api')).toBe(`api:${BASE_URL}`)
    expect(fact(off, 'api')).toBe('api:-')
    expect(fact(off, 'apitoken')).toBe('apitoken:-')
    expect(fact(cleared, 'api')).toBe(`api:${PROJECT_API}`)
    expect(fact(cleared, 'session')).toBe(fact(on, 'session'))
  })

  const PROJECT_API = 'http://project-own-api:1'
  function declareProjectApi(folder: string, projectEnv: Record<string, string>): void {
    mkdirSync(join(folder, '.claude'), { recursive: true })
    writeFileSync(join(folder, '.claude', 'settings.local.json'), JSON.stringify({ env: projectEnv }))
  }

  test('/disable_api with nothing saved turns the project\'s own API off; /status warns only while that API is in effect', async () => {
    // Arrange
    const { topic, work, say, lastAnswer } = await apiTopic()
    declareProjectApi(topic.folder, { ANTHROPIC_BASE_URL: PROJECT_API, ANTHROPIC_AUTH_TOKEN: 'project-token' })
    const before = await work('own-api project, first')
    await say('/status')
    const statusBefore = lastAnswer()

    // Act
    await say('/disable_api')
    const answer = lastAnswer()
    const off = await work('own-api project, disabled')
    await say('/status')
    const statusOff = lastAnswer()
    await say('/api clear')
    const clearedAnswer = lastAnswer()
    const cleared = await work('own-api project, cleared')

    // Assert
    expect(fact(before, 'api')).toBe(`api:${PROJECT_API}`)
    expect(statusBefore).toContain('⚠️ Dự án tự khai API')
    expect(statusBefore).toContain(PROJECT_API)
    expect(answer).toContain('Đã tắt API')
    expect(fact(off, 'api')).toBe('api:-')
    expect(fact(off, 'apitoken')).toBe('apitoken:-')
    expect(fact(off, 'session')).toBe(fact(before, 'session'))
    expect(statusOff).toContain('🔌 API: TẮT')
    expect(statusOff).not.toContain('⚠️ Dự án tự khai API')
    expect(clearedAnswer).toContain('⚠️ Dự án tự khai API')
    expect(fact(cleared, 'api')).toBe(`api:${PROJECT_API}`)
  })

  test('the /api panel of a project with its own API offers a button that turns it off; only the origin of its URL is shown', async () => {
    // Arrange
    const { topic, panel, panelNow, tap } = await apiTopic()
    declareProjectApi(topic.folder, { ANTHROPIC_BASE_URL: 'https://user:url-password@own-api:2/v1?key=url-secret' })
    await topic.send('/api')
    const offered = panel()

    // Act
    await tap('api:off')

    // Assert
    expect(offered?.buttons).toEqual([['api:edit'], ['api:off']])
    expect(offered?.text).toContain('(https://own-api:2)')
    expect(offered?.text).not.toMatch(/url-password|url-secret/)
    expect(env.store.get(topic.key)?.apiOff).toBe(true)
    expect(panelNow()).toContain('🔌 API: TẮT')
  })

  test('an API change does not interrupt the work in progress and applies to the next', async () => {
    // Arrange
    const { topic, say, work } = await apiTopic()
    await topic.send('WAIT busy work')
    await topic.started()

    // Act
    await say(`/api ${BASE_URL} ${TOKEN}`)
    await topic.send('joined while busy')
    const during = await topic.answer('echo:WAIT busy work + joined while busy')
    await topic.idle()
    const later = await work('after the work')

    // Assert
    expect(env.api.find('send', '⏳ Áp dụng khi Claude xong việc đang làm.')).toBeDefined()
    expect(fact(during, 'api')).toBe('api:-')
    expect(fact(later, 'api')).toBe(`api:${BASE_URL}`)
    expect(fact(later, 'session')).toBe(fact(during, 'session'))
  })

  test('/api url token saves in one line, tests it and deletes that message; off, on, test and clear work as words', async () => {
    // Arrange
    const { topic, say, deleted, lastAnswer } = await apiTopic()

    // Act
    const line = await say(`/api ${BASE_URL} ${TOKEN}`)
    const saved = env.store.get(topic.key)?.api
    const savedAnswer = lastAnswer()
    await say('/api off')
    const off = env.store.get(topic.key)?.api?.enabled
    await say('/api on')
    const on = env.store.get(topic.key)?.api?.enabled
    api.mode = 'deny'
    await say('/api test')
    const testAnswer = lastAnswer()
    await say('/api clear')

    // Assert
    expect(saved).toEqual({ enabled: true, baseUrl: BASE_URL, token: TOKEN })
    expect(savedAnswer).toContain('✅ Kết nối được')
    expect(deleted(line.message_id)).toBe(true)
    expect(off).toBe(false)
    expect(on).toBe(true)
    expect(testAnswer).toContain('từ chối token')
    expect(env.store.get(topic.key)?.api).toBeUndefined()
  })

  test('a malformed one-line /api saves and tests nothing, and its message is deleted all the same', async () => {
    // Arrange
    const { topic, say, deleted } = await apiTopic()

    // Act
    const spaced = await say(`/api http://bad host ${TOKEN}`)
    const scheme = await say(`/api ftp://1.2.3.4:21 ${TOKEN}`)
    const port = await say(`/api http://1.2.3.4:70000 ${TOKEN}`)

    // Assert
    expect(env.store.get(topic.key)?.api).toBeUndefined()
    expect([spaced, scheme, port].every(message => deleted(message.message_id))).toBe(true)
    expect(env.api.find('send', '⛔ Sai dạng')).toBeDefined()
    expect(api.hits).toEqual([])
  })

  test('/status and the panel never show the whole token', async () => {
    // Arrange
    const { topic, say } = await apiTopic()
    await say(`/api ${BASE_URL} ${TOKEN}`)

    // Act
    await topic.send('/status')
    await topic.send('/api')

    // Assert
    const shown = env.api.log.filter(item => item.threadId === topic.threadId).map(item => item.text).join('\n')
    expect(shown).toContain(`🔌 API: BẬT → ${BASE_URL} · token …7890`)
    expect(shown).not.toContain(TOKEN)
  })

  test('any command ends the setup: the next message is work for Claude again', async () => {
    // Arrange
    const { topic, say, tap } = await apiTopic()
    await topic.send('/api')
    await tap('api:edit')

    // Act
    await say('/status')
    await say(HOST)

    // Assert
    await topic.started()
    await topic.idle()
    expect(env.store.get(topic.key)?.api).toBeUndefined()
  })

  test('an API that cannot be saved is not applied, and not tested either', async () => {
    // Arrange
    const { topic, say } = await apiTopic()
    const writable = env.store as unknown as { save(): void }
    const save = writable.save
    writable.save = () => {
      throw new Error('EPERM: state.json is locked')
    }

    // Act
    try {
      await say(`/api ${BASE_URL} ${TOKEN}`)
    } finally {
      writable.save = save
    }

    // Assert
    expect(env.api.find('send', '⚠️ Không lưu được')).toBeDefined()
    expect(env.store.get(topic.key)?.api).toBeUndefined()
    expect(api.hits).toEqual([])
  })

  test('a press from someone not allowed changes nothing', async () => {
    // Arrange
    const { topic, say, panel } = await apiTopic()
    await say(`/api ${BASE_URL} ${TOKEN}`)
    api.hits.length = 0

    // Act
    await topic.press(panel()?.messageId ?? -1, 'api:clear', 999)
    await topic.press(panel()?.messageId ?? -1, 'api:test', 999)

    // Assert
    expect(env.store.get(topic.key)?.api?.enabled).toBe(true)
    expect(api.hits).toEqual([])
  })
})

describe('API in the topic store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'api-store-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('it survives a restart and a /bind to the same folder, goes with another folder; bad data in state.json is dropped', () => {
    // Arrange
    const file = join(dir, 'state.json')
    const store = new TopicStore(file)
    store.bind('-100:1', 'D:\\a')
    store.setApi('-100:1', { enabled: true, baseUrl: BASE_URL, token: TOKEN })

    // Act
    store.bind('-100:1', 'D:\\a')
    const sameFolder = new TopicStore(file).get('-100:1')
    store.bind('-100:1', 'D:\\b')
    const otherFolder = new TopicStore(file).get('-100:1')
    const loadBad = (value: unknown) => {
      writeFileSync(join(dir, 'bad.json'), JSON.stringify({ lastUpdateId: 1, topics: { '-100:2': { cwd: 'D:\\c', boundAt: 1, api: value } } }))
      return new TopicStore(join(dir, 'bad.json')).get('-100:2')?.api
    }

    // Assert
    expect(sameFolder?.api).toEqual({ enabled: true, baseUrl: BASE_URL, token: TOKEN })
    expect(otherFolder?.api).toBeUndefined()
    expect(loadBad({ enabled: true, baseUrl: 'http://x y:1', token: TOKEN })).toBeUndefined()
    expect(loadBad({ enabled: true, baseUrl: BASE_URL, token: 'has space' })).toBeUndefined()
    expect(loadBad({ enabled: 'yes', baseUrl: BASE_URL, token: TOKEN })?.enabled).toBe(false)
    expect(store.setApi('-100:9', undefined)).toBe(false)
    expect(existsSync(join(dir, 'topic-api'))).toBe(false)
  })

  test('a plain "off" survives a restart and a /bind to the same folder, and goes with another folder or a saved server', () => {
    // Arrange
    const file = join(dir, 'off.json')
    const store = new TopicStore(file)
    store.bind('-100:3', 'D:\\a')
    store.setApi('-100:3', 'off')

    // Act
    store.bind('-100:3', 'D:\\a')
    const sameFolder = new TopicStore(file).get('-100:3')
    store.setApi('-100:3', { enabled: true, baseUrl: BASE_URL, token: TOKEN })
    const withServer = new TopicStore(file).get('-100:3')
    store.setApi('-100:3', 'off')
    store.bind('-100:3', 'D:\\b')
    const otherFolder = new TopicStore(file).get('-100:3')

    // Assert
    expect(sameFolder?.apiOff).toBe(true)
    expect(withServer?.apiOff).toBeUndefined()
    expect(otherFolder?.apiOff).toBeUndefined()
  })
})

describe('the ANTHROPIC_* the router overrides', () => {
  const folder = mkdtempSync(join(tmpdir(), 'api-env-'))
  afterAll(() => rmSync(folder, { recursive: true, force: true }))

  test('a project\'s ANTHROPIC_API_KEY is blanked too, so it neither stays in use nor travels to the topic\'s server; without one it is left alone', () => {
    // Arrange
    const on = { cwd: folder, api: { enabled: true, baseUrl: BASE_URL, token: TOKEN } }
    const without = apiEnv(on)
    mkdirSync(join(folder, '.claude'))
    writeFileSync(join(folder, '.claude', 'settings.json'), `\uFEFF${JSON.stringify({ env: { ANTHROPIC_API_KEY: 'project-key' } })}`)

    // Act
    const whileOn = apiEnv(on)
    const whileOff = apiEnv({ cwd: folder, apiOff: true })
    const neverChosen = apiEnv({ cwd: folder })

    // Assert
    expect(without).toEqual({ ANTHROPIC_BASE_URL: BASE_URL, ANTHROPIC_AUTH_TOKEN: TOKEN })
    expect(whileOn).toEqual({ ANTHROPIC_BASE_URL: BASE_URL, ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: '' })
    expect(whileOff).toEqual({ ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '' })
    expect(neverChosen).toBeUndefined()
  })

  /** A new project folder whose settings.local.json holds `env`. */
  function project(name: string, projectEnv: Record<string, string>): string {
    const cwd = join(folder, name)
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ env: projectEnv }))
    return cwd
  }

  test('model names that go with the project\'s own server are blanked when that server is overridden; without one they stay', () => {
    // Arrange
    const models = { ANTHROPIC_MODEL: 'proxy-model', ANTHROPIC_DEFAULT_OPUS_MODEL: 'proxy-opus', CLAUDE_CODE_SUBAGENT_MODEL: 'proxy-sub' }
    const proxied = project('proxied', { ANTHROPIC_BASE_URL: 'http://proxy:1', ...models, MAX_THINKING_TOKENS: '2048' })
    const modelOnly = project('model-only', models)

    // Act
    const off = apiEnv({ cwd: proxied, apiOff: true })
    const on = apiEnv({ cwd: proxied, api: { enabled: true, baseUrl: BASE_URL, token: TOKEN } })
    const ownModelKept = apiEnv({ cwd: modelOnly, api: { enabled: true, baseUrl: BASE_URL, token: TOKEN } })

    // Assert
    const blanked = { ANTHROPIC_MODEL: '', ANTHROPIC_DEFAULT_OPUS_MODEL: '', CLAUDE_CODE_SUBAGENT_MODEL: '' }
    expect(off).toEqual({ ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: '', ...blanked })
    expect(on).toEqual({ ANTHROPIC_BASE_URL: BASE_URL, ANTHROPIC_AUTH_TOKEN: TOKEN, ...blanked })
    expect(ownModelKept).toEqual({ ANTHROPIC_BASE_URL: BASE_URL, ANTHROPIC_AUTH_TOKEN: TOKEN })
  })

  test('off in a project without an API of its own overrides nothing: the machine\'s settings, an API among them, stay', () => {
    // Arrange
    const plain = project('plain', { MAX_THINKING_TOKENS: '2048' })

    // Act
    const plainOff = apiEnv({ cwd: plain, apiOff: true })
    const savedOff = apiEnv({ cwd: plain, api: { enabled: false, baseUrl: BASE_URL, token: TOKEN } })

    // Assert
    expect(plainOff).toBeUndefined()
    expect(savedOff).toBeUndefined()
  })
})
