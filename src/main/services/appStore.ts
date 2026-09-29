import { app } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import type { AppEntry } from '@shared/types'

export interface LauncherConfig {
  version: number
  apps: AppEntry[]
  /** Persisted UI preferences. */
  ui?: {
    gamesRowHidden?: boolean
  }
  /** Launcher-wide (global) appearance + behavior settings. */
  launcher?: {
    iconFile?: string | null
    fontFamily?: string | null
    closeAction?: 'close' | 'tray'
    afterLaunch?: 'none' | 'minimize' | 'tray' | 'close'
  }
}

/** v2: admin. v3: glass tone. v4: bg blur/dim. v5: auto theme. v6: module label. */
const CURRENT_VERSION = 6
const DEFAULT_CONFIG: LauncherConfig = { version: CURRENT_VERSION, apps: [] }

let cache: LauncherConfig | null = null

/** Persisted `config.json` store (apps + UI + global launcher settings). */
export class AppStore {
  static file(): string {
    return join(app.getPath('userData'), 'config.json')
  }

  static async load(): Promise<LauncherConfig> {
    if (cache) return cache
    try {
      const raw = await fs.readFile(this.file(), 'utf-8')
      const parsed = JSON.parse(raw) as LauncherConfig
      parsed.apps = Array.isArray(parsed.apps) ? parsed.apps : []
      parsed.version = parsed.version ?? 1
      cache = parsed
      await this.migrate(cache)
    } catch {
      cache = structuredClone(DEFAULT_CONFIG)
    }
    return cache
  }

  /** Runs version migrations and persists them once. */
  private static async migrate(config: LauncherConfig): Promise<void> {
    if (config.version >= CURRENT_VERSION) return
    if (config.version < 2) {
      // Everything launched through the launcher runs as administrator by
      // default now, so bring existing entries up to date.
      for (const entry of config.apps) entry.runAsAdmin = true
    }
    if (config.version < 3) {
      for (const entry of config.apps) entry.glassStyle = entry.glassStyle ?? 'dark'
    }
    if (config.version < 4) {
      for (const entry of config.apps) {
        entry.backgroundBlur = entry.backgroundBlur ?? 0
        entry.backgroundDim = entry.backgroundDim ?? 25
      }
    }
    if (config.version < 5) {
      for (const entry of config.apps) {
        if (entry.autoTheme === undefined) entry.autoTheme = entry.themeColor == null
        // The old default dimming was 100; the new default is 25.
        if (entry.backgroundDim === 100) entry.backgroundDim = 25
      }
    }
    if (config.version < 6) {
      for (const entry of config.apps) entry.moduleLabel = entry.moduleLabel ?? null
    }
    config.version = CURRENT_VERSION
    await this.save()
  }

  static async save(): Promise<void> {
    if (!cache) return
    await fs.mkdir(app.getPath('userData'), { recursive: true })
    await fs.writeFile(this.file(), JSON.stringify(cache, null, 2), 'utf-8')
  }

  /** Drop the in-memory copy and read from disk again. */
  static async reload(): Promise<void> {
    cache = null
    await this.load()
  }

  static async uiPrefs(): Promise<{ gamesRowHidden: boolean }> {
    const config = await this.load()
    return { gamesRowHidden: !!config.ui?.gamesRowHidden }
  }

  static async launcherSettings(): Promise<{
    iconFile: string | null
    fontFamily: string | null
    closeAction: 'close' | 'tray'
    afterLaunch: 'none' | 'minimize' | 'tray' | 'close'
  }> {
    const config = await this.load()
    return {
      iconFile: config.launcher?.iconFile ?? null,
      fontFamily: config.launcher?.fontFamily ?? null,
      closeAction: config.launcher?.closeAction ?? 'close',
      afterLaunch: config.launcher?.afterLaunch ?? 'none'
    }
  }

  static async setLauncher(patch: {
    iconFile?: string | null
    fontFamily?: string | null
    closeAction?: 'close' | 'tray'
    afterLaunch?: 'none' | 'minimize' | 'tray' | 'close'
  }): Promise<void> {
    const config = await this.load()
    config.launcher = { ...config.launcher, ...patch }
    await this.save()
  }

  static async setGamesRowHidden(hidden: boolean): Promise<void> {
    const config = await this.load()
    config.ui = { ...config.ui, gamesRowHidden: hidden }
    await this.save()
  }

  /** Reorders apps to match the given id order (unknown ids keep their tail position). */
  static async reorder(ids: string[]): Promise<AppEntry[]> {
    const config = await this.load()
    const byId = new Map(config.apps.map((entry) => [entry.id, entry]))
    const ordered: AppEntry[] = []
    for (const id of ids) {
      const entry = byId.get(id)
      if (entry) {
        ordered.push(entry)
        byId.delete(id)
      }
    }
    for (const entry of byId.values()) ordered.push(entry)
    config.apps = ordered
    await this.save()
    return config.apps
  }
}
