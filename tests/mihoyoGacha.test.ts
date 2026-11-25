import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchMiHoYoGacha, toApiPrefix } from '../src/main/gacha/mihoyo'
import { scanWebCache } from '../src/main/gacha/urlSource'

const rawAuth = 'demonstration%2btoken%3D%25~'
const genshin = 'https://webstatic.mihoyo.com/hk4e/event/e20190909gacha-v3/index.html'
const tempDirs = new Set<string>()

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all([...tempDirs].map(path => fs.rm(path, { recursive: true, force: true })))
  tempDirs.clear()
})

describe('MiHoYo history links', () => {
  it.each([
    ['genshin', genshin, 'https://public-operation-hk4e.mihoyo.com/gacha_info/api/getGachaLog'],
    ['starrail', 'https://gs.hoyoverse.com/hkrpg/event/e20211215gacha-v2/index.html',
      'https://public-operation-hkrpg-sg.hoyoverse.com/common/gacha_record/api/getGachaLog'],
    ['zzz', 'https://webstatic.mihoyo.com/nap/event/e20230424gacha/index.html',
      'https://public-operation-nap.mihoyo.com/common/gacha_record/api/getGachaLog'],
    ['zzz', 'https://gs.hoyoverse.com/nap/event/e20230424gacha/index.html',
      'https://public-operation-common-sg.hoyoverse.com/common/gacha_record/api/getGachaLog']
  ] as const)('maps the %s record page to the selected region and preserves auth encoding', (game, page, endpoint) => {
    const source = `${page}?page=77&authkey=${rawAuth}&real_gacha_type=3&lang=zh-cn#/log`
    expect(toApiPrefix(game, source)).toBe(`${endpoint}?authkey=${rawAuth}&lang=zh-cn`)
  })

  it('removes encoded paging fields and supports the direct, documented API alias', () => {
    const endpoint = 'https://hk4e-api.mihoyo.com/event/gacha_info/api/getGachaLog'
    const pasted = `${endpoint}?%70age=3&size=25&authkey=${rawAuth}&lang=zh-cn&end_id=123`
    expect(toApiPrefix('genshin', pasted)).toBe(`${endpoint}?authkey=${rawAuth}&lang=zh-cn`)
    expect(toApiPrefix('genshin', `${genshin}?lang=zh-cn#/log?authkey=${rawAuth}`))
      .toContain(`?lang=zh-cn&authkey=${rawAuth}`)
  })

  it.each([
    'https://different.example/gacha_info/api/getGachaLog?authkey=fixture',
    'http://webstatic.mihoyo.com/hk4e/event/e20190909gacha?authkey=fixture',
    'https://user:password@webstatic.mihoyo.com/hk4e/event/e20190909gacha?authkey=fixture',
    'https://public-operation-hk4e.mihoyo.com/not-a-history-endpoint?authkey=fixture',
    `${genshin}?authkey=fixture&authkey=duplicate`,
    `${genshin}?wrong_authkey=fixture`,
    `${genshin}?authkey=fixture&game_biz=hkrpg_cn`
  ])('rejects malformed or nonmatching URLs before sending any request', async url => {
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    await expect(fetchMiHoYoGacha('genshin', url, 'fixture')).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
})

const draw = (id: string, uid = '100000001') => ({
  id, uid, item_id: '10032', name: '合成条目', rank_type: '5', time: '2026-11-24 20:01:02'
})
const largeId = 18446744073709551599n
const pageOf20 = (): ReturnType<typeof draw>[] =>
  Array.from({ length: 20 }, (_, index) => draw(String(largeId - BigInt(index))))
const reply = (records: ReturnType<typeof draw>[]): Response =>
  Response.json({ retcode: 0, data: { list: records } })

describe('MiHoYo history sync', () => {
  it('paginates using exact large IDs and preserves the existing record contract', async () => {
    const page = pageOf20()
    const calls: URL[] = []
    vi.stubGlobal('fetch', async (raw: string, init: RequestInit) => {
      expect(init.redirect).toBe('error')
      expect(init.signal).toBeDefined()
      const url = new URL(raw)
      calls.push(url)
      const params = url.searchParams
      if (params.get('gacha_type') !== '100') return reply([])
      if (params.get('page') === '1') return reply(page)
      expect(params.get('end_id')).toBe(page[19].id)
      return reply([page[19], draw(String(largeId - 20n))])
    })
    const steps: number[] = []
    const records = await fetchMiHoYoGacha(
      'genshin', `${genshin}?authkey=${rawAuth}`, 'fixture-app', event => steps.push(event.page)
    )
    expect(calls.map(call => call.searchParams.get('gacha_type'))).toEqual(['100', '100', '200', '301', '302', '500'])
    expect(steps).toEqual([1, 2, 1, 1, 1, 1])
    expect(records).toHaveLength(21)
    expect(records[0]).toEqual({
      id: `genshin:100000001:${largeId}`, appId: 'fixture-app', game: 'genshin', uid: '100000001',
      gachaType: '100', bannerName: '新手祈愿', itemId: '10032', itemName: '合成条目',
      rankType: 5, time: '2026-11-24 20:01:02'
    })
  })

  it('uses the independent ZZZ banner namespace and does not duplicate query parameters', async () => {
    const types: (string | null)[] = []
    vi.stubGlobal('fetch', async (raw: string) => {
      const params = new URL(raw).searchParams
      types.push(params.get('real_gacha_type'))
      expect(params.has('gacha_type')).toBe(false)
      expect(params.getAll('real_gacha_type')).toHaveLength(1)
      return reply([])
    })
    await fetchMiHoYoGacha('zzz',
      `https://public-operation-nap.mihoyo.com/common/gacha_record/api/getGachaLog?gacha_type=5&authkey=${rawAuth}`,
      'fixture-app')
    expect(types).toEqual(['1', '2', '3', '5', '102', '103'])
  })

  it('stops a repeated cursor without fetching later banners', async () => {
    const request = vi.fn(async () => reply(pageOf20()))
    vi.stubGlobal('fetch', request)
    await expect(fetchMiHoYoGacha('genshin', `${genshin}?authkey=${rawAuth}`, 'fixture')).rejects.toThrow('分页')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('shows HTTP errors and hides authorization or response payloads from messages', async () => {
    const source = `${genshin}?authkey=${rawAuth}`
    vi.stubGlobal('fetch', async () => new Response(rawAuth, { status: 503 }))
    await expect(fetchMiHoYoGacha('genshin', source, 'fixture')).rejects.toThrow('HTTP 503')
    vi.stubGlobal('fetch', async () => Response.json({ retcode: -100, message: rawAuth }))
    const failure = await fetchMiHoYoGacha('genshin', source, 'fixture').catch(error => (error as Error).message)
    expect(failure).toContain('-100')
    expect(failure).not.toContain(rawAuth)
  })

  it('rejects records without losslessly represented IDs', async () => {
    vi.stubGlobal('fetch', async () => Response.json({
      retcode: 0, data: { list: [{ ...draw('1'), id: Number(largeId) }] }
    }))
    await expect(fetchMiHoYoGacha('genshin', `${genshin}?authkey=${rawAuth}`, 'fixture')).rejects.toThrow('无效记录')
  })
})

async function cacheFixture(file = 'data_2'): Promise<{ root: string; path: string }> {
  const root = await fs.mkdtemp(join(tmpdir(), 'mihoyo-gacha-test-'))
  tempDirs.add(root)
  const folder = join(root, 'YuanShen_Data', 'webCaches', '1.2.3', 'Cache', 'Cache_Data')
  await fs.mkdir(folder, { recursive: true })
  return { root, path: join(folder, file) }
}

describe('MiHoYo WebView cache', () => {
  it('finds links split across bounded read blocks', async () => {
    const { root, path } = await cacheFixture()
    const link = `${genshin}?authkey=${rawAuth}&game_biz=hk4e_cn#/log`
    const block = 128 * 1024
    const file = Buffer.alloc(block * 2, 0)
    file.write(link, block - 3, 'utf8')
    await fs.writeFile(path, file)
    expect(await scanWebCache(root, 'genshin')).toBe(link)
  })

  it('chooses the newest valid entry across cache layouts without scanning unrelated files', async () => {
    const { root, path } = await cacheFixture('f_1a2b3c')
    const earlier = `${genshin}?authkey=earlier&game_biz=hk4e_cn`
    const newer = `${genshin}?authkey=${rawAuth}&game_biz=hk4e_cn`
    const otherGame = 'https://webstatic.mihoyo.com/nap/event/e20230424gacha/index.html?authkey=unrelated'
    await fs.writeFile(path, `${earlier}\x00${newer}"${otherGame}\x00`)
    await fs.utimes(path, 1000, 1000)
    const corrupt = join(path, '..', 'data_2')
    await fs.writeFile(corrupt, `\u0000${genshin}?authkey=\u0000`)
    await fs.utimes(corrupt, 1200, 1200)
    await fs.writeFile(join(path, '..', 'ignore.txt'), `${genshin}?authkey=outside-format`)
    expect(await scanWebCache(root, 'genshin')).toBe(newer)
    expect(await scanWebCache(root, 'zzz')).toBeNull()
  })
})
