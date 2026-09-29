import type { GachaGame } from '@shared/types'

/**
 * Volatile per-game metadata (endpoints, banner ids, rarity scale, cache paths).
 * Kept in one place so upstream/official API changes are a one-file edit.
 */

export interface GachaTypeDef {
  type: string
  name: string
}

export interface MiHoYoMeta {
  /** Full `getGachaLog` endpoint (the captured URL's query is appended to it). */
  apiHost: string
  gameBiz: string
  /** Highest rarity value as reported by the API. */
  topRank: number
  /** Second highest rarity value (shown by all these games). */
  secondRank: number
  /** Banner types to query + their display names. */
  gachaTypes: GachaTypeDef[]
  /** ZZZ needs `real_gacha_type` instead of `gacha_type`. */
  realGachaType?: boolean
  /** `<gameDir>\<dir>` — folders (under the game dir) that hold the web caches. */
  webCacheDirs: string[]
  /** URL prefixes written to the cache file (CN then global). */
  urlPrefixes: string[]
}

export const MIHOYO: Record<'genshin' | 'starrail' | 'zzz', MiHoYoMeta> = {
  genshin: {
    apiHost: 'https://public-operation-hk4e.mihoyo.com/gacha_info/api/getGachaLog',
    gameBiz: 'hk4e_cn',
    topRank: 5,
    secondRank: 4,
    gachaTypes: [
      { type: '100', name: '新手祈愿' },
      { type: '200', name: '常驻祈愿' },
      { type: '301', name: '角色活动祈愿' },
      { type: '400', name: '角色活动祈愿-2' },
      { type: '302', name: '武器活动祈愿' },
      { type: '500', name: '集录祈愿' }
    ],
    // Starward only queries these five (400 shares 301's pool in practice).
    webCacheDirs: ['YuanShen_Data/webCaches', 'GenshinImpact_Data/webCaches'],
    urlPrefixes: [
      'https://webstatic.mihoyo.com/hk4e/event/e20190909gacha',
      'https://gs.hoyoverse.com/genshin/event/e20190909gacha'
    ]
  },
  starrail: {
    apiHost: 'https://public-operation-hkrpg.mihoyo.com/common/hkrpg_gacha_record/api/getGachaLog',
    gameBiz: 'hkrpg_cn',
    topRank: 5,
    secondRank: 4,
    gachaTypes: [
      { type: '1', name: '群星跃迁' },
      { type: '2', name: '始发跃迁' },
      { type: '11', name: '角色活动跃迁' },
      { type: '12', name: '光锥活动跃迁' },
      { type: '21', name: '角色联动跃迁' },
      { type: '22', name: '光锥联动跃迁' }
    ],
    webCacheDirs: ['StarRail_Data/webCaches'],
    urlPrefixes: [
      'https://webstatic.mihoyo.com/hkrpg/event/e20211215gacha',
      'https://gs.hoyoverse.com/hkrpg/event/e20211215gacha'
    ]
  },
  zzz: {
    apiHost: 'https://public-operation-nap.mihoyo.com/common/gacha_record/api/getGachaLog',
    gameBiz: 'nap_cn',
    // ZZZ reports S=4, A=3, B=2.
    topRank: 4,
    secondRank: 3,
    realGachaType: true,
    gachaTypes: [
      { type: '1', name: '常驻频段' },
      { type: '2', name: '独家频段' },
      { type: '3', name: '音擎频段' },
      { type: '5', name: '邦布频段' },
      { type: '102', name: '独家重映' },
      { type: '103', name: '音擎回响' }
    ],
    webCacheDirs: ['ZenlessZoneZero_Data/webCaches'],
    urlPrefixes: [
      'https://webstatic.mihoyo.com/nap/event/e20230424gacha',
      'https://gs.hoyoverse.com/nap/event/e20230424gacha'
    ]
  }
}

/** Banner types actually requested from the API (mirrors Starward). */
export const MIHOYO_QUERY_TYPES: Record<'genshin' | 'starrail' | 'zzz', string[]> = {
  genshin: ['100', '200', '301', '302', '500'],
  starrail: ['1', '2', '11', '12', '21', '22'],
  zzz: ['1', '2', '3', '5', '102', '103']
}

export interface HypergryphMeta {
  appCode: string
  asBase: string
  bindingBase: string
  akBase: string
  /** Arknights rarity is 0-indexed (6★ == 5, 5★ == 4). */
  topRank: number
  secondRank: number
}

export const HYPERGRYPH: HypergryphMeta = {
  appCode: 'be36d44aa36bfb5b',
  asBase: 'https://as.hypergryph.com',
  bindingBase: 'https://binding-api-account-prod.hypergryph.com',
  akBase: 'https://ak.hypergryph.com',
  topRank: 5,
  secondRank: 4
}

export function topRankFor(game: GachaGame): number {
  return game === 'arknights' ? HYPERGRYPH.topRank : MIHOYO[game].topRank
}

export function secondRankFor(game: GachaGame): number {
  return game === 'arknights' ? HYPERGRYPH.secondRank : MIHOYO[game].secondRank
}

/** Human-readable rarity label (differs per game). */
export function displayRank(game: GachaGame, rank: number): string {
  if (game === 'arknights') return `${rank + 1}★`
  if (game === 'zzz') return rank >= 4 ? 'S' : rank === 3 ? 'A' : 'B'
  return `${rank}★`
}

export function bannerName(game: GachaGame, type: string): string {
  if (game === 'arknights') return type
  return MIHOYO[game].gachaTypes.find((t) => t.type === type)?.name ?? type
}

/**
 * Which banner group shares pity. Records in the same group are counted
 * together when computing "pulls since last item of this rarity".
 *
 * - miHoYo games: pity is shared per banner type (character / weapon / standard
 *   / beginner / ... are independent; all banners of the same type share).
 * - Arknights: all standard (`normal`) banners share pity; every limited
 *   banner is independent (pity resets between different limited banners), so
 *   limited records are grouped by their specific pool.
 */
export function poolGroup(game: GachaGame, gachaType: string, poolId?: string): string {
  if (game === 'arknights') {
    return gachaType === 'normal' ? 'normal' : poolId ?? gachaType
  }
  return gachaType
}

export function poolName(game: GachaGame, group: string, latestBanner?: string): string {
  if (game === 'arknights') return group === 'normal' ? '标准寻访' : latestBanner ?? group
  return bannerName(game, group)
}
