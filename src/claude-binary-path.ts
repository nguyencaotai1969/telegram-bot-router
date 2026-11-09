import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

const EXE = process.platform === 'win32' ? 'claude.exe' : 'claude'
/** Where `npm install -g @anthropic-ai/claude-code` keeps its package, next to its shims. */
const NPM_PACKAGE = ['node_modules', '@anthropic-ai', 'claude-code']
/** The native binary npm unpacks; its postinstall links it to bin/claude.exe. */
const NATIVE_PACKAGE = ['node_modules', '@anthropic-ai', `claude-code-${process.platform}-${process.arch}`, EXE]
/** npm first unpacks bin/claude.exe as a small placeholder script (postinstall replaces it): not runnable. */
const MIN_BINARY_BYTES = 4096

export interface ClaudeSearchPlaces {
  /** The PATH to search (default: this process's PATH). */
  pathEnv?: string
  /** Home folder holding the native installer's .local/bin (default: the user's). */
  home?: string
}

/**
 * Every place a claude executable may be, best first. On Windows it must be the real .exe:
 * a .cmd / .bat shim would need cmd.exe, which re-parses arguments.
 */
export function claudeBinaryCandidates(places: ClaudeSearchPlaces = {}): string[] {
  const candidates: string[] = []
  for (const raw of (places.pathEnv ?? process.env.PATH ?? '').split(delimiter)) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1')
    if (!dir || !isAbsolute(dir)) continue // a relative entry would resolve against each topic's folder
    candidates.push(join(dir, EXE), join(dir, ...NPM_PACKAGE, 'bin', 'claude.exe'))
    // An update renames bin/claude.exe before it puts the new one there; this file stays.
    candidates.push(join(dir, ...NPM_PACKAGE, ...NATIVE_PACKAGE))
  }
  candidates.push(join(places.home ?? homedir(), '.local', 'bin', EXE))
  return candidates
}

/** A file big enough to be the real claude, not npm's placeholder. */
function isClaudeBinary(path: string): boolean {
  try {
    const stat = statSync(path)
    return stat.isFile() && stat.size >= MIN_BINARY_BYTES
  } catch {
    return false
  }
}

/** The claude executable the router spawns: CLAUDE_BIN, or the first one found. */
export function resolveClaudeBinary(explicit?: string, places?: ClaudeSearchPlaces): string {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`CLAUDE_BIN không tồn tại: ${explicit}`)
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(explicit)) {
      throw new Error('CLAUDE_BIN phải là claude.exe, không phải file .cmd / .bat')
    }
    return explicit
  }
  const found = claudeBinaryCandidates(places).find(isClaudeBinary)
  if (!found) {
    throw new Error('Không tìm thấy claude. Cài Claude Code hoặc đặt CLAUDE_BIN trong .env.')
  }
  return found
}

/**
 * The claude path to use for each new process. Found at startup (throws if there is none), then
 * looked up again at every call: a Claude Code update renames claude.exe while it replaces it, may
 * move the whole package aside for a while, or install the new one elsewhere, and the router must
 * neither keep a path that is gone nor stay on a fallback once the first choice is back.
 * A CLAUDE_BIN set by the user is never swapped for another.
 */
export function claudeBinaryLocator(explicit?: string, places?: ClaudeSearchPlaces): () => string {
  let current = resolveClaudeBinary(explicit, places)
  if (explicit) return () => current
  return () => {
    try {
      const found = resolveClaudeBinary(undefined, places)
      if (found !== current) console.log(`Claude: chuyển từ ${current} sang ${found}`)
      current = found
    } catch {
      // none right now (mid-update): spawning the last path reports the error, the next spawn looks again
    }
    return current
  }
}
