export interface ParsedCommand {
  name: string
  args: string
}

const COMMAND = /^\/([A-Za-z0-9_][A-Za-z0-9_-]{0,31})(?:@([A-Za-z0-9_]{1,64}))?(?:\s+([\s\S]*))?$/

/**
 * Telegram's "/" menu only holds names of letters, digits and `_`, so these are typed with `_` there;
 * the hyphen spelling works too. Any other `/some-name` is not ours: it goes to Claude (a skill like /code-review).
 */
const HYPHEN_ALIASES: Record<string, string> = { 'enable-api': 'enable_api', 'disable-api': 'disable_api' }

/**
 * `/bind D:\x` or `/bind@this_bot D:\x`. Returns null when the text is not a command
 * (e.g. "/src/a.ts is broken") and 'other-bot' when it names another bot of the group.
 */
export function parseCommand(text: string, botUsername: string): ParsedCommand | 'other-bot' | null {
  const match = COMMAND.exec(text.trim())
  if (!match) return null
  const [, rawName, target, args] = match
  const lower = (rawName ?? '').toLowerCase()
  const name = lower.includes('-') ? HYPHEN_ALIASES[lower] : lower
  if (!name) return null
  if (target && target.toLowerCase() !== botUsername.toLowerCase()) return 'other-bot'
  return { name, args: (args ?? '').trim() }
}
