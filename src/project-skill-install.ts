import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import type { SourceSkill } from './skill-sources'
import { SECRET_NAME } from './telegram-outgoing-files'

/** Never copied: installed packages and caches (ClaudeKit's chrome-devtools carries 72 MB of node_modules). */
const SKIPPED = new Set(['node_modules', '__pycache__', '.venv', 'venv', '.git'])
/**
 * Written into each copy: the hash of every file the router put there. A copy is only ever removed
 * while it still has exactly those files, so a skill the project wrote or changed is never deleted.
 */
const MANIFEST = '.router-skill.json'

/** Where Claude Code looks for a project's own skills. */
export function projectSkillsDir(cwd: string): string {
  return join(cwd, '.claude', 'skills')
}

/** The project has a skill folder of this name (copied from a source, or its own). */
export function hasProjectSkill(cwd: string, name: string): boolean {
  return existsSync(join(projectSkillsDir(cwd), name))
}

/**
 * Copies a skill into the project with its manifest, and the source's shared folders it imports when the
 * project lacks them (they hold no SKILL.md: not skills, never removed). Never replaces a skill already
 * there. Throws on a disk error, before the skill is in place.
 */
export function installSkill(cwd: string, skill: SourceSkill): 'installed' | 'exists' {
  const skillsDir = projectSkillsDir(cwd)
  const target = join(skillsDir, skill.name)
  if (existsSync(target)) return 'exists'
  mkdirSync(skillsDir, { recursive: true })
  for (const shared of skill.shared) {
    if (!existsSync(join(skillsDir, basename(shared)))) copyWhole(cwd, shared, join(skillsDir, basename(shared)))
  }
  copyWhole(cwd, skill.dir, target, copy => writeFileSync(join(copy, MANIFEST), JSON.stringify({ files: hashTree(copy) }, null, 2)))
  return 'installed'
}

/**
 * Removes the project's copy of a skill: only one the router installed ('foreign' otherwise) whose files
 * are all still as installed ('changed' otherwise). Throws on a disk error, with the copy left whole.
 */
export function removeSkill(cwd: string, skill: SourceSkill): 'removed' | 'missing' | 'foreign' | 'changed' {
  const target = join(projectSkillsDir(cwd), skill.name)
  if (!existsSync(target)) return 'missing'
  const installed = manifestFiles(target)
  if (!installed) return 'foreign'
  const now = hashTree(target)
  const same = Object.keys(now).length === Object.keys(installed).length && Object.entries(now).every(([path, hash]) => installed[path] === hash)
  if (!same) return 'changed'
  const trash = join(cwd, '.claude', `.skill-removing-${skill.name}`)
  rmSync(trash, { recursive: true, force: true }) // left by a crash
  renameSync(target, trash) // a file in use (Windows) fails here, before anything is deleted
  try {
    rmSync(trash, { recursive: true, force: true })
  } catch (err) {
    console.warn(`Gỡ skill: không xoá hết được ${trash}: ${err instanceof Error ? err.message : err}`)
  }
  return 'removed'
}

/**
 * Copies a folder to `target` whole or not at all: into a folder beside .claude/skills first (Claude
 * never sees half a skill), then renamed into place. Its name is fixed (one router per machine), so a
 * copy cut short by a crash is cleared by the next one.
 */
function copyWhole(cwd: string, from: string, target: string, finish?: (copy: string) => void): void {
  const temp = join(cwd, '.claude', `.skill-installing-${basename(target)}`)
  try {
    rmSync(temp, { recursive: true, force: true })
    const source = realpathSync(from)
    cpSync(source, temp, { recursive: true, filter: path => path === source || isCopied(path) })
    finish?.(temp)
    renameSync(temp, target)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

/** Not caches, not secrets (a skill's own .env stays out of the project's git), not links (they may lead anywhere). */
function isCopied(path: string): boolean {
  const name = basename(path)
  return !SKIPPED.has(name) && !SECRET_NAME.test(name) && !lstatSync(path).isSymbolicLink()
}

/** Every file under `root` (but the manifest), by its path from `root`, with its SHA-256. */
function hashTree(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const key = relative(root, path).split(sep).join('/')
      if (key === MANIFEST) continue
      if (entry.isDirectory()) walk(path)
      else files[key] = entry.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'not a file'
    }
  }
  walk(root)
  return files
}

function manifestFiles(copy: string): Record<string, string> | undefined {
  try {
    const files: unknown = JSON.parse(readFileSync(join(copy, MANIFEST), 'utf8'))?.files
    return files && typeof files === 'object' ? (files as Record<string, string>) : undefined
  } catch {
    return undefined
  }
}
