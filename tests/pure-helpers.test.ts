import { describe, expect, test } from 'bun:test'
import { BOT_COMMANDS, PRIVATE_COMMANDS, SETUP_COMMANDS } from '../src/bot-commands'
import { claudeArgs, claudeChildEnv } from '../src/claude-runner'
import { describeToolUse, oneLine, parseStreamLine, startsTurn } from '../src/claude-stream-events'
import { parseCommand } from '../src/command-parse'
import { loadConfig, parseIdList } from '../src/config'
import { MediaGroupCollector } from '../src/media-group-collector'
import { splitForTelegram } from '../src/reply-text-chunks'
import { safeFileName } from '../src/telegram-attachments'
import type { TgMessage } from '../src/telegram-types'

const UUID = '8db377da-ce6a-40c8-8ff2-87b2bdf9e88f'

describe('stream-json events', () => {
  test('init, text, tool calls and result', () => {
    expect(parseStreamLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: UUID }))).toEqual([
      { kind: 'init', sessionId: UUID },
    ])
    const content = [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Edit', input: { file_path: 'D:\\a\\b.ts' } }]
    const steps = parseStreamLine(JSON.stringify({ type: 'assistant', message: { content } }))
    expect(steps).toEqual([
      { kind: 'text', text: 'hi' },
      { kind: 'tool', line: '✏️ Edit: b.ts', sub: false },
    ])
    // A sub-agent's words are not the session's: only its tool calls show, as progress, and start no turn.
    const sub = parseStreamLine(JSON.stringify({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content } }))
    expect(sub).toEqual([{ kind: 'tool', line: '✏️ Edit: b.ts', sub: true }])
    expect(sub.map(startsTurn)).toEqual([false])
    expect(steps.map(startsTurn)).toEqual([true, true])
    const [result] = parseStreamLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 3 }))
    expect(result).toMatchObject({ kind: 'result', text: 'done', isError: false, turns: 3 })
    const [failed] = parseStreamLine(JSON.stringify({ type: 'result', subtype: 'error_max_turns' }))
    expect(failed).toMatchObject({ isError: true, subtype: 'error_max_turns', text: '' })
  })

  test('context size: main-thread calls only, and the largest context window', () => {
    const usage = { input_tokens: 4, cache_creation_input_tokens: 328, cache_read_input_tokens: 209_496, output_tokens: 570 }
    const main = parseStreamLine(JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [], usage } }))
    expect(main).toEqual([{ kind: 'context', tokens: 210_398 }])
    const sub = parseStreamLine(JSON.stringify({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: [], usage } }))
    expect(sub).toEqual([])
    expect(parseStreamLine(JSON.stringify({ type: 'assistant', message: { content: [], usage: {} } }))).toEqual([])
    const modelUsage = { a: { contextWindow: 200_000 }, b: { contextWindow: 1_000_000 }, c: 'junk' }
    const [result] = parseStreamLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', modelUsage }))
    expect(result).toMatchObject({ kind: 'result', contextWindow: 1_000_000 })
    const [bare] = parseStreamLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }))
    expect(bare).toMatchObject({ kind: 'result', contextWindow: undefined })
  })

  test('the init line tells the model the turn runs on', () => {
    const init = { type: 'system', subtype: 'init', session_id: UUID, model: 'claude-opus-5-5' }
    expect(parseStreamLine(JSON.stringify(init))).toEqual([{ kind: 'init', sessionId: UUID, model: 'claude-opus-5-5' }])
  })

  test('a replayed message of the router counts as taken in; a tool result does not', () => {
    const replay = { type: 'user', isReplay: true, message: { role: 'user', content: 'fix the bug' } }
    const toolResult = { type: 'user', isReplay: true, message: { content: [{ type: 'tool_result', content: 'ok' }] } }
    const plain = { type: 'user', message: { role: 'user', content: 'fix the bug' } }
    expect(parseStreamLine(JSON.stringify(replay))).toEqual([{ kind: 'replay' }])
    expect(parseStreamLine(JSON.stringify(toolResult))).toEqual([])
    expect(parseStreamLine(JSON.stringify(plain))).toEqual([])
  })

  test('garbage and a session id that is not a UUID give nothing', () => {
    expect(parseStreamLine('not json')).toEqual([])
    expect(parseStreamLine('[1,2]')).toEqual([])
    expect(parseStreamLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: '--evil' }))).toEqual([])
  })

  test('tool lines are one short line', () => {
    expect(describeToolUse('Bash', { command: 'npm run\n  typecheck' })).toBe('💻 Bash: npm run typecheck')
    expect(describeToolUse('Bash', { command: 'mysql -psecret', description: 'Check DB' })).toBe('💻 Bash: Check DB')
    expect(describeToolUse('mcp__x__y', {})).toBe('🔧 mcp__x__y')
    expect(oneLine('a'.repeat(100), 10)).toHaveLength(10)
    expect(oneLine(`${'a'.repeat(8)}😀😀`, 10)).toBe(`${'a'.repeat(8)}…`)
  })
})

describe('claude command line', () => {
  test('flags, resume only with a UUID', () => {
    expect(claudeArgs({})).toContain('--dangerously-skip-permissions')
    expect(claudeArgs({}).join(' ')).toContain('--input-format stream-json --output-format stream-json --verbose --replay-user-messages')
    expect(claudeArgs({ sessionId: UUID }).slice(-2)).toEqual(['--resume', UUID])
    expect(() => claudeArgs({ sessionId: '--help' })).toThrow()
  })

  test('Claude is told to send files with 📎 lines only, to answer mid-turn messages at once and never to block', () => {
    // Arrange
    const args = claudeArgs({})

    // Act
    const note = args[args.indexOf('--append-system-prompt') + 1] ?? ''

    // Assert
    expect(note).toContain('📎 <path>')
    expect(note).toContain('Never send Telegram messages yourself')
    expect(note).toContain('posted to the user at once as the reply to it')
    expect(note).toContain('never wait in the foreground')
    expect(note).not.toContain('"') // it goes on a command line
  })

  test('the router settings and parent-session markers never reach Claude', () => {
    const env = claudeChildEnv({ PATH: 'p', TELEGRAM_BOT_TOKEN: 't', CLAUDECODE: '1', Allowed_User_Ids: '1', HOME: 'h' })
    expect(env).toEqual({ PATH: 'p', HOME: 'h' })
  })
})

describe('command menus', () => {
  test('the private-chat menu offers exactly the commands that answer in a private chat', () => {
    expect(PRIVATE_COMMANDS.map(c => c.command).sort()).toEqual(['help', 'id'])
    expect(PRIVATE_COMMANDS.every(c => SETUP_COMMANDS.has(c.command))).toBe(true)
    expect(BOT_COMMANDS.map(c => c.command)).toContain('model')
  })
})

describe('commands', () => {
  test('parse', () => {
    expect(parseCommand('/bind D:\\x y', 'my_bot')).toEqual({ name: 'bind', args: 'D:\\x y' })
    expect(parseCommand('/STATUS@My_Bot', 'my_bot')).toEqual({ name: 'status', args: '' })
    expect(parseCommand('/status@other_bot', 'my_bot')).toBe('other-bot')
    expect(parseCommand('/src/a.ts is broken', 'my_bot')).toBeNull()
  })
})

describe('text and files', () => {
  test('chunks stay under the limit and keep everything', () => {
    expect(splitForTelegram('  short  ')).toEqual(['short'])
    const text = Array.from({ length: 50 }, (_, i) => `paragraph ${i} ${'w '.repeat(60)}`).join('\n\n')
    const chunks = splitForTelegram(text, 1000)
    expect(chunks.every(c => c.length <= 1000)).toBe(true)
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' ').trim())
    const emoji = splitForTelegram(`${'a'.repeat(9)}😀${'b'.repeat(5)}`, 10)
    expect(emoji[0]).toBe('a'.repeat(9))
  })

  test('file names cannot climb out of the inbox', () => {
    expect(safeFileName('..\\..\\evil.ps1')).toBe('evil.ps1')
    expect(safeFileName('../.env')).toBe('env')
    expect(safeFileName('ảnh lỗi.png')).toBe('_nh_l_i.png')
    expect(safeFileName('...')).toBe('file')
  })

  test('an album arrives as one request, before a later plain message of its chat', async () => {
    const got: number[][] = []
    const collector = new MediaGroupCollector(messages => got.push(messages.map(m => m.message_id)), 30)
    const msg = (id: number, group?: string): TgMessage => ({
      message_id: id,
      date: 0,
      chat: { id: 1, type: 'supergroup' },
      ...(group ? { media_group_id: group } : {}),
    })
    collector.push(msg(3, 'g'))
    collector.push(msg(2, 'g'))
    collector.push(msg(9))
    collector.push(msg(11, 'h'))
    await Bun.sleep(80)
    expect(got).toEqual([[2, 3], [9], [11]])
  })
})

describe('config', () => {
  const token = '123456:abcdefghijklmnopqrstuvwxyz0123456789'
  test('refuses to start without a token or an owner', () => {
    expect(() => loadConfig({ ALLOWED_USER_IDS: '1' })).toThrow('TELEGRAM_BOT_TOKEN')
    expect(() => loadConfig({ TELEGRAM_BOT_TOKEN: token })).toThrow('ALLOWED_USER_IDS')
    expect(() => loadConfig({ TELEGRAM_BOT_TOKEN: token, ALLOWED_USER_IDS: '1', MAX_PARALLEL_RUNS: '0' })).toThrow()
  })

  test('session warning limits: defaults, 0 turns one off, nonsense is refused', () => {
    const base = { TELEGRAM_BOT_TOKEN: token, ALLOWED_USER_IDS: '1' }
    expect(loadConfig(base)).toMatchObject({ contextWarnTokens: 200_000, sessionWarnMessages: 20 })
    expect(loadConfig({ ...base, CONTEXT_WARN_TOKENS: '0', SESSION_WARN_MESSAGES: '5' })).toMatchObject({
      contextWarnTokens: 0,
      sessionWarnMessages: 5,
    })
    expect(() => loadConfig({ ...base, CONTEXT_WARN_TOKENS: '150k' })).toThrow('CONTEXT_WARN_TOKENS')
  })

  test('id lists', () => {
    expect([...parseIdList('1, -1001234567890;2')]).toEqual([1, -1001234567890, 2])
    expect(() => parseIdList('12abc')).toThrow()
  })
})
