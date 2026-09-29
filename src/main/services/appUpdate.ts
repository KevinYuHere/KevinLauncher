import { app, shell } from 'electron'
import { dirname, join } from 'path'
import { promises as fs } from 'fs'
import type { AppUpdateInfo, AppUpdateState, AppUpdateStatus } from '@shared/types'
import { isNewerVersion } from '@shared/version'
import { downloadPayload, extractPayload } from './updateDownload'
import { applyStagedUpdate } from './updateApply'
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
  const manifest = assets.find((item) => /update-manifest\.json$/i.test(item.name ?? ''))

  // The manifest only carries the unpacked size (install progress denominator)
  // and the payload hash.
  let installSize = 0
  let payloadSha256: string | null = null
  if (manifest) {
    try {
      const meta = JSON.parse(await fetchText(assetUrls(manifest))) as {
        installSize?: number
        payloadSha256?: string
      }
      installSize = meta.installSize ?? 0
      payloadSha256 = meta.payloadSha256 ?? null
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

  /** Currently installed version (from package.json). */
  current(): string {
    return app.getVersion()
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
    const archive = join(staging, 'payload.zip')
    try {
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

      // 2) install: unpack into the staging directory (not pausable).
      this.patch({ phase: 'installing', percent: 100, installPercent: 0, message: '正在安装更新…' })
      const unpacked = join(staging, 'app')
      await extractPayload(archive, unpacked, info.installSize, (bytes, total) => {
        this.patch({ installPercent: total > 0 ? Math.min(100, (bytes / total) * 100) : 0 })
      })
      await fs.rm(archive, { force: true }).catch(() => {})

      // 3) hand over to the helper, which restarts the launcher afterwards.
      this.patch({
        phase: 'done',
        installPercent: 100,
        message: '更新完成，正在重启…'
      })
      await applyStagedUpdate(unpacked, dirname(app.getPath('exe')))
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
}
