import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireSingleInstanceLock } from '../src/single-instance-lock'

const dir = mkdtempSync(join(tmpdir(), 'lock-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('single instance lock', () => {
  test('a second router is refused while the first runs, and may start once it released', () => {
    const file = join(dir, 'router.lock')
    const holder = Bun.spawn([process.execPath, '-e', 'await Bun.sleep(20000)'])
    writeFileSync(file, String(holder.pid))
    try {
      expect(() => acquireSingleInstanceLock(file)).toThrow(`pid ${holder.pid}`)
    } finally {
      holder.kill()
    }
  })

  test('a lock left by a dead router is taken over, and released on exit', async () => {
    const file = join(dir, 'stale.lock')
    const gone = Bun.spawn([process.execPath, '-e', '0'])
    await gone.exited
    writeFileSync(file, String(gone.pid))
    const release = acquireSingleInstanceLock(file)
    expect(existsSync(file)).toBe(true)
    release()
    expect(existsSync(file)).toBe(false)
  })
})
