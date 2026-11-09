import { mkdirSync } from 'node:fs'
import { killTree, trackRun } from './claude-process-kill'
import { claudeChildEnv, readLines } from './claude-runner'
import { isModelName, pluginOffEnv, type RouterConfig } from './config'

/** A model this Claude Code offers the account, as its `initialize` answer lists it. */
export interface ClaudeModel {
  /** What `--model` / `set_model` take: an alias (`opus`), a full name, or `default`. */
  value: string
  /** e.g. "Opus 4.8". */
  displayName: string
  /** e.g. "Sonnet 5.5 · Efficient for routine tasks" (for `default`: what it is now). */
  description: string
}

type ListConfig = Pick<RouterConfig, 'claudeCommand' | 'dataDir'>

const ASK_TIMEOUT_MS = 20_000
/** A list older than this is asked again, in the background: Claude Code updates itself. */
const FRESH_MS = 60 * 60_000
/** After a failed ask, the next one waits this long (no claude.exe per /model while it fails). */
const RETRY_MS = 5 * 60_000
const REQUEST_ID = 'router-models'

interface Known {
  models?: ClaudeModel[]
  /** When the last ask ended (0: never asked). */
  at: number
  asking?: Promise<ClaudeModel[] | undefined>
}
const known = new Map<string, Known>()

/**
 * The models this Claude Code offers, as known right now: never waits. Undefined until Claude
 * Code has answered once. Asks it (again) in the background when due. No model is called: Claude
 * only answers its stream-json `initialize` request, then is ended.
 */
export function knownModels(config: ListConfig): ClaudeModel[] | undefined {
  return entryFor(config).models
}

/** The same list, waiting at most `maxWaitMs` for an ask in progress (e.g. right after start). */
export async function claudeModels(config: ListConfig, maxWaitMs = 3000): Promise<ClaudeModel[] | undefined> {
  const entry = entryFor(config)
  if (entry.models || !entry.asking) return entry.models
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), maxWaitMs)
  })
  try {
    return (await Promise.race([entry.asking, waited])) ?? entry.models
  } finally {
    clearTimeout(timer)
  }
}

function entryFor(config: ListConfig): Known {
  const key = config.claudeCommand.join('\0')
  let entry = known.get(key)
  if (!entry) known.set(key, (entry = { at: 0 }))
  const age = Date.now() - entry.at
  const due = entry.at === 0 || age > (entry.models ? FRESH_MS : RETRY_MS)
  if (due && !entry.asking) {
    const current = entry
    current.asking = askModels(config)
      .catch(err => {
        console.warn(`Không lấy được danh sách model của Claude Code: ${err instanceof Error ? err.message : err}`)
        return undefined
      })
      .then(models => {
        current.asking = undefined
        current.at = Date.now()
        if (models) current.models = models // a failed refresh keeps the list it had
        return current.models
      })
  }
  return entry
}

async function askModels(config: ListConfig): Promise<ClaudeModel[] | undefined> {
  mkdirSync(config.dataDir, { recursive: true })
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
  const proc = Bun.spawn([...config.claudeCommand, ...args], {
    cwd: config.dataDir,
    env: claudeChildEnv(process.env, pluginOffEnv(config.dataDir)),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
    windowsHide: true,
  })
  void proc.exited.then(trackRun(proc.pid))
  const answer = Promise.withResolvers<ClaudeModel[] | undefined>()
  const timer = setTimeout(() => answer.resolve(undefined), ASK_TIMEOUT_MS)
  void readLines(proc.stdout, line => {
    const message = parseJson(line)
    if (message?.type === 'control_response' && message.response?.request_id === REQUEST_ID) {
      answer.resolve(modelsOf(message.response.response?.models))
    }
  })
    .catch(() => {})
    .finally(() => answer.resolve(undefined))
  try {
    proc.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: REQUEST_ID, request: { subtype: 'initialize' } })}\n`)
    await proc.stdin.flush()
    return await answer.promise
  } finally {
    clearTimeout(timer)
    void killTree(proc) // it never got a prompt: nothing to keep
  }
}

// biome-ignore lint/suspicious/noExplicitAny: a stream-json line, checked field by field below
function parseJson(line: string): any {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/** Only entries whose value is safe for `--model` (and fits Telegram's 64-byte button data). */
function modelsOf(raw: unknown): ClaudeModel[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const models = raw.flatMap(item => {
    const { value, displayName, description } = (item ?? {}) as Record<string, unknown>
    if (!isModelName(value) || value.length > 48 || typeof displayName !== 'string') return []
    return [{ value, displayName: displayName.slice(0, 40), description: typeof description === 'string' ? description.slice(0, 120) : '' }]
  })
  return models.length > 0 ? models : undefined
}
