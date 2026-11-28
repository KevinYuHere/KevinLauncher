import { describe, expect, it } from 'vitest'
import {
  KEVIN_HUD_DURATION_TEMPLATE,
  KEVIN_HUD_DURATION_TEXT_CANDIDATES,
  KEVIN_HUD_DURATION_WIDEST_TEXT,
  KEVIN_HUD_RATE_TEMPLATE,
  KEVIN_HUD_RATE_TEXT_CANDIDATES,
  KEVIN_HUD_RATE_WIDEST_TEXT,
  formatKevinHudDuration,
  formatKevinHudDurationText,
  formatKevinHudRate,
  formatKevinHudRateText
} from '../src/shared/kevinHudMetricText'

const KIB = 1024
const MIB = 1024 ** 2
const GIB = 1024 ** 3

describe('KEVIN HUD duration text', () => {
  it('keeps ordinary durations in H:MM:SS across every hour digit width', () => {
    for (const invalid of [
      null,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1
    ]) {
      expect(formatKevinHudDuration(invalid)).toBeNull()
    }

    expect(formatKevinHudDuration(0)).toBe('0:00:00')
    expect(formatKevinHudDuration(3661)).toBe('1:01:01')
    expect(formatKevinHudDuration(90_061)).toBe('25:01:01')

    for (const hours of [
      9,
      10,
      99,
      100,
      999,
      1_000,
      9_999,
      10_000,
      99_999,
      100_000,
      999_999
    ]) {
      const text = formatKevinHudDuration(hours * 3600 + 61)
      expect(text).toBe(`${hours}:01:01`)
      expect(text!.length).toBeLessThanOrEqual(KEVIN_HUD_DURATION_WIDEST_TEXT.length)
    }

    expect(formatKevinHudDuration(999_999 * 3600 + 3_599)).toBe('999999:59:59')
  })

  it('switches extremely long finite durations to bounded compact units', () => {
    expect(formatKevinHudDuration(1_000_000 * 3600)).toBe('41666d')
    expect(formatKevinHudDuration(1_000_000 * 86_400)).toBe('1.0e+6d')
    expect(formatKevinHudDuration(Number.MAX_SAFE_INTEGER)).toBe('1.0e+11d')
    expect(formatKevinHudDuration(Number.MAX_VALUE)).toBe('2.1e+303d')

    for (const seconds of [1_000_000 * 86_400, 1e12, 1e100, Number.MAX_VALUE]) {
      const text = formatKevinHudDuration(seconds)
      expect(text).not.toBeNull()
      expect(text).toMatch(/^\d+\.\de\+\d{1,3}d$/)
      expect(text!.length).toBeLessThanOrEqual(KEVIN_HUD_DURATION_WIDEST_TEXT.length)
    }
  })

  it('exports duration width candidates that cover each display form', () => {
    expect(KEVIN_HUD_DURATION_WIDEST_TEXT).toBe('999999:59:59')
    expect(KEVIN_HUD_DURATION_TEMPLATE).toBe(KEVIN_HUD_DURATION_WIDEST_TEXT)
    expect(formatKevinHudDurationText).toBe(formatKevinHudDuration)
    expect(KEVIN_HUD_DURATION_TEXT_CANDIDATES).toContain(KEVIN_HUD_DURATION_WIDEST_TEXT)

    const cases: Array<[number, string]> = [
      [999_999 * 3600 + 3_599, '999999:59:59'],
      [999_999 * 86_400, '999999d'],
      [Number.MAX_VALUE, '2.1e+303d']
    ]
    for (const [seconds, expected] of cases) {
      expect(formatKevinHudDuration(seconds)).toBe(expected)
      expect(KEVIN_HUD_DURATION_TEXT_CANDIDATES).toContain(expected)
      expect(expected.length).toBeLessThanOrEqual(KEVIN_HUD_DURATION_WIDEST_TEXT.length)
    }
    expect(new Set(KEVIN_HUD_DURATION_TEXT_CANDIDATES).size)
      .toBe(KEVIN_HUD_DURATION_TEXT_CANDIDATES.length)
  })
})

describe('KEVIN HUD network rate text', () => {
  it('keeps historical KB/s and MB/s forms and crosses to GB/s at 1 GiB/s', () => {
    for (const invalid of [
      null,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1
    ]) {
      expect(formatKevinHudRate(invalid)).toBeNull()
    }

    expect(formatKevinHudRate(0)).toBe('0 B/s')
    expect(formatKevinHudRate(1023)).toBe('1023 B/s')
    expect(formatKevinHudRate(1023.6)).toBe('1024 B/s')
    expect(formatKevinHudRate(1024)).toBe('1.0 KB/s')
    expect(formatKevinHudRate(1536)).toBe('1.5 KB/s')
    expect(formatKevinHudRate(512 * KIB)).toBe('512.0 KB/s')
    expect(formatKevinHudRate(MIB - 1)).toBe('1024.0 KB/s')
    expect(formatKevinHudRate(1.5 * MIB)).toBe('1.5 MB/s')
    expect(formatKevinHudRate(GIB - 1)).toBe('1024.0 MB/s')
    expect(formatKevinHudRate(GIB)).toBe('1.0 GB/s')
    expect(formatKevinHudRate(1.5 * GIB)).toBe('1.5 GB/s')
    expect(formatKevinHudRate(1024 * GIB)).toBe('1024.0 GB/s')
  })

  it('keeps extreme finite rates bounded without truncating rounding carries', () => {
    expect(formatKevinHudRate(999_999 * GIB)).toBe('999999.0 GB/s')
    expect(formatKevinHudRate(999_999.96 * GIB)).toBe('1000000.0 GB/s')
    expect(formatKevinHudRate(1_000_000 * GIB)).toBe('1.0e+6 GB/s')
    expect(formatKevinHudRate(1e12 * GIB)).toBe('1.0e+12 GB/s')
    expect(formatKevinHudRate(Number.MAX_SAFE_INTEGER)).toBe('8.4e+6 GB/s')
    expect(formatKevinHudRate(Number.MAX_VALUE)).toBe('1.7e+299 GB/s')

    for (const bytesPerSecond of [
      999_999.96 * GIB,
      1_000_000 * GIB,
      1e12 * GIB,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_VALUE
    ]) {
      const text = formatKevinHudRate(bytesPerSecond)
      expect(text).not.toBeNull()
      expect(text).not.toContain('Infinity')
      expect(text).not.toContain('NaN')
      expect(text!.length).toBeLessThanOrEqual(KEVIN_HUD_RATE_WIDEST_TEXT.length)
      expect(text).toMatch(/(?:B|KB|MB|GB)\/s$/)
    }

    // The carry is emitted in full; the widest template reserves its whole
    // width instead of clipping it back to the common `999.9 MB/s` shape.
    expect(formatKevinHudRate(999_999.96 * GIB)!.length)
      .toBe(KEVIN_HUD_RATE_WIDEST_TEXT.length)
  })

  it('exports width candidates with differently sized units for every branch', () => {
    expect(KEVIN_HUD_RATE_WIDEST_TEXT).toBe('1000000.0 GB/s')
    expect(KEVIN_HUD_RATE_TEMPLATE).toBe(KEVIN_HUD_RATE_WIDEST_TEXT)
    expect(formatKevinHudRateText).toBe(formatKevinHudRate)
    expect(KEVIN_HUD_RATE_TEXT_CANDIDATES).toContain(KEVIN_HUD_RATE_WIDEST_TEXT)

    const cases: Array<[number, string]> = [
      [1023.6, '1024 B/s'],
      [MIB - 1, '1024.0 KB/s'],
      [GIB - 1, '1024.0 MB/s'],
      [999_999.96 * GIB, '1000000.0 GB/s'],
      [1_000_000 * GIB, '1.0e+6 GB/s'],
      [Number.MAX_VALUE, '1.7e+299 GB/s']
    ]
    for (const [bytesPerSecond, expected] of cases) {
      expect(formatKevinHudRate(bytesPerSecond)).toBe(expected)
      expect(KEVIN_HUD_RATE_TEXT_CANDIDATES).toContain(expected)
      expect(expected.length).toBeLessThanOrEqual(KEVIN_HUD_RATE_WIDEST_TEXT.length)
    }

    for (const unit of ['B/s', 'KB/s', 'MB/s', 'GB/s']) {
      expect(KEVIN_HUD_RATE_TEXT_CANDIDATES.some((text) => text.endsWith(` ${unit}`))).toBe(true)
    }
    expect(new Set(KEVIN_HUD_RATE_TEXT_CANDIDATES).size)
      .toBe(KEVIN_HUD_RATE_TEXT_CANDIDATES.length)
  })

  it('keeps representative finite magnitudes within both reserved widths', () => {
    for (let exponent = 0; exponent <= 300; exponent += 7) {
      const value = 1.37 * 10 ** exponent
      if (!Number.isFinite(value)) continue

      const duration = formatKevinHudDuration(value)
      const rate = formatKevinHudRate(value)
      expect(duration).not.toBeNull()
      expect(rate).not.toBeNull()
      expect(duration!.length).toBeLessThanOrEqual(KEVIN_HUD_DURATION_WIDEST_TEXT.length)
      expect(rate!.length).toBeLessThanOrEqual(KEVIN_HUD_RATE_WIDEST_TEXT.length)
    }
  })
})
