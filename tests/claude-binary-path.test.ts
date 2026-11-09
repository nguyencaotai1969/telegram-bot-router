import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

// The layout below is what `npm install -g @anthropic-ai/claude-code` leaves on Windows.
const onWindows = process.platform === 'win32'
const PROBE = join(import.meta.dir, 'fixtures', 'claude-command-probe.ts')
/** Stands in for the real binary (hundreds of MB): anything from 4 KB on counts as one. */
const REAL_EXE = Buffer.alloc(8192, 1)
/** npm unpacks a small placeholder script as bin/claude.exe; postinstall replaces it. */
const STUB_EXE = '#!/bin/sh\necho "claude native binary not installed" >&2\nexit 1\n'
const root = mkdtempSync(join(tmpdir(), 'claude-bin-test-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A global npm folder: the claude.cmd shim, bin/claude.exe and the native package binary it was linked from. */
function npmPrefix(name: string, parts: { bin: 'real' | 'stub' | 'none'; native: boolean }) {
  const prefix = join(root, name)
  const pkg = join(prefix, 'node_modules', '@anthropic-ai', 'claude-code')
  const nativeDir = join(pkg, 'node_modules', '@anthropic-ai', `claude-code-${process.platform}-${process.arch}`)
  mkdirSync(join(pkg, 'bin'), { recursive: true })
  mkdirSync(nativeDir, { recursive: true })
  writeFileSync(join(prefix, 'claude.cmd'), '@echo off\r\n')
  const bin = join(pkg, 'bin', 'claude.exe')
  const native = join(nativeDir, 'claude.exe')
  if (parts.bin !== 'none') writeFileSync(bin, parts.bin === 'real' ? REAL_EXE : STUB_EXE)
  if (parts.native) writeFileSync(native, REAL_EXE)
  return { prefix, pkg, bin, native }
}

/**
 * The claude paths a router started with only `dirs` on PATH would spawn: at startup, then after
 * each of `renames`. A child process, because PATH lookups may be fixed at process start.
 */
function routerSees(
  dirs: string[],
  opts: { renames?: [string, string][]; claudeBin?: string } = {},
): { seen?: string[]; error?: string } {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (!/^path$/i.test(key) && value) env[key] = value
  env.PATH = dirs.join(delimiter)
  env.PROBE_RENAMES = JSON.stringify(opts.renames ?? [])
  if (opts.claudeBin) env.PROBE_CLAUDE_BIN = opts.claudeBin
  const run = Bun.spawnSync([process.execPath, PROBE], { env, timeout: 10_000 })
  const last = run.stdout.toString().trim().split('\n').at(-1) ?? ''
  try {
    return JSON.parse(last)
  } catch {
    return { error: `probe printed: ${run.stdout.toString()}${run.stderr.toString()}` }
  }
}

describe.skipIf(!onWindows)('claude binary path', () => {
  test('an update renaming bin/claude.exe while the router runs: the next spawn uses the native package binary', () => {
    // Arrange
    const npm = npmPrefix('renamed-by-update', { bin: 'real', native: true })

    // Act: startup, then what the Claude Code updater did on 2026-11-07 00:32
    const result = routerSees([npm.prefix], { renames: [[npm.bin, `${npm.bin}.old.1793986361313`]] })

    // Assert
    expect(result).toEqual({ seen: [npm.bin, npm.native] })
  })

  test('a router started while bin/claude.exe is missing finds the native package binary', () => {
    // Arrange
    const npm = npmPrefix('bin-missing', { bin: 'none', native: true })

    // Act
    const result = routerSees([npm.prefix])

    // Assert
    expect(result).toEqual({ seen: [npm.native] })
  })

  test('npm placeholder stub as bin/claude.exe is skipped for the real binary next to it', () => {
    // Arrange: between unpacking and postinstall, or after a failed / skipped postinstall
    const npm = npmPrefix('stub-left', { bin: 'stub', native: true })

    // Act
    const result = routerSees([npm.prefix])

    // Assert
    expect(result).toEqual({ seen: [npm.native] })
  })

  test('a broken first install on PATH falls through to a working install further on', () => {
    // Arrange
    const broken = npmPrefix('broken-first', { bin: 'none', native: false })
    const working = npmPrefix('working-second', { bin: 'real', native: true })

    // Act
    const result = routerSees([broken.prefix, working.prefix])

    // Assert
    expect(result).toEqual({ seen: [working.bin] })
  })

  test('the first install comes back after npm moved it aside: the router returns to it', () => {
    // Arrange
    const first = npmPrefix('reinstalled-first', { bin: 'real', native: true })
    const second = npmPrefix('fallback-second', { bin: 'real', native: true })
    const aside = `${first.pkg}-moved-aside`

    // Act: npm moves the old package folder away while it unpacks the new one, then puts it in place
    const result = routerSees([first.prefix, second.prefix], {
      renames: [
        [first.pkg, aside],
        [aside, first.pkg],
      ],
    })

    // Assert
    expect(result).toEqual({ seen: [first.bin, second.bin, first.bin] })
  })

  test('CLAUDE_BIN set by the user is kept even when that file disappears', () => {
    // Arrange
    const npm = npmPrefix('explicit', { bin: 'real', native: true })

    // Act
    const result = routerSees([npm.prefix], { claudeBin: npm.bin, renames: [[npm.bin, `${npm.bin}.old`]] })

    // Assert
    expect(result).toEqual({ seen: [npm.bin, npm.bin] })
  })
})
