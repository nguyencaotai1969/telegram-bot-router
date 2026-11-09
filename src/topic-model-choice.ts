import { type ClaudeModel, claudeModels, knownModels } from './claude-model-list'
import { isModelName } from './config'
import type { InlineButton } from './telegram-api'
import { errorText, type RunDeps, type TopicContext } from './topic-run'

const DEFAULT = 'default'
const BUTTON_PREFIX = 'model:'
const PER_ROW = 2
/** When Claude Code cannot list its models: its aliases for the latest of each family. */
const FALLBACK: ClaudeModel[] = [DEFAULT, 'fable', 'opus', 'sonnet', 'haiku'].map(value => ({
  value,
  displayName: value === DEFAULT ? 'Default' : value[0]?.toUpperCase() + value.slice(1),
  description: '',
}))

/** A command's answer, possibly with inline buttons under it. */
export interface Reply {
  text: string
  buttons?: InlineButton[][]
}

/** What the panel offers: Claude Code's own list (`known`), else the aliases. */
interface Offer {
  models: ClaudeModel[]
  known: boolean
}

/**
 * `/model`: the topic's model with a button per model Claude Code offers. `/model <name>`: sets it,
 * before anything is awaited, so a message right behind it already runs on the new model.
 */
export async function modelCommand(deps: RunDeps, ctx: TopicContext, args: string): Promise<Reply> {
  if (!deps.store.get(ctx.key)) return { text: 'Topic này chưa gắn dự án. Gõ /bind trước.' }
  const result = args ? chooseModel(deps, ctx.key, args, offerNow(deps)) : undefined
  if (!result) await claudeModels(deps.config) // a bare /model may wait briefly, so its panel lists every model
  return modelPanel(deps, ctx.key, offerNow(deps), result)
}

/** A press on a /model panel button: sets the model and redraws the panel in place. False: not ours. */
export async function onModelButton(
  deps: RunDeps,
  panel: TopicContext & { messageId: number },
  data: string,
  queryId: string,
): Promise<boolean> {
  if (!data.startsWith(BUTTON_PREFIX)) return false
  const offer = offerNow(deps)
  const result = chooseModel(deps, panel.key, data.slice(BUTTON_PREFIX.length), offer)
  const redrawn = modelPanel(deps, panel.key, offer, result)
  // The redraw goes out first, in press order: a slow answer to an earlier press never paints over a later one.
  await Promise.all([
    deps.api.editText(panel.chatId, panel.messageId, redrawn.text, redrawn.buttons).catch(() => {}),
    deps.api.answerCallback(queryId, result.slice(0, 200)).catch(() => {}), // Telegram's toast limit
  ])
  return true
}

/** "🤖 Model: Opus 4.8 · đang chạy: claude-opus-4-8", for /model and /status. Never waits. */
export function modelLine(deps: RunDeps, key: string): string {
  return describeModel(deps, key, offerNow(deps).models)
}

/** Claude Code's list as known right now, else the aliases; always with a default entry. */
function offerNow(deps: RunDeps): Offer {
  const listed = knownModels(deps.config)
  const models = listed ?? FALLBACK
  const withDefault = models.some(m => m.value === DEFAULT) ? models : [FALLBACK[0] as ClaudeModel, ...models]
  return { models: withDefault, known: listed !== undefined }
}

function describeModel(deps: RunDeps, key: string, models: ClaudeModel[]): string {
  const chosen = deps.store.get(key)?.model
  const running = deps.conversations.runningModel(key)
  return `🤖 Model: ${chosen ? nameOf(chosen, models) : `mặc định (${defaultName(deps, models)})`}${running ? ` · đang chạy: ${running}` : ''}`
}

function nameOf(value: string, models: ClaudeModel[]): string {
  return models.find(m => m.value === value)?.displayName ?? value
}

/** What "default" means for this router: CLAUDE_MODEL, else Claude Code's own default (e.g. "Sonnet 5.5"). */
function defaultName(deps: RunDeps, models: ClaudeModel[]): string {
  if (deps.config.claudeModel) return `${nameOf(deps.config.claudeModel, models)}, theo CLAUDE_MODEL`
  return models.find(m => m.value === DEFAULT)?.description.split(' · ')[0] || 'của Claude Code'
}

function chooseModel(deps: RunDeps, key: string, name: string, offer: Offer): string {
  const value = name.trim().toLowerCase()
  const listed = offer.models.find(m => m.value.toLowerCase() === value)
  const model = value === DEFAULT ? undefined : (listed?.value ?? value) // the list's own spelling
  if (model !== undefined && !isModelName(model)) return '⛔ Tên model không hợp lệ.'
  if (model !== undefined && offer.known && !listed) {
    return `⛔ Claude Code không có model "${model.slice(0, 64)}". Chọn trong bảng /model.`
  }
  try {
    if (!deps.store.setModel(key, model)) return 'Topic này chưa gắn dự án. Gõ /bind trước.'
  } catch (err) {
    return `⚠️ Không lưu được: ${errorText(err)}`
  }
  const when = deps.conversations.busy(deps.scheduler, key)
    ? '⏳ Áp dụng khi Claude xong việc đang làm.'
    : 'Tin sau dùng model này, vẫn nhớ ngữ cảnh.'
  return `✅ Đã chọn ${model ? nameOf(model, offer.models) : 'mặc định'}. ${when}`
}

function modelPanel(deps: RunDeps, key: string, offer: Offer, headline?: string): Reply {
  const chosen = deps.store.get(key)?.model ?? DEFAULT
  const label = (m: ClaudeModel) => (m.value === DEFAULT ? `Mặc định · ${defaultName(deps, offer.models)}` : m.displayName)
  const buttons = offer.models.map(m => ({ text: `${m.value === chosen ? '✓ ' : ''}${label(m)}`, data: `${BUTTON_PREFIX}${m.value}` }))
  const rows: InlineButton[][] = []
  for (let i = 0; i < buttons.length; i += PER_ROW) rows.push(buttons.slice(i, i + PER_ROW))
  return { text: [...(headline ? [headline] : []), describeModel(deps, key, offer.models)].join('\n'), buttons: rows }
}
