import type { PlayTimeDay, PlayTimeTotals } from '@shared/types'
import type { PlaySessionRecord } from './playTimeStore'

function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function localBoundary(today: Date, offset: number): number {
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset).getTime()
}

/** Use local calendar boundaries while preserving stored elapsed seconds. */
export function calculatePlayTime(
  sessions: readonly PlaySessionRecord[],
  appId: string,
  requestedDays: number,
  now = Date.now()
): PlayTimeTotals {
  const days = Number.isFinite(requestedDays) ? Math.max(1, Math.min(731, Math.trunc(requestedDays))) : 14
  const today = new Date(now)
  const length = Math.max(days, 30)
  const boundaries = Array.from({ length: length + 1 }, (_, index) => localBoundary(today, index - length + 1))
  const buckets = Array<number>(length).fill(0)
  let totalSec = 0

  for (const session of sessions) {
    if (session.appId !== appId) continue
    totalSec += session.durationSec
    const start = Date.parse(session.startUtc)
    const end = Date.parse(session.endUtc)
    if (!Number.isFinite(start) || end <= boundaries[0] || start >= boundaries[length]) continue
    // Legacy durations are already rounded. Allocate each day its share of
    // the elapsed seconds using cumulative rounding so the parts add back up.
    const elapsed = end - start
    let first = 0
    let last = length
    while (first < last) {
      const middle = (first + last) >> 1
      if (boundaries[middle + 1] <= start) first = middle + 1
      else last = middle
    }
    if (!Number.isFinite(end) || elapsed <= 0) {
      if (first < length && start >= boundaries[0]) buckets[first] += session.durationSec
      continue
    }
    const secondsAt = (point: number): number => {
      if (point <= start) return 0
      if (point >= end) return session.durationSec
      return Math.floor(session.durationSec * (point - start) / elapsed)
    }
    for (let index = first; index < length && boundaries[index] < end; index++) {
      buckets[index] += secondsAt(boundaries[index + 1]) - secondsAt(boundaries[index])
    }
  }
  const daily: PlayTimeDay[] = buckets.slice(-days).map((sec, index) => ({
    date: dayKey(new Date(boundaries[length - days + index])), sec
  }))
  const sum = (count: number): number => buckets.slice(-count).reduce((total, seconds) => total + seconds, 0)
  return { totalSec, todaySec: buckets[length - 1], weekSec: sum(7), monthSec: sum(30), daily }
}
