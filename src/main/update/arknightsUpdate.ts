import { promises as fs } from 'fs'
import { join, basename } from 'path'
import { createDecipheriv } from 'crypto'
import type { UpdateInfo } from '@shared/types'
import { compareVersions } from '@shared/version'
import { writeFileAtomic } from '../services/atomicFile'

const API_URL = 'https://launcher.hypergryph.com/api/proxy/batch_proxy'
const APP_CODE = 'GzD1CpaWgmSq1wew'
const LAUNCHER_APP_CODE = 'abYeZZ16BPluCFyT'
const CHANNEL = '1'
const SUB_CHANNEL = '1'
const SEQ = '5'

/** AES-256-CBC key/IV used by the Arknights client for its config files. */
const AES_KEY = Buffer.from([
  0xc0, 0xf3, 0x0e, 0x1c, 0xe7, 0x63, 0xbb, 0xc2, 0x1c, 0xc3, 0x55, 0xa3, 0x43, 0x03, 0xac, 0x50,
  0x39, 0x94, 0x44, 0xbf, 0xf6, 0x8c, 0x4a, 0x22, 0xaf, 0x39, 0x8c, 0x0a, 0x16, 0x6e, 0xe1, 0x43
])
const AES_IV = Buffer.from([
  0x33, 0x46, 0x78, 0x61, 0x19, 0x27, 0x50, 0x64, 0x95, 0x01, 0x93, 0x72, 0x64, 0x60, 0x84, 0x00
])

export interface AkPack {
  url: string
  md5?: string
  size: number
  name: string
}

/**
 * The incremental ("v2") update package: a set of (possibly split) AES
 * encrypted zip volumes plus the plaintext `patch.json` manifest URL and the
 * decryption key. Applying it only downloads the changed data (~0.8 GB) instead
 * of the full package (~20 GB).
 */
export interface AkPatch {
  parts: AkPack[]
  /** WinZip AES password for the archive (from `patch.cd_key`). */
  cdKey?: string
  infoUrl?: string
  infoMd5?: string
  /** Total bytes to download. */
  size: number
  /** Version this patch updates to (pre-download patches carry their own). */
  version?: string
}

export interface AkLatest {
  action: number
  version: string
  packs: AkPack[]
  patch: AkPatch | null
  /** Pre-download package offered ahead of the release (`pre_patch`). */
  prePatch: AkPatch | null
}

interface RawPack {
  url?: string
  md5?: string
  package_size?: string
}

interface RawPatch {
  url?: string
  md5?: string
  package_size?: string
  patches?: RawPack[]
  cd_key?: string
  v2_patch_info_url?: string
  v2_patch_info_md5?: string
  version?: string
  client_version?: string
}

interface RawResponse {
  code?: number
  message?: string
  proxy_rsps?: {
    kind?: string
    get_latest_game_rsp?: {
      action?: number
      version?: string
      request_version?: string
      pkg?: { packs?: RawPack[] }
      patch?: RawPatch | null
      pre_patch?: RawPatch | null
    }
  }[]
}

/** Decrypt an Arknights config file (AES-256-CBC) to a UTF-8 string. */
function decryptConfig(buffer: Buffer): string {
  try {
    const decipher = createDecipheriv('aes-256-cbc', AES_KEY, AES_IV)
    return Buffer.concat([decipher.update(buffer), decipher.final()]).toString('utf8')
  } catch {
    return ''
  }
}

/** Read the installed client version from `<gameDir>/config.ini`. */
export async function readLocalVersion(gameDir: string): Promise<string> {
  try {
    const raw = await fs.readFile(join(gameDir, 'config.ini'))
    const text = decryptConfig(raw)
    const match = /(?:^|\n)\s*version\s*=\s*([^\r\n]+)/i.exec(text)
    return match ? match[1].trim() : ''
  } catch {
    return ''
  }
}

export async function getArknightsLatest(localVersion: string): Promise<AkLatest> {
  const body = {
    seq: SEQ,
    proxy_reqs: [
      {
        kind: 'get_latest_game',
        get_latest_game_req: {
          appcode: APP_CODE,
          launcher_app_code: LAUNCHER_APP_CODE,
          channel: CHANNEL,
          sub_channel: SUB_CHANNEL,
          version: localVersion
        }
      }
    ]
  }
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const json = (await res.json()) as RawResponse
  const rsp = json.proxy_rsps?.find((x) => x.kind === 'get_latest_game')?.get_latest_game_rsp
  if (!rsp) {
    const message = json.message ?? ''
    if (!res.ok || /patchExist|not\s*found/i.test(message)) {
      return { action: 0, version: localVersion, packs: [], patch: null, prePatch: null }
    }
    throw new Error(message || '鹰角接口返回异常')
  }
  const packs = toPacks(rsp.pkg?.packs)
  return {
    action: rsp.action ?? 0,
    version: rsp.version ?? '',
    packs,
    patch: toPatch(rsp.patch),
    prePatch: toPatch(rsp.pre_patch)
  }
}

/** Map a raw `patch` / `pre_patch` block to an `AkPatch` (null when unusable). */
function toPatch(raw: RawPatch | null | undefined): AkPatch | null {
  if (!raw) return null
  const parts = toPacks(raw.patches)
  if (parts.length === 0) return null
  return {
    parts,
    cdKey: raw.cd_key,
    infoUrl: raw.v2_patch_info_url,
    infoMd5: raw.v2_patch_info_md5,
    size: parts.reduce((sum, part) => sum + part.size, 0),
    version: raw.version
  }
}

/** Map the raw `packs` array to `AkPack`s, deriving a file name from the URL. */
function toPacks(raw: RawPack[] | undefined): AkPack[] {
  return (raw ?? [])
    .filter((p) => p.url)
    .map((p) => {
      const url = p.url as string
      let name = 'package.zip'
      try {
        name = basename(new URL(url).pathname)
      } catch {
        /* keep default */
      }
      return { url, md5: p.md5, size: Number(p.package_size ?? 0), name }
    })
}

/**
 * Predownload staging for Arknights — deliberately separate from the miHoYo
 * flow: parts land in `<gameDir>/_kl_pre/<version>/` and the formal update
 * reuses them instead of downloading again.
 */
export interface AkPredownloadState {
  version: string
  ready: boolean
  total: number
  parts: { name: string; size: number; md5?: string }[]
}

export function akPredownloadDir(gameDir: string, version: string): string {
  return join(gameDir, '_kl_pre', version)
}

/** Newest staged predownload (if any). */
export async function readAkPredownloadState(gameDir: string): Promise<AkPredownloadState | null> {
  try {
    const root = join(gameDir, '_kl_pre')
    const versions = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    if (versions.length === 0) return null
    versions.sort(compareVersions)
    const version = versions[versions.length - 1]
    const raw = await fs.readFile(join(root, version, 'state.json'), 'utf-8')
    const state = JSON.parse(raw) as AkPredownloadState
    return state?.version === version ? state : null
  } catch {
    return null
  }
}

export async function writeAkPredownloadState(
  gameDir: string,
  state: AkPredownloadState
): Promise<void> {
  const dir = akPredownloadDir(gameDir, state.version)
  await fs.mkdir(dir, { recursive: true })
  await writeFileAtomic(join(dir, 'state.json'), JSON.stringify(state, null, 2))
}

/** Drop every staged predownload (after the formal update applied them). */
export async function clearAkPredownload(gameDir: string): Promise<void> {
  await fs.rm(join(gameDir, '_kl_pre'), { recursive: true, force: true }).catch(() => undefined)
}

export async function getArknightsUpdateInfo(gameDir: string): Promise<UpdateInfo> {
  const info: UpdateInfo = {
    game: 'arknights',
    currentVersion: null,
    latestVersion: null,
    preDownloadVersion: null,
    hasUpdate: false,
    supported: true,
    mainSizeBytes: 0,
    preDownloadSizeBytes: 0
  }
  try {
    const local = await readLocalVersion(gameDir)
    info.currentVersion = local || null
    const latest = await getArknightsLatest(local)
    info.latestVersion = latest.version || null
    // Prefer the (much smaller) incremental package when the server offers one.
    info.mainSizeBytes = latest.patch
      ? latest.patch.size
      : latest.packs.reduce((sum, pack) => sum + pack.size, 0)
    info.hasUpdate = latest.action === 1 && (latest.patch !== null || latest.packs.length > 0)
    // Pre-download: the API exposes `pre_patch` for the next version before it
    // goes live. Offer it only when it is newer than the installed version.
    const pre = latest.prePatch
    const preNewer = !!local && !!pre?.version && compareVersions(local, pre.version) < 0
    info.preDownloadVersion = preNewer ? (pre?.version ?? null) : null
    if (preNewer && pre) {
      info.preDownloadSizeBytes = pre.size
      const state = await readAkPredownloadState(gameDir)
      info.preDownloadFinished = !!state && state.ready && state.version === pre.version
    }
    if (!info.hasUpdate) {
      info.message = info.preDownloadVersion
        ? `可预下载 ${info.preDownloadVersion}`
        : '已是最新版本'
    }
  } catch (error) {
    info.message = (error as Error).message
    info.supported = false
  }
  return info
}
