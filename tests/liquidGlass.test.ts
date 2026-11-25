import { describe, expect, it } from 'vitest'
import {
  buildBezelProfile,
  buildDisplacementBytes,
  buildSpecularBytes,
  DEFAULT_BEZEL_HEIGHT_FN
} from '../src/renderer/src/liquidGlass'

describe('buildBezelProfile', () => {
  it('returns a finite profile with a non-zero peak', () => {
    const profile = buildBezelProfile(40, 16, DEFAULT_BEZEL_HEIGHT_FN, 1.5)
    expect(profile.length).toBe(128)
    for (const v of profile) expect(Number.isFinite(v)).toBe(true)
    expect(Math.max(...profile.map(Math.abs))).toBeGreaterThan(0)
  })
})

describe('buildDisplacementBytes', () => {
  const profile = buildBezelProfile(40, 16, DEFAULT_BEZEL_HEIGHT_FN, 1.5)
  const max = Math.max(...profile.map(Math.abs))
  const size = 128

  it('produces a fully opaque RGBA buffer of the requested size', () => {
    const bytes = buildDisplacementBytes(size, size, 64, 16, max, profile, 1)
    expect(bytes.length).toBe(size * size * 4)
    for (let i = 3; i < bytes.length; i += 4) expect(bytes[i]).toBe(255)
  })

  it('is neutral (128,128) in the interior', () => {
    const bytes = buildDisplacementBytes(size, size, 64, 16, max, profile, 1)
    const i = (64 * size + 64) * 4
    expect(bytes[i]).toBe(128)
    expect(bytes[i + 1]).toBe(128)
  })

  it('displaces pixels inside the edge bezel band', () => {
    const bytes = buildDisplacementBytes(size, size, 64, 16, max, profile, 1)
    const i = (64 * size + 1) * 4 // middle of the left edge
    expect(bytes[i] !== 128 || bytes[i + 1] !== 128).toBe(true)
  })

  it('does not vanish when the bezel is wider than the corner radius', () => {
    // radius 16 with a 40px band used to make the inner ring larger than the
    // outer one → every pixel skipped → empty map.
    const bytes = buildDisplacementBytes(size, size, 16, 40, max, profile, 1)
    let displaced = 0
    for (let i = 0; i < bytes.length; i += 4) {
      if (bytes[i] !== 128 || bytes[i + 1] !== 128) displaced++
    }
    expect(displaced).toBeGreaterThan(0)
  })
})

describe('buildSpecularBytes', () => {
  it('lights the rim and leaves the interior dark', () => {
    const size = 128
    const bytes = buildSpecularBytes(size, size, 64, 50, Math.PI / 3, 1)
    expect(bytes.length).toBe(size * size * 4)
    const rim = (64 * size + 1) * 4 // just inside the left edge
    const center = (64 * size + 64) * 4
    expect(bytes[rim + 3]).toBeGreaterThan(0)
    expect(bytes[center + 3]).toBe(0)
  })
})
