/** Where a message goes in its chat and what it carries, and how that is written for the Bot API. */
export interface SendOptions {
  threadId?: number
  replyTo?: number
  /** Inline buttons under the message, in rows. */
  buttons?: InlineButton[][]
}

export interface FileOptions extends SendOptions {
  caption?: string
  /** Send as a photo instead of a file. */
  photo?: boolean
}

/** An inline button; `data` (≤ 64 bytes) comes back in the callback query when it is pressed. */
export interface InlineButton {
  text: string
  data: string
}

/** Buttons laid out `perRow` to a row. */
export function buttonRows(buttons: InlineButton[], perRow: number): InlineButton[][] {
  const rows: InlineButton[][] = []
  for (let i = 0; i < buttons.length; i += perRow) rows.push(buttons.slice(i, i + perRow))
  return rows
}

export function threadParams(opts: SendOptions): Record<string, unknown> {
  return {
    ...(opts.threadId ? { message_thread_id: opts.threadId } : {}),
    ...(opts.replyTo ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } } : {}),
    ...keyboard(opts.buttons),
  }
}

export function keyboard(buttons: InlineButton[][] | undefined): Record<string, unknown> {
  if (!buttons) return {}
  return { reply_markup: { inline_keyboard: buttons.map(row => row.map(b => ({ text: b.text, callback_data: b.data }))) } }
}
