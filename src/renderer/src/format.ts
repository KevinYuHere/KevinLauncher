import { dataErrorDetails } from '@shared/dataErrors'
import type { GachaGame } from '@shared/types'

/**
 * Readable reason behind a renderer rejection. Data errors keep their upstream
 * message; Electron's IPC wrapper and leading `Error:` labels are removed.
 */
export function errorReason(error: unknown): string {
  if (error == null) return ''
  const dataError = dataErrorDetails(error)
  if (dataError) return dataError.message.trim()
  return (error instanceof Error ? error.message : String(error))
    .replace(/^(?:Error:\s*)?Error invoking remote method '[^']*':\s*(?:Error:\s*)?/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}

/** Page-specific hint plus the readable reason, without printing an empty detail. */
export function failureText(error: unknown, hint: string): string {
  const reason = errorReason(error)
  return reason ? `${hint} 详情：${reason}` : hint
}

/** Human-readable rarity label (differs per game). */
export function displayRank(game: GachaGame | null, rank: number): string {
  if (game === 'arknights') return `${rank + 1}★`
  if (game === 'zzz') return rank >= 4 ? 'S' : rank === 3 ? 'A' : 'B'
  return `${rank}★`
}

/** Colour class relative to the game's top rarity. */
export function rankClass(rank: number, topRank: number): string {
  if (rank >= topRank) return 'rank-top'
  if (rank === topRank - 1) return 'rank-second'
  return 'rank-third'
}

/** Byte size with an automatically chosen unit (B / KB / MB / GB / TB). */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unit]}`
}

/** Byte-per-second speed, e.g. `3.4 MB/s`. */
export function formatSpeed(bytesPerSecond: number): string {
  if (!bytesPerSecond || bytesPerSecond <= 0 || !Number.isFinite(bytesPerSecond)) return '—'
  return `${formatBytes(bytesPerSecond)}/s`
}

/** Remaining time, e.g. `1 分 20 秒` / `2 小时 3 分`. */
export function formatEta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${Math.round(seconds % 60)} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

