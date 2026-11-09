/** The parts of the Telegram Bot API objects this router reads. */

export interface TgUser {
  id: number
  is_bot: boolean
  first_name: string
  username?: string
}

export interface TgChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  is_forum?: boolean
}

export interface TgPhotoSize {
  file_id: string
  width: number
  height: number
  file_size?: number
}

export interface TgDocument {
  file_id: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

export interface TgMessage {
  message_id: number
  /** Unix time in seconds. */
  date: number
  chat: TgChat
  from?: TgUser
  /** Set on topic messages (and on reply threads of plain supergroups: check is_topic_message). */
  message_thread_id?: number
  is_topic_message?: boolean
  media_group_id?: string
  /** Present on a forwarded message (someone else's words). */
  forward_origin?: { type: string }
  text?: string
  caption?: string
  photo?: TgPhotoSize[]
  document?: TgDocument
  /** In a topic this is the topic's creation message when the user did not reply to anything. */
  reply_to_message?: TgMessage
  forum_topic_created?: { name: string }
}

/** A press on an inline button of a bot message. */
export interface TgCallbackQuery {
  id: string
  from: TgUser
  /**
   * The bot message whose button was pressed. When Telegram no longer gives it out (too old),
   * only `chat`, `message_id` and `date: 0` are set: no topic. Absent for inline-mode messages.
   */
  message?: TgMessage
  data?: string
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
  callback_query?: TgCallbackQuery
}
