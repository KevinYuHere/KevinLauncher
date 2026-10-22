import { describe, expect, it } from 'vitest'
import {
  SPECIAL_AREAS,
  SPECIAL_AREA_GROUPS,
  applyAppThemePolicy,
  applyThemePolicy,
  normalizeThemePolicy,
  policyTargetsVersion,
  resolveAreaTheme,
  themedAreaCount,
  withAllThemes,
  withAreaTheme
} from '../src/shared/specialTheme'
import { DEFAULT_GLASS_APPEARANCE, MATERIAL_DEFAULTS } from '../src/shared/types'

describe('specialTheme', () => {
  it('falls back to default for missing or unknown values', () => {
    expect(resolveAreaTheme(undefined, 'sidebar')).toBe('default')
    expect(resolveAreaTheme({ sidebar: 'nope' }, 'sidebar')).toBe('default')
  })

  it('resolves a known theme', () => {
    expect(resolveAreaTheme({ sidebar: 'starsnow' }, 'sidebar')).toBe('starsnow')
  })

  it('keeps a stable, grouped area registry', () => {
    expect(SPECIAL_AREAS.length).toBe(28)
    const ids = new Set(SPECIAL_AREAS.map((area) => area.id))
    expect(ids.size).toBe(SPECIAL_AREAS.length)
    for (const group of SPECIAL_AREA_GROUPS) {
      expect(SPECIAL_AREAS.some((area) => area.group === group)).toBe(true)
    }
  })

  it('sets one area and clears it with default', () => {
    const one = withAreaTheme(undefined, 'dialogs', 'starsnow')
    expect(one).toEqual({ dialogs: 'starsnow' })
    expect(withAreaTheme(one, 'dialogs', 'default')).toEqual({})
  })

  it('bulk-applies to every area and resets', () => {
    const all = withAllThemes(undefined, 'starsnow')
    for (const area of SPECIAL_AREAS) expect(all[area.id]).toBe('starsnow')
    expect(withAllThemes(all, 'default')).toEqual({})
    expect(themedAreaCount(all)).toBe(SPECIAL_AREAS.length)
  })

  it('never overrides an area locked by the release policy', () => {
    const locks = { dialogs: 'starsnow' as const }
    const next = withAllThemes({}, 'default', locks)
    expect(next.dialogs).toBe('starsnow')
    expect(next.sidebar).toBeUndefined()
    const bulk = withAllThemes({}, 'starsnow', locks)
    expect(bulk.dialogs).toBe('starsnow')
  })

  it('applies a force policy once without locking the user in', () => {
    const policy = {
      version: '2.0.0',
      themeId: 'starsnow' as const,
      areas: ['dialogs', 'titlebar'] as const,
      locked: true
    }
    const result = applyThemePolicy({ sidebar: 'starsnow' }, {}, {
      ...policy,
      areas: [...policy.areas]
    })
    expect(result.assignments).toMatchObject({
      sidebar: 'starsnow',
      dialogs: 'starsnow',
      titlebar: 'starsnow'
    })
    // `locked` is ignored: a policy sets values once, never blocks later edits.
    expect(result.locks).toEqual({})
  })

  it('default mode does not replace a user’s existing choice', () => {
    const result = applyThemePolicy({ dialogs: 'default' }, {}, {
      version: '2.0.0',
      themeId: 'starsnow',
      areas: ['dialogs', 'titlebar'],
      locked: false,
      mode: 'default'
    })
    expect(result.assignments.dialogs).toBe('starsnow')
    expect(result.assignments.titlebar).toBe('starsnow')
    const kept = applyThemePolicy({ dialogs: 'starsnow' }, {}, {
      version: '2.0.0',
      themeId: 'default',
      areas: 'all',
      locked: false,
      mode: 'default'
    })
    expect(kept.assignments.dialogs).toBe('starsnow')
  })

  it('rejects malformed policies instead of changing the UI', () => {
    expect(normalizeThemePolicy(null)).toBeNull()
    expect(normalizeThemePolicy({})).toBeNull()
    expect(normalizeThemePolicy({ version: '1', themeId: 'nope', areas: 'all', locked: false })).toBeNull()
    expect(normalizeThemePolicy({ version: '1', themeId: 'starsnow', areas: [], locked: false })).toBeNull()
    expect(
      normalizeThemePolicy({ version: '1', themeId: 'starsnow', areas: ['dialogs', 'nope'], locked: true })
    ).toMatchObject({ version: '1', areas: ['dialogs'], locked: true })
  })

  it('carries the optional material / launch effect / critical marker', () => {
    const policy = normalizeThemePolicy({
      version: '2.0.0-beta.1',
      themeId: 'starsnow',
      areas: 'all',
      locked: false,
      material: 'starfrost',
      launchEffect: 'shatter',
      critical: true
    })
    expect(policy).toMatchObject({
      version: '2.0.0-beta.1',
      themeId: 'starsnow',
      areas: 'all',
      material: 'starfrost',
      launchEffect: 'shatter',
      critical: true
    })
    // Unknown values in optional fields are dropped, not fatal.
    const partial = normalizeThemePolicy({
      version: '2',
      themeId: 'starsnow',
      areas: 'all',
      material: 'hologram',
      launchEffect: 'explode'
    })
    expect(partial).toMatchObject({ version: '2' })
    expect(partial?.material).toBeUndefined()
    expect(partial?.launchEffect).toBeUndefined()
    expect(partial?.critical).toBeUndefined()
  })

  it('replaces the material and launch effect of every app once', () => {
    const policy = normalizeThemePolicy({
      version: '2.0.0-beta.1',
      themeId: 'starsnow',
      areas: 'all',
      material: 'starfrost',
      launchEffect: 'shatter'
    })!
    const themed = applyAppThemePolicy(
      { glass: { ...DEFAULT_GLASS_APPEARANCE, material: 'mica' as const }, launchEffect: 'none' as const },
      policy
    )
    expect(themed.changed).toBe(true)
    // The forced material brings its recommended parameters, like the settings do.
    expect(themed.app.glass).toEqual(MATERIAL_DEFAULTS.starfrost)
    expect(themed.app.launchEffect).toBe('shatter')
    // Running it again changes nothing (idempotent, no pointless writes).
    expect(applyAppThemePolicy(themed.app, policy).changed).toBe(false)
    // A policy without those fields leaves the app alone.
    const themeOnly = normalizeThemePolicy({
      version: '2',
      themeId: 'starsnow',
      areas: 'all'
    })!
    expect(applyAppThemePolicy(themed.app, themeOnly).changed).toBe(false)
  })

  it('only applies on the version the policy was written for', () => {
    const policy = normalizeThemePolicy({
      version: '2.0.0',
      themeId: 'starsnow',
      areas: 'all',
      material: 'starfrost'
    })!
    expect(policyTargetsVersion(policy, '2.0.0')).toBe(true)
    // 2.1.0 must not re-apply 2.0.0's changes (and a stale copy is harmless).
    expect(policyTargetsVersion(policy, '2.1.0')).toBe(false)
    expect(policyTargetsVersion(policy, '2.0.0-beta.1')).toBe(false)
  })
})
