import { basename } from 'node:path'
import type { LiveSessionEnd } from './claude-runner'
import type { ContextEvent, InitEvent, ResultEvent, TextEvent, ToolEvent } from './claude-stream-events'
import { ProgressStatus } from './progress-status'
import type { BotApi } from './telegram-api'
import { sendOutgoingFiles, takeOutgoingFiles } from './telegram-outgoing-files'
import { errorText, postReply, reportTurn, type RunDeps, type RunInput, type TopicContext, type TurnOutcome } from './topic-run'

/** A request and the bot's reply to it ("⏳ Bắt đầu…", "📨 …"), which the bot edits later. */
export interface Acked {
  ctx: TopicContext
  ack: Promise<number | undefined>
}

/** A Telegram request on its way into Claude. */
export interface Entry extends Acked {
  input: RunInput
  /** What was written to Claude: kept to write it again to a fresh process. */
  prompt?: string
}

/** What the bot's reply to a request turns into. */
export const ACK = {
  dropped: '⏹️ Đã bỏ (lệnh /stop).',
  unreadLost: '⚠️ Claude dừng trước khi đọc tin này. Gửi lại nếu vẫn cần.',
  read: '📨 Claude đã đọc tin này.',
}

/** Runs one Telegram send after those already queued for the topic. */
export type PostFn = (send: () => Promise<void>) => void

const OWN_TURN = '🔔 Claude tự làm tiếp: một việc chạy nền của nó vừa xong.'

/** Answers a request at once; resolves to the reply's id, or undefined when it could not be sent. */
export function sendAck(api: BotApi, ctx: TopicContext, text: string): Promise<number | undefined> {
  return api.sendText(ctx.chatId, text, { threadId: ctx.threadId, replyTo: ctx.messageId }).then(
    message => message.message_id,
    err => {
      console.error(`Gửi tin trạng thái lỗi: ${errorText(err)}`)
      return undefined
    },
  )
}

/** Rewrites the bot's reply to a request (best effort). */
export function editAck(api: BotApi, acked: Acked, text: string): void {
  void acked.ack.then(id => id !== undefined && api.editText(acked.ctx.chatId, id, text)).catch(() => {})
}

/** The status message of a turn Claude began by itself: no request to answer, a new message in the topic. */
export function ownTurnStatus(api: BotApi, place: Omit<TopicContext, 'messageId'>): Acked {
  const ctx = { chatId: place.chatId, threadId: place.threadId, key: place.key }
  return { ctx, ack: sendAck(api, ctx, OWN_TURN) }
}

/**
 * One Claude turn in a topic: from the request that opened it (or Claude starting by itself) to its
 * result line or the end of its process. Its status message is `first`'s ack, edited into its progress.
 * Claude's text is held until its next step: then it was not the final answer, and goes out at once
 * as the reply to a message Claude read mid-turn, with the files its 📎 lines name.
 */
export class TopicTurn {
  readonly progress: ProgressStatus
  private sawInit = false
  private timedOut = false
  private contextTokens?: number
  private readonly timer: ReturnType<typeof setTimeout>
  /** A message Claude took in mid-turn: the next thing it says answers it. */
  private owed?: Acked
  private held?: string

  constructor(
    private readonly deps: RunDeps,
    readonly first: Acked,
    private readonly cwd: string,
    onTimeout: () => void,
    private readonly post: PostFn,
    own = false,
  ) {
    const project = `${basename(cwd)}${own ? ' (tự làm tiếp)' : ''}`
    this.progress = new ProgressStatus(deps.api, first.ctx.chatId, first.ctx.threadId, first.ack, project)
    this.progress.start()
    this.sawInit = own
    this.timer = setTimeout(() => {
      this.timedOut = true
      onTimeout()
    }, deps.config.runTimeoutMs)
  }

  /** Claude took in `entry`, sent while it worked. */
  read(entry: Acked): void {
    this.owed = entry
  }

  /** One step: the turn started, Claude wrote text (its final answer if the result comes next) or called a tool, its context grew. */
  see(event: InitEvent | TextEvent | ToolEvent | ContextEvent): void {
    if (event.kind === 'init') {
      this.sawInit = true
    } else if (event.kind === 'context') {
      this.contextTokens = event.tokens
    } else if (event.kind === 'text') {
      this.release() // what Claude said before this was not its final answer
      this.held = event.text
    } else {
      // A sub-agent's call says nothing about Claude's own text: its result line may still come next.
      if (!event.sub) this.release()
      this.progress.addTool(event.line)
    }
  }

  /** Claude answered: the result line, which holds its last text. Reported after the topic's earlier posts. */
  answered(result: ResultEvent): void {
    this.close()
    const { timedOut, contextTokens } = this
    this.report({ result, exitCode: null, stderrTail: '', stopped: false, timedOut, sawInit: true, contextTokens })
  }

  /** The process ended first: /stop, the time limit, a crash. */
  cutShort(end: LiveSessionEnd, stopped: boolean): void {
    this.close()
    const { timedOut, contextTokens } = this
    this.report({ exitCode: end.exitCode, stderrTail: end.stderrTail, stopped, timedOut, sawInit: this.sawInit || end.sawInit, contextTokens })
  }

  private report(outcome: TurnOutcome): void {
    this.post(() => reportTurn(this.deps, this.first.ctx, this.cwd, this.progress, outcome))
  }

  private release(): void {
    const said = this.held
    this.held = undefined
    if (!said) return
    const { text, files } = takeOutgoingFiles(said, this.cwd)
    const owed = text ? this.owed : undefined
    if (owed) this.owed = undefined
    if (!owed && files.length === 0) return // talk between steps: the progress shows the steps
    const { api } = this.deps
    const place = { chatId: this.first.ctx.chatId, threadId: this.first.ctx.threadId, replyTo: owed?.ctx.messageId }
    this.post(async () => {
      if (owed) await postReply(api, owed.ctx, text)
      await sendOutgoingFiles(api, place, files)
    })
  }

  private close(): void {
    this.held = undefined // the result line carries it, or the turn was cut short
    clearTimeout(this.timer)
    this.progress.freeze()
  }
}

/**
 * Runs `send` after the topic's earlier posts, so answers keep their order even when a long one
 * goes out slowly. Never rejects.
 */
export function queuePost(conv: { reporting: Promise<void> }, send: () => Promise<void>): Promise<void> {
  const posted = conv.reporting.then(send).catch(err => console.error(`Gửi vào topic lỗi: ${errorText(err)}`))
  conv.reporting = posted
  return posted
}
