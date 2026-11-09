import type { RunScheduler } from './run-scheduler'
import { BusyPeriod } from './topic-busy-period'
import type { ClaudeProcess } from './topic-claude-process'
import type { RunDeps, RunInput, TopicContext } from './topic-run'

/** What stays of a topic between messages: its warm Claude process and the work in progress. */
export interface Conversation {
  readonly key: string
  /**
   * The topic's Claude process. It stays up between turns until /stop, /new, /bind or /unbind
   * kill it, and only its own end clears it: a replacement always waits for it to be gone.
   */
  process?: ClaudeProcess
  /** The busy period new messages join, if any. */
  period?: BusyPeriod
  /** The topic's turn reports, one after the other: answers keep their order. */
  reporting: Promise<void>
  /** Where the topic is: where a turn Claude begins by itself is shown. */
  place?: { chatId: number; threadId?: number }
}

/** Claude in a topic: answering now, up and waiting (next answer is quick), or not started. */
export type TopicClaudeState = 'working' | 'warm' | 'off'

const JOINED = '📨 Đã gửi vào việc đang chạy: Claude đọc ở bước kế tiếp.'
const JOINED_WAITING = '🕒 Đang chờ lượt: tin này sẽ đến Claude cùng tin trước.'

/** One Claude conversation per topic, each with its own long-lived process. */
export class TopicConversations {
  private readonly conversations = new Map<string, Conversation>()

  /**
   * Hands one request to the topic's Claude, synchronously (a later message of the topic can
   * never overtake it): it joins the work in progress, or starts a busy period.
   */
  deliver(deps: RunDeps, ctx: TopicContext, input: RunInput): void {
    const conv = this.of(ctx.key)
    conv.place = { chatId: ctx.chatId, threadId: ctx.threadId }
    const current = conv.period
    if (current) {
      current.add(ctx, input, current.started ? JOINED : JOINED_WAITING)
      return
    }
    const period = new BusyPeriod(deps, conv)
    const slotsFull = deps.scheduler.slotsFull
    const ahead = deps.scheduler.enqueue(ctx.key, control => period.run(control), () => period.dropped())
    if (ahead < 0) {
      const busy = '⛔ Topic còn đang dừng các việc trước. Gửi lại sau ít giây.'
      void deps.api.sendText(ctx.chatId, busy, { threadId: ctx.threadId, replyTo: ctx.messageId }).catch(() => {})
      return
    }
    conv.period = period
    const waiting = slotsFull ? `🕒 Đang chờ: đã có ${deps.config.maxParallelRuns} việc chạy cùng lúc.` : '⏳ Bắt đầu…'
    period.add(ctx, input, ahead > 0 ? '🕒 Chờ việc trước dừng hẳn…' : waiting)
  }

  /** /stop: ends the topic's work (running or still waiting for its slot) or, when idle, its process. */
  stop(scheduler: RunScheduler, key: string): 'work' | 'process' | 'nothing' {
    const period = this.conversations.get(key)?.period
    const { stopped, dropped } = scheduler.stop(key)
    if (period && !period.stopped) period.stop() // one still waiting for its slot has no stop hook yet
    if (stopped || dropped > 0 || period) return 'work'
    return this.shutDown(key) ? 'process' : 'nothing'
  }

  /**
   * Claude began a turn by itself (a background task of its own finished) after its busy period
   * ended. The topic's waiting period takes the process, else a new period, queued like a message's:
   * Claude's own turn is shown at once (a slot cannot hold it back), while what the user sends
   * meanwhile waits for a slot as usual. Only a full topic queue makes the period run unqueued.
   */
  adoptOwnTurn(deps: RunDeps, conv: Conversation, proc: ClaudeProcess): BusyPeriod {
    const waiting = conv.period
    if (waiting) {
      waiting.adopt(proc, false)
      return waiting
    }
    const period = new BusyPeriod(deps, conv)
    const ahead = deps.scheduler.enqueue(conv.key, control => period.run(control), () => period.dropped())
    conv.period = period
    period.adopt(proc, ahead < 0)
    return period
  }

  state(key: string): TopicClaudeState {
    const conv = this.conversations.get(key)
    if (conv?.period) return 'working'
    return conv?.process?.live.alive ? 'warm' : 'off'
  }

  /** Work in the topic: a busy period (also one Claude began by itself), or a stopped one still ending. */
  busy(scheduler: RunScheduler, key: string): boolean {
    return scheduler.status(key).busy || this.state(key) === 'working'
  }

  /** The model the topic's warm process reports it runs on, if one is up. */
  runningModel(key: string): string | undefined {
    const proc = this.conversations.get(key)?.process
    return proc?.live.alive ? proc.runningModel : undefined
  }
  /** Ends the topic's Claude process and what it started. False when none was up. */
  shutDown(key: string): boolean {
    const live = this.conversations.get(key)?.process?.live
    if (!live?.alive) return false
    live.kill()
    return true
  }

  /** Ends every topic's process; resolves once they are all gone (their folders are free again). */
  async shutDownAll(): Promise<void> {
    const ending = [...this.conversations.values()].flatMap(conv => (conv.process ? [conv.process.live.ended] : []))
    for (const key of this.conversations.keys()) this.shutDown(key)
    await Promise.all(ending)
  }

  private of(key: string): Conversation {
    let conv = this.conversations.get(key)
    if (!conv) {
      conv = { key, reporting: Promise.resolve() }
      this.conversations.set(key, conv)
    }
    return conv
  }
}
