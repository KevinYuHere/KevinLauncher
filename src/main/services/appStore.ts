import { app } from 'electron'
import { join } from 'path'
import type { AppEntry, LinkedLaunch } from '@shared/types'
import { writeFileAtomic } from './atomicFile'
import { openJsonStore } from './jsonStore'
import { CURRENT_VERSION, migrateConfig } from './appMigrations'

export interface LauncherConfig {
  version: number
  apps: AppEntry[]
  /** Launcher-wide linked launches (one file starts several apps). */
  linkedLaunches?: LinkedLaunch[]
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
    autoStart?: 'off' | 'window' | 'tray'
    sidebarMaterial?: boolean
  }
}

const DEFAULT_CONFIG: LauncherConfig = { version: CURRENT_VERSION, apps: [], linkedLaunches: [] }

let cache: LauncherConfig | null = null
/** Set when the config file could not be read — writes are refused for the session. */
let saveBlocked = false

/** Persisted `config.json` store (apps + UI + global launcher settings). */
export class AppStore {
  static file(): string {
    return join(app.getPath('userData'), 'config.json')
  }

  static async load(): Promise<LauncherConfig> {
    if (cache) return cache
    const { data, writable } = await openJsonStore<LauncherConfig>(
      this.file(),
      () => structuredClone(DEFAULT_CONFIG),
      'appStore'
    )
    data.apps = Array.isArray(data.apps) ? data.apps : []
    data.linkedLaunches = Array.isArray(data.linkedLaunches) ? data.linkedLaunches : []
    data.version = data.version ?? 1
    cache = data
    saveBlocked = !writable
    await this.migrate(cache)
    return cache
  }

  /** Runs version migrations and persists them once. */
  private static async migrate(config: LauncherConfig): Promise<void> {
    if (migrateConfig(config)) await this.save()
  }

  static async save(): Promise<void> {
    if (!cache || saveBlocked) return
    await writeFileAtomic(this.file(), JSON.stringify(cache, null, 2))
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
    autoStart: 'off' | 'window' | 'tray'
    sidebarMaterial: boolean
  }> {
    const config = await this.load()
    return {
      iconFile: config.launcher?.iconFile ?? null,
      fontFamily: config.launcher?.fontFamily ?? null,
      closeAction: config.launcher?.closeAction ?? 'close',
      afterLaunch: config.launcher?.afterLaunch ?? 'none',
      autoStart: config.launcher?.autoStart ?? 'off',
      sidebarMaterial: config.launcher?.sidebarMaterial ?? true
    }
  }

  static async setLauncher(patch: {
    iconFile?: string | null
    fontFamily?: string | null
    closeAction?: 'close' | 'tray'
    afterLaunch?: 'none' | 'minimize' | 'tray' | 'close'
    autoStart?: 'off' | 'window' | 'tray'
    sidebarMaterial?: boolean
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

  /** Launcher-wide linked launches (global order preserved). */
  static async linkedLaunches(): Promise<LinkedLaunch[]> {
    const config = await this.load()
    return config.linkedLaunches ?? []
  }

  static async setLinkedLaunches(list: LinkedLaunch[]): Promise<void> {
    const config = await this.load()
    config.linkedLaunches = list
    await this.save()
  }

  /** Reorders linked launches to match the given id order. */
  static async reorderLinkedLaunches(ids: string[]): Promise<LinkedLaunch[]> {
    const config = await this.load()
    const byId = new Map((config.linkedLaunches ?? []).map((entry) => [entry.id, entry]))
    const ordered: LinkedLaunch[] = []
    for (const id of ids) {
      const entry = byId.get(id)
      if (entry) {
        ordered.push(entry)
        byId.delete(id)
      }
    }
    for (const entry of byId.values()) ordered.push(entry)
    config.linkedLaunches = ordered
    await this.save()
    return ordered
  }
}
