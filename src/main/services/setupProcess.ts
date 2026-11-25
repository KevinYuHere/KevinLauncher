import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { launcherEntryPath, trialBuild } from './buildIdentity'
import type { ProcessIdentity } from './processTree'

const exec = promisify(execFile)

/** Use the bundled Win32 entry to request a regular close from an exact legacy instance. */
export async function requestLegacyLauncherClose(processes: readonly ProcessIdentity[]): Promise<number> {
  const entry = launcherEntryPath()
  if (trialBuild || entry === process.execPath) return 0
  let sent = 0
  for (const process of processes) {
    const { stdout } = await exec(entry, [
      '--kevin-close-legacy-window', String(process.pid), String(process.createdAt), process.executable
    ], { timeout: 5000, windowsHide: true })
    const count = stdout.trim()
    const matched = Number(count)
    if (!/^\d+$/.test(count) || !Number.isSafeInteger(matched)) throw new Error('旧启动器退出状态无效')
    sent += matched
  }
  return sent
}
