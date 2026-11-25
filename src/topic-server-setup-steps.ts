import { cancelApiSetup } from './topic-api-setup-steps'
import type { RunDeps, TopicContext } from './topic-run'
import { deleteSecret, isHost, isUser, NOT_DELETED, parsePort, saveServer, type ServerId, UNBOUND } from './topic-server-config'

/**
 * A press on a /server panel button (`server:a`, `server:b`) starts a step-by-step setup in that topic: the next
 * messages of the person who pressed it are its answers (host, port, user, password), never work for Claude.
 * Any command ends it. In memory only: a restart forgets it.
 */
const PREFIX = 'server:'
type Step = 'host' | 'port' | 'user' | 'password'
interface Setup {
  id: ServerId
  userId: number
  step: Step
  host: string
  port: number
  user: string
}
const setups = new Map<string, Setup>()

const ASK: Record<Step, string> = {
  host: 'Bước 1/4: gửi host (IP hoặc tên miền), ví dụ 1.2.3.4',
  port: 'Bước 2/4: gửi port SSH (thường là 22)',
  user: 'Bước 3/4: gửi tên đăng nhập, ví dụ root',
  password: 'Bước 4/4: gửi mật khẩu. Bot xoá tin đó ngay sau khi đọc.',
}
const INVALID: Record<Step, string> = {
  host: '⛔ Host chỉ gồm chữ, số, dấu chấm, gạch ngang và không bắt đầu bằng "-".',
  port: '⛔ Port là số từ 1 đến 65535.',
  user: '⛔ Tên đăng nhập chỉ gồm chữ, số, dấu chấm, gạch dưới, gạch ngang và không bắt đầu bằng "-".',
  password: '⛔ Mật khẩu không được trống và phải nằm trên một dòng.',
}

/** Synchronous, so a message that is not an answer reaches Claude in order. */
export function awaitsServerSetup(key: string, userId: number): boolean {
  return setups.get(key)?.userId === userId
}

export function cancelServerSetup(key: string): void {
  setups.delete(key)
}

/** A press on a /server panel button. False: not ours. */
export async function onServerButton(
  deps: RunDeps,
  panel: TopicContext,
  data: string,
  queryId: string,
  fromId: number,
): Promise<boolean> {
  if (!data.startsWith(PREFIX)) return false
  const refuse = (toast: string) => deps.api.answerCallback(queryId, toast).then(() => true, () => true)
  const id = data.slice(PREFIX.length)
  if (id !== 'a' && id !== 'b') return refuse('⛔ Nút không hợp lệ.')
  if (!deps.store.get(panel.key)) return refuse(UNBOUND)
  cancelApiSetup(panel.key) // one setup at a time per topic
  setups.set(panel.key, { id, userId: fromId, step: 'host', host: '', port: 22, user: '' })
  const text = `🖥️ Khai báo server ${id.toUpperCase()}. ${ASK.host}\n(Gõ lệnh bất kỳ, ví dụ /server, để huỷ.)`
  await Promise.all([
    deps.api.answerCallback(queryId).catch(() => {}),
    deps.api.sendText(panel.chatId, text, { threadId: panel.threadId }),
  ])
  return true
}

/** Takes the answer to the current step and asks the next one; the password saves the account. */
export async function answerServerSetup(deps: RunDeps, ctx: TopicContext, text: string): Promise<void> {
  const setup = setups.get(ctx.key)
  if (!setup) return
  const wasPassword = setup.step === 'password'
  const reply = advance(deps, ctx.key, setup, text) // the step is settled before the first await
  // A password leaves the chat whether or not it was accepted.
  const deleted = !wasPassword || (await deleteSecret(deps, ctx))
  await deps.api.sendText(ctx.chatId, deleted ? reply : reply + NOT_DELETED, { threadId: ctx.threadId })
}

function advance(deps: RunDeps, key: string, setup: Setup, text: string): string {
  const cwd = deps.store.get(key)?.cwd
  if (!cwd) {
    setups.delete(key)
    return UNBOUND
  }
  const retry = `${INVALID[setup.step]}\n${ASK[setup.step]}`
  if (setup.step === 'host') {
    if (!isHost(text)) return retry
    setup.host = text
    setup.step = 'port'
  } else if (setup.step === 'port') {
    const port = parsePort(text)
    if (port === undefined) return retry
    setup.port = port
    setup.step = 'user'
  } else if (setup.step === 'user') {
    if (!isUser(text)) return retry
    setup.user = text
    setup.step = 'password'
  } else {
    if (!text || /[\r\n]/.test(text)) return retry
    setups.delete(key)
    return saveServer(cwd, { id: setup.id, host: setup.host, port: setup.port, user: setup.user, password: text })
  }
  return ASK[setup.step]
}
