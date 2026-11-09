export interface ParsedCommand {
  name: string
  args: string
}

const COMMAND = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,64}))?(?:\s+([\s\S]*))?$/

/**
 * `/bind D:\x` or `/bind@this_bot D:\x`. Returns null when the text is not a command
 * (e.g. "/src/a.ts is broken") and 'other-bot' when it names another bot of the group.
 */
export function parseCommand(text: string, botUsername: string): ParsedCommand | 'other-bot' | null {
  const match = COMMAND.exec(text.trim())
  if (!match) return null
  const [, name, target, args] = match
  if (target && target.toLowerCase() !== botUsername.toLowerCase()) return 'other-bot'
  return { name: (name ?? '').toLowerCase(), args: (args ?? '').trim() }
}
