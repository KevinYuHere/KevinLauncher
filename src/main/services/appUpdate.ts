import { app, shell } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import type { AppUpdateInfo, AppUpdateState, AppUpdateStatus } from '@shared/types'
import { isNewerVersion } from '@shared/version'
import { downloadPayload, extractPayload, sha256File } from './updateDownload'
import { currentAppVersion } from './appVersion'
import { markQuitting } from './behavior'
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
  assets?: { id?: number; name?: string; browser_download_url?: string; size?: number }[]
}

/** Everything the UI needs while idle (no download running). */
const IDLE_STATE: AppUpdateState = {
  phase: 'idle',
  version: null,
  percent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  installPercent: 0,
  message: ''
}

/**
 * Candidate URLs for a release asset, best first.
 *
 * The API asset endpoint is used first on purpose: some networks (China in
 * particular) can reach `api.github.com` but time out on `github.com`, where
 * the classic `/releases/download/...` URLs live.
 */
function assetUrls(asset: { id?: number; browser_download_url?: string }): string[] {
  const urls: string[] = []
  if (asset.id) urls.push(`https://api.github.com/repos/${GITHUB_REPO}/releases/assets/${asset.id}`)
  if (asset.browser_download_url) urls.push(asset.browser_download_url)
  return urls
}

/** Downloads a small text asset (the release manifest), trying each URL. */
async function fetchText(urls: string[]): Promise<string> {
  let lastError: unknown
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/octet-stream', 'user-agent': USER_AGENT }
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.text()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('无法获取更新清单')
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

  const assets = release.assets ?? []
  const payload = assets.find((item) => /KevinLauncher-.*\.zip$/i.test(item.name ?? ''))
  const installer = assets.find((item) => /KevinLauncher-Installer.*\.exe$/i.test(item.name ?? ''))
  const manifest = assets.find((item) => /update-manifest\.json$/i.test(item.name ?? ''))

  // The manifest carries the unpacked size (install progress denominator), the
  // payload hash and — for runtime upgrades — the full installer's details.
  let installSize = 0
  let payloadSha256: string | null = null
  let electronVersion: string | null = null
  let installerName: string | null = null
  let installerSize = installer?.size ?? 0
  let installerSha256: string | null = null
  if (manifest) {
    try {
      const meta = JSON.parse(await fetchText(assetUrls(manifest))) as {
        appSize?: number
        payloadSha256?: string
        electron?: string
        installerName?: string
        installerSize?: number
        installerSha256?: string
      }
      installSize = meta.appSize ?? 0
      payloadSha256 = meta.payloadSha256 ?? null
      electronVersion = meta.electron ?? null
      installerName = meta.installerName ?? null
      if (meta.installerSize) installerSize = meta.installerSize
      installerSha256 = meta.installerSha256 ?? null
    } catch (error) {
      log(`appUpdate: manifest unreadable (${(error as Error).message})`)
    }
  }

  return {
    version,
    name: release.name?.trim() || `v${version}`,
    notes: (release.body ?? '').trim(),
    htmlUrl: release.html_url ?? `https://github.com/${GITHUB_REPO}/releases`,
    payloadUrls: payload ? assetUrls(payload) : [],
    payloadSize: payload?.size ?? 0,
    payloadSha256,
    installSize,
    electronVersion,
    installerUrls: installer ? assetUrls(installer) : [],
    installerName: installerName ?? installer?.name ?? null,
    installerSize,
    installerSha256,
    publishedAt: release.published_at ?? ''
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await fs.stat(path)).size
  } catch {
    return 0
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Checks GitHub Releases for a newer version (once shortly after launch, then
 * every 24 hours, plus manual checks) and runs the in-app upgrade:
 *
 * download (multi-connection, resumable, pausable) → unpack into a staging
 * directory (progress shown as "installing", not pausable) → a small helper
 * waits for this process to exit, swaps the files and restarts the launcher.
 *
 * The user never sees the NSIS installer UI and never has to choose anything.
 */
export class AppUpdateChecker {
  private info: AppUpdateInfo | null = null
  private error: string | undefined
  private announced: string | null = null
  private listeners = new Set<(info: AppUpdateInfo) => void>()
  private stateListeners = new Set<(state: AppUpdateState) => void>()
  private state: AppUpdateState = { ...IDLE_STATE }
  private controller: AbortController | null = null
  private running = false

  /** Currently installed version (from `resources/app-version.txt`). */
  current(): string {
    return currentAppVersion()
  }

  status(): AppUpdateStatus {
    return { current: this.current(), hasUpdate: !!this.info, info: this.info, error: this.error }
  }

  /** Current download / install state (for the rail ring and popover). */
  stateSnapshot(): AppUpdateState {
    return { ...this.state }
  }

  /** Subscribe to "a newer version is available" notifications. */
  onUpdate(callback: (info: AppUpdateInfo) => void): () => void {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  /** Subscribe to download / install state changes. */
  onState(callback: (state: AppUpdateState) => void): () => void {
    this.stateListeners.add(callback)
    return () => this.stateListeners.delete(callback)
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

  /** Begins the upgrade, or resumes a paused download. */
  begin(): void {
    const info = this.info
    if (!info || this.running) return
    if (!app.isPackaged || !info.payloadUrls.length) {
      void shell.openExternal(info.htmlUrl)
      return
    }
    this.running = true
    this.controller = new AbortController()
    log(`appUpdate: starting ${info.version} (${Math.round(info.payloadSize / 1048576)} MB)`)
    void this.run(info, this.controller).finally(() => {
      this.running = false
    })
  }

  /**
   * Pauses / resumes the **download**. The install step is intentionally not
   * pausable, so while `installing` this does nothing.
   */
  toggle(): void {
    const phase = this.state.phase
    if (phase === 'downloading') {
      this.controller?.abort()
    } else if (phase === 'paused' || phase === 'error') {
      this.begin()
    }
  }

  private patch(patch: Partial<AppUpdateState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.stateListeners) listener({ ...this.state })
  }

  private async run(info: AppUpdateInfo, controller: AbortController): Promise<void> {
    const staging = join(app.getPath('userData'), 'update-staging', info.version)
    const archive = join(staging, 'app.zip')
    try {
      // A new Electron runtime cannot be swapped while the launcher is running:
      // download the full installer and hand over to it instead.
      if (info.electronVersion && info.electronVersion !== process.versions.electron) {
        await this.updateViaInstaller(info, staging, controller)
        return
      }

      await fs.mkdir(staging, { recursive: true })

      // 1) download (resumes from the .part files when restarted after a pause).
      this.patch({
        phase: 'downloading',
        version: info.version,
        total: info.payloadSize,
        message: '正在下载更新…'
      })
      if (info.payloadSize > 0 && (await fileSize(archive)) === info.payloadSize) {
        this.patch({ percent: 100, transferred: info.payloadSize, bytesPerSecond: 0 })
      } else {
        await downloadPayload(
          info.payloadUrls,
          archive,
          info.payloadSize,
          (progress) => {
            this.patch({
              percent: info.payloadSize > 0 ? (progress.transferred / info.payloadSize) * 100 : 0,
              transferred: progress.transferred,
              total: info.payloadSize,
              bytesPerSecond: progress.bytesPerSecond
            })
          },
          controller.signal
        )
      }
      const downloaded = await fileSize(archive)
      if (info.payloadSize > 0 && downloaded !== info.payloadSize) {
        throw new Error('更新包大小不匹配')
      }

      // 2) install: unpack into a *new* version directory. Nothing in use is
      // touched, so the launcher keeps running and showing progress.
      this.patch({ phase: 'installing', percent: 100, installPercent: 0, message: '正在安装更新…' })
      const target = join(process.resourcesPath, `app-${info.version}`)
      await extractPayload(archive, target, info.installSize, (bytes, total) => {
        this.patch({ installPercent: total > 0 ? Math.min(100, (bytes / total) * 100) : 0 })
      })
      if (!(await pathExists(join(target, 'out', 'main', 'index.js')))) {
        throw new Error('更新包内容不完整')
      }

      // 3) switch: flip the version pointer and restart into the new version.
      this.patch({ phase: 'done', installPercent: 100, message: '更新完成，正在重启…' })
      await this.switchTo(info.version)
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
      app.relaunch()
      app.exit(0)
    } catch (error) {
      if (controller.signal.aborted) {
        log('appUpdate: paused')
        this.patch({ phase: 'paused', message: '已暂停' })
        return
      }
      const message = (error as Error).message
      log(`appUpdate: failed: ${message}`)
      this.patch({ phase: 'error', message: '更新失败', error: message })
    }
  }

  /**
   * Runtime (Electron) upgrade: download the full installer, verify it and open
   * it. Files of the running launcher cannot be replaced in place, so the
   * installer takes over (it closes this instance and overwrites the files).
   */
  private async updateViaInstaller(
    info: AppUpdateInfo,
    staging: string,
    controller: AbortController
  ): Promise<void> {
    if (!info.installerUrls.length) {
      throw new Error('本次更新包含新的运行库，但发布中没有提供安装程序，请手动下载安装包')
    }
    await fs.mkdir(staging, { recursive: true })
    const installer = join(staging, info.installerName ?? 'KevinLauncher-Installer.exe')

    this.patch({
      phase: 'downloading',
      version: info.version,
      total: info.installerSize,
      message: '正在下载安装程序…'
    })
    if (!(info.installerSize > 0 && (await fileSize(installer)) === info.installerSize)) {
      await downloadPayload(
        info.installerUrls,
        installer,
        info.installerSize,
        (progress) => {
          this.patch({
            percent:
              info.installerSize > 0 ? (progress.transferred / info.installerSize) * 100 : 0,
            transferred: progress.transferred,
            total: info.installerSize,
            bytesPerSecond: progress.bytesPerSecond
          })
        },
        controller.signal
      )
    }
    const size = await fileSize(installer)
    if (info.installerSize > 0 && size !== info.installerSize) {
      throw new Error('安装程序大小不匹配')
    }
    if (info.installerSha256 && (await sha256File(installer)) !== info.installerSha256) {
      throw new Error('安装程序校验失败')
    }

    this.patch({
      phase: 'installing',
      percent: 100,
      installPercent: 100,
      message: '正在打开安装程序…'
    })
    log(`appUpdate: opening ${installer}`)
    const failure = await shell.openPath(installer)
    if (failure) throw new Error(failure)
    // The installer closes this instance itself before overwriting the files.
    markQuitting()
    app.quit()
  }

  /** Atomically rewrites the version pointer read by the shell loader. */
  private async switchTo(version: string): Promise<void> {
    const pointer = join(process.resourcesPath, 'app-version.txt')
    const temp = `${pointer}.tmp`
    await fs.writeFile(temp, version, 'utf-8')
    await fs.rename(temp, pointer)
    log(`appUpdate: version pointer -> ${version}`)
  }

  /** Deletes leftover `app-<other version>` directories (best effort). */
  async cleanupOldVersions(): Promise<void> {
    if (!app.isPackaged) return
    const keep = `app-${currentAppVersion()}`
    try {
      // Only directories: the version pointer (`app-version.txt`) also starts
      // with "app-" and must never be removed.
      const entries = await fs.readdir(process.resourcesPath, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('app-')) continue
        if (entry.name === keep) continue
        log(`appUpdate: removing old version directory ${entry.name}`)
        await fs
          .rm(join(process.resourcesPath, entry.name), { recursive: true, force: true })
          .catch(() => {})
      }
    } catch {
      /* nothing to clean */
    }
  }
}
