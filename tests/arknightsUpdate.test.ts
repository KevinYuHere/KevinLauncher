import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { getArknightsLatest, getArknightsUpdateInfo } from '../src/main/update/arknightsUpdate'

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
})
