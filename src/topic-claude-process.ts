import { ClaudeLiveSession, type LiveSessionEnd } from './claude-runner'
import { type ClaudeEvent, startsTurn } from './claude-stream-events'
import { pluginOffEnv } from './config'
import type { Conversation } from './topic-conversations'
import { errorText, type RunDeps } from './topic-run'

const STALE_SESSION = /No conversation found/i

/** The busy period a process answers to: it gets the process's events and its end. */
export interface ProcessOwner {
  /** /stop came: it must not get a new process. */
  readonly stopped: boolean
  /** Over: what Claude does from now on (a turn it begins by itself) needs a new owner. */
  readonly finished: boolean
  onEvent(event: ClaudeEvent): void
  onEnd(proc: ClaudeProcess, end: LiveSessionEnd): void
}

/** A topic's Claude process. It outlives busy periods: each one that uses it becomes its owner. */
export interface ClaudeProcess {
  readonly live: ClaudeLiveSession
  readonly cwd: string
  /** Started with `--resume`: only such a process can find its session gone. */
  readonly resumed: boolean
  /** The model it was started with (`--model`) or switched to since (undefined: Claude Code's default). */
  model: string | undefined
  /** The model Claude reports it runs on (from its init line), e.g. claude-opus-5-5. */
  runningModel?: string
  owner: ProcessOwner
}

/** The model the topic's Claude should run on: the one chosen with /model, else CLAUDE_MODEL. */
export function topicModel(deps: RunDeps, key: string): string | undefined {
  return deps.store.get(key)?.model ?? deps.config.claudeModel
}

/**
 * The topic's process for `owner`: the warm one, or a new one resuming the topic's session.
 * One still dying (killed, crashed) is waited for first, so its end is handled (its turn closed
 * and reported, or its session restarted) before anything replaces it: two processes never
 * work on one session. While Claude is `idle`, a model changed with /model is switched in place
 * (`set_model`: the process and what it runs live on); a busy one is never touched for it.
 * A string says why Claude cannot run.
 */
export async function claudeProcessFor(
  deps: RunDeps,
  conv: Conversation,
  owner: ProcessOwner,
  idle: boolean,
): Promise<ClaudeProcess | string> {
  for (;;) {
    if (owner.stopped) return '⏹️ Đã bỏ (lệnh /stop).' // e.g. /stop while the old one was dying
    const binding = deps.store.get(conv.key)
    if (!binding) return '⚠️ Topic đã bỏ gắn dự án, tin này bị bỏ qua.'
    const proc = conv.process
    if (!proc) return startClaudeProcess(deps, conv, owner, binding.cwd, binding.sessionId)
    const wanted = topicModel(deps, conv.key)
    if (idle && proc.model !== wanted && proc.live.setModel(wanted)) proc.model = wanted
    if (proc.live.alive && proc.cwd === binding.cwd && (!idle || proc.model === wanted)) {
      proc.owner = owner
      return proc
    }
    proc.live.kill() // another folder or model; a no-op for one already gone
    await proc.live.ended // its own end handler, registered first, runs before this
    if (conv.process === proc) conv.process = undefined
  }
}

/** A `--resume` of a session Claude no longer has: the process failed before starting anything. */
export function sessionWasGone(proc: ClaudeProcess, end: LiveSessionEnd): boolean {
  return proc.resumed && !end.killed && !end.sawInit && STALE_SESSION.test(end.stderrTail)
}

/** Forgets the topic's gone session and starts its process fresh, with `prompts` written again. */
export function restartWithoutSession(
  deps: RunDeps,
  conv: Conversation,
  owner: ProcessOwner,
  cwd: string,
  prompts: string[],
): ClaudeProcess | undefined {
  saveTopicSession(deps, conv.key, undefined, cwd)
  const proc = startClaudeProcess(deps, conv, owner, cwd, undefined)
  if (typeof proc === 'string') return undefined
  for (const prompt of prompts) proc.live.send(prompt)
  return proc
}

/** Saves the topic's session; when state.json cannot be written it is kept in memory all the same. */
export function saveTopicSession(deps: RunDeps, key: string, sessionId: string | undefined, cwd: string | undefined): void {
  try {
    deps.store.setSession(key, sessionId, cwd)
  } catch (err) {
    console.error(`Không lưu được phiên: ${errorText(err)}`)
  }
}

/** Starts the topic's process and makes it the topic's current one. */
export function startClaudeProcess(
  deps: RunDeps,
  conv: Conversation,
  owner: ProcessOwner,
  cwd: string,
  sessionId: string | undefined,
): ClaudeProcess | string {
  let proc: ClaudeProcess
  const model = topicModel(deps, conv.key)
  try {
    const live: ClaudeLiveSession = new ClaudeLiveSession({
      command: deps.config.claudeCommand,
      model,
      cwd,
      sessionId,
      extraEnv: pluginOffEnv(deps.config.dataDir),
      // What a process prints after the router killed it is no longer news: its end reports the turn.
      onEvent: event => {
        if (live.killed) return
        if (event.kind === 'init' && event.model) proc.runningModel = event.model
        // A background task Claude started has finished and it works again, its busy period long over.
        if (proc.owner.finished && startsTurn(event)) deps.conversations.adoptOwnTurn(deps, conv, proc)
        proc.owner.onEvent(event)
      },
    })
    proc = { live, cwd, resumed: sessionId !== undefined, model, owner }
  } catch (err) {
    return `⚠️ Không chạy được Claude: ${errorText(err)}`
  }
  conv.process = proc
  void proc.live.ended
    .then(end => {
      if (conv.process === proc) conv.process = undefined
      proc.owner.onEnd(proc, end)
    })
    .catch(err => console.error(`Lỗi khi tiến trình Claude kết thúc: ${errorText(err)}`))
  return proc
}
