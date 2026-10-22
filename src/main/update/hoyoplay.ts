import { promises as fs } from 'fs'
import { join } from 'path'
import type { UpdateInfo } from '@shared/types'
import { getSophonBuild, isLanguageField } from './sophon'
import { getPatchBuild } from './sophonPatch'

const API_BASE = 'https://hyp-api.mihoyo.com/hyp/hyp-connect/api'
/** China official HoYoPlay launcher id (Global is VYTpXlbWo8). */
const LAUNCHER_ID = 'jGHBHlcOq1'
const GAME_IDS: Record<string, string> = {
  genshin: '1Z8W5NHUQb',
  starrail: '64kMb5iAWu',
  zzz: 'x6znKlJ0xK'
}

export interface PackageFile {
  url: string
  md5?: string
  size: number
  name: string
  /** Voice-language field for audio packages (`zh-cn`, …); absent for game pkgs. */
  language?: string
}

export interface VersionPackage {
  version: string
  files: PackageFile[]
  sizeBytes: number
}

interface RawPkg {
  url?: string
  md5?: string
  size?: string
}
interface RawMajor {
  version?: string
  game_pkgs?: RawPkg[]
  audio_pkgs?: (RawPkg & { language?: string })[]
}
interface RawPackage {
  version?: string
  major?: RawMajor
}
interface RawGamePackage {
  main?: RawPackage
  pre_download?: RawPackage
}

function basename(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'package.zip')
  } catch {
    return 'package.zip'
  }
}

function toFile(pkg: RawPkg & { language?: string }): PackageFile {
  const url = pkg.url ?? ''
  return {
    url,
    md5: pkg.md5,
    size: Number(pkg.size ?? 0),
    name: basename(url),
    language: pkg.language
  }
}

function toVersionPackage(pkg: RawPackage | undefined): VersionPackage | null {
  if (!pkg?.major) return null
  const files: PackageFile[] = []
  for (const item of pkg.major.game_pkgs ?? []) if (item.url) files.push(toFile(item))
  for (const item of pkg.major.audio_pkgs ?? []) if (item.url) files.push(toFile(item))
  if (files.length === 0) return null
  return {
    version: pkg.major.version ?? pkg.version ?? '',
    files,
    sizeBytes: files.reduce((sum, file) => sum + file.size, 0)
  }
}

export async function getHoYoPackages(
  game: 'genshin' | 'starrail' | 'zzz'
): Promise<{ main: VersionPackage | null; preDownload: VersionPackage | null }> {
  const url = new URL(`${API_BASE}/getGamePackages`)
  url.searchParams.set('launcher_id', LAUNCHER_ID)
  url.searchParams.set('game_ids[]', GAME_IDS[game])
  url.searchParams.set('language', 'en-us')

  const res = await fetch(url.toString(), { headers: { 'User-Agent': 'Mozilla/5.0' } })
  const json = (await res.json()) as {
    retcode: number
    message: string
    data?: { game_packages?: RawGamePackage[] }
  }
  if (json.retcode !== 0) throw new Error(json.message || `HoYoPlay 接口返回 ${json.retcode}`)
  const pkg = json.data?.game_packages?.[0]
  return {
    main: toVersionPackage(pkg?.main),
    preDownload: toVersionPackage(pkg?.pre_download)
  }
}

/** Advertised update size: patch delta when available, else the chunk build total. */
async function computeTargetSize(
  branch: BranchPackage,
  localVersion: string | null,
  audio: string[]
): Promise<number> {
  const wanted = (field: string): boolean => !isLanguageField(field) || audio.includes(field)
  try {
    const patch = await getPatchBuild(branch)
    if (localVersion) {
      let sum = 0
      for (const category of patch.categories) {
        if (!wanted(category.matchingField)) continue
        sum += category.versions[localVersion]?.compressedSize ?? 0
      }
      if (sum > 0) return sum
    }
  } catch {
    /* no patch build */
  }
  try {
    const build = await getSophonBuild(branch)
    let sum = 0
    for (const category of build.categories) {
      if (!wanted(category.matchingField)) continue
      sum += category.compressedSize
    }
    return sum
  } catch {
    return 0
  }
}

export async function getHoYoUpdateInfo(
  game: 'genshin' | 'starrail' | 'zzz',
  gameDir: string
): Promise<UpdateInfo> {
  const info: UpdateInfo = {
    game,
    currentVersion: null,
    latestVersion: null,
    preDownloadVersion: null,
    hasUpdate: false,
    supported: true,
    mainSizeBytes: 0,
    preDownloadSizeBytes: 0
  }
  try {
    info.currentVersion = (await readGameVersion(gameDir)) || null
    let latest: string | null = null
    let pd: string | null = null
    let mainBranch: BranchPackage | null = null
    let preBranch: BranchPackage | null = null
    try {
      const branches = await getGameBranches(game)
      mainBranch = branches.main
      preBranch = branches.preDownload
      latest = mainBranch?.tag ?? null
      pd = preBranch?.tag ?? null
    } catch {
      /* branch API unavailable — fall back to the package API below */
    }
    if (!latest) {
      const packages = await getHoYoPackages(game)
      latest = packages.main?.version ?? null
      pd = packages.preDownload?.version ?? null
    }
    info.latestVersion = latest
    if (info.currentVersion && latest) {
      info.hasUpdate = compareVersion(info.currentVersion, latest) < 0
    }
    // Starward only offers a pre-download when it is *newer* than the installed
    // version (`predownload > local`); completion is recorded by a
    // `predownload=local,version` marker in the game's config.ini.
    const pdNewer = !!info.currentVersion && !!pd && compareVersion(info.currentVersion, pd) < 0
    info.preDownloadVersion = pdNewer ? pd : null
    if (pdNewer && info.currentVersion && pd) {
      const langs = audioEnumNames(await detectAudioLanguages(gameDir))
      info.preDownloadFinished =
        (await readPredownloadMarker(gameDir)) === `${info.currentVersion},${pd},${langs}`
    }
    // F35: advertised sizes (patch delta, or the chunk build total).
    try {
      const audio = await detectAudioLanguages(gameDir)
      if (mainBranch) {
        info.mainSizeBytes = await computeTargetSize(mainBranch, info.currentVersion, audio)
      }
      if (preBranch && info.preDownloadVersion) {
        info.preDownloadSizeBytes = await computeTargetSize(preBranch, info.currentVersion, audio)
      }
    } catch {
      /* sizes are best-effort */
    }
    if (!info.hasUpdate) info.message = '已是最新版本'
  } catch (error) {
    info.message = (error as Error).message
  }
  return info
}

/** Read the installed game version from `<gameDir>/config.ini` (last match, like Starward). */
export async function readGameVersion(gameDir: string): Promise<string> {
  try {
    const ini = await fs.readFile(join(gameDir, 'config.ini'), 'utf-8')
    const matches = [...ini.matchAll(/(?:^|\n)\s*game_version\s*=\s*([0-9][0-9.]*)/gi)]
    const value = matches.length ? (matches[matches.length - 1][1] ?? '').trim() : ''
    // `.NET Version.TryParse` accepts 1–4 numeric parts; reject anything else.
    return /^\d+(\.\d+){0,3}$/.test(value) ? value : ''
  } catch {
    return ''
  }
}

/** The `predownload=` marker Starward writes into `config.ini` (or null). */
export async function readPredownloadMarker(gameDir: string): Promise<string | null> {
  try {
    const ini = await fs.readFile(join(gameDir, 'config.ini'), 'utf-8')
    const matches = [...ini.matchAll(/(?:^|\n)\s*predownload\s*=\s*([^\r\n]*)/gi)]
    const value = matches.length ? matches[matches.length - 1][1].trim() : ''
    return value || null
  } catch {
    return null
  }
}

/**
 * Voice languages already installed — KevinLauncher has no voice-language setting,
 * so the `Audio_<lang>_pkg_version` files in the game root are the source (a
 * player may have several).
 */
export async function detectAudioLanguages(gameDir: string): Promise<string[]> {
  const table: [string, string][] = [
    ['Audio_Chinese_pkg_version', 'zh-cn'],
    ['Audio_English(US)_pkg_version', 'en-us'],
    ['Audio_Japanese_pkg_version', 'ja-jp'],
    ['Audio_Korean_pkg_version', 'ko-kr']
  ]
  const installed: string[] = []
  for (const [file, field] of table) {
    try {
      await fs.access(join(gameDir, file))
      installed.push(field)
    } catch {
      /* not installed */
    }
  }
  return installed
}

/** Format voice languages like Starward's `AudioLanguage.ToString()` ("Chinese, Japanese"). */
export function audioEnumNames(fields: string[]): string {
  const names: Record<string, string> = {
    'zh-cn': 'Chinese',
    'en-us': 'English',
    'ja-jp': 'Japanese',
    'ko-kr': 'Korean'
  }
  return fields
    .map((field) => names[field])
    .filter((name): name is string => !!name)
    .join(', ')
}

interface GameBranchPackage {
  package_id?: string
  branch?: string
  password?: string
  tag?: string
  diff_tags?: string[]
}
interface GameBranchEntry {
  main?: GameBranchPackage
  pre_download?: GameBranchPackage
}

export interface BranchPackage {
  packageId: string
  branch: string
  password: string
  tag: string
  /** Install versions a patch (diff) build can update from. */
  diffTags: string[]
}

function toBranchPackage(pkg: GameBranchPackage | undefined): BranchPackage | null {
  if (!pkg?.package_id || !pkg.branch || !pkg.password) return null
  return {
    packageId: pkg.package_id,
    branch: pkg.branch,
    password: pkg.password,
    tag: pkg.tag ?? '',
    diffTags: Array.isArray(pkg.diff_tags) ? pkg.diff_tags : []
  }
}

/**
 * The correct latest version comes from the chunk ("branch") API, not from
 * `getGamePackages` (whose `main.major` is the older full-package version).
 */
export async function getGameBranches(
  game: 'genshin' | 'starrail' | 'zzz'
): Promise<{ main: BranchPackage | null; preDownload: BranchPackage | null }> {
  const url = new URL(`${API_BASE}/getGameBranches`)
  url.searchParams.set('launcher_id', LAUNCHER_ID)
  url.searchParams.set('game_ids[]', GAME_IDS[game])
  url.searchParams.set('language', 'en-us')
  const res = await fetch(url.toString(), { headers: { 'User-Agent': 'Mozilla/5.0' } })
  const json = (await res.json()) as {
    retcode: number
    message: string
    data?: { game_branches?: GameBranchEntry[] }
  }
  if (json.retcode !== 0) throw new Error(json.message || `getGameBranches 返回 ${json.retcode}`)
  const entry = json.data?.game_branches?.[0]
  return {
    main: toBranchPackage(entry?.main),
    preDownload: toBranchPackage(entry?.pre_download)
  }
}

export interface HoYoGameConfig {
  defaultDownloadMode: string
  audioScanDir: string
  audioResDir: string
  audioCacheDir: string
  resCategoryDir: string
  blacklistDir: string
  enableBlacklist: boolean
  enableAudioPkgMgmt: boolean
}

/** Launcher config: download mode, audio dirs, resource-category / blacklist. */
export async function getGameConfig(
  game: 'genshin' | 'starrail' | 'zzz'
): Promise<HoYoGameConfig | null> {
  const url = new URL(`${API_BASE}/getGameConfigs`)
  url.searchParams.set('launcher_id', LAUNCHER_ID)
  url.searchParams.set('game_ids[]', GAME_IDS[game])
  url.searchParams.set('language', 'en-us')
  const res = await fetch(url.toString(), { headers: { 'User-Agent': 'Mozilla/5.0' } })
  const json = (await res.json()) as {
    retcode: number
    message: string
    data?: {
      launch_configs?: {
        default_download_mode?: string
        audio_pkg_scan_dir?: string
        audio_pkg_res_dir?: string
        audio_pkg_cache_dir?: string
        res_category_dir?: string
        blacklist_dir?: string
        enable_resource_blacklist?: boolean
        enable_audio_pkg_mgmt?: boolean
      }[]
    }
  }
  if (json.retcode !== 0) throw new Error(json.message || `getGameConfigs 返回 ${json.retcode}`)
  const c = json.data?.launch_configs?.[0]
  if (!c) return null
  return {
    defaultDownloadMode: c.default_download_mode ?? '',
    audioScanDir: c.audio_pkg_scan_dir ?? '',
    audioResDir: c.audio_pkg_res_dir ?? '',
    audioCacheDir: c.audio_pkg_cache_dir ?? '',
    resCategoryDir: c.res_category_dir ?? '',
    blacklistDir: c.blacklist_dir ?? '',
    enableBlacklist: !!c.enable_resource_blacklist,
    enableAudioPkgMgmt: !!c.enable_audio_pkg_mgmt
  }
}

export async function getGameChannelSDK(
  game: 'genshin' | 'starrail' | 'zzz'
): Promise<string | null> {
  const url = new URL(`${API_BASE}/getGameChannelSDKs`)
  url.searchParams.set('launcher_id', LAUNCHER_ID)
  url.searchParams.set('game_ids[]', GAME_IDS[game])
  url.searchParams.set('language', 'en-us')
  const res = await fetch(url.toString(), { headers: { 'User-Agent': 'Mozilla/5.0' } })
  const json = (await res.json()) as {
    retcode: number
    data?: { game_channel_sdks?: { version?: string }[] }
  }
  return json.data?.game_channel_sdks?.[0]?.version ?? null
}

export async function getGameDeprecatedFiles(
  game: 'genshin' | 'starrail' | 'zzz'
): Promise<string[]> {
  const url = new URL(`${API_BASE}/getGameDeprecatedFileConfigs`)
  url.searchParams.set('launcher_id', LAUNCHER_ID)
  url.searchParams.set('game_ids[]', GAME_IDS[game])
  url.searchParams.set('language', 'en-us')
  const res = await fetch(url.toString(), { headers: { 'User-Agent': 'Mozilla/5.0' } })
  const json = (await res.json()) as {
    retcode: number
    data?: { deprecated_file_configs?: { deprecated_files?: { name?: string }[] }[] }
  }
  return (json.data?.deprecated_file_configs?.[0]?.deprecated_files ?? [])
    .map((file) => file.name)
    .filter((name): name is string => !!name)
}

export async function getWPFPackageVersion(
  game: 'genshin' | 'starrail' | 'zzz'
): Promise<string | null> {
  const url = new URL(`${API_BASE}/getWPFPackages`)
  url.searchParams.set('launcher_id', LAUNCHER_ID)
  url.searchParams.set('game_ids[]', GAME_IDS[game])
  url.searchParams.set('language', 'en-us')
  const res = await fetch(url.toString(), { headers: { 'User-Agent': 'Mozilla/5.0' } })
  const json = (await res.json()) as {
    retcode: number
    data?: { wpf_packages?: { wpf_package?: { version?: string } }[] }
  }
  return json.data?.wpf_packages?.[0]?.wpf_package?.version ?? null
}
/** Numeric dotted-version comparison. */
export function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}
