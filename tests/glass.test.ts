import { describe, expect, it } from 'vitest'
import { DEFAULT_GLASS_APPEARANCE, MATERIAL_DEFAULTS } from '../src/shared/types'
import { GLASS_MATERIALS, mergeGlass } from '../src/main/services/glass'

describe('mergeGlass', () => {
  it('accepts every material offered by the settings (including starfrost)', () => {
    expect(GLASS_MATERIALS).toEqual(Object.keys(MATERIAL_DEFAULTS))
    for (const material of GLASS_MATERIALS) {
      expect(mergeGlass(undefined, { material }).material).toBe(material)
    }
    expect(mergeGlass(undefined, { material: 'starfrost' }).material).toBe('starfrost')
  })

  it('keeps the current material for an unknown value instead of silently resetting', () => {
    const current = { ...DEFAULT_GLASS_APPEARANCE, material: 'mica' as const }
    expect(mergeGlass(current, { material: 'nope' as never }).material).toBe('mica')
  })

  it('clamps numeric fields and keeps untouched ones', () => {
    const next = mergeGlass({ ...DEFAULT_GLASS_APPEARANCE, blur: 20 }, {
      brightness: 999,
      opacity: -5,
      blur: 300,
      edgeWidth: 1
    })
    expect(next.brightness).toBe(100)
    expect(next.opacity).toBe(0)
    expect(next.blur).toBe(60)
    expect(next.edgeWidth).toBe(4)
    expect(next.material).toBe(DEFAULT_GLASS_APPEARANCE.material)
  })
})
