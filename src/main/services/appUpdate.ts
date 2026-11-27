import { app, shell } from 'electron'
import { dirname, join } from 'path'
import { promises as fs } from 'fs'
import type { AppUpdateInfo, AppUpdateState, AppUpdateStatus } from '@shared/types'
import { compareVersions, isNewerVersion, pickNewestVersion } from '@shared/version'
import { downloadPayload, extractPayload, verifyPayloadDownload } from './updateDownload'
import { backupUserData, estimateBackupBytes, requireBackup } from './dataBackup'
import {
  installerAssetName,
  isBetaVersion,
  isHotUpdateCompatible,
  isPositiveFileSize,
  isRuntimeVersion,
  isSha256,
  parseBetaVerification,
  parseUpdateManifest,
  parseUpdateCompatibility,
  payloadAssetName,
  SAFE_VERSION,
  STABLE_VERSION,
  type BetaVerification,
  type UpdateManifest
} from './appUpdateManifest'
import { currentAppVersion } from './appVersion'
import { AppStore } from './appStore'
import {
  prepareApplicationActivation, protectedApplicationVersions, rejectedApplicationVersion
} from './appActivation'
import { requireDiskSpace } from './diskSpace'
import { recordVersionedInstallation } from './install'
import { writeFileAtomic } from './atomicFile'
import { flushBeforeShutdown } from './shutdown'
import { markQuitting } from './behavior'
import { log } from './logger'
import { launcherEntryPath, trialBuild } from './buildIdentity'

/** Owner/repository used for release checks (public GitHub API). */
export const GITHUB_REPO = 'KevinYuHere/KevinLauncher'

const RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
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

/** Which releases the launcher follows. The persisted setting is the source. */
type Channel = 'stable' | 'beta'

function isVersionForChannel(version: string, channel: Channel): boolean {
  return channel === 'stable' ? STABLE_VERSION.test(version) : STABLE_VERSION.test(version) || isBetaVersion(version)
}

/**
 * A Beta artifact is always the verified full installer. Never accept a cached
 * Beta entry that still advertises a hot payload: old caches predate the
 * installer-only Beta release format.
 */
function isVerifiedBetaInstaller(info: AppUpdateInfo): boolean {
  return isBetaVersion(info.version) &&
    isPositiveFileSize(info.installerSize) && isSha256(info.installerSha256) &&
    info.installerName === installerAssetName(info.version) && info.installerUrls.length > 0 &&
    info.payloadUrls.length === 0
}

/** Cached / marker data is user-writable: never trust its version string. */
function safeInfo(info: AppUpdateInfo | null | undefined, channel: Channel): AppUpdateInfo | null {
  if (!info || typeof info.version !== 'string' ||
      !Array.isArray(info.payloadUrls) || !Array.isArray(info.installerUrls) ||
      !isVersionForChannel(info.version, channel)) return null
  if (!isBetaVersion(info.version)) return info
  if (!isVerifiedBetaInstaller(info)) return null
  return info.critical === true ? { ...info, critical: false } : info
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

/**
 * Fetch and validate each candidate; an API asset endpoint might return
 * metadata instead of the file, so the direct release URL is tried next.
 */
async function fetchVerified<T>(
  urls: string[],
  parse: (raw: string) => T,
  failure: string
): Promise<T> {
  let lastError: unknown
  for (const url of new Set(urls)) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/octet-stream', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(20_000)
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return parse(await response.text())
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error(failure)
}

function fetchManifest(urls: string[], version?: string): Promise<UpdateManifest> {
  return fetchVerified(urls, raw => parseUpdateManifest(raw, version), '无法获取更新清单')
}

function fetchBetaVerification(urls: string[], version: string): Promise<BetaVerification> {
  return fetchVerified(urls, raw => parseBetaVerification(raw, version), '无法获取 Beta 验证清单')
}

function releaseAssetUrl(version: string, asset: string): string {
  return `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${asset}`
}

/** Fixed asset names reconstructed from the release tag, API URL first. */
function releaseAssetUrls(release: GitHubRelease | undefined, version: string, name: string): string[] {
  const asset = release?.assets?.find(item => item.name === name)
  return [...new Set([...(asset ? assetUrls(asset) : []), releaseAssetUrl(version, name)])]
}

function releaseVersion(release: GitHubRelease): string {
  return String(release.tag_name ?? '').trim().replace(/^v/i, '')
}

function infoFromManifest(manifest: UpdateManifest, release?: GitHubRelease): AppUpdateInfo {
  const { version, installerName } = manifest
  const payloadName = payloadAssetName(version)
  return {
    version,
    name: release?.name?.trim() || `v${version}`,
    notes: release?.body?.trim() || manifest.notes || '',
    htmlUrl: release?.html_url ?? `https://github.com/${GITHUB_REPO}/releases/tag/v${version}`,
    payloadUrls: releaseAssetUrls(release, version, payloadName),
    payloadSize: manifest.payloadSize,
    payloadSha256: manifest.payloadSha256,
    installSize: manifest.appSize,
    electronVersion: manifest.electron,
    compatibility: manifest.compatibility,
    installerUrls: installerName ? releaseAssetUrls(release, version, installerName) : [],
    installerName,
    installerSize: manifest.installerSize,
    installerUnpackedSize: manifest.installerUnpackedSize,
    installerSha256: manifest.installerSha256,
    publishedAt: release?.published_at ?? '',
    critical: manifest.critical
  }
}

function infoFromBetaVerification(beta: BetaVerification, release?: GitHubRelease): AppUpdateInfo {
  const { version } = beta
  return {
    version,
    critical: false,
    name: release?.name?.trim() || `v${version}`,
    notes: release?.body?.trim() || '',
    htmlUrl: release?.html_url ?? `https://github.com/${GITHUB_REPO}/releases/tag/v${version}`,
    payloadUrls: [],
    payloadSize: 0,
    payloadSha256: null,
    installSize: 0,
    electronVersion: null,
    installerUrls: releaseAssetUrls(release, version, beta.installer),
    installerName: beta.installer,
    installerSize: beta.size,
    installerSha256: beta.sha256,
    publishedAt: release?.published_at ?? ''
  }
}

async function fetchReleaseViaLatestUrl(): Promise<AppUpdateInfo | null> {
  const manifest = await fetchManifest([LATEST_MANIFEST_URL])
  return STABLE_VERSION.test(manifest.version) ? infoFromManifest(manifest) : null
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
  const version = releaseVersion(release)
  if (!STABLE_VERSION.test(version) || release.draft || release.prerelease) return null
  const manifest = await fetchManifest(
    releaseAssetUrls(release, version, 'update-manifest.json'),
    version
  )
  return infoFromManifest(manifest, release)
}

/**
 * Verified public Beta: the release must carry exactly the fixed installer and
 * its `beta-verification.json`. Legacy pre-releases without that pair return
 * null so the list can fall through to a newer supported release.
 */
async function betaInfoFromRelease(release: GitHubRelease): Promise<AppUpdateInfo | null> {
  const version = releaseVersion(release)
  if (!isBetaVersion(version) || release.draft === true || release.prerelease !== true) return null
  const assets = release.assets ?? []
  const verificationAsset = assets.find(item => item.name === 'beta-verification.json')
  const installerAsset = assets.find(item => item.name === installerAssetName(version))
  if (!verificationAsset || !installerAsset) return null
  const beta = await fetchBetaVerification(
    releaseAssetUrls(release, version, 'beta-verification.json'),
    version
  )
  if (installerAsset.size !== undefined &&
      (!isPositiveFileSize(installerAsset.size) || installerAsset.size !== beta.size)) {
    throw new Error('Beta 安装包大小与 GitHub 资产不一致')
  }
  return infoFromBetaVerification(beta, release)
}

class ReleaseManifestError extends Error {}

async function refreshManifest(version: string): Promise<AppUpdateInfo> {
  if (isBetaVersion(version)) {
    let release: GitHubRelease | undefined
    try {
      release = await releaseFromTag(version)
    } catch (error) {
      log(`appUpdate: Beta release lookup failed (${(error as Error).message}) — trying the verification asset`)
    }
    if (release) {
      const info = await betaInfoFromRelease(release)
      if (!info) throw new Error('Beta 更新发布缺少已校验的安装包')
      return info
    }
    const beta = await fetchBetaVerification(
      [releaseAssetUrl(version, 'beta-verification.json')],
      version
    )
    return infoFromBetaVerification(beta)
  }
  try {
    return infoFromManifest(await fetchManifest([releaseAssetUrl(version, 'update-manifest.json')], version))
  } catch {
    const info = await infoFromRelease(await releaseFromTag(version))
    if (!info) throw new Error('更新清单版本无效')
    return info
  }
}

function hasVerifiedMetadata(info: AppUpdateInfo, useInstaller: boolean): boolean {
  if (isBetaVersion(info.version)) return useInstaller && isVerifiedBetaInstaller(info)
  if (!isRuntimeVersion(info.electronVersion)) return false
  if (useInstaller) {
    return isPositiveFileSize(info.installerSize) && isSha256(info.installerSha256) &&
      info.installerName === installerAssetName(info.version) && info.installerUrls.length > 0
  }
  return isPositiveFileSize(info.payloadSize) && isSha256(info.payloadSha256) &&
    isPositiveFileSize(info.installSize) && info.payloadUrls.length > 0
}

async function needsFullInstaller(info: AppUpdateInfo): Promise<boolean> {
  if (info.electronVersion !== process.versions.electron) return true
  try {
    const contents = await fs.readFile(join(process.resourcesPath, 'release-compatibility.json'), 'utf8')
    return !isHotUpdateCompatible(parseUpdateCompatibility(JSON.parse(contents)), info.compatibility)
  } catch {
    return true
  }
}


/** List response shared by both channels; the list order is publication time. */
async function fetchReleaseList(): Promise<GitHubRelease[] | null> {
  const response = await fetch(RELEASES_LIST_API, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000)
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`)
  const list: unknown = await response.json()
  if (!Array.isArray(list)) throw new Error('GitHub 发布列表格式无效')
  return list as GitHubRelease[]
}

/**
 * Newest stable release **by version** (GitHub itself lists by publication
 * date, so a patch published last must not hide a newer minor).
 */
async function latestStableFromList(): Promise<AppUpdateInfo | null> {
  const list = await fetchReleaseList()
  if (!list) return null
  const pool = list
    .map(release => ({
      release,
      version: releaseVersion(release),
      draft: release.draft === true,
      prerelease: release.prerelease === true
    }))
    .filter(candidate => STABLE_VERSION.test(candidate.version))
  const best = pickNewestVersion(pool, true)
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

interface ChannelCandidate {
  release: GitHubRelease
  version: string
  beta: boolean
}

/**
 * Beta channel: canonical Betas compete with stable releases by SemVer.
 * Drafts, flag/version mismatches and noncanonical tags never enter the pool.
 */
function betaCandidates(list: GitHubRelease[]): ChannelCandidate[] {
  return list
    .flatMap((release): ChannelCandidate[] => {
      if (release.draft === true) return []
      const version = releaseVersion(release)
      if (isBetaVersion(version)) {
        return release.prerelease === true ? [{ release, version, beta: true }] : []
      }
      return STABLE_VERSION.test(version) && release.prerelease !== true
        ? [{ release, version, beta: false }]
        : []
    })
    .sort((left, right) => compareVersions(right.version, left.version))
}

/** Newest supported release for the Beta channel (stable or verified Beta). */
async function latestBetaFromList(): Promise<AppUpdateInfo | null> {
  const list = await fetchReleaseList()
  if (!list) return null
  const current = currentAppVersion()
  for (const candidate of betaCandidates(list)) {
    // An offer is only ever an upgrade; do not fetch metadata for the running
    // or an older release.
    if (!isNewerVersion(candidate.version, current)) continue
    try {
      const info = candidate.beta
        ? await betaInfoFromRelease(candidate.release)
        : await infoFromRelease(candidate.release)
      if (info) return info
      if (candidate.beta) {
        log(`appUpdate: skipping Beta ${candidate.version} without a verified installer`)
      }
    } catch (cause) {
      throw new ReleaseManifestError(
        `无法验证 ${candidate.version} 的更新信息: ${(cause as Error).message}`,
        { cause }
      )
    }
  }
  return null
}

async function fetchLatestRelease(channel: Channel): Promise<AppUpdateInfo | null> {
  if (channel === 'beta') {
    try {
      return await latestBetaFromList()
    } catch (error) {
      if (error instanceof ReleaseManifestError) throw error
      log(`appUpdate: Beta release list unavailable (${(error as Error).message})`)
    }
  }

  // The list API gives the real "newest stable by version"; `releases/latest`
  // only means "newest published", which an out-of-order patch can distort.
  try {
    const info = await latestStableFromList()
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

function normalizeChannelState(state: Partial<ChannelState> | undefined, channel: Channel): ChannelState {
  return {
    auto: typeof state?.auto === 'number' && Number.isFinite(state.auto) ? state.auto : 0,
    manual: typeof state?.manual === 'number' && Number.isFinite(state.manual) ? state.manual : 0,
    failedAt: typeof state?.failedAt === 'number' && Number.isFinite(state.failedAt) ? state.failedAt : 0,
    rateLimitedUntil: typeof state?.rateLimitedUntil === 'number' && Number.isFinite(state.rateLimitedUntil)
      ? state.rateLimitedUntil : 0,
    info: safeInfo(state?.info, channel)
  }
}

export class AppUpdateChecker {
  constructor(
    private readonly pendingDataTransfer: () => Promise<void> | undefined = () => undefined,
    private readonly withUpdateBackup: (
      reason: string, apply: () => Promise<void>, checkSpace: () => Promise<void>
    ) => Promise<void> =
      async (reason, apply, checkSpace) => {
        await checkSpace()
        requireBackup(await backupUserData(reason))
        await apply()
      }
  ) {}

  private info: AppUpdateInfo | null = null
  private error: string | undefined
  private announced: string | null = null
  private listeners = new Set<(info: AppUpdateInfo) => void>()
  private stateListeners = new Set<(state: AppUpdateState) => void>()
  private state: AppUpdateState = { ...IDLE_STATE }
  private controller: AbortController | null = null
  private running = false
  private pendingVersion: string | undefined
  private activeCheck: Promise<AppUpdateStatus> | undefined
  private activeCheckChannel: Channel | undefined
  private initialCheck: Promise<void> | undefined
  private rejectedVersion: string | undefined
  private cleanupTask: Promise<void> | undefined
  private taskInfo: AppUpdateInfo | undefined
  /** Critical-update version that already auto-started (start it only once). */
  private autoStarted: string | null = null
  /** Automatic retry timer / counter for a failing critical update. */
  private criticalRetryTimer: NodeJS.Timeout | null = null
  private criticalRetries = 0
  /** Timestamp of the last successful automatic check. */
  private lastAutoCheck = 0
  /** Timestamp of the last successful manual check. */
  private lastManualCheck = 0
  /** Timestamp of the last failed attempt (retry backoff). */
  private failedAt = 0
  /** Automatic checks are skipped until this timestamp after a 403. */
  private rateLimitedUntil = 0
  /** Channel the active fields and offer belong to. */
  private channel: Channel = 'stable'
  /** Per-channel cache/cooldowns; switching channels never discards them. */
  private saved: Record<Channel, ChannelState> = {
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

  /** Which channel the persisted launcher setting selects. */
  private async readChannel(): Promise<Channel> {
    try {
      const persisted = String((await AppStore.launcherSettings()).updateChannel)
      return persisted === 'beta' ? 'beta' : 'stable'
    } catch (error) {
      // A temporarily unreadable config must not break self-update. Keep the
      // last known channel; the next check will reread the setting.
      log(`appUpdate: cannot read update channel (${(error as Error).message})`)
      return this.channel
    }
  }

  private applyChannel(channel: Channel): void {
    const state = this.saved[channel]
    this.channel = channel
    this.lastAutoCheck = state.auto
    this.lastManualCheck = state.manual
    this.failedAt = state.failedAt
    this.rateLimitedUntil = state.rateLimitedUntil
    const info = safeInfo(state.info, channel)
    this.info = info && isNewerVersion(info.version, this.current()) ? info : null
    this.announced = this.info?.version ?? null
  }

  private switchChannel(channel: Channel): void {
    if (this.channel === channel) return
    this.saved[this.channel] = this.snapshot()
    this.applyChannel(channel)
  }

  /** Currently installed version (from `resources/app-version.txt`). */
  current(): string {
    return currentAppVersion()
  }

  /** Optional release description used by a local preview build. */
  private async fakeSpec(): Promise<AppUpdateInfo | null> {
    if (!trialBuild) return null
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
    if (!trialBuild) return
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
        this.patch({ phase: 'done', percent: 100, transferred: total, installPercent: 100 })
        return
      }
      this.patch({
        percent: (transferred / total) * 100,
        transferred,
        bytesPerSecond: total / 3,
        installPercent: 0
      })
    }, 150)
  }

  status(): AppUpdateStatus {
    // A stale or cached entry must still match the active channel (a Beta must
    // never surface on stable), and an installed version is never advertised.
    const info = safeInfo(this.info, this.channel)
    if (info !== this.info) {
      this.info = info
      if (!info) this.announced = null
    }
    // Never advertise a version that is already installed: a cached result can
    // otherwise keep offering the update right after it was applied.
    if (this.info && !isNewerVersion(this.info.version, this.current())) {
      this.info = null
      this.announced = null
    }
    return {
      current: this.current(),
      hasUpdate: !!this.info,
      info: this.info,
      channel: this.channel,
      error: this.error
    }
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
    // Beta releases are installer-only and never critical.
    if (info.critical && !isBetaVersion(info.version) && this.autoStarted !== info.version) {
      this.autoStarted = info.version
      this.criticalRetries = 0
      // Persist before starting: if the app is closed mid-download (or crashes),
      // the next launch must resume instead of forgetting the critical update.
      void this.saveCriticalMarker(info)
      log(`appUpdate: v${info.version} is a critical update — starting automatically`)
      setTimeout(() => {
        // A later check may already have replaced it; never start a stale one.
        if (!this.running && this.info?.version === info.version) this.begin(false, info)
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
    if (!info.critical || isBetaVersion(info.version) ||
        (info.payloadUrls.length === 0 && info.installerUrls.length === 0)) return
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
        JSON.parse(await fs.readFile(this.criticalMarkerFile(), 'utf8')) as AppUpdateInfo,
        'stable'
      )
      if (!info?.critical || isBetaVersion(info.version) || !isNewerVersion(info.version, this.current())) {
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
    if (trialBuild) return
    void (async (): Promise<void> => {
      await this.initializeCheck()
      // A critical update cached by the previous session must still start by
      // itself (the 24h check below may legitimately be answered from cache).
      if (this.info?.critical) this.announce(this.info)
      setTimeout(() => void this.check('auto'), STARTUP_DELAY)
      setInterval(() => void this.check('auto'), CHECK_INTERVAL)
    })()
  }

  private initializeCheck(): Promise<void> {
    this.initialCheck ??= (async () => {
      this.rejectedVersion = await rejectedApplicationVersion().catch(() => undefined)
      await this.loadCache()
      await this.loadCriticalMarker()
      if (this.info?.version === this.rejectedVersion) this.info = null
      if (this.rejectedVersion) this.error = `已回到可启动版本。版本 ${this.rejectedVersion} 的完整安装包可在发布页获取。`
    })()
    return this.initialCheck
  }

  /** Result of the last checks, cached on disk for a day (per channel/kind). */
  private async loadCache(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.cacheFile(), 'utf8')) as {
        forVersion?: string
        channel?: Channel
        autoCheckedAt?: number
        manualCheckedAt?: number
        info?: AppUpdateInfo | null
        /** Current stable-only cache format. */
        state?: ChannelState
        channels?: Partial<Record<Channel, ChannelState>>
      }
      const channel = await this.readChannel()
      const current = this.current()
      if (raw.forVersion && raw.forVersion !== current) {
        log(`appUpdate: cache is for ${raw.forVersion}, current is ${current} - discarding`)
        this.applyChannel(channel)
        return
      }
      if (raw.channels && typeof raw.channels === 'object' && !Array.isArray(raw.channels)) {
        for (const key of ['stable', 'beta'] as const) {
          const state = raw.channels[key]
          if (state) this.saved[key] = normalizeChannelState(state, key)
        }
      } else {
        // Backward compatibility: the previous stable-only format stored one
        // `state` (or the older flat fields). Attribute it to its channel.
        const legacyChannel: Channel = raw.channel === 'beta' ? 'beta' : 'stable'
        const state = raw.state ?? {
          auto: raw.autoCheckedAt ?? 0,
          manual: raw.manualCheckedAt ?? 0,
          failedAt: 0,
          rateLimitedUntil: 0,
          info: raw.info
        }
        this.saved[legacyChannel] = normalizeChannelState(state, legacyChannel)
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
        JSON.stringify({
          forVersion: this.current(),
          channels: this.saved
        }, null, 2)
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
   *
   * The persisted channel is reread before every check. An in-flight check for
   * the old channel is never returned to callers on the new channel: they wait
   * for it to settle and then check again with the current setting.
   */
  async check(kind: 'auto' | 'manual' = 'auto'): Promise<AppUpdateStatus> {
    if (trialBuild) return this.checkNow(kind, this.channel)
    await this.initializeCheck()
    for (let round = 0; round < 3; round++) {
      const channel = await this.readChannel()
      if (channel !== this.channel) this.switchChannel(channel)
      if (this.activeCheck && this.activeCheckChannel === channel) return this.activeCheck
      if (this.activeCheck) {
        await this.activeCheck.catch(() => undefined)
        continue
      }
      const task = this.checkNow(kind, channel).finally(() => {
        if (this.activeCheck === task) {
          this.activeCheck = undefined
          this.activeCheckChannel = undefined
        }
      })
      this.activeCheck = task
      this.activeCheckChannel = channel
      const status = await task
      if (this.channel === channel) return status
    }
    return this.status()
  }

  /** Store a result for the channel it was fetched for, active or not. */
  private commitCheck(
    channel: Channel,
    kind: 'auto' | 'manual',
    now: number,
    info: AppUpdateInfo | null,
    error: string | undefined
  ): void {
    if (channel === this.channel) {
      this.error = error
      this.info = info
      if (kind === 'auto') this.lastAutoCheck = now
      else this.lastManualCheck = now
      return
    }
    const state = this.saved[channel]
    this.saved[channel] = {
      ...state,
      ...(kind === 'auto' ? { auto: now } : { manual: now }),
      info
    }
  }

  private async checkNow(kind: 'auto' | 'manual', channel: Channel): Promise<AppUpdateStatus> {
    const now = Date.now()
    // Local test affordance: `%userData%/simulate-app-update.json` fakes a newer
    // release so the update dialog / ring can be inspected offline.
    if (trialBuild) {
      const fake = await this.fakeSpec()
      this.error = fake ? undefined : '本地试用版使用本地模拟更新'
      this.info = fake
      this.lastAutoCheck = now
      this.lastManualCheck = now
      if (fake && this.announced !== fake.version) {
        this.announced = fake.version
        this.announce(fake)
      }
      return this.status()
    }
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
      const latest = await fetchLatestRelease(channel)
      const rejected = !!latest?.version && latest.version === this.rejectedVersion
      const info = latest && !rejected && isVersionForChannel(latest.version, channel) &&
        isNewerVersion(latest.version, this.current()) ? latest : null
      const error = rejected
        ? `已回到可启动版本。版本 ${latest!.version} 的完整安装包可在发布页获取。` : undefined
      this.commitCheck(channel, kind, now, info, error)
      log(
        `appUpdate: ${kind} ${channel} check → ${
          info ? `v${info.version} available` : 'up to date'
        } (current ${this.current()})`
      )
      if (channel === this.channel && info && this.announced !== info.version) {
        this.announced = info.version
        this.announce(info)
      }
      await this.saveCache()
    } catch (error) {
      // Keep the previous result: a failed check (network, rate limit, …) must
      // not make an already known update disappear, otherwise a paused download
      // could no longer be resumed.
      const limited = /403/.test((error as Error).message)
      if (channel === this.channel) {
        this.failedAt = now
        this.error = describeCheckError(error)
        if (limited) {
          this.rateLimitedUntil = now + RATE_LIMIT_BACKOFF
          log('appUpdate: GitHub rate limit hit — next automatic check in 30 minutes')
        }
      } else {
        const state = this.saved[channel]
        this.saved[channel] = {
          ...state,
          failedAt: now,
          ...(limited ? { rateLimitedUntil: now + RATE_LIMIT_BACKOFF } : {})
        }
      }
      log(`appUpdate: ${kind} ${channel} check failed: ${(error as Error).message}`)
    }
    return this.status()
  }

  /** Begins the upgrade, or resumes a paused download. */
  begin(retry = false, info = this.state.phase === 'error' ? this.taskInfo ?? this.info : this.info): void {
    if (!info || this.running || info.version === this.rejectedVersion || !SAFE_VERSION.test(info.version) ||
        !isNewerVersion(info.version, this.current())) return
    // Beta releases are always the installer-only path and never critical.
    if (isBetaVersion(info.version) && info.critical) info = { ...info, critical: false }
    if (trialBuild) {
      this.simulateFake(info)
      return
    }
    const transfer = this.pendingDataTransfer()
    if (transfer) {
      void transfer.then(() => {
        if (this.info?.version === info.version || this.taskInfo?.version === info.version) this.begin(retry, info)
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
    if (info.payloadUrls.length === 0 && info.installerUrls.length === 0) return
    if (!app.isPackaged) {
      void shell.openExternal(info.htmlUrl)
      return
    }
    this.running = true
    this.taskInfo = info
    // Hold on to the info for the whole run: a later (failed) check must not
    // change what is being downloaded.
    this.controller = new AbortController()
    this.pendingVersion = info.version
    void this.run(info, this.controller).finally(() => {
      this.running = false
      this.pendingVersion = undefined
    })
  }

  /**
   * Pauses / resumes the **download**. The install step is intentionally not
   * pausable, so while `installing` this does nothing.
   */
  toggle(): void {
    // 重要更新不可暂停：the only way forward is to let it finish (or retry).
    if (this.state.critical) return
    const phase = this.state.phase
    if (phase === 'downloading') {
      this.controller?.abort()
    } else if (phase === 'paused' || phase === 'error') {
      this.begin(false, this.taskInfo)
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
    let awaitingSave = false
    try {
      await this.cleanupTask
      // A cached check from an older build may contain incomplete metadata.
      // Get the same version's metadata again before selecting an install mode.
      const beta = isBetaVersion(info.version)
      let useInstaller = beta || await needsFullInstaller(info)
      if (!hasVerifiedMetadata(info, useInstaller)) {
        const fresh = await refreshManifest(info.version)
        info = { ...fresh, critical: beta ? false : info.critical || fresh.critical }
        useInstaller = beta || await needsFullInstaller(info)
        if (!hasVerifiedMetadata(info, useInstaller)) {
          throw new Error(beta
            ? 'Beta 安装包缺少已校验的大小或 SHA-256，请重新检查更新'
            : '缺少适合当前运行库的已校验更新文件，请手动下载安装包')
        }
        if (this.info?.version === info.version) this.info = info
        this.taskInfo = info
      }
      controller.signal.throwIfAborted()
      if (useInstaller) {
        await this.updateViaInstaller(info, staging, controller)
        return
      }

      await this.downloadVerified({
        info, name: payloadAssetName(info.version), path: archive, size: info.payloadSize,
        sha256: info.payloadSha256, urls: info.payloadUrls, controller, installer: false
      })
      this.patch({
        phase: 'installing', percent: 100, installPercent: 0, installTotal: info.installSize,
        message: '正在安装更新…'
      })
      const data = app.getPath('userData')
      await this.withUpdateBackup(`update ${info.version}`, async () => {
        await this.applyHotUpdate(archive, info)
      }, async () => {
        await requireDiskSpace([
          { path: data, bytes: await estimateBackupBytes(data) },
          { path: process.resourcesPath, bytes: info.installSize }
        ])
      })
      awaitingSave = true
      await flushBeforeShutdown(async () => {
        awaitingSave = false
        await prepareApplicationActivation(info.version)
      })
      await this.clearCriticalMarker()
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
      this.patch({
        phase: 'done',
        installPercent: 100,
        message: '更新完成，正在重启…',
        critical: info.critical === true
      })
      app.relaunch({ execPath: launcherEntryPath() })
      app.exit(0)
    } catch (error) {
      if (controller.signal.aborted) {
        log('appUpdate: paused')
        this.patch({ phase: 'paused', message: '已暂停' })
        return
      }
      const message = (error as Error).message
      log(`appUpdate: failed: ${message}`)
      if (awaitingSave) {
        this.patch({
          phase: 'error',
          message: '更新文件已准备好，保存失败。请保存后重试。',
          error: message,
          critical: info.critical === true
        })
        return
      }
      if (!isBetaVersion(info.version) && info.critical && this.criticalRetries < CRITICAL_MAX_RETRIES) {
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
          if (!this.running && this.taskInfo?.version === info.version) this.begin(true, info)
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

  private async applyHotUpdate(archive: string, info: AppUpdateInfo): Promise<void> {
    const resources = process.resourcesPath
    const stage = await fs.mkdtemp(join(resources, '.kevin-payload-'))
    const prepared = join(stage, 'verified')
    const target = join(resources, `app-${info.version}`)
    try {
      await extractPayload(archive, prepared, info.installSize, (bytes, total) => {
        this.patch({ installPercent: total > 0 ? Math.min(100, (bytes / total) * 100) : 0 })
      })
      const required = ['package.json', 'out/main/index.js', 'out/preload/index.js',
        'out/renderer/index.html', 'release-compatibility.json']
      const valid = await Promise.all(required.map(file => isRegularFile(join(prepared, file))))
      if (valid.some(exists => !exists)) throw new Error('更新包内容不完整')
      const metadata = JSON.parse(await fs.readFile(join(prepared, 'package.json'), 'utf8')) as { version?: string } | null
      if (metadata?.version !== info.version) throw new Error('更新包版本与清单不匹配')
      const packaged = parseUpdateCompatibility(JSON.parse(
        await fs.readFile(join(prepared, 'release-compatibility.json'), 'utf8')
      ))
      if (!isHotUpdateCompatible(packaged, info.compatibility)) throw new Error('更新包兼容信息与清单不一致')
      const existing = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      if (existing) {
        if (!existing.isDirectory() || (await protectedApplicationVersions()).has(info.version)) {
          throw new Error('待更新的程序目录仍在使用，请重新启动后再试')
        }
        await fs.rm(target, { recursive: true, force: true })
      }
      await fs.rename(prepared, target)
      await recordVersionedInstallation(dirname(resources), info.version, target)
    } finally {
      await fs.rm(stage, { recursive: true, force: true }).catch((error) => {
        log(`appUpdate: could not release staging (${String(error)})`)
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
    if (info.installerUnpackedSize) {
      await requireDiskSpace([{ path: app.getPath('temp'), bytes: info.installerUnpackedSize }])
    }

    this.patch({
      phase: 'installing',
      percent: 100,
      installPercent: 100,
      installTotal: info.installerUnpackedSize,
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

  /** Keep every version mentioned by a running instance or recoverable transaction. */
  cleanupOldVersions(): Promise<void> {
    this.cleanupTask ??= this.removeUnusedVersions().finally(() => { this.cleanupTask = undefined })
    return this.cleanupTask
  }

  private async removeUnusedVersions(): Promise<void> {
    if (!app.isPackaged) return
    try {
      const keep = await protectedApplicationVersions()
      // Only directories: the version pointer (`app-version.txt`) also starts
      // with "app-" and must never be removed.
      const entries = await fs.readdir(process.resourcesPath, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('app-')) continue
        const version = entry.name.slice(4)
        if (!SAFE_VERSION.test(version) || keep.has(version) ||
            version === this.current() || version === this.pendingVersion) continue
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
