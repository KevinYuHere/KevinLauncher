import { app } from 'electron'
import { join } from 'path'
import { DEFAULT_GLASS_APPEARANCE, type AppEntry, type GlassAppearance } from '@shared/types'
import { writeFileAtomic } from './atomicFile'
import { openJsonStore } from './jsonStore'

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
    autoStart?: 'off' | 'window' | 'tray'
    sidebarMaterial?: boolean
  }
}

/**
 * v2: admin. v3: glass tone. v4: bg blur/dim. v5: auto theme. v6: module label.
 * v7: glass tone → glass appearance { color, material, blur }.
 * v9: glass `color` → `brightness`; per-app gacha option; sidebar material toggle.
 * v10: glass gains `opacity` + per-material params (saturation/grain/refraction/
 *      edgeWidth/highlight/highlightAngle/dispersion).
 * v11: glass gains `panelRefraction`; per-app home-module state.
 */
const CURRENT_VERSION = 12
const DEFAULT_CONFIG: LauncherConfig = { version: CURRENT_VERSION, apps: [] }

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
    data.version = data.version ?? 1
    cache = data
    saveBlocked = !writable
    await this.migrate(cache)
    return cache
  }

  /** Runs version migrations and persists them once. */
  private static async migrate(config: LauncherConfig): Promise<void> {
    if (config.version >= CURRENT_VERSION) return
    const { version } = config
    for (const entry of config.apps) {
      // The pre-v7 binary tone, read only while upgrading an old config.
      const legacy = entry as AppEntry & { glassStyle?: 'dark' | 'light' }
      // v2: everything launched through the launcher runs as administrator now.
      if (version < 2) entry.runAsAdmin = true
      if (version < 3) legacy.glassStyle ??= 'dark'
      if (version < 4) {
        entry.backgroundBlur ??= 0
        entry.backgroundDim ??= 25
      }
      if (version < 5) {
        entry.autoTheme ??= entry.themeColor == null
        // The old default dimming was 100; the new default is 25.
        if (entry.backgroundDim === 100) entry.backgroundDim = 25
      }
      if (version < 6) entry.moduleLabel ??= null
      if (version < 7) {
        // Binary dark/light becomes a brightness (0 dark … 100 light) plus a
        // material (毛玻璃 by default) and its own blur radius.
        entry.glass = {
          ...DEFAULT_GLASS_APPEARANCE,
          brightness: legacy.glassStyle === 'light' ? 100 : 0
        }
        delete legacy.glassStyle
      }
      if (version < 9) {
        // `color` was a misleading name for the brightness; the earlier
        // distortion/edge/highlight fields were dropped.
        const glass = entry.glass as (Partial<GlassAppearance> & { color?: number }) | undefined
        entry.glass = {
          ...DEFAULT_GLASS_APPEARANCE,
          brightness: glass?.brightness ?? glass?.color ?? 0,
          material: glass?.material ?? 'blur',
          blur: glass?.blur ?? 18
        }
        entry.gachaShowSecond ??= true
      }
      if (version < 10) {
        // Fill the new opacity + per-material fields (keep existing values).
        entry.glass = { ...DEFAULT_GLASS_APPEARANCE, ...entry.glass }
      }
      if (version < 11) {
        // panelRefraction + home-module state.
        entry.glass = { ...DEFAULT_GLASS_APPEARANCE, ...entry.glass }
        entry.homeModules = entry.homeModules ?? {}
      }
      if (version < 12) entry.launchEffect ??= 'none'
    }
    if (version < 9) {
      config.launcher = { ...config.launcher, sidebarMaterial: config.launcher?.sidebarMaterial ?? true }
    }
    config.version = CURRENT_VERSION
    await this.save()
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
}
