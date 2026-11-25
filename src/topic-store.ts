import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isApiBaseUrl, isApiToken, isModelName } from './config'
import { isSessionId } from './session-id'

/** An API server for the topic's Claude (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN), used only while `enabled`. */
export interface TopicApi {
  enabled: boolean
  baseUrl: string
  token: string
}

export interface TopicBinding {
  /** Project folder Claude works in for this topic. */
  cwd: string
  /** Topic title, when Telegram told us (display only). */
  name?: string
  /** Claude session this topic continues; absent = the next message starts a new one. */
  sessionId?: string
  /** Model chosen for this topic (/model); absent = the router's default. Kept across /new and /bind. */
  model?: string
  /** API server chosen for this topic (/api); absent = the user's own Claude login and settings. Kept across /new, dropped by /bind to another folder. */
  api?: TopicApi
  /** How big that session has grown; goes with the session. */
  usage?: SessionUsage
  boundAt: number
}

export interface SessionUsage {
  /** Telegram requests answered in this session. */
  messages: number
  /** Context size after the last one. */
  contextTokens: number
  contextWindow?: number
  /** The "session is heavy" message went out: once per session. */
  warned?: boolean
}

interface StoreData {
  /** Highest Telegram update already taken: never handled twice, even after a crash. */
  lastUpdateId: number
  topics: Record<string, TopicBinding>
}

const TOPIC_KEY = /^-?\d+:(\d+|general)$/

export function topicKey(chatId: number, threadId?: number): string {
  return `${chatId}:${threadId ?? 'general'}`
}

/** Topic -> project bindings, saved to one JSON file on every change. */
export class TopicStore {
  private data: StoreData

  constructor(private readonly file: string) {
    this.data = this.load()
  }

  get lastUpdateId(): number {
    return this.data.lastUpdateId
  }

  /** Throws (and keeps the old value) when the file cannot be written: the batch is then polled again. */
  setLastUpdateId(id: number): void {
    const previous = this.data.lastUpdateId
    if (id <= previous) return
    this.data.lastUpdateId = id
    try {
      this.save()
    } catch (err) {
      this.data.lastUpdateId = previous
      throw err
    }
  }

  get(key: string): TopicBinding | undefined {
    const binding = Object.hasOwn(this.data.topics, key) ? this.data.topics[key] : undefined
    if (!binding) return undefined
    return { ...binding, ...(binding.usage ? { usage: { ...binding.usage } } : {}), ...(binding.api ? { api: { ...binding.api } } : {}) }
  }

  bind(key: string, cwd: string, name?: string): void {
    const before = this.get(key)
    const api = before?.cwd === cwd ? before.api : undefined // an API server belongs to its project
    const model = before?.model
    this.data.topics[key] = { cwd, boundAt: Date.now(), ...(name ? { name } : {}), ...(model ? { model } : {}), ...(api ? { api } : {}) }
    this.save()
  }

  /** Sets (or, with undefined, clears) the topic's model. False when the topic is not bound. */
  setModel(key: string, model: string | undefined): boolean {
    return this.edit(key, binding => (model === undefined ? delete binding.model : (binding.model = model)))
  }

  /** Sets (or, with undefined, clears) the topic's API server. False when the topic is not bound. */
  setApi(key: string, api: TopicApi | undefined): boolean {
    return this.edit(key, binding => (api === undefined ? delete binding.api : (binding.api = { ...api })))
  }

  /** Applies `change` to the topic's binding and saves. Not saved, not applied: what the user is told stays true. */
  private edit(key: string, change: (binding: TopicBinding) => unknown): boolean {
    const binding = Object.hasOwn(this.data.topics, key) ? this.data.topics[key] : undefined
    if (!binding) return false
    const before = structuredClone(binding)
    change(binding)
    try {
      this.save()
    } catch (err) {
      this.data.topics[key] = before
      throw err
    }
    return true
  }

  unbind(key: string): boolean {
    if (!Object.hasOwn(this.data.topics, key)) return false
    delete this.data.topics[key]
    this.save()
    return true
  }

  setName(key: string, name: string): void {
    const binding = this.data.topics[key]
    if (!binding || binding.name === name) return
    binding.name = name.slice(0, 128)
    this.save()
  }

  /** Changes the session only while the topic still points at `expectedCwd` (a /bind meanwhile wins). */
  setSession(key: string, sessionId: string | undefined, expectedCwd?: string): void {
    const binding = Object.hasOwn(this.data.topics, key) ? this.data.topics[key] : undefined
    if (!binding || (expectedCwd !== undefined && binding.cwd !== expectedCwd)) return
    if (binding.sessionId === sessionId) return
    if (sessionId === undefined) delete binding.sessionId
    else if (isSessionId(sessionId)) binding.sessionId = sessionId
    else return
    delete binding.usage
    this.save()
  }

  /**
   * Replaces the usage of the topic's session `sessionId` with `update(current)`; nothing when
   * the topic has moved on to another folder or session. Returns the new usage.
   */
  updateUsage(
    key: string,
    sessionId: string,
    update: (current: SessionUsage | undefined) => SessionUsage,
  ): SessionUsage | undefined {
    const binding = Object.hasOwn(this.data.topics, key) ? this.data.topics[key] : undefined
    if (!binding || binding.sessionId !== sessionId) return undefined
    binding.usage = update(binding.usage && { ...binding.usage })
    this.save()
    return { ...binding.usage }
  }

  /** Topics bound to this folder (case-insensitive on Windows). */
  keysForCwd(cwd: string): string[] {
    const fold = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path)
    return Object.entries(this.data.topics)
      .filter(([, binding]) => fold(binding.cwd) === fold(cwd))
      .map(([key]) => key)
  }

  listChat(chatId: number): Array<[string, TopicBinding]> {
    const prefix = `${chatId}:`
    return Object.entries(this.data.topics).filter(([key]) => key.startsWith(prefix))
  }

  private load(): StoreData {
    const empty: StoreData = { lastUpdateId: 0, topics: {} }
    if (!existsSync(this.file)) return empty
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoreData>
      const topics: Record<string, TopicBinding> = {}
      for (const [key, value] of Object.entries(raw.topics ?? {})) {
        if (!TOPIC_KEY.test(key) || typeof value?.cwd !== 'string') continue
        topics[key] = {
          cwd: value.cwd,
          boundAt: Number(value.boundAt) || 0,
          ...(typeof value.name === 'string' ? { name: value.name.slice(0, 128) } : {}),
          ...(isSessionId(value.sessionId) ? { sessionId: value.sessionId, ...loadUsage(value.usage) } : {}),
          ...(isModelName(value.model) ? { model: value.model } : {}),
          ...loadApi(value.api),
        }
      }
      const lastUpdateId = Number.isSafeInteger(raw.lastUpdateId) ? (raw.lastUpdateId as number) : 0
      return { lastUpdateId, topics }
    } catch (err) {
      const backup = `${this.file}.bad-${Date.now()}`
      renameSync(this.file, backup)
      console.error(`state.json hỏng, đã đổi tên thành ${backup}: ${err}`)
      return empty
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const json = JSON.stringify(this.data, null, 2)
    const tmp = `${this.file}.tmp`
    try {
      writeFileSync(tmp, json)
      renameSync(tmp, this.file)
    } catch {
      // Windows refuses the rename while another program (antivirus, indexer) holds the file.
      writeFileSync(this.file, json)
    }
  }
}

function loadApi(raw: unknown): { api?: TopicApi } {
  const value = (raw ?? {}) as Partial<TopicApi>
  if (!isApiBaseUrl(value.baseUrl) || !isApiToken(value.token)) return {}
  return { api: { enabled: value.enabled === true, baseUrl: value.baseUrl, token: value.token } }
}

function loadUsage(raw: unknown): { usage?: SessionUsage } {
  const value = (raw ?? {}) as Partial<SessionUsage>
  const count = (n: unknown) => (Number.isSafeInteger(n) && (n as number) >= 0 ? (n as number) : undefined)
  const messages = count(value.messages)
  const contextTokens = count(value.contextTokens)
  if (messages === undefined || contextTokens === undefined) return {}
  const contextWindow = count(value.contextWindow)
  const warned = value.warned === true
  return { usage: { messages, contextTokens, ...(contextWindow ? { contextWindow } : {}), ...(warned ? { warned } : {}) } }
}
