import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TopicBinding } from './topic-store'

const API_VARS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const
/** Model names, which may mean something only to the server they are set beside. */
const MODEL_VARS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
] as const
type ProjectVar = (typeof API_VARS)[number] | (typeof MODEL_VARS)[number]

/**
 * The variables a topic's Claude gets through `--settings`, or undefined when there is nothing to override: Claude
 * Code's own settings then decide. That is a topic that never chose with /api, and one that is off in a project
 * without an API of its own (the machine's settings may be an API too). Blanks (Claude Code takes an empty one as
 * unset) keep a project's own API from taking over.
 * shortcut: off in a project with its own API also blanks an API the machine sets in its environment (`claude /login`
 * is unaffected), copy the machine's values here when such a machine needs it.
 */
export function apiEnv(binding: Pick<TopicBinding, 'cwd' | 'api' | 'apiOff'> | undefined): Record<string, string> | undefined {
  if (!binding || (!binding.api && !binding.apiOff)) return undefined
  const server = binding.api?.enabled ? binding.api : undefined
  const project = projectEnv(binding.cwd)
  if (!server && !hasOwnApi(project)) return undefined
  // Blanked only when the project sets them: elsewhere a key may be the machine's login, a model the user's choice.
  const alsoBlank = (['ANTHROPIC_API_KEY', ...(project.ANTHROPIC_BASE_URL ? MODEL_VARS : [])] as const).filter(key => project[key])
  return {
    ANTHROPIC_BASE_URL: server?.baseUrl ?? '',
    ANTHROPIC_AUTH_TOKEN: server?.token ?? '',
    ...Object.fromEntries(alsoBlank.map(key => [key, ''])),
  }
}

export function hasOwnApi(project: Partial<Record<ProjectVar, string>>): boolean {
  return API_VARS.some(key => project[key])
}

/**
 * The API and model variables the project sets itself in .claude/settings.json and settings.local.json (the latter
 * wins). A missing or unreadable file declares nothing.
 * shortcut: only these variables in the bound folder's two files (no apiKeyHelper, no Bedrock / Vertex switch), add them when a project uses one.
 */
export function projectEnv(cwd: string): Partial<Record<ProjectVar, string>> {
  const found: Partial<Record<ProjectVar, string>> = {}
  for (const name of ['settings.json', 'settings.local.json']) {
    try {
      const env = JSON.parse(readFileSync(join(cwd, '.claude', name), 'utf8').replace(/^﻿/, ''))?.env
      for (const key of [...API_VARS, ...MODEL_VARS]) if (typeof env?.[key] === 'string') found[key] = env[key]
    } catch {
      // no such file, or not JSON
    }
  }
  return found
}

/** What makes two API choices different for a running process: it has to restart when this changes. */
export function apiSignature(env: Record<string, string> | undefined): string {
  return env ? JSON.stringify(env) : ''
}

/**
 * Writes the topic's settings file for `claude --settings`: it outranks the router's environment, the project's
 * .claude/settings*.json and the user's ~/.claude/settings.json (any of which may carry its own ANTHROPIC_BASE_URL).
 * Kept in the router's data folder, never in the project, so a repo can not commit the token. Rewritten at every
 * start: it always matches the store.
 */
export function writeApiSettings(dataDir: string, topicKey: string, env: Record<string, string>): string {
  const dir = join(dataDir, 'topic-api')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${topicKey.replace(/[^\w-]/g, '_')}.json`)
  writeFileSync(file, JSON.stringify({ env }, null, 2), { mode: 0o600 })
  return file
}
