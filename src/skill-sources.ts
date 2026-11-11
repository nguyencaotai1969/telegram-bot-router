import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** A skill folder name /skills accepts: also its name in the project, and it must fit Telegram's 64-byte button data. */
export const SKILL_NAME = /^[A-Za-z0-9][\w.-]{0,39}$/

/** One skill a source offers. */
export interface SourceSkill {
  /** Its folder name, kept as is in the project's .claude/skills. */
  name: string
  description: string
  /** Its folder in the source. */
  dir: string
  /** The source's shared folders (no SKILL.md) that skills import by relative path: copied along. */
  shared: string[]
}

/** Where /skills installs skills from. Another source = one more entry in SKILL_SOURCES. */
export interface SkillSource {
  /** Short: it goes in button data. */
  id: string
  label: string
  /** What to do when this machine does not have the source. */
  missingHint: string
  /** The folder holding one folder per skill, when this machine has it. */
  folder(claudeDir: string): string | undefined
  /** Which of the folder's skills belong to the source, by their SKILL.md frontmatter (default: all). */
  owns?(frontmatter: string): boolean
  /** Folders of the source, beside its skills, that skills import by relative path. */
  shared?: string[]
}

export const SKILL_SOURCES: readonly SkillSource[] = [
  {
    id: 'ponytail',
    label: 'Ponytail',
    missingHint: 'cài plugin ponytail cho Claude Code trước',
    folder: claudeDir => pluginSkillsFolder(claudeDir, 'ponytail', 'ponytail'),
  },
  {
    id: 'ck',
    label: 'ClaudeKit',
    missingHint: 'cài ClaudeKit trước (ck init -g)',
    // ~/.claude/skills also holds other kits' skills: ClaudeKit's say `author: claudekit` or are named ck:… / ckm:…
    folder: claudeDir => (isDir(join(claudeDir, 'skills')) ? join(claudeDir, 'skills') : undefined),
    owns: frontmatter => /^\s*author:\s*["']?claudekit\b/m.test(frontmatter) || /^name:\s*["']?ckm?:/m.test(frontmatter),
    // plans-kanban and markdown-novel-viewer require ../../../_shared/lib; ai-multimodal imports ../../common
    shared: ['_shared', 'common'],
  },
]

/** The skills of a source, by name; undefined when this machine does not have the source. */
export function sourceSkills(source: SkillSource, claudeDir: string): SourceSkill[] | undefined {
  const folder = source.folder(claudeDir)
  if (!folder) return undefined
  let names: string[]
  try {
    names = readdirSync(folder)
  } catch {
    return undefined
  }
  const shared = (source.shared ?? []).map(name => join(folder, name)).filter(isDir)
  const skills: SourceSkill[] = []
  for (const name of names) {
    const dir = join(folder, name)
    if (!SKILL_NAME.test(name) || !isDir(dir)) continue
    const frontmatter = frontmatterOf(join(dir, 'SKILL.md'))
    if (frontmatter === undefined || (source.owns && !source.owns(frontmatter))) continue
    skills.push({ name, description: descriptionOf(frontmatter), dir, shared })
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/** A plugin's skills folder: where Claude Code installed it, else its marketplace's copy. */
function pluginSkillsFolder(claudeDir: string, plugin: string, marketplace: string): string | undefined {
  const plugins = join(claudeDir, 'plugins')
  let installPaths: string[] = []
  try {
    const installed = JSON.parse(readFileSync(join(plugins, 'installed_plugins.json'), 'utf8'))
    const entries: unknown = installed?.plugins?.[`${plugin}@${marketplace}`]
    if (Array.isArray(entries)) installPaths = entries.map(entry => entry?.installPath).filter(path => typeof path === 'string')
  } catch {
    // no plugin installed yet
  }
  const candidates = [...installPaths.map(path => join(path, 'skills')), join(plugins, 'marketplaces', marketplace, 'skills')]
  return candidates.find(isDir)
}

/** The YAML between the leading `---` lines of a SKILL.md; undefined when it is not a skill. */
function frontmatterOf(file: string): string | undefined {
  try {
    return /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, 'utf8'))?.[1]
  } catch {
    return undefined
  }
}

/** `description:` as one line: plain, quoted, or a block (`>` / `|`) of indented lines. */
function descriptionOf(frontmatter: string): string {
  const lines = frontmatter.split(/\r?\n/)
  const at = lines.findIndex(line => line.startsWith('description:'))
  if (at < 0) return ''
  let text = (lines[at] ?? '').slice('description:'.length).trim()
  if (text === '' || /^[>|][-+]?$/.test(text)) {
    const block: string[] = []
    for (const line of lines.slice(at + 1)) {
      if (!/^\s/.test(line) && line.trim()) break
      block.push(line.trim())
    }
    text = block.join(' ')
  }
  return text
    .replace(/^(["'])([\s\S]*)\1$/, '$2')
    .replace(/\s+/g, ' ')
    .trim()
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
