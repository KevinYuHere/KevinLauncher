import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { launcherEntryPath } from './buildIdentity'
import { log } from './logger'
import type { ProcessIdentity } from './processTree'

const exec = promisify(execFile)

function logCloseDiagnostics(pid: number, stderr: string | undefined): void {
  for (const line of stderr?.trim().split(/\r?\n/) ?? []) {
    if (line) log(`install: close request for PID ${pid}: ${line}`)
  }
}

/** Request a normal exit from the installed processes using only the setup's own entry. */
export async function requestLauncherClose(processes: readonly ProcessIdentity[]): Promise<number> {
  const entry = launcherEntryPath()
  if (entry === process.execPath) return 0
  let sent = 0
  for (const process of processes) {
    try {
      const { stdout, stderr } = await exec(entry, [
        '--kevin-close-launcher-window', String(process.pid), String(process.createdAt), process.executable
      ], { timeout: 5000, windowsHide: true })
      logCloseDiagnostics(process.pid, stderr)
      const count = stdout.trim()
      const matched = Number(count)
      if (!/^\d+$/.test(count) || !Number.isSafeInteger(matched)) throw new Error('启动器退出请求状态无效')
      sent += matched
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string }
      logCloseDiagnostics(process.pid, failure.stderr)
      const reason = failure.killed ? 'helper timed out' : failure.code ?? failure.message
      log(`install: close request for PID ${process.pid} failed (${reason})`)
    }
  }
  return sent
}
