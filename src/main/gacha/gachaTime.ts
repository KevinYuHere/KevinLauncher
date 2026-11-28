const WALL_CLOCK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

/** An ordinal for a wall clock reading, independent of the host's time zone. */
export function gachaWallTime(value: unknown): number | undefined {
  if (typeof value !== 'string' || !WALL_CLOCK.test(value)) return undefined
  const iso = value.replace(' ', 'T')
  const date = new Date(iso + 'Z')
  const time = date.getTime()
  return Number.isFinite(time) && date.toISOString().slice(0, 19) === iso ? time : undefined
}

export function gachaTimezoneOffset(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= -12 && value <= 14 ? value : undefined
}

export function gachaTimeWithOffset(time: string, timezone?: number): number | undefined {
  const offset = gachaTimezoneOffset(timezone)
  if (offset === undefined) return undefined
  const wall = gachaWallTime(time)
  return wall === undefined ? undefined : wall - offset * 3_600_000
}

export function isGachaInstant(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15
}
