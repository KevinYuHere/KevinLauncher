import { app } from 'electron'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import type { AppEntry, LinkedLaunch } from '@shared/types'
import { parseJsonLenient, writeFileAtomic } from './atomicFile'
import { BACKUP_DIR_NAME } from './dataBackup'
import { openJsonStore } from './jsonStore'
import { log } from './logger'
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
    updateChannel?: 'stable' | 'beta'
  }
}

const DEFAULT_CONFIG: LauncherConfig = { version: CURRENT_VERSION, apps: [], linkedLaunches: [] }

let cache: LauncherConfig | null = null
/** Set when the config file could not be read — writes are refused for the session. */
let saveBlocked = false
/** In-flight load, so concurrent callers share one read (and one quarantine). */
let loading: Promise<LauncherConfig> | null = null

/** Persisted `config.json` store (apps + UI + global launcher settings). */
export class AppStore {
  static file(): string {
    return join(app.getPath('userData'), 'config.json')
  }

  static async load(): Promise<LauncherConfig> {
    if (cache) return cache
    loading ??= AppStore.readConfig().finally(() => {
      loading = null
    })
    return loading
  }

  private static async readConfig(): Promise<LauncherConfig> {
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
    // A quarantined config holds the apps the 1.2.2 write race moved aside while
    // an empty file took their place: restore them before anything else runs.
    if (writable) await this.restoreQuarantined(data)
    await this.migrate(cache)
    return cache
  }

  /**
   * Restore apps when the live config lost them, trying the quarantined file and
   * then the pre-update backup. Only a *salvageable* source (valid root JSON,
   * e.g. the 1.2.2 trailing junk) with a non-empty app list is used, so an
   * unrelated or truncated file can never resurrect stale data.
   */
  private static async restoreQuarantined(config: LauncherConfig): Promise<void> {
    if (config.apps.length > 0) return
    const sources = [
      `${this.file()}.corrupt`,
      join(dirname(this.file()), BACKUP_DIR_NAME, 'config.json')
    ]
    for (const source of sources) {
      let salvaged: LauncherConfig | undefined
      try {
        salvaged = parseJsonLenient<LauncherConfig>(await fs.readFile(source, 'utf-8'))
      } catch {
        continue
      }
      if (!salvaged || !Array.isArray(salvaged.apps) || salvaged.apps.length === 0) continue
      log(`appStore: restoring ${salvaged.apps.length} app(s) from ${source}`)
      config.apps = salvaged.apps
      if (Array.isArray(salvaged.linkedLaunches)) config.linkedLaunches = salvaged.linkedLaunches
      if (salvaged.ui) config.ui = salvaged.ui
      if (salvaged.launcher) config.launcher = salvaged.launcher
      if (typeof salvaged.version === 'number') config.version = salvaged.version
      await writeFileAtomic(this.file(), JSON.stringify(config, null, 2))
      return
    }
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
    loading = null
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
    updateChannel: 'stable' | 'beta'
  }> {
    const config = await this.load()
    return {
      iconFile: config.launcher?.iconFile ?? null,
      fontFamily: config.launcher?.fontFamily ?? null,
      closeAction: config.launcher?.closeAction ?? 'close',
      afterLaunch: config.launcher?.afterLaunch ?? 'none',
      autoStart: config.launcher?.autoStart ?? 'off',
      sidebarMaterial: config.launcher?.sidebarMaterial ?? true,
      updateChannel: config.launcher?.updateChannel ?? 'stable'
    }
  }

  static async setLauncher(patch: {
    iconFile?: string | null
    fontFamily?: string | null
    closeAction?: 'close' | 'tray'
    afterLaunch?: 'none' | 'minimize' | 'tray' | 'close'
    autoStart?: 'off' | 'window' | 'tray'
    sidebarMaterial?: boolean
    updateChannel?: 'stable' | 'beta'
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
