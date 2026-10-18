import { randomUUID } from 'crypto'
import {
  DEFAULT_GLASS_APPEARANCE,
  DEFAULT_WALLPAPER_SETTINGS,
  type AppEntry,
  type GlassAppearance,
  type LauncherSettings,
  type LinkedLaunch,
  type UiPrefs
} from '@shared/types'

/**
 * Config migrations. Kept **pure** (no electron / fs) so every upgrade step is
 * unit-testable: `migrateConfig` mutates the given object in place and returns
 * whether anything changed.
 *
 * v2  admin. v3 glass tone. v4 bg blur/dim. v5 auto theme. v6 module label.
 * v7  glass tone → glass appearance.
 * v9  glass `color` → `brightness`; per-app gacha option; sidebar toggle.
 * v10 glass `opacity` + per-material params.
 * v11 glass `panelRefraction`; per-app home-module state.
 * v12 per-app launch effect.
 * v13 launch methods (multiple), wallpaper lists, linked launches.
 * v14 per-method `runAsAdmin` (moved off the app).
 */
export const CURRENT_VERSION = 14

/** The parts of `config.json` migrations touch. */
export interface MigratableConfig {
  version: number
  apps: AppEntry[]
  ui?: Partial<UiPrefs>
  launcher?: Partial<LauncherSettings>
  linkedLaunches?: LinkedLaunch[]
}

/** Fields the pre-v13 config carried directly on an app. */
type LegacyApp = AppEntry & {
  glassStyle?: 'dark' | 'light'
  color?: number
  targetPath?: string
  arguments?: string
  workingDirectory?: string
  backgroundFile?: string | null
  runAsAdmin?: boolean
}

/** Runs every upgrade step up to `CURRENT_VERSION`; returns true if changed. */
export function migrateConfig(config: MigratableConfig): boolean {
  if (config.version >= CURRENT_VERSION) return false
  const version = config.version

  for (const app of config.apps) {
    const entry = app as LegacyApp

    // v2: everything launched through the launcher runs as administrator now.
    if (version < 2) entry.runAsAdmin = true
    if (version < 3) entry.glassStyle ??= 'dark'
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
        brightness: entry.glassStyle === 'light' ? 100 : 0
      }
      delete entry.glassStyle
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

    if (version < 13) {
      // A single target/args/workdir becomes the default launch method.
      const methodId = randomUUID()
      entry.launchMethods = [
        {
          id: methodId,
          name: '默认',
          targetPath: entry.targetPath ?? '',
          arguments: entry.arguments ?? '',
          workingDirectory: entry.workingDirectory ?? '',
          runAsAdmin: true
        }
      ]
      entry.defaultLaunchMethodId = methodId
      delete entry.targetPath
      delete entry.arguments
      delete entry.workingDirectory

      // A single background becomes a one-item wallpaper list.
      const background = entry.backgroundFile
      entry.wallpapers = background
        ? [{ id: randomUUID(), file: background, name: background }]
        : []
      entry.wallpaperSettings = { ...DEFAULT_WALLPAPER_SETTINGS }
      entry.wallpaperIndex = 0
      delete entry.backgroundFile

      // No linked launches associated yet.
      entry.linkedLaunchIds = []
      entry.defaultLinkedLaunchId = null
    }

    if (version < 14) {
      // runAsAdmin moves from the app to each launch method.
      const legacyAdmin = (entry as LegacyApp).runAsAdmin ?? true
      if (Array.isArray(entry.launchMethods)) {
        for (const method of entry.launchMethods) method.runAsAdmin = legacyAdmin
      }
      delete (entry as LegacyApp).runAsAdmin
    }
  }

  if (version < 9) {
    config.launcher = { ...config.launcher, sidebarMaterial: config.launcher?.sidebarMaterial ?? true }
  }
  if (version < 13) config.linkedLaunches = config.linkedLaunches ?? []
  config.version = CURRENT_VERSION
  return true
}
