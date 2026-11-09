import { renameSync } from 'node:fs'
import { loadConfig } from '../../src/config'

/**
 * Started with the PATH under test, as the router is: prints, on its last line, the claude
 * command the router would spawn at startup and after each rename of PROBE_RENAMES
 * (a JSON list of [from, to]), the way a Claude Code update moves files while the router runs.
 */
const env = {
  TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz0123456789',
  ALLOWED_USER_IDS: '1',
  CLAUDE_BIN: process.env.PROBE_CLAUDE_BIN,
}
try {
  const config = loadConfig(env)
  const seen = [config.claudeCommand[0]]
  const renames = JSON.parse(process.env.PROBE_RENAMES ?? '[]') as [string, string][]
  for (const [from, to] of renames) {
    renameSync(from, to)
    seen.push(config.claudeCommand[0])
  }
  console.log(JSON.stringify({ seen }))
} catch (err) {
  console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
}
