import { isApiBaseUrl, isApiToken } from './config'
import { apiPanel, BIND_FIRST, clearApi, saveApi, switchApi, testSaved } from './topic-api-choice'
import { errorText, type RunDeps, type TopicContext } from './topic-run'
import { deleteSecret, isHost, NOT_DELETED, parsePort } from './topic-server-config'
import { cancelServerSetup } from './topic-server-setup-steps'

/**
 * The /api panel's buttons: `api:toggle`, `api:test`, `api:clear`, and `api:edit`, which starts a step-by-step setup
 * in that topic. Its answers (host, port, token) are the next messages of the person who pressed it, never work for
 * Claude. Any command ends it. In memory only: a restart forgets it.
 */
const PREFIX = 'api:'
type Step = 'host' | 'port' | 'token'
interface Setup {
  userId: number
  step: Step
  scheme: 'http' | 'https'
  host: string
  port: number
}
const setups = new Map<string, Setup>()

const ASK: Record<Step, string> = {
  host: 'Bước 1/3: gửi IP hoặc tên miền của API, ví dụ 192.168.1.10 (thêm https:// phía trước nếu server dùng https)',
  port: 'Bước 2/3: gửi port, ví dụ 23334',
  token: 'Bước 3/3: gửi token (ANTHROPIC_AUTH_TOKEN). Bot xoá tin đó ngay sau khi đọc, rồi thử kết nối.',
}
const INVALID: Record<Step, string> = {
  host: '⛔ Host chỉ gồm chữ, số, dấu chấm, gạch ngang và không bắt đầu bằng "-".',
  port: '⛔ Port là số từ 1 đến 65535.',
  token: '⛔ Token chỉ gồm ký tự in được, không có dấu cách hay xuống dòng.',
}
const HOST_ANSWER = /^(?:(https?):\/\/)?([^/\s]+)\/?$/i

/** Synchronous, so a message that is not an answer reaches Claude in order. */
export function awaitsApiSetup(key: string, userId: number): boolean {
  return setups.get(key)?.userId === userId
}

export function cancelApiSetup(key: string): void {
  setups.delete(key)
}

/** A press on a /api panel button: redraws the panel in place, or starts the setup. False: not ours. */
export async function onApiButton(
  deps: RunDeps,
  panel: TopicContext & { messageId: number },
  data: string,
  queryId: string,
  fromId: number,
): Promise<boolean> {
  if (!data.startsWith(PREFIX)) return false
  const action = data.slice(PREFIX.length)
  if (action === 'edit') {
    if (!deps.store.get(panel.key)) {
      await deps.api.answerCallback(queryId, BIND_FIRST).catch(() => {})
      return true
    }
    cancelServerSetup(panel.key) // one setup at a time per topic
    setups.set(panel.key, { userId: fromId, step: 'host', scheme: 'http', host: '', port: 0 })
    const text = `🔌 Điền cấu hình API. ${ASK.host}\n(Gõ lệnh bất kỳ, ví dụ /api, để huỷ.)`
    await Promise.all([
      deps.api.answerCallback(queryId).catch(() => {}),
      deps.api.sendText(panel.chatId, text, { threadId: panel.threadId }),
    ])
    return true
  }
  if (action === 'test') {
    await testFromPanel(deps, panel, queryId)
    return true
  }
  const headline =
    action === 'toggle' ? toggle(deps, panel.key) : action === 'clear' ? clearApi(deps, panel.key) : '⛔ Nút không hợp lệ.'
  const redrawn = apiPanel(deps, panel.key, headline, false)
  // The redraw goes out first, in press order: a slow answer to an earlier press never paints over a later one.
  await Promise.all([
    deps.api.editText(panel.chatId, panel.messageId, redrawn.text, redrawn.buttons).catch(() => {}),
    deps.api.answerCallback(queryId, headline.slice(0, 200)).catch(() => {}), // Telegram's toast limit
  ])
  return true
}

/**
 * The test button: "checking" shows in the panel at once (the test may take seconds), then the result replaces it.
 * The result carries the time, so two presses never give Telegram the same text twice (it refuses that edit as
 * "not modified"). When the panel cannot be edited at all, the result goes to the topic as a new message: it is never lost.
 */
async function testFromPanel(deps: RunDeps, panel: TopicContext & { messageId: number }, queryId: string): Promise<void> {
  const edit = (reply: { text: string; buttons?: Parameters<RunDeps['api']['editText']>[3] }) =>
    deps.api.editText(panel.chatId, panel.messageId, reply.text, reply.buttons).then(
      () => true,
      err => {
        console.error(`Không sửa được bảng /api: ${errorText(err)}`)
        return false
      },
    )
  await deps.api.answerCallback(queryId, '🧪 Đang kiểm tra kết nối…').catch(() => {})
  const checking = edit(apiPanel(deps, panel.key, '⏳ Đang kiểm tra kết nối…', false))
  const result = await testSaved(deps, panel.key)
  await checking // in press order: the result never gets painted over by a late "checking"
  const done = apiPanel(deps, panel.key, `${result}\n🕐 ${new Date().toTimeString().slice(0, 8)}`, false)
  if (await edit(done)) return
  await deps.api.sendText(panel.chatId, done.text, { threadId: panel.threadId, buttons: done.buttons }).catch(err => {
    console.error(`Không gửi được kết quả test API: ${errorText(err)}`)
  })
}

function toggle(deps: RunDeps, key: string): string {
  return switchApi(deps, key, !deps.store.get(key)?.api?.enabled)
}

/** What a step answers; `saved`: the token was the last step and the API server is saved. */
interface Outcome {
  text: string
  saved?: boolean
}

/** Takes the answer to the current step and asks the next one; the token saves the server and tests it. */
export async function answerApiSetup(deps: RunDeps, ctx: TopicContext, text: string): Promise<void> {
  const setup = setups.get(ctx.key)
  if (!setup) return
  const wasToken = setup.step === 'token'
  let outcome: Outcome
  try {
    outcome = advance(deps, ctx.key, setup, text) // the step is settled (and saved) before the first await
  } catch (err) {
    setups.delete(ctx.key)
    outcome = { text: `⚠️ Lỗi: ${errorText(err)}` }
  }
  // A token leaves the chat whether or not it was accepted.
  const [deleted, tested] = await Promise.all([
    !wasToken || deleteSecret(deps, ctx),
    outcome.saved ? testSaved(deps, ctx.key) : undefined,
  ])
  const reply = outcome.saved ? apiPanel(deps, ctx.key, [outcome.text, tested].join('\n'), false) : { text: outcome.text, buttons: undefined }
  await deps.api.sendText(ctx.chatId, deleted ? reply.text : reply.text + NOT_DELETED, { threadId: ctx.threadId, buttons: reply.buttons })
}

function advance(deps: RunDeps, key: string, setup: Setup, text: string): Outcome {
  if (!deps.store.get(key)) {
    setups.delete(key)
    return { text: BIND_FIRST }
  }
  const retry = { text: `${INVALID[setup.step]}\n${ASK[setup.step]}` }
  if (setup.step === 'host') {
    const match = HOST_ANSWER.exec(text)
    if (!match || !isHost(match[2] ?? '')) return retry
    setup.scheme = match[1]?.toLowerCase() === 'https' ? 'https' : 'http'
    setup.host = match[2] ?? ''
    setup.step = 'port'
  } else if (setup.step === 'port') {
    const port = parsePort(text)
    if (port === undefined) return retry
    setup.port = port
    setup.step = 'token'
  } else {
    const baseUrl = `${setup.scheme}://${setup.host}:${setup.port}`
    if (!isApiToken(text) || !isApiBaseUrl(baseUrl)) return retry
    setups.delete(key)
    const saved = saveApi(deps, key, baseUrl, text)
    return { text: saved.text, saved: saved.ok }
  }
  return { text: ASK[setup.step] }
}
