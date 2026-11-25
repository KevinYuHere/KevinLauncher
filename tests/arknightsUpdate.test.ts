import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createCipheriv } from 'crypto'
import {
  clearAkPredownload,
  getArknightsLatest,
  getArknightsUpdateInfo,
  readAkPredownloadState,
  writeAkPredownloadState
} from '../src/main/update/arknightsUpdate'

/** Same AES key/IV the Arknights client uses for `config.ini`. */
const KEY = Buffer.from([
  0xc0, 0xf3, 0x0e, 0x1c, 0xe7, 0x63, 0xbb, 0xc2, 0x1c, 0xc3, 0x55, 0xa3, 0x43, 0x03, 0xac, 0x50,
  0x39, 0x94, 0x44, 0xbf, 0xf6, 0x8c, 0x4a, 0x22, 0xaf, 0x39, 0x8c, 0x0a, 0x16, 0x6e, 0xe1, 0x43
])
const IV = Buffer.from([
  0x33, 0x46, 0x78, 0x61, 0x19, 0x27, 0x50, 0x64, 0x95, 0x01, 0x93, 0x72, 0x64, 0x60, 0x84, 0x00
])

async function writeConfigIni(dir: string, version: string): Promise<void> {
  const cipher = createCipheriv('aes-256-cbc', KEY, IV)
  const body = Buffer.concat([cipher.update(`[Game]\nversion=${version}\n`), cipher.final()])
  await fs.writeFile(join(dir, 'config.ini'), body)
}

const response = {
  proxy_rsps: [
    {
      kind: 'get_latest_game',
      get_latest_game_rsp: {
        action: 1,
        version: '78.0.0',
        pkg: {
          packs: [{ url: 'https://cdn/full.zip.001', md5: 'abc', package_size: '20000000000' }]
        },
        patch: {
          url: 'https://cdn/legacy.zip',
          package_size: '2000000000',
          patches: [
            { url: 'https://cdn/v2/patch.zip.001', md5: 'def', package_size: '854074318' }
          ],
          cd_key: 'SECRET',
          v2_patch_info_url: 'https://cdn/patch.json',
          v2_patch_info_md5: 'ghi'
        }
      }
    }
  ]
}

afterEach(() => vi.unstubAllGlobals())

/** A response where only a pre-download for 79.0.0 is offered. */
const preDownloadResponse = {
  proxy_rsps: [
    {
      kind: 'get_latest_game',
      get_latest_game_rsp: {
        action: 0,
        version: '78.0.0',
        pkg: { packs: [] },
        patch: null,
        pre_patch: {
          package_size: '1221839400',
          total_size: '3006072881',
          version: '79.0.0',
          client_version: '2.7.91',
          patches: [
            { url: 'https://cdn/v2/pre.zip.001', md5: 'pre1', package_size: '1073741824' },
            { url: 'https://cdn/v2/pre.zip.002', md5: 'pre2', package_size: '148097576' }
          ]
        }
      }
    }
  ]
}

describe('getArknightsLatest', () => {
  it('prefers the incremental patch over the full package', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response))))
    const latest = await getArknightsLatest('77.0.0')
    expect(latest.action).toBe(1)
    expect(latest.patch).not.toBeNull()
    expect(latest.patch?.cdKey).toBe('SECRET')
    expect(latest.patch?.infoUrl).toBe('https://cdn/patch.json')
    expect(latest.patch?.size).toBe(854074318)
    expect(latest.patch?.parts[0].name).toBe('patch.zip.001')
  })

  it('exposes the pre-download package', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(preDownloadResponse))))
    const latest = await getArknightsLatest('78.0.0')
    expect(latest.prePatch?.version).toBe('79.0.0')
    expect(latest.prePatch?.size).toBe(1221839400)
    expect(latest.prePatch?.parts).toHaveLength(2)
  })

  it('falls back to the full package when no patch is offered', async () => {
    const noPatch = JSON.parse(JSON.stringify(response))
    noPatch.proxy_rsps[0].get_latest_game_rsp.patch = null
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(noPatch))))
    const latest = await getArknightsLatest('0.0.0')
    expect(latest.patch).toBeNull()
    expect(latest.packs).toHaveLength(1)
  })
})

describe('getArknightsUpdateInfo', () => {
  it('reports the incremental download size', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response))))
    const dir = await fs.mkdtemp(join(tmpdir(), 'kl-akinfo-'))
    const info = await getArknightsUpdateInfo(dir)
    expect(info.hasUpdate).toBe(true)
    expect(info.latestVersion).toBe('78.0.0')
    expect(info.mainSizeBytes).toBe(854074318)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('detects an available pre-download from pre_patch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(preDownloadResponse)))
    )
    const dir = await fs.mkdtemp(join(tmpdir(), 'kl-akpre-'))
    await writeConfigIni(dir, '78.0.0')
    const info = await getArknightsUpdateInfo(dir)
    expect(info.currentVersion).toBe('78.0.0')
    expect(info.preDownloadVersion).toBe('79.0.0')
    expect(info.preDownloadSizeBytes).toBe(1221839400)
    expect(info.preDownloadFinished).toBe(false)
    expect(info.message).toBe('可预下载 79.0.0')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('ignores a pre-download that is not newer than the installed version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(preDownloadResponse)))
    )
    const dir = await fs.mkdtemp(join(tmpdir(), 'kl-akpre2-'))
    await writeConfigIni(dir, '79.0.0')
    const info = await getArknightsUpdateInfo(dir)
    expect(info.preDownloadVersion).toBeNull()
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('arknights predownload state', () => {
  it('round-trips and clears the staged state', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'kl-akstate-'))
    expect(await readAkPredownloadState(dir)).toBeNull()
    await writeAkPredownloadState(dir, {
      version: '79.0.0',
      ready: true,
      total: 3,
      parts: [{ name: 'a.zip.001', size: 3, md5: 'x' }]
    })
    const state = await readAkPredownloadState(dir)
    expect(state?.version).toBe('79.0.0')
    expect(state?.ready).toBe(true)
    await clearAkPredownload(dir)
    expect(await readAkPredownloadState(dir)).toBeNull()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('marks a completed pre-download on the update info', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(preDownloadResponse)))
    )
    const dir = await fs.mkdtemp(join(tmpdir(), 'kl-akdone-'))
    await writeConfigIni(dir, '78.0.0')
    await writeAkPredownloadState(dir, { version: '79.0.0', ready: true, total: 1, parts: [] })
    const info = await getArknightsUpdateInfo(dir)
    expect(info.preDownloadFinished).toBe(true)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
