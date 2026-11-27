/**
 * Shared formatter/parser for the Kevin HUD system-memory metric.
 *
 * The main process puts one bounded display string into `values.memory`, while
 * the renderer may parse that string to place the used/total text and the
 * percentage (or its progress arc) independently. This module is deliberately
 * pure: it performs no OS sampling and keeps no mutable state. An unavailable
 * metric stays `null` so the existing HUD fallback can render `--`.
 */

export type KevinHudMemoryUnit = 'B' | 'KB' | 'MB' | 'GB'

/** Typed view of the one canonical memory display string. */
export interface KevinHudMemoryDisplay {
  /** Canonical complete text, e.g. `9.7 / 31.3 GB · 31%`. */
  text: string
  /** Used/total text without the percentage, e.g. `9.7 / 31.3 GB`. */
  usage: string | null
  /** Used amount, e.g. `9.7`; null for a legacy percent-only value. */
  used: string | null
  /** Total amount, e.g. `31.3`; null for a legacy percent-only value. */
  total: string | null
  /** Unit shared by `used` and `total`; null for a legacy percent-only value. */
  unit: KevinHudMemoryUnit | null
  /** Compact percentage, e.g. `31%`. */
  percent: string
  /** Rounded percentage in 0..100 for a progress arc. */
  percentValue: number
}

const BYTE_UNITS: ReadonlyArray<{ unit: KevinHudMemoryUnit; bytes: number }> = [
  { unit: 'GB', bytes: 1024 ** 3 },
  { unit: 'MB', bytes: 1024 ** 2 },
  { unit: 'KB', bytes: 1024 },
  { unit: 'B', bytes: 1 }
]

const MAX_DISPLAY_LENGTH = 64
const FULL_PATTERN =
  /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*(GB|MB|KB|B)\s*·\s*(\d{1,3})%$/
const PERCENT_PATTERN = /^(\d{1,3})%$/

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value))

const finiteBytes = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/**
 * Format real used/total bytes as one compact display string:
 * `9.7 / 31.3 GB · 31%`.
 *
 * Both amounts share the unit chosen from the total, and the percentage is
 * derived from the same pair. Invalid or inconsistent readings (non-finite,
 * non-positive total, negative or greater-than-total used) return `null`; they
 * are never replaced by a fabricated measurement.
 */
export function formatKevinHudMemoryDisplay(
  usedBytes: number | null | undefined,
  totalBytes: number | null | undefined
): string | null {
  if (!finiteBytes(usedBytes) || !finiteBytes(totalBytes)) return null
  if (usedBytes < 0 || totalBytes <= 0 || usedBytes > totalBytes) return null

  const chosen = BYTE_UNITS.find(({ bytes }) => totalBytes >= bytes) ?? BYTE_UNITS[BYTE_UNITS.length - 1]
  const amount = (bytes: number): string =>
    chosen.unit === 'B'
      ? String(Math.round(bytes))
      : (bytes / chosen.bytes).toFixed(1)

  const used = amount(usedBytes)
  const total = amount(totalBytes)
  const percentValue = Math.round(clampPercent((usedBytes / totalBytes) * 100))
  return `${used} / ${total} ${chosen.unit} · ${percentValue}%`
}

/**
 * Parse the canonical display string produced by
 * `formatKevinHudMemoryDisplay`. A legacy percent-only value (`31%`) is also
 * accepted, which keeps old callers usable and lets a multi-metric layout show
 * just the compact percentage. `null`, empty text and `--` mean unavailable and
 * return `null`.
 */
export function parseKevinHudMemoryDisplay(
  value: string | null | undefined
): KevinHudMemoryDisplay | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text === '--' || text.length > MAX_DISPLAY_LENGTH) return null

  const percentOnly = PERCENT_PATTERN.exec(text)
  if (percentOnly) {
    const percentValue = Number.parseInt(percentOnly[1], 10)
    if (percentValue > 100) return null
    return {
      text: `${percentValue}%`,
      usage: null,
      used: null,
      total: null,
      unit: null,
      percent: `${percentValue}%`,
      percentValue
    }
  }

  const full = FULL_PATTERN.exec(text)
  if (!full) return null
  const usedText = full[1]
  const totalText = full[2]
  const unit = full[3] as KevinHudMemoryUnit
  const used = Number.parseFloat(usedText)
  const total = Number.parseFloat(totalText)
  const percentValue = Number.parseInt(full[4], 10)
  if (!Number.isFinite(used) || !Number.isFinite(total)) return null
  if (total <= 0 || used < 0 || used > total || percentValue > 100) return null

  const usage = `${usedText} / ${totalText} ${unit}`
  return {
    text: `${usage} · ${percentValue}%`,
    usage,
    used: usedText,
    total: totalText,
    unit,
    percent: `${percentValue}%`,
    percentValue
  }
}
