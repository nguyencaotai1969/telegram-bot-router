import type { ResultEvent } from './claude-stream-events'
import type { RouterConfig } from './config'
import { formatElapsed, type ProgressStatus } from './progress-status'
import { splitForTelegram } from './reply-text-chunks'
import type { RunScheduler } from './run-scheduler'
import { sessionSizeReport } from './session-size-warning'
import type { BotApi } from './telegram-api'
import { sendOutgoingFiles, takeOutgoingFiles } from './telegram-outgoing-files'
import type { TgMessage } from './telegram-types'
import type { TopicConversations } from './topic-conversations'
import type { TopicStore } from './topic-store'

export interface TopicContext {
  chatId: number
  threadId?: number
  /** The message to answer; none for a turn Claude started by itself. */
  messageId?: number
  key: string
}

export interface RunDeps {
  api: BotApi
  config: RouterConfig
  store: TopicStore
  scheduler: RunScheduler
  conversations: TopicConversations
  inboxDir: string
}

/** One Telegram request: its text and the messages whose photos / files go with it. */
export interface RunInput {
  text: string
  messages: TgMessage[]
}

/** How one Claude turn ended. */
export interface TurnOutcome {
  result?: ResultEvent
  /** Exit code when the process itself ended the turn (crash, /stop, time limit); else null. */
  exitCode: number | null
  stderrTail: string
  stopped: boolean
  timedOut: boolean
  /** Claude had started the session when the turn ended. */
  sawInit: boolean
  /** Context size after the turn's last main-thread model call. */
  contextTokens?: number
}

/** Past this many messages the answer is sent as a .txt file instead. */
const MAX_ANSWER_MESSAGES = 6

/**
 * Closes one turn in its topic: the summary on its status message, the answer and the files it
 * names (📎 lines, paths from `cwd`), and the session-size warning. The session's usage is counted
 * before the first await, in turn order.
 */
export async function reportTurn(
  deps: RunDeps,
  ctx: TopicContext,
  cwd: string,
  progress: ProgressStatus,
  outcome: TurnOutcome,
): Promise<void> {
  const size = sessionSizeReport(deps.store, ctx.key, outcome, deps.config)
  await progress.finish(summaryLine(outcome, progress.elapsedMs(), deps.config.runTimeoutMs) + (size?.suffix ?? ''))
  const { text, files } = takeOutgoingFiles(answerText(outcome), cwd)
  await postReply(deps.api, ctx, text)
  await sendOutgoingFiles(deps.api, { chatId: ctx.chatId, threadId: ctx.threadId, replyTo: ctx.messageId }, files)
  if (size?.warning) {
    await deps.api.sendText(ctx.chatId, size.warning, { threadId: ctx.threadId }).catch(err => {
      console.error(`Gửi cảnh báo phiên lỗi: ${errorText(err)}`)
    })
  }
}

function summaryLine(outcome: TurnOutcome, elapsedMs: number, timeoutMs: number): string {
  const elapsed = formatElapsed(elapsedMs)
  if (outcome.stopped) return `⏹️ Đã dừng · ${elapsed}`
  if (outcome.timedOut) return `⌛ Quá ${Math.round(timeoutMs / 60_000)} phút, đã dừng.`
  const result = outcome.result
  if (result && !result.isError) return `✅ Xong · ${elapsed}${result.turns ? ` · ${result.turns} lượt` : ''}`
  if (result) return `⚠️ Claude báo lỗi (${result.subtype}) · ${elapsed}`
  return `⚠️ Claude thoát bất thường (mã ${outcome.exitCode ?? '?'}) · ${elapsed}`
}

const NO_ANSWER = '(Claude không gửi nội dung trả lời.)'

/** What the turn says: Claude's answer, or the error that ended it; nothing after /stop or the time limit. */
function answerText(outcome: TurnOutcome): string {
  if (outcome.stopped || outcome.timedOut) return ''
  if (outcome.result) return outcome.result.text.trim() || (outcome.result.isError ? '' : NO_ANSWER)
  const stderr = outcome.stderrTail.trim()
  return stderr ? `Lỗi từ Claude:\n${stderr.slice(-1500)}` : ''
}

/** Posts a text answering `ctx` (in parts, or as a .txt file when very long). Never throws. */
export async function postReply(api: BotApi, ctx: Pick<TopicContext, 'chatId' | 'threadId' | 'messageId'>, text: string): Promise<void> {
  if (!text.trim()) return
  const chunks = splitForTelegram(text.trim())
  try {
    if (chunks.length > MAX_ANSWER_MESSAGES) {
      await api.sendDocument(ctx.chatId, 'ket-qua.txt', text, { threadId: ctx.threadId, replyTo: ctx.messageId })
      return
    }
    for (const [index, chunk] of chunks.entries()) {
      await api.sendText(ctx.chatId, chunk, { threadId: ctx.threadId, replyTo: index === 0 ? ctx.messageId : undefined })
    }
  } catch (err) {
    console.error(`Gửi câu trả lời lỗi: ${errorText(err)}`)
  }
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
