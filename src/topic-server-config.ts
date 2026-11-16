import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Reply } from './topic-model-choice'
import { errorText, type RunDeps, type TopicContext } from './topic-run'

/** The accounts of the topic's servers. `.env.*`: the bot never uploads it, and a project's own `.env` stays untouched. */
export const SERVERS_ENV = '.env.servers'
/** Copied into the topic's folder once, never overwritten: how Claude reaches the servers (ssh-to.sh) and its rules. */
const TEMPLATE_DIR = join(import.meta.dir, '..', 'templates', 'server-topic')
const TEMPLATE_FILES = ['CLAUDE.md', 'ssh-to.sh']
const SERVERS = { a: 'SERVER_A', b: 'SERVER_B' } as const
export type ServerId = keyof typeof SERVERS
export const UNBOUND = 'Topic này chưa gắn thư mục. Gõ /bind <thư mục> trước (thư mục trống cũng được).'
export const NOT_DELETED = '\n\n⚠️ Bot không xoá được tin có mật khẩu (cần quyền admin "Xoá tin"): hãy tự xoá tin đó.'
const USAGE = 'Bấm nút để khai báo từng bước. Hoặc gõ một dòng: /server a root@1.2.3.4:22 mật-khẩu. Tin có mật khẩu được bot xoá ngay.'
/** The /server panel: each button starts the step-by-step setup of that server (topic-server-setup-steps). */
const SETUP_BUTTONS = [[{ text: '⚙️ Server A', data: 'server:a' }, { text: '⚙️ Server B', data: 'server:b' }]]
// No leading '-' in user or host: ssh can never read `user@host` as an option.
const USER = '[A-Za-z0-9._][A-Za-z0-9._-]{0,63}'
const HOST = '[A-Za-z0-9.][A-Za-z0-9.-]{0,252}'
const TARGET = new RegExp(`^(${USER})@(${HOST})(?::(\\d{1,5}))?$`)
export const isUser = (text: string) => new RegExp(`^${USER}$`).test(text)
export const isHost = (text: string) => new RegExp(`^${HOST}$`).test(text)

export function parsePort(text: string): number | undefined {
  const port = /^\d{1,5}$/.test(text) ? Number(text) : 0
  return port >= 1 && port <= 65535 ? port : undefined
}

export interface ServerAccount {
  id: ServerId
  user: string
  host: string
  port: number
  password: string
}

/** `a root@1.2.3.4:22 the password` (the password is the rest of the line), or why not. */
export function parseServerArgs(args: string): ServerAccount | string {
  const match = /^(\S+)\s+(\S+)\s+(.+)$/s.exec(args)
  const id = match?.[1]?.toLowerCase()
  if (!match || (id !== 'a' && id !== 'b')) return `⛔ ${USAGE}`
  const target = TARGET.exec(match[2] ?? '')
  if (!target) return '⛔ Sai dạng user@host:port, ví dụ root@1.2.3.4:22 (port không ghi thì là 22).'
  const port = parsePort(target[3] ?? '22')
  if (port === undefined) return '⛔ Port phải từ 1 đến 65535.'
  const password = match[3] ?? ''
  if (/[\r\n]/.test(password)) return '⛔ Mật khẩu phải nằm trên một dòng.'
  return { id, user: target[1] ?? '', host: target[2] ?? '', port, password }
}

/** First `KEY=` line wins, read raw: the same rule as ssh-to.sh. */
export function envValue(text: string, key: string): string | undefined {
  return text.split(/\r?\n/).find(line => line.startsWith(`${key}=`))?.slice(key.length + 1)
}

/** `text` with each key set: every line of it rewritten in place, missing keys appended, other lines kept. */
export function setEnvValues(text: string, values: Record<string, string>): string {
  const missing = new Set(Object.keys(values))
  const lines = text.split(/\r?\n/).filter((line, i, all) => line || i < all.length - 1)
  const kept = lines.map(line => {
    const key = line.slice(0, line.indexOf('='))
    if (!line.includes('=') || !Object.hasOwn(values, key)) return line
    missing.delete(key)
    return `${key}=${values[key]}`
  })
  return [...kept, ...[...missing].map(key => `${key}=${values[key]}`)].join('\n') + '\n'
}

/**
 * `/server`: the topic's servers and a setup button for each; `/server a|b user@host[:port] password` saves one in
 * one line, then deletes the message. Saved before the first await: a message sent right after it cannot reach
 * Claude before the account is on disk.
 */
export async function serverCommand(deps: RunDeps, ctx: TopicContext, args: string): Promise<string | Reply> {
  const cwd = deps.store.get(ctx.key)?.cwd
  if (!args) return cwd ? { text: `${serversText(cwd)}\n\n${USAGE}`, buttons: SETUP_BUTTONS } : UNBOUND
  const account = parseServerArgs(args)
  const answer = !cwd ? UNBOUND : typeof account === 'string' ? account : saveServer(cwd, account)
  // The message may hold a password: it leaves the chat whether or not it was saved.
  return (await deleteSecret(deps, ctx)) ? answer : answer + NOT_DELETED
}

/** Deletes the message that holds a password; false when the bot could not. */
export function deleteSecret(deps: RunDeps, ctx: TopicContext): Promise<boolean> {
  if (ctx.messageId === undefined) return Promise.resolve(true)
  return deps.api.deleteMessage(ctx.chatId, ctx.messageId).then(() => true, () => false)
}

/** Writes the account to the folder's .env.servers (plus the template files); the answer for the topic. */
export function saveServer(cwd: string, account: ServerAccount): string {
  // A repo would commit the passwords (a `.env` ignore rule misses `.env.servers`) and get a CLAUDE.md that is not its own.
  if (insideGitRepo(cwd)) return '⛔ Thư mục này nằm trong repo git: mật khẩu có thể bị commit. Dùng /server trong topic gắn với thư mục riêng (thư mục trống).'
  const prefix = SERVERS[account.id]
  const file = join(cwd, SERVERS_ENV)
  try {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const values = { HOST: account.host, PORT: String(account.port), USER: account.user, PASSWORD: account.password }
    const entries = Object.entries(values).map(([name, value]) => [`${prefix}_${name}`, value])
    writeFileSync(file, setEnvValues(current, Object.fromEntries(entries)), { mode: 0o600 })
  } catch (err) {
    return `⚠️ Không lưu được server: ${errorText(err)}`
  }
  const saved = `✅ Đã lưu server ${account.id.toUpperCase()}: ${account.user}@${account.host}:${account.port}`
  return [saved, ...installTemplate(cwd), '', serversText(cwd)].join('\n')
}

function insideGitRepo(dir: string): boolean {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return true
    if (dirname(current) === current) return false
  }
}

function serversText(cwd: string): string {
  const file = join(cwd, SERVERS_ENV)
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const lines = (Object.keys(SERVERS) as ServerId[]).map(id => {
    const get = (name: string) => envValue(text, `${SERVERS[id]}_${name}`)
    const [host, user] = [get('HOST'), get('USER')]
    if (!host || !user) return `${id.toUpperCase()}: chưa có`
    return `${id.toUpperCase()}: ${user}@${host}:${get('PORT') || 22} · mật khẩu ${get('PASSWORD') ? '✓' : 'chưa có'}`
  })
  return [`🖥️ Server của topic (${file}):`, ...lines].join('\n')
}

/** Copies the missing template files; says what it did, or why Claude may not know about ssh-to.sh. */
function installTemplate(cwd: string): string[] {
  try {
    const added = TEMPLATE_FILES.filter(name => !existsSync(join(cwd, name)))
    for (const name of added) copyFileSync(join(TEMPLATE_DIR, name), join(cwd, name))
    chmodSync(join(cwd, 'ssh-to.sh'), 0o755) // ssh runs it as SSH_ASKPASS; a git checkout on Windows may drop the bit
    const notes = added.length ? [`📄 Đã thêm ${added.join(', ')} vào thư mục.`] : []
    if (!added.includes('CLAUDE.md') && !readFileSync(join(cwd, 'CLAUDE.md'), 'utf8').includes('ssh-to.sh')) {
      notes.push('ℹ️ Thư mục đã có CLAUDE.md riêng nên bot không ghi đè: dặn Claude vào server bằng ./ssh-to.sh a|b \'lệnh\'.')
    }
    return notes
  } catch (err) {
    return [`⚠️ Không chép được tệp mẫu (ssh-to.sh, CLAUDE.md): ${errorText(err)}`]
  }
}
