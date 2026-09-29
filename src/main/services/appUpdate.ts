import { app, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { AppUpdateInfo, AppUpdateProgress, AppUpdateStatus } from '@shared/types'
import { isNewerVersion } from '@shared/version'
import { log } from './logger'

/** Owner/repository used for release checks (public GitHub API). */
export const GITHUB_REPO = 'KevinYuHere/KevinLauncher'

const RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
const USER_AGENT = 'KevinLauncher'

/** Time between automatic checks (startup check is separate). */
const CHECK_INTERVAL = 24 * 60 * 60 * 1000
/** Small delay so the window is painted before the first request. */
const STARTUP_DELAY = 4_000

interface GitHubRelease {
  tag_name?: string
  name?: string
  body?: string
  html_url?: string
  published_at?: string
  draft?: boolean
  prerelease?: boolean
  assets?: { name?: string; browser_download_url?: string }[]
}

/** Reads the newest published release, or `null` when the repo has none. */
async function fetchLatestRelease(): Promise<AppUpdateInfo | null> {
  const response = await fetch(RELEASES_API, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT }
  })
  // A repository with no releases yet (or a renamed repo) answers 404.
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`)

  const release = (await response.json()) as GitHubRelease
  const version = String(release.tag_name ?? '')
    .trim()
    .replace(/^v/i, '')
  if (!version) throw new Error('发布信息缺少版本号')

  // Prefer the NSIS installer produced by electron-builder.
  const asset =
    (release.assets ?? []).find((item) => /\.exe$/i.test(item.name ?? '')) ??
    (release.assets ?? [])[0]

  return {
    version,
    name: release.name?.trim() || `v${version}`,
    notes: (release.body ?? '').trim(),
    htmlUrl: release.html_url ?? `https://github.com/${GITHUB_REPO}/releases`,
    downloadUrl: asset?.browser_download_url ?? null,
    fileName: asset?.name ?? null,
    publishedAt: release.published_at ?? ''
  }
}

/**
 * Checks GitHub Releases for a newer version. Runs once shortly after launch,
 * then every 24 hours, and can be triggered manually from the settings page.
 * Emits the new release to listeners exactly once per version.
 */
export class AppUpdateChecker {
  private info: AppUpdateInfo | null = null
  private error: string | undefined
  private announced: string | null = null
  private listeners = new Set<(info: AppUpdateInfo) => void>()
  private progressListeners = new Set<(progress: AppUpdateProgress) => void>()
  private updaterReady = false

  /** Currently installed version (from package.json). */
  current(): string {
    return app.getVersion()
  }

  status(): AppUpdateStatus {
    return { current: this.current(), hasUpdate: !!this.info, info: this.info, error: this.error }
  }

  /** Subscribe to "a newer version is available" notifications. */
  onUpdate(callback: (info: AppUpdateInfo) => void): () => void {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  /** Subscribe to the installer download progress. */
  onProgress(callback: (progress: AppUpdateProgress) => void): () => void {
    this.progressListeners.add(callback)
    return () => this.progressListeners.delete(callback)
  }

  /** Starts the startup check and the 24-hour interval. */
  start(): void {
    setTimeout(() => void this.check(), STARTUP_DELAY)
    setInterval(() => void this.check(), CHECK_INTERVAL)
  }

  /** Performs a check now and returns the resulting status (never throws). */
  async check(): Promise<AppUpdateStatus> {
    try {
      const latest = await fetchLatestRelease()
      this.error = undefined
      this.info = latest && isNewerVersion(latest.version, this.current()) ? latest : null
      log(
        `appUpdate: ${this.info ? `v${this.info.version} available` : 'up to date'} (current ${this.current()})`
      )
      const found = this.info
      if (found && this.announced !== found.version) {
        this.announced = found.version
        for (const listener of this.listeners) listener(found)
      }
    } catch (error) {
      this.error = (error as Error).message
      this.info = null
      log(`appUpdate: check failed: ${this.error}`)
    }
    return this.status()
  }

  /** Wires the electron-updater events exactly once. */
  private prepareUpdater(): void {
    if (this.updaterReady) return
    this.updaterReady = true
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    // A differential download needs the blockmap of the version we are running.
    // GitHub cannot serve it from the "latest" release, so point the updater at
    // the release of the current version; if that asset is missing it falls back
    // to a full download automatically.
    autoUpdater.previousBlockmapBaseUrlOverride =
      `https://github.com/${GITHUB_REPO}/releases/download/v${this.current()}`
    autoUpdater.on('download-progress', (progress) => {
      const payload: AppUpdateProgress = {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond
      }
      for (const listener of this.progressListeners) listener(payload)
    })
    autoUpdater.on('error', (error) => log(`appUpdate: updater error: ${error.message}`))
  }

  /**
   * Downloads the new version and restarts into its installer. The installer is
   * fetched differentially (only the byte ranges that changed since the running
   * version), with automatic retry and resume handled by electron-updater; if
   * that is not possible it falls back to the full download. In dev, or when
   * nothing installable is published, the release page is opened instead.
   */
  async run(): Promise<void> {
    const info = this.info
    if (!info) return
    if (!app.isPackaged) {
      await shell.openExternal(info.htmlUrl)
      return
    }
    this.prepareUpdater()
    log(`appUpdate: downloading ${info.version} (differential)`)
    try {
      await autoUpdater.checkForUpdates()
      await autoUpdater.downloadUpdate()
    } catch (error) {
      log(`appUpdate: updater failed: ${(error as Error).message}`)
      // Nothing installable (missing asset, no matching blockmap, …).
      await shell.openExternal(info.htmlUrl)
      return
    }
    log('appUpdate: quitting to run the installer')
    autoUpdater.quitAndInstall(false, true)
  }
}
