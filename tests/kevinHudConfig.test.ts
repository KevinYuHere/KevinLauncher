import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_KEVIN_HUD,
  DEFAULT_KEVIN_HUD_ITEM_STYLE,
  KEVIN_HUD_ITEM_STYLE_LIMITS,
  KEVIN_HUD_LIMITS,
  isKevinHudConfig,
  normalizeKevinHudConfig,
  type KevinHudConfig
} from '../src/shared/kevinHud'
import {
  DEFAULT_KEVIN_HUD_GRADIENT,
  type KevinHudGradient
} from '../src/shared/kevinHudBackground'
import {
  normalizeLauncherConfig,
  validateLauncherConfig
} from '../src/main/services/configValidation'
import { CURRENT_VERSION } from '../src/main/services/appMigrations'
import { AppStore } from '../src/main/services/appStore'

const electron = vi.hoisted(() => ({ data: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => electron.data }
}))

const CUSTOM_GRADIENT: KevinHudGradient = {
  kind: 'conic',
  angle: 135,
  centerX: 25,
  centerY: 75,
  shape: 'circle',
  stops: [
    { color: '#112233', position: 0 },
    { color: '#445566', position: 50 },
    { color: '#778899', position: 100 }
  ]
}

const CUSTOM_HUD: KevinHudConfig = {
  enabled: false,
  alwaysVisible: true,
  absorbLauncher: false,
  displaySeconds: 4.5,
  sampleSeconds: 0.5,
  direction: 'bottom',
  bounce: 0.5,
  ripple: 0.4,
  positionMode: 'custom',
  anchor: 'left',
  x: 18,
  y: 72,
  width: 600,
  maxWidth: 900,
  height: 72,
  radius: 12,
  borderWidth: 2,
  borderColor: '#ABCDEF',
  backgroundMode: 'gradient',
  gradient: CUSTOM_GRADIENT,
  material: 'astral',
  backgroundColor: '#123456',
  foregroundOpacity: 0.7,
  backgroundOpacity: 0.4,
  textColor: 'auto',
  iconColor: '#abcdef',
  textOffsetX: 3,
  textOffsetY: -2,
  iconOffsetX: 1,
  iconOffsetY: -1,
  fontScale: 1.1,
  itemGap: 7,
  contentPadding: 11,
  itemStyle: {
    orientation: 'vertical',
    description: 'icon',
    gap: 4,
    minWidth: 120,
    descriptionAlign: 'center',
    valueAlign: 'left',
    descriptionSize: 9,
    valueSize: 13,
    descriptionBold: false,
    valueBold: true,
    descriptionColor: '#AAAAAA',
    valueColor: '#BBBBBB'
  },
  itemStyles: {
    fps: {
      gap: 4,
      minWidth: 140,
      descriptionAlign: 'right',
      valueAlign: 'center',
      valueColor: '#00FF00'
    }
  },
  monitor: 'game',
  autoWidth: true,
  restoreLauncher: false,
  hotkey: 'CommandOrControl+Shift+K',
  metrics: ['clock', 'fps']
}

/**
 * The complete previous-build default. Tests use it to prove that only an
 * untouched old preset is upgraded, while any customization keeps its fields.
 */
const LEGACY_DEFAULT_HUD = {
  enabled: true,
  alwaysVisible: false,
  displaySeconds: 6,
  sampleSeconds: 1,
  direction: 'center',
  bounce: 0.275,
  ripple: 1,
  positionMode: 'preset',
  anchor: 'center',
  x: 50,
  y: 3,
  width: 448,
  maxWidth: 1600,
  height: 48,
  radius: 24,
  borderWidth: 0,
  borderColor: '#656363',
  backgroundMode: 'solid',
  material: 'blur',
  backgroundColor: '#312F30',
  backgroundOpacity: 1,
  textColor: '#FFFFFF',
  iconColor: null,
  textOffsetX: 0,
  textOffsetY: 0,
  iconOffsetX: 0,
  iconOffsetY: 0,
  fontScale: 1,
  itemGap: 8,
  contentPadding: 12,
  itemStyle: {
    orientation: 'horizontal',
    description: 'text',
    gap: 5,
    descriptionSize: 8.5,
    valueSize: 12,
    descriptionBold: true,
    valueBold: true
  },
  itemStyles: {},
  monitor: 'primary',
  autoWidth: true,
  restoreLauncher: false,
  hotkey: null,
  metrics: ['memory']
} as const

describe('KEVIN HUD shared defaults', () => {
  it('matches the fixed 448 x 48 top-centre reference capsule defaults', () => {
    expect(DEFAULT_KEVIN_HUD).toEqual({
      enabled: true,
      alwaysVisible: true,
      absorbLauncher: true,
      displaySeconds: 6,
      sampleSeconds: 1,
      direction: 'center',
      bounce: 0.275,
      ripple: 1,
      positionMode: 'preset',
      anchor: 'center',
      x: 50,
      y: 3,
      width: 448,
      maxWidth: 448,
      height: 48,
      radius: 24,
      borderWidth: 2,
      borderColor: '#A7AD48',
      backgroundMode: 'gradient',
      gradient: {
        kind: 'linear',
        angle: 90,
        centerX: 50,
        centerY: 50,
        shape: 'ellipse',
        stops: [
          { color: '#1F1D1E', position: 0 },
          { color: '#302E2F', position: 100 }
        ]
      },
      material: 'blur',
      backgroundColor: '#312F30',
      foregroundOpacity: 1,
      backgroundOpacity: 1,
      textColor: '#FFFFFF',
      iconColor: null,
      textOffsetX: 0,
      textOffsetY: 0,
      iconOffsetX: 0,
      iconOffsetY: 0,
      fontScale: 1,
      itemGap: 8,
      contentPadding: 12,
      itemStyle: {
        orientation: 'horizontal',
        description: 'text',
        gap: 5,
        minWidth: 0,
        descriptionAlign: 'left',
        valueAlign: 'right',
        descriptionSize: 12,
        valueSize: 14,
        descriptionBold: true,
        valueBold: true,
        descriptionColor: null,
        valueColor: null
      },
      itemStyles: {},
      monitor: 'primary',
      autoWidth: false,
      restoreLauncher: false,
      hotkey: null,
      metrics: ['fps', 'gpu', 'cpu']
    })
    expect(isKevinHudConfig(DEFAULT_KEVIN_HUD)).toBe(true)
    // The module-level preset owns independent static data; it shares no
    // mutable nested object with the standalone gradient/item-style constants.
    expect(DEFAULT_KEVIN_HUD.gradient).not.toBe(DEFAULT_KEVIN_HUD_GRADIENT)
    expect(DEFAULT_KEVIN_HUD.gradient.stops).not.toBe(DEFAULT_KEVIN_HUD_GRADIENT.stops)
    expect(DEFAULT_KEVIN_HUD.itemStyle).not.toBe(DEFAULT_KEVIN_HUD_ITEM_STYLE)
  })

  it('keeps valid customization and native accelerator syntax intact', () => {
    const normalized = normalizeKevinHudConfig(CUSTOM_HUD)
    expect(normalized).toEqual(CUSTOM_HUD)
    expect(normalized.gradient).not.toBe(CUSTOM_HUD.gradient)
    expect(normalized.gradient.stops).not.toBe(CUSTOM_HUD.gradient.stops)
    expect(normalized.gradient.stops[0]).not.toBe(CUSTOM_HUD.gradient.stops[0])
    expect(isKevinHudConfig(normalized)).toBe(true)
  })

  it('returns independent objects, item styles, metrics and gradient stops even for absent input', () => {
    const first = normalizeKevinHudConfig(undefined)
    const second = normalizeKevinHudConfig(null)
    expect(first).toEqual(DEFAULT_KEVIN_HUD)
    expect(second).toEqual(DEFAULT_KEVIN_HUD)
    expect(first).not.toBe(second)
    expect(first.metrics).not.toBe(second.metrics)
    expect(first.gradient).not.toBe(second.gradient)
    expect(first.gradient.stops).not.toBe(second.gradient.stops)
    expect(first.gradient.stops[0]).not.toBe(second.gradient.stops[0])
    expect(first.gradient.stops).not.toBe(DEFAULT_KEVIN_HUD.gradient.stops)
    expect(first.itemStyle).not.toBe(second.itemStyle)
    expect(first.itemStyle).not.toBe(DEFAULT_KEVIN_HUD.itemStyle)
    expect(first.itemStyles).not.toBe(second.itemStyles)
    expect(first.itemStyles).not.toBe(DEFAULT_KEVIN_HUD.itemStyles)
    first.metrics.push('memory')
    first.gradient.stops[0].color = '#000000'
    first.itemStyle.gap = 24
    first.itemStyles.fps = { gap: 1 }
    expect(second.metrics).toEqual(['fps', 'gpu', 'cpu'])
    expect(second.gradient.stops[0].color).toBe(DEFAULT_KEVIN_HUD_GRADIENT.stops[0].color)
    expect(second.itemStyle.gap).toBe(DEFAULT_KEVIN_HUD_ITEM_STYLE.gap)
    expect(second.itemStyles).toEqual({})
    expect(DEFAULT_KEVIN_HUD.gradient.stops[0].color)
      .toBe(DEFAULT_KEVIN_HUD_GRADIENT.stops[0].color)
  })

  it('migrates legacy positions without discarding explicit choices', () => {
    // The old untouched default is the only shape promoted to the new preset.
    expect(normalizeKevinHudConfig({ x: 50, y: 3, anchor: 'center' })).toMatchObject({
      positionMode: 'preset',
      x: 50,
      y: 3,
      anchor: 'center'
    })
    expect(normalizeKevinHudConfig({
      x: 18,
      y: 72,
      anchor: 'left',
      width: 620,
      backgroundMode: 'custom',
      backgroundColor: '#123456',
      borderColor: '#ABCDEF',
      metrics: ['clock', 'fps']
    })).toMatchObject({
      positionMode: 'custom',
      x: 18,
      y: 72,
      anchor: 'left',
      width: 620,
      backgroundMode: 'custom',
      backgroundColor: '#123456',
      borderColor: '#ABCDEF',
      metrics: ['clock', 'fps']
    })
    expect(normalizeKevinHudConfig({ positionMode: 'custom', x: 50, y: 3, anchor: 'center' })
      .positionMode).toBe('custom')
    expect(normalizeKevinHudConfig({ positionMode: 'preset', x: 20, y: 30, anchor: 'right' }))
      .toMatchObject({ positionMode: 'preset', x: 20, y: 30, anchor: 'right' })
    expect(normalizeKevinHudConfig({ anchor: 'left' }).positionMode).toBe('custom')
  })

  it('preserves explicit legacy auto-width, width and non-default appearance', () => {
    const legacy = normalizeKevinHudConfig({
      autoWidth: false,
      width: 760,
      backgroundMode: 'app',
      material: 'mica',
      textColor: '#FEDCBA',
      iconColor: '#112233',
      metrics: []
    })
    expect(legacy).toMatchObject({
      positionMode: 'preset',
      autoWidth: false,
      width: 760,
      maxWidth: 760,
      backgroundMode: 'app',
      material: 'mica',
      textColor: '#FEDCBA',
      iconColor: '#112233',
      metrics: []
    })
  })

  it('adds launcher absorption and a canonical foreground opacity safely', () => {
    expect(normalizeKevinHudConfig({})).toMatchObject({
      absorbLauncher: true,
      foregroundOpacity: 1,
      backgroundOpacity: 1,
      gradient: DEFAULT_KEVIN_HUD_GRADIENT
    })
    expect(normalizeKevinHudConfig({
      absorbLauncher: false,
      foregroundOpacity: 0.35,
      backgroundOpacity: 0.9
    })).toMatchObject({
      absorbLauncher: false,
      foregroundOpacity: 0.35,
      backgroundOpacity: 0.9
    })

    // The intermediate `opacity` value is only a read-time fallback. The
    // normalized result always exposes the canonical foreground field.
    const legacyOpacity = normalizeKevinHudConfig({ opacity: 0.4 })
    expect(legacyOpacity.foregroundOpacity).toBe(0.4)
    expect(Object.hasOwn(legacyOpacity, 'opacity')).toBe(false)
    expect(normalizeKevinHudConfig({ foregroundOpacity: 0.6, opacity: 0.2 }).foregroundOpacity)
      .toBe(0.6)
    expect(normalizeKevinHudConfig({ foregroundOpacity: '0.5', opacity: 0.4 }).foregroundOpacity)
      .toBe(0.4)

    expect(normalizeKevinHudConfig({
      absorbLauncher: 'false',
      foregroundOpacity: 2
    })).toMatchObject({ absorbLauncher: true, foregroundOpacity: 1 })
  })

  it('defaults to the sampled 2 px gauge border without replacing explicit old choices', () => {
    expect(DEFAULT_KEVIN_HUD).toMatchObject({
      borderWidth: 2,
      borderColor: '#A7AD48'
    })
    expect(normalizeKevinHudConfig({})).toMatchObject({
      borderWidth: 2,
      borderColor: '#A7AD48'
    })
    // A partial historical config with an explicit invisible border keeps it.
    expect(normalizeKevinHudConfig({ borderWidth: 0 })).toMatchObject({
      borderWidth: 0,
      borderColor: '#A7AD48'
    })
    expect(normalizeKevinHudConfig({
      borderWidth: 0,
      borderColor: '#123456'
    })).toMatchObject({
      borderWidth: 0,
      borderColor: '#123456'
    })
    expect(normalizeKevinHudConfig({
      width: 620,
      borderWidth: 2,
      borderColor: '#ABCDEF'
    })).toMatchObject({
      width: 620,
      borderWidth: 2,
      borderColor: '#ABCDEF'
    })
    // A complete old preset with a custom border is a customization, so the
    // automatic default migration must leave its invisible/custom border alone.
    expect(normalizeKevinHudConfig({
      ...LEGACY_DEFAULT_HUD,
      borderColor: '#123456'
    })).toMatchObject({
      borderWidth: 0,
      borderColor: '#123456',
      autoWidth: true
    })
  })

  it('upgrades only a provably complete, untouched previous beta default', () => {
    expect(normalizeKevinHudConfig(LEGACY_DEFAULT_HUD)).toEqual(DEFAULT_KEVIN_HUD)

    const customWidth = normalizeKevinHudConfig({ ...LEGACY_DEFAULT_HUD, width: 620 })
    expect(customWidth).toMatchObject({
      width: 620,
      maxWidth: 1600,
      autoWidth: true,
      itemStyle: {
        description: 'text',
        valueSize: 12
      }
    })

    const legacyForeground = normalizeKevinHudConfig({ ...LEGACY_DEFAULT_HUD, opacity: 0.5 })
    expect(legacyForeground).toMatchObject({
      foregroundOpacity: 0.5,
      autoWidth: true,
      maxWidth: 1600
    })
    expect(Object.hasOwn(legacyForeground, 'opacity')).toBe(false)

    const customBackground = normalizeKevinHudConfig({
      ...LEGACY_DEFAULT_HUD,
      backgroundMode: 'gradient',
      backgroundColor: '#123456',
      gradient: CUSTOM_GRADIENT,
      foregroundOpacity: 0.6
    })
    expect(customBackground).toMatchObject({
      autoWidth: true,
      maxWidth: 1600,
      backgroundMode: 'gradient',
      backgroundColor: '#123456',
      gradient: CUSTOM_GRADIENT,
      foregroundOpacity: 0.6
    })

    // A gradient alone is still an explicit background customization.
    const gradientOnly = normalizeKevinHudConfig({
      ...LEGACY_DEFAULT_HUD,
      gradient: CUSTOM_GRADIENT
    })
    expect(gradientOnly).toMatchObject({
      autoWidth: true,
      maxWidth: 1600,
      backgroundMode: 'solid',
      gradient: CUSTOM_GRADIENT
    })

    // Plain solid mode still owns its editable background colour.
    const customSolid = normalizeKevinHudConfig({
      ...LEGACY_DEFAULT_HUD,
      backgroundColor: '#123456'
    })
    expect(customSolid).toMatchObject({
      autoWidth: true,
      maxWidth: 1600,
      backgroundMode: 'solid',
      backgroundColor: '#123456'
    })

    const customItem = normalizeKevinHudConfig({
      ...LEGACY_DEFAULT_HUD,
      itemStyle: { ...LEGACY_DEFAULT_HUD.itemStyle, valueSize: 13 }
    })
    expect(customItem).toMatchObject({
      autoWidth: true,
      itemStyle: { description: 'text', valueSize: 13 }
    })

    const perMetric = normalizeKevinHudConfig({
      ...LEGACY_DEFAULT_HUD,
      itemStyles: { fps: { gap: 4 } }
    })
    expect(perMetric).toMatchObject({
      autoWidth: true,
      itemStyle: { description: 'text', valueSize: 12 },
      itemStyles: { fps: { gap: 4 } }
    })

    // A partial object is not a complete saved preset and keeps its own
    // explicit grow settings.
    expect(normalizeKevinHudConfig({
      width: 448,
      maxWidth: 1600,
      autoWidth: true
    })).toMatchObject({ width: 448, maxWidth: 1600, autoWidth: true })

    // Early-beta HUDs could select appIcon and appName separately. That saved
    // selection is a customization, not the untouched default, so it keeps its
    // beta layout while the two metric slots fold into one canonical appName.
    const bothIcons = normalizeKevinHudConfig({
      ...LEGACY_DEFAULT_HUD,
      metrics: ['appIcon', 'appName', 'fps']
    })
    expect(bothIcons).toMatchObject({
      autoWidth: true,
      maxWidth: 1600,
      itemStyle: { description: 'text', valueSize: 12 },
      metrics: ['appName', 'fps']
    })
    expect(normalizeKevinHudConfig({
      ...LEGACY_DEFAULT_HUD,
      metrics: ['appIcon']
    }).metrics).toEqual(['appName'])
    expect(normalizeKevinHudConfig({
      ...LEGACY_DEFAULT_HUD,
      metrics: ['appName', 'appIcon', 'clock']
    }).metrics).toEqual(['appName', 'clock'])
  })

  it('resolves legacy autoWidth into a positive min/max range without breaking fixed sizes', () => {
    // Explicit historical grow mode keeps its broad cap; the new default is
    // fixed 448/448 and does not silently change an explicit choice.
    expect(normalizeKevinHudConfig({ autoWidth: true, width: 448 })).toMatchObject({
      width: 448,
      maxWidth: 1600,
      autoWidth: true
    })
    expect(normalizeKevinHudConfig({ autoWidth: true, width: 448, maxWidth: 448 }))
      .toMatchObject({ width: 448, maxWidth: 448, autoWidth: true })
    // A historical fixed width stays fixed when no maxWidth was ever saved.
    for (const width of [120, 420, 760, 1600]) {
      expect(normalizeKevinHudConfig({ autoWidth: false, width })).toMatchObject({
        width,
        maxWidth: width
      })
    }
    // An explicit cap is honored but can never be narrower than the minimum.
    expect(normalizeKevinHudConfig({ autoWidth: false, width: 760, maxWidth: 1100 }))
      .toMatchObject({ width: 760, maxWidth: 1100 })
    expect(normalizeKevinHudConfig({ autoWidth: true, width: 760, maxWidth: 120 }))
      .toMatchObject({ width: 760, maxWidth: 760 })
    expect(normalizeKevinHudConfig({ width: 900, maxWidth: 99999 }))
      .toMatchObject({ width: 900, maxWidth: 1600 })
  })

  it('falls back optional item sizes and keeps only allowed per-metric overrides', () => {
    const normalized = normalizeKevinHudConfig({
      itemStyle: { valueSize: 14, descriptionBold: false },
      itemStyles: {
        // Historical beta layout/type/weight fields are ignored.
        fps: { orientation: 'vertical', descriptionSize: 16, valueBold: false },
        clock: { description: 'icon', gap: 2, valueBold: false },
        download: { valueColor: '#00FF00', descriptionColor: null },
        bogus: { valueSize: 99 }
      }
    })
    expect(normalized.itemStyle).toEqual({
      orientation: 'horizontal',
      description: 'text',
      gap: 5,
      minWidth: 0,
      descriptionAlign: 'left',
      valueAlign: 'right',
      descriptionSize: 12,
      valueSize: 14,
      descriptionBold: false,
      valueBold: true,
      descriptionColor: null,
      valueColor: null
    })
    expect(normalized.itemStyles).toEqual({
      clock: { gap: 2 },
      download: { valueColor: '#00FF00', descriptionColor: null }
    })
    expect(isKevinHudConfig(normalized)).toBe(true)
  })

  it('keeps every settings-compatible bound instead of shrinking it', () => {
    const maximums = normalizeKevinHudConfig({
      itemGap: KEVIN_HUD_LIMITS.itemGap[1],
      contentPadding: KEVIN_HUD_LIMITS.contentPadding[1],
      fontScale: KEVIN_HUD_LIMITS.fontScale[1],
      itemStyle: {
        gap: KEVIN_HUD_ITEM_STYLE_LIMITS.gap[1],
        minWidth: KEVIN_HUD_ITEM_STYLE_LIMITS.minWidth[1],
        descriptionAlign: 'center',
        valueAlign: 'left',
        descriptionSize: KEVIN_HUD_ITEM_STYLE_LIMITS.descriptionSize[1],
        valueSize: KEVIN_HUD_ITEM_STYLE_LIMITS.valueSize[1]
      },
      itemStyles: {
        download: {
          gap: KEVIN_HUD_ITEM_STYLE_LIMITS.gap[1],
          minWidth: KEVIN_HUD_ITEM_STYLE_LIMITS.minWidth[1],
          descriptionAlign: 'right',
          valueAlign: 'center',
          valueColor: '#FFFFFF'
        }
      }
    })
    expect(maximums).toMatchObject({
      itemGap: 48,
      contentPadding: 32,
      fontScale: 1.25
    })
    expect(maximums.itemStyle).toMatchObject({
      gap: 24,
      minWidth: 1600,
      descriptionAlign: 'center',
      valueAlign: 'left',
      descriptionSize: 24,
      valueSize: 32
    })
    expect(maximums.itemStyles.download).toEqual({
      gap: 24,
      minWidth: 1600,
      descriptionAlign: 'right',
      valueAlign: 'center',
      valueColor: '#FFFFFF'
    })
    expect(isKevinHudConfig(maximums)).toBe(true)

    const minimums = normalizeKevinHudConfig({
      itemGap: KEVIN_HUD_LIMITS.itemGap[0],
      contentPadding: KEVIN_HUD_LIMITS.contentPadding[0],
      fontScale: KEVIN_HUD_LIMITS.fontScale[0],
      itemStyle: {
        gap: KEVIN_HUD_ITEM_STYLE_LIMITS.gap[0],
        descriptionSize: KEVIN_HUD_ITEM_STYLE_LIMITS.descriptionSize[0],
        valueSize: KEVIN_HUD_ITEM_STYLE_LIMITS.valueSize[0]
      }
    })
    expect(minimums).toMatchObject({
      itemGap: 0,
      contentPadding: 0,
      fontScale: 0.8
    })
    expect(minimums.itemStyle).toMatchObject({
      gap: 0,
      descriptionSize: 6,
      valueSize: 8
    })
    expect(isKevinHudConfig(minimums)).toBe(true)
  })

  it('rejects out-of-range, unnormalized or non-allowlisted fields', () => {
    expect(isKevinHudConfig({ ...DEFAULT_KEVIN_HUD, maxWidth: 200 })).toBe(false)
    expect(isKevinHudConfig({ ...DEFAULT_KEVIN_HUD, itemGap: 49 })).toBe(false)
    expect(isKevinHudConfig({ ...DEFAULT_KEVIN_HUD, contentPadding: -1 })).toBe(false)
    expect(isKevinHudConfig({ ...DEFAULT_KEVIN_HUD, foregroundOpacity: 1.01 })).toBe(false)
    expect(isKevinHudConfig({ ...DEFAULT_KEVIN_HUD, foregroundOpacity: undefined })).toBe(false)
    expect(isKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      gradient: { ...DEFAULT_KEVIN_HUD.gradient, stops: [] }
    })).toBe(false)
    expect(isKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      gradient: { ...DEFAULT_KEVIN_HUD.gradient, stops: [{ color: '#FFFFFF', position: 100 }] }
    })).toBe(false)
    expect(isKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      backgroundMode: 'gradient',
      gradient: CUSTOM_GRADIENT
    })).toBe(true)
    expect(isKevinHudConfig({ ...DEFAULT_KEVIN_HUD, absorbLauncher: 'yes' })).toBe(false)
    expect(isKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      itemStyle: { ...DEFAULT_KEVIN_HUD.itemStyle, descriptionSize: 99 }
    })).toBe(false)
    expect(isKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      itemStyle: { ...DEFAULT_KEVIN_HUD.itemStyle, valueColor: '#fff' }
    })).toBe(false)
    expect(isKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      itemStyle: { ...DEFAULT_KEVIN_HUD.itemStyle, minWidth: 1601 }
    })).toBe(false)
    expect(isKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      itemStyle: { ...DEFAULT_KEVIN_HUD.itemStyle, descriptionAlign: 'justify' }
    })).toBe(false)
    expect(isKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      itemStyle: { ...DEFAULT_KEVIN_HUD.itemStyle, valueAlign: 'middle' }
    })).toBe(false)
    expect(isKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      itemStyles: { fps: { descriptionSize: 99 } }
    })).toBe(false)
    expect(isKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      itemStyles: { fps: { valueColor: 'red' } }
    })).toBe(false)
    expect(isKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      itemStyles: { fps: { minWidth: -1 } }
    })).toBe(false)
    expect(isKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      itemStyles: { fps: { minWidth: 1601 } }
    })).toBe(false)
    expect(isKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      itemStyles: { fps: { descriptionAlign: 'between' } }
    })).toBe(false)
    expect(isKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      itemStyles: { fps: { valueAlign: 'middle' } }
    })).toBe(false)
    expect(isKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      itemStyles: {
        fps: {
          gap: 4,
          minWidth: 180,
          descriptionAlign: 'center',
          valueAlign: 'left',
          valueColor: null
        }
      }
    })).toBe(true)
  })
})

describe('normalizeKevinHudConfig', () => {
  it('repairs every invalid field and clamps numeric ranges', () => {
    const normalized = normalizeKevinHudConfig({
      enabled: 'yes',
      alwaysVisible: 1,
      absorbLauncher: 'yes',
      displaySeconds: 99,
      sampleSeconds: 0.1,
      direction: 'diagonal',
      bounce: 9,
      ripple: -1,
      anchor: 'middle',
      x: -4,
      y: 180,
      width: -10,
      maxWidth: -10,
      height: '48',
      radius: -1,
      borderWidth: 999,
      borderColor: 'red',
      backgroundMode: 'transparent',
      gradient: {
        kind: 'diagonal',
        angle: 999,
        centerX: -5,
        centerY: 200,
        shape: 'square',
        stops: [{ color: 'red', position: 0 }]
      },
      material: 'unknown',
      backgroundColor: '#12345',
      foregroundOpacity: 2,
      backgroundOpacity: 2,
      textColor: 'navy',
      iconColor: '#12345',
      textOffsetX: Number.POSITIVE_INFINITY,
      textOffsetY: -99999,
      iconOffsetX: Number.NaN,
      iconOffsetY: 99999,
      fontScale: 2,
      itemGap: 999,
      contentPadding: -1,
      itemStyle: {
        orientation: 'diagonal',
        description: 'emoji',
        gap: -5,
        minWidth: -10,
        descriptionAlign: 'justify',
        valueAlign: 'middle',
        descriptionSize: 999,
        valueSize: '13',
        descriptionBold: 'yes',
        valueBold: 0,
        descriptionColor: 'red',
        valueColor: '#12345'
      },
      itemStyles: {
        fps: {
          gap: -2,
          minWidth: 99999,
          descriptionAlign: 'right',
          valueAlign: 'bogus',
          valueColor: '#12345',
          valueSize: 999,
          orientation: 'diagonal'
        },
        bogus: { valueSize: 20 }
      },
      monitor: 'secondary',
      autoWidth: 'true',
      restoreLauncher: 0,
      hotkey: 123,
      metrics: ['fps', 'unknown', 'fps', 'clock']
    })

    expect(normalized).toMatchObject({
      enabled: true,
      alwaysVisible: true,
      absorbLauncher: true,
      displaySeconds: 10,
      sampleSeconds: 0.5,
      direction: 'center',
      bounce: 0.5,
      ripple: 0,
      anchor: 'center',
      x: 0,
      y: 100,
      width: 448,
      maxWidth: 448,
      height: 48,
      radius: 24,
      borderWidth: 6,
      borderColor: '#A7AD48',
      backgroundMode: 'gradient',
      gradient: {
        ...DEFAULT_KEVIN_HUD_GRADIENT,
        angle: 360,
        centerX: 0,
        centerY: 100
      },
      material: 'blur',
      backgroundColor: '#312F30',
      foregroundOpacity: 1,
      backgroundOpacity: 1,
      textColor: '#FFFFFF',
      iconColor: null,
      textOffsetX: 0,
      textOffsetY: -200,
      iconOffsetX: 0,
      iconOffsetY: 200,
      fontScale: 1.25,
      itemGap: 48,
      contentPadding: 12,
      itemStyle: {
        orientation: 'horizontal',
        description: 'text',
        gap: 0,
        minWidth: 0,
        descriptionAlign: 'left',
        valueAlign: 'right',
        descriptionSize: 24,
        valueSize: 14,
        descriptionBold: true,
        valueBold: true,
        descriptionColor: null,
        valueColor: null
      },
      itemStyles: {
        fps: { gap: 0, minWidth: 1600, descriptionAlign: 'right' }
      },
      monitor: 'primary',
      autoWidth: false,
      restoreLauncher: false,
      hotkey: null,
      metrics: ['fps', 'clock']
    })
    expect(isKevinHudConfig(normalized)).toBe(true)
  })

  it('locks the attached bounce, ripple and border ranges while keeping in-range saved values', () => {
    expect(normalizeKevinHudConfig({ bounce: 1, ripple: 2, borderWidth: 16 }))
      .toMatchObject({ bounce: 0.5, ripple: 2, borderWidth: 6 })
    expect(normalizeKevinHudConfig({ bounce: 0.5, ripple: 2, borderWidth: 6 }))
      .toMatchObject({ bounce: 0.5, ripple: 2, borderWidth: 6 })
    expect(normalizeKevinHudConfig({ bounce: 0, ripple: 0, borderWidth: 0 }))
      .toMatchObject({ bounce: 0, ripple: 0, borderWidth: 0 })
    expect(isKevinHudConfig({ ...DEFAULT_KEVIN_HUD, bounce: 0.501 })).toBe(false)
    expect(isKevinHudConfig({ ...DEFAULT_KEVIN_HUD, ripple: 2.001 })).toBe(false)
    expect(isKevinHudConfig({ ...DEFAULT_KEVIN_HUD, borderWidth: 6.001 })).toBe(false)
  })

  it('keeps the metric order, folds the appIcon alias, removes duplicates and allows an empty list', () => {
    expect(normalizeKevinHudConfig({
      metrics: ['clock', 'fps', 'clock', 'bogus', 'appIcon']
    }).metrics).toEqual(['clock', 'fps', 'appName'])
    expect(normalizeKevinHudConfig({ metrics: ['appIcon', 'appName', 'memory'] }).metrics)
      .toEqual(['appName', 'memory'])
    expect(normalizeKevinHudConfig({ metrics: ['appName', 'appIcon', 'fps'] }).metrics)
      .toEqual(['appName', 'fps'])
    expect(normalizeKevinHudConfig({ metrics: ['appIcon'] }).metrics).toEqual(['appName'])
    expect(normalizeKevinHudConfig({ metrics: ['clock', 'appIcon', 'appIcon', 'fps'] }).metrics)
      .toEqual(['clock', 'appName', 'fps'])
    expect(normalizeKevinHudConfig({ metrics: [] }).metrics).toEqual([])
    expect(normalizeKevinHudConfig({ metrics: 'fps' }).metrics)
      .toEqual(['fps', 'gpu', 'cpu'])
  })

  it('folds legacy appIcon overrides into appName with canonical fields taking priority', () => {
    const canonicalLast = normalizeKevinHudConfig({
      metrics: ['appIcon', 'appName'],
      itemStyles: {
        appIcon: {
          gap: 7,
          minWidth: 120,
          descriptionAlign: 'right',
          descriptionColor: '#111111',
          valueColor: '#222222',
          orientation: 'vertical',
          valueSize: 99
        },
        appName: {
          valueAlign: 'center',
          valueColor: '#333333',
          valueBold: false
        }
      }
    })
    expect(canonicalLast.metrics).toEqual(['appName'])
    expect(canonicalLast.itemStyles).toEqual({
      appName: {
        gap: 7,
        minWidth: 120,
        descriptionAlign: 'right',
        valueAlign: 'center',
        descriptionColor: '#111111',
        valueColor: '#333333'
      }
    })
    expect(isKevinHudConfig(canonicalLast)).toBe(true)

    const canonicalFirst = normalizeKevinHudConfig({
      metrics: ['appName', 'appIcon'],
      itemStyles: {
        appName: { gap: 9, descriptionColor: null },
        appIcon: { gap: 21, descriptionColor: '#AAAAAA', valueColor: '#BBBBBB' }
      }
    })
    expect(canonicalFirst.itemStyles).toEqual({
      appName: { gap: 9, descriptionColor: null, valueColor: '#BBBBBB' }
    })
    expect(isKevinHudConfig(canonicalFirst)).toBe(true)

    // A malformed legacy entry is ignored field-by-field and never makes the
    // normalized HUD fail to load.
    const malformedAlias = normalizeKevinHudConfig({
      itemStyles: {
        appIcon: {
          gap: 'bad',
          descriptionColor: 'red',
          valueColor: '#00FF00',
          orientation: 'vertical',
          valueSize: 99
        }
      }
    })
    expect(malformedAlias.itemStyles).toEqual({
      appName: { valueColor: '#00FF00' }
    })
    expect(isKevinHudConfig(malformedAlias)).toBe(true)
  })

  it('rejects legacy appIcon ids in already-normalized writes', () => {
    expect(isKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      metrics: ['appIcon']
    })).toBe(false)
    expect(isKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      itemStyles: { appIcon: { gap: 4 } }
    })).toBe(false)
    expect(Object.hasOwn(normalizeKevinHudConfig({
      metrics: ['appIcon'],
      itemStyles: { appIcon: { gap: 4 } }
    }).itemStyles, 'appIcon')).toBe(false)
  })

  it('rejects broken empty or control-character hotkeys but keeps native names', () => {
    expect(normalizeKevinHudConfig({ hotkey: '  ' }).hotkey).toBeNull()
    expect(normalizeKevinHudConfig({ hotkey: 'Ctrl+\nK' }).hotkey).toBeNull()
    expect(normalizeKevinHudConfig({ hotkey: ' F10 ' }).hotkey).toBe('F10')
    expect(isKevinHudConfig({ ...DEFAULT_KEVIN_HUD, hotkey: 'F10' })).toBe(true)
    expect(isKevinHudConfig({ ...DEFAULT_KEVIN_HUD, metrics: ['fps', 'fps'] })).toBe(false)
    expect(isKevinHudConfig({ ...DEFAULT_KEVIN_HUD, textColor: '#fff' })).toBe(false)
  })
})

describe('launcher config integration', () => {
  it('normalizes an optional per-app HUD without changing other apps or upgrade markers', () => {
    const raw = {
      version: CURRENT_VERSION,
      apps: [
        {
          id: 'game',
          name: 'Game',
          kevinHud: {
            enabled: false,
            displaySeconds: 1,
            direction: 'left',
            metrics: ['fps', 'fps', 'bogus'],
            hotkey: 'Alt+F10'
          }
        },
        { id: 'other', name: 'Other' }
      ],
      launcher: {
        themePolicyVersion: '2.0.5',
        themePolicyApplied: ['2.0.5'],
        featureIntroApplied: ['2.0.5']
      }
    }

    const config = normalizeLauncherConfig(raw)
    expect(config.apps[0]).toMatchObject({ id: 'game', name: 'Game' })
    expect(config.apps[0].kevinHud).toMatchObject({
      enabled: false,
      displaySeconds: 3,
      direction: 'left',
      metrics: ['fps'],
      hotkey: 'Alt+F10'
    })
    expect(config.apps[1].kevinHud).toEqual(DEFAULT_KEVIN_HUD)
    expect(config.launcher).toMatchObject({
      themePolicyVersion: '2.0.5',
      themePolicyApplied: ['2.0.5'],
      featureIntroApplied: ['2.0.5']
    })
    expect(() => validateLauncherConfig(config)).not.toThrow()
    expect((raw.apps[0].kevinHud as Record<string, unknown>).displaySeconds).toBe(1)
  })

  it('turns a malformed historical HUD value into safe defaults', () => {
    const malformed = normalizeLauncherConfig({
      version: CURRENT_VERSION,
      apps: [{ id: 'game', name: 'Game', kevinHud: 'not-an-object' }]
    })
    expect(malformed.apps[0].kevinHud).toEqual(DEFAULT_KEVIN_HUD)
  })

  it('rejects a directly written HUD that is not normalized', () => {
    expect(() => validateLauncherConfig({
      version: CURRENT_VERSION,
      apps: [{ id: 'game', name: 'Game', kevinHud: { enabled: 'yes' } }]
    })).toThrow()
  })
})

describe('HUD persistence in config.json', () => {
  let root: string | undefined

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'kl-kevin-hud-'))
    electron.data = join(root, 'data')
    await fs.mkdir(electron.data, { recursive: true })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (root) await fs.rm(root, { recursive: true, force: true })
    root = undefined
  })

  it('upgrades an untouched old preset without clearing a customized old HUD', async () => {
    const file = AppStore.file()
    await fs.writeFile(file, JSON.stringify({
      version: CURRENT_VERSION,
      apps: [
        { id: 'untouched', name: 'Untouched', kevinHud: LEGACY_DEFAULT_HUD },
        { id: 'custom', name: 'Custom', kevinHud: { ...LEGACY_DEFAULT_HUD, width: 620 } }
      ]
    }, null, 2))

    const loaded = await AppStore.load()
    expect(loaded.apps[0].kevinHud).toEqual(DEFAULT_KEVIN_HUD)
    expect(loaded.apps[1].kevinHud).toMatchObject({
      width: 620,
      maxWidth: 1600,
      autoWidth: true,
      itemStyle: { description: 'text', valueSize: 12 }
    })

    // Reading never erases the user's original JSON. A later mutation persists
    // the normalized in-memory shape through the existing atomic store.
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8')) as {
      apps: Array<{ id: string; kevinHud: { width: number } }>
    }
    expect(onDisk.apps.find(({ id }) => id === 'untouched')?.kevinHud.width).toBe(448)
    expect(onDisk.apps.find(({ id }) => id === 'custom')?.kevinHud.width).toBe(620)
  })

  it('materializes defaults on read and saves HUD through the existing atomic config store', async () => {
    const file = AppStore.file()
    await fs.writeFile(file, JSON.stringify({
      version: CURRENT_VERSION,
      apps: [{ id: 'game', name: 'Game' }, { id: 'other', name: 'Other' }],
      launcher: { themePolicyApplied: ['2.0.5'], featureIntroApplied: ['2.0.5'] }
    }, null, 2))

    expect((await AppStore.load()).apps[0].kevinHud).toEqual(DEFAULT_KEVIN_HUD)
    await AppStore.patchApp('game', {
      kevinHud: { ...CUSTOM_HUD, displaySeconds: 99, metrics: ['fps', 'clock'] }
    })

    const persisted = JSON.parse(await fs.readFile(file, 'utf8')) as {
      apps: Array<{ id: string; kevinHud?: KevinHudConfig }>
      launcher: Record<string, unknown>
    }
    const persistedHud = persisted.apps.find(({ id }) => id === 'game')?.kevinHud
    expect(persistedHud).toMatchObject({
      enabled: false,
      displaySeconds: 10,
      maxWidth: 900,
      itemGap: 7,
      backgroundMode: 'gradient',
      gradient: CUSTOM_GRADIENT,
      foregroundOpacity: 0.7,
      backgroundOpacity: 0.4,
      hotkey: 'CommandOrControl+Shift+K',
      metrics: ['fps', 'clock']
    })
    expect(Object.hasOwn(persistedHud ?? {}, 'opacity')).toBe(false)
    expect(persisted.apps.find(({ id }) => id === 'other')?.kevinHud).toEqual(DEFAULT_KEVIN_HUD)
    expect(persisted.launcher).toMatchObject({
      themePolicyApplied: ['2.0.5'],
      featureIntroApplied: ['2.0.5']
    })
  })
})
