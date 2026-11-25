import { setTimeout as wait } from 'node:timers/promises'
import type { GachaRecord } from '@shared/types'
import { MIHOYO, type GachaTypeDef, type MiHoYoGame } from './metadata'
import { parseMiHoYoLink } from './mihoyoLink'
import { gachaTimeWithOffset, gachaTimezoneOffset } from './gachaTime'

const PAGE_SIZE = 20
const PAGE_DELAY = 250
const REQUEST_TIMEOUT = 20_000

export function toApiPrefix(game: MiHoYoGame, input: string): string {
  const { endpoint, query } = parseMiHoYoLink(game, input)
  return `${endpoint}?${query}`
}

interface ParsedDraw {
  id: string
  uid: string
  item: string
  name: string
  rank: number
  time: string
  timezone?: number
  lang?: string
  gachaId?: string
  gachaType?: string
}

function decimal(value: unknown): string | null {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  return null
}

function readDraw(input: unknown, pageTimezone: unknown): ParsedDraw {
  if (!input || typeof input !== 'object') throw new Error('抽卡接口返回了无效记录')
  const row = input as Record<string, unknown>
  const id = decimal(row.id)
  const uid = decimal(row.uid)
  const item = decimal(row.item_id)
  const rank = decimal(row.rank_type)
  if (!id || !uid || !item || !rank || !Number.isSafeInteger(Number(rank)) ||
      typeof row.name !== 'string' || typeof row.time !== 'string' || !row.time.trim()) {
    throw new Error('抽卡接口返回了无效记录')
  }
  const timeOffset = row.region_time_zone ?? pageTimezone
  const offset = typeof timeOffset === 'number' || (typeof timeOffset === 'string' && /^-?\d+$/.test(timeOffset))
    ? Number(timeOffset) : NaN
  return {
    id, uid, item, rank: Number(rank), name: row.name, time: row.time,
    timezone: gachaTimezoneOffset(offset),
    lang: typeof row.lang === 'string' ? row.lang : undefined,
    gachaId: decimal(row.gacha_id) ?? undefined,
    gachaType: decimal(row.gacha_type) ?? undefined
  }
}

async function requestPage(url: string, signal: AbortSignal): Promise<ParsedDraw[]> {
  let response: Response
  try {
    response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT)]),
      headers: { 'User-Agent': 'KevinLauncher', Accept: 'application/json' }
    })
  } catch {
    throw new Error('无法连接抽卡接口，请稍后重试')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`抽卡接口暂不可用（HTTP ${response.status}）`)
  }
  let envelope: { retcode?: unknown; data?: { list?: unknown; region_time_zone?: unknown } } | null
  try {
    envelope = await response.json()
  } catch {
    throw new Error('抽卡接口返回了无法读取的数据')
  }
  if (!envelope || typeof envelope.retcode !== 'number') throw new Error('抽卡接口返回了无效数据')
  if (envelope.retcode === -110) throw new Error('抽卡接口请求过快，请稍后重试')
  if (envelope.retcode !== 0) {
    throw new Error(`抽卡接口拒绝请求（${envelope.retcode}），请在游戏内重新打开记录后获取链接`)
  }
  const list = envelope.data?.list
  if (!Array.isArray(list) || list.length > PAGE_SIZE) throw new Error('抽卡接口返回了无效分页数据')
  return list.map((row) => readDraw(row, envelope.data?.region_time_zone))
}

interface PageProgress {
  bannerName: string
  page: number
}

/** Keep cursor IDs as decimal strings all the way through the API and store. */
async function* bannerDraws(
  prefix: string,
  queryName: string,
  banner: GachaTypeDef,
  progress: ((info: PageProgress) => void) | undefined,
  signal: AbortSignal
): AsyncGenerator<ParsedDraw> {
  let cursor = '0'
  for (let page = 1; ; page++) {
    progress?.({ bannerName: banner.name, page })
    const pagination = new URLSearchParams({
      [queryName]: banner.type,
      page: String(page),
      size: String(PAGE_SIZE),
      end_id: cursor
    })
    const records = await requestPage(`${prefix}&${pagination}`, signal)
    const next = records.at(-1)?.id
    if (page > 1 && next && BigInt(next) >= BigInt(cursor)) {
      throw new Error('抽卡接口分页未向前推进，请重新打开游戏内的记录后重试')
    }
    yield* records
    if (records.length < PAGE_SIZE) return
    cursor = next!
    if (cursor === '0') throw new Error('抽卡接口返回了无效分页游标')
    await wait(PAGE_DELAY, undefined, { signal })
  }
}

export async function fetchMiHoYoGacha(
  game: MiHoYoGame,
  url: string,
  appId: string,
  onProgress?: (info: PageProgress) => void,
  cancellation?: AbortSignal
): Promise<GachaRecord[]> {
  const timeout = AbortSignal.timeout(5 * 60_000)
  const signal = cancellation ? AbortSignal.any([cancellation, timeout]) : timeout
  const prefix = toApiPrefix(game, url)
  const config = MIHOYO[game]
  const queryName = config.realGachaType ? 'real_gacha_type' : 'gacha_type'
  const unique = new Map<string, GachaRecord>()
  let uid: string | undefined

  try {
    for (const banner of config.gachaTypes) {
      if (banner.displayOnly) continue
      for await (const draw of bannerDraws(prefix, queryName, banner, onProgress, signal)) {
        uid ??= draw.uid
        if (draw.uid !== uid) throw new Error('抽卡接口在同一次查询中返回了不同账号')
        const id = `${game}:${uid}:${draw.id}`
        if (unique.has(id)) continue
        const gachaType = game === 'genshin' && banner.type === '301' && draw.gachaType === '400' ? '400' : banner.type
        unique.set(id, {
          id, appId, game, uid, gachaType, bannerName: banner.name,
          itemId: draw.item, itemName: draw.name, rankType: draw.rank, time: draw.time,
          timezone: draw.timezone, lang: draw.lang, gachaId: draw.gachaId,
          timestampMs: gachaTimeWithOffset(draw.time, draw.timezone)
        })
      }
    }
  } catch (error) {
    if (unique.size === 0) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}。已获取 ${unique.size} 条但尚未保存，原有记录已保留`, { cause: error })
  }
  return [...unique.values()]
}
