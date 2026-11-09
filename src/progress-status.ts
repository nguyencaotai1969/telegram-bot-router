import { TelegramApiError, type BotApi } from './telegram-api'

const MAX_TOOL_LINES = 6
/** At most one progress edit per run this often: 3 parallel runs stay under Telegram's ~20 a minute per group. */
const TICK_MS = 10_000
/** With no new step, the elapsed time is refreshed this often. */
const HEARTBEAT_MS = 30_000

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes ? `${minutes}m${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`
}

/** The "⏳ working…" message of one run: the last steps Claude took, edited in place, in order. */
export class ProgressStatus {
  private readonly tools: string[] = []
  private readonly startedAt = Date.now()
  private endedAt: number | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private queue: Promise<void> = Promise.resolve()
  private pendingEdits = 0
  private shown = ''
  private lastEditAt = 0
  private dirty = true

  constructor(
    private readonly api: BotApi,
    private readonly chatId: number,
    private readonly threadId: number | undefined,
    /** The status message to edit; it may still be on its way. */
    private readonly messageId: Promise<number | undefined>,
    private readonly project: string,
  ) {}

  start(): void {
    this.tick()
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  addTool(line: string): void {
    this.tools.push(line)
    if (this.tools.length > MAX_TOOL_LINES) this.tools.shift()
    this.dirty = true
  }

  /** How long the turn took: up to its end, not to when its summary gets posted. */
  elapsedMs(): number {
    return (this.endedAt ?? Date.now()) - this.startedAt
  }

  /** The turn is over: no more "đang làm" edits while its summary waits for its turn to be posted. */
  freeze(): void {
    clearInterval(this.timer)
    this.endedAt ??= Date.now()
  }

  /** Last edit: the summary line over the last steps. Queued after any edit still on its way. */
  finish(summary: string): Promise<void> {
    clearInterval(this.timer)
    return this.edit([summary, ...this.tools].join('\n'), true)
  }

  private tick(): void {
    // An edit still waiting (e.g. a flood pause) means Telegram is busy: skip, never pile up.
    if (this.pendingEdits > 0) return
    if (!this.dirty && Date.now() - this.lastEditAt < HEARTBEAT_MS) return
    this.dirty = false
    const header = `⏳ ${this.project} · đang làm ${formatElapsed(this.elapsedMs())}`
    void this.edit([header, ...this.tools].join('\n'), false)
  }

  private edit(text: string, final: boolean): Promise<void> {
    this.pendingEdits++
    this.lastEditAt = Date.now()
    this.queue = this.queue
      .then(() => this.send(text, final))
      .finally(() => {
        this.pendingEdits--
      })
    return this.queue
  }

  /** The API already waits out flood limits and retries network errors. */
  private async send(text: string, final: boolean): Promise<void> {
    try {
      const messageId = await this.messageId
      if (messageId === undefined) {
        if (final) await this.api.sendText(this.chatId, text, { threadId: this.threadId })
        return
      }
      if (text === this.shown) return
      await this.api.editText(this.chatId, messageId, text)
      this.shown = text
    } catch (err) {
      if (err instanceof TelegramApiError && /not modified/i.test(err.description)) return
      console.warn(`Sửa tin tiến độ lỗi: ${err instanceof Error ? err.message : err}`)
    }
  }
}
