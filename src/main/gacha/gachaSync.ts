import type { GachaGame } from '@shared/types'
import type { MiHoYoGame } from './metadata'

export type MiHoYoSyncMode = 'incremental' | 'full'

/**
 * The newest record covered by one continuous, successfully completed sync of
 * a single account and pool. Incremental syncs page from the newest record
 * until they cross this boundary and then stop.
 */
export interface MiHoYoSyncCheckpoint {
  game: MiHoYoGame
  uid: string
  pool: string
  /** Newest source record ID known to be covered by the trusted sync chain. */
  boundaryId: string
  /** When the checkpoint was written (epoch milliseconds). */
  completedAt: number
  /** Pages traversed when this checkpoint was established. */
  pages: number
}

export type MiHoYoSyncCheckpoints = Record<string, MiHoYoSyncCheckpoint>

const GAMES = new Set<string>(['genshin', 'starrail', 'zzz'])
const DECIMAL = /^\d+$/
const MAX_CHECKPOINTS = 10_000

/** Canonical decimal form so leading zeroes cannot create a false boundary. */
export function normalizeSourceId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return undefined
  return value.replace(/^0+(?=\d)/, '')
}

/** Compare two already-normalised decimal IDs without converting to Number. */
export function compareSourceIds(left: string, right: string): number {
  const a = normalizeSourceId(left)
  const b = normalizeSourceId(right)
  if (a === undefined || b === undefined) throw new Error('抽卡记录的 ID 不是十进制数字')
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
}

export function syncKey(game: GachaGame, uid: string, pool: string): string {
  return JSON.stringify([game, uid, pool])
}

/** Validate the optional sync section without letting it invalidate records. */
export function readSyncCheckpoints(value: unknown): MiHoYoSyncCheckpoints {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: MiHoYoSyncCheckpoints = {}
  for (const [key, raw] of Object.entries(value)) {
    if (Object.keys(result).length >= MAX_CHECKPOINTS) break
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const row = raw as Record<string, unknown>
    const game = row.game
    if (typeof game !== 'string' || !GAMES.has(game)) continue
    const uid = typeof row.uid === 'string' && DECIMAL.test(row.uid) ? row.uid : undefined
    const pool = typeof row.pool === 'string' && row.pool.length > 0 && row.pool.length <= 64
      ? row.pool
      : undefined
    const boundaryId = normalizeSourceId(row.boundaryId)
    if (!uid || !pool || boundaryId === undefined || syncKey(game as GachaGame, uid, pool) !== key) continue
    result[key] = {
      game: game as MiHoYoGame,
      uid,
      pool,
      boundaryId,
      completedAt: typeof row.completedAt === 'number' && Number.isFinite(row.completedAt) ? row.completedAt : 0,
      pages: typeof row.pages === 'number' && Number.isSafeInteger(row.pages) && row.pages > 0 ? row.pages : 0
    }
  }
  return result
}

export function findCheckpoint(
  checkpoints: Iterable<MiHoYoSyncCheckpoint>,
  game: MiHoYoGame,
  uid: string,
  pool: string
): MiHoYoSyncCheckpoint | undefined {
  for (const checkpoint of checkpoints) {
    if (checkpoint.game === game && checkpoint.uid === uid && checkpoint.pool === pool) return checkpoint
  }
  return undefined
}
