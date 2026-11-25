import { psQuote, runPowerShell } from './powershell'
import { win32 } from 'path'

export interface ProcInfo {
  pid: number
  ppid: number
  name: string
  executable?: string
  createdAt?: number
}

export interface ProcessIdentity extends ProcInfo {
  executable: string
  createdAt: number
}

const PS_CMD = `
$ErrorActionPreference = 'Stop'
$epoch = [DateTime]::SpecifyKind([DateTime]'1970-01-01', [DateTimeKind]::Utc)
@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate | ForEach-Object {
  $created = if ($_.CreationDate) { [long][Math]::Floor(($_.CreationDate.ToUniversalTime() - $epoch).TotalMilliseconds) } else { $null }
  [PSCustomObject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; executable = $_.ExecutablePath; createdAt = $created }
}) | ConvertTo-Json -Compress
`

export function canonicalExecutable(path: string): string {
  return win32.normalize(path.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')).toLowerCase()
}

export function hasProcessIdentity(process: ProcInfo): process is ProcessIdentity {
  return typeof process.executable === 'string' && win32.isAbsolute(process.executable) &&
    typeof process.createdAt === 'number' && Number.isSafeInteger(process.createdAt) && process.createdAt > 0
}

export function sameProcess(left: ProcessIdentity, right: ProcInfo): boolean {
  return hasProcessIdentity(right) && left.pid === right.pid && left.createdAt === right.createdAt &&
    canonicalExecutable(left.executable) === canonicalExecutable(right.executable)
}

export type StopProcessOutcome = 'stopped' | 'exited' | 'mismatch' | 'failed'

/** Reads the Windows process list (pid + parent pid + name) on demand. */
export class ProcessTree {
  /** Snapshot of all processes. Uses CIM so parent pids are available. */
  static async snapshot(signal?: AbortSignal): Promise<ProcInfo[]> {
    const stdout = await runPowerShell(PS_CMD, { maxBuffer: 8 * 1024 * 1024, timeout: 12_000, signal, systemOnly: true })
    if (!stdout.trim()) return []
    const parsed = JSON.parse(stdout) as unknown
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list.filter((value): value is ProcInfo => !!value &&
      typeof value === 'object' && Number.isSafeInteger(value.pid) && Number.isSafeInteger(value.ppid) &&
      typeof value.name === 'string')
  }

  /** Pin a process handle before checking identity and let it guard termination against PID reuse. */
  static async stop(process: ProcessIdentity): Promise<StopProcessOutcome> {
    if (!hasProcessIdentity(process) || !Number.isSafeInteger(process.pid) || process.pid < 1) return 'failed'
    const script = `
$ErrorActionPreference = 'Stop'
$target = $null
try {
  try { $target = [Diagnostics.Process]::GetProcessById(${process.pid}) }
  catch [ArgumentException] { 'exited'; return }
  $null = $target.Handle
  if ($target.HasExited) { 'exited'; return }
  $epoch = [DateTime]::SpecifyKind([DateTime]'1970-01-01', [DateTimeKind]::Utc)
  $created = [long][Math]::Floor(($target.StartTime.ToUniversalTime() - $epoch).TotalMilliseconds)
  if ($created -ne ${process.createdAt} -or $target.MainModule.FileName -ine ${psQuote(process.executable)}) {
    'mismatch'; return
  }
  $target.Kill()
  if ($target.WaitForExit(3000)) { 'stopped' } else { 'failed' }
} catch { 'failed' }
finally { if ($target) { $target.Dispose() } }
`
    const result = (await runPowerShell(script, { timeout: 8000 }).catch(() => '')).trim()
    return result === 'stopped' || result === 'exited' || result === 'mismatch' ? result : 'failed'
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
