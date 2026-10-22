import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  isNewerVersion,
  keepStagedVersion,
  pickNewestVersion
} from '../src/shared/version'

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

  it('orders pre-releases below the release and ignores build metadata', () => {
    expect(compareVersions('1.4.0-beta.2', '1.4.0')).toBeLessThan(0)
    expect(compareVersions('1.4.0+build7', '1.4.0')).toBe(0)
    expect(compareVersions('1.4.0-beta.2', '1.4.0-beta.10')).toBeLessThan(0)
    expect(compareVersions('1.4.0-alpha', '1.4.0-beta')).toBeLessThan(0)
    expect(compareVersions('1.4.0-beta', '1.3.9')).toBeGreaterThan(0)
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
    // A release is newer than its pre-release; a newer core beats both.
    expect(isNewerVersion('1.4.0', '1.4.0-beta.2')).toBe(true)
    expect(isNewerVersion('1.4.0-beta.2', '1.4.0')).toBe(false)
    expect(isNewerVersion('1.4.0-beta.2', '1.4.0-beta.10')).toBe(false)
  })

  it('never throws on a word version (it degrades to 0.0.0)', () => {
    // Releases are gated to SemVer by the release scripts, so this is only a
    // guard against a hand-edited manifest: it must not crash the check.
    expect(compareVersions('foo', '2.0.0')).toBeLessThan(0)
    expect(compareVersions('rc', '0.0.0')).toBe(0)
  })
})

describe('keepStagedVersion', () => {
  it('keeps the running version and newer (pending) downloads', () => {
    expect(keepStagedVersion('2.0.0-beta.1', '2.0.0-beta.1')).toBe(true)
    expect(keepStagedVersion('2.0.0', '2.0.0-beta.1')).toBe(true)
    expect(keepStagedVersion('2.1.0', '2.0.0')).toBe(true)
  })

  it('drops stale and unrelated folders', () => {
    expect(keepStagedVersion('1.3.0', '2.0.0-beta.1')).toBe(false)
    expect(keepStagedVersion('2.0.0-beta.1', '2.0.0')).toBe(false)
    expect(keepStagedVersion('temp', '2.0.0')).toBe(false)
  })
})

describe('pickNewestVersion', () => {
  const releases = [
    { version: '1.9.0' },
    { version: '2.0.0-beta.1', prerelease: true },
    { version: '2.0.0' },
    { version: '2.1.0-beta.1', prerelease: true }
  ]

  it('stable only takes the highest real release', () => {
    expect(pickNewestVersion(releases, true)?.version).toBe('2.0.0')
  })

  it('beta takes the highest version, stable or pre-release', () => {
    expect(pickNewestVersion(releases, false)?.version).toBe('2.1.0-beta.1')
    // A stable release outranks its own pre-release for the beta channel too.
    expect(
      pickNewestVersion(
        [
          { version: '2.0.0-beta.2', prerelease: true },
          { version: '2.0.0' }
        ],
        false
      )?.version
    ).toBe('2.0.0')
  })

  it('never offers drafts and copes with empty lists', () => {
    expect(
      pickNewestVersion([{ version: '3.0.0', draft: true }, { version: '2.0.0' }], false)?.version
    ).toBe('2.0.0')
    expect(pickNewestVersion([], true)).toBeNull()
    expect(pickNewestVersion([{ version: '2.0.0-beta.1', prerelease: true }], true)).toBeNull()
  })
})
