import {
  DEFAULT_GLASS_APPEARANCE,
  DEFAULT_WALLPAPER_SETTINGS,
  HOME_MODULES,
  LAUNCH_EFFECTS,
  MATERIAL_DEFAULTS,
  type AppEntry,
  type LauncherSettings,
  type LinkedLaunch,
  type UiPrefs
} from '@shared/types'
import { isSpecialAreaId, isSpecialThemeId } from '@shared/specialTheme'
import { DataError } from '@shared/dataErrors'
import { isMediaFilename } from '@shared/mediaReferences'
import { normalizeLauncherFontFamily } from '@shared/launcherFonts'
import { isKevinHudConfig, normalizeKevinHudConfig } from '@shared/kevinHud'
import { CURRENT_VERSION, migrateConfig } from './appMigrations'

export interface LauncherConfig {
  version: number
  apps: AppEntry[]
  linkedLaunches?: LinkedLaunch[]
  ui?: Partial<UiPrefs>
  launcher?: Omit<Partial<LauncherSettings>, 'updateChannel'> & { updateChannel?: 'stable' | 'beta' }
}

export class ConfigValidationError extends DataError {
  constructor(code: 'INVALID_CONFIG' | 'UNSUPPORTED_CONFIG', message: string) {
    super(code, message)
  }
}

type Check = (value: unknown) => boolean
type RecordValue = Record<string, unknown>
export const isObject = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const string: Check = (v) => typeof v === 'string'
const boolean: Check = (v) => typeof v === 'boolean'
const id: Check = (v) => typeof v === 'string' && /^[\w-]+$/.test(v)
const date: Check = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v))
const range = (min: number, max: number): Check =>
  (v) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const oneOf = (...values: string[]): Check => (v) => typeof v === 'string' && values.includes(v)
const nullable = (check: Check): Check => (v) => v === null || check(v)
const list = (check: Check): Check => (v) => Array.isArray(v) && v.every(check)
const fields = (value: unknown, rules: Record<string, Check>, required: string[] = []): value is RecordValue =>
  isObject(value) && required.every((key) => Object.hasOwn(value, key)) &&
  Object.entries(rules).every(([key, check]) => !Object.hasOwn(value, key) || check(value[key]))

const glassFields: Record<string, Check> = {
  brightness: range(0, 100), opacity: range(0, 100), material: oneOf(...Object.keys(MATERIAL_DEFAULTS)),
  blur: range(0, 60), saturation: range(50, 200), grain: range(0, 100),
  refraction: range(0, 200), panelRefraction: range(0, 200), edgeWidth: range(4, 100),
  highlight: range(0, 100), highlightAngle: range(0, 360), dispersion: range(0, 100)
}
const launchFields: Record<string, Check> = {
  id, name: string, targetPath: string, arguments: string, workingDirectory: string, runAsAdmin: boolean
}
const method: Check = (v) => fields(v, launchFields, ['id', 'name', 'targetPath'])
const linked: Check = (v) => fields(v, { ...launchFields, showInGamesRow: boolean }, ['id', 'name', 'targetPath'])
const wallpaper: Check = (v) => fields(v, { id, name: string, file: isMediaFilename }, ['id', 'file', 'name'])
const themeAreas: Check = (v) => isObject(v) && Object.entries(v).every(
  ([area, theme]) => typeof theme === 'string' && (!isSpecialAreaId(area) || isSpecialThemeId(theme))
)
const launcher: Check = (v) => fields(v, {
  iconFile: nullable(isMediaFilename),
  fontFamily: nullable(string),
  fontFamilyEn: nullable(string),
  fontFamilyZh: nullable(string),
  closeAction: oneOf('close', 'tray'),
  afterLaunch: oneOf('none', 'minimize', 'tray', 'close'), autoStart: oneOf('off', 'window', 'tray'),
  sidebarMaterial: boolean, updateChannel: oneOf('stable', 'beta'),
  downloadLimitMbps: range(0, Number.MAX_SAFE_INTEGER), themePolicyVersion: nullable(string),
  themePolicyApplied: list(string), featureIntroApplied: list(string),
  themeAreas, themeLocks: themeAreas
})
const homeModule: Check = (v) => fields(v, {
  visible: boolean, draggable: boolean, x: nullable(range(0, 1)), y: nullable(range(0, 1))
})
const appFields: Record<string, Check> = {
  id, name: string, moduleLabel: nullable(string), launchMethods: list(method), defaultLaunchMethodId: id,
  gameDirectory: nullable(string), screenshotDirectory: nullable(string),
  environmentVariables: (v) => isObject(v) && Object.values(v).every(string),
  addonId: nullable(oneOf('genshin', 'starrail', 'zzz', 'arknights')), iconFile: nullable(isMediaFilename),
  wallpapers: list(wallpaper), wallpaperSettings: (v) => fields(v, {
    strategy: oneOf('loop', 'random'), trigger: oneOf('launcherStart', 'appSwitch', 'appLaunch', 'interval'),
    intervalMinutes: range(1, 1440)
  }),
  wallpaperIndex: (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0,
  themeColor: nullable((v) => typeof v === 'string' && /^#[a-f\d]{6}$/i.test(v)),
  glass: (v) => fields(v, glassFields), autoTheme: boolean,
  backgroundBlur: range(0, 60), backgroundDim: range(0, 100), monitorProcessNames: list(string),
  gachaShowSecond: boolean, linkedLaunchIds: list(id), defaultLinkedLaunchId: nullable(id),
  homeModules: (v) => isObject(v) && HOME_MODULES.every(({ id: key }) => !Object.hasOwn(v, key) || homeModule(v[key])),
  launchEffect: oneOf(...LAUNCH_EFFECTS.map(({ id: effect }) => effect)),
  kevinHud: isKevinHudConfig,
  createdAt: date, updatedAt: date,
  targetPath: string, arguments: string, workingDirectory: string,
  backgroundFile: nullable(isMediaFilename), runAsAdmin: boolean
}

const invalid = (): never => { throw new ConfigValidationError('INVALID_CONFIG', '配置格式或引用关系无效') }
const unique = (ids: string[]): boolean => new Set(ids).size === ids.length

export function validateLauncherConfig(value: unknown): asserts value is LauncherConfig {
  if (!isObject(value)) return invalid()
  if (typeof value.version === 'number' && Number.isSafeInteger(value.version) && value.version > CURRENT_VERSION) {
    throw new ConfigValidationError('UNSUPPORTED_CONFIG', '配置由较新版启动器写入，请使用兼容版本')
  }
  if (!fields(value, {
    version: (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1,
    apps: list((entry) => fields(entry, appFields, ['id', 'name'])),
    linkedLaunches: list(linked), ui: (v) => fields(v, { gamesRowHidden: boolean }), launcher
  }, ['apps'])) return invalid()
  const config = value as unknown as LauncherConfig
  const linkedIds = (config.linkedLaunches ?? []).map(({ id }) => id)
  if (!unique(config.apps.map(({ id }) => id)) || !unique(linkedIds)) return invalid()
  for (const entry of config.apps) {
    const methods = entry.launchMethods?.map(({ id }) => id)
    const wallpapers = entry.wallpapers?.map(({ id }) => id)
    const assigned = entry.linkedLaunchIds ?? []
    if ((methods && (!methods.length || !unique(methods))) ||
      (entry.defaultLaunchMethodId !== undefined && !methods?.includes(entry.defaultLaunchMethodId)) ||
      (wallpapers && !unique(wallpapers)) ||
      (entry.wallpaperIndex !== undefined && entry.wallpaperIndex >= Math.max(1, wallpapers?.length ?? 0)) ||
      !unique(assigned) || assigned.some((key) => !linkedIds.includes(key)) ||
      (entry.defaultLinkedLaunchId != null && !assigned.includes(entry.defaultLinkedLaunchId))) return invalid()
  }
}

/**
 * HUD fields are normalized before schema validation so even a malformed
 * historical `kevinHud` object becomes a safe default instead of invalidating
 * the whole launcher config. The HUD is optional and needs no version bump, so
 * config versions and existing upgrade markers stay untouched. The input is
 * cloned, never rewritten in place.
 */
function normalizeAppHudFields(value: unknown): unknown {
  if (!isObject(value) || !Array.isArray(value.apps)) return value
  const config = structuredClone(value) as RecordValue & { apps: unknown[] }
  config.apps = config.apps.map((entry) => isObject(entry)
    ? {
        ...entry,
        kevinHud: normalizeKevinHudConfig(
          Object.hasOwn(entry, 'kevinHud') ? entry.kevinHud : undefined
        )
      }
    : entry)
  return config
}

/** Materialize fields omitted by supported older configs without discarding unknown data. */
export function normalizeLauncherConfig(value: unknown): LauncherConfig {
  const normalized = normalizeAppHudFields(value)
  validateLauncherConfig(normalized)
  const config = normalized
  config.version ??= 1
  migrateConfig(config)
  config.linkedLaunches ??= []
  for (const linked of config.linkedLaunches) {
    linked.arguments ??= ''
    linked.workingDirectory ??= ''
    linked.runAsAdmin ??= true
    linked.showInGamesRow ??= true
  }
  const epoch = '1970-01-01T00:00:00.000Z'
  for (const entry of config.apps) {
    entry.launchMethods ??= [{ id: entry.id, name: '默认', targetPath: '', arguments: '', workingDirectory: '', runAsAdmin: true }]
    for (const method of entry.launchMethods) {
      method.arguments ??= ''
      method.workingDirectory ??= ''
      method.runAsAdmin ??= true
    }
    entry.defaultLaunchMethodId ??= entry.launchMethods[0].id
    entry.moduleLabel ??= null
    entry.gameDirectory ??= null
    entry.screenshotDirectory ??= null
    entry.environmentVariables ??= {}
    entry.addonId ??= null
    entry.iconFile ??= null
    entry.wallpapers ??= []
    entry.wallpaperSettings = { ...DEFAULT_WALLPAPER_SETTINGS, ...entry.wallpaperSettings }
    entry.wallpaperIndex ??= 0
    entry.themeColor ??= null
    entry.glass = { ...DEFAULT_GLASS_APPEARANCE, ...entry.glass }
    entry.autoTheme ??= entry.themeColor === null
    entry.backgroundBlur ??= 0
    entry.backgroundDim ??= 25
    entry.monitorProcessNames ??= []
    entry.gachaShowSecond ??= true
    entry.linkedLaunchIds ??= []
    if (entry.defaultLinkedLaunchId === undefined) entry.defaultLinkedLaunchId = entry.linkedLaunchIds[0] ?? null
    entry.launchEffect ??= 'none'
    entry.createdAt ??= epoch
    entry.updatedAt ??= entry.createdAt
  }
  if (config.launcher) {
    if (config.launcher.updateChannel === 'beta') config.launcher.updateChannel = 'stable'
    // Older configs/backups carry one `fontFamily`; map it to both independent
    // choices. An explicit per-script `null` is kept and means system default.
    const legacyFont = normalizeLauncherFontFamily(config.launcher.fontFamily)
    if (!Object.hasOwn(config.launcher, 'fontFamilyEn')) config.launcher.fontFamilyEn = legacyFont
    if (!Object.hasOwn(config.launcher, 'fontFamilyZh')) config.launcher.fontFamilyZh = legacyFont
  }
  validateLauncherConfig(config)
  return config
}
