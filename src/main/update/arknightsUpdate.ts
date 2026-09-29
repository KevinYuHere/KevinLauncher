import { promises as fs } from 'fs'
import { join, basename } from 'path'
import { createDecipheriv } from 'crypto'
import type { UpdateInfo } from '@shared/types'

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

export interface AkLatest {
  action: number
  version: string
  packs: AkPack[]
}

interface RawPack {
  url?: string
  md5?: string
  package_size?: string
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
      return { action: 0, version: localVersion, packs: [] }
    }
    throw new Error(message || '鹰角接口返回异常')
  }
  const packs: AkPack[] = (rsp.pkg?.packs ?? [])
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
  return { action: rsp.action ?? 0, version: rsp.version ?? '', packs }
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
    info.mainSizeBytes = latest.packs.reduce((sum, pack) => sum + pack.size, 0)
    info.hasUpdate = latest.action === 1 && latest.packs.length > 0
    if (!info.hasUpdate) info.message = '已是最新版本'
  } catch (error) {
    info.message = (error as Error).message
    info.supported = false
  }
  return info
}
