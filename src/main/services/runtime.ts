import { execFile } from 'child_process'
import { promisify } from 'util'
import type { RunningApp, StopResult } from '@shared/types'
import { ProcessTree, type ProcInfo } from './processTree'
import { ProcessScanner } from './processScanner'
import type { PlaySessionRecord } from './playTimeStore'
import { log } from './logger'

const exec = promisify(execFile)

interface TrackedEntry {
  appId: string
  rootPid: number | null
  elevated: boolean
  /** When tracking began (used only to bound the "waiting for the app" window). */
  createdAt: number
  /** When the app was actually observed running; the play session starts here. */
  startedAt: string
  /** Pids we consider part of the running app (root + descendants + monitored). */
  pids: Set<number>
  /** Optional process names to watch (for shortcut / elevated / script launches). */
  monitor: Set<string>
  /** True once the app has actually been seen running (a live pid exists). */
  armed: boolean
}

const POLL_INTERVAL_MS = 4000
/** How long a pid-less launch may wait for its monitored process to appear. */
const MATCH_GRACE_MS = 5 * 60 * 1000

/**
 * Tracks which applications are currently running by following the process
 * tree of the launched process, plus optional process-name monitoring for
 * launches that cannot be tracked by pid (shortcuts / elevated starts).
 *
 * Process enumeration runs in a worker thread (see ProcessScanner) so it never
 * blocks the main process / UI.
 */
export class Runtime {
  private readonly running = new Map<string, TrackedEntry>()
  private readonly scanner = new ProcessScanner()
  private timer: NodeJS.Timeout | null = null
  private readonly listeners = new Set<() => void>()
  private sessionListener: ((record: PlaySessionRecord) => void) | null = null

  onChanged(callback: () => void): () => void {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  /** Called when a tracked app stops, with its recorded session. */
  onSessionEnded(callback: (record: PlaySessionRecord) => void): void {
    this.sessionListener = callback
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  /** Stop tracking an entry, optionally recording its play session. */
  private endEntry(entry: TrackedEntry, record: boolean): void {
    this.running.delete(entry.appId)
    if (!record) return
    const endUtc = new Date().toISOString()
    const durationSec = Math.round((Date.now() - new Date(entry.startedAt).getTime()) / 1000)
    if (this.sessionListener && durationSec > 0) {
      this.sessionListener({ appId: entry.appId, startUtc: entry.startedAt, endUtc, durationSec })
    }
  }

  start(appId: string, rootPid: number | null, elevated: boolean, monitorNames: string[]): void {
    const now = Date.now()
    const entry: TrackedEntry = {
      appId,
      rootPid,
      elevated,
      createdAt: now,
      startedAt: new Date(now).toISOString(),
      pids: new Set(rootPid ? [rootPid] : []),
      monitor: new Set(monitorNames.map((n) => n.toLowerCase()).filter(Boolean)),
      armed: rootPid !== null
    }
    this.running.set(appId, entry)
    this.ensureTimer()
    this.emit()
  }

  /** Kill every process belonging to the tracked app and stop tracking it. */
  async stop(appId: string): Promise<StopResult> {
    const entry = this.running.get(appId)
    if (!entry) return { ok: true, killed: 0 }

    const pids = [...entry.pids]
    this.endEntry(entry, entry.armed)
    this.emit()

    if (pids.length === 0) return { ok: true, killed: 0 }

    const results = await Promise.all(
      pids.map((pid) =>
        exec('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true }).then(
          () => true,
          () => false
        )
      )
    )
    const killed = results.filter(Boolean).length
    log(`runtime: stop "${appId}" killed ${killed}/${pids.length}`)
    return { ok: true, killed }
  }

  isRunning(appId: string): boolean {
    return this.running.has(appId)
  }

  list(): RunningApp[] {
    return [...this.running.values()].map((entry) => ({
      appId: entry.appId,
      rootPid: entry.rootPid,
      elevated: entry.elevated,
      startedAt: entry.startedAt,
      pids: [...entry.pids]
    }))
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.scanner.dispose()
  }

  private ensureTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, POLL_INTERVAL_MS)
  }

  private async tick(): Promise<void> {
    if (this.running.size === 0) {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      return
    }

    let snapshot: ProcInfo[]
    try {
      snapshot = await this.scanner.snapshot()
    } catch {
      return
    }

    const alive = new Set(snapshot.map((p) => p.pid))
    const nameToPids = new Map<string, number[]>()
    for (const p of snapshot) {
      const key = p.name.toLowerCase()
      const list = nameToPids.get(key)
      if (list) list.push(p.pid)
      else nameToPids.set(key, [p.pid])
    }

    let changed = false

    for (const entry of [...this.running.values()]) {
      for (const pid of [...entry.pids]) {
        if (!alive.has(pid)) {
          entry.pids.delete(pid)
          changed = true
          continue
        }
        for (const descendant of ProcessTree.descendants(snapshot, pid)) {
          if (!entry.pids.has(descendant)) {
            entry.pids.add(descendant)
            changed = true
          }
        }
      }

      for (const name of entry.monitor) {
        for (const pid of nameToPids.get(name) ?? []) {
          if (!entry.pids.has(pid)) {
            entry.pids.add(pid)
            changed = true
          }
        }
      }

      // A pid-less launch (shortcut / elevated) becomes "armed" the first time
      // its monitored process is actually seen; the play session starts then.
      if (!entry.armed && entry.pids.size > 0) {
        entry.armed = true
        entry.startedAt = new Date().toISOString()
        changed = true
      }

      if (entry.pids.size === 0) {
        const waiting =
          !entry.armed &&
          entry.monitor.size > 0 &&
          Date.now() - entry.createdAt < MATCH_GRACE_MS
        if (waiting) continue
        this.endEntry(entry, entry.armed)
        changed = true
      }
    }

    if (changed) this.emit()
  }
}
