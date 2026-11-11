import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { claudeBinaryLocator } from './claude-binary-path'

/** Keys the router reads from .env. They are removed from the environment Claude runs with. */
export const ROUTER_ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'ALLOWED_USER_IDS',
  'ALLOWED_CHAT_IDS',
  'CLAUDE_BIN',
  'CLAUDE_MODEL',
  'MAX_PARALLEL_RUNS',
  'RUN_TIMEOUT_MINUTES',
  'STALE_MESSAGE_MINUTES',
  'CONTEXT_WARN_TOKENS',
  'SESSION_WARN_MESSAGES',
  'ROUTER_DATA_DIR',
] as const

export interface RouterConfig {
  botToken: string
  allowedUserIds: ReadonlySet<number>
  allowedChatIds: ReadonlySet<number>
  /** Executable (+ leading args, tests only) that behaves like `claude`. */
  claudeCommand: readonly string[]
  claudeModel?: string
  maxParallelRuns: number
  runTimeoutMs: number
  staleMessageMs: number
  /** Warn in the topic once its session's context reaches this many tokens (0 = never). */
  contextWarnTokens: number
  /** Warn once a session has answered this many messages (0 = never). */
  sessionWarnMessages: number
  dataDir: string
  /** Claude Code's own folder (~/.claude, or CLAUDE_CONFIG_DIR): where /skills finds the skills it offers. */
  claudeDir: string
}

type Env = Record<string, string | undefined>

export function parseIdList(raw: string | undefined): Set<number> {
  const ids = new Set<number>()
  for (const part of (raw ?? '').split(/[\s,;]+/)) {
    if (!part) continue
    if (!/^-?\d{1,16}$/.test(part)) throw new Error(`ID không hợp lệ: "${part}"`)
    ids.add(Number(part))
  }
  return ids
}

function boundedInt(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} phải là số nguyên từ ${min} đến ${max}`)
  }
  return value
}

/**
 * Set for every Claude the router starts. Claude starts the MCP servers of the user's plugins,
 * including the Telegram channel plugin, which would read its own token from
 * ~/.claude/channels/telegram and poll that bot. Pointed at this empty folder it finds no token and exits.
 */
export function pluginOffEnv(dataDir: string): Record<string, string> {
  return { TELEGRAM_STATE_DIR: join(dataDir, 'telegram-plugin-off') }
}

/** A model alias (`opus`) or full name (`claude-opus-5-5`, `…[1m]`): safe to pass to `--model`. */
export function isModelName(value: unknown): value is string {
  return typeof value === 'string' && /^[\w.\-[\]]{1,64}$/.test(value)
}

export function loadConfig(env: Env = process.env): RouterConfig {
  const botToken = (env.TELEGRAM_BOT_TOKEN ?? '').trim()
  if (!/^\d{5,}:[\w-]{30,}$/.test(botToken)) {
    throw new Error('TELEGRAM_BOT_TOKEN trong .env đang trống hoặc sai dạng (lấy từ @BotFather).')
  }
  const allowedUserIds = parseIdList(env.ALLOWED_USER_IDS)
  if (allowedUserIds.size === 0) {
    throw new Error(
      'ALLOWED_USER_IDS trong .env đang trống. Điền ID Telegram của bạn: bot chạy Claude với toàn quyền, không để ai khác ra lệnh.',
    )
  }
  const claudeModel = env.CLAUDE_MODEL?.trim() || undefined
  if (claudeModel && !isModelName(claudeModel)) throw new Error('CLAUDE_MODEL không hợp lệ')
  const claudeBinary = claudeBinaryLocator(env.CLAUDE_BIN?.trim() || undefined)
  return {
    botToken,
    allowedUserIds,
    allowedChatIds: parseIdList(env.ALLOWED_CHAT_IDS),
    // Read at each spawn: a Claude Code update can move claude.exe while the router runs.
    get claudeCommand() {
      return [claudeBinary()]
    },
    claudeModel,
    maxParallelRuns: boundedInt(env, 'MAX_PARALLEL_RUNS', 3, 1, 10),
    runTimeoutMs: boundedInt(env, 'RUN_TIMEOUT_MINUTES', 60, 1, 24 * 60) * 60_000,
    staleMessageMs: boundedInt(env, 'STALE_MESSAGE_MINUTES', 10, 1, 7 * 24 * 60) * 60_000,
    contextWarnTokens: boundedInt(env, 'CONTEXT_WARN_TOKENS', 200_000, 0, 10_000_000),
    sessionWarnMessages: boundedInt(env, 'SESSION_WARN_MESSAGES', 20, 0, 10_000),
    dataDir: resolve(env.ROUTER_DATA_DIR?.trim() || join(import.meta.dir, '..', 'data')),
    claudeDir: resolve(env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')),
  }
}
