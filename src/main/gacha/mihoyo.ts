import type { GachaRecord } from '@shared/types'
import { MIHOYO, MIHOYO_QUERY_TYPES } from './metadata'

type MiHoYoGame = 'genshin' | 'starrail' | 'zzz'

const PAGE_SIZE = 20
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Turn a captured gacha-page URL into the `getGachaLog` request prefix.
 *
 * Ported from Starward (Scighost/Starward, MIT). The games cache a
 * `https://webstatic.mihoyo.com/...e20190909gacha...` URL that carries the
 * whole auth query (`authkey`, `authkey_ver`, `sign_type`, `region`, `lang`,
 * `game_biz`, …). We keep that query string verbatim and only swap the path for
 * the API endpoint — that is what makes the request actually succeed.
 */
export function toApiPrefix(game: MiHoYoGame, url: string): string {
  const meta = MIHOYO[game]
  const value = url.trim()

  // Already an API URL — strip any paging params that may be present.
  if (value.includes('public-operation-')) {
    return value
      .replace(/[?&](real_)?gacha_type=\d+/g, '')
      .replace(/[?&]page=\d+/g, '')
      .replace(/[?&]size=\d+/g, '')
      .replace(/[?&]end_id=\d+/g, '')
  }

  const q = value.indexOf('?')
  if (q < 0) throw new Error('链接缺少参数（需包含 authkey 等）')
  const query = value.slice(q).replace(/#\/log.*$/, '')
  if (!query.includes('authkey=')) throw new Error('链接中缺少 authkey')
  return meta.apiHost + query
}

interface MiHoYoItem {
  uid: string
  gacha_type: string
  item_id: string
  name: string
  rank_type: string
  id: string
  time: string
}

/**
 * Fetch every banner's records via `getGachaLog` (paged 20 at a time), exactly
 * like Starward: `{prefix}&gacha_type=<t>&page=<n>&size=20&end_id=<id>`
 * (ZZZ uses `real_gacha_type`).
 */
export async function fetchMiHoYoGacha(
  game: MiHoYoGame,
  url: string,
  appId: string,
  onProgress?: (info: { bannerName: string; page: number }) => void
): Promise<GachaRecord[]> {
  const meta = MIHOYO[game]
  const prefix = toApiPrefix(game, url)
  const types = MIHOYO_QUERY_TYPES[game]
  const out: GachaRecord[] = []

  for (const type of types) {
    const banner = meta.gachaTypes.find((t) => t.type === type)
    const bannerName = banner?.name ?? type
    let endId = '0'
    let page = 1
    for (;;) {
      onProgress?.({ bannerName, page })
      const param = meta.realGachaType
        ? `real_gacha_type=${type}&page=${page}&size=${PAGE_SIZE}&end_id=${endId}`
        : `gacha_type=${type}&page=${page}&size=${PAGE_SIZE}&end_id=${endId}`
      const res = await fetch(`${prefix}&${param}`, { headers: { 'User-Agent': 'Mozilla/5.0' } })
      const json = (await res.json()) as {
        retcode: number
        message: string
        data?: { list?: MiHoYoItem[] }
      }
      if (json.retcode !== 0) {
        throw new Error(
          json.message ||
            `接口返回错误码 ${json.retcode}（authkey 可能已过期，请在游戏内重新打开抽卡记录）`
        )
      }
      const list = json.data?.list ?? []
      if (list.length === 0) break
      for (const item of list) {
        out.push({
          id: `${game}:${item.uid}:${item.id}`,
          appId,
          game,
          uid: item.uid,
          gachaType: type,
          bannerName,
          itemId: item.item_id,
          itemName: item.name,
          rankType: Number(item.rank_type),
          time: item.time
        })
      }
      if (list.length < PAGE_SIZE) break
      endId = list[list.length - 1].id
      page++
      await delay(250)
    }
  }
  return out
}
