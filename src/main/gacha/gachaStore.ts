import { app } from 'electron'
import { join } from 'path'
import type { GachaRecord, GachaStats, GachaPoolStat } from '@shared/types'
import { writeFileAtomic } from '../services/atomicFile'
import { openJsonStore } from '../services/jsonStore'
import { topRankFor, secondRankFor, poolGroup, poolName } from './metadata'

interface StoreShape {
  version: number
  records: GachaRecord[]
}

const CURRENT_VERSION = 1

/**
 * The API `id` (the last `:`-separated part of our composite id) is monotonic,
 * so it gives the true pull order. Records pulled within the same second share
 * the same `time` string — sorting by time alone leaves them reversed.
 */
function idNumber(id: string): bigint {
  const tail = id.slice(id.lastIndexOf(':') + 1).replace(/\D/g, '')
  try {
    return tail ? BigInt(tail) : 0n
  } catch {
    return 0n
  }
}

/** Oldest → newest pull order (time, then API id). */
function compareAscending(a: GachaRecord, b: GachaRecord): number {
  if (a.time !== b.time) return a.time < b.time ? -1 : 1
  const na = idNumber(a.id)
  const nb = idNumber(b.id)
  return na < nb ? -1 : na > nb ? 1 : 0
}

/** Persists gacha records per application to `%userData%/gacha/<appId>.json`. */
export class GachaStore {
  private readonly cache = new Map<string, GachaRecord[]>()
  private readonly saveTimers = new Map<string, NodeJS.Timeout>()
  /** App ids whose store file could not be read — writes are refused for them. */
  private readonly saveBlocked = new Set<string>()

  private dir(): string {
    return join(app.getPath('userData'), 'gacha')
  }

  private file(appId: string): string {
    return join(this.dir(), `${appId}.json`)
  }

  async load(appId: string): Promise<GachaRecord[]> {
    const cached = this.cache.get(appId)
    if (cached) return cached
    const { data, writable } = await openJsonStore<StoreShape>(
      this.file(appId),
      () => ({ version: CURRENT_VERSION, records: [] }),
      `gacha:${appId}`
    )
    const records = Array.isArray(data.records) ? data.records : []
    if (writable) this.saveBlocked.delete(appId)
    else this.saveBlocked.add(appId)
    this.cache.set(appId, records)
    return records
  }

  /** Add records, skipping duplicates. Returns the number of new records. */
  async add(appId: string, incoming: GachaRecord[]): Promise<number> {
    const records = await this.load(appId)
    const seen = new Set(records.map((r) => r.id))
    let added = 0
    for (const record of incoming) {
      if (seen.has(record.id)) continue
      seen.add(record.id)
      records.push({ ...record, appId })
      added += 1
    }
    if (added > 0) this.scheduleSave(appId)
    return added
  }

  async clear(appId: string): Promise<void> {
    this.cache.set(appId, [])
    this.scheduleSave(appId)
  }

  /** Drop the in-memory cache so records are re-read from disk. */
  reload(): void {
    this.cache.clear()
  }

  /**
   * Records sorted newest first, each annotated with `pityAtPull` (the number
   * of pulls since the previous item of the same rarity within the same pool).
   */
  async list(appId: string): Promise<GachaRecord[]> {
    const records = await this.load(appId)
    const game = records[0]?.game ?? 'genshin'

    const byGroup = new Map<string, GachaRecord[]>()
    for (const record of records) {
      const group = poolGroup(game, record.gachaType, record.poolId)
      const list = byGroup.get(group)
      if (list) list.push(record)
      else byGroup.set(group, [record])
    }

    const pityById = new Map<string, number>()
    const groupById = new Map<string, string>()
    for (const [group, list] of byGroup) {
      for (const record of list) groupById.set(record.id, group)
      const ascending = [...list].sort(compareAscending)
      const lastPos: Record<number, number> = {}
      ascending.forEach((record, index) => {
        const position = index + 1
        const previous = lastPos[record.rankType] ?? 0
        pityById.set(record.id, position - previous)
        lastPos[record.rankType] = position
      })
    }

    return [...records]
      .sort((a, b) => -compareAscending(a, b))
      .map((record) => ({
        ...record,
        group: groupById.get(record.id),
        pityAtPull: pityById.get(record.id)
      }))
  }

  async stats(appId: string): Promise<GachaStats> {
    const records = await this.load(appId)
    const game = records[0]?.game ?? 'genshin'
    const topRank = topRankFor(game)
    const secondRank = secondRankFor(game)

    const rankCounts: Record<string, number> = {}
    const byGroup = new Map<string, GachaRecord[]>()
    for (const record of records) {
      rankCounts[String(record.rankType)] = (rankCounts[String(record.rankType)] ?? 0) + 1
      const group = poolGroup(game, record.gachaType, record.poolId)
      const list = byGroup.get(group)
      if (list) list.push(record)
      else byGroup.set(group, [record])
    }

    const pools: GachaPoolStat[] = []
    for (const [group, list] of byGroup) {
      const ascending = [...list].sort(compareAscending)
      let topPity = 0
      let secondPity = 0
      let lastTopName: string | null = null
      let lastTopTime: string | null = null
      let lastSecondName: string | null = null
      let lastSecondTime: string | null = null
      let latestBanner: string | undefined

      for (const record of ascending) {
        latestBanner = record.bannerName || latestBanner
        if (record.rankType >= topRank) {
          topPity = 0
          lastTopName = record.itemName
          lastTopTime = record.time
        } else {
          topPity += 1
        }
        if (record.rankType === secondRank) {
          secondPity = 0
          lastSecondName = record.itemName
          lastSecondTime = record.time
        } else {
          secondPity += 1
        }
      }

      pools.push({
        group,
        bannerName: poolName(game, group, latestBanner),
        count: list.length,
        topRank,
        secondRank,
        topPity,
        lastTopName,
        lastTopTime,
        secondPity,
        lastSecondName,
        lastSecondTime
      })
    }
    pools.sort((a, b) => b.count - a.count)

    const lastUpdated = records.length
      ? records.reduce((max, r) => (r.time > max ? r.time : max), records[0].time)
      : null

    return { total: records.length, rankCounts, topRank, secondRank, pools, lastUpdated }
  }

  /** UIGF-flavoured export object. */
  async exportUigf(appId: string, appName: string): Promise<string> {
    const records = await this.list(appId)
    const uid = records[0]?.uid ?? ''
    const payload = {
      info: {
        uid,
        lang: 'zh-cn',
        export_time: new Date().toISOString(),
        export_app: 'KevinLauncher',
        export_app_version: app.getVersion(),
        uigf_version: 'v4.0'
      },
      hk4e: records
    }
    void appName
    return JSON.stringify(payload, null, 2)
  }

  /** Import from a UIGF-ish or raw record list. Returns number added. */
  async importRecords(appId: string, raw: string): Promise<number> {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('文件不是有效的 JSON')
    }
    const obj = parsed as Record<string, unknown>
    const list =
      (obj.list as unknown[]) ??
      (obj.hk4e as unknown[]) ??
      (obj.hkrpg as unknown[]) ??
      (obj.nap as unknown[]) ??
      (Array.isArray(parsed) ? (parsed as unknown[]) : [])
    const incoming: GachaRecord[] = []
    for (const item of list) {
      const r = item as Record<string, unknown>
      const id = String(r.id ?? r.recordId ?? '')
      if (!id) continue
      incoming.push({
        id,
        appId,
        game: (r.game as GachaRecord['game']) ?? 'genshin',
        uid: String(r.uid ?? ''),
        gachaType: String(r.gacha_type ?? r.gachaType ?? ''),
        bannerName: String(r.bannerName ?? ''),
        itemId: String(r.item_id ?? r.itemId ?? ''),
        itemName: String(r.name ?? r.itemName ?? ''),
        rankType: Number(r.rank_type ?? r.rankType ?? 0),
        time: String(r.time ?? ''),
        seq: r.seq != null ? String(r.seq) : undefined
      })
    }
    return this.add(appId, incoming)
  }

  private scheduleSave(appId: string): void {
    if (this.saveTimers.has(appId)) return
    const timer = setTimeout(() => {
      this.saveTimers.delete(appId)
      void this.save(appId)
    }, 800)
    this.saveTimers.set(appId, timer)
  }

  private async save(appId: string): Promise<void> {
    if (this.saveBlocked.has(appId)) return
    const records = this.cache.get(appId) ?? []
    const data: StoreShape = { version: CURRENT_VERSION, records }
    await writeFileAtomic(this.file(appId), JSON.stringify(data)).catch(() => undefined)
  }
}
