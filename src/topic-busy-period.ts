import type { LiveSessionEnd } from './claude-runner'
import { type ClaudeEvent, startsTurn } from './claude-stream-events'
import { requestPrompt } from './run-prompt'
import type { JobControl } from './run-scheduler'
import { type ClaudeProcess, claudeProcessFor, type ProcessOwner } from './topic-claude-process'
import { restartWithoutSession, saveTopicSession, sessionWasGone } from './topic-claude-process'
import type { Conversation } from './topic-conversations'
import { errorText, type RunDeps, type RunInput } from './topic-run'
import { type Acked, ACK, editAck, type Entry, ownTurnStatus, type PostFn, queuePost, sendAck, TopicTurn } from './topic-turn'

/**
 * A topic's Claude being busy: from a message reaching the idle topic (or Claude starting a turn by
 * itself) until everything sent meanwhile is answered and posted. One scheduler job (one
 * MAX_PARALLEL_RUNS slot); later messages join it.
 */
export class BusyPeriod implements ProcessOwner {
  /** Received, not yet written to Claude (waiting for the slot, a download, or a dying process). */
  private readonly inbox: Entry[] = []
  /** Written to Claude, not yet taken in by it (no replay yet), in order. */
  private readonly unread: Entry[] = []
  private turn: TopicTurn | undefined
  private proc: ClaudeProcess | undefined
  private running = false
  private stopping = false
  private pumping = false
  private reports = 0
  private ended = false
  private readonly done = Promise.withResolvers<void>()

  constructor(
    private readonly deps: RunDeps,
    private readonly conv: Conversation,
  ) {}

  /** The scheduler has started it: it holds a slot. */
  get started(): boolean {
    return this.running
  }

  get stopped(): boolean {
    return this.stopping
  }

  /** Takes one more request and answers it at once with `ackText`. */
  add(ctx: Entry['ctx'], input: RunInput, ackText: string): void {
    this.inbox.push({ ctx, ack: sendAck(this.deps.api, ctx, ackText), input })
    if (this.running) void this.pump()
  }

  /** The scheduler job: lasts until Claude is idle and its answers are posted, or /stop. */
  run(control: JobControl): Promise<void> {
    this.running = true
    control.onStop(() => this.stop())
    void this.pump()
    return this.done.promise
  }

  /** Takes the topic's process, in which Claude began a turn by itself. `alone`: no scheduler job runs this period. */
  adopt(proc: ClaudeProcess, alone: boolean): void {
    this.proc = proc
    proc.owner = this
    if (alone) this.running = true
  }

  /** Never got to run: /stop before its slot came. */
  dropped(): void {
    this.dropInbox()
    this.finish()
  }

  /**
   * /stop: ends Claude's work and what it started. The period lets go of the topic at once, so
   * what the user sends next starts a new period, queued until this one is over. Again: retries the kill.
   */
  stop(): void {
    this.stopping = true
    if (this.conv.period === this) this.conv.period = undefined
    this.dropInbox()
    ;(this.proc ?? this.conv.process)?.live.kill()
    this.finishIfIdle()
  }

  /** Over: no more events, no more messages. A turn Claude begins by itself after this goes to a new period. */
  get finished(): boolean {
    return this.ended
  }

  onEvent(event: ClaudeEvent): void {
    if (this.ended) return
    if (!this.turn && startsTurn(event)) this.openOwnTurn()
    const turn = this.turn
    if (event.kind === 'init') saveTopicSession(this.deps, this.conv.key, event.sessionId, this.proc?.cwd)
    if (event.kind === 'replay') {
      const taken = this.unread.shift()
      if (taken && taken !== turn?.first) {
        this.note(taken, ACK.read)
        turn?.read(taken)
      }
    } else if (event.kind !== 'result') {
      turn?.see(event)
    } else if (turn) {
      // what Claude has not taken in yet makes it start its next turn by itself
      this.turn = undefined
      turn.answered(event)
      if (this.unread[0]) this.openTurn(this.unread[0])
    }
  }

  /** The process this period writes to has ended: /stop, the time limit, a crash, a stale session. */
  onEnd(proc: ClaudeProcess, end: LiveSessionEnd): void {
    if (proc !== this.proc) return
    this.proc = undefined
    if (!this.stopping && sessionWasGone(proc, end)) {
      // The session to resume was gone: nothing was read, so everything unread is written again.
      const prompts = this.unread.flatMap(entry => (entry.prompt ? [entry.prompt] : []))
      this.proc = restartWithoutSession(this.deps, this.conv, this, proc.cwd, prompts)
      this.turn?.progress.addTool('🆕 Phiên cũ không còn, bắt đầu phiên mới')
      if (this.proc) return
    }
    const turn = this.turn
    this.turn = undefined
    for (const entry of this.unread.splice(0)) {
      if (entry !== turn?.first) this.note(entry, this.stopping ? ACK.dropped : ACK.unreadLost)
    }
    turn?.cutShort(end, this.stopping)
    this.finishIfIdle()
  }

  /** Writes the inbox to Claude in arrival order: a slow download never lets a later message overtake. */
  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    for (let entry = this.inbox.shift(); entry; entry = this.inbox.shift()) {
      const taken = entry
      await this.take(taken).catch(err => this.note(taken, `⚠️ Lỗi: ${errorText(err)}`))
    }
    this.pumping = false
    this.finishIfIdle()
  }

  private async take(entry: Entry): Promise<void> {
    let prompt: string
    try {
      prompt = await requestPrompt(this.deps.api, entry.input.text, entry.input.messages, this.deps.inboxDir)
    } catch (err) {
      return this.note(entry, `⚠️ Không tải được tệp đính kèm: ${errorText(err)}`)
    }
    if (this.stopping) return this.note(entry, ACK.dropped)
    const proc = await claudeProcessFor(this.deps, this.conv, this, !this.turn && this.unread.length === 0)
    if (typeof proc === 'string') return this.note(entry, proc)
    if (this.stopping) {
      proc.live.kill() // /stop came while it was starting
      return this.note(entry, ACK.dropped)
    }
    this.proc = proc
    entry.prompt = prompt
    if (!this.turn) this.openTurn(entry)
    this.unread.push(entry)
    proc.live.send(prompt) // false only for a process on its way out: its end reports the turn
  }

  private openTurn(first: Acked, own = false): void {
    this.turn = new TopicTurn(this.deps, first, this.proc?.cwd ?? '', () => this.proc?.live.kill(), this.post, own)
  }

  /** Claude began a turn by itself: it gets a status message of its own in the topic. */
  private openOwnTurn(): void {
    const place = this.conv.place
    if (place) this.openTurn(ownTurnStatus(this.deps.api, { ...place, key: this.conv.key }), true)
  }

  /** Sends after the topic's earlier posts; the period lasts until it is out. */
  private readonly post: PostFn = send => {
    this.reports++
    void queuePost(this.conv, send).then(() => {
      this.reports--
      this.finishIfIdle()
    })
  }

  private note(entry: Acked, text: string): void {
    editAck(this.deps.api, entry, text)
  }

  private dropInbox(): void {
    for (const entry of this.inbox.splice(0)) this.note(entry, ACK.dropped)
  }

  private finishIfIdle(): void {
    if (this.turn || this.unread.length > 0 || this.inbox.length > 0 || this.pumping || this.reports > 0) return
    this.finish()
  }

  private finish(): void {
    if (this.ended) return
    this.ended = true
    if (this.conv.period === this) this.conv.period = undefined
    this.done.resolve()
  }
}
