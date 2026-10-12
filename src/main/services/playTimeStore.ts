import { app } from 'electron'
import { join } from 'path'
import type { PlayTimeDay, PlayTimeTotals } from '@shared/types'
import { writeFileAtomic } from './atomicFile'
import { openJsonStore } from './jsonStore'

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
const DAY_MS = 24 * 60 * 60 * 1000

let singleton: PlayTimeStore | null = null

function localDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Persists play sessions to `%userData%/playtime.json` (debounced, atomic
 * write). Kept dependency-free on purpose; can be swapped for SQLite later
 * without touching callers.
 */
export class PlayTimeStore {
  private sessions: PlaySessionRecord[] = []
  private loaded = false
  private saveTimer: NodeJS.Timeout | null = null
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
    const { data, writable } = await openJsonStore<StoreShape>(
      this.file(),
      () => ({ version: CURRENT_VERSION, sessions: [] }),
      'playTime'
    )
    this.sessions = Array.isArray(data.sessions) ? data.sessions : []
    this.saveBlocked = !writable
    this.loaded = true
  }

  async addSession(record: PlaySessionRecord): Promise<void> {
    await this.load()
    if (record.durationSec < 1) return
    this.sessions.push(record)
    this.scheduleSave()
  }

  /** Drop everything and read from disk again. */
  async reload(): Promise<void> {
    this.loaded = false
    this.sessions = []
    await this.load()
  }

  /** Persist any pending change immediately (used on shutdown). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await this.save()
  }

  totalForApp(appId: string): number {
    let total = 0
    for (const session of this.sessions) {
      if (session.appId === appId) total += session.durationSec
    }
    return total
  }

  totalsMap(): Record<string, number> {
    const map: Record<string, number> = {}
    for (const session of this.sessions) {
      map[session.appId] = (map[session.appId] ?? 0) + session.durationSec
    }
    return map
  }

  summary(appId: string, days = 14): PlayTimeTotals {
    const now = Date.now()
    const todayKey = localDateKey(new Date(now))
    const weekStart = now - 6 * DAY_MS
    const monthStart = now - 29 * DAY_MS

    const dailyMap = new Map<string, number>()
    for (let i = days - 1; i >= 0; i--) {
      dailyMap.set(localDateKey(new Date(now - i * DAY_MS)), 0)
    }

    let totalSec = 0
    let todaySec = 0
    let weekSec = 0
    let monthSec = 0

    for (const session of this.sessions) {
      if (session.appId !== appId) continue
      totalSec += session.durationSec
      const startMs = new Date(session.startUtc).getTime()
      if (startMs >= weekStart) weekSec += session.durationSec
      if (startMs >= monthStart) monthSec += session.durationSec
      const key = localDateKey(new Date(session.startUtc))
      if (key === todayKey) todaySec += session.durationSec
      if (dailyMap.has(key)) dailyMap.set(key, (dailyMap.get(key) ?? 0) + session.durationSec)
    }

    const daily: PlayTimeDay[] = [...dailyMap.entries()].map(([date, sec]) => ({ date, sec }))
    return { totalSec, todaySec, weekSec, monthSec, daily }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.save()
    }, 1000)
  }

  private async save(): Promise<void> {
    if (this.saveBlocked) return
    const data: StoreShape = { version: CURRENT_VERSION, sessions: this.sessions }
    await writeFileAtomic(this.file(), JSON.stringify(data)).catch(() => undefined)
  }
}
