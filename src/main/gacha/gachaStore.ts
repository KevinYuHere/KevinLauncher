import { app } from 'electron'
import { join } from 'path'
import type { GachaGame, GachaRecord, GachaRecordPage, GachaStats } from '@shared/types'
import { writeFileAtomic } from '../services/atomicFile'
import { openJsonStore } from '../services/jsonStore'
import { currentAppVersion } from '../services/appVersion'
import { GachaIndex, recordIdentity } from './gachaIndex'
import { decodeGachaArchive, exportGachaArchive } from './gachaFormats'
import { isObject } from '../services/configValidation'
import {
  readSyncCheckpoints,
  syncKey,
  type MiHoYoSyncCheckpoint,
  type MiHoYoSyncCheckpoints
} from './gachaSync'
import type { GachaIndexClient } from './gachaIndexClient'
import type { IndexQuery } from './gachaIndexMessages'

interface StoreShape {
  version: number
  records: GachaRecord[]
  /** Optional incremental-sync boundaries, validated independently of records. */
  sync?: unknown
}

const CURRENT_VERSION = 1
const LARGE_HISTORY_SIZE = 20_000
const DATASET_LIMIT = 6

function enrichRecord(previous: GachaRecord, incoming: GachaRecord): GachaRecord | undefined {
  const patch: Partial<GachaRecord> = {}
  for (const key of ['lang', 'gachaId', 'timestampMs', 'uigfGachaType', 'seq'] as const) {
    if (previous[key] === undefined && incoming[key] !== undefined) Object.assign(patch, { [key]: incoming[key] })
  }
  if (previous.timezone === undefined && incoming.timezone !== undefined && previous.time === incoming.time &&
      (previous.timestampMs === undefined || previous.timestampMs === incoming.timestampMs)) {
    patch.timezone = incoming.timezone
  }
  if (previous.rankType === 0 && previous.game !== 'arknights' && incoming.rankType > 0) patch.rankType = incoming.rankType
  if (Object.keys(patch).length) return { ...previous, ...patch }
  return undefined
}

/** Persists gacha records per application to `%userData%/gacha/<appId>.json`. */
export class GachaStore {
  private readonly cache = new Map<string, GachaRecord[]>()
  private readonly loading = new Map<string, Promise<GachaRecord[]>>()
  private readonly pending = new Map<string, GachaRecord[]>()
  private readonly writes = new Map<string, Promise<void>>()
  private readonly indexes = new Map<string, { records: GachaRecord[]; index: GachaIndex }>()
  private readonly syncs = new Map<string, MiHoYoSyncCheckpoints>()
  private largeIndex: Promise<GachaIndexClient> | undefined
  private readonly revisions = new WeakMap<GachaRecord[], number>()
  private revision = 0
  private dir(): string {
    return join(app.getPath('userData'), 'gacha')
  }

  private file(appId: string): string {
    if (!/^[a-z0-9_-]+$/i.test(appId)) throw new Error('无效的应用编号')
    return join(this.dir(), `${appId}.json`)
  }

  async load(appId: string): Promise<GachaRecord[]> {
    const cached = this.cache.get(appId)
    if (cached) {
      this.remember(appId, cached)
      return cached
    }
    let pending = this.loading.get(appId)
    if (!pending) {
      pending = this.read(appId).finally(() => this.loading.delete(appId))
      this.loading.set(appId, pending)
    }
    return pending
  }

  private async read(appId: string): Promise<GachaRecord[]> {
    const { data, writable } = await openJsonStore<StoreShape>(
      this.file(appId),
      () => ({ version: CURRENT_VERSION, records: [] }),
      `gacha:${appId}`
    )
    const valid = isObject(data) && (data.version === undefined || data.version === CURRENT_VERSION) &&
      Array.isArray(data.records) && data.records.every((entry) => isObject(entry) &&
        typeof entry.id === 'string' && typeof entry.time === 'string' &&
        ['genshin', 'starrail', 'zzz', 'arknights'].includes(String(entry.game)) &&
        typeof entry.gachaType === 'string' && Number.isFinite(entry.rankType))
    if (!writable) throw new Error('无法读取现有抽卡记录，已保留原文件')
    if (!valid) throw new Error('抽卡记录版本或格式不受支持，已保留原文件')
    const records = data.records.map((record) => ({ ...record, appId, uid: typeof record.uid === 'string' ? record.uid : '' }))
    // A malformed sync section only loses the incremental hint; records stay.
    this.syncs.set(appId, readSyncCheckpoints(data.sync))
    this.remember(appId, records)
    return records
  }

  /** Add records, skipping duplicates. Returns the number of new records. */
  async add(appId: string, incoming: GachaRecord[], checkpointUpdates?: readonly MiHoYoSyncCheckpoint[]): Promise<number> {
    return this.enqueue(appId, async () => {
      const current = await this.load(appId)
      const previous = this.pending.get(appId) ?? current
      const records = previous.slice()
      const seen = new Map(records.map((record, index) => [recordIdentity(record), index]))
      let changed = previous !== current
      for (const record of incoming) {
        const key = recordIdentity(record)
        const existing = seen.get(key)
        if (existing !== undefined) {
          const enriched = enrichRecord(records[existing], record)
          if (enriched) {
            records[existing] = enriched
            changed = true
          }
          continue
        }
        seen.set(key, records.length)
        records.push({ ...record, appId })
        changed = true
      }
      const currentSync = this.syncs.get(appId) ?? {}
      const nextSync = checkpointUpdates?.length ? { ...currentSync } : currentSync
      let syncChanged = false
      for (const checkpoint of checkpointUpdates ?? []) {
        const key = syncKey(checkpoint.game, checkpoint.uid, checkpoint.pool)
        const old = nextSync[key]
        nextSync[key] = checkpoint
        if (!old || old.boundaryId !== checkpoint.boundaryId || old.completedAt !== checkpoint.completedAt ||
            old.pages !== checkpoint.pages) syncChanged = true
      }
      const added = records.length - current.length
      if (changed || syncChanged) {
        this.pending.set(appId, records)
        await this.save(appId, records, nextSync)
      }
      return added
    })
  }

  /** Persist fetch results and their trusted sync boundaries in one atomic write. */
  async addWithSync(
    appId: string,
    incoming: GachaRecord[],
    checkpoints: readonly MiHoYoSyncCheckpoint[]
  ): Promise<number> {
    return this.add(appId, incoming, checkpoints)
  }

  /** Trusted boundaries for the current app, optionally limited to one game. */
  async checkpoints(appId: string, game?: GachaGame): Promise<MiHoYoSyncCheckpoint[]> {
    await this.load(appId)
    return Object.values(this.syncs.get(appId) ?? {})
      .filter((checkpoint) => game === undefined || checkpoint.game === game)
      .map((checkpoint) => ({ ...checkpoint }))
  }

  async clear(appId: string): Promise<void> {
    return this.enqueue(appId, async () => {
      await this.load(appId)
      await this.save(appId, [], {})
    })
  }

  async flush(): Promise<void> {
    await Promise.all(this.writes.values())
    const results = await Promise.allSettled([...this.pending.keys()].map((appId) => this.enqueue(appId, async () => {
      const records = this.pending.get(appId)
      if (records) await this.save(appId, records)
    })))
    const failure = results.find((result) => result.status === 'rejected')
    if (failure) throw failure.reason
  }

  /** Reload only after outstanding writes have either succeeded or reported failure. */
  async reload(): Promise<void> {
    await Promise.allSettled(this.loading.values())
    await this.flush()
    this.cache.clear()
    this.indexes.clear()
    this.syncs.clear()
    await this.dispose()
  }

  async dispose(): Promise<void> {
    const large = this.largeIndex
    this.largeIndex = undefined
    if (large) await (await large).stop()
  }

  private async index(appId: string): Promise<GachaIndex> {
    const records = await this.load(appId)
    const cached = this.indexes.get(appId)
    if (cached?.records === records) return cached.index
    const index = new GachaIndex(records, false)
    this.indexes.set(appId, { records, index })
    return index
  }

  async count(appId: string, game?: GachaGame): Promise<number> {
    const records = await this.load(appId)
    return game ? records.reduce((total, record) => total + Number(record.game === game), 0) : records.length
  }

  async list(appId: string): Promise<GachaRecord[]> {
    return new GachaIndex(await this.load(appId)).records
  }

  async stats(appId: string, game?: GachaGame): Promise<GachaStats> {
    const result = await this.queryLargeIndex(appId, { type: 'stats', game })
    return result ? result as GachaStats : (await this.index(appId)).stats(game)
  }

  async page(appId: string, group: string, showSecond: boolean, offset: number, limit = 40): Promise<GachaRecordPage> {
    const result = await this.queryLargeIndex(appId, { type: 'page', group, showSecond, offset, limit })
    return result ? result as GachaRecordPage : (await this.index(appId)).page(group, showSecond, offset, limit)
  }

  private async queryLargeIndex(appId: string, query: IndexQuery): Promise<GachaStats | GachaRecordPage | null> {
    let records = await this.load(appId)
    while (records.length >= LARGE_HISTORY_SIZE) {
      let revision = this.revisions.get(records)
      if (revision === undefined) {
        revision = ++this.revision
        this.revisions.set(records, revision)
      }
      this.largeIndex ??= import('./gachaIndexClient').then(({ GachaIndexClient }) => new GachaIndexClient())
      const client = await this.largeIndex
      const reply = await client.request({ appId, file: this.file(appId), revision, query })
      const current = await this.load(appId)
      if (current === records) return reply
      records = current
    }
    return null
  }

  async exportArchive(appId: string): Promise<ReturnType<typeof exportGachaArchive>> {
    return exportGachaArchive(await this.load(appId), currentAppVersion())
  }

  async importRecords(appId: string, raw: string, game?: GachaGame): Promise<number> {
    return this.add(appId, decodeGachaArchive(raw, appId, game))
  }

  private enqueue<T>(appId: string, action: () => Promise<T>): Promise<T> {
    const chain = this.writes.get(appId) ?? Promise.resolve()
    const task = chain.then(action)
    const next = task.then(() => undefined, () => undefined)
    this.writes.set(appId, next)
    void next.then(() => {
      if (this.writes.get(appId) === next) this.writes.delete(appId)
    })
    return task
  }

  private remember(appId: string, records: GachaRecord[]): void {
    this.cache.delete(appId)
    this.cache.set(appId, records)
    if (this.cache.size <= DATASET_LIMIT) return
    for (const key of this.cache.keys()) {
      if (key === appId || this.writes.has(key) || this.pending.has(key)) continue
      this.cache.delete(key)
      this.indexes.delete(key)
      if (this.cache.size <= DATASET_LIMIT) break
    }
  }

  private async save(appId: string, records: GachaRecord[], sync?: MiHoYoSyncCheckpoints): Promise<void> {
    const nextSync = sync ?? this.syncs.get(appId) ?? {}
    const data: StoreShape = { version: CURRENT_VERSION, records, sync: nextSync }
    await writeFileAtomic(this.file(appId), JSON.stringify(data))
    this.remember(appId, records)
    this.indexes.delete(appId)
    this.syncs.set(appId, nextSync)
    this.pending.delete(appId)
  }
}
