import { app } from 'electron'
import { promises as fs, type Dirent } from 'fs'
import { basename, dirname, join } from 'path'
import type {
  AppEntry, AppSettingsPatch, FeatureIntro, LauncherSettings, LinkedLaunch, ThemePolicy
} from '@shared/types'
import { APP_SETTINGS_FIELDS, LAUNCHER_BEHAVIOR_FIELDS } from '@shared/types'
import { currentWallpaper } from '@shared/appEntry'
import { DataError } from '@shared/dataErrors'
import { normalizeLauncherFontFamily, resolveLauncherFonts } from '@shared/launcherFonts'
import { normalizeKevinHudConfig } from '@shared/kevinHud'
import { isSemVerVersion } from '@shared/version'
import {
  applyAppThemePolicy, applyThemePolicy, isSpecialAreaId, isSpecialThemeId,
  type ReleaseUpgradePolicy
} from '@shared/specialTheme'
import { parseJsonLenient, writeFileAtomic } from './atomicFile'
import { BACKUP_DIR_NAME, PREVIOUS_BACKUP_DIR_NAME } from './dataDir'
import { ConfigValidationError, normalizeLauncherConfig, validateLauncherConfig, type LauncherConfig } from './configValidation'
import { collectOrphanMedia, collectReplacedMedia } from './mediaFiles'
import { openJsonStore } from './jsonStore'
import { configureRateLimit } from './rateLimit'
import { log } from './logger'
import { CURRENT_VERSION } from './appMigrations'

export type { LauncherConfig } from './configValidation'

/** Result of applying a release's one-time theme patch and pending introduction. */
export interface ReleaseUpgradeResult {
  changed: boolean
  intro: FeatureIntro | null
}

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

const QUARANTINE_SUFFIX = '.corrupt'

/** Timestamp encoded in a generated quarantine name; 0 for the legacy exact name. */
function quarantineTime(name: string, prefix: string): number | null {
  if (name === prefix) return 0
  const marker = `${prefix}-`
  if (!name.startsWith(marker)) return null
  const parts = name.slice(marker.length).split('-')
  if (parts.length !== 2 || !parts.every((part) => /^\d+$/.test(part))) return null
  const time = Number(parts[0])
  return Number.isSafeInteger(time) ? time : null
}

/** Regular-file quarantines for this exact config, newest first. */
async function quarantineCandidates(file: string): Promise<string[]> {
  const directory = dirname(file)
  const prefix = `${basename(file)}${QUARANTINE_SUFFIX}`
  let entries: Dirent[]
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new DataError('READ_FAILED', '启动器配置目录读取失败，已暂停写入', error)
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => ({ path: join(directory, entry.name), time: quarantineTime(entry.name, prefix) }))
    .filter((candidate): candidate is { path: string; time: number } => candidate.time !== null)
    .sort((left, right) => right.time - left.time || right.path.localeCompare(left.path))
    .map(({ path }) => path)
}

async function restoreConfig(file: string, freshQuarantine?: string): Promise<LauncherConfig | undefined> {
  const directory = dirname(file)
  const backups = [
    join(directory, BACKUP_DIR_NAME, 'config.json'),
    join(directory, PREVIOUS_BACKUP_DIR_NAME, 'config.json')
  ]
  const historical = await quarantineCandidates(file)
  // Only read the freshly quarantined path when enumeration confirmed it is a
  // regular file. A symlink must not be followed back in as config.
  const fresh = freshQuarantine && historical.includes(freshQuarantine)
    ? freshQuarantine
    : undefined
  const older = fresh ? historical.filter((candidate) => candidate !== fresh) : historical
  // A confirmed fresh quarantine outranks backups; otherwise backups outrank
  // older quarantines during this recovery. If no backup works,
  // result.quarantinePath still makes readConfig refuse the empty fallback.
  // For a missing current file, quarantines keep their newest-first priority.
  const sources = fresh
    ? [fresh, ...backups, ...older]
    : freshQuarantine
      ? [...backups, ...older]
      : [...older, ...backups]
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
    const restored = await restoreConfig(file, result.quarantinePath)
    if (restored) {
      config = restored
    } else {
      const hasQuarantine = result.quarantinePath !== undefined ||
        (await quarantineCandidates(file)).length > 0
      if (hasQuarantine) throw new ConfigValidationError('INVALID_CONFIG', '启动器配置损坏，已保留原文件')
      config = normalizeLauncherConfig(result.data)
    }
  }
  if (result.status !== 'ok' || (result.data as LauncherConfig).version !== CURRENT_VERSION) {
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
        // HUD settings are optional for historical configs and for newly added
        // apps. Materialize every entry inside this same atomic transaction so
        // defaults persist and malformed values never reach the validated write
        // path.
        for (const entry of draft.apps) entry.kevinHud = normalizeKevinHudConfig(entry.kevinHud)
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

  static patchApp(
    appId: string,
    patch: AppSettingsPatch,
    prepare?: (entry: AppEntry) => void | Promise<void>
  ): Promise<AppEntry> {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
        Object.keys(patch).some((key) => !(APP_SETTINGS_FIELDS as readonly string[]).includes(key))) {
      throw new Error('应用设置字段无效')
    }
    return this.mutateApp(appId, async (entry) => {
      await prepare?.(entry)
      Object.assign(entry, patch)
    })
  }

  static async uiPrefs(): Promise<{ gamesRowHidden: boolean }> {
    const config = await this.load()
    return { gamesRowHidden: !!config.ui?.gamesRowHidden }
  }

  static async launcherSettings(): Promise<LauncherSettings> {
    return launcherSettings((await this.load()).launcher)
  }

  static setLauncher(
    patch: Partial<Omit<
      LauncherSettings,
      'themeLocks' | 'themePolicyVersion' | 'themePolicyApplied' | 'featureIntroApplied'
    >>
  ): Promise<void> {
    const allowed: readonly string[] = [
      ...LAUNCHER_BEHAVIOR_FIELDS, 'iconFile', 'fontFamily', 'fontFamilyEn', 'fontFamilyZh'
    ]
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
        Object.keys(patch).some((key) => !allowed.includes(key))) {
      throw new ConfigValidationError('INVALID_CONFIG', '启动器设置字段无效')
    }
    return this.mutate((config) => {
      const next = { ...config.launcher, ...patch }
      if (Object.hasOwn(patch, 'fontFamily')) {
        next.fontFamily = normalizeLauncherFontFamily(patch.fontFamily)
      }
      if (Object.hasOwn(patch, 'fontFamilyEn')) {
        next.fontFamilyEn = normalizeLauncherFontFamily(patch.fontFamilyEn)
      }
      if (Object.hasOwn(patch, 'fontFamilyZh')) {
        next.fontFamilyZh = normalizeLauncherFontFamily(patch.fontFamilyZh)
      }
      if (patch.themeAreas) {
        next.themeAreas = Object.fromEntries(
          Object.entries(patch.themeAreas).filter(([area, theme]) => isSpecialAreaId(area) && isSpecialThemeId(theme))
        )
        next.themeLocks = {}
      }
      config.launcher = next
    })
  }

  /**
   * Apply the target release's theme patch atomically with its own marker, and
   * report an introduction that still has to be displayed. The introduction
   * marker is deliberately **not** written here: it is committed only after the
   * renderer confirms the dialog was shown (`markFeatureIntroApplied`).
   */
  static applyReleaseUpgrade(policy: ReleaseUpgradePolicy): Promise<ReleaseUpgradeResult> {
    return this.mutate((config) => {
      const current = config.launcher ?? {}
      const theme = policy.theme
      const intro = policy.intro
      const themeHistory = appliedVersionHistory(current.themePolicyApplied, current.themePolicyVersion)
      const introHistory = appliedVersionHistory(current.featureIntroApplied)
      const themeDone = !theme || themeHistory.includes(policy.version)
      const introDone = !intro || introHistory.includes(policy.version)
      let changed = false

      if (!themeDone && theme) {
        const settings = launcherSettings(current)
        let assignments = settings.themeAreas
        let locks = settings.themeLocks
        const themeId = theme.themeId
        const areas = theme.areas
        if (themeId && (areas === 'all' || (Array.isArray(areas) && areas.length > 0))) {
          const fullPolicy: ThemePolicy = {
            version: policy.version,
            themeId,
            areas,
            locked: false,
            mode: theme.mode
          }
          const applied = applyThemePolicy(settings.themeAreas, settings.themeLocks, fullPolicy)
          assignments = applied.assignments
          locks = {}
        }
        const apps = config.apps.map((entry) => applyAppThemePolicy(entry, theme).app)
        if (!themeHistory.includes(policy.version)) themeHistory.push(policy.version)
        config.apps = apps
        config.launcher = {
          ...current,
          themeAreas: assignments,
          themeLocks: locks,
          themePolicyVersion: policy.version,
          themePolicyApplied: themeHistory,
          featureIntroApplied: introHistory
        }
        changed = true
      }

      return { changed, intro: introDone ? null : intro }
    })
  }

  /** Commit the one-time introduction marker after it was actually displayed. */
  static markFeatureIntroApplied(version: string): Promise<boolean> {
    if (!isSemVerVersion(version)) return Promise.resolve(false)
    return this.mutate((config) => {
      const current = config.launcher ?? {}
      const history = appliedVersionHistory(current.featureIntroApplied)
      if (history.includes(version)) return false
      history.push(version)
      config.launcher = { ...current, featureIntroApplied: history }
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

/** Merge the legacy single marker into the per-version history without losing either. */
function appliedVersionHistory(history: unknown, legacy?: string | null): string[] {
  const versions = Array.isArray(history)
    ? history.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : []
  if (legacy && !versions.includes(legacy)) versions.unshift(legacy)
  return [...new Set(versions)]
}

function launcherSettings(settings: LauncherConfig['launcher']): LauncherSettings {
  const fonts = resolveLauncherFonts(settings ?? {})
  return {
    iconFile: settings?.iconFile ?? null,
    fontFamily: normalizeLauncherFontFamily(settings?.fontFamily),
    fontFamilyEn: fonts.en,
    fontFamilyZh: fonts.zh,
    closeAction: settings?.closeAction ?? 'close',
    afterLaunch: settings?.afterLaunch ?? 'none',
    autoStart: settings?.autoStart ?? 'off',
    sidebarMaterial: settings?.sidebarMaterial ?? true,
    updateChannel: settings?.updateChannel === 'beta' ? 'beta' : 'stable',
    downloadLimitMbps: settings?.downloadLimitMbps ?? 0,
    themeAreas: settings?.themeAreas ?? {},
    themeLocks: settings?.themeLocks ?? {},
    themePolicyVersion: settings?.themePolicyVersion ?? null,
    themePolicyApplied: appliedVersionHistory(settings?.themePolicyApplied, settings?.themePolicyVersion),
    featureIntroApplied: appliedVersionHistory(settings?.featureIntroApplied)
  }
}
