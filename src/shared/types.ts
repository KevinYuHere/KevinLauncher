/**
 * Shared types between Electron main process, preload and renderer.
 * No UI / Node specific imports here on purpose.
 */

export type AddonId = 'genshin' | 'starrail' | 'zzz' | 'arknights'

/** Frosted-glass tone used across an app's UI. */
export type GlassStyle = 'dark' | 'light'

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
 * A launchable application. Deliberately NOT tied to a specific game
 * executable: `targetPath` may be a game exe, an official launcher, a
 * `.bat`/`.ps1` script or another third-party launcher.
 */
export interface AppEntry {
  id: string
  name: string
  /** Custom subtitle shown under the app name on the home screen. */
  moduleLabel: string | null
  /** File to start (.exe / .bat / .cmd / .ps1 / .lnk / any file). */
  targetPath: string
  /** Raw argument string, passed as-is to the target. */
  arguments: string
  /** Optional working directory. */
  workingDirectory: string
  /**
   * Game installation directory (used for version detection / updates). Kept
   * separate from the launch target, which may be a script or another launcher.
   */
  gameDirectory: string | null
  /** Extra environment variables merged over the current process env. */
  environmentVariables: Record<string, string>
  runAsAdmin: boolean
  /** Bound game add-on (explicit, never inferred from the exe name). */
  addonId: AddonId | null
  /** Icon file name stored in the launcher `icons` directory. */
  iconFile: string | null
  /** Background file name stored in the launcher `bg` directory. */
  backgroundFile: string | null
  /** Accent/theme colour for this app (hex), or null for the default. */
  themeColor: string | null
  /** Frosted-glass tone (dark or light) used across the UI for this app. */
  glassStyle: GlassStyle
  /** Auto-extract the theme colour from the background whenever it changes. */
  autoTheme: boolean
  /** Background Gaussian blur radius in px (0 = sharp). */
  backgroundBlur: number
  /** Background darkening, 0-100 (100 = the default scrim). */
  backgroundDim: number
  /** Screenshot directory for the gallery feature. */
  screenshotDirectory: string | null
  /**
   * Optional process names to treat as "the app is running" in addition to
   * the tracked process tree. Useful when a game is started through another
   * launcher/script whose process names we cannot predict.
   */
  monitorProcessNames: string[]
  createdAt: string
  updatedAt: string
}

export interface NewAppEntry {
  name: string
  /** Optional custom subtitle for the home screen (defaults to the add-on name). */
  moduleLabel?: string | null
  targetPath: string
  arguments?: string
  workingDirectory?: string
  gameDirectory?: string | null
  environmentVariables?: Record<string, string>
  runAsAdmin?: boolean
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
}

/** A newer release found on GitHub (self-update). */
export interface AppUpdateInfo {
  /** Version parsed from the release tag (leading `v` stripped). */
  version: string
  /** Release title. */
  name: string
  /** Release notes (Markdown). */
  notes: string
  /** Release page URL (opened when there is no installer asset). */
  htmlUrl: string
  /** Direct download URL of the Windows installer, if the release has one. */
  downloadUrl: string | null
  fileName: string | null
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

/** Download progress of the launcher update itself. */
export interface AppUpdateProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
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
  setBackground(appId: string, sourcePath: string | null): Promise<AppEntry>
  setIcon(appId: string, sourcePath: string | null): Promise<AppEntry>
  /** Save a square-cropped icon from a data URL (PNG). */
  setIconData(appId: string, dataUrl: string | null): Promise<AppEntry>
  /** Restore the default icon (extracted from the target file). */
  resetIcon(appId: string): Promise<AppEntry>
  /** Restore the default background (the current desktop wallpaper). */
  resetBackground(appId: string): Promise<AppEntry>
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
  getLauncherSettings(): Promise<LauncherSettings>
  setLauncherIcon(dataUrl: string | null): Promise<LauncherSettings>
  setLauncherFont(family: string | null): Promise<LauncherSettings>
  setLauncherBehavior(patch: {
    closeAction?: CloseAction
    afterLaunch?: AfterLaunchAction
    autoStart?: AutoStartMode
  }): Promise<LauncherSettings>
  hideToTray(): Promise<void>
  /** Export every setting (apps, playtime, gacha, icons, backgrounds) to a zip. */
  exportData(): Promise<string | null>
  /** Restore a previously exported zip (overwrites everything). */
  importData(): Promise<{ apps: number } | null>
  setThemeColor(appId: string, color: string | null): Promise<AppEntry>
  setGlassStyle(appId: string, style: GlassStyle): Promise<AppEntry>
  /** Set background blur (px) and dimming (0-100) for an app. */
  setBgTuning(appId: string, tuning: { blur: number; dim: number }): Promise<AppEntry>
  /** Extract a theme colour from the app's background image. */
  extractThemeColor(appId: string): Promise<AppEntry | null>

  launchApp(id: string): Promise<LaunchResult>
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
  galleryOpenViewer(path: string): Promise<void>
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
  /** Downloads + runs the installer of the available update. */
  appUpdateRun(): Promise<void>
  /** Fired when a newer version is found (startup / 24h / manual check). */
  onAppUpdateAvailable(callback: (info: AppUpdateInfo) => void): () => void
  /** Fired while the update installer is being downloaded. */
  onAppUpdateProgress(callback: (progress: AppUpdateProgress) => void): () => void

  windowMinimize(): Promise<void>
  windowToggleMaximize(): Promise<boolean>
  windowClose(): Promise<void>
  windowIsMaximized(): Promise<boolean>

  onAppsChanged(callback: () => void): () => void
  onRunningChanged(callback: () => void): () => void
  onPlayTimeChanged(callback: () => void): () => void
  onGachaProgress(callback: (progress: GachaProgress) => void): () => void
  onWindowMaximized(callback: (maximized: boolean) => void): () => void
  onLauncherChanged(callback: () => void): () => void
  onUpdateProgress(callback: (status: UpdateStatus) => void): () => void
}
