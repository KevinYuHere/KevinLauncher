import { promises as fs } from 'fs'
import { join } from 'path'
import type { UpdateInfo } from '@shared/types'

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

function toFile(pkg: RawPkg): PackageFile {
  const url = pkg.url ?? ''
  return { url, md5: pkg.md5, size: Number(pkg.size ?? 0), name: basename(url) }
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
  url.searchParams.set('language', 'zh-cn')

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
    const branches = await getGameBranches(game)
    info.latestVersion = branches.main?.tag ?? null
    info.preDownloadVersion = branches.preDownload?.tag ?? null
    if (info.currentVersion && info.latestVersion) {
      info.hasUpdate = compareVersion(info.currentVersion, info.latestVersion) < 0
    }
    if (!info.hasUpdate) info.message = '已是最新版本'
  } catch (error) {
    info.message = (error as Error).message
  }
  return info
}

/** Read the installed game version from `<gameDir>/config.ini`. */
export async function readGameVersion(gameDir: string): Promise<string> {
  try {
    const ini = await fs.readFile(join(gameDir, 'config.ini'), 'utf-8')
    const match = /(?:^|\n)\s*game_version\s*=\s*([0-9][0-9.]*)/i.exec(ini)
    return match ? match[1].trim() : ''
  } catch {
    return ''
  }
}

interface GameBranchPackage {
  package_id?: string
  branch?: string
  password?: string
  tag?: string
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
}

function toBranchPackage(pkg: GameBranchPackage | undefined): BranchPackage | null {
  if (!pkg?.package_id || !pkg.branch || !pkg.password) return null
  return { packageId: pkg.package_id, branch: pkg.branch, password: pkg.password, tag: pkg.tag ?? '' }
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
  url.searchParams.set('language', 'zh-cn')
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
