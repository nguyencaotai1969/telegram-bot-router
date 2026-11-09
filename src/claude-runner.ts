import { killTree, trackRun } from './claude-process-kill'
import { parseStreamLine, type ClaudeEvent } from './claude-stream-events'
import { TELEGRAM_NOTE } from './claude-telegram-instructions'
import { ROUTER_ENV_KEYS } from './config'
import { isSessionId } from './session-id'

/** Variables a parent Claude Code session sets; a child that inherits them thinks it is nested. */
const SESSION_ENV_KEYS = [
  ...['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID'],
  ...['CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_EXECPATH'],
]

const MAX_LINE_CHARS = 16 * 1024 * 1024
const STDERR_TAIL_CHARS = 4000
/** After claude exits, its pipes get this long to drain (a background child may keep them open). */
const DRAIN_GRACE_MS = 5000
/** A killed process is reported as ended after this long, even if it has not gone yet. */
const KILL_DEADLINE_MS = 10_000

export interface LiveSessionRequest {
  command: readonly string[]
  cwd: string
  /** Continue this Claude session (`--resume`). */
  sessionId?: string
  model?: string
  /** Set on top of the cleaned environment. */
  extraEnv?: Record<string, string>
  onEvent(event: ClaudeEvent): void
}

export interface LiveSessionEnd {
  exitCode: number | null
  stderrTail: string
  /** Ended by kill() (/stop, time limit, /new…), not on its own. */
  killed: boolean
  /** Claude started its session (printed an init line) before it ended. */
  sawInit: boolean
}

export function claudeArgs(req: Pick<LiveSessionRequest, 'sessionId' | 'model'>): string[] {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages']
  args.push('--dangerously-skip-permissions', '--append-system-prompt', TELEGRAM_NOTE)
  if (req.model) args.push('--model', req.model)
  if (req.sessionId !== undefined) {
    if (!isSessionId(req.sessionId)) throw new Error('session id không hợp lệ')
    args.push('--resume', req.sessionId)
  }
  return args
}

/**
 * The router's own settings and a parent session's markers never reach Claude. Removing
 * TELEGRAM_BOT_TOKEN matters twice: Claude cannot read it, and an MCP server started by Claude
 * cannot poll the router's bot with it.
 */
export function claudeChildEnv(
  source: Record<string, string | undefined> = process.env,
  extra: Record<string, string> = {},
): Record<string, string> {
  const drop = new Set<string>([...SESSION_ENV_KEYS, ...ROUTER_ENV_KEYS])
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !drop.has(key.toUpperCase())) env[key] = value
  }
  return { ...env, ...extra }
}

function spawnClaude(req: LiveSessionRequest) {
  return Bun.spawn([...req.command, ...claudeArgs(req)], {
    cwd: req.cwd,
    env: claudeChildEnv(process.env, req.extraEnv),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  })
}

/**
 * One long-lived `claude -p` for one topic. Messages go in on stdin (stream-json), the prompt
 * never on the command line; each turn ends with a result line. It lives until kill() or until
 * it exits on its own. Throws when it cannot start (folder gone, claude.exe moved).
 */
export class ClaudeLiveSession {
  readonly ended: Promise<LiveSessionEnd>
  private readonly proc: ReturnType<typeof spawnClaude>
  private readonly deadline = Promise.withResolvers<null>()
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined
  private wasKilled = false
  private sawInit = false

  constructor(req: LiveSessionRequest) {
    const proc = spawnClaude(req)
    this.proc = proc
    void proc.exited.then(trackRun(proc.pid))
    const reading = readLines(proc.stdout, line => {
      for (const event of parseStreamLine(line)) {
        if (event.kind === 'init') this.sawInit = true
        try {
          req.onEvent(event)
        } catch (err) {
          console.error('Lỗi xử lý sự kiện Claude:', err)
        }
      }
    })
    const stderr = { tail: '' }
    const readingStderr = readTail(proc.stderr, stderr)
    // A broken pipe must not end the router: `ended` reports the process either way.
    for (const stream of [reading, readingStderr]) stream.catch(() => {})
    this.ended = (async (): Promise<LiveSessionEnd> => {
      const exitCode = await Promise.race([proc.exited, this.deadline.promise])
      clearTimeout(this.deadlineTimer)
      let graceTimer: ReturnType<typeof setTimeout> | undefined
      const grace = new Promise<void>(resolve => (graceTimer = setTimeout(resolve, DRAIN_GRACE_MS)))
      await Promise.race([Promise.all([reading, readingStderr]).catch(() => {}), grace])
      clearTimeout(graceTimer)
      return { exitCode, stderrTail: stderr.tail, killed: this.wasKilled, sawInit: this.sawInit }
    })()
  }

  /** Still running and not being killed: it can take messages. */
  get alive(): boolean {
    return !this.wasKilled && this.proc.exitCode === null
  }

  /** The router ended it (kill()): whatever it still prints is no longer news. */
  get killed(): boolean {
    return this.wasKilled
  }

  /** Hands Claude one user message. False when the process can no longer take it. */
  send(text: string): boolean {
    return this.write({ type: 'user', message: { role: 'user', content: text } })
  }

  /** Switches the model of the turns to come, in this same process (`set_model`); undefined: Claude Code's default. */
  setModel(model: string | undefined): boolean {
    return this.write({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'set_model', ...(model ? { model } : {}) } })
  }

  private write(line: object): boolean {
    if (!this.alive) return false
    try {
      this.proc.stdin.write(`${JSON.stringify(line)}\n`)
      const flushed = this.proc.stdin.flush()
      if (flushed instanceof Promise) flushed.catch(() => {}) // a dying process: `ended` reports it
      return true
    } catch {
      return false
    }
  }

  /** Ends the process and everything it started (shells, dev servers, sub-agents). */
  kill(): void {
    if (this.proc.exitCode !== null) return
    this.wasKilled = true
    void killTree(this.proc)
    this.deadlineTimer ??= setTimeout(() => this.deadline.resolve(null), KILL_DEADLINE_MS)
  }
}

export async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ''
  let skipping = false
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (skipping) skipping = false
      else if (line) onLine(line)
    }
    if (buffer.length > MAX_LINE_CHARS) {
      buffer = '' // a huge tool result: drop the rest of this line, keep reading
      skipping = true
    }
  }
  const last = (buffer + decoder.decode()).trim()
  if (last && !skipping) onLine(last)
}

async function readTail(stream: ReadableStream<Uint8Array>, sink: { tail: string }): Promise<void> {
  const decoder = new TextDecoder()
  for await (const chunk of stream) {
    sink.tail = (sink.tail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_CHARS)
  }
}
