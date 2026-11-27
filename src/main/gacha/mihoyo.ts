import { setTimeout as wait } from 'node:timers/promises'
import type { GachaRecord } from '@shared/types'
import { MIHOYO, poolGroup, type GachaTypeDef, type MiHoYoGame } from './metadata'
import { parseMiHoYoLink } from './mihoyoLink'
import { gachaTimeWithOffset, gachaTimezoneOffset } from './gachaTime'
import {
  compareSourceIds,
  findCheckpoint,
  normalizeSourceId,
  syncKey,
  type MiHoYoSyncCheckpoint,
  type MiHoYoSyncMode
} from './gachaSync'

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

export interface PageProgress {
  bannerName: string
  page: number
}

export interface MiHoYoSyncOptions {
  /** Defaults to `incremental`; `full` always traverses to the oldest page. */
  mode?: MiHoYoSyncMode
  /** Previous trusted boundaries, normally read from the gacha store. */
  checkpoints?: readonly MiHoYoSyncCheckpoint[]
  onProgress?: (info: PageProgress) => void
  cancellation?: AbortSignal
}

export interface MiHoYoSyncResult {
  records: GachaRecord[]
  /** Checkpoints that were confirmed by this run; persist them with `records`. */
  checkpoints: MiHoYoSyncCheckpoint[]
  mode: MiHoYoSyncMode
  pages: number
  /** True when at least one pool stopped at an already trusted boundary. */
  earlyStopped: boolean
}

interface BannerSyncResult {
  uid?: string
  records: ParsedDraw[]
  checkpoint?: MiHoYoSyncCheckpoint
  earlyStopped: boolean
  pages: number
}

/**
 * Page one banner from newest to oldest. A previous trusted boundary is only
 * used after every page in this run has been checked for ordering, overlap,
 * duplicates, account changes and source consistency. Any uncertainty turns
 * the run into a full traversal instead of stopping early.
 */
async function syncBanner(
  game: MiHoYoGame,
  prefix: string,
  queryName: string,
  banner: GachaTypeDef,
  mode: MiHoYoSyncMode,
  checkpoints: readonly MiHoYoSyncCheckpoint[],
  progress: ((info: PageProgress) => void) | undefined,
  signal: AbortSignal
): Promise<BannerSyncResult> {
  const pool = poolGroup(game, banner.type)
  const records: ParsedDraw[] = []
  const seen = new Set<string>()
  let uid: string | undefined
  let trusted: MiHoYoSyncCheckpoint | undefined
  let watermark: string | undefined
  let newest: string | undefined
  let pageAnomaly = false
  let boundaryExamined = false
  let earlyStopped = false
  let reachedEnd = false
  let pages = 0
  let cursor = '0'

  for (let page = 1; ; page++) {
    progress?.({ bannerName: banner.name, page })
    const pagination = new URLSearchParams({
      [queryName]: banner.type,
      page: String(page),
      size: String(PAGE_SIZE),
      end_id: cursor
    })
    const rows = await requestPage(`${prefix}&${pagination}`, signal)
    pages++
    if (page > 1 && rows.length) {
      // A later page must start strictly below the previous cursor. A repeated
      // or out-of-order row means the page chain is not trustworthy.
      const first = normalizeSourceId(rows[0].id)
      if (first === undefined || compareSourceIds(first, cursor) >= 0) pageAnomaly = true
    }

    let priorId: string | undefined
    for (const draw of rows) {
      if (uid === undefined) {
        uid = draw.uid
        if (mode === 'incremental') {
          trusted = findCheckpoint(checkpoints, game, uid, pool)
          watermark = trusted?.boundaryId
        }
      } else if (draw.uid !== uid) {
        throw new Error('抽卡接口在同一次查询中返回了不同账号')
      }
      const id = normalizeSourceId(draw.id)
      if (id === undefined) throw new Error('抽卡接口返回了无效记录')
      if (seen.has(id)) pageAnomaly = true
      seen.add(id)
      if (priorId !== undefined && compareSourceIds(id, priorId) >= 0) pageAnomaly = true
      priorId = id
      if (newest === undefined || compareSourceIds(id, newest) > 0) newest = id
      records.push(draw)
    }

    if (watermark !== undefined && !boundaryExamined) {
      const ids = rows.map((row) => normalizeSourceId(row.id)!)
      const hasWatermark = ids.some((id) => id === watermark)
      const passedWatermark = ids.some((id) => compareSourceIds(id, watermark!) < 0)
      if (hasWatermark) {
        boundaryExamined = true
        if (!pageAnomaly) earlyStopped = true
      } else if (passedWatermark) {
        // The source skipped past the saved boundary without returning it.
        // Continue to the oldest page so a fresh boundary can be established.
        boundaryExamined = true
      }
    }

    if (earlyStopped) break
    if (rows.length < PAGE_SIZE) {
      reachedEnd = true
      break
    }
    const next = rows.at(-1)?.id
    if (page > 1 && next && BigInt(next) >= BigInt(cursor)) {
      throw new Error('抽卡接口分页未向前推进，请重新打开游戏内的记录后重试')
    }
    cursor = next ?? '0'
    if (cursor === '0') throw new Error('抽卡接口返回了无效分页游标')
    await wait(PAGE_DELAY, undefined, { signal })
  }

  let checkpoint: MiHoYoSyncCheckpoint | undefined
  // Duplicated, unordered or cross-pool pages mean the current run cannot
  // establish a new trusted boundary. A later clean run will do so; until then
  // the previous boundary (if any) remains untouched.
  if (uid !== undefined && newest !== undefined && !pageAnomaly && (earlyStopped || reachedEnd)) {
    checkpoint = {
      game, uid, pool, boundaryId: newest, completedAt: Date.now(), pages
    }
  }
  return { uid, records, checkpoint, earlyStopped, pages }
}

export async function syncMiHoYoGacha(
  game: MiHoYoGame,
  url: string,
  appId: string,
  options: MiHoYoSyncOptions = {}
): Promise<MiHoYoSyncResult> {
  const mode = options.mode ?? 'incremental'
  if (mode !== 'incremental' && mode !== 'full') throw new Error('无效的抽卡同步方式')
  const timeout = AbortSignal.timeout(5 * 60_000)
  const signal = options.cancellation
    ? AbortSignal.any([options.cancellation, timeout])
    : timeout
  const prefix = toApiPrefix(game, url)
  const config = MIHOYO[game]
  const queryName = config.realGachaType ? 'real_gacha_type' : 'gacha_type'
  const unique = new Map<string, GachaRecord>()
  const checkpoints = new Map<string, MiHoYoSyncCheckpoint>()
  const known = mode === 'incremental' ? options.checkpoints ?? [] : []
  let uid: string | undefined
  let pages = 0
  let earlyStopped = false

  try {
    for (const banner of config.gachaTypes) {
      if (banner.displayOnly) continue
      const result = await syncBanner(
        game, prefix, queryName, banner, mode, known, options.onProgress, signal
      )
      pages += result.pages
      earlyStopped ||= result.earlyStopped
      if (result.uid !== undefined) {
        if (uid !== undefined && uid !== result.uid) {
          throw new Error('抽卡接口在同一次查询中返回了不同账号')
        }
        uid = result.uid
      }
      const account = result.uid
      if (result.records.length && account === undefined) throw new Error('抽卡接口返回了无效记录')
      for (const draw of result.records) {
        const id = `${game}:${account}:${draw.id}`
        if (unique.has(id)) continue
        const gachaType = game === 'genshin' && banner.type === '301' && draw.gachaType === '400'
          ? '400'
          : banner.type
        unique.set(id, {
          id, appId, game, uid: account!, gachaType, bannerName: banner.name,
          itemId: draw.item, itemName: draw.name, rankType: draw.rank, time: draw.time,
          timezone: draw.timezone, lang: draw.lang, gachaId: draw.gachaId,
          timestampMs: gachaTimeWithOffset(draw.time, draw.timezone)
        })
      }
      if (result.checkpoint) {
        checkpoints.set(
          syncKey(game, result.checkpoint.uid, result.checkpoint.pool),
          result.checkpoint
        )
      }
    }
  } catch (error) {
    if (unique.size === 0) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}。已获取 ${unique.size} 条但尚未保存，原有记录已保留`, { cause: error })
  }
  return {
    records: [...unique.values()],
    checkpoints: [...checkpoints.values()],
    mode,
    pages,
    earlyStopped
  }
}

/** Full-traversal compatibility wrapper for callers that only need records. */
export async function fetchMiHoYoGacha(
  game: MiHoYoGame,
  url: string,
  appId: string,
  onProgress?: (info: PageProgress) => void,
  cancellation?: AbortSignal
): Promise<GachaRecord[]> {
  const result = await syncMiHoYoGacha(game, url, appId, {
    mode: 'full', onProgress, cancellation
  })
  return result.records
}
