/** Pids of claude processes still running, so a shutdown can end them all. */
const liveRuns = new Set<number>()

export function trackRun(pid: number): () => void {
  liveRuns.add(pid)
  return () => liveRuns.delete(pid)
}

interface KillableProcess {
  pid: number
  exitCode: number | null
  kill(): void
}

/** Ends a process and everything it started (shells, dev servers, sub-agents). */
export async function killTree(proc: KillableProcess): Promise<void> {
  if (proc.exitCode !== null) return
  if (process.platform !== 'win32') {
    proc.kill()
    return
  }
  try {
    const taskkill = Bun.spawn(['taskkill', '/PID', String(proc.pid), '/T', '/F'], {
      stdout: 'ignore',
      stderr: 'ignore',
      windowsHide: true,
    })
    if ((await taskkill.exited) === 0) return
  } catch {
    // taskkill unavailable: fall through
  }
  if (proc.exitCode === null) proc.kill()
}

/** For shutdown (window closed, Ctrl+C): blocks until every tracked run's tree is ended. */
export function killAllRunsSync(): void {
  for (const pid of liveRuns) {
    if (process.platform === 'win32') {
      Bun.spawnSync(['taskkill', '/PID', String(pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' })
    } else {
      try {
        process.kill(pid)
      } catch {
        // already gone
      }
    }
  }
  liveRuns.clear()
}
