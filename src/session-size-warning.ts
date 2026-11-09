import type { RouterConfig } from './config'
import type { TurnOutcome } from './topic-run'
import type { SessionUsage, TopicStore } from './topic-store'

/** The two limits past which a session is worth restarting (0 = that limit is off). */
export type SessionLimits = Pick<RouterConfig, 'contextWarnTokens' | 'sessionWarnMessages'>

/** What one finished run adds to the topic's messages. */
export interface SessionSizeReport {
  /** Appended to the "✅ Xong" line: the context size, and a reminder while over a limit. */
  suffix: string
  /** Sent as its own message, once per session: on the first run that finds it over a limit. */
  warning?: string
}

/** 950 → "950", 209_824 → "210k", 1_000_000 → "1M". */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const thousands = Math.round(tokens / 1000)
  if (thousands < 1000) return `${thousands}k`
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** "210k token (21% của 1M) · 18 tin". */
export function describeUsage(usage: SessionUsage): string {
  const share = usage.contextWindow
    ? ` (${Math.round((usage.contextTokens / usage.contextWindow) * 100)}% của ${formatTokens(usage.contextWindow)})`
    : ''
  return `${formatTokens(usage.contextTokens)} token${share} · ${usage.messages} tin`
}

function overLimits(usage: SessionUsage | undefined, limits: SessionLimits) {
  return {
    context: limits.contextWarnTokens > 0 && (usage?.contextTokens ?? 0) >= limits.contextWarnTokens,
    messages: limits.sessionWarnMessages > 0 && (usage?.messages ?? 0) >= limits.sessionWarnMessages,
  }
}

export function isOverLimit(usage: SessionUsage | undefined, limits: SessionLimits): boolean {
  const over = overLimits(usage, limits)
  return over.context || over.messages
}

export function warningText(usage: SessionUsage): string {
  return [
    `⚠️ Phiên này đã nặng: ${describeUsage(usage)}.`,
    'Mỗi tin sau Claude phải đọc lại toàn bộ ngữ cảnh nên chậm và tốn hơn.',
    'Gõ /new để mở phiên mới. Nếu việc đang dở, bảo Claude tóm tắt lại trước rồi mới /new.',
  ].join('\n')
}

/**
 * Counts a turn in the topic's session and says what to tell the user. A stopped or timed-out
 * turn counts too: its context stays in the session. Nothing when Claude never started one.
 * Never throws: a state.json that cannot be written must not cost the user Claude's answer.
 */
export function sessionSizeReport(
  store: TopicStore,
  key: string,
  outcome: Pick<TurnOutcome, 'result' | 'contextTokens' | 'sawInit'>,
  limits: SessionLimits,
): SessionSizeReport | undefined {
  const sessionId = outcome.result?.sessionId ?? (outcome.sawInit ? store.get(key)?.sessionId : undefined)
  if (!sessionId) return undefined
  let warn = false
  const update = (current: SessionUsage | undefined): SessionUsage => {
    const next: SessionUsage = {
      messages: (current?.messages ?? 0) + 1,
      contextTokens: outcome.contextTokens ?? current?.contextTokens ?? 0,
    }
    const window = outcome.result?.contextWindow ?? current?.contextWindow
    if (window) next.contextWindow = window
    warn = !current?.warned && isOverLimit(next, limits)
    if (warn || current?.warned) next.warned = true
    return next
  }
  let usage: SessionUsage | undefined
  try {
    usage = store.updateUsage(key, sessionId, update)
  } catch (err) {
    console.error(`Không lưu được độ lớn phiên: ${err instanceof Error ? err.message : err}`)
    return undefined
  }
  if (!usage) return undefined
  const size = usage.contextTokens ? ` · 🧠 ${formatTokens(usage.contextTokens)}` : ''
  return {
    suffix: `${size}${isOverLimit(usage, limits) ? '\n⚠️ Phiên đã nặng: gõ /new để mở phiên mới' : ''}`,
    ...(warn ? { warning: warningText(usage) } : {}),
  }
}
