import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { launcherEntryPath } from './buildIdentity'
import { log } from './logger'
import type { ProcessIdentity } from './processTree'

const exec = promisify(execFile)

/** Request a normal exit from the installed processes using only the setup's own entry. */
export async function requestLauncherClose(processes: readonly ProcessIdentity[]): Promise<number> {
  const entry = launcherEntryPath()
  if (entry === process.execPath) return 0
  let sent = 0
  for (const process of processes) {
    try {
      const { stdout } = await exec(entry, [
        '--kevin-close-launcher-window', String(process.pid), String(process.createdAt), process.executable
      ], { timeout: 5000, windowsHide: true })
      const count = stdout.trim()
      const matched = Number(count)
      if (!/^\d+$/.test(count) || !Number.isSafeInteger(matched)) throw new Error('启动器退出请求状态无效')
      sent += matched
    } catch (error) {
      log(`install: close request for PID ${process.pid} failed (${String(error)})`)
    }
  }
  return sent
}
