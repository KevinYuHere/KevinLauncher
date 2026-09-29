// Worker thread that snapshots the running process tree (pid/parent/name) via
// WMI. A `Get-CimInstance` call can block for a while, so it runs here instead
// of on the main process. The parent sends `{ id }` and receives the snapshot
// tagged with the same id.
import { parentPort } from 'worker_threads'
import { execFile } from 'child_process'
import { promisify } from 'util'

const exec = promisify(execFile)

const PS_CMD =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'

interface Request {
  id: number
}

parentPort?.on('message', async (message: Request) => {
  try {
    const { stdout } = await exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PS_CMD],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true }
    )
    const parsed: unknown = stdout.trim() ? JSON.parse(stdout) : []
    const list = Array.isArray(parsed) ? parsed : [parsed]
    const procs = list.map((raw) => {
      const p = raw as { ProcessId: number; ParentProcessId: number; Name: string }
      return { pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name }
    })
    parentPort?.postMessage({ id: message.id, ok: true, procs })
  } catch (error) {
    parentPort?.postMessage({ id: message.id, ok: false, error: (error as Error).message })
  }
})
