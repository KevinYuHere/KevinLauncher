import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KEVIN_HUD,
  normalizeKevinHudConfig,
  KEVIN_HUD_METRICS
} from '../src/shared/kevinHud'
import {
  KEVIN_HUD_APP_NAME_MAX_WIDTH,
  KEVIN_HUD_CELL_INLINE_PADDING,
  KEVIN_HUD_DEFAULT_CONTENT_PADDING,
  KEVIN_HUD_DEFAULT_ITEM_GAP,
  KEVIN_HUD_DEFAULT_MAX_WIDTH,
  KEVIN_HUD_ITEM_DEFAULT,
  KEVIN_HUD_MAX_CONTENT_PADDING,
  KEVIN_HUD_MAX_ITEM_GAP,
  KEVIN_HUD_MEMORY_READOUT_MIN_WIDTH,
  KEVIN_HUD_MEMORY_REFERENCE,
  KEVIN_HUD_METRIC_TEMPLATES,
  getKevinHudItemStyle,
  getKevinHudValueTextCandidates,
  kevinHudSizingKey,
  measureKevinHudAnnouncementWidth,
  measureKevinHudAnnounceStatusWidth,
  measureKevinHudItemWidth,
  measureKevinHudMinContentHeight,
  measureKevinHudTextWidth,
  measureKevinHudValueWidth,
  resolveKevinHudContentPadding,
  resolveKevinHudFontScale,
  resolveKevinHudItemGap,
  resolveKevinHudMemoryReadoutTypeSizing,
  resolveKevinHudWidthBounds,
  usesKevinHudMemoryReadout
} from '../src/shared/kevinHudSizing'
import {
  KEVIN_HUD_DURATION_TEXT_CANDIDATES,
  KEVIN_HUD_RATE_TEXT_CANDIDATES
} from '../src/shared/kevinHudMetricText'

const CONFIG = normalizeKevinHudConfig(DEFAULT_KEVIN_HUD)

/**
 * Historical 8.5 px icon descriptor fixture. The fresh default is the 12 px
 * text descriptor, but the dedicated memory instrument keeps this exact
 * optical reference and its tests must not be rewritten by the new default.
 */
const LEGACY_MEMORY_ITEM_STYLE = {
  ...CONFIG.itemStyle,
  description: 'icon' as const,
  descriptionSize: KEVIN_HUD_MEMORY_REFERENCE.descriptionSize,
  valueSize: KEVIN_HUD_MEMORY_REFERENCE.valueSize
}

describe('KEVIN HUD reserved display metadata', () => {
  it('reserves a documented bounded template for every metric', () => {
    expect(Object.keys(KEVIN_HUD_METRIC_TEMPLATES).sort()).toEqual(
      [...KEVIN_HUD_METRICS].sort()
    )
    for (const metric of KEVIN_HUD_METRICS) {
      const template = KEVIN_HUD_METRIC_TEMPLATES[metric]
      expect(typeof template.template).toBe('string')
      expect(typeof template.label).toBe('string')
      expect(template.template.length).toBeGreaterThan(0)
    }
    expect(KEVIN_HUD_METRIC_TEMPLATES.appName).toMatchObject({ label: '', template: 'KEVIN' })
    expect(KEVIN_HUD_METRICS).not.toContain('appIcon')
  })
})

describe('KEVIN HUD fixed-slot text candidates', () => {
  it('exports every duration/network candidate plus the conservative template', () => {
    for (const metric of ['sessionTime', 'totalTime'] as const) {
      const candidates = getKevinHudValueTextCandidates(metric)
      expect(candidates).toEqual(
        expect.arrayContaining([...KEVIN_HUD_DURATION_TEXT_CANDIDATES])
      )
      expect(candidates).toContain(KEVIN_HUD_METRIC_TEMPLATES[metric].template)
      expect(new Set(candidates).size).toBe(candidates.length)
      expect(Object.isFrozen(candidates)).toBe(true)
    }
    for (const metric of ['download', 'upload'] as const) {
      const candidates = getKevinHudValueTextCandidates(metric)
      expect(candidates).toEqual(
        expect.arrayContaining([...KEVIN_HUD_RATE_TEXT_CANDIDATES])
      )
      expect(candidates).toContain(KEVIN_HUD_METRIC_TEMPLATES[metric].template)
      expect(new Set(candidates).size).toBe(candidates.length)
      expect(Object.isFrozen(candidates)).toBe(true)
    }

    expect(getKevinHudValueTextCandidates('fps')).toEqual([
      KEVIN_HUD_METRIC_TEMPLATES.fps.template
    ])
    expect(getKevinHudValueTextCandidates('appName')).toEqual([])
  })

  it('reserves at least the measured width of every candidate at maximum type', () => {
    const config = {
      ...CONFIG,
      fontScale: 1.25,
      itemStyle: {
        ...CONFIG.itemStyle,
        descriptionSize: 24,
        valueSize: 32,
        descriptionBold: true,
        valueBold: true
      }
    }
    for (const metric of ['sessionTime', 'totalTime', 'download', 'upload'] as const) {
      const style = getKevinHudItemStyle(config, metric)
      const reserved = measureKevinHudValueWidth(config, metric)
      for (const text of getKevinHudValueTextCandidates(metric)) {
        const measured = measureKevinHudTextWidth(text, style.valueSize * 1.25)
        expect(reserved).toBeGreaterThanOrEqual(Math.ceil(measured + 2))
      }
    }
  })
})

describe('KEVIN HUD announcement sizing', () => {
  it('keeps its own launch geometry independent of monitoring item styles', () => {
    const plain = measureKevinHudAnnouncementWidth(CONFIG, '原神')
    const restyled = measureKevinHudAnnouncementWidth(
      {
        ...CONFIG,
        itemGap: 48,
        metrics: ['fps', 'memory'],
        itemStyle: {
          ...CONFIG.itemStyle,
          orientation: 'vertical',
          descriptionSize: 24,
          valueSize: 32,
          gap: 24,
          minWidth: 1600,
          descriptionAlign: 'center',
          valueAlign: 'center'
        },
        itemStyles: {
          appName: {
            gap: 24,
            minWidth: 1600,
            descriptionAlign: 'right',
            valueAlign: 'left',
            valueColor: '#00FF00'
          }
        }
      },
      '原神'
    )
    expect(restyled).toBe(plain)
    // The trailing status is part of the reserved auto width.
    expect(plain).toBeGreaterThan(measureKevinHudAnnounceStatusWidth(CONFIG))
    expect(measureKevinHudAnnouncementWidth(CONFIG, '原神'.repeat(20)))
      .toBeGreaterThan(plain)
  })
})

describe('KEVIN HUD item style resolution', () => {
  it('starts from the text descriptor, 12 px description and 14 px value', () => {
    expect(KEVIN_HUD_ITEM_DEFAULT).toEqual({
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
    })
    expect(getKevinHudItemStyle(CONFIG, 'fps')).toEqual(KEVIN_HUD_ITEM_DEFAULT)
    expect(KEVIN_HUD_DEFAULT_MAX_WIDTH).toBe(448)
    expect(resolveKevinHudWidthBounds(CONFIG)).toEqual({
      minWidth: 448,
      maxWidth: 448,
      auto: false
    })
  })

  it('merges global typography with only the allowed per-metric overrides', () => {
    const config = normalizeKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      itemStyle: {
        valueSize: 15,
        descriptionBold: false,
        descriptionColor: '#AABBCC',
        valueColor: '#FFFFFF',
        minWidth: 90,
        descriptionAlign: 'center',
        valueAlign: 'left'
      },
      itemStyles: {
        fps: {
          orientation: 'vertical',
          descriptionSize: 16,
          valueBold: false,
          gap: 9,
          minWidth: 180,
          descriptionAlign: 'right',
          valueColor: '#00FF00'
        },
        gpu: { description: 'icon', valueSize: 16, descriptionColor: null }
      }
    })
    expect(getKevinHudItemStyle(config, 'fps')).toEqual({
      ...KEVIN_HUD_ITEM_DEFAULT,
      valueSize: 15,
      descriptionBold: false,
      descriptionColor: '#AABBCC',
      valueColor: '#00FF00',
      gap: 9,
      minWidth: 180,
      descriptionAlign: 'right',
      valueAlign: 'left'
    })
    expect(getKevinHudItemStyle(config, 'gpu')).toEqual({
      ...KEVIN_HUD_ITEM_DEFAULT,
      valueSize: 15,
      descriptionBold: false,
      // Explicit null on a per-item override resets to the readable colour.
      descriptionColor: null,
      valueColor: '#FFFFFF',
      minWidth: 90,
      descriptionAlign: 'center',
      valueAlign: 'left'
    })
    expect(getKevinHudItemStyle(config, 'memory')).toMatchObject({
      valueSize: 15,
      descriptionBold: false,
      // The app-wide text descriptor wins; the per-item `gpu` icon entry is a
      // historical field and cannot leak into another metric.
      description: 'text',
      descriptionColor: '#AABBCC'
    })
  })

  it('keeps the dedicated memory type at its 448 x 48 reference and scales it by item size', () => {
    const reference = resolveKevinHudMemoryReadoutTypeSizing(LEGACY_MEMORY_ITEM_STYLE)
    expect(reference.valueScale).toBe(1)
    expect(reference.descriptionScale).toBe(1)
    expect(reference.usedSize).toBeCloseTo(KEVIN_HUD_MEMORY_REFERENCE.usedSize)
    expect(reference.totalSize).toBeCloseTo(11.2)
    expect(reference.percentSize).toBeCloseTo(17.6)
    expect(reference.percentSignSize).toBeCloseTo(10.4)
    expect(reference.descriptionTextSize).toBeCloseTo(11.2)
    expect(reference.descriptionIconSize).toBeCloseTo(16.8)

    const explicit = resolveKevinHudMemoryReadoutTypeSizing(
      { valueSize: 28, descriptionSize: 17 },
      1.25
    )
    expect(explicit.valueScale).toBe(2)
    expect(explicit.descriptionScale).toBe(2)
    expect(explicit.usedSize).toBeCloseTo(20.8 * 2 * 1.25)
    expect(explicit.totalSize).toBeCloseTo(11.2 * 2 * 1.25)
    expect(explicit.percentSize).toBeCloseTo(17.6 * 2 * 1.25)
    expect(explicit.percentSignSize).toBeCloseTo(10.4 * 2 * 1.25)
    expect(explicit.descriptionTextSize).toBeCloseTo(11.2 * 2 * 1.25)
    expect(explicit.descriptionIconSize).toBeCloseTo(16.8 * 2)
  })

  it('ignores historical per-item layout/type/weight fields in a raw draft', () => {
    const raw = {
      itemStyle: {
        ...KEVIN_HUD_ITEM_DEFAULT,
        valueSize: 14,
        descriptionBold: false
      },
      itemStyles: {
        fps: {
          orientation: 'vertical',
          description: 'text',
          descriptionSize: 20,
          valueSize: 22,
          descriptionBold: true,
          valueBold: false,
          gap: 6,
          minWidth: 140,
          descriptionAlign: 'center' as const,
          valueAlign: 'left' as const,
          valueColor: '#112233'
        }
      }
    }
    expect(getKevinHudItemStyle(raw, 'fps')).toMatchObject({
      orientation: 'horizontal',
      description: 'text',
      descriptionSize: 12,
      valueSize: 14,
      descriptionBold: false,
      valueBold: true,
      gap: 6,
      minWidth: 140,
      descriptionAlign: 'center',
      valueAlign: 'left',
      valueColor: '#112233'
    })
  })

  it('keeps colours out of geometry and the layout signature', () => {
    const baseKey = kevinHudSizingKey(CONFIG)
    const coloured = {
      ...CONFIG,
      itemStyle: {
        ...CONFIG.itemStyle,
        descriptionColor: '#AABBCC',
        valueColor: '#112233'
      },
      itemStyles: { fps: { valueColor: '#445566' } }
    }
    expect(kevinHudSizingKey(coloured)).toBe(baseKey)
    expect(measureKevinHudItemWidth(coloured, 'fps')).toBe(
      measureKevinHudItemWidth(CONFIG, 'fps')
    )
  })

  it('measures the merged app identity as a regular icon + name value', () => {
    const config = normalizeKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      itemStyle: {
        orientation: 'vertical',
        description: 'text',
        gap: 20,
        descriptionSize: 20,
        valueSize: 28,
        descriptionBold: false,
        valueBold: false,
        descriptionColor: '#AABBCC',
        valueColor: '#FFFFFF'
      },
      itemStyles: {
        appName: { gap: 22, valueColor: '#00FF00' },
        appIcon: { gap: 9, descriptionColor: '#112233' }
      }
    })
    const style = getKevinHudItemStyle(config, 'appName')
    expect(style).toMatchObject({
      orientation: 'vertical',
      // The real app icon is the fixed descriptor form, regardless of the
      // unified `description: 'text'` preference.
      description: 'icon',
      gap: 22,
      descriptionSize: 20,
      valueSize: 28,
      descriptionBold: false,
      valueBold: false,
      // The canonical appName override supplies the gap and value colour; the
      // legacy appIcon entry only fills the description colour it did not set.
      descriptionColor: '#112233',
      valueColor: '#00FF00'
    })

    const titleWidth = measureKevinHudValueWidth(config, 'appName', {
      appName: '原神'
    })
    const verticalWidth = measureKevinHudItemWidth(config, 'appName', {
      appName: '原神'
    })
    const horizontalWidth = measureKevinHudItemWidth(
      {
        ...config,
        itemStyle: { ...config.itemStyle, orientation: 'horizontal' }
      },
      'appName',
      { appName: '原神' }
    )
    expect(titleWidth).toBeGreaterThanOrEqual(54)
    // The icon and inner gap are part of the measured identity width; a
    // vertical item stacks them and therefore uses the max instead of the sum.
    expect(horizontalWidth).toBeGreaterThan(verticalWidth)
    expect(measureKevinHudItemWidth(CONFIG, 'appName', { appName: 'A' }))
      .toBeGreaterThan(0)
    expect(measureKevinHudItemWidth({
      ...CONFIG,
      itemStyles: { appName: { minWidth: 222 } }
    }, 'appName', { appName: 'A' })).toBeGreaterThanOrEqual(222)
  })
})

describe('KEVIN HUD per-item minimum width and alignment', () => {
  it('uses the default reference alignments for the dedicated memory readout', () => {
    expect(usesKevinHudMemoryReadout(KEVIN_HUD_ITEM_DEFAULT)).toBe(true)
    expect(usesKevinHudMemoryReadout({
      ...KEVIN_HUD_ITEM_DEFAULT,
      descriptionAlign: 'center'
    })).toBe(false)
    expect(usesKevinHudMemoryReadout({
      ...KEVIN_HUD_ITEM_DEFAULT,
      valueAlign: 'left'
    })).toBe(false)
  })

  it('measures each item at least as wide as its minWidth and its content', () => {
    const base = {
      ...CONFIG,
      metrics: ['fps'] as const,
      itemStyle: { ...CONFIG.itemStyle, minWidth: 0 }
    }
    const natural = measureKevinHudItemWidth(base, 'fps')
    expect(natural).toBeGreaterThan(0)

    const globalFloor = {
      ...base,
      itemStyle: { ...base.itemStyle, minWidth: 420 }
    }
    expect(measureKevinHudItemWidth(globalFloor, 'fps')).toBeGreaterThanOrEqual(420)

    const perItemFloor = {
      ...base,
      itemStyle: { ...base.itemStyle, minWidth: 10 },
      itemStyles: { fps: { minWidth: 333 } }
    }
    expect(measureKevinHudItemWidth(perItemFloor, 'fps')).toBeGreaterThanOrEqual(333)
    // A larger content reserve still wins over the user's lower bound.
    const contentWide = {
      ...base,
      itemStyle: { ...base.itemStyle, minWidth: 10, valueSize: 32 },
      fontScale: 1.25,
      metrics: ['sessionTime'] as const
    }
    expect(measureKevinHudItemWidth(contentWide, 'sessionTime'))
      .toBeGreaterThan(10)
  })

  it('counts the gap into width only for a horizontal item and into height when vertical', () => {
    const base = {
      ...CONFIG,
      height: 24,
      contentPadding: 4,
      metrics: ['fps'] as const,
      itemStyle: {
        ...CONFIG.itemStyle,
        minWidth: 0,
        descriptionSize: 16,
        valueSize: 20
      }
    }
    const horizontalTight = {
      ...base,
      itemStyle: { ...base.itemStyle, orientation: 'horizontal' as const, gap: 0 }
    }
    const horizontalLoose = {
      ...base,
      itemStyle: { ...base.itemStyle, orientation: 'horizontal' as const, gap: 24 }
    }
    expect(
      measureKevinHudItemWidth(horizontalLoose, 'fps') -
        measureKevinHudItemWidth(horizontalTight, 'fps')
    ).toBeGreaterThanOrEqual(24)

    const verticalTight = {
      ...base,
      itemStyle: { ...base.itemStyle, orientation: 'vertical' as const, gap: 0 }
    }
    const verticalLoose = {
      ...base,
      itemStyle: { ...base.itemStyle, orientation: 'vertical' as const, gap: 24 }
    }
    expect(measureKevinHudItemWidth(verticalLoose, 'fps')).toBe(
      measureKevinHudItemWidth(verticalTight, 'fps')
    )
    expect(
      measureKevinHudMinContentHeight(verticalLoose) -
        measureKevinHudMinContentHeight(verticalTight)
    ).toBeGreaterThanOrEqual(24)
  })

  it('never lets the reserved description/value slot overlap', () => {
    const config = {
      ...CONFIG,
      metrics: ['fps'] as const,
      itemStyle: {
        ...CONFIG.itemStyle,
        minWidth: 0,
        gap: 24,
        descriptionSize: 24,
        valueSize: 32
      }
    }
    const style = getKevinHudItemStyle(config, 'fps')
    const valueWidth = measureKevinHudValueWidth(config, 'fps')
    const itemWidth = measureKevinHudItemWidth(config, 'fps')
    expect(style.gap).toBe(24)
    expect(itemWidth).toBeGreaterThanOrEqual(
      valueWidth + style.gap + KEVIN_HUD_CELL_INLINE_PADDING * 2
    )

    const vertical = {
      ...config,
      itemStyle: { ...config.itemStyle, orientation: 'vertical' as const }
    }
    const lines = style.valueSize * 1.22 +
      style.gap +
      style.descriptionSize * 1.22
    expect(measureKevinHudMinContentHeight(vertical)).toBeGreaterThanOrEqual(
      Math.ceil(lines)
    )
  })

  it('keeps the dedicated memory reserve and switches away from it on custom alignment', () => {
    const memoryOnly = {
      ...CONFIG,
      metrics: ['memory'] as const,
      itemStyle: { ...CONFIG.itemStyle, minWidth: 0 }
    }
    expect(usesKevinHudMemoryReadout(getKevinHudItemStyle(memoryOnly, 'memory')))
      .toBe(true)
    expect(measureKevinHudItemWidth(memoryOnly, 'memory'))
      .toBeGreaterThanOrEqual(KEVIN_HUD_MEMORY_READOUT_MIN_WIDTH)

    const custom = {
      ...memoryOnly,
      itemStyle: { ...memoryOnly.itemStyle, valueAlign: 'left' as const }
    }
    expect(usesKevinHudMemoryReadout(getKevinHudItemStyle(custom, 'memory')))
      .toBe(false)
    expect(measureKevinHudItemWidth(custom, 'memory'))
      .toBeLessThan(KEVIN_HUD_MEMORY_READOUT_MIN_WIDTH)

    // The ordinary presentation must still honor the per-item lower bound.
    const customFloor = {
      ...custom,
      itemStyle: { ...custom.itemStyle, minWidth: 420 }
    }
    expect(measureKevinHudItemWidth(customFloor, 'memory'))
      .toBeGreaterThanOrEqual(420)
  })

  it('uses the general layout for a custom-aligned memory item', () => {
    const base = {
      ...CONFIG,
      height: 24,
      contentPadding: 4,
      metrics: ['memory'] as const,
      itemStyle: { ...CONFIG.itemStyle, minWidth: 0 }
    }
    const dedicated = measureKevinHudMinContentHeight(base)
    const custom = measureKevinHudMinContentHeight({
      ...base,
      itemStyle: { ...base.itemStyle, descriptionAlign: 'center' as const }
    })
    expect(custom).toBeLessThan(dedicated)
    expect(custom).toBeGreaterThanOrEqual(24)
  })

  it('re-measures for min width and alignment but not for colour edits', () => {
    const baseConfig = {
      ...CONFIG,
      metrics: ['fps'] as const,
      itemStyle: { ...CONFIG.itemStyle, minWidth: 0 }
    }
    const base = kevinHudSizingKey(baseConfig)
    expect(kevinHudSizingKey({
      ...baseConfig,
      itemStyle: { ...baseConfig.itemStyle, descriptionAlign: 'center' }
    })).not.toBe(base)
    expect(kevinHudSizingKey({
      ...baseConfig,
      itemStyle: { ...baseConfig.itemStyle, valueAlign: 'left' }
    })).not.toBe(base)
    expect(kevinHudSizingKey({
      ...baseConfig,
      itemStyle: { ...baseConfig.itemStyle, minWidth: 240 }
    })).not.toBe(base)
    expect(kevinHudSizingKey({
      ...baseConfig,
      itemStyles: {
        fps: {
          minWidth: 180,
          descriptionAlign: 'right',
          valueAlign: 'center'
        }
      }
    })).not.toBe(base)
    expect(kevinHudSizingKey({
      ...baseConfig,
      itemStyle: {
        ...baseConfig.itemStyle,
        descriptionColor: '#AABBCC',
        valueColor: '#112233'
      },
      itemStyles: { fps: { valueColor: '#445566' } }
    })).toBe(base)
  })
})

describe('KEVIN HUD deterministic widths', () => {
  it('returns a finite positive slot for every metric', () => {
    for (const metric of KEVIN_HUD_METRICS) {
      const width = measureKevinHudItemWidth(CONFIG, metric)
      expect(Number.isFinite(width)).toBe(true)
      expect(width).toBeGreaterThan(0)
    }
  })

  it('reserves the same width for every sample string of a metric', () => {
    // The shared helper has no sample-string input by design: widths come from
    // the bounded templates, not from a particular value reading.
    const first = measureKevinHudItemWidth(CONFIG, 'fps')
    const second = measureKevinHudItemWidth(
      { ...CONFIG, metrics: ['fps', 'gpu', 'memory'] },
      'fps'
    )
    expect(second).toBe(first)
  })

  it('keeps ordinary metric reserves independent of the other selections', () => {
    for (const metric of ['sessionTime', 'download', 'fps', 'appName'] as const) {
      expect(
        measureKevinHudItemWidth({ ...CONFIG, metrics: KEVIN_HUD_METRICS }, metric)
      ).toBe(measureKevinHudItemWidth(CONFIG, metric))
    }
    // Memory is the one intentional exception: the dedicated readout only
    // exists while memory is the sole selected metric. The fresh default
    // selects fps/gpu/cpu, so the fixture must make memory explicit.
    expect(
      measureKevinHudItemWidth({ ...CONFIG, metrics: ['memory'] }, 'memory')
    ).toBeGreaterThanOrEqual(KEVIN_HUD_MEMORY_READOUT_MIN_WIDTH)
    expect(
      measureKevinHudItemWidth({ ...CONFIG, metrics: KEVIN_HUD_METRICS }, 'memory')
    ).toBeLessThan(KEVIN_HUD_MEMORY_READOUT_MIN_WIDTH)
  })

  it('estimates the merged app name from stable title geometry and a calm fallback', () => {
    const fallback = measureKevinHudItemWidth(CONFIG, 'appName')
    const short = measureKevinHudItemWidth(CONFIG, 'appName', { appName: '原神' })
    const long = measureKevinHudItemWidth(CONFIG, 'appName', {
      appName: '崩坏：星穹铁道 — 开拓者档案'.repeat(4)
    })
    expect(short).toBeGreaterThanOrEqual(fallback)
    expect(long).toBeGreaterThan(short)
    // The title value itself is bounded and scrolls inside its cell; the icon,
    // inner gap and inline padding sit outside that title bound.
    const title = measureKevinHudValueWidth(CONFIG, 'appName', {
      appName: '崩坏：星穹铁道 — 开拓者档案'.repeat(4)
    })
    expect(title).toBe(KEVIN_HUD_APP_NAME_MAX_WIDTH)
    const iconReserve = Math.max(
      12,
      Math.ceil(DEFAULT_KEVIN_HUD.itemStyle.descriptionSize * 1.35)
    )
    expect(long).toBeLessThanOrEqual(
      title +
        iconReserve +
        DEFAULT_KEVIN_HUD.itemStyle.gap +
        KEVIN_HUD_CELL_INLINE_PADDING * 2
    )
    expect(measureKevinHudValueWidth(CONFIG, 'appName', { appName: 'A' }))
      .toBeGreaterThanOrEqual(54)
  })

  it('honors horizontal and vertical item orientation', () => {
    const base = { ...CONFIG, metrics: ['fps'] as const }
    const horizontal = getKevinHudItemStyle(base, 'fps')
    const vertical = getKevinHudItemStyle({
      ...base,
      itemStyle: { ...horizontal, orientation: 'vertical' }
    }, 'fps')
    expect(vertical.orientation).toBe('vertical')
    expect(getKevinHudItemStyle(base, 'fps').orientation).toBe(horizontal.orientation)
  })
})

describe('KEVIN HUD width bounds and content padding', () => {
  it('uses width as min/manual and maxWidth as the positive cap', () => {
    expect(resolveKevinHudWidthBounds({ width: 448, autoWidth: true })).toEqual({
      minWidth: 448,
      maxWidth: 1600,
      auto: true
    })
    expect(resolveKevinHudWidthBounds({
      width: 900,
      maxWidth: 500,
      autoWidth: true
    })).toMatchObject({ minWidth: 900, maxWidth: 900 })
    expect(resolveKevinHudWidthBounds({ width: 1, autoWidth: true }))
      .toMatchObject({ minWidth: 120 })
  })

  it('keeps legacy fixed widths at min === max', () => {
    expect(resolveKevinHudWidthBounds({ width: 420, autoWidth: false })).toEqual({
      minWidth: 420,
      maxWidth: 420,
      auto: false
    })
    expect(resolveKevinHudWidthBounds({ width: 760 })).toEqual({
      minWidth: 760,
      maxWidth: 760,
      auto: false
    })
  })

  it('derives vertical padding from the same contentPadding value when absent', () => {
    const normal = resolveKevinHudContentPadding({
      height: 48,
      contentPadding: KEVIN_HUD_DEFAULT_CONTENT_PADDING
    })
    const larger = resolveKevinHudContentPadding({ height: 48, contentPadding: 30 })
    expect(normal.horizontal).toBe(CONFIG.contentPadding)
    expect(larger.horizontal).toBe(30)
    // The vertical share is a bounded fraction/cap so the selected text always
    // has room and a large horizontal padding cannot starve the row.
    expect(larger.vertical).toBeLessThanOrEqual(larger.horizontal)
    expect(larger.vertical).toBeLessThan(30)
  })

  it('does not let a low configured height shrink explicit vertical padding', () => {
    expect(resolveKevinHudContentPadding({
      height: 24,
      contentPadding: 12,
      verticalPadding: 32
    })).toEqual({ horizontal: 12, vertical: 32 })

    const natural = measureKevinHudMinContentHeight({
      ...CONFIG,
      height: 24,
      metrics: ['fps'],
      verticalPadding: 32
    })
    expect(natural).toBeGreaterThan(24)
  })

  it('shares the canonical config bounds with sizing', () => {
    expect(KEVIN_HUD_MAX_ITEM_GAP).toBe(48)
    expect(KEVIN_HUD_MAX_CONTENT_PADDING).toBe(32)
    expect(resolveKevinHudItemGap({ itemGap: 40 })).toBe(40)
    expect(resolveKevinHudFontScale({ fontScale: 1.25 })).toBe(1.25)
    expect(getKevinHudItemStyle({
      itemStyle: { gap: 0, descriptionSize: 6, valueSize: 8 }
    }, 'fps')).toMatchObject({
      gap: 0,
      descriptionSize: 6,
      valueSize: 8
    })
    expect(getKevinHudItemStyle({
      itemStyle: { gap: 24, descriptionSize: 24, valueSize: 32 }
    }, 'fps')).toMatchObject({
      gap: 24,
      descriptionSize: 24,
      valueSize: 32
    })
  })

  it('uses itemGap only between items, not inside a cell', () => {
    const one = resolveKevinHudContentPadding(CONFIG)
    expect(one.horizontal).toBe(CONFIG.contentPadding)
    expect(KEVIN_HUD_DEFAULT_ITEM_GAP).toBe(CONFIG.itemGap)
  })
})

describe('KEVIN HUD minimum content height', () => {
  it('never returns less than the user height lower bound', () => {
    for (const height of [24, 48, 72, 120, 240]) {
      expect(measureKevinHudMinContentHeight({
        ...CONFIG,
        height,
        metrics: ['fps']
      })).toBeGreaterThanOrEqual(height)
    }
  })

  it('raises the height for a tall vertical descriptor/value pair', () => {
    const horizontal = measureKevinHudMinContentHeight({
      ...CONFIG,
      height: 24,
      metrics: ['fps'],
      contentPadding: 4
    })
    const vertical = measureKevinHudMinContentHeight({
      ...CONFIG,
      height: 24,
      metrics: ['fps'],
      contentPadding: 4,
      itemStyle: {
        ...CONFIG.itemStyle,
        orientation: 'vertical',
        descriptionSize: 24,
        valueSize: 32,
        gap: 24
      }
    })
    expect(vertical).toBeGreaterThan(horizontal)
    expect(vertical).toBeGreaterThan(24)
    expect(vertical).toBeLessThanOrEqual(240)
  })

  it('includes the merged app icon, title, inner gap and padding in app-name height', () => {
    const base = {
      ...CONFIG,
      height: 24,
      contentPadding: 4,
      metrics: ['appName'] as const
    }
    const horizontal = measureKevinHudMinContentHeight(base)
    const largeIcon = measureKevinHudMinContentHeight({
      ...base,
      itemStyle: { ...base.itemStyle, descriptionSize: 24 }
    })
    const vertical = measureKevinHudMinContentHeight({
      ...base,
      itemStyle: {
        ...base.itemStyle,
        orientation: 'vertical',
        gap: 24,
        valueSize: 32
      }
    })
    expect(horizontal).toBeGreaterThan(24)
    expect(largeIcon).toBeGreaterThan(horizontal)
    expect(vertical).toBeGreaterThan(horizontal)
    expect(vertical).toBeLessThanOrEqual(240)
  })

  it('settles the dedicated memory readout from its reference type without feedback', () => {
    const base = {
      ...CONFIG,
      height: 48,
      metrics: ['memory'] as const
    }
    expect(measureKevinHudMinContentHeight(base)).toBe(48)

    const large = {
      ...base,
      itemStyle: {
        ...base.itemStyle,
        valueSize: 32,
        descriptionSize: 24,
        gap: 12
      }
    }
    const horizontal = measureKevinHudMinContentHeight(large)
    const vertical = measureKevinHudMinContentHeight({
      ...large,
      itemStyle: { ...large.itemStyle, orientation: 'vertical' }
    })
    expect(horizontal).toBeGreaterThan(48)
    expect(vertical).toBeGreaterThan(horizontal)
    expect(vertical).toBeLessThanOrEqual(240)
    // Feeding the settled height back into the config must not inflate type
    // or height again: the font sizes come from the item sizes only.
    expect(measureKevinHudMinContentHeight({ ...large, height: horizontal })).toBe(
      horizontal
    )
    expect(measureKevinHudMinContentHeight({ ...large, height: vertical })).toBe(
      vertical
    )
  })

  it('raises one natural height for multiple extreme values and full padding', () => {
    const config = {
      ...CONFIG,
      height: 24,
      contentPadding: 32,
      verticalPadding: 32,
      borderWidth: 6,
      fontScale: 1.25,
      metrics: KEVIN_HUD_METRICS,
      itemStyle: {
        ...CONFIG.itemStyle,
        orientation: 'vertical' as const,
        description: 'text' as const,
        gap: 24,
        descriptionSize: 24,
        valueSize: 32,
        descriptionBold: true,
        valueBold: true
      }
    }
    const padding = resolveKevinHudContentPadding(config)
    expect(padding.vertical).toBe(32)
    const height = measureKevinHudMinContentHeight(config)
    expect(height).toBeGreaterThan(24)
    expect(height).toBeLessThanOrEqual(240)

    const style = getKevinHudItemStyle(config, 'download')
    const fullPaddingAndLines =
      style.valueSize * 1.25 * 1.22 +
      style.gap +
      style.descriptionSize * 1.25 * 1.22 +
      padding.vertical * 2 +
      6 * 2
    expect(height).toBeGreaterThanOrEqual(Math.ceil(fullPaddingAndLines))

    for (const metric of KEVIN_HUD_METRICS) {
      const width = measureKevinHudItemWidth(config, metric)
      expect(Number.isFinite(width)).toBe(true)
      expect(width).toBeGreaterThan(0)
    }
  })

  it('keeps every allowed scale, weight and padding inside the height range', () => {
    for (const fontScale of [0.8, 1, 1.25]) {
      for (const bold of [false, true]) {
        for (const contentPadding of [0, 32]) {
          for (const orientation of ['horizontal', 'vertical'] as const) {
            const config = {
              ...CONFIG,
              height: 24,
              fontScale,
              contentPadding,
              borderWidth: 6,
              metrics: ['sessionTime', 'download'] as const,
              itemStyle: {
                ...CONFIG.itemStyle,
                orientation,
                description: 'text' as const,
                gap: 24,
                descriptionSize: 24,
                valueSize: 32,
                descriptionBold: bold,
                valueBold: bold
              }
            }
            const height = measureKevinHudMinContentHeight(config)
            expect(Number.isInteger(height)).toBe(true)
            expect(height).toBeGreaterThanOrEqual(24)
            expect(height).toBeLessThanOrEqual(240)
            expect(height).toBeGreaterThan(24)
          }
        }
      }
    }
  })

  it('produces a stable layout signature across identical configs', () => {
    const first = kevinHudSizingKey(CONFIG)
    const second = kevinHudSizingKey(normalizeKevinHudConfig({ ...CONFIG }))
    const changed = kevinHudSizingKey({ ...CONFIG, itemGap: CONFIG.itemGap + 1 })
    expect(second).toBe(first)
    expect(changed).not.toBe(first)
  })
})
