import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TopicApi } from './topic-store'

/** The API server a topic's Claude must use right now, or undefined: the user's own Claude login and settings. */
export function activeApi(binding: { api?: TopicApi } | undefined): TopicApi | undefined {
  return binding?.api?.enabled ? binding.api : undefined
}

/** What makes two API choices different for a running process: it has to restart when this changes. */
export function apiSignature(api: TopicApi | undefined): string {
  return api ? `${api.baseUrl}\n${api.token}` : ''
}

/**
 * Writes the topic's settings file for `claude --settings`: it outranks both the router's environment and the
 * user's ~/.claude/settings.json (which may carry its own ANTHROPIC_BASE_URL). Kept in the router's data folder,
 * never in the project, so a repo can not commit the token. Rewritten at every start: it always matches the store.
 */
export function writeApiSettings(dataDir: string, topicKey: string, api: TopicApi): string {
  const dir = join(dataDir, 'topic-api')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${topicKey.replace(/[^\w-]/g, '_')}.json`)
  const settings = { env: { ANTHROPIC_BASE_URL: api.baseUrl, ANTHROPIC_AUTH_TOKEN: api.token } }
  writeFileSync(file, JSON.stringify(settings, null, 2), { mode: 0o600 })
  return file
}
