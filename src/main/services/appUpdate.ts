import { app, shell } from 'electron'
import { spawn } from 'child_process'
import { join } from 'path'
import { promises as fs } from 'fs'
import type { AppUpdateInfo, AppUpdateProgress, AppUpdateStatus } from '@shared/types'
import { isNewerVersion } from '@shared/version'
import {
  downloadInstaller,
  type CachedInstaller,
  type InstallerSource
} from './installerDownload'
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
  assets?: { name?: string; browser_download_url?: string; size?: number }[]
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
  const assets = release.assets ?? []
  const installer =
    assets.find((item) => /KevinLauncher-Setup.*\.exe$/i.test(item.name ?? '')) ??
    assets.find((item) => /\.exe$/i.test(item.name ?? ''))

  // `latest.yml` carries the SHA-512 (base64) and size used to verify the file.
  let sha512: string | null = null
  let size = installer?.size ?? 0
  const meta = assets.find((item) => /(^|\/)latest\.ya?ml$/i.test(item.name ?? ''))
  if (meta?.browser_download_url) {
    try {
      const fromYml = await fetchLatestYml(meta.browser_download_url)
      sha512 = fromYml.sha512
      if (fromYml.size) size = fromYml.size
    } catch (error) {
      log(`appUpdate: latest.yml unavailable (${(error as Error).message})`)
    }
  }

  return {
    version,
    name: release.name?.trim() || `v${version}`,
    notes: (release.body ?? '').trim(),
    htmlUrl: release.html_url ?? `https://github.com/${GITHUB_REPO}/releases`,
    downloadUrl: installer?.browser_download_url ?? null,
    fileName: installer?.name ?? null,
    sha512,
    size,
    blockmapUrl: installer?.browser_download_url
      ? `${installer.browser_download_url}.blockmap`
      : null,
    publishedAt: release.published_at ?? ''
  }
}

/** Reads the installer SHA-512 / size from a release's `latest.yml`. */
async function fetchLatestYml(
  url: string
): Promise<{ sha512: string | null; size: number }> {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const text = await response.text()
  return {
    sha512: /\bsha512:\s*(\S+)/.exec(text)?.[1] ?? null,
    size: Number(/\bsize:\s*(\d+)/.exec(text)?.[1] ?? 0)
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

  /** Directory caching downloaded installers (enables differential updates). */
  private cacheDir(): string {
    return join(app.getPath('userData'), 'update-cache')
  }

  /**
   * The installer of the version we are running, if a previous update left it
   * cached. Without it (e.g. the very first self-update) the changed blocks
   * cannot be sourced locally, so the download is a plain full one.
   */
  private async previousInstaller(): Promise<CachedInstaller | null> {
    const dir = this.cacheDir()
    try {
      const files = await fs.readdir(dir)
      const candidates = files.filter((name) => /KevinLauncher-Setup-.*\.exe$/i.test(name))
      const preferred = candidates.find((name) => name.includes(this.current())) ?? candidates[0]
      if (!preferred) return null
      const path = join(dir, preferred)
      const blockmapPath = `${path}.blockmap`
      try {
        await fs.access(blockmapPath)
      } catch {
        return null
      }
      return { path, blockmapPath }
    } catch {
      return null
    }
  }

  private emitProgress(progress: AppUpdateProgress): void {
    for (const listener of this.progressListeners) listener(progress)
  }

  /**
   * Downloads the new version and restarts into its installer. The installer is
   * fetched over several connections and, when the previous installer is still
   * cached, completed differentially (only changed byte ranges are transferred;
   * the rest is copied from the cached file). A full download resumes from its
   * part files and every connection retries. The file is verified against the
   * release's SHA-512; on failure the release page is opened instead.
   */
  async run(): Promise<void> {
    const info = this.info
    if (!info) return
    if (!app.isPackaged || !info.downloadUrl || !info.fileName) {
      await shell.openExternal(info.htmlUrl)
      return
    }

    const source: InstallerSource = {
      url: info.downloadUrl,
      blockmapUrl: info.blockmapUrl,
      size: info.size,
      sha512: info.sha512,
      fileName: info.fileName
    }
    try {
      const megabytes = info.size ? `, ${Math.round(info.size / 1048576)} MB` : ''
      log(`appUpdate: downloading ${info.version}${megabytes}`)
      const installer = await downloadInstaller(
        source,
        this.cacheDir(),
        await this.previousInstaller(),
        (progress) => this.emitProgress(progress)
      )
      log(`appUpdate: verified, starting ${installer}`)
      spawn(installer, [], { detached: true, stdio: 'ignore' }).unref()
      app.quit()
    } catch (error) {
      log(`appUpdate: download failed: ${(error as Error).message}`)
      await shell.openExternal(info.htmlUrl)
    }
  }
}
