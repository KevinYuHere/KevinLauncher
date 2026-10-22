/**
 * Shared types between Electron main process, preload and renderer.
 * No UI / Node specific imports here on purpose.
 */

export type AddonId = 'genshin' | 'starrail' | 'zzz' | 'arknights'

/**
 * Glass material used across an app's UI.
 * - `blur` 毛玻璃（经典模糊）
 * - `mica` 云母（更致密、带细微颗粒的磨砂）
 * - `liquid` 液态玻璃（边缘折射）
 * - `shine` 高光（液态玻璃 + 高光反射）
 */
export type GlassMaterial = 'blur' | 'mica' | 'liquid' | 'shine' | 'starfrost'

/**
 * Appearance of the glass across an app. Two independent perceptual axes:
 * - `brightness`
 *   the surface tint (0 black … 100 white);
 * - `opacity`
 *   how much the background shows through / refracts (0 = opaque, no background
 *   influence; 100 = fully see-through).
 * Plus the shared `blur` and the per-material parameters below.
 */
export interface GlassAppearance {
  /** 底色：0 = 黑，100 = 白（只影响材质内部，不影响页面背景）。 */
  brightness: number
  /** 背景影响：0 = 完全实心（无视背景），100 = 完全透出/折射背景。 */
  opacity: number
  material: GlassMaterial
  /** 材质自身的模糊半径（px）。 */
  blur: number
  /** 背景饱和度（%，毛玻璃 / 云母）。 */
  saturation: number
  /** 颗粒强度（0-100，云母）。 */
  grain: number
  /** 折射强度（%，控件档：按钮/滑块/小药丸，液态 / 高光）。 */
  refraction: number
  /** 折射强度（%，大面板档：卡片/弹窗，液态 / 高光）。 */
  panelRefraction: number
  /** 折射边缘宽度（px，液态 / 高光）。 */
  edgeWidth: number
  /** 轮廓高光强度（%，液态 / 高光）。 */
  highlight: number
  /** 高光方向角度（deg，高光）。 */
  highlightAngle: number
  /** 色散强度（0-100，液态 / 高光）。 */
  dispersion: number
}

/** Partial update for an app's glass appearance. */
export type GlassPatch = Partial<GlassAppearance>

/**
 * Recommended parameters per material. Used when a new app is created, when the
 * material is first switched to, and by the "重置材质参数" button.
 */
export const MATERIAL_DEFAULTS: Record<GlassMaterial, GlassAppearance> = {
  // 毛玻璃 (per the 原神 preset)
  blur: {
    brightness: 0,
    opacity: 100,
    material: 'blur',
    blur: 60,
    saturation: 100,
    grain: 30,
    refraction: 100,
    panelRefraction: 127,
    edgeWidth: 40,
    highlight: 42,
    highlightAngle: 60,
    dispersion: 0
  },
  // 星霜（霆骇列律特别版）：磨砂底 + 碎晶三角，保留可读的底色。
  starfrost: {
    brightness: 0,
    opacity: 85,
    material: 'starfrost',
    blur: 40,
    saturation: 125,
    grain: 45,
    refraction: 100,
    panelRefraction: 120,
    edgeWidth: 28,
    highlight: 45,
    highlightAngle: 60,
    dispersion: 8
  },
  // 云母 (per the 崩坏：星穹铁道 preset)
  mica: {
    brightness: 0,
    opacity: 100,
    material: 'mica',
    blur: 32,
    saturation: 110,
    grain: 30,
    refraction: 100,
    panelRefraction: 55,
    edgeWidth: 16,
    highlight: 40,
    highlightAngle: 60,
    dispersion: 15
  },
  // 液态 (per the 绝区零 preset)
  liquid: {
    brightness: 0,
    opacity: 50,
    material: 'liquid',
    blur: 0,
    saturation: 120,
    grain: 30,
    refraction: 100,
    panelRefraction: 55,
    edgeWidth: 40,
    highlight: 0,
    highlightAngle: 60,
    dispersion: 15
  },
  // 高光 (per the 明日方舟 preset)
  shine: {
    brightness: 0,
    opacity: 50,
    material: 'shine',
    blur: 0,
    saturation: 120,
    grain: 30,
    refraction: 100,
    panelRefraction: 55,
    edgeWidth: 40,
    highlight: 35,
    highlightAngle: 61,
    dispersion: 8
  }
}

/** Defaults for a new app / the fallback when a field is missing. */
export const DEFAULT_GLASS_APPEARANCE: GlassAppearance = { ...MATERIAL_DEFAULTS.blur }

/** Home-screen modules (per app). */
export type HomeModuleId = 'info' | 'playtime' | 'launch' | 'wallpaper' | 'linkedLaunch'

/** Per-module state on the home screen. `x`/`y` are stage fractions (null = default). */
export interface HomeModuleState {
  visible: boolean
  draggable: boolean
  x: number | null
  y: number | null
}

/** Registry of home modules (extend here to add more later). */
export const HOME_MODULES: {
  id: HomeModuleId
  name: string
  desc: string
  /** Whether the module may be hidden (the launch button may not). */
  hideable: boolean
}[] = [
  { id: 'info', name: '信息卡片', desc: '左下角的应用信息与总时长', hideable: true },
  { id: 'playtime', name: '使用时长', desc: '右下角的使用时长药丸按钮', hideable: true },
  { id: 'wallpaper', name: '壁纸', desc: '左上角的上一张 / 下一张壁纸按钮', hideable: true },
  { id: 'linkedLaunch', name: '关联启动', desc: '一键拉起多个应用的快捷按钮', hideable: true },
  { id: 'launch', name: '启动按钮', desc: '启动 / 更新 / 停止按钮（不可隐藏）', hideable: false }
]

export const DEFAULT_HOME_MODULE: HomeModuleState = {
  visible: true,
  draggable: true,
  x: null,
  y: null
}

/** Full-screen transition played when a game is launched. */
export type LaunchEffect = 'none' | 'shockwave' | 'melt' | 'glitch' | 'gravity' | 'shatter'

/** Registry of launch effects (label + description). */
export const LAUNCH_EFFECTS: { id: LaunchEffect; label: string; desc: string }[] = [
  { id: 'none', label: '无', desc: '不播放启动特效' },
  { id: 'shockwave', label: '折射激波', desc: '带色散的激波扫过整个窗口' },
  { id: 'melt', label: '液态熔蚀', desc: '液态融化 + 方块故障' },
  { id: 'glitch', label: '赛博故障', desc: '撕裂 / 方块 / RGB 故障' },
  { id: 'gravity', label: '引力奇点', desc: '启动按钮的霆核膨胀，吞掉整页碎片' },
  { id: 'shatter', label: '星屑碎裂', desc: '整页壁纸炸成三角碎片向外飞散' }
]

export const DEFAULT_LAUNCH_EFFECT: LaunchEffect = 'none'

export interface AddonCapabilities {
  gacha: boolean
  update: boolean
  gallery: boolean
}

export interface AddonDescriptor {
  id: AddonId
  name: string
  capabilities: AddonCapabilities
  /** Suggested process names to watch (used to auto-fill a new app). */
  defaultMonitorProcessNames: string[]
}

/**
 * One way to start an application. An app may have several (e.g. the normal
 * launch, a launch through the official launcher, a script with extra flags);
 * exactly one is marked as the default.
 */
export interface LaunchMethod {
  id: string
  /** User-facing name shown in the picker / module settings. */
  name: string
  /** File to start (.exe / .bat / .cmd / .ps1 / .lnk / any file). */
  targetPath: string
  /** Raw argument string, passed as-is to the target. */
  arguments: string
  /** Optional working directory. */
  workingDirectory: string
  /** Whether this method is started with administrator rights. */
  runAsAdmin: boolean
}

/** One wallpaper (image or video) in an app's rotation list. */
export interface Wallpaper {
  id: string
  /** File name stored in the launcher `bg` directory. */
  file: string
  /** Original file name, shown in the list. */
  name: string
}

export type WallpaperStrategy = 'random' | 'loop'
export type WallpaperTrigger = 'launcherStart' | 'appSwitch' | 'appLaunch' | 'interval'

/** How / when an app's wallpapers rotate. */
export interface WallpaperSettings {
  strategy: WallpaperStrategy
  trigger: WallpaperTrigger
  /** Interval in minutes (used when `trigger === 'interval'`). */
  intervalMinutes: number
}

export const DEFAULT_WALLPAPER_SETTINGS: WallpaperSettings = {
  strategy: 'loop',
  trigger: 'appSwitch',
  intervalMinutes: 30
}

/**
 * A launcher-wide "linked launch": one file (any type the launcher can start)
 * that starts several applications at once. It has no home of its own — it is
 * surfaced through the apps it is associated with.
 */
export interface LinkedLaunch {
  id: string
  name: string
  targetPath: string
  arguments: string
  workingDirectory: string
  runAsAdmin: boolean
  /** Whether this appears in the games-bar linked-launch row. */
  showInGamesRow: boolean
}

/**
 * A launchable application. Deliberately NOT tied to a specific game
 * executable: each launch method's `targetPath` may be a game exe, an official
 * launcher, a `.bat`/`.ps1` script or another third-party launcher.
 */
export interface AppEntry {
  id: string
  name: string
  /** Custom subtitle shown under the app name on the home screen. */
  moduleLabel: string | null
  /** Ways to launch this app (at least one); one is the default. */
  launchMethods: LaunchMethod[]
  /** Id of the default launch method (must be in `launchMethods`). */
  defaultLaunchMethodId: string
  /**
   * Game installation directory (used for version detection / updates). Kept
   * separate from the launch target, which may be a script or another launcher.
   */
  gameDirectory: string | null
  /** Extra environment variables merged over the current process env. */
  environmentVariables: Record<string, string>
  /** Bound game add-on (explicit, never inferred from the exe name). */
  addonId: AddonId | null
  /** Icon file name stored in the launcher `icons` directory. */
  iconFile: string | null
  /** Wallpapers rotated for this app (images / videos); may be empty. */
  wallpapers: Wallpaper[]
  /** Rotation strategy / trigger. */
  wallpaperSettings: WallpaperSettings
  /** Index of the currently shown wallpaper (`wallpapers[wallpaperIndex]`). */
  wallpaperIndex: number
  /** Accent/theme colour for this app (hex), or null for the default. */
  themeColor: string | null
  /** Glass appearance (colour / material / blur) used across the UI for this app. */
  glass: GlassAppearance
  /** Auto-extract the theme colour from the current wallpaper whenever it changes. */
  autoTheme: boolean
  /** Background Gaussian blur radius in px (0 = sharp); applies to every wallpaper. */
  backgroundBlur: number
  /** Background darkening, 0-100 (100 = the default scrim); applies to every wallpaper. */
  backgroundDim: number
  /** Screenshot directory for the gallery feature. */
  screenshotDirectory: string | null
  /**
   * Optional process names to treat as "the app is running" in addition to
   * the tracked process tree. Useful when a game is started through another
   * launcher/script whose process names we cannot predict.
   */
  monitorProcessNames: string[]
  /** 抽卡记录里是否显示次高品级（每个应用独立）。 */
  gachaShowSecond: boolean
  /** Linked launches associated with this app, in this app's display order. */
  linkedLaunchIds: string[]
  /** Default linked launch for this app (must be in `linkedLaunchIds`). */
  defaultLinkedLaunchId: string | null
  /** Home-screen module state (per app). Missing modules use the defaults. */
  homeModules?: Partial<Record<HomeModuleId, HomeModuleState>>
  /** Full-screen launch transition played when this app starts. */
  launchEffect: LaunchEffect
  createdAt: string
  updatedAt: string
}

/** A launch method supplied when creating an app. */
export interface NewLaunchMethod {
  name?: string
  targetPath: string
  arguments?: string
  workingDirectory?: string
  runAsAdmin?: boolean
}

export interface NewAppEntry {
  name: string
  /** Optional custom subtitle for the home screen (defaults to the add-on name). */
  moduleLabel?: string | null
  /** Launch transition (defaults to none). */
  launchEffect?: LaunchEffect
  /** Ways to launch the app; at least one. The first is the default. */
  launchMethods: NewLaunchMethod[]
  gameDirectory?: string | null
  environmentVariables?: Record<string, string>
  addonId?: AddonId | null
  screenshotDirectory?: string | null
  monitorProcessNames?: string[]
}

export interface LaunchResult {
  ok: boolean
  pid: number | null
  elevated: boolean
  /** Optional informational note (e.g. auto-elevated). Not an error. */
  message?: string
  error?: string
}

export interface StopResult {
  ok: boolean
  killed: number
}

export interface RunningApp {
  appId: string
  rootPid: number | null
  elevated: boolean
  startedAt: string
  pids: number[]
}

export interface PlayTimeDay {
  /** Local date, `YYYY-MM-DD`. */
  date: string
  sec: number
}

export interface PlayTimeTotals {
  totalSec: number
  todaySec: number
  weekSec: number
  monthSec: number
  /** Daily totals for the most recent days (oldest first). */
  daily: PlayTimeDay[]
}

export type GachaGame = 'genshin' | 'starrail' | 'zzz' | 'arknights'

export interface GachaRecord {
  /** Stable unique id used for de-duplication. */
  id: string
  appId: string
  game: GachaGame
  uid: string
  /** Banner/category id. */
  gachaType: string
  /** Specific pool id (used to group banners that do not share pity). */
  poolId?: string
  /** Computed pool group id (banners that share pity). */
  group?: string
  bannerName: string
  itemId: string
  itemName: string
  /** Rarity as reported by the API (per-game scale). */
  rankType: number
  /** Local time string `YYYY-MM-DD HH:MM:SS`. */
  time: string
  isUp?: boolean
  seq?: string
  /** Pulls since the previous item of the same rarity in the same pool. */
  pityAtPull?: number
}

export interface GachaPoolStat {
  /** Pool group id (banners that share pity). */
  group: string
  bannerName: string
  count: number
  topRank: number
  secondRank: number | null
  /** Pulls since the most recent top-rarity item (current pity). */
  topPity: number
  lastTopName: string | null
  lastTopTime: string | null
  /** Pulls since the most recent second-rarity item. */
  secondPity: number | null
  lastSecondName: string | null
  lastSecondTime: string | null
}

export interface GachaStats {
  total: number
  rankCounts: Record<string, number>
  topRank: number
  secondRank: number | null
  pools: GachaPoolStat[]
  lastUpdated: string | null
}

export interface GachaUpdateResult {
  added: number
  total: number
  message?: string
}

/** Live progress while fetching gacha records. */
export interface GachaProgress {
  appId: string
  phase: 'fetching' | 'done'
  /** Banner being fetched (only while `phase === 'fetching'`). */
  bannerName?: string
  /** Page number within that banner. */
  page?: number
}

export interface UpdateInfo {
  game: GachaGame
  currentVersion: string | null
  latestVersion: string | null
  preDownloadVersion: string | null
  /** A pre-download for `preDownloadVersion` is already completed (config.ini marker). */
  preDownloadFinished?: boolean
  hasUpdate: boolean
  /** Whether this launcher can download/apply the update. */
  supported: boolean
  mainSizeBytes: number
  preDownloadSizeBytes: number
  message?: string
}

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'extracting'
  | 'paused'
  | 'done'
  | 'error'

export interface UpdateStatus {
  appId: string
  phase: UpdatePhase
  progress: number
  downloadedBytes: number
  totalBytes: number
  /** Which kind of job this is, so the home UI can pick the right control. */
  mode?: UpdateMode
  message?: string
}

export type UpdateMode = 'update' | 'preDownload'

export interface GalleryItem {
  path: string
  name: string
  mtimeMs: number
  size: number
}

/** Persisted UI preferences (survive restarts). */
export interface UiPrefs {
  /** Whether the top-left games row is collapsed/hidden. */
  gamesRowHidden: boolean
}

export type CloseAction = 'close' | 'tray'
export type AfterLaunchAction = 'none' | 'minimize' | 'tray' | 'close'
/** Launch-at-login behaviour: off, show the window, or start hidden in the tray. */
export type AutoStartMode = 'off' | 'window' | 'tray'
/** Which GitHub releases the launcher self-updater follows. */
export type UpdateChannel = 'stable' | 'beta'

/** 特别版主题标识（可扩展；`default` 表示不套用主题）。 */
export type SpecialThemeId = 'default' | 'starsnow' | (string & {})

/** 可独立选择主题的 UI 区域。 */
export type SpecialAreaId =
  | 'titlebar'
  | 'focusRing'
  | 'textAccent'
  | 'toast'
  | 'transition'
  | 'sidebar'
  | 'navSelected'
  | 'updateIndicator'
  | 'cards'
  | 'launchButton'
  | 'gamesBar'
  | 'avatars'
  | 'emptyState'
  | 'updatePage'
  | 'downloadOverlay'
  | 'downloadRing'
  | 'dialogs'
  | 'forms'
  | 'dropdowns'
  | 'drawer'
  | 'segmented'
  | 'slider'
  | 'switch'
  | 'tabs'
  | 'inputs'
  | 'clickEffect'
  | 'gallery'
  | 'skeleton'

/** 发布方可选的强制主题策略（见 `theme-policy.json`）。 */
export interface ThemePolicy {
  /** 策略版本；同一版本只应用一次（`appliedThemePolicyVersion`）。 */
  version: string
  themeId: SpecialThemeId
  areas: 'all' | SpecialAreaId[]
  /** 旧字段：兼容旧清单，策略不会再锁定区域（用户之后可自由修改）。 */
  locked: boolean
  /** `force` 覆盖用户选择；`default` 只填充尚未设置主题的区域。 */
  mode?: 'force' | 'default'
  /**
   * 同时把**每个应用**的玻璃材质替换为该材质（连同该材质的推荐参数，与设置里
   * 切换材质的行为一致）。缺省 = 不改动材质。
   */
  material?: GlassMaterial
  /** 同时把**每个应用**的启动特效替换为该特效。缺省 = 不改动启动特效。 */
  launchEffect?: LaunchEffect
  /**
   * 把本次发布标记为重要更新（写入 `update-manifest.json` 的 `critical`）。
   * 仅在仓库根目录的策略文件里生效，只影响发布产物，不影响客户端行为。
   */
  critical?: boolean
}

/** Launcher-wide (global) appearance + behavior settings. */
export interface LauncherSettings {
  iconFile: string | null
  fontFamily: string | null
  /** What the window's × button does. */
  closeAction: CloseAction
  /** What to do to the launcher window after a successful game launch. */
  afterLaunch: AfterLaunchAction
  /** Whether the launcher starts with Windows (and how). */
  autoStart: AutoStartMode
  /** 侧边栏是否应用当前应用的玻璃材质（否则用主题色）。 */
  sidebarMaterial: boolean
  /** Follow stable releases or also pre-releases (测试版). */
  updateChannel: UpdateChannel
  /** Download speed limit in MB/s (0 = unlimited). */
  downloadLimitMbps: number
  /** 特别版主题：每个区域独立选择；缺省 = default。 */
  themeAreas: Partial<Record<SpecialAreaId, SpecialThemeId>>
  /** 由发布策略锁定的区域（用户不可修改）。 */
  themeLocks: Partial<Record<SpecialAreaId, SpecialThemeId>>
  /** 已经应用过的主题策略版本（同一版本不再覆盖用户选择）。 */
  themePolicyVersion: string | null
}

/** A newer release found on GitHub (self-update). */
export interface AppUpdateInfo {
  /** Version parsed from the release tag (leading `v` stripped). */
  version: string
  /** 重要更新：不可跳过，检测到即自动开始。 */
  critical?: boolean
  /** Release title. */
  name: string
  /** Release notes (Markdown). */
  notes: string
  /** Release page URL (opened when there is no payload asset). */
  htmlUrl: string
  /** Download URLs of the update payload, best first (API asset endpoint, then
   *  the `github.com/.../releases/download/...` URL). Some networks cannot
   *  reach `github.com` but can reach `api.github.com`. */
  payloadUrls: string[]
  payloadSize: number
  /** Hex SHA-256 of the payload, from the release manifest. */
  payloadSha256: string | null
  /** Total bytes of the unpacked application — denominator of install progress. */
  installSize: number
  /** Electron version the release was built with ('' when unknown). */
  electronVersion: string | null
  /** Full installer used when the runtime itself changed (URLs, best first). */
  installerUrls: string[]
  installerName: string | null
  installerSize: number
  installerSha256: string | null
  publishedAt: string
}

/** Result of the latest GitHub release check. */
export interface AppUpdateStatus {
  /** Currently installed version. */
  current: string
  hasUpdate: boolean
  info: AppUpdateInfo | null
  /** Set when the last check failed (network / rate limit / …). */
  error?: string
}

/** Lifecycle of the in-app upgrade. */
export type AppUpdatePhase =
  | 'idle'
  | 'downloading'
  /** Download paused by the user (install cannot be paused). */
  | 'paused'
  | 'installing'
  | 'done'
  | 'error'

/**
 * Everything the download ring / popover needs. `percent`/`transferred`/`total`
 * describe the **download**, `installPercent` the **install** step.
 */
export interface AppUpdateState {
  phase: AppUpdatePhase
  version: string | null
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
  installPercent: number
  message: string
  error?: string
  /** 当前下载是重要更新：不可暂停 / 跳过，失败会自动重试。 */
  critical?: boolean
  /** 重要更新的自动重试序号（1 起）；0 表示没有在重试。 */
  retry?: number
}

/** A KevinLauncher installation found on this machine. */
export interface DetectedInstall {
  dir: string
  version: string | null
  source: 'registry' | 'default' | 'running'
}

/** State of the directory the user wants to install into. */
export interface InstallTarget {
  dir: string
  exists: boolean
  /** True when the directory already holds a KevinLauncher installation. */
  isInstalled: boolean
  version: string | null
  fileCount: number
}

/** Everything the install UI needs to render its first page. */
export interface InstallerInfo {
  defaultDir: string
  detected: DetectedInstall | null
  target: InstallTarget | null
  /** Paths of launchers that are running right now (closed before installing). */
  running: string[]
  /** Pre-filled install directory (detected installation, `KevinLauncher` appended). */
  prefillDir: string
  payloadSize: number
  version: string
  dataDir: string
}

export interface InstallerProgress {
  phase: 'copying' | 'shortcuts'
  done: number
  total: number
  current: string
}

/** Everything the uninstall UI needs. */
export interface UninstallerInfo {
  installDir: string
  version: string
  dataDir: string
  dataSize: number
  installSize: number
}

/** Disk usage of the caches the launcher can clean up. */
export interface UsageReport {
  /** Staged update downloads (`update-staging`). */
  staging: number
  /** Gallery thumbnail cache (`thumbs`). */
  thumbs: number
  /** Log files. */
  logs: number
  total: number
}

/** API exposed on `window.api` through the preload context bridge. */
export interface KevinApi {
  listAddons(): Promise<AddonDescriptor[]>

  listApps(): Promise<AppEntry[]>
  addApp(input: NewAppEntry): Promise<AppEntry>
  updateApp(app: AppEntry): Promise<AppEntry>
  removeApp(id: string): Promise<void>
  /** Reorder applications by id; returns the new order. */
  reorderApps(ids: string[]): Promise<AppEntry[]>
  getUiPrefs(): Promise<UiPrefs>
  setGamesRowHidden(hidden: boolean): Promise<UiPrefs>
  setIcon(appId: string, sourcePath: string | null): Promise<AppEntry>
  /** Save a square-cropped icon from a data URL (PNG). */
  setIconData(appId: string, dataUrl: string | null): Promise<AppEntry>
  /** Restore the default icon (extracted from the default launch method's file). */
  resetIcon(appId: string): Promise<AppEntry>
  setAutoTheme(appId: string, on: boolean): Promise<AppEntry>
  /** Pick an icon source: an image, or an exe/bat/lnk whose icon is extracted. */
  pickIconSource(): Promise<{ path: string; dataUrl: string } | null>
  /** Extract/read an icon (data URL) from an arbitrary file path. */
  iconFromPath(path: string): Promise<string | null>
  /** Read an image file as a data URL (for the cropper; avoids canvas taint). */
  readImage(path: string): Promise<string | null>
  /** Installed font family names (for the launcher font picker). */
  listFonts(): Promise<string[]>
  appVersion(): Promise<string>
  /** Current Windows desktop wallpaper path (used when there are no apps). */
  desktopWallpaper(): Promise<string | null>
  getLauncherSettings(): Promise<LauncherSettings>
  setLauncherIcon(dataUrl: string | null): Promise<LauncherSettings>
  setLauncherFont(family: string | null): Promise<LauncherSettings>
  setLauncherBehavior(patch: {
    closeAction?: CloseAction
    afterLaunch?: AfterLaunchAction
    autoStart?: AutoStartMode
    sidebarMaterial?: boolean
    updateChannel?: UpdateChannel
    downloadLimitMbps?: number
    themeAreas?: LauncherSettings['themeAreas']
  }): Promise<LauncherSettings>
  /** 抽卡记录里是否显示次高品级（每个应用独立）。 */
  setGachaShowSecond(appId: string, value: boolean): Promise<AppEntry>
  hideToTray(): Promise<void>
  /** Export every setting (apps, playtime, gacha, icons, wallpapers) to a zip. */
  exportData(): Promise<string | null>
  /** Restore a previously exported zip (overwrites everything). */
  importData(): Promise<{ apps: number } | null>
  setThemeColor(appId: string, color: string | null): Promise<AppEntry>
  /** Update the app's glass appearance (colour / material / blur). */
  setGlass(appId: string, patch: GlassPatch): Promise<AppEntry>
  /** Set background blur (px) and dimming (0-100) for an app (all wallpapers). */
  setBgTuning(appId: string, tuning: { blur: number; dim: number }): Promise<AppEntry>
  /** Update one home-screen module's state (visibility / draggable / position). */
  setHomeModule(appId: string, moduleId: HomeModuleId, patch: Partial<HomeModuleState>): Promise<AppEntry>
  /** Set the full-screen launch transition for an app. */
  setLaunchEffect(appId: string, effect: LaunchEffect): Promise<AppEntry>
  /** Set the home information card's subtitle text ('' clears it). */
  setModuleLabel(appId: string, label: string | null): Promise<AppEntry>
  /** Ask for a directory and copy the launcher logs there; returns it (or null). */
  exportLogs(): Promise<string | null>
  /** Extract a theme colour from the app's current wallpaper (image only). */
  extractThemeColor(appId: string): Promise<AppEntry | null>

  /** Replace an app's launch methods + default (at least one is enforced). */
  setLaunchMethods(appId: string, methods: LaunchMethod[], defaultId: string): Promise<AppEntry>

  /** --- wallpapers (per app) --- */
  /** Pick one or more image/video files for the wallpaper list. */
  pickWallpapers(): Promise<string[]>
  /** Import a picked file into the app's wallpaper list (appended). */
  wallpaperAdd(appId: string, sourcePath: string): Promise<AppEntry>
  /** Remove a wallpaper from the list (deletes the stored file). */
  wallpaperRemove(appId: string, wallpaperId: string): Promise<AppEntry>
  /** Reorder an app's wallpapers by id. */
  wallpaperReorder(appId: string, ids: string[]): Promise<AppEntry>
  /** Update rotation strategy / trigger. */
  wallpaperSettings(appId: string, patch: Partial<WallpaperSettings>): Promise<AppEntry>
  /** Manually show the previous / next wallpaper (list order). */
  wallpaperStep(appId: string, delta: number): Promise<AppEntry>
  /** Rotate automatically according to the strategy (random / loop). */
  wallpaperAdvance(appId: string): Promise<AppEntry>
  /** Replace the wallpaper list with the current desktop wallpaper. */
  wallpaperReset(appId: string): Promise<AppEntry>
  /** Show a specific wallpaper (by list index). */
  wallpaperSelect(appId: string, index: number): Promise<AppEntry>
  /** Open a wallpaper in the shared media viewer (prev/next + video). */
  wallpaperOpenViewer(appId: string, index: number): Promise<void>

  /** --- linked launches (launcher-wide) --- */
  listLinkedLaunches(): Promise<LinkedLaunch[]>
  addLinkedLaunch(input: Omit<LinkedLaunch, 'id' | 'showInGamesRow'> & { showInGamesRow?: boolean }): Promise<LinkedLaunch>
  updateLinkedLaunch(entry: LinkedLaunch): Promise<LinkedLaunch>
  removeLinkedLaunch(id: string): Promise<void>
  /** Global order of linked launches (games-bar row / page). */
  reorderLinkedLaunches(ids: string[]): Promise<LinkedLaunch[]>
  /** Set the linked launches associated with an app, in order, + the default. */
  setAppLinkedLaunches(appId: string, ids: string[], defaultId: string | null): Promise<AppEntry>
  launchLinkedLaunch(id: string): Promise<LaunchResult>

  launchApp(id: string, methodId?: string): Promise<LaunchResult>
  listRunning(): Promise<RunningApp[]>
  stopApp(appId: string): Promise<StopResult>

  playTimeTotals(): Promise<Record<string, number>>
  playTimeSummary(appId: string, days?: number): Promise<PlayTimeTotals>

  gachaList(appId: string): Promise<GachaRecord[]>
  gachaStats(appId: string): Promise<GachaStats>
  gachaClear(appId: string): Promise<void>
  gachaUpdateMiHoYo(appId: string, url: string): Promise<GachaUpdateResult>
  /** Opens the Hypergryph login page and fetches records automatically. */
  gachaLoginArknights(appId: string): Promise<GachaUpdateResult>
  gachaScanUrl(appId: string): Promise<string | null>
  gachaExport(appId: string): Promise<string | null>
  gachaImport(appId: string): Promise<number>

  updateInfo(appId: string): Promise<UpdateInfo>
  updateStart(appId: string, mode: UpdateMode): Promise<void>
  updateCancel(appId: string): Promise<void>
  updateStatus(appId: string): Promise<UpdateStatus>
  /** Preview the download UI with a fake progress run. */
  updateSimulate(appId: string, mode: UpdateMode): Promise<void>

  galleryList(appId: string): Promise<GalleryItem[]>
  galleryOpenViewer(paths: string[], index: number): Promise<void>
  /** Move the open viewer to the previous/next image (wraps); returns its path. */
  galleryViewerNav(delta: number): Promise<string | null>
  galleryContextMenu(path: string): Promise<void>

  pickExecutable(): Promise<string | null>
  pickBackground(): Promise<string | null>
  pickImage(): Promise<string | null>
  pickDirectory(): Promise<string | null>
  openPath(path: string): Promise<void>
  openExternal(url: string): Promise<void>

  /** Last known result of the GitHub release check. */
  appUpdateStatus(): Promise<AppUpdateStatus>
  /** Forces a release check now (used by the manual button). */
  appUpdateCheck(): Promise<AppUpdateStatus>
  /** Starts downloading + installing the available update. */
  appUpdateStart(): Promise<void>
  /** Pauses / resumes the update download (install cannot be paused). */
  appUpdateToggle(): Promise<void>
  /** Current upgrade state (for the ring / popover). */
  appUpdateState(): Promise<AppUpdateState>
  /** Fired when a newer version is found (startup / 24h / manual check). */
  onAppUpdateAvailable(callback: (info: AppUpdateInfo) => void): () => void
  /** Fired whenever the download / install state changes. */
  onAppUpdateState(callback: (state: AppUpdateState) => void): () => void

  /** --- installer mode (`KevinLauncher-Setup-*.exe`) --- */
  installerInfo(): Promise<InstallerInfo>
  /** `KevinLauncher` is appended to a folder that is not named like that. */
  installerNormalize(dir: string): Promise<string>
  installerRunning(): Promise<string[]>
  installerInspect(dir: string): Promise<InstallTarget>
  installerFreeSpace(dir: string): Promise<number>
  installerPickDirectory(current: string): Promise<string | null>
  /** Copies the payload into `dir`, writes shortcuts + the uninstall entry. */
  installerRun(dir: string, dataDir?: string): Promise<boolean>
  /** Starts the installed launcher and closes the installer. */
  installerLaunch(dir: string): Promise<void>
  onInstallerProgress(callback: (progress: InstallerProgress) => void): () => void

  /** --- uninstaller mode (`KevinLauncher.exe --uninstall`) --- */
  uninstallerInfo(): Promise<UninstallerInfo>
  /** Removes the installation (and optionally the user data), then quits. */
  uninstallerRun(keepUserData: boolean): Promise<void>
  onUninstallerProgress(callback: (progress: { step: string }) => void): () => void

  /** --- data directory (config, playtime, gacha, icons …) --- */
  dataDirGet(): Promise<{ current: string; default: string; programDir: string }>
  dataDirPick(current: string): Promise<string | null>
  /** Moves the existing data to `dir` and restarts the launcher. */
  dataDirSet(dir: string): Promise<void>
  onDataDirProgress(callback: (progress: { step: string }) => void): () => void

  /** --- disk housekeeping (settings → 清理与占用) --- */
  housekeepingUsage(): Promise<UsageReport>
  /** Cleans the requested caches and returns the new usage. */
  housekeepingClean(kinds: ('staging' | 'thumbs' | 'logs')[]): Promise<UsageReport>

  windowMinimize(): Promise<void>
  windowToggleMaximize(): Promise<boolean>
  windowClose(): Promise<void>
  windowIsMaximized(): Promise<boolean>

  onAppsChanged(callback: () => void): () => void
  onRunningChanged(callback: () => void): () => void
  onPlayTimeChanged(callback: () => void): () => void
  onGachaProgress(callback: (progress: GachaProgress) => void): () => void
  onWindowMaximized(callback: (maximized: boolean) => void): () => void
  /** Fired whenever the main window becomes visible (startup / tray / re-open). */
  onWindowShown(callback: () => void): () => void
  onLauncherChanged(callback: () => void): () => void
  onUpdateProgress(callback: (status: UpdateStatus) => void): () => void
}
