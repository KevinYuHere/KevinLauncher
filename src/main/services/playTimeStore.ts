import { app } from 'electron'
import { join } from 'path'
import type { PlayTimeTotals } from '@shared/types'
import { writeFileAtomic } from './atomicFile'
import { openJsonStore } from './jsonStore'
import { log } from './logger'
import { calculatePlayTime } from './playTimeStats'

export interface PlaySessionRecord {
  appId: string
  startUtc: string
  endUtc: string
  durationSec: number
}

interface StoreShape {
  version: number
  sessions: PlaySessionRecord[]
}

const CURRENT_VERSION = 1
let singleton: PlayTimeStore | null = null

function sessionKey(record: PlaySessionRecord): string {
  return JSON.stringify([record.appId, record.startUtc, record.endUtc])
}

/**
 * Persists play sessions to `%userData%/playtime.json` (debounced, atomic
 * write). Kept dependency-free on purpose; can be swapped for SQLite later
 * without touching callers.
 */
export class PlayTimeStore {
  private sessions: PlaySessionRecord[] = []
  private seen = new Set<string>()
  private loaded = false
  private loading: Promise<void> | undefined
  private revision = 0
  private persisted = 0
  private saveTimer: NodeJS.Timeout | null = null
  private saving: Promise<void> | undefined
  /** Set when the store file could not be read — writes are refused. */
  private saveBlocked = false

  static instance(): PlayTimeStore {
    if (!singleton) singleton = new PlayTimeStore()
    return singleton
  }

  private file(): string {
    return join(app.getPath('userData'), 'playtime.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loading ??= this.read().finally(() => { this.loading = undefined })
    await this.loading
  }

  private async read(): Promise<void> {
    const { data, writable } = await openJsonStore<StoreShape>(
      this.file(),
      () => ({ version: CURRENT_VERSION, sessions: [] }),
      'playTime'
    )
    this.sessions = Array.isArray(data?.sessions) ? data.sessions : []
    this.seen = new Set(this.sessions.map(sessionKey))
    this.saveBlocked = !writable
    this.loaded = true
  }

  async addSession(record: PlaySessionRecord): Promise<void> {
    await this.load()
    if (!Number.isFinite(record.durationSec) || record.durationSec < 1 || this.seen.has(sessionKey(record))) return
    this.seen.add(sessionKey(record))
    this.sessions.push({ ...record })
    this.revision += 1
    this.scheduleSave()
  }

  /** Drop everything and read from disk again. */
  async reload(): Promise<void> {
    await this.loading
    await this.flush()
    this.loaded = false
    this.sessions = []
    this.seen.clear()
    await this.load()
  }

  /** Persist any pending change immediately (used on shutdown). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    do {
      await this.save()
    } while (this.revision !== this.persisted)
  }

  totalForApp(appId: string): number {
    let total = 0
    for (const session of this.sessions) {
      if (session.appId === appId) total += session.durationSec
    }
    return total
  }

  totalsMap(): Record<string, number> {
    const map: Record<string, number> = Object.create(null)
    for (const session of this.sessions) {
      map[session.appId] = (map[session.appId] ?? 0) + session.durationSec
    }
    return map
  }

  summary(appId: string, days = 14): PlayTimeTotals {
    return calculatePlayTime(this.sessions, appId, days)
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flush().catch((error) => log(`playTime: could not save sessions (${String(error)})`))
    }, 1000)
  }

  private async save(): Promise<void> {
    if (this.saving) return this.saving
    if (this.revision === this.persisted) return
    if (this.saveBlocked) throw new Error('无法读取现有使用时长，已保留原文件')
    const revision = this.revision
    const data: StoreShape = { version: CURRENT_VERSION, sessions: this.sessions }
    this.saving = writeFileAtomic(this.file(), JSON.stringify(data)).then(() => {
      this.persisted = revision
    }).finally(() => { this.saving = undefined })
    return this.saving
  }
}
