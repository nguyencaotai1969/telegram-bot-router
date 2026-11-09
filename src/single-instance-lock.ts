import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Only one router per data folder: two would fight over the bot (409), run one topic's
 * session twice at once and overwrite each other's state.json. Returns the release function.
 */
export function acquireSingleInstanceLock(file: string): () => void {
  mkdirSync(dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return () => releaseLock(file)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const holder = Number(readFileSync(file, 'utf8').trim())
      if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && isAlive(holder)) {
        throw new Error(
          `Router đang chạy ở tiến trình khác (pid ${holder}). Đóng cửa sổ đó trước. ` +
            `Nếu chắc không còn router nào, xoá ${file}.`,
        )
      }
      unlinkSync(file) // left by a router that crashed or whose window was closed
    }
  }
  throw new Error(`Không lấy được khoá ${file}`)
}

function releaseLock(file: string): void {
  try {
    if (readFileSync(file, 'utf8').trim() === String(process.pid)) unlinkSync(file)
  } catch {
    // already gone
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
