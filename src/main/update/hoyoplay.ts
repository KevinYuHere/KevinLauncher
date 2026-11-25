import { promises as fs } from 'fs'
import { join } from 'path'
import type { UpdateInfo } from '@shared/types'
import { BuildNotFound, fetchManifest, getSophonBuild, runPool, type SophonBuild, type SophonChunk } from './sophon'
import { selectCategories } from './sophonPlan'
import { getScenario, selectionFiles } from './hoyoFiles'
import { getPatchBuild } from './sophonPatch'
import { getHoYoMetadata, HOYO_CN_LAUNCHER_ID as LAUNCHER_ID, hoyoFetch } from './hoyoNetwork'
import { validateHoYoInstall } from './hoyoInstall'
export { GAME_BIZ } from './hoyoInstall'

const API_BASE = 'https://hyp-api.mihoyo.com/hyp/hyp-connect/api'
export const GAME_IDS: Record<string, string> = {
  genshin: '1Z8W5NHUQb',
  starrail: '64kMb5iAWu',
  zzz: 'x6znKlJ0xK'
}

export type HoYoGame = 'genshin' | 'starrail' | 'zzz'

/** HoYoPlay CommonGetAsync checks HTTP, retcode, the list node, then the game. */
async function gameList<T>(
  endpoint: string, node: string, signal?: AbortSignal, channel = false
): Promise<T[]> {
  const url = new URL(API_BASE + '/' + endpoint)
  url.searchParams.set('launcher_id', LAUNCHER_ID)
  url.searchParams.set('language', Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase())
  if (channel) {
    url.searchParams.set('channel', '1')
    url.searchParams.set('sub_channel', '1')
  }
  return getHoYoMetadata(`${endpoint}_${LAUNCHER_ID}`, async token => {
    const res = await hoyoFetch(url, { signal: token })
    const json = await res.json() as { retcode?: number; message?: string; data?: Record<string, unknown> } | null
    if (!json || json.retcode !== 0) throw new Error(json?.message || endpoint + ' 返回无效结果')
    const list = json.data?.[node]
    if (!Array.isArray(list)) throw new Error(endpoint + ' 缺少 ' + node)
    return list
  }, signal, { permanentFailSafe: endpoint === 'getGames' })
}

async function gameRecord<T>(endpoint: string, node: string, game: HoYoGame, signal?: AbortSignal, channel = false): Promise<T | null> {
  const list = await gameList<T & { game: { id: string; biz: string } }>(endpoint, node, signal, channel)
  return list.find(row => row?.game?.id === GAME_IDS[game]) ?? null
}

export async function requireGameInfo(game: HoYoGame, signal: AbortSignal): Promise<void> {
  const infos = await gameList<{ id: string; biz: string; game_server_configs?: { game_id: string }[] }>('getGames', 'games', signal)
  const known = infos.some(row => row.game_server_configs?.length ? row.game_server_configs.some(server => server.game_id === GAME_IDS[game]) : row.id === GAME_IDS[game])
  if (!known) throw new Error('官方启动器未提供该游戏的配置')

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
  resListUrl: string
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
  res_list_url?: string
  version?: string
  game_pkgs?: RawPkg[]
  audio_pkgs?: (RawPkg & { language?: string })[]
}
interface RawPackage {
  version?: string
  major?: RawMajor
  patches?: RawMajor[]
}
interface RawGamePackage {
  main?: RawPackage
  pre_download?: RawPackage
}

export function downloadMode(config: HoYoGameConfig | null): 'chunk' | 'package' {
  switch (config?.defaultDownloadMode) {
    case 'DOWNLOAD_MODE_CHUNK': return 'chunk'
    case 'DOWNLOAD_MODE_FILE': return 'package'
    default: throw new Error('游戏配置缺失或下载模式不受支持')
  }
}

export function selectPackageFiles(pkg: VersionPackage, audio: string[]): PackageFile[] {
  const files = pkg.files.filter(file => !file.language)
  for (const language of audio) {
    const voice = pkg.files.find(file => file.language === language)
    if (voice) files.push(voice)
  }
  return files
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

function toVersionPackage(pkg: RawPackage | undefined, localVersion?: string): VersionPackage | null {
  if (!pkg?.major?.version) return null
  const resource = pkg.patches?.find(patch => patch.version === localVersion) ?? pkg.major
  const files = [...(resource.game_pkgs ?? []), ...(resource.audio_pkgs ?? [])].map(toFile)
  return { version: pkg.major.version, resListUrl: pkg.major.res_list_url ?? '', files, sizeBytes: files.reduce((sum, file) => sum + file.size, 0) }
}

export async function getHoYoPackages(
  game: HoYoGame, localVersion?: string, signal?: AbortSignal
): Promise<{ main: VersionPackage | null; preDownload: VersionPackage | null }> {
  const row = await gameRecord<RawGamePackage>('getGamePackages', 'game_packages', game, signal)
  return { main: toVersionPackage(row?.main, localVersion), preDownload: toVersionPackage(row?.pre_download, localVersion) }
}

/** Advertised update size: patch delta when available, else the chunk build total. */
async function computeTargetSize(
  main: BranchPackage, branch: BranchPackage, localVersion: string | null, audio: string[], scenario: string,
  filters: { ignoreFields: string[]; blacklist: string[] }, delta: boolean
): Promise<number> {
  const selected = <T extends { categories: { categoryId: string }[] }>(build: T, which: BranchPackage) =>
    selectCategories(build, which, audio, filters.ignoreFields, scenario)
  if (localVersion && branch.diffTags.includes(localVersion)) {
    const patch = selected(await getPatchBuild(branch), branch)
    return patch.categories.reduce((sum, category) => sum + (category.versions[localVersion]?.compressedSize ?? 0), 0)
  }
  if (!delta || !localVersion) {
    const build = selected(await getSophonBuild(branch), branch)
    return build.categories.reduce((sum, category) => sum + category.compressedSize, 0)
  }
  const oldChunks = new Set<string>()
  const old = await getSophonBuild(main, localVersion).catch(error => {
    if (error instanceof BuildNotFound) return null
    throw error
  })
  const excluded = new Set(filters.blacklist)
  async function collect(build: SophonBuild, visit: (chunk: SophonChunk) => void) {
    await runPool(build.categories, 8, async category => {
      for (const file of await fetchManifest(category)) {
        if (!excluded.has(file.name)) for (const chunk of file.chunks) visit(chunk)
      }
    })
  }
  if (old) await collect(selected(old, main), chunk => oldChunks.add(chunk.name))
  let total = 0
  await collect(selected(await getSophonBuild(branch), branch), chunk => {
    if (!oldChunks.has(chunk.name)) {
      oldChunks.add(chunk.name)
      total += chunk.size
    }
  })
  return total
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
    try {
      info.currentVersion = (await validateHoYoInstall(gameDir, game)).get('game_version') ?? null
    } catch (error) {
      info.supported = false
      throw error
    }
    let latest: string | null = null
    let pd: string | null = null
    let mainBranch: BranchPackage | null = null
    let preBranch: BranchPackage | null = null
    const config = await getGameConfig(game)
    const mode = downloadMode(config)
    const audio = await detectAudioLanguages(game, gameDir)
    if (mode === 'chunk') {
      const branches = await getGameBranches(game)
      mainBranch = branches.main
      preBranch = branches.preDownload
      latest = mainBranch?.tag ?? null
      pd = preBranch?.tag ?? null
    } else {
      const packages = await getHoYoPackages(game, info.currentVersion ?? undefined)
      latest = packages.main?.version ?? null
      pd = packages.preDownload?.version ?? null
      const size = (pkg: VersionPackage | null): number =>
        pkg ? selectPackageFiles(pkg, audio).reduce((sum, file) => sum + file.size, 0) : 0
      info.mainSizeBytes = size(packages.main)
      info.preDownloadSizeBytes = size(packages.preDownload)
    }
    if (!latest) throw new Error('未找到游戏资源')
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
      const langs = audioEnumNames(audio)
      info.preDownloadFinished =
        (await readPredownloadMarker(gameDir)) === `${info.currentVersion},${pd},${langs}`
    }
    if (mainBranch && config && (info.hasUpdate || info.preDownloadVersion)) {
      const filters = await selectionFiles(game, gameDir, config)
      const scenario = await getScenario(gameDir, config)
      if (info.hasUpdate) info.mainSizeBytes = await computeTargetSize(mainBranch, mainBranch, info.currentVersion, audio, scenario, filters, false)
      if (preBranch && info.preDownloadVersion) {
        info.preDownloadSizeBytes = await computeTargetSize(mainBranch, preBranch, info.currentVersion, audio, scenario, filters, true)
      }
    }
    if (!info.hasUpdate) {
      info.message = info.preDownloadVersion
        ? `可预下载 ${info.preDownloadVersion}`
        : '已是最新版本'
    }
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
 * Voice languages already installed — KevinLauncher has no voice-language setting.
 * Two sources are combined:
 * - the legacy `Audio_<lang>_pkg_version` marker files in the game root, and
 * - the voice-asset folders (`.../AudioAssets/Chinese`, `English(US)`, …), which
 *   newer installs use instead of (or in addition to) the markers.
 * Checking only the markers under-reports the languages (Genshin 7.x ships three
 * voice packs with a single Chinese marker), which made the advertised
 * pre-download size too small.
 */
export async function detectAudioLanguages(
  game: 'genshin' | 'starrail' | 'zzz',
  gameDir: string
): Promise<string[]> {
  const markers: Record<string, string> = {
    'zh-cn': 'Audio_Chinese_pkg_version',
    'en-us': 'Audio_English(US)_pkg_version',
    'ja-jp': 'Audio_Japanese_pkg_version',
    'ko-kr': 'Audio_Korean_pkg_version'
  }
  const folders: Record<string, string[]> = {
    'zh-cn': ['Chinese'],
    'en-us': ['English(US)', 'English'],
    'ja-jp': ['Japanese'],
    'ko-kr': ['Korean']
  }
  const audioDirs: Record<'genshin' | 'starrail' | 'zzz', string[]> = {
    genshin: ['YuanShen_Data/StreamingAssets/AudioAssets'],
    starrail: [
      'StarRail_Data/Persistent/AudioAssets',
      'StarRail_Data/StreamingAssets/AudioAssets'
    ],
    zzz: ['ZenlessZoneZero_Data/StreamingAssets/AudioAssets']
  }
  const installed: string[] = []
  for (const field of ['zh-cn', 'en-us', 'ja-jp', 'ko-kr']) {
    let found = false
    try {
      await fs.access(join(gameDir, markers[field]))
      found = true
    } catch {
      /* no marker file */
    }
    if (!found) {
      for (const relative of audioDirs[game] ?? []) {
        for (const folder of folders[field]) {
          try {
            const stat = await fs.stat(join(gameDir, ...relative.split('/'), folder))
            if (stat.isDirectory()) {
              found = true
              break
            }
          } catch {
            /* no such voice folder */
          }
        }
        if (found) break
      }
    }
    if (found) installed.push(field)
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
  return fields.length === 0 ? 'None' : fields
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
  categories?: BranchCategory[]
}
interface GameBranchEntry {
  main?: GameBranchPackage
  pre_download?: GameBranchPackage
}

interface BranchCategory { category_id: string; matching_field: string; type: string; scenarios: string[] }

export interface BranchPackage {
  categories: BranchCategory[]
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
    categories: pkg.categories ?? [],
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
  game: HoYoGame, signal?: AbortSignal
): Promise<{ main: BranchPackage | null; preDownload: BranchPackage | null }> {
  const entry = await gameRecord<GameBranchEntry>('getGameBranches', 'game_branches', game, signal)
  return { main: toBranchPackage(entry?.main), preDownload: toBranchPackage(entry?.pre_download) }
}

export interface HoYoGameConfig {
  defaultDownloadMode: string
  audioScanDir: string
  audioResDir: string
  audioCacheDir: string
  resCategoryDir: string
  localResDir: string
  localResCacheDir: string
  gameResCutDir: string
  blacklistDir: string
  enableScenario: boolean
  scenarioFile: string
  enableBlacklist: boolean
  enableAudioPkgMgmt: boolean
}

/** Launcher config: download mode, audio dirs, resource-category / blacklist. */
export async function getGameConfig(game: HoYoGame, signal?: AbortSignal): Promise<HoYoGameConfig | null> {
  const c = await gameRecord<{
    default_download_mode?: string
    audio_pkg_scan_dir?: string
    audio_pkg_res_dir?: string
    audio_pkg_cache_dir?: string
    res_category_dir?: string
    local_res_dir?: string
    local_res_cache_dir?: string
    game_res_cut_dir?: string
    blacklist_dir?: string
    enable_scenario_pkg?: boolean
    local_scenario_config_path?: string
    enable_resource_blacklist?: boolean
    enable_audio_pkg_mgmt?: boolean
  }>('getGameConfigs', 'launch_configs', game, signal)
  if (!c) return null
  return {
    defaultDownloadMode: c.default_download_mode ?? '',
    audioScanDir: c.audio_pkg_scan_dir ?? '',
    audioResDir: c.audio_pkg_res_dir ?? '',
    audioCacheDir: c.audio_pkg_cache_dir ?? '',
    resCategoryDir: c.res_category_dir ?? '',
    localResDir: c.local_res_dir ?? '',
    localResCacheDir: c.local_res_cache_dir ?? '',
    gameResCutDir: c.game_res_cut_dir ?? '',
    blacklistDir: c.blacklist_dir ?? '',
    enableScenario: !!c.enable_scenario_pkg,
    scenarioFile: c.local_scenario_config_path ?? '',
    enableBlacklist: !!c.enable_resource_blacklist,
    enableAudioPkgMgmt: !!c.enable_audio_pkg_mgmt
  }
}

export interface ComponentPackage extends PackageFile { version: string }
export interface GamePlugin extends ComponentPackage { pluginId: string; command: string; validation: string }

export async function getGamePlugins(game: HoYoGame, signal?: AbortSignal): Promise<GamePlugin[]> {
  const entry = await gameRecord<{ plugins: {
    plugin_id: string; version: string; plugin_pkg: RawPkg & { command?: string; validation?: string }
  }[] }>('getGamePlugins', 'plugin_releases', game, signal)
  return (entry?.plugins ?? []).filter(item => !item.plugin_pkg.url?.toUpperCase().includes('DXSETUP')).map(item => ({
    ...toFile(item.plugin_pkg), version: item.version, pluginId: item.plugin_id,
    command: item.plugin_pkg.command ?? '', validation: item.plugin_pkg.validation ?? ''
  }))
}

export interface ChannelSDK extends ComponentPackage { pkgVersionFile: string }

export async function getGameChannelSDK(game: HoYoGame, signal?: AbortSignal): Promise<ChannelSDK | null> {
  const entry = await gameRecord<{ version: string; channel_sdk_pkg: RawPkg; pkg_version_file_name?: string }>(
    'getGameChannelSDKs', 'game_channel_sdks', game, signal, true
  )
  return entry ? { ...toFile(entry.channel_sdk_pkg), version: entry.version, pkgVersionFile: entry.pkg_version_file_name ?? '' } : null
}

export async function getWPFPackage(game: HoYoGame, signal?: AbortSignal): Promise<ComponentPackage | null> {
  const entry = await gameRecord<{ wpf_package: RawPkg & { version: string } }>(
    'getWPFPackages', 'wpf_packages', game, signal
  )
  return entry?.wpf_package ? { ...toFile(entry.wpf_package), version: entry.wpf_package.version } : null
}

export async function getGameDeprecatedFiles(game: HoYoGame, signal?: AbortSignal): Promise<string[]> {
  const entry = await gameRecord<{ deprecated_files?: { name: string }[] }>(
    'getGameDeprecatedFileConfigs', 'deprecated_file_configs', game, signal, true
  )
  return (entry?.deprecated_files ?? []).map(file => file.name)
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
