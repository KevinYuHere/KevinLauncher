/**
 * Pure text contract for continuously sampled Kevin HUD metrics.
 *
 * Duration and network values update in a fixed slot, so every finite
 * non-negative input has to map to a short, bounded string and the sizing layer
 * needs a template that covers every emitted shape:
 *
 * - ordinary durations keep the historical `H:MM:SS` form with up to six hour
 *   digits (`999999:59:59`), so realistic cumulative play time never changes
 *   the reserved width;
 * - longer durations switch to whole days (`41666d`) and then to a one-decimal
 *   scientific day form (`2.1e+303d`) for finite extremes;
 * - rates keep B/s, KB/s and MB/s below 1 GiB/s, use one-decimal GB/s from
 *   1 GiB/s, and switch to a bounded scientific GB/s form at 1,000,000 GB/s.
 *
 * Unavailable input returns `null`. No displayed value is silently shortened
 * to fit a slot: the fallback forms preserve the order of magnitude and the
 * exported widest templates include rounding carries such as `1024.0 MB/s`
 * and `1000000.0 GB/s`.
 *
 * This module deliberately owns only duration/network text; percentage and the
 * existing 10,000 FPS cap remain with their current formatting helper.
 */

const KIB = 1024
const MIB = KIB * KIB
const GIB = MIB * KIB
const HOUR_SECONDS = 3600
const DAY_SECONDS = 86_400
const MAX_HOUR_FIELD = 999_999
const DAY_SCIENTIFIC_THRESHOLD = 1_000_000
const GB_SCIENTIFIC_THRESHOLD = 1_000_000

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const pad2 = (value: number): string => String(value).padStart(2, '0')

/**
 * `H:MM:SS` for ordinary durations. Finite values beyond six hour digits use a
 * compact bounded day form instead, so an hourly counter can never push an
 * arbitrary number of digits into a fixed-position HUD slot.
 */
export function formatKevinHudDuration(seconds: number | null | undefined): string | null {
  if (!finite(seconds) || seconds < 0) return null
  const total = Math.floor(seconds)
  const hours = Math.floor(total / HOUR_SECONDS)
  if (hours <= MAX_HOUR_FIELD) {
    const minutes = Math.floor((total % HOUR_SECONDS) / 60)
    return `${hours}:${pad2(minutes)}:${pad2(total % 60)}`
  }
  const days = seconds / DAY_SECONDS
  if (days < DAY_SCIENTIFIC_THRESHOLD) return `${Math.floor(days)}d`
  return `${days.toExponential(1)}d`
}

/**
 * Human-readable byte rate with binary units. Below 1 GiB/s the output is
 * compatible with the historical formatter, including its rounding edges.
 * Larger finite values stay bounded; scientific GB/s is used only when the
 * one-decimal GB/s field would otherwise grow without limit.
 */
export function formatKevinHudRate(bytesPerSecond: number | null | undefined): string | null {
  if (!finite(bytesPerSecond) || bytesPerSecond < 0) return null
  if (bytesPerSecond < KIB) return `${Math.round(bytesPerSecond)} B/s`
  if (bytesPerSecond < MIB) return `${(bytesPerSecond / KIB).toFixed(1)} KB/s`
  if (bytesPerSecond < GIB) return `${(bytesPerSecond / MIB).toFixed(1)} MB/s`
  const gigabytes = bytesPerSecond / GIB
  if (gigabytes < GB_SCIENTIFIC_THRESHOLD) return `${gigabytes.toFixed(1)} GB/s`
  return `${gigabytes.toExponential(1)} GB/s`
}

/** Explicit text-suffixed alias for integrations that prefer that naming. */
export const formatKevinHudDurationText = formatKevinHudDuration

/** Explicit text-suffixed alias for integrations that prefer that naming. */
export const formatKevinHudRateText = formatKevinHudRate

/**
 * One widest emitted shape per duration branch. The list is deliberately kept
 * as candidate texts rather than a single number: sizing can measure each
 * candidate and select its own widest result for the selected font.
 *
 * - `999999:59:59`: maximum H:MM:SS field;
 * - `999999d`: maximum whole-day field before scientific notation;
 * - `2.1e+303d`: widest finite scientific day form.
 */
export const KEVIN_HUD_DURATION_TEXT_CANDIDATES: readonly string[] = Object.freeze([
  '999999:59:59',
  '999999d',
  '2.1e+303d'
])

/** Conservative single template that covers all duration candidates. */
export const KEVIN_HUD_DURATION_WIDEST_TEXT = '999999:59:59'

/**
 * Widest emitted shape per rate branch, including carries produced by
 * one-decimal rounding at each unit boundary. Units are intentionally mixed:
 * `MB/s` occupies more horizontal space than `GB/s` in many proportional
 * fonts, so the sizing layer must measure the candidates rather than only the
 * longest numeric field.
 *
 * - `1024 B/s` / `1024.0 KB/s` / `1024.0 MB/s`: rounding carries just below a
 *   unit boundary;
 * - `1000000.0 GB/s`: carry just below the scientific GB/s threshold;
 * - `1.0e+6 GB/s` / `1.7e+299 GB/s`: scientific threshold and finite maximum.
 */
export const KEVIN_HUD_RATE_TEXT_CANDIDATES: readonly string[] = Object.freeze([
  '1024 B/s',
  '1024.0 KB/s',
  '1024.0 MB/s',
  '1000000.0 GB/s',
  '1.0e+6 GB/s',
  '1.7e+299 GB/s'
])

/** Conservative single template that covers all network-rate candidates. */
export const KEVIN_HUD_RATE_WIDEST_TEXT = '1000000.0 GB/s'

/** Sizing-friendly alias for the duration candidate. */
export const KEVIN_HUD_DURATION_TEMPLATE = KEVIN_HUD_DURATION_WIDEST_TEXT

/** Sizing-friendly alias for the network-rate candidate. */
export const KEVIN_HUD_RATE_TEMPLATE = KEVIN_HUD_RATE_WIDEST_TEXT
