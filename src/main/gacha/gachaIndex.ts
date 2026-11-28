import type { GachaGame, GachaPoolStat, GachaRecord, GachaRecordPage, GachaStats } from '@shared/types'
import { gachaTimeWithOffset, gachaWallTime, isGachaInstant } from './gachaTime'
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

function sourceInstant(record: GachaRecord): number | undefined {
  if (isGachaInstant(record.timestampMs)) return record.timestampMs
  if (record.game === 'arknights' && record.uid) {
    // Older native records embedded the service's millisecond timestamp in their ID.
    const prefix = `arknights:${record.uid}:`
    const suffix = `:${record.seq}:${record.itemId}`
    if (record.seq && record.id.startsWith(prefix) && record.id.endsWith(suffix)) {
      const source = record.id.slice(prefix.length, -suffix.length)
      const millis = Number(source)
      if (/^\d+$/.test(source) && millis > 0 && isGachaInstant(millis)) return millis
    }
  }
  return gachaTimeWithOffset(record.time, record.timezone)
}

interface KeyedRecord {
  record: GachaRecord
  order?: string
  /** An absolute instant, or a wall-clock ordinal when `absolute` is false. */
  time?: number
  absolute: boolean
  identifier: string
}

/** How a group's records can be put in source order using only data it carries. */
type OrderBasis = 'source' | 'absolute' | 'sameSecond' | 'partial'

interface GroupBuild {
  pool: string
  list: KeyedRecord[]
  allOrder: boolean
  allAbsolute: boolean
  allNonAbsolute: boolean
  sameWall: boolean
  firstWall?: number
}

interface PoolIndex {
  top: GachaRecord[]
  topAndSecond: GachaRecord[]
}

function compareTime(left: KeyedRecord, right: KeyedRecord): number {
  // Display unplaced wall-clock records separately from records on the UTC timeline.
  if (left.absolute !== right.absolute) return left.absolute ? 1 : -1
  if (left.time !== undefined && right.time !== undefined) return left.time - right.time
  if (left.time !== right.time) return left.time === undefined ? -1 : 1
  return left.record.time < right.record.time ? -1 : left.record.time > right.record.time ? 1 : 0
}

function compareOrder(left: KeyedRecord, right: KeyedRecord): number {
  if (left.order !== undefined && right.order !== undefined) {
    const order = compareDigits(left.order, right.order)
    if (order) return order
  }
  if (left.order !== right.order) return left.order === undefined ? -1 : 1
  return left.identifier < right.identifier ? -1 : left.identifier > right.identifier ? 1 : 0
}

function compare(left: KeyedRecord, right: KeyedRecord): number {
  const time = compareTime(left, right)
  if (time) return time
  return compareOrder(left, right)
}

function orderBasis(game: GachaGame, group: GroupBuild): OrderBasis {
  // The service record ID is monotonic for one account and pool. Unlike the
  // displayed wall clock it does not depend on a known timezone.
  if (game !== 'arknights' && group.allOrder) return 'source'
  if (group.allAbsolute) return 'absolute'
  if (group.allNonAbsolute && group.allOrder && group.sameWall) return 'sameSecond'
  return 'partial'
}

function comparatorFor(basis: OrderBasis): (left: KeyedRecord, right: KeyedRecord) => number {
  if (basis === 'source' || basis === 'sameSecond') return compareOrder
  return compare
}

/**
 * True when the adjacent records have provable order. A source sequence is the
 * strongest evidence for the three miHoYo games; without it only absolute
 * instants, or one wall-clock second plus distinct source positions, suffice.
 */
function linked(left: KeyedRecord, right: KeyedRecord, basis: OrderBasis): boolean {
  if (basis === 'source' || basis === 'sameSecond') {
    return left.order !== undefined && right.order !== undefined &&
      compareDigits(left.order, right.order) !== 0
  }
  if (left.absolute !== right.absolute) return false
  if (left.time === undefined || right.time === undefined) return false
  if (left.time !== right.time) return left.absolute
  return left.order !== undefined && right.order !== undefined &&
    compareDigits(left.order, right.order) !== 0
}

/** Build the sorted projection and rarity summaries once per committed data revision. */
export class GachaIndex {
  readonly records: GachaRecord[]
  private readonly defaultGame: GachaGame
  private readonly pools = new Map<string, PoolIndex>()
  private readonly statsByGame = new Map<GachaGame, GachaStats>()

  constructor(records: readonly GachaRecord[], includeAllRecords = true) {
    this.defaultGame = records[0]?.game ?? 'genshin'
    const grouped = new Map<string, GroupBuild>()
    for (const record of records) {
      const pool = poolGroup(record.game, record.gachaType, record.poolId, record.uigfGachaType)
      const group = JSON.stringify([record.game, record.uid, pool])
      const current = grouped.get(group) ?? {
        pool, list: [], allOrder: true, allAbsolute: true, allNonAbsolute: true, sameWall: true
      }
      const when = sourceInstant(record)
      const wall = when === undefined ? gachaWallTime(record.time) : undefined
      const order = orderKey(record)
      current.list.push({
        record, order, identifier: recordIdentity(record),
        time: when ?? wall, absolute: when !== undefined
      })
      if (order === undefined) current.allOrder = false
      if (when === undefined) {
        current.allAbsolute = false
        if (wall === undefined) current.sameWall = false
        else if (current.firstWall === undefined) current.firstWall = wall
        else if (current.firstWall !== wall) current.sameWall = false
      } else {
        current.allNonAbsolute = false
      }
      grouped.set(group, current)
    }

    const all: KeyedRecord[] = []
    for (const [group, built] of grouped) {
      const { pool, list } = built
      const basis = orderBasis(list[0].record.game, built)
      list.sort(comparatorFor(basis))
      const { game, uid } = list[0].record
      const stats = this.statsByGame.get(game) ?? emptyStats(game)
      this.statsByGame.set(game, stats)
      const { topRank, secondRank } = stats
      const pityFloor = game === 'arknights' ? 0 : 1

      // Partial groups have no trusted order, so none of them may anchor a
      // pull count. For comparable bases walk back over the newest suffix; a
      // pair without provable order cannot anchor, so the suffix starts after
      // both of its records.
      let windowStart = list.length
      if (basis !== 'partial') {
        windowStart = list.length - 1
        for (let index = list.length - 1; index > 0; index--) {
          if (!linked(list[index - 1], list[index], basis)) {
            windowStart = index + 1
            break
          }
          windowStart = index - 1
        }
      }
      const fromStart = basis !== 'partial' && windowStart === 0
      const hasSecond = secondRank !== null

      const stat: GachaPoolStat = {
        group, game, uid, pityKnown: false, topPityKnown: false, secondPityKnown: false,
        bannerName: pool, count: list.length, topRank, secondRank,
        topPity: 0, secondPity: hasSecond ? 0 : null,
        lastTopName: null, lastTopTime: null, lastSecondName: null, lastSecondTime: null
      }
      const top: GachaRecord[] = []
      const topAndSecond: GachaRecord[] = []
      let latestBanner: string | undefined
      let topPity = 0
      let secondPity = 0
      let lastTopPosition: number | undefined
      let lastSecondPosition: number | undefined
      let unknownSinceTop = 0
      let unknownSinceSecond = 0
      list.forEach((keyed, index) => {
        const { record } = keyed
        latestBanner = record.bannerName || latestBanner
        stats.rankCounts[String(record.rankType)] = (stats.rankCounts[String(record.rankType)] ?? 0) + 1
        if (stats.lastUpdated === null || record.time > stats.lastUpdated) stats.lastUpdated = record.time
        const reference = record.rankType >= (secondRank ?? topRank)
        if (record.rankType >= topRank) {
          stat.lastTopName = record.itemName
          stat.lastTopTime = record.time
        }
        if (record.rankType === secondRank) {
          stat.lastSecondName = record.itemName
          stat.lastSecondTime = record.time
        }
        let pityAtPull: number | undefined
        if (index >= windowStart) {
          const position = index - windowStart + 1
          if (record.rankType < pityFloor || !Number.isSafeInteger(record.rankType)) {
            // Unknown rarity may have been either display tier. It only matters
            // after a known win; a later known win starts a fresh window.
            unknownSinceTop++
            unknownSinceSecond++
            topPity++
            if (hasSecond) secondPity++
          } else {
            if (record.rankType >= topRank) {
              if (unknownSinceTop === 0) {
                if (lastTopPosition !== undefined) pityAtPull = position - lastTopPosition
                else if (fromStart) pityAtPull = position
              }
              topPity = 0
              lastTopPosition = position
              unknownSinceTop = 0
            } else {
              topPity++
            }
            if (hasSecond) {
              if (record.rankType === secondRank) {
                if (unknownSinceSecond === 0) {
                  if (lastSecondPosition !== undefined) pityAtPull = position - lastSecondPosition
                  else if (fromStart) pityAtPull = position
                }
                secondPity = 0
                lastSecondPosition = position
                unknownSinceSecond = 0
              } else {
                secondPity++
              }
            }
          }
        }
        if (includeAllRecords || reference) {
          const row = { ...record, group, pityAtPull: uid ? pityAtPull : undefined }
          if (includeAllRecords) all.push({ ...keyed, record: row })
          if (record.rankType >= topRank) top.push(row)
          if (reference) topAndSecond.push(row)
        }
      })
      stat.bannerName = poolName(game, pool, latestBanner)
      stat.topPityKnown = Boolean(uid) && unknownSinceTop === 0 &&
        (lastTopPosition !== undefined || fromStart)
      stat.secondPityKnown = Boolean(uid) && hasSecond && unknownSinceSecond === 0 &&
        (lastSecondPosition !== undefined || fromStart)
      stat.pityKnown = stat.topPityKnown && (!hasSecond || stat.secondPityKnown)
      stat.topPity = topPity
      stat.secondPity = hasSecond ? secondPity : null
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
