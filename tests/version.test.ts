import { describe, expect, it } from 'vitest'
import { compareVersions, isNewerVersion } from '../src/shared/version'

describe('compareVersions', () => {
  it('treats equal versions (with or without a leading v) as equal', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.3.0', '1.2.3')).toBe(0)
  })

  it('compares each numeric segment', () => {
    expect(compareVersions('1.2.4', '1.2.3')).toBeGreaterThan(0)
    expect(compareVersions('1.3.0', '1.2.9')).toBeGreaterThan(0)
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3', '1.3.0')).toBeLessThan(0)
    expect(compareVersions('1.9.9', '2.0.0')).toBeLessThan(0)
  })

  it('ignores pre-release / build suffixes', () => {
    expect(compareVersions('1.4.0-beta.2', '1.4.0')).toBe(0)
    expect(compareVersions('1.4.0+build7', '1.4.0')).toBe(0)
  })

  it('handles missing segments', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.2', '1.2.1')).toBeLessThan(0)
  })
})

describe('isNewerVersion', () => {
  it('is true only for strictly newer versions', () => {
    expect(isNewerVersion('0.0.2', '0.0.1')).toBe(true)
    expect(isNewerVersion('v0.1.0', '0.0.9')).toBe(true)
    expect(isNewerVersion('0.0.1', '0.0.1')).toBe(false)
    expect(isNewerVersion('0.0.1', '0.0.2')).toBe(false)
  })
})
