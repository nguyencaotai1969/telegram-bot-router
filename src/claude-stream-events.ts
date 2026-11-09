import { basename } from 'node:path'
import { isSessionId } from './session-id'

/** The final line of `claude -p --output-format stream-json`. */
export interface ResultEvent {
  kind: 'result'
  text: string
  isError: boolean
  subtype: string
  sessionId?: string
  turns?: number
  durationMs?: number
  /** Largest context window among the models the turn used. */
  contextWindow?: number
}

/** Tokens the session's context holds after one main-thread model call. */
export type ContextEvent = { kind: 'context'; tokens: number }

/** Claude took in one message the router wrote to its stdin (`--replay-user-messages`). */
export type ReplayEvent = { kind: 'replay' }

/** A turn starts: the session, and the model it runs on (e.g. claude-opus-5-5). */
export type InitEvent = { kind: 'init'; sessionId: string; model?: string }

/** Text Claude wrote in the session's own thread (not a sub-agent's): mid-turn, or its final answer. */
export type TextEvent = { kind: 'text'; text: string }

/** A tool call, as one line for the progress message. `sub`: a sub-agent's, which may go on after the turn's result. */
export type ToolEvent = { kind: 'tool'; line: string; sub: boolean }

export type ClaudeEvent = InitEvent | ToolEvent | TextEvent | ReplayEvent | ContextEvent | ResultEvent

/**
 * Claude itself doing something: with no turn open, it began one by itself (a background task of
 * its own finished). A sub-agent still working in the background is not Claude starting a turn.
 */
export function startsTurn(event: ClaudeEvent): boolean {
  return event.kind === 'text' || (event.kind === 'tool' && !event.sub) || event.kind === 'result'
}

const TOOL_ICONS: Record<string, string> = {
  Bash: '💻',
  PowerShell: '💻',
  Read: '📖',
  Edit: '✏️',
  MultiEdit: '✏️',
  Write: '📝',
  NotebookEdit: '📝',
  Grep: '🔎',
  Glob: '🔎',
  Task: '🤖',
  Agent: '🤖',
  WebFetch: '🌐',
  WebSearch: '🌐',
  TodoWrite: '📋',
}

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const numberOrUndefined = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** Turns one stream-json line into the events the router shows. Unknown or broken lines give nothing. */
export function parseStreamLine(line: string): ClaudeEvent[] {
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    return []
  }
  if (!isRecord(message)) return []
  if (message.type === 'system' && message.subtype === 'init') {
    if (!isSessionId(message.session_id)) return []
    return [{ kind: 'init', sessionId: message.session_id, ...(typeof message.model === 'string' ? { model: message.model } : {}) }]
  }
  // The router writes plain-string messages; tool results come back as arrays and are not replays.
  if (message.type === 'user' && message.isReplay === true && isRecord(message.message)) {
    return typeof message.message.content === 'string' ? [{ kind: 'replay' }] : []
  }
  if (message.type === 'assistant' && isRecord(message.message) && Array.isArray(message.message.content)) {
    const events: ClaudeEvent[] = []
    // A sub-agent's messages (parent_tool_use_id set) are its own: neither its words nor its context are the session's.
    const ownThread = !message.parent_tool_use_id
    for (const block of message.message.content) {
      if (isRecord(block) && block.type === 'tool_use' && typeof block.name === 'string') {
        events.push({ kind: 'tool', line: describeToolUse(block.name, block.input), sub: !ownThread })
      } else if (ownThread && isRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        events.push({ kind: 'text', text: block.text })
      }
    }
    const tokens = ownThread ? contextTokensOf(message.message.usage) : undefined
    if (tokens) events.push({ kind: 'context', tokens })
    return events
  }
  if (message.type === 'result') {
    return [
      {
        kind: 'result',
        text: typeof message.result === 'string' ? message.result : '',
        isError: message.is_error === true || message.subtype !== 'success',
        subtype: typeof message.subtype === 'string' ? message.subtype : 'unknown',
        sessionId: isSessionId(message.session_id) ? message.session_id : undefined,
        turns: numberOrUndefined(message.num_turns),
        durationMs: numberOrUndefined(message.duration_ms),
        contextWindow: largestContextWindow(message.modelUsage),
      },
    ]
  }
  return []
}

/** Everything the model read plus what it wrote: what the next call starts from. */
function contextTokensOf(usage: unknown): number | undefined {
  if (!isRecord(usage)) return undefined
  const fields = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']
  const total = fields.reduce((sum, field) => sum + (numberOrUndefined(usage[field]) ?? 0), 0)
  return total > 0 ? total : undefined
}

function largestContextWindow(modelUsage: unknown): number | undefined {
  if (!isRecord(modelUsage)) return undefined
  const windows = Object.values(modelUsage).map(model => (isRecord(model) ? numberOrUndefined(model.contextWindow) : undefined))
  const largest = Math.max(0, ...windows.map(value => value ?? 0))
  return largest > 0 ? largest : undefined
}

/** One short line per tool call, e.g. "💻 Bash: npm run typecheck". */
export function describeToolUse(name: string, input: unknown): string {
  const fields = isRecord(input) ? input : {}
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined)
  const file = (value: unknown) => (text(value) ? basename(String(value)) : undefined)
  // A shell step shows its description when Claude gave one: a raw command line may hold a
  // password or token, and the group's history keeps it.
  const shell = name === 'Bash' || name === 'PowerShell'
  const detail =
    (shell ? text(fields.description) : undefined) ??
    text(fields.command) ??
    file(fields.file_path) ??
    file(fields.notebook_path) ??
    text(fields.description) ??
    text(fields.pattern) ??
    text(fields.url) ??
    text(fields.query) ??
    ''
  return oneLine(`${TOOL_ICONS[name] ?? '🔧'} ${name}${detail ? `: ${detail}` : ''}`, 90)
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  let cut = max - 1
  const code = flat.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut-- // never split an emoji's surrogate pair
  return `${flat.slice(0, cut)}…`
}
