// Stand-in for claude.exe in tests: behaves like `claude -p --input-format stream-json
// --output-format stream-json --verbose --replay-user-messages`, one long-lived process.
//   SLOW: the turn takes 30 s · WAIT: the turn waits (≤5 s) for another message to join it
//   CRASH: exits 3 · EXIT_AFTER: exits after answering · LONG: a 30 000-char answer · MEDIUM: ~9 000 chars
//   CONTEXT=<n>: context size reported · NOISY_STDERR: stderr noise after the answer
//   ASK (in a message read mid-turn): answered at once with "heard:<it>", then one more step
//   ATTACH=<path>: names the file in a 📎 line mid-turn and in the answer, plus a missing one
//   BACKGROUND: after answering, a background task "finishes" and Claude begins a turn by itself
//     (BACKGROUND_WAIT: that turn waits ≤5 s for a message to join it); it answers "bg-done|…"
//   SUBAGENT: a background sub-agent's tool calls land just before the result line and after it
//   `--resume deadbeef-…`: a session that no longer exists (fails at start, like claude)
export {}

const args = process.argv.slice(2)
const resumeAt = args.indexOf('--resume')
const resumed = resumeAt >= 0 ? args[resumeAt + 1] : undefined
const modelAt = args.indexOf('--model')
/** `--model`, or what a `set_model` control request switched to since. */
let model = modelAt >= 0 ? args[modelAt + 1] : undefined
const sessionId = resumed ?? crypto.randomUUID()
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)

if (resumed?.startsWith('deadbeef')) {
  process.stderr.write(`No conversation found with session ID: ${resumed}\n`)
  process.exit(1)
}

/** What `initialize` lists, like claude's: `default` first, aliases, then older versions by full name. */
const MODELS = [
  { value: 'default', displayName: 'Default (recommended)', description: 'Sonnet Test · Efficient for routine tasks' },
  { value: 'opus', displayName: 'Opus Test', description: 'For complex work' },
  { value: 'sonnet', displayName: 'Sonnet Test', description: 'Most efficient' },
  { value: 'haiku', displayName: 'Haiku Test', description: 'Fastest' },
  { value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: 'Older' },
]

/** Messages read from stdin, not yet taken in. */
const inbox: string[] = []
let stdinClosed = false
void (async () => {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      const message = line ? JSON.parse(line) : undefined
      if (message?.type === 'user' && typeof message.message?.content === 'string') inbox.push(message.message.content)
      // Like claude: `set_model` switches the model of the turns to come, in this same process.
      if (message?.type === 'control_request' && message.request?.subtype === 'initialize') {
        emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { models: MODELS } } })
      }
      if (message?.type === 'control_request' && message.request?.subtype === 'set_model') {
        model = message.request.model
        emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { model } } })
      }
    }
  }
  stdinClosed = true
})()

async function nextMessage(): Promise<string | undefined> {
  while (inbox.length === 0 && !stdinClosed) await Bun.sleep(10)
  return inbox.shift()
}
const replay = (text: string) => emit({ type: 'user', isReplay: true, session_id: sessionId, message: { role: 'user', content: text } })
const usage = (tokens: number) => ({ input_tokens: 2, cache_creation_input_tokens: 48, cache_read_input_tokens: tokens - 100, output_tokens: 50 })
const modelUsage = { 'claude-test': { contextWindow: 1_000_000 }, 'claude-small': { contextWindow: 200_000 } }

let turn = 0
for (let prompt = await nextMessage(); prompt !== undefined; prompt = await nextMessage()) {
  turn++
  const prompts = [prompt]
  emit({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), model: `claude-${model ?? 'default'}-test` })
  replay(prompt)
  if (prompt.includes('CRASH')) {
    process.stderr.write('boom: something broke\n')
    process.exit(3)
  }
  const contextTokens = Number(/CONTEXT=(\d+)/.exec(prompt)?.[1] ?? 1000)
  const said = (text: string) =>
    emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }], usage: usage(contextTokens) } })
  step('npm test', contextTokens - 500)
  const attach = /ATTACH=(\S+)/.exec(prompt)?.[1]
  if (attach) {
    said(`Ảnh giữa chừng:\n📎 ${attach} | giữa chừng`)
    step('npm run build', contextTokens - 400)
  }
  if (prompt.includes('SLOW')) await Bun.sleep(30_000)
  if (prompt.includes('WAIT')) for (const end = Date.now() + 5000; inbox.length === 0 && Date.now() < end; ) await Bun.sleep(10)
  // Messages that came while working join this turn, as Claude takes them in between steps.
  for (let more = inbox.shift(); more !== undefined; more = inbox.shift()) {
    replay(more)
    prompts.push(more)
    if (!more.includes('ASK')) continue
    said(`heard:${more}`) // the reply to a message read mid-turn, then the work goes on
    step('npm run lint', contextTokens - 300)
  }
  emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'done' }], usage: usage(contextTokens) } })
  // A background sub-agent's call, after the last main-thread one: its context is its own, not the session's.
  emit({ type: 'assistant', parent_tool_use_id: 'toolu_sub', message: { content: [], usage: usage(999_999) } })

  const facts = [
    `echo:${prompts.join(' + ').replace(/\n/g, ' / ')}`,
    `resumed:${resumed ?? '-'}`,
    `session:${sessionId}`,
    `pid:${process.pid}`,
    `turn:${turn}`,
    `cwd:${process.cwd()}`,
    `token:${process.env.TELEGRAM_BOT_TOKEN ? 'leak' : 'none'}`,
    `nested:${process.env.CLAUDECODE ? 'yes' : 'no'}`,
    `perm:${args.includes('--dangerously-skip-permissions') ? 'skip' : 'ask'}`,
    `model:${model ?? '-'}`,
    `plugin:${process.env.TELEGRAM_STATE_DIR ?? '-'}`,
  ]
  // LONG: sent as a file · MEDIUM: three Telegram messages, the last one ending with the facts
  const files = attach ? `\n\n📎 ${attach} | cuối\n📎 ${attach}.missing.png` : ''
  const text = prompt.includes('LONG') ? 'x'.repeat(30_000) : prompt.includes('MEDIUM') ? `${'y'.repeat(9000)}\n\n${facts.join('|')}` : facts.join('|') + files
  const subagentCall = () =>
    emit({ type: 'assistant', parent_tool_use_id: 'toolu_sub', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'x' } }] } })
  if (prompt.includes('SUBAGENT')) {
    said(text) // like claude: the final text comes before the result line, and here a background sub-agent's call between them
    subagentCall()
  }
  emit({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId, num_turns: 2, duration_ms: 5, modelUsage })
  if (prompt.includes('SUBAGENT')) subagentCall() // the sub-agent goes on after the turn's result
  // A successful turn whose stderr happens to contain the stale-session phrase must not run again.
  if (prompt.includes('NOISY_STDERR')) process.stderr.write('warning: No conversation found in cache\n')
  if (prompt.includes('EXIT_AFTER')) process.exit(0)
  if (prompt.includes('BACKGROUND')) await ownTurn(prompt.includes('BACKGROUND_WAIT'))
}
process.exit(0)

/** One tool call and its result. */
function step(command: string, tokens: number) {
  const tool = { type: 'tool_use', name: 'Bash', input: { command } }
  emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [tool], usage: usage(tokens) } })
  emit({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } })
}

/** Like claude when a background task it started finishes while it is idle: it begins a turn by itself. */
async function ownTurn(waitForMessage: boolean) {
  await Bun.sleep(300)
  turn++
  emit({ type: 'system', subtype: 'task_notification', task_id: 'bg1', status: 'completed', session_id: sessionId })
  emit({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), model: `claude-${model ?? 'default'}-test` })
  step('tail bot.log', 2000)
  if (waitForMessage) for (const end = Date.now() + 5000; inbox.length === 0 && Date.now() < end; ) await Bun.sleep(10)
  const joined = inbox.splice(0)
  for (const more of joined) replay(more)
  emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'bg-done' }], usage: usage(2100) } })
  const text = `bg-done|echo:${joined.join(' + ')}|turn:${turn}`
  emit({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId, num_turns: 3, duration_ms: 5, modelUsage })
}
