import { win32 } from 'path'
import { canonicalExecutable, hasProcessIdentity, sameProcess, type ProcInfo, type ProcessIdentity } from './processTree'

export interface LaunchObservation {
  requestedAt: number
  spawnedAt?: number
  rootExecutable?: string
  targetExecutable?: string
  monitorDirectory?: string
  indirect?: boolean
}

export interface ProcessLineage {
  rootPid: number | null
  intent: LaunchObservation
  monitor: Set<string>
  seen: Map<number, { identity: ProcessIdentity; at: number }>
  inspected: boolean
}

const LINEAGE_MS = 60_000
const CREATION_TOLERANCE_MS = 25
// Do not claim a process by executable name/path long after the launch request:
// another instance started later is unrelated and must not be stopped with this app.
const MATCH_WINDOW_MS = 5 * 60_000

function insideDirectory(executable: string, directory: string): boolean {
  const root = canonicalExecutable(directory).replace(/\\+$/, '')
  return canonicalExecutable(executable).startsWith(`${root}\\`)
}

/** Follow identity-checked ancestors and expected locations across successive snapshots. */
export function observeLaunch(
  entry: ProcessLineage,
  snapshot: readonly ProcInfo[],
  available: (process: ProcessIdentity) => boolean,
  now: number
): Map<number, ProcessIdentity> {
  const byPid = new Map(snapshot.map((process) => [process.pid, process]))
  const children = new Map<number, ProcessIdentity[]>()
  const active = new Map<number, ProcessIdentity>()
  const claimed: ProcessIdentity[] = []
  const before = entry.intent.requestedAt - CREATION_TOLERANCE_MS
  const accept = (process: ProcessIdentity): void => {
    if (active.has(process.pid) || !available(process)) return
    active.set(process.pid, process)
    entry.seen.set(process.pid, { identity: process, at: now })
    claimed.push(process)
  }
  const descendants = (pid: number, createdAt: number, beforeReuse?: number): void => {
    for (const child of children.get(pid) ?? []) {
      if (child.createdAt >= createdAt && (beforeReuse === undefined || child.createdAt < beforeReuse)) accept(child)
    }
  }
  for (const process of snapshot) {
    if (!hasProcessIdentity(process)) continue
    const siblings = children.get(process.ppid) ?? []
    siblings.push(process)
    children.set(process.ppid, siblings)
    const known = entry.seen.get(process.pid)
    if (known && sameProcess(known.identity, process)) accept(process)
  }
  const root = entry.rootPid === null ? undefined : byPid.get(entry.rootPid)
  const rootExecutable = entry.intent.rootExecutable && canonicalExecutable(entry.intent.rootExecutable)
  if (root && hasProcessIdentity(root) && !entry.seen.has(root.pid) && !entry.inspected &&
      root.createdAt >= before && (entry.intent.spawnedAt === undefined || root.createdAt <= entry.intent.spawnedAt + CREATION_TOLERANCE_MS) &&
      (!rootExecutable || canonicalExecutable(root.executable) === rootExecutable)) {
    accept(root)
  }
  // A process can exit before the first query. Windows retains each child's
  // recorded parent PID, even after that parent has disappeared.
  if (entry.rootPid !== null && !entry.inspected && (!root || hasProcessIdentity(root) &&
      rootExecutable && canonicalExecutable(root.executable) !== rootExecutable)) {
    descendants(entry.rootPid, before, root?.createdAt)
  }
  entry.inspected = true

  for (const [pid, ancestor] of entry.seen) {
    const current = byPid.get(pid)
    if (current && sameProcess(ancestor.identity, current)) continue
    if (now - ancestor.at > LINEAGE_MS) {
      entry.seen.delete(pid)
      continue
    }
    descendants(pid, ancestor.identity.createdAt, current?.createdAt)
  }
  const matchDeadline = (entry.intent.spawnedAt ?? entry.intent.requestedAt) + MATCH_WINDOW_MS
  for (const process of snapshot) {
    if (!hasProcessIdentity(process) || process.createdAt < before || process.createdAt > matchDeadline ||
        process.pid === entry.rootPid || entry.seen.has(process.pid)) continue
    const exact = entry.intent.targetExecutable &&
      canonicalExecutable(process.executable) === canonicalExecutable(entry.intent.targetExecutable)
    const configured = entry.intent.monitorDirectory && entry.monitor.has(process.name.toLowerCase()) &&
      insideDirectory(process.executable, entry.intent.monitorDirectory) &&
      win32.basename(process.executable).toLowerCase() === process.name.toLowerCase()
    if (exact || configured) accept(process)
  }
  for (let index = 0; index < claimed.length; index++) {
    const parent = claimed[index]
    descendants(parent.pid, parent.createdAt)
  }
  return active
}
