import type { GachaGame, GachaPoolStat, GachaRecord, GachaRecordPage, GachaStats } from '@shared/types'
import { poolGroup, poolName, secondRankFor, topRankFor } from './metadata'

export function sourceRecordId(record: GachaRecord): string {
  const prefix = `${record.game}:${record.uid}:`
  return record.game !== 'arknights' && record.id.startsWith(prefix) ? record.id.slice(prefix.length) : record.id
}

export function recordIdentity(record: GachaRecord): string {
  return JSON.stringify([record.game, record.uid, sourceRecordId(record)])
}

function orderKey(record: GachaRecord): string | undefined {
  const source = record.game === 'arknights' ? record.seq : sourceRecordId(record)
  return source && /^\d+$/.test(source) ? source.replace(/^0+(?=\d)/, '') : undefined
}

function compareDigits(left: string, right: string): number {
  return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0)
}

interface KeyedRecord {
  record: GachaRecord
  order?: string
  time?: number
  identifier: string
}

function compareTime(left: KeyedRecord, right: KeyedRecord): number {
  if (left.time !== undefined && right.time !== undefined) return left.time - right.time
  if (left.time !== right.time) return left.time === undefined ? -1 : 1
  return left.record.time < right.record.time ? -1 : left.record.time > right.record.time ? 1 : 0
}

function compare(left: KeyedRecord, right: KeyedRecord): number {
  const time = compareTime(left, right)
  if (time) return time
  if (left.order !== undefined && right.order !== undefined) {
    const order = compareDigits(left.order, right.order)
    if (order) return order
  }
  if (left.order !== right.order) return left.order === undefined ? -1 : 1
  return left.identifier < right.identifier ? -1 : left.identifier > right.identifier ? 1 : 0
}

interface PoolIndex {
  top: GachaRecord[]
  topAndSecond: GachaRecord[]
}

/** Build the sorted projection and rarity summaries once per committed data revision. */
export class GachaIndex {
  readonly records: GachaRecord[]
  private readonly defaultGame: GachaGame
  private readonly pools = new Map<string, PoolIndex>()
  private readonly statsByGame = new Map<GachaGame, GachaStats>()

  constructor(records: readonly GachaRecord[], includeAllRecords = true) {
    this.defaultGame = records[0]?.game ?? 'genshin'
    const grouped = new Map<string, { pool: string; list: KeyedRecord[] }>()
    for (const record of records) {
      const pool = poolGroup(record.game, record.gachaType, record.poolId, record.uigfGachaType)
      const group = JSON.stringify([record.game, record.uid, pool])
      const current = grouped.get(group) ?? { pool, list: [] }
      const time = record.timestampMs ?? Date.parse(record.time.replace(' ', 'T'))
      current.list.push({
        record, order: orderKey(record), identifier: recordIdentity(record),
        time: Number.isFinite(time) ? time : undefined
      })
      grouped.set(group, current)
    }

    const all: KeyedRecord[] = []
    for (const [group, { pool, list }] of grouped) {
      list.sort(compare)
      const { game, uid } = list[0].record
      const stats = this.statsByGame.get(game) ?? emptyStats(game)
      this.statsByGame.set(game, stats)
      const { topRank, secondRank } = stats
      const pityKnown = Boolean(uid) && list.every((item, index) => {
        const { record, order, time } = item
        if (time === undefined || !Number.isSafeInteger(record.rankType) ||
            record.rankType < (game === 'arknights' ? 0 : 1)) return false
        const prior = list[index - 1]
        return !prior || compareTime(prior, item) !== 0 ||
          (order !== undefined && prior.order !== undefined && order !== prior.order)
      })
      const stat: GachaPoolStat = {
        group, game, uid, pityKnown, bannerName: pool, count: list.length, topRank, secondRank,
        topPity: 0, secondPity: secondRank === null ? null : 0,
        lastTopName: null, lastTopTime: null, lastSecondName: null, lastSecondTime: null
      }
      const top: GachaRecord[] = []
      const topAndSecond: GachaRecord[] = []
      const lastPosition = new Map<number, number>()
      let latestBanner: string | undefined
      list.forEach(({ record, order, identifier, time }, index) => {
        latestBanner = record.bannerName || latestBanner
        stats.rankCounts[String(record.rankType)] = (stats.rankCounts[String(record.rankType)] ?? 0) + 1
        if (stats.lastUpdated === null || record.time > stats.lastUpdated) stats.lastUpdated = record.time
        const position = index + 1
        const prior = lastPosition.get(record.rankType) ?? 0
        const highRank = record.rankType >= (secondRank ?? topRank)
        const row = includeAllRecords || highRank
          ? { ...record, group, pityAtPull: pityKnown ? position - prior : undefined }
          : undefined
        lastPosition.set(record.rankType, position)
        if (includeAllRecords && row) all.push({ record: row, order, identifier, time })
        if (record.rankType >= topRank) {
          stat.lastTopName = record.itemName
          stat.lastTopTime = record.time
          stat.topPity = 0
          if (row) top.push(row)
        } else stat.topPity++
        if (record.rankType === secondRank) {
          stat.lastSecondName = record.itemName
          stat.lastSecondTime = record.time
          stat.secondPity = 0
        } else if (stat.secondPity !== null) stat.secondPity++
        if (highRank && row) topAndSecond.push(row)
      })
      stat.bannerName = poolName(game, pool, latestBanner)
      stats.total += list.length
      stats.pools.push(stat)
      this.pools.set(group, { top: top.reverse(), topAndSecond: topAndSecond.reverse() })
    }
    for (const stats of this.statsByGame.values()) stats.pools.sort((left, right) => right.count - left.count)
    this.records = all.sort((left, right) => compare(right, left)).map(({ record }) => record)
  }

  stats(game: GachaGame = this.defaultGame): GachaStats {
    return this.statsByGame.get(game) ?? emptyStats(game)
  }

  page(group: string, showSecond: boolean, offset: number, limit: number): GachaRecordPage {
    const parsedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 40
    const parsedOffset = Number.isSafeInteger(offset) ? Math.max(0, offset) : 0
    const pool = this.pools.get(group)
    const records = (showSecond ? pool?.topAndSecond : pool?.top) ?? []
    return {
      records: records.slice(parsedOffset, parsedOffset + parsedLimit),
      offset: parsedOffset, limit: parsedLimit, matched: records.length
    }
  }
}

function emptyStats(game: GachaGame): GachaStats {
  return { total: 0, pools: [], rankCounts: {}, topRank: topRankFor(game), secondRank: secondRankFor(game), lastUpdated: null }
}
