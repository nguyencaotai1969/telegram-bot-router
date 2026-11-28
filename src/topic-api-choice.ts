import { isApiBaseUrl, isApiToken } from './config'
import type { Reply } from './topic-model-choice'
import { deleteSecret, NOT_DELETED } from './topic-server-config'
import { errorText, type RunDeps, type TopicContext } from './topic-run'
import { hasOwnApi, projectEnv } from './topic-api-settings'
import { testApiConnection } from './topic-api-test'
import type { TopicApi } from './topic-store'

export const BIND_FIRST = 'Topic này chưa gắn dự án. Gõ /bind trước.'
const USAGE =
  'Bấm nút để điền từng bước. Hoặc gõ một dòng: /api http://192.168.1.10:23334 TOKEN (tin có token được bot xoá ngay). /api test kiểm tra kết nối; /api on | off | clear. Bật / tắt nhanh: /enable_api, /disable_api.'

/**
 * `/api`: the topic's API server (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN) with buttons to turn it on or off,
 * test it, edit or delete it. `/api <url> <token>` saves one in one line (and deletes the message that holds the
 * token); `/api on|off|clear|test`. While on, the topic's Claude talks to that server instead of the machine's login.
 */
export async function apiCommand(deps: RunDeps, ctx: TopicContext, args: string): Promise<string | Reply> {
  const word = args.toLowerCase()
  if (!args) return deps.store.get(ctx.key) ? apiPanel(deps, ctx.key, USAGE) : BIND_FIRST
  if (word === 'on' || word === 'off') return enableApiCommand(deps, ctx, word === 'on')
  if (word === 'clear') return apiPanel(deps, ctx.key, clearApi(deps, ctx.key))
  if (word === 'test') return apiPanel(deps, ctx.key, await testSaved(deps, ctx.key), false)
  // Saved before the first await: a message sent right after it already runs on the new API.
  const saved = saveFromLine(deps, ctx.key, args)
  // The message may hold a token: it leaves the chat whether or not it was saved.
  const [deleted, tested] = await Promise.all([deleteSecret(deps, ctx), saved.ok ? testSaved(deps, ctx.key) : undefined])
  const reply = apiPanel(deps, ctx.key, [saved.text, tested].filter(Boolean).join('\n'), false)
  return deleted ? reply : { ...reply, text: reply.text + NOT_DELETED }
}

/** `/enable-api` and `/disable-api` (and `/api on|off`): the switch, then a connection test when turning on. */
export async function enableApiCommand(deps: RunDeps, ctx: TopicContext, enabled: boolean): Promise<Reply | string> {
  if (!deps.store.get(ctx.key)) return BIND_FIRST
  const switched = switchApi(deps, ctx.key, enabled) // before the first await
  const tested = enabled && deps.store.get(ctx.key)?.api?.enabled ? await testSaved(deps, ctx.key) : undefined
  return apiPanel(deps, ctx.key, [switched, tested].filter(Boolean).join('\n'), false)
}

/** The /api panel: the topic's API server, and the buttons that fit its state. */
export function apiPanel(deps: RunDeps, key: string, headline?: string, withUsage = true): Reply {
  const api = deps.store.get(key)?.api
  const buttons = api
    ? [
        [{ text: api.enabled ? '🔴 Tắt API' : '🟢 Bật API', data: 'api:toggle' }, { text: '🧪 Test kết nối', data: 'api:test' }],
        [{ text: '✏️ Sửa', data: 'api:edit' }, { text: '🗑️ Xoá', data: 'api:clear' }],
      ]
    : [
        [{ text: '✏️ Điền cấu hình', data: 'api:edit' }],
        ...(projectApiInUse(deps, key) ? [[{ text: '🔴 Tắt API của dự án', data: 'api:off' }]] : []),
      ]
  const lines = [...(headline ? [headline] : []), apiLine(deps, key), ...(withUsage && !headline ? [USAGE] : [])]
  return { text: lines.join('\n'), buttons }
}

/** "🔌 API: BẬT → http://… · token …wxyz", for /api and /status. Never the whole token. */
export function apiLine(deps: RunDeps, key: string): string {
  const binding = deps.store.get(key)
  if (binding?.apiOff) return '🔌 API: TẮT, Claude dùng đăng nhập của máy (/api clear: trả về cấu hình của dự án)'
  const api = binding?.api
  if (!api) {
    const own = projectApiInUse(deps, key)
    return own
      ? `🔌 API: chưa cấu hình\n⚠️ Dự án tự khai API trong .claude/settings*.json${own.origin}, Claude đang dùng API đó. Gõ /disable_api để dùng đăng nhập của máy.`
      : '🔌 API: chưa cấu hình (Claude theo cấu hình sẵn có của máy và dự án)'
  }
  if (!api.enabled) return `🔌 API: TẮT (đã lưu ${api.baseUrl})`
  return `🔌 API: BẬT → ${api.baseUrl} · token ${maskToken(api.token)}`
}

/** The project's own API while nothing in /api overrides it. `origin`: " (https://host:port)", never the URL's login, path or query. */
function projectApiInUse(deps: RunDeps, key: string): { origin: string } | undefined {
  const binding = deps.store.get(key)
  if (!binding || binding.api || binding.apiOff) return undefined
  const env = projectEnv(binding.cwd)
  if (!hasOwnApi(env)) return undefined
  const url = env.ANTHROPIC_BASE_URL ?? ''
  const origin = URL.canParse(url) ? new URL(url).origin : 'null'
  return { origin: origin === 'null' ? '' : ` (${origin})` }
}

function maskToken(token: string): string {
  return token.length >= 12 ? `…${token.slice(-4)}` : '✓'
}

/** Tests the topic's saved API server (on or off); the answer says what came back. */
export function testSaved(deps: RunDeps, key: string): Promise<string> | string {
  const api = deps.store.get(key)?.api
  if (!api) return deps.store.get(key) ? '⛔ Chưa có cấu hình API để test. Bấm "Điền cấu hình".' : BIND_FIRST
  return testApiConnection(api.baseUrl, api.token, deps.config.apiTestTimeoutMs).then(result => `🧪 ${api.baseUrl}\n${result}`)
}

/** Turns the saved API server on or off; off works with nothing saved too. The answer says what happened. */
export function switchApi(deps: RunDeps, key: string, enabled: boolean): string {
  const binding = deps.store.get(key)
  if (!binding) return BIND_FIRST
  const { api } = binding
  if (enabled && !api) return '⛔ Chưa có cấu hình API. Gõ /api để điền.'
  const done = enabled ? '✅ Đã bật API.' : '✅ Đã tắt API, Claude dùng lại đăng nhập của máy.'
  return apply(deps, key, api ? { ...api, enabled } : 'off', done)
}

export function clearApi(deps: RunDeps, key: string): string {
  return apply(deps, key, undefined, '✅ Đã xoá cấu hình API.')
}

/** Saves a complete API server for the topic and turns it on. `ok`: it was saved. */
export function saveApi(deps: RunDeps, key: string, baseUrl: string, token: string): { ok: boolean; text: string } {
  const text = apply(deps, key, { enabled: true, baseUrl, token }, `✅ Đã lưu và bật API ${baseUrl}.`)
  return { ok: deps.store.get(key)?.api?.token === token && text.startsWith('✅'), text }
}

function saveFromLine(deps: RunDeps, key: string, args: string): { ok: boolean; text: string } {
  const match = /^(\S+)\s+(\S+)$/.exec(args)
  if (!match || !isApiBaseUrl(match[1])) return { ok: false, text: `⛔ Sai dạng. ${USAGE}` }
  if (!isApiToken(match[2])) return { ok: false, text: '⛔ Token chỉ gồm ký tự in được, không có dấu cách.' }
  return saveApi(deps, key, match[1], match[2])
}

function apply(deps: RunDeps, key: string, api: TopicApi | 'off' | undefined, done: string): string {
  try {
    if (!deps.store.setApi(key, api)) return BIND_FIRST
  } catch (err) {
    return `⚠️ Không lưu được: ${errorText(err)}`
  }
  const when = deps.conversations.busy(deps.scheduler, key)
    ? '⏳ Áp dụng khi Claude xong việc đang làm.'
    : 'Tin sau chạy theo cấu hình này (Claude khởi động lại, vẫn nhớ ngữ cảnh).'
  return `${done} ${when}`
}
