import { execFile } from 'child_process'
import { promisify } from 'util'

const exec = promisify(execFile)

export interface ProcInfo {
  pid: number
  ppid: number
  name: string
}

const PS_CMD =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'

/** Reads the Windows process list (pid + parent pid + name) on demand. */
export class ProcessTree {
  /** Snapshot of all processes. Uses CIM so parent pids are available. */
  static async snapshot(): Promise<ProcInfo[]> {
    const { stdout } = await exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PS_CMD],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true }
    )
    if (!stdout.trim()) return []
    const parsed = JSON.parse(stdout) as unknown
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list.map((p) => {
      const rec = p as { ProcessId: number; ParentProcessId: number; Name: string }
      return { pid: rec.ProcessId, ppid: rec.ParentProcessId, name: rec.Name }
    })
  }

  /** Transitive descendants of `rootPid` (including itself). */
  static descendants(snapshot: ProcInfo[], rootPid: number): number[] {
    const byParent = new Map<number, number[]>()
    for (const p of snapshot) {
      const list = byParent.get(p.ppid)
      if (list) list.push(p.pid)
      else byParent.set(p.ppid, [p.pid])
    }
    const result: number[] = []
    const seen = new Set<number>()
    const stack = [rootPid]
    while (stack.length) {
      const current = stack.pop() as number
      if (seen.has(current)) continue
      seen.add(current)
      result.push(current)
      for (const child of byParent.get(current) ?? []) stack.push(child)
    }
    return result
  }
}
