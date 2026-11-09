import type { TgMessage } from './telegram-types'

/** Telegram sends an album as one message per photo; this many ms of quiet closes the album. */
const ALBUM_QUIET_MS = 1500
const MAX_ALBUM_ITEMS = 10

interface PendingAlbum {
  chatId: number
  messages: TgMessage[]
  timer: ReturnType<typeof setTimeout>
}

/**
 * Hands single messages on at once and an album's messages together, as one request.
 * A plain message (e.g. /stop) first flushes the albums of its chat, so it never overtakes them.
 */
export class MediaGroupCollector {
  private readonly albums = new Map<string, PendingAlbum>()

  constructor(
    private readonly onReady: (messages: TgMessage[]) => void,
    private readonly quietMs = ALBUM_QUIET_MS,
  ) {}

  push(message: TgMessage): void {
    if (!message.media_group_id) {
      this.flushChat(message.chat.id)
      this.onReady([message])
      return
    }
    const id = `${message.chat.id}:${message.media_group_id}`
    const album = this.albums.get(id)
    if (album) clearTimeout(album.timer)
    const messages = album?.messages ?? []
    if (messages.length < MAX_ALBUM_ITEMS) messages.push(message)
    const timer = setTimeout(() => this.flush(id), this.quietMs)
    this.albums.set(id, { chatId: message.chat.id, messages, timer })
  }

  private flushChat(chatId: number): void {
    for (const [id, album] of this.albums) if (album.chatId === chatId) this.flush(id)
  }

  private flush(id: string): void {
    const album = this.albums.get(id)
    if (!album) return
    clearTimeout(album.timer)
    this.albums.delete(id)
    this.onReady(album.messages.sort((a, b) => a.message_id - b.message_id))
  }
}
