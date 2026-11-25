import { app, shell } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import type { AppUpdateInfo, AppUpdateState, AppUpdateStatus } from '@shared/types'
import { isNewerVersion, pickNewestVersion } from '@shared/version'
import { downloadPayload, extractPayload, verifyPayloadDownload } from './updateDownload'
import { backupUserData } from './dataBackup'
import {
  installerAssetName,
  isPositiveFileSize,
  isRuntimeVersion,
  isSha256,
  parseUpdateManifest,
  payloadAssetName,
  SAFE_VERSION,
  type UpdateManifest
} from './appUpdateManifest'
import { currentAppVersion } from './appVersion'
import { writeFileAtomic } from './atomicFile'
import { flushBeforeShutdown } from './shutdown'
import { markQuitting } from './behavior'
import { AppStore } from './appStore'
import { log } from './logger'

/** Owner/repository used for release checks (public GitHub API). */
export const GITHUB_REPO = 'KevinYuHere/KevinLauncher'

const RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
/** Full release list (includes pre-releases) used by the beta channel. */
const RELEASES_LIST_API = `https://api.github.com/repos/${GITHUB_REPO}/releases`
/**
 * Stable URL that always redirects to the newest release's manifest.
 *
 * This is a plain asset download, so it does **not** count against the API rate
 * limit (60/hour per IP) — the same trick electron-updater uses with
 * `latest.yml`. The GitHub API is only a fallback for networks where
 * `github.com` is unreachable (the API is reachable there).
 */
const LATEST_MANIFEST_URL = `https://github.com/${GITHUB_REPO}/releases/latest/download/update-manifest.json`
const USER_AGENT = 'KevinLauncher'

/** Time between automatic checks (startup check is separate). */
const CHECK_INTERVAL = 24 * 60 * 60 * 1000
/** A successful check is reused for this long (disk cache). */
const CHECK_CACHE_TTL = 24 * 60 * 60 * 1000
/** A failed check is retried after this long (clicks must not hammer the API). */
const FAILURE_RETRY = 5 * 60 * 1000
/** After a 403 (rate limit) automatic checks stay quiet for this long. */
const RATE_LIMIT_BACKOFF = 30 * 60 * 1000
/** Small delay so the window is painted before the first request. */
const STARTUP_DELAY = 4_000
/** A critical update starts by itself as soon as it is detected. */
const CRITICAL_AUTOSTART_DELAY = 0
/** Critical updates retry automatically; after this many failures the UI waits. */
const CRITICAL_MAX_RETRIES = 3
const CRITICAL_RETRY_DELAY = 8_000

/** Human readable reason for a failed check (403 = GitHub rate limit). */
function describeCheckError(error: unknown): string {
  const message = (error as Error).message ?? String(error)
  if (/403/.test(message)) return 'GitHub 接口请求过于频繁（限流），请稍后再试'
  return message
}

/** Cached / marker data is user-writable: never trust its version string. */
function safeInfo(info: AppUpdateInfo | null | undefined): AppUpdateInfo | null {
  return info && typeof info.version === 'string' && SAFE_VERSION.test(info.version) &&
    Array.isArray(info.payloadUrls) && Array.isArray(info.installerUrls) ? info : null
}

interface GitHubRelease {
  tag_name?: string
  name?: string
  body?: string
  html_url?: string
  published_at?: string
  draft?: boolean
  prerelease?: boolean
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

/** Fetch and validate each candidate; an API endpoint might return asset metadata. */
async function fetchManifest(urls: string[], version?: string): Promise<UpdateManifest> {
  let lastError: unknown
  for (const url of new Set(urls)) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/octet-stream', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(20_000)
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return parseUpdateManifest(await response.text(), version)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('无法获取更新清单')
}

function releaseAssetUrl(version: string, asset: string): string {
  return `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${asset}`
}

function infoFromManifest(manifest: UpdateManifest, release?: GitHubRelease): AppUpdateInfo {
  const { version, installerName } = manifest
  const payloadName = payloadAssetName(version)
  const assets = release?.assets ?? []
  const urlsFor = (name: string): string[] => {
    const asset = assets.find(item => item.name === name)
    return [...new Set([...(asset ? assetUrls(asset) : []), releaseAssetUrl(version, name)])]
  }
  return {
    version,
    name: release?.name?.trim() || `v${version}`,
    notes: release?.body?.trim() || manifest.notes || '',
    htmlUrl: release?.html_url ?? `https://github.com/${GITHUB_REPO}/releases/tag/v${version}`,
    payloadUrls: urlsFor(payloadName),
    payloadSize: manifest.payloadSize,
    payloadSha256: manifest.payloadSha256,
    installSize: manifest.appSize,
    electronVersion: manifest.electron,
    installerUrls: installerName ? urlsFor(installerName) : [],
    installerName,
    installerSize: manifest.installerSize,
    installerSha256: manifest.installerSha256,
    publishedAt: release?.published_at ?? '',
    critical: manifest.critical
  }
}

async function fetchReleaseViaLatestUrl(): Promise<AppUpdateInfo> {
  return infoFromManifest(await fetchManifest([LATEST_MANIFEST_URL]))
}

/** API asset URLs for the selected version; the latest tag can change mid-update. */
async function releaseFromTag(version: string): Promise<GitHubRelease> {
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/tags/v${version}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`)
  const release = (await response.json()) as GitHubRelease
  if (release.tag_name !== `v${version}`) throw new Error('更新发布标签不匹配')
  return release
}

async function apiAssetUrls(version: string, name: string): Promise<string[]> {
  const release = await releaseFromTag(version)
  const asset = release.assets?.find(item => item.name === name)
  return asset ? assetUrls(asset) : []
}

async function downloadWithFallback(options: {
  version: string
  name: string
  primary: string[]
  size: number
  dest: string
  onProgress?: (progress: { transferred: number; total: number; bytesPerSecond: number }) => void
  signal: AbortSignal
}): Promise<void> {
  const { version, name, primary, size, dest, onProgress, signal } = options
  const onlyDirect = primary.length === 1 && primary[0] === releaseAssetUrl(version, name)
  try {
    await downloadPayload(primary, dest, size, onProgress, signal, onlyDirect ? 2 : undefined)
  } catch (error) {
    if (signal.aborted || !onlyDirect) throw error
    log(`appUpdate: ${primary[0]} failed (${(error as Error).message}) — retrying via the API`)
    const fallback = await apiAssetUrls(version, name)
    if (!fallback.length) throw error
    await downloadPayload(fallback, dest, size, onProgress, signal)
  }
}

async function infoFromRelease(release: GitHubRelease): Promise<AppUpdateInfo | null> {
  const version = String(release.tag_name ?? '').trim().replace(/^v/i, '')
  if (!SAFE_VERSION.test(version)) return null
  const asset = release.assets?.find(item => item.name === 'update-manifest.json')
  const manifest = await fetchManifest(
    [...(asset ? assetUrls(asset) : []), releaseAssetUrl(version, 'update-manifest.json')],
    version
  )
  return infoFromManifest(manifest, release)
}

class ReleaseManifestError extends Error {}

async function refreshManifest(version: string): Promise<AppUpdateInfo> {
  try {
    return infoFromManifest(await fetchManifest([releaseAssetUrl(version, 'update-manifest.json')], version))
  } catch {
    const info = await infoFromRelease(await releaseFromTag(version))
    if (!info) throw new Error('更新清单版本无效')
    return info
  }
}

function hasVerifiedMetadata(info: AppUpdateInfo): boolean {
  if (!isRuntimeVersion(info.electronVersion)) return false
  if (info.electronVersion !== process.versions.electron) {
    return isPositiveFileSize(info.installerSize) && isSha256(info.installerSha256) &&
      info.installerName === installerAssetName(info.version) && info.installerUrls.length > 0
  }
  return isPositiveFileSize(info.payloadSize) && isSha256(info.payloadSha256) &&
    isPositiveFileSize(info.installSize) && info.payloadUrls.length > 0
}

/**
 * Newest release **by version** (GitHub itself lists by publication date, so a
 * patch published last must not hide a newer minor).
 *
 * - `stableOnly: true`  → pre-releases are skipped (the stable channel),
 * - `stableOnly: false` → stable and pre-release compete; the higher version
 *   wins (the beta channel always takes the absolute newest build).
 */
async function latestFromList(stableOnly: boolean): Promise<AppUpdateInfo | null> {
  const response = await fetch(RELEASES_LIST_API, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000)
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`)
  const list = (await response.json()) as GitHubRelease[]
  const pool = list
    .map((release) => ({
      release,
      version: String(release.tag_name ?? '').trim().replace(/^v/i, ''),
      draft: release.draft === true,
      prerelease: release.prerelease === true
    }))
    .filter(candidate => SAFE_VERSION.test(candidate.version))
  const best = pickNewestVersion(pool, stableOnly)
  if (!best) return null
  try {
    return await infoFromRelease(best.release)
  } catch (cause) {
    throw new ReleaseManifestError(
      `无法验证 ${best.version} 的更新清单: ${(cause as Error).message}`,
      { cause }
    )
  }
}

/**
 * Newest release for a channel:
 * - `stable` → the highest **non-pre-release** version, so a critical stable
 *   release also reaches beta users that are below it;
 * - `beta`   → the highest version overall (stable or pre-release).
 */
async function fetchLatestRelease(channel: 'stable' | 'beta'): Promise<AppUpdateInfo | null> {
  if (channel === 'beta') return latestFromList(false)

  // The list API gives the real "newest stable by version"; `releases/latest`
  // only means "newest published", which an out-of-order patch can distort.
  try {
    const info = await latestFromList(true)
    if (info) return info
  } catch (error) {
    if (error instanceof ReleaseManifestError) throw error
    log(`appUpdate: release list unavailable (${(error as Error).message})`)
  }

  // 1) Free path (no rate limit, no auth) — also works where api.github.com is
  //    unreachable but github.com is not.
  try {
    const info = await fetchReleaseViaLatestUrl()
    if (info) return info
  } catch (error) {
    log(`appUpdate: latest/download path unavailable (${(error as Error).message})`)
  }

  // 2) GitHub API (rate limited to 60/hour per IP, but reachable where
  //    github.com is blocked).
  const response = await fetch(RELEASES_API, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000)
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`)
  return infoFromRelease((await response.json()) as GitHubRelease)
}
async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await fs.lstat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Checks GitHub Releases for a newer version (once shortly after launch, then
 * every 24 hours, plus manual checks) and runs the in-app upgrade:
 *
 * Apply a verified payload to a new version directory and switch the pointer,
 * or open the verified installer when the release needs a different runtime.
 */
interface ChannelState {
  auto: number
  manual: number
  failedAt: number
  rateLimitedUntil: number
  info: AppUpdateInfo | null
}

function emptyChannelState(): ChannelState {
  return { auto: 0, manual: 0, failedAt: 0, rateLimitedUntil: 0, info: null }
}
export class AppUpdateChecker {
  constructor(private readonly pendingDataTransfer: () => Promise<void> | undefined = () => undefined) {}

  private info: AppUpdateInfo | null = null
  private error: string | undefined
  private announced: string | null = null
  private listeners = new Set<(info: AppUpdateInfo) => void>()
  private stateListeners = new Set<(state: AppUpdateState) => void>()
  private state: AppUpdateState = { ...IDLE_STATE }
  private controller: AbortController | null = null
  private running = false
  /** Critical-update version that already auto-started (start it only once). */
  private autoStarted: string | null = null
  /** Automatic retry timer / counter for a failing critical update. */
  private criticalRetryTimer: NodeJS.Timeout | null = null
  private criticalRetries = 0
  /** Update channel the current result was computed for. */
  private channel: 'stable' | 'beta' = 'stable'
  /** Timestamp of the last successful automatic check (active channel). */
  private lastAutoCheck = 0
  /** Timestamp of the last successful manual check (active channel). */
  private lastManualCheck = 0
  /** Timestamp of the last failed attempt (retry backoff). */
  private failedAt = 0
  /** Automatic checks are skipped until this timestamp after a 403. */
  private rateLimitedUntil = 0
  /** Per-channel state: switching channels reuses that channel's cache/cooldowns. */
  private saved: Record<'stable' | 'beta', ChannelState> = {
    stable: emptyChannelState(),
    beta: emptyChannelState()
  }

  private snapshot(): ChannelState {
    return {
      auto: this.lastAutoCheck,
      manual: this.lastManualCheck,
      failedAt: this.failedAt,
      rateLimitedUntil: this.rateLimitedUntil,
      info: this.info
    }
  }

  private applyChannel(channel: 'stable' | 'beta'): void {
    const state = this.saved[channel]
    this.channel = channel
    this.lastAutoCheck = state.auto
    this.lastManualCheck = state.manual
    this.failedAt = state.failedAt
    this.rateLimitedUntil = state.rateLimitedUntil
    this.info = state.info && isNewerVersion(state.info.version, this.current()) ? state.info : null
    this.announced = this.info?.version ?? null
  }

  private switchChannel(channel: 'stable' | 'beta'): void {
    if (this.channel === channel) return
    this.saved[this.channel] = this.snapshot()
    this.applyChannel(channel)
  }

  /** Currently installed version (from `resources/app-version.txt`). */
  current(): string {
    return currentAppVersion()
  }

  /** Optional fake release read from `%userData%/simulate-app-update.json`. */
  private async fakeSpec(): Promise<AppUpdateInfo | null> {
    try {
      const raw = await fs.readFile(
        join(app.getPath('userData'), 'simulate-app-update.json'),
        'utf-8'
      )
      const spec = JSON.parse(raw) as {
        version?: string
        name?: string
        notes?: string
        critical?: boolean
      }
      const version = spec.version ?? '9.9.9'
      return {
        version,
        name: spec.name ?? `KevinLauncher ${version}（模拟更新）`,
        notes: spec.notes ?? '这是用于本地检查更新页面的模拟更新，不会真正下载。',
        htmlUrl: `https://github.com/${GITHUB_REPO}/releases/tag/v${version}`,
        payloadUrls: [],
        payloadSize: 0,
        payloadSha256: null,
        installSize: 0,
        electronVersion: null,
        installerUrls: [],
        installerName: null,
        installerSize: 0,
        installerSha256: null,
        publishedAt: new Date().toISOString(),
        critical: spec.critical === true
      }
    } catch {
      return null
    }
  }

  /** Fake download progress (used with `fakeSpec`). */
  private simulateFake(info: AppUpdateInfo): void {
    const total = 1048576
    let transferred = 0
    this.running = true
    this.patch({
      phase: 'downloading',
      version: info.version,
      percent: 0,
      transferred: 0,
      total,
      bytesPerSecond: total / 3,
      installPercent: 0,
      message: ''
    })
    const timer = setInterval(() => {
      transferred += total / 40
      if (transferred >= total) {
        clearInterval(timer)
        this.running = false
        this.patch({ phase: 'done', percent: 1, transferred: total, installPercent: 100 })
        return
      }
      this.patch({
        percent: transferred / total,
        transferred,
        bytesPerSecond: total / 3,
        installPercent: 0
      })
    }, 150)
  }

  status(): AppUpdateStatus {
    // Never advertise a version that is already installed: a cached result can
    // otherwise keep offering the update right after it was applied.
    if (this.info && !isNewerVersion(this.info.version, this.current())) {
      this.info = null
      this.announced = null
      this.saved[this.channel].info = null
    }
    return { current: this.current(), hasUpdate: !!this.info, info: this.info, error: this.error }
  }

  /** Current download / install state (for the rail ring and popover). */
  stateSnapshot(): AppUpdateState {
    return { ...this.state }
  }

  isRunning(): boolean {
    return this.running
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

  /**
   * Publish a newly found release. A **critical** update also starts itself: the
   * user must not have to notice and click it. `autoStarted` keeps a repeated
   * check (e.g. after a failed manual refresh) from restarting it.
   */
  private announce(info: AppUpdateInfo): void {
    if (info.critical && this.autoStarted !== info.version) {
      this.autoStarted = info.version
      this.criticalRetries = 0
      // Persist before starting: if the app is closed mid-download (or crashes),
      // the next launch must resume instead of forgetting the critical update.
      void this.saveCriticalMarker(info)
      log(`appUpdate: v${info.version} is a critical update — starting automatically`)
      setTimeout(() => {
        // A later check may already have replaced it; never start a stale one.
        if (!this.running && this.info?.version === info.version) this.begin()
      }, CRITICAL_AUTOSTART_DELAY)
    }
    for (const listener of this.listeners) listener(info)
  }

  private criticalMarkerFile(): string {
    return join(app.getPath('userData'), 'critical-update.json')
  }

  /**
   * A critical update must start by itself even when the status came from the
   * cache (a channel switch, a rate-limited refresh): the user may never have
   * seen a dialog to click.
   */
  private resumeCriticalAutoStart(): void {
    if (this.info?.critical && this.autoStarted !== this.info.version) this.announce(this.info)
  }

  /** Persist a real critical update (fake local specs are not resumed forever). */
  private async saveCriticalMarker(info: AppUpdateInfo): Promise<void> {
    if (!info.critical || (info.payloadUrls.length === 0 && info.installerUrls.length === 0)) return
    try {
      await writeFileAtomic(this.criticalMarkerFile(), JSON.stringify(info, null, 2))
      log(`appUpdate: critical marker saved for ${info.version}`)
    } catch (error) {
      log(`appUpdate: cannot save critical marker: ${(error as Error).message}`)
    }
  }

  private async clearCriticalMarker(): Promise<void> {
    await fs.rm(this.criticalMarkerFile(), { force: true }).catch(() => undefined)
  }

  /** Resume a critical update saved by the previous session (before any check). */
  private async loadCriticalMarker(): Promise<void> {
    try {
      const info = safeInfo(
        JSON.parse(await fs.readFile(this.criticalMarkerFile(), 'utf8')) as AppUpdateInfo
      )
      if (!info?.critical || !isNewerVersion(info.version, this.current())) {
        await this.clearCriticalMarker()
        return
      }
      if (!this.info || isNewerVersion(info.version, this.info.version)) {
        this.info = info
        log(`appUpdate: resuming critical update ${info.version} from marker`)
      }
    } catch {
      /* no marker / unreadable: a normal check follows */
    }
  }

  /** Starts the startup check and the 24-hour interval. */
  start(): void {
    void (async (): Promise<void> => {
      await this.loadCache()
      // A critical marker is independent of the check cache (channel changes,
      // cache invalidation, app closed mid-download) — resume it first.
      await this.loadCriticalMarker()
      // A critical update cached by the previous session must still start by
      // itself (the 24h check below may legitimately be answered from cache).
      if (this.info?.critical) this.announce(this.info)
      setTimeout(() => void this.check('auto'), STARTUP_DELAY)
      setInterval(() => void this.check('auto'), CHECK_INTERVAL)
    })()
  }

  /** Result of the last checks, cached on disk for a day (per kind). */
  private async loadCache(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.cacheFile(), 'utf8')) as {
        forVersion?: string
        channel?: 'stable' | 'beta'
        autoCheckedAt?: number
        manualCheckedAt?: number
        info?: AppUpdateInfo | null
        channels?: Partial<Record<'stable' | 'beta', ChannelState>>
      }
      const channel = (await AppStore.launcherSettings()).updateChannel
      const current = this.current()
      if (raw.forVersion && raw.forVersion !== current) {
        log(`appUpdate: cache is for ${raw.forVersion}, current is ${current} - discarding`)
        this.channel = channel
        return
      }
      if (raw.channels) {
        for (const key of ['stable', 'beta'] as const) {
          const state = raw.channels[key]
          if (state) {
            this.saved[key] = {
              auto: state.auto ?? 0,
              manual: state.manual ?? 0,
              failedAt: state.failedAt ?? 0,
              rateLimitedUntil: state.rateLimitedUntil ?? 0,
              info: safeInfo(state.info)
            }
          }
        }
      } else {
        // Legacy single-channel cache: attribute it to its recorded channel.
        this.saved[raw.channel ?? 'stable'] = {
          auto: raw.autoCheckedAt ?? 0,
          manual: raw.manualCheckedAt ?? 0,
          failedAt: 0,
          rateLimitedUntil: 0,
          info: safeInfo(raw.info)
        }
      }
      this.applyChannel(channel)
    } catch {
      /* no cache yet */
    }
  }
  private async saveCache(): Promise<void> {
    try {
      this.saved[this.channel] = this.snapshot()
      await writeFileAtomic(
        this.cacheFile(),
        JSON.stringify({ forVersion: this.current(), channels: this.saved }, null, 2)
      )
    } catch {
      /* caching is best effort */
    }
  }
  private cacheFile(): string {
    return join(app.getPath('userData'), 'update-check.json')
  }

  /**
   * Performs a check when *this kind* of check has not run for a day.
   *
   * Automatic and manual checks have independent 24-hour cooldowns, so the first
   * manual check of the day always asks GitHub (and can therefore see a release
   * published since the startup check), while the automatic check still runs at
   * most once a day. Neither kind refreshes the other's timestamp.
   */
  async check(kind: 'auto' | 'manual' = 'auto'): Promise<AppUpdateStatus> {
    const now = Date.now()
    // Local test affordance: `%userData%/simulate-app-update.json` fakes a newer
    // release so the update dialog / ring can be inspected offline.
    const fake = await this.fakeSpec()
    if (fake) {
      this.error = undefined
      this.info = fake
      this.lastAutoCheck = now
      this.lastManualCheck = now
      if (this.announced !== fake.version) {
        this.announced = fake.version
        this.announce(fake)
      }
      return this.status()
    }
    this.switchChannel((await AppStore.launcherSettings()).updateChannel)
    const stamp = kind === 'auto' ? this.lastAutoCheck : this.lastManualCheck
    // Fresh for this kind (≤ 24 h) → answer from the cached result.
    if (stamp && now - stamp < CHECK_CACHE_TTL) {
      this.resumeCriticalAutoStart()
      return this.status()
    }
    if (this.rateLimitedUntil > now) {
      this.resumeCriticalAutoStart()
      return this.status()
    }
    // A failed attempt is retried after a while, not on every click.
    if (this.failedAt && now - this.failedAt < FAILURE_RETRY) {
      this.resumeCriticalAutoStart()
      return this.status()
    }

    try {
      const latest = await fetchLatestRelease(this.channel)
      this.error = undefined
      this.info = latest && isNewerVersion(latest.version, this.current()) ? latest : null
      // Timestamp of the last *successful* check of this kind (persisted below).
      if (kind === 'auto') this.lastAutoCheck = now
      else this.lastManualCheck = now
      log(
        `appUpdate: ${kind} check → ${
          this.info ? `v${this.info.version} available` : 'up to date'
        } (current ${this.current()})`
      )
      const found = this.info
      if (found && this.announced !== found.version) {
        this.announced = found.version
        this.announce(found)
      }
      await this.saveCache()
    } catch (error) {
      // Keep the previous result: a failed check (network, rate limit, …) must
      // not make an already known update disappear, otherwise a paused download
      // could no longer be resumed.
      this.failedAt = now
      this.error = describeCheckError(error)
      if (/403/.test((error as Error).message)) {
        this.rateLimitedUntil = now + RATE_LIMIT_BACKOFF
        log('appUpdate: GitHub rate limit hit — next automatic check in 30 minutes')
      }
      log(`appUpdate: ${kind} check failed: ${(error as Error).message}`)
    }
    return this.status()
  }

  /** Begins the upgrade, or resumes a paused download. */
  begin(retry = false): void {
    const info = this.info
    if (!info || this.running || !SAFE_VERSION.test(info.version) ||
        !isNewerVersion(info.version, this.current())) return
    const transfer = this.pendingDataTransfer()
    if (transfer) {
      void transfer.then(() => {
        if (this.info?.version === info.version) this.begin(retry)
      }).catch((error) => log(`appUpdate: waiting for data recovery (${String(error)})`))
      return
    }
    if (this.criticalRetryTimer) {
      clearTimeout(this.criticalRetryTimer)
      this.criticalRetryTimer = null
    }
    // A manual retry after the automatic attempts are exhausted starts a fresh
    // retry budget; an automatic retry must not reset its own counter.
    if (!retry && this.state.phase === 'error') this.criticalRetries = 0
    this.patch({
      version: info.version,
      critical: info.critical === true,
      retry: this.criticalRetries
    })
    const runtimeChanged =
      !!info.electronVersion && info.electronVersion !== process.versions.electron
    if (info.payloadUrls.length === 0 && info.installerUrls.length === 0) {
      // No real asset (the local fake spec): simulate the download UI.
      if (!this.running) this.simulateFake(info)
      return
    }
    if (!app.isPackaged) {
      void shell.openExternal(info.htmlUrl)
      return
    }
    this.running = true
    // Hold on to the info for the whole run: a later (failed) check must not
    // change what is being downloaded.
    this.controller = new AbortController()
    // Log what will actually be fetched (the payload is ~0.15 MB, the installer
    // ~71 MB and only used when the runtime changed).
    const megabytes = Math.round(
      (runtimeChanged ? info.installerSize : info.payloadSize) / 1048576
    )
    log(
      `appUpdate: starting ${info.version} (${runtimeChanged ? 'installer' : 'app payload'}, ~${megabytes} MB)`
    )
    void this.run(info, this.controller).finally(() => {
      this.running = false
    })
  }

  /**
   * Pauses / resumes the **download**. The install step is intentionally not
   * pausable, so while `installing` this does nothing.
   */
  toggle(): void {
    // 重要更新不可暂停：the only way forward is to let it finish (or retry).
    if (this.info?.critical) return
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

  private async downloadVerified(options: {
    info: AppUpdateInfo
    name: string
    path: string
    size: number
    sha256: string | null
    urls: string[]
    controller: AbortController
    installer: boolean
  }): Promise<void> {
    const { info, name, path, size, sha256, urls, controller, installer } = options
    if (!isSha256(sha256)) throw new Error('更新清单缺少文件的 SHA-256')
    this.patch({
      phase: 'downloading',
      version: info.version,
      total: size,
      transferred: 0,
      percent: 0,
      message: installer ? '正在下载安装程序…' : '正在下载更新…'
    })
    if (!(await verifyPayloadDownload(path, size, sha256))) {
      await downloadWithFallback({
        version: info.version,
        name,
        primary: urls,
        size,
        dest: path,
        signal: controller.signal,
        onProgress: progress => {
          this.patch({
            percent: (progress.transferred / size) * 100,
            transferred: progress.transferred,
            total: size,
            bytesPerSecond: progress.bytesPerSecond
          })
        }
      })
      if (!(await verifyPayloadDownload(path, size, sha256))) {
        throw new Error(installer ? '安装程序校验失败（大小或 SHA-256 不匹配）' : '更新包校验失败（大小或 SHA-256 不匹配）')
      }
    }
    controller.signal.throwIfAborted()
    this.patch({ percent: 100, transferred: size, bytesPerSecond: 0 })
  }

  private async run(info: AppUpdateInfo, controller: AbortController): Promise<void> {
    const staging = join(app.getPath('userData'), 'update-staging', info.version)
    const archive = join(staging, 'app.zip')
    try {
      // A cached check from an older build may contain incomplete metadata.
      // Get the same version's manifest again before selecting an install mode.
      if (!hasVerifiedMetadata(info)) {
        const fresh = await refreshManifest(info.version)
        info = { ...fresh, critical: info.critical || fresh.critical }
        if (!hasVerifiedMetadata(info)) {
          throw new Error('缺少适合当前运行库的已校验更新文件，请手动下载安装包')
        }
        if (this.info?.version === info.version) this.info = info
      }
      controller.signal.throwIfAborted()
      if (info.electronVersion !== process.versions.electron) {
        await this.updateViaInstaller(info, staging, controller)
        return
      }

      await this.downloadVerified({
        info, name: payloadAssetName(info.version), path: archive, size: info.payloadSize,
        sha256: info.payloadSha256, urls: info.payloadUrls, controller, installer: false
      })
      this.patch({ phase: 'installing', percent: 100, installPercent: 0, message: '正在安装更新…' })
      await backupUserData(`update ${info.version}`)
      const target = join(process.resourcesPath, `app-${info.version}`)
      await extractPayload(archive, target, info.installSize, (bytes, total) => {
        this.patch({ installPercent: total > 0 ? Math.min(100, (bytes / total) * 100) : 0 })
      })
      const required = ['package.json', 'out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']
      const valid = await Promise.all(required.map(file => isRegularFile(join(target, file))))
      if (valid.some(exists => !exists)) throw new Error('更新包内容不完整')
      const metadata = JSON.parse(await fs.readFile(join(target, 'package.json'), 'utf8')) as { version?: string } | null
      if (metadata?.version !== info.version) throw new Error('更新包版本与清单不匹配')

      // 3) switch: flip the version pointer and restart into the new version.
      await this.switchTo(info.version)
      this.patch({
        phase: 'done',
        installPercent: 100,
        message: '更新完成，正在重启…',
        critical: info.critical === true
      })
      await this.clearCriticalMarker()
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
      await flushBeforeShutdown()
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
      if (info.critical && this.criticalRetries < CRITICAL_MAX_RETRIES) {
        this.criticalRetries += 1
        const attempt = this.criticalRetries
        this.patch({
          phase: 'error',
          message: `重要更新失败，正在自动重试（${attempt}/${CRITICAL_MAX_RETRIES}）…`,
          error: message,
          critical: true,
          retry: attempt
        })
        if (this.criticalRetryTimer) clearTimeout(this.criticalRetryTimer)
        this.criticalRetryTimer = setTimeout(() => {
          this.criticalRetryTimer = null
          if (!this.running && this.info?.version === info.version) this.begin(true)
        }, CRITICAL_RETRY_DELAY)
        return
      }
      this.patch({
        phase: 'error',
        message: info.critical ? '重要更新失败，请重试' : '更新失败',
        error: message,
        critical: info.critical === true
      })
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
    const name = installerAssetName(info.version)
    const installer = join(staging, name)
    await this.downloadVerified({
      info, name, path: installer, size: info.installerSize, sha256: info.installerSha256,
      urls: info.installerUrls, controller, installer: true
    })

    this.patch({
      phase: 'installing',
      percent: 100,
      installPercent: 100,
      message: '正在打开安装程序…'
    })
    // The installer takes its own snapshot immediately before writing.
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
    await writeFileAtomic(pointer, version)
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
