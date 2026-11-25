import type { RunningApp, StopResult } from '@shared/types'
import { observeLaunch, type LaunchObservation, type ProcessLineage } from './processObservation'
import { ProcessTree, type ProcessIdentity } from './processTree'
import { ProcessScanner } from './processScanner'
import type { PlaySessionRecord } from './playTimeStore'
import { log } from './logger'

interface TrackedEntry extends ProcessLineage {
  appId: string
  elevated: boolean
  startedAt: string
  settledAt: string
  elapsedSec: number
  resumePending: boolean
  processes: Map<number, ProcessIdentity>
  armed: boolean
  recordSession: boolean
}

const POLL_INTERVAL_MS = 4_000
const MATCH_GRACE_MS = 5 * 60_000

/** Tracks one launch session per application using time- and path-checked processes. */
export class Runtime {
  private readonly running = new Map<string, TrackedEntry>()
  private readonly launching = new Set<string>()
  private readonly stops = new Map<string, Promise<StopResult>>()
  private timer: NodeJS.Timeout | undefined
  private scan: Promise<boolean> | undefined
  private disposed = false
  private pollingPauses = 0
  private observationGeneration = 0
  private suspended = false
  private readonly listeners = new Set<() => void>()
  private sessionListener: ((record: PlaySessionRecord) => void) | null = null

  constructor(
    private readonly scanner: Pick<ProcessScanner, 'snapshot' | 'dispose'> = new ProcessScanner(),
    private readonly terminate = ProcessTree.stop
  ) {}

  onChanged(callback: () => void): () => void {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  onSessionEnded(callback: (record: PlaySessionRecord) => void): void {
    this.sessionListener = callback
  }

  reserveLaunch(appId: string): (() => void) | null {
    if (this.disposed || this.launching.has(appId) || this.running.has(appId)) return null
    this.launching.add(appId)
    return () => { this.launching.delete(appId) }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private endEntry(entry: TrackedEntry): void {
    this.running.delete(entry.appId)
    const segment = this.settleSession(entry, Date.now())
    if (segment) this.sessionListener?.(segment)
  }

  private settleSession(entry: TrackedEntry, end: number): PlaySessionRecord | null {
    if (!entry.armed || !entry.recordSession || entry.resumePending) return null
    const start = Date.parse(entry.settledAt)
    const durationSec = Math.floor((end - start) / 1000)
    if (durationSec <= 0) return null
    const startUtc = entry.settledAt
    const endUtc = new Date(start + durationSec * 1000).toISOString()
    entry.settledAt = endUtc
    entry.elapsedSec += durationSec
    return { appId: entry.appId, startUtc, endUtc, durationSec }
  }

  start(
    appId: string,
    rootPid: number | null,
    elevated: boolean,
    monitorNames: string[],
    recordSession = true,
    intent: LaunchObservation = { requestedAt: Date.now() }
  ): void {
    if (this.disposed || this.running.has(appId)) return
    if (rootPid === null && !intent.targetExecutable && !(intent.monitorDirectory && monitorNames.length)) return
    const startedAt = new Date(intent.spawnedAt ?? Date.now()).toISOString()
    this.running.set(appId, {
      appId, rootPid, elevated, intent, startedAt, settledAt: startedAt, elapsedSec: 0, resumePending: false,
      processes: new Map(), seen: new Map(), inspected: false,
      monitor: new Set(monitorNames.map((name) => name.toLowerCase()).filter(Boolean)),
      armed: false,
      recordSession
    })
    this.timer ??= setInterval(() => { void this.tick() }, POLL_INTERVAL_MS)
    if (intent.rootExecutable || intent.targetExecutable) void this.tick()
    this.emit()
  }

  stop(appId: string): Promise<StopResult> {
    const active = this.stops.get(appId)
    if (active) return active
    const stop = this.stopTracked(appId).finally(() => this.stops.delete(appId))
    this.stops.set(appId, stop)
    return stop
  }

  private async stopTracked(appId: string): Promise<StopResult> {
    const entry = this.running.get(appId)
    if (!entry) return { ok: true, killed: 0 }
    await this.tick()
    if (!this.running.has(appId)) return { ok: true, killed: 0 }
    const targets = [...entry.processes.values()]
    if (targets.length === 0) return { ok: false, killed: 0, error: '尚未确认可停止的进程' }
    let killed = 0
    let failed = 0
    for (const process of targets) {
      const outcome = await this.terminate(process).catch(() => 'failed' as const)
      if (outcome === 'failed') failed++
      else {
        if (outcome === 'stopped') killed++
        entry.processes.delete(process.pid)
      }
    }
    // A descendant may have appeared while stopping its parent.
    const refreshed = await this.tick()
    const remaining = this.running.get(appId)?.processes.size ?? 0
    if (failed || remaining || !refreshed) {
      log(`runtime: stop ${appId} left ${remaining} observed process(es), ${failed} failed`)
      this.emit()
      return { ok: false, killed, remaining, error: '部分进程无法确认已退出，可以重试' }
    }
    if (this.running.get(appId) === entry) this.endEntry(entry)
    this.emit()
    return { ok: true, killed }
  }

  isRunning(appId: string): boolean {
    return this.running.has(appId) || this.launching.has(appId)
  }

  list(): RunningApp[] {
    return [...this.running.values()].map((entry) => ({
      appId: entry.appId, rootPid: entry.rootPid, elevated: entry.elevated, startedAt: entry.startedAt,
      pids: [...entry.processes.keys()], confirmed: entry.processes.size > 0,
      elapsedSec: entry.elapsedSec, activeSince: entry.armed && !entry.resumePending ? entry.settledAt : undefined
    }))
  }

  checkpointSessions(end = Date.now()): PlaySessionRecord[] {
    const records: PlaySessionRecord[] = []
    for (const entry of this.running.values()) {
      const segment = this.settleSession(entry, end)
      if (segment) records.push(segment)
    }
    return records
  }

  suspendSessions(end = Date.now()): PlaySessionRecord[] {
    if (this.suspended) return []
    const records = this.checkpointSessions(end)
    this.suspended = true
    this.observationGeneration += 1
    for (const entry of this.running.values()) entry.resumePending = true
    if (this.running.size) this.emit()
    return records
  }

  resumeObservations(): void {
    if (!this.suspended) return
    this.suspended = false
    void this.tick()
  }

  endAll(): PlaySessionRecord[] {
    const records = this.checkpointSessions()
    this.running.clear()
    return records
  }

  /** A complete restore may remove apps while their actual processes keep running. */
  retainConfigured(keys: ReadonlySet<string>): void {
    let changed = false
    for (const appId of this.running.keys()) {
      if (!keys.has(appId)) changed = this.running.delete(appId) || changed
    }
    if (changed) this.emit()
  }

  pausePolling(): () => void {
    this.pollingPauses += 1
    this.observationGeneration += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.pollingPauses -= 1
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.observationGeneration += 1
    clearInterval(this.timer)
    this.timer = undefined
    await this.scanner.dispose()
    await this.scan
    this.listeners.clear()
    this.sessionListener = null
  }

  private tick(): Promise<boolean> {
    if (this.disposed || this.pollingPauses || this.suspended) return Promise.resolve(false)
    if (this.running.size === 0) {
      clearInterval(this.timer)
      this.timer = undefined
      return Promise.resolve(true)
    }
    this.scan ??= this.observe(this.observationGeneration).finally(() => { this.scan = undefined })
    return this.scan
  }

  private async observe(generation: number): Promise<boolean> {
    const tracked = [...this.running.values()]
    const snapshot = await this.scanner.snapshot().catch(() => null)
    if (!snapshot || generation !== this.observationGeneration || this.disposed) return false
    const now = Date.now()
    const owners = new Map<number, string>()
    for (const entry of this.running.values()) {
      for (const pid of entry.processes.keys()) owners.set(pid, entry.appId)
    }
    let updated = false
    for (const entry of tracked) {
      if (this.running.get(entry.appId) !== entry) continue
      const previous = entry.processes
      const active = observeLaunch(entry, snapshot, ({ pid }) => !owners.has(pid) || owners.get(pid) === entry.appId, now)
      entry.processes = active
      for (const pid of active.keys()) owners.set(pid, entry.appId)
      if (active.size) {
        if (!entry.armed || entry.resumePending) {
          const directRoot = !entry.armed && !entry.resumePending && !entry.intent.indirect && entry.rootPid !== null
            ? active.get(entry.rootPid) : undefined
          const timestamp = new Date(directRoot ? Math.max(entry.intent.requestedAt, directRoot.createdAt) : now).toISOString()
          if (!entry.armed) entry.startedAt = timestamp
          entry.settledAt = timestamp
          entry.armed = true
          entry.resumePending = false
          updated = true
        }
        if (active.size !== previous.size || [...active.keys()].some((pid) => !previous.has(pid))) updated = true
        continue
      }
      if (!entry.seen.size && now - entry.intent.requestedAt < MATCH_GRACE_MS) continue
      this.endEntry(entry)
      updated = true
    }
    if (updated) this.emit()
    return true
  }
}
