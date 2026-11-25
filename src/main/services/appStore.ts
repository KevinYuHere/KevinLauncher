import { app } from 'electron'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import type { AppEntry, AppSettingsPatch, LauncherSettings, LinkedLaunch, ThemePolicy } from '@shared/types'
import { APP_SETTINGS_FIELDS, LAUNCHER_BEHAVIOR_FIELDS } from '@shared/types'
import { currentWallpaper } from '@shared/appEntry'
import { DataError } from '@shared/dataErrors'
import { applyAppThemePolicy, applyThemePolicy, isSpecialAreaId, isSpecialThemeId } from '@shared/specialTheme'
import { parseJsonLenient, writeFileAtomic } from './atomicFile'
import { BACKUP_DIR_NAME, PREVIOUS_BACKUP_DIR_NAME } from './dataDir'
import { ConfigValidationError, normalizeLauncherConfig, validateLauncherConfig, type LauncherConfig } from './configValidation'
import { collectOrphanMedia, collectReplacedMedia } from './mediaFiles'
import { openJsonStore } from './jsonStore'
import { configureRateLimit } from './rateLimit'
import { log } from './logger'
import { CURRENT_VERSION } from './appMigrations'

export type { LauncherConfig } from './configValidation'

const DEFAULT_CONFIG: LauncherConfig = { version: CURRENT_VERSION, apps: [], linkedLaunches: [] }
let queue = Promise.resolve()
let state: { file: string; config: LauncherConfig } | undefined

function enqueue<T>(action: (file: string) => Promise<T>): Promise<T> {
  const file = AppStore.file()
  const task = queue.then(() => {
    if (AppStore.file() !== file) throw new DataError('DATA_MOVED', '数据目录已切换')
    return action(file)
  })
  queue = task.then(() => undefined, () => undefined)
  return task
}

async function writeConfig(file: string, config: LauncherConfig): Promise<void> {
  validateLauncherConfig(config)
  if (AppStore.file() !== file) throw new DataError('DATA_MOVED', '数据目录已切换')
  try {
    await writeFileAtomic(file, JSON.stringify(config, null, 2))
  } catch (error) {
    throw new DataError('SAVE_FAILED', '保存启动器配置失败', error)
  }
}

async function restoreConfig(file: string): Promise<LauncherConfig | undefined> {
  const sources = [
    `${file}.corrupt`,
    join(dirname(file), BACKUP_DIR_NAME, 'config.json'),
    join(dirname(file), PREVIOUS_BACKUP_DIR_NAME, 'config.json')
  ]
  for (const source of sources) {
    let config: LauncherConfig
    try {
      config = normalizeLauncherConfig(parseJsonLenient(await fs.readFile(source, 'utf8')))
    } catch {
      continue
    }
    if (!config.apps.length) continue
    log(`appStore: restoring ${config.apps.length} app(s) from ${source}`)
    return config
  }
  return undefined
}

async function readConfig(file: string): Promise<LauncherConfig> {
  if (state?.file === file) return state.config
  const result = await openJsonStore<unknown>(file, () => structuredClone(DEFAULT_CONFIG), 'appStore')
  if (!result.writable) throw new DataError('READ_FAILED', '启动器配置读取失败，已暂停写入', result.error)
  let config: LauncherConfig
  if (result.status === 'ok') {
    config = normalizeLauncherConfig(result.data)
  } else {
    const restored = await restoreConfig(file)
    if (restored) {
      config = restored
    } else {
      const hasQuarantine = await fs.lstat(`${file}.corrupt`).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return false
      })
      if (hasQuarantine) throw new ConfigValidationError('INVALID_CONFIG', '启动器配置损坏，已保留原文件')
      config = normalizeLauncherConfig(result.data)
    }
  }
  if (result.status !== 'ok' || (result.data as LauncherConfig).version !== CURRENT_VERSION ||
      (result.data as LauncherConfig).launcher?.updateChannel === 'beta') {
    await writeConfig(file, config)
  }
  state = { file, config }
  configureRateLimit(config.launcher?.downloadLimitMbps ?? 0)
  if (result.status === 'ok') await collectOrphanMedia(dirname(file), config)
  return config
}

export function requireApp(config: LauncherConfig, appId: string): AppEntry {
  const entry = config.apps.find(({ id }) => id === appId)
  if (!entry) throw new DataError('NOT_FOUND', '应用不存在')
  return entry
}

export function reorderById<T extends { id: string }>(entries: T[], ids: string[]): T[] {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw new Error('排序格式无效')
  const remaining = new Map(entries.map((entry) => [entry.id, entry]))
  const ordered: T[] = []
  for (const id of ids) {
    const entry = remaining.get(id)
    if (!entry) continue
    ordered.push(entry)
    remaining.delete(id)
  }
  return [...ordered, ...remaining.values()]
}

/** Authoritative persisted application settings. Readers always receive snapshots. */
export class AppStore {
  static file(): string {
    return join(app.getPath('userData'), 'config.json')
  }

  static load(): Promise<LauncherConfig> {
    return enqueue(async (file) => structuredClone(await readConfig(file)))
  }

  static reload(): Promise<void> {
    return enqueue(async (file) => {
      state = undefined
      await readConfig(file)
    })
  }

  /** A previous launcher ICO may still be referenced until the shell accepts the current icon. */
  static synchronizeLauncherIcon(apply: (iconFile: string | null) => Promise<void>): Promise<void> {
    return enqueue(async (file) => {
      const current = await readConfig(file)
      await apply(current.launcher?.iconFile ?? null)
      await collectOrphanMedia(dirname(file), current, ['brand'])
    })
  }

  static mutate<T>(
    change: (draft: LauncherConfig) => T | Promise<T>,
    afterCommit?: () => void | Promise<void>
  ): Promise<T> {
    return enqueue(async (file) => {
      const previous = await readConfig(file)
      const draft = structuredClone(previous)
      let result: T
      try {
        result = await change(draft)
        if (JSON.stringify(previous) === JSON.stringify(draft)) return structuredClone(result)
        await writeConfig(file, draft)
      } catch (error) {
        await collectReplacedMedia(dirname(file), draft, previous)
        throw error
      }
      state = { file, config: draft }
      configureRateLimit(draft.launcher?.downloadLimitMbps ?? 0)
      await afterCommit?.()
      await collectReplacedMedia(dirname(file), previous, draft)
      return structuredClone(result)
    })
  }

  static mutateApp(appId: string, change: (entry: AppEntry) => void | Promise<void>): Promise<AppEntry> {
    return this.mutate(async (draft) => {
      const entry = requireApp(draft, appId)
      await change(entry)
      entry.updatedAt = new Date().toISOString()
      return entry
    })
  }

  static patchApp(appId: string, patch: AppSettingsPatch): Promise<AppEntry> {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
        Object.keys(patch).some((key) => !(APP_SETTINGS_FIELDS as readonly string[]).includes(key))) {
      throw new Error('应用设置字段无效')
    }
    return this.mutateApp(appId, (entry) => { Object.assign(entry, patch) })
  }

  static async uiPrefs(): Promise<{ gamesRowHidden: boolean }> {
    const config = await this.load()
    return { gamesRowHidden: !!config.ui?.gamesRowHidden }
  }

  static async launcherSettings(): Promise<LauncherSettings> {
    return launcherSettings((await this.load()).launcher)
  }

  static setLauncher(patch: Partial<Omit<LauncherSettings, 'themeLocks' | 'themePolicyVersion'>>): Promise<void> {
    const allowed: readonly string[] = [...LAUNCHER_BEHAVIOR_FIELDS, 'iconFile', 'fontFamily']
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
        Object.keys(patch).some((key) => !allowed.includes(key))) {
      throw new ConfigValidationError('INVALID_CONFIG', '启动器设置字段无效')
    }
    return this.mutate((config) => {
      const next = { ...config.launcher, ...patch, updateChannel: 'stable' as const }
      if (patch.themeAreas) {
        next.themeAreas = Object.fromEntries(
          Object.entries(patch.themeAreas).filter(([area, theme]) => isSpecialAreaId(area) && isSpecialThemeId(theme))
        )
        next.themeLocks = {}
      }
      config.launcher = next
    })
  }

  /** Commit per-app effects, assignments and the one-time marker together. */
  static applyReleasePolicy(policy: ThemePolicy): Promise<boolean> {
    return this.mutate((config) => {
      if (config.launcher?.themePolicyVersion === policy.version) return false
      const settings = launcherSettings(config.launcher)
      const { assignments } = applyThemePolicy(settings.themeAreas, settings.themeLocks, policy)
      config.apps = config.apps.map((entry) => applyAppThemePolicy(entry, policy).app)
      config.launcher = {
        ...config.launcher, themeAreas: assignments, themeLocks: {}, themePolicyVersion: policy.version
      }
      return true
    })
  }

  static setGamesRowHidden(hidden: boolean): Promise<void> {
    return this.mutate((config) => { config.ui = { ...config.ui, gamesRowHidden: hidden } })
  }

  static reorder(ids: string[]): Promise<AppEntry[]> {
    return this.mutate((config) => config.apps = reorderById(config.apps, ids))
  }

  static reorderWallpapers(appId: string, ids: string[]): Promise<AppEntry> {
    return this.mutateApp(appId, (entry) => {
      const currentId = currentWallpaper(entry)?.id
      entry.wallpapers = reorderById(entry.wallpapers, ids)
      entry.wallpaperIndex = Math.max(0, entry.wallpapers.findIndex((wallpaper) => wallpaper.id === currentId))
    })
  }

  static async linkedLaunches(): Promise<LinkedLaunch[]> {
    return (await this.load()).linkedLaunches ?? []
  }

  static reorderLinkedLaunches(ids: string[]): Promise<LinkedLaunch[]> {
    return this.mutate((config) => config.linkedLaunches = reorderById(config.linkedLaunches ?? [], ids))
  }
}

function launcherSettings(settings: LauncherConfig['launcher']): LauncherSettings {
  return {
    iconFile: settings?.iconFile ?? null,
    fontFamily: settings?.fontFamily ?? null,
    closeAction: settings?.closeAction ?? 'close',
    afterLaunch: settings?.afterLaunch ?? 'none',
    autoStart: settings?.autoStart ?? 'off',
    sidebarMaterial: settings?.sidebarMaterial ?? true,
    updateChannel: 'stable',
    downloadLimitMbps: settings?.downloadLimitMbps ?? 0,
    themeAreas: settings?.themeAreas ?? {},
    themeLocks: settings?.themeLocks ?? {},
    themePolicyVersion: settings?.themePolicyVersion ?? null
  }
}
