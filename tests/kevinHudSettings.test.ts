import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_KEVIN_HUD,
  DEFAULT_KEVIN_HUD_ITEM_STYLE,
  KEVIN_HUD_METRICS
} from '../src/shared/kevinHud'
import {
  DEFAULT_KEVIN_HUD_GRADIENT,
  type KevinHudGradient
} from '../src/shared/kevinHudBackground'
import {
  measureKevinHudItemWidth,
  measureKevinHudMinContentHeight,
  resolveKevinHudWidthBounds
} from '../src/shared/kevinHudSizing'
import KevinHudSettings, {
  HUD_ITEM_GAP_MAX,
  HUD_ITEM_LAYOUT_DEFAULTS,
  HUD_ITEM_MIN_WIDTH_MAX,
  HUD_LIVE_SYNC_INTERVAL_MS,
  HUD_METRIC_INFO,
  HUD_REFERENCE_DESCRIPTION_COLOR,
  HUD_REFERENCE_VALUE_COLOR,
  HUD_WIDTH_MAX,
  buildHudCopySources,
  clampHudNumber,
  clearHudMetricItemStyle,
  clearHudMetricStyleField,
  cloneHudSettingsForCopy,
  getHudMetricStyleOverride,
  hasHudItemStyleField,
  hudColorTargetKey,
  hudColorTargetPanelId,
  normalizeHudForegroundOpacity,
  normalizeHudHotkey,
  normalizeHudSettings,
  planHudCopyApply,
  readHudItemLayout,
  reorderHudMetrics,
  resetHudConfig,
  resolveActiveColorField,
  resolveHudLiveDispatch,
  sameHudColorTarget,
  sanitizeHudItemStyles,
  sanitizeHudMetricStyleOverride,
  sanitizeHudMetrics,
  setHudMetricEnabled,
  type HudColorTarget
} from '../src/renderer/src/components/KevinHudSettings'

const CONFIG = normalizeHudSettings(DEFAULT_KEVIN_HUD)

const CUSTOM_GRADIENT: KevinHudGradient = {
  kind: 'radial',
  angle: 135,
  centerX: 25,
  centerY: 75,
  shape: 'circle',
  stops: [
    { color: '#112233', position: 0 },
    { color: '#445566', position: 100 }
  ]
}

describe('KEVIN HUD metric helpers', () => {
  it('offers the merged app identity once plus every other shared metric', () => {
    const shared = KEVIN_HUD_METRICS.filter((metric) => (metric as string) !== 'appIcon')
    expect(HUD_METRIC_INFO.map((metric) => metric.id)).toEqual(shared)
    expect(new Set(HUD_METRIC_INFO.map((metric) => metric.id)).size).toBe(shared.length)
    expect(HUD_METRIC_INFO.some((metric) => (metric.id as string) === 'appIcon')).toBe(false)

    const merged = HUD_METRIC_INFO.find((metric) => metric.id === 'appName')
    expect(merged?.label).toBe('应用图标与名称')
    expect(merged?.desc).toBe(
      '图标在说明位置，名称在数值位置；名称太长时会在 HUD 里滚动，不会被裁掉'
    )
    expect(merged?.reserve).toContain('真实应用图标')
    expect(merged?.reserve).toContain('实际应用名称')
  })

  it('drops unknown / duplicate ids and keeps the requested order', () => {
    expect(sanitizeHudMetrics(['fps', 'clock', 'fps', 'unknown', 'cpu'])).toEqual([
      'fps',
      'clock',
      'cpu'
    ])
  })

  it('maps either legacy identity id to one appName and preserves first position', () => {
    expect(sanitizeHudMetrics(['appIcon'])).toEqual(['appName'])
    expect(sanitizeHudMetrics(['appName'])).toEqual(['appName'])
    expect(sanitizeHudMetrics(['appIcon', 'appName'])).toEqual(['appName'])
    expect(sanitizeHudMetrics(['appName', 'appIcon'])).toEqual(['appName'])
    expect(sanitizeHudMetrics(['appIcon', 'fps', 'appName', 'clock', 'appIcon'])).toEqual([
      'appName',
      'fps',
      'clock'
    ])
    expect(sanitizeHudMetrics(['fps', 'appIcon', 'cpu', 'appName'])).toEqual([
      'fps',
      'appName',
      'cpu'
    ])
    // An explicit empty selection is not replaced by the default profile.
    expect(sanitizeHudMetrics([])).toEqual([])
    expect(
      normalizeHudSettings({ ...DEFAULT_KEVIN_HUD, metrics: [] }).metrics
    ).toEqual([])
    expect(normalizeHudSettings({}).metrics).toEqual(['fps', 'gpu', 'cpu'])
  })

  it('appends newly enabled metrics and removes disabled ones', () => {
    expect(setHudMetricEnabled(['fps'], 'cpu', true)).toEqual(['fps', 'cpu'])
    expect(setHudMetricEnabled(['fps', 'cpu'], 'fps', false)).toEqual(['cpu'])
    expect(setHudMetricEnabled([], 'clock', true)).toEqual(['clock'])
    expect(setHudMetricEnabled(['fps'], 'appName', true)).toEqual(['fps', 'appName'])
    expect(setHudMetricEnabled(['appIcon', 'fps'], 'appName', true)).toEqual([
      'appName',
      'fps'
    ])
    expect(setHudMetricEnabled(['appIcon', 'fps'], 'appName', false)).toEqual(['fps'])
  })

  it('re-applies a dragged order without losing unlisted or forged ids', () => {
    expect(reorderHudMetrics(['fps', 'cpu', 'clock'], ['clock', 'missing', 'fps'])).toEqual([
      'clock',
      'fps',
      'cpu'
    ])
    expect(reorderHudMetrics(['appIcon', 'fps', 'clock'], ['clock', 'appName'])).toEqual([
      'clock',
      'appName',
      'fps'
    ])
  })
})

describe('KEVIN HUD field helpers', () => {
  it('treats an empty / whitespace hotkey as unbound and trims a real one', () => {
    expect(normalizeHudHotkey('')).toBeNull()
    expect(normalizeHudHotkey('   ')).toBeNull()
    expect(normalizeHudHotkey(null)).toBeNull()
    expect(normalizeHudHotkey('  Ctrl+Shift+H  ')).toBe('Ctrl+Shift+H')
  })

  it('clamps numeric fields and keeps a fallback for non-finite input', () => {
    expect(clampHudNumber(50, 0, 100)).toBe(50)
    expect(clampHudNumber(-5, 0, 100)).toBe(0)
    expect(clampHudNumber(120, 0, 100)).toBe(100)
    expect(clampHudNumber(Number.NaN, 0, 100, 42)).toBe(42)
  })

  it('clamps foreground opacity without touching background opacity', () => {
    expect(normalizeHudForegroundOpacity(0.42)).toBe(0.42)
    expect(normalizeHudForegroundOpacity(-1)).toBe(0)
    expect(normalizeHudForegroundOpacity(2)).toBe(1)
    expect(normalizeHudForegroundOpacity(Number.NaN)).toBe(1)
  })

  it('resets to a deep copy of the normalized real-Genshin defaults', () => {
    const defaults = normalizeHudSettings(DEFAULT_KEVIN_HUD)
    const reset = resetHudConfig()

    expect(reset).toEqual(defaults)
    expect(reset).not.toBe(defaults)
    expect(reset.metrics).toEqual(['fps', 'gpu', 'cpu'])
    expect(reset.alwaysVisible).toBe(true)
    expect(reset.borderWidth).toBe(2)
    expect(reset.backgroundMode).toBe('gradient')
    expect(reset.itemStyle.description).toBe('text')
    expect(reset.itemStyle.descriptionSize).toBe(12)
    expect(reset.absorbLauncher).toBe(true)
    expect(reset.foregroundOpacity).toBe(1)
    expect(reset.gradient).toEqual(DEFAULT_KEVIN_HUD_GRADIENT)
    expect(reset.itemStyle.descriptionColor).toBeNull()
    expect(reset.itemStyle.valueColor).toBeNull()
    expect(reset.itemStyles).toEqual({})

    // Every mutable nested value is copied, not shared with the defaults.
    expect(reset.metrics).not.toBe(DEFAULT_KEVIN_HUD.metrics)
    expect(reset.metrics).not.toBe(defaults.metrics)
    expect(reset.gradient).not.toBe(DEFAULT_KEVIN_HUD.gradient)
    expect(reset.gradient).not.toBe(defaults.gradient)
    expect(reset.gradient.stops).not.toBe(defaults.gradient.stops)
    expect(reset.gradient.stops[0]).not.toBe(defaults.gradient.stops[0])
    expect(reset.itemStyle).not.toBe(DEFAULT_KEVIN_HUD_ITEM_STYLE)
    expect(reset.itemStyle).not.toBe(defaults.itemStyle)
    expect(reset.itemStyles).not.toBe(defaults.itemStyles)

    reset.metrics.reverse()
    reset.gradient.stops[0].color = '#000000'
    reset.itemStyle.descriptionSize = 10
    expect(defaults.metrics).toEqual(['fps', 'gpu', 'cpu'])
    expect(defaults.gradient.stops[0].color)
      .toBe(DEFAULT_KEVIN_HUD_GRADIENT.stops[0].color)
    expect(defaults.itemStyle.descriptionSize).toBe(12)
    expect(DEFAULT_KEVIN_HUD.metrics[0]).toBe('fps')
  })

  it('hides a colour panel as soon as its row becomes inapplicable', () => {
    const editable = {
      backgroundIsApp: false,
      backgroundIsGradient: false,
      textIsAuto: false,
      iconIsOriginal: false
    }
    expect(resolveActiveColorField('border', editable)).toBe('border')
    expect(resolveActiveColorField('background', editable)).toBe('background')
    expect(resolveActiveColorField('background', { ...editable, backgroundIsApp: true })).toBeNull()
    expect(resolveActiveColorField('background', { ...editable, backgroundIsGradient: true }))
      .toBeNull()
    expect(resolveActiveColorField('text', { ...editable, textIsAuto: true })).toBeNull()
    expect(resolveActiveColorField('icon', { ...editable, iconIsOriginal: true })).toBeNull()
    expect(resolveActiveColorField(null, editable)).toBeNull()
  })

  it('builds one unique colour target and panel id for every field and item', () => {
    const targets: HudColorTarget[] = [
      { kind: 'config', field: 'border' },
      { kind: 'config', field: 'background' },
      { kind: 'config', field: 'text' },
      { kind: 'config', field: 'icon' },
      { kind: 'defaultStyle', field: 'descriptionColor' },
      { kind: 'defaultStyle', field: 'valueColor' },
      ...(['fps', 'memory'] as const).flatMap((metric): HudColorTarget[] => [
        { kind: 'metricStyle', metric, field: 'descriptionColor' },
        { kind: 'metricStyle', metric, field: 'valueColor' }
      ])
    ]
    const keys = targets.map(hudColorTargetKey)
    const ids = targets.map(hudColorTargetPanelId)
    expect(new Set(keys).size).toBe(targets.length)
    expect(new Set(ids).size).toBe(targets.length)
    expect(hudColorTargetKey(targets[0])).toBe('config-border')
    expect(sameHudColorTarget(targets[0], targets[0])).toBe(true)
    expect(sameHudColorTarget(targets[0], targets[1])).toBe(false)
    expect(sameHudColorTarget(null, null)).toBe(false)
  })
})

describe('KEVIN HUD new shared settings', () => {
  it('defaults and normalizes launcher absorption, both opacities, gradient and colours', () => {
    const defaults = normalizeHudSettings({})
    // A new app inherits the untouched real-Genshin monitoring profile.
    expect(defaults.alwaysVisible).toBe(true)
    expect(defaults.borderWidth).toBe(2)
    expect(defaults.backgroundMode).toBe('gradient')
    expect(defaults.itemStyle.description).toBe('text')
    expect(defaults.itemStyle.descriptionSize).toBe(12)
    expect(defaults.metrics).toEqual(['fps', 'gpu', 'cpu'])
    expect(defaults.absorbLauncher).toBe(true)
    expect(defaults.foregroundOpacity).toBe(1)
    expect(defaults.backgroundOpacity).toBe(1)
    expect(defaults.gradient).toEqual(DEFAULT_KEVIN_HUD_GRADIENT)
    expect(defaults.itemStyle.descriptionColor).toBeNull()
    expect(defaults.itemStyle.valueColor).toBeNull()
    expect(defaults.itemStyle.valueSize).toBe(14)
    expect(defaults.itemStyle.minWidth).toBe(0)
    expect(defaults.itemStyle.gap).toBe(DEFAULT_KEVIN_HUD_ITEM_STYLE.gap)
    expect(defaults.itemStyle.descriptionAlign).toBe('left')
    expect(defaults.itemStyle.valueAlign).toBe('right')

    const custom = normalizeHudSettings({
      absorbLauncher: false,
      backgroundMode: 'gradient',
      gradient: CUSTOM_GRADIENT,
      foregroundOpacity: 0.35,
      backgroundOpacity: 0.65,
      itemStyle: {
        ...DEFAULT_KEVIN_HUD_ITEM_STYLE,
        descriptionColor: '#aabbcc',
        valueColor: '#112233'
      }
    })
    expect(custom.absorbLauncher).toBe(false)
    expect(custom.backgroundMode).toBe('gradient')
    expect(custom.gradient).toEqual(CUSTOM_GRADIENT)
    expect(custom.foregroundOpacity).toBe(0.35)
    expect(custom.backgroundOpacity).toBe(0.65)
    expect(custom.itemStyle.descriptionColor).toBe('#aabbcc')
    expect(custom.itemStyle.valueColor).toBe('#112233')
  })

  it('keeps the public layout/colour overrides and ignores beta typography fields', () => {
    const config = normalizeHudSettings({
      ...DEFAULT_KEVIN_HUD,
      itemStyle: { ...DEFAULT_KEVIN_HUD_ITEM_STYLE, valueSize: 15 },
      itemStyles: {
        fps: {
          minWidth: 140,
          gap: 7,
          descriptionAlign: 'center',
          valueAlign: 'left',
          descriptionColor: '#112233',
          valueColor: '#445566'
        },
        cpu: {
          orientation: 'vertical',
          descriptionSize: 20,
          valueSize: 30,
          descriptionBold: false,
          valueBold: false,
          minWidth: 80,
          gap: 3,
          descriptionAlign: 'right',
          valueAlign: 'center'
        },
        appName: {
          orientation: 'vertical',
          valueSize: 30
        }
      }
    })

    expect(config.itemStyles.fps).toEqual({
      minWidth: 140,
      gap: 7,
      descriptionAlign: 'center',
      valueAlign: 'left',
      descriptionColor: '#112233',
      valueColor: '#445566'
    })
    // Legacy typography fields are dropped, but every legal layout field stays.
    expect(config.itemStyles.cpu).toEqual({
      minWidth: 80,
      gap: 3,
      descriptionAlign: 'right',
      valueAlign: 'center'
    })
    expect(config.itemStyles.appName).toBeUndefined()
    expect(getHudMetricStyleOverride(config.itemStyles, 'fps')).toEqual({
      minWidth: 140,
      gap: 7,
      descriptionAlign: 'center',
      valueAlign: 'left',
      descriptionColor: '#112233',
      valueColor: '#445566'
    })
    expect(getHudMetricStyleOverride(config.itemStyles, 'cpu')).toEqual({
      minWidth: 80,
      gap: 3,
      descriptionAlign: 'right',
      valueAlign: 'center'
    })
  })

  it('sanitizes old per-item data without sharing or mutating the source', () => {
    const raw = {
      fps: {
        minWidth: 140,
        gap: 6,
        descriptionAlign: 'center',
        valueAlign: 'left',
        descriptionColor: '#ABCDEF',
        valueColor: null,
        orientation: 'vertical',
        valueSize: 20
      },
      cpu: { orientation: 'vertical', descriptionBold: false }
    }
    const sanitized = sanitizeHudItemStyles(raw)
    expect(sanitized).toEqual({
      fps: {
        minWidth: 140,
        gap: 6,
        descriptionAlign: 'center',
        valueAlign: 'left',
        descriptionColor: '#ABCDEF'
      }
    })
    expect(raw.fps.orientation).toBe('vertical')
    expect(sanitizeHudMetricStyleOverride({ valueColor: null, valueSize: 20 })).toEqual({})
    expect(sanitizeHudMetricStyleOverride({ gap: 999 })).toEqual({ gap: 24 })
    expect(sanitizeHudMetricStyleOverride({ minWidth: 9999 })).toEqual({
      minWidth: HUD_ITEM_MIN_WIDTH_MAX
    })
    expect(
      sanitizeHudMetricStyleOverride({
        descriptionAlign: 'center',
        valueAlign: 'middle'
      })
    ).toEqual({ descriptionAlign: 'center' })
    expect(
      sanitizeHudMetricStyleOverride(
        { minWidth: 0, descriptionAlign: 'center' },
        { minWidth: 100, gap: 4, valueAlign: 'left' }
      )
    ).toEqual({
      minWidth: 0,
      gap: 4,
      descriptionAlign: 'center',
      valueAlign: 'left'
    })
    expect(sanitizeHudMetricStyleOverride({ descriptionColor: 'not-a-colour' })).toEqual({})
  })

  it('clears one legal per-item field and drops an empty metric entry', () => {
    const styles = {
      fps: { minWidth: 120, gap: 6, valueColor: '#111111' },
      cpu: { gap: 3 }
    }
    const next = clearHudMetricStyleField(styles, 'fps', 'valueColor')
    expect(next).toEqual({ fps: { minWidth: 120, gap: 6 }, cpu: { gap: 3 } })
    expect(styles.fps.valueColor).toBe('#111111')
    expect(clearHudMetricStyleField(next, 'fps', 'minWidth')).toEqual({
      fps: { gap: 6 },
      cpu: { gap: 3 }
    })
    expect(clearHudMetricStyleField(next, 'fps', 'gap')).toEqual({
      fps: { minWidth: 120 },
      cpu: { gap: 3 }
    })
    expect(clearHudMetricItemStyle(styles, 'cpu')).toEqual({
      fps: { minWidth: 120, gap: 6, valueColor: '#111111' }
    })
  })
})

describe('KEVIN HUD item layout helpers', () => {
  it('reads the four layout fields with the shared defaults and bounds', () => {
    expect(readHudItemLayout({})).toEqual(HUD_ITEM_LAYOUT_DEFAULTS)
    expect(
      readHudItemLayout({
        minWidth: 240,
        gap: 9,
        descriptionAlign: 'center',
        valueAlign: 'right'
      })
    ).toEqual({
      minWidth: 240,
      gap: 9,
      descriptionAlign: 'center',
      valueAlign: 'right'
    })
    expect(
      readHudItemLayout({
        minWidth: -1,
        gap: 99,
        descriptionAlign: 'center',
        valueAlign: 'middle'
      })
    ).toEqual({
      minWidth: 0,
      gap: 24,
      descriptionAlign: 'center',
      valueAlign: 'right'
    })
    expect(readHudItemLayout({ minWidth: 9999 }).minWidth).toBe(HUD_ITEM_MIN_WIDTH_MAX)
    expect(readHudItemLayout({ descriptionAlign: 'right' }).descriptionAlign).toBe('right')
  })

  it('only treats saved layout fields with a legal value as overrides', () => {
    expect(hasHudItemStyleField({ minWidth: 0 }, 'minWidth')).toBe(true)
    expect(hasHudItemStyleField({ gap: 24 }, 'gap')).toBe(true)
    expect(hasHudItemStyleField({ descriptionAlign: 'center' }, 'descriptionAlign')).toBe(true)
    expect(hasHudItemStyleField({ valueAlign: 'left' }, 'valueAlign')).toBe(true)
    expect(hasHudItemStyleField({ valueAlign: 'middle' }, 'valueAlign')).toBe(false)
    expect(hasHudItemStyleField({ minWidth: 'wide' }, 'minWidth')).toBe(false)
    expect(hasHudItemStyleField({}, 'gap')).toBe(false)
    expect(hasHudItemStyleField(null, 'gap')).toBe(false)
  })
})

describe('KEVIN HUD live sync scheduling', () => {
  it('coalesces within the requested 16–50 ms window', () => {
    expect(HUD_LIVE_SYNC_INTERVAL_MS).toBeGreaterThanOrEqual(16)
    expect(HUD_LIVE_SYNC_INTERVAL_MS).toBeLessThanOrEqual(50)
  })

  it('skips without a bound surface, waits while busy and de-duplicates applied values', () => {
    expect(
      resolveHudLiveDispatch({
        previewActive: false,
        inFlight: false,
        signature: 'latest',
        appliedSignature: ''
      })
    ).toBe('skip')
    expect(
      resolveHudLiveDispatch({
        previewActive: true,
        inFlight: true,
        signature: 'latest',
        appliedSignature: 'older'
      })
    ).toBe('wait')
    expect(
      resolveHudLiveDispatch({
        previewActive: true,
        inFlight: false,
        signature: 'same',
        appliedSignature: 'same'
      })
    ).toBe('skip')
    expect(
      resolveHudLiveDispatch({
        previewActive: true,
        inFlight: false,
        signature: 'latest',
        appliedSignature: 'older'
      })
    ).toBe('send')
    // A formal live callback may amend an already bound real HUD without an
    // open settings preview; the legacy fallback may not.
    expect(
      resolveHudLiveDispatch({
        previewActive: false,
        liveActive: true,
        inFlight: false,
        signature: 'latest',
        appliedSignature: 'older'
      })
    ).toBe('send')
    expect(
      resolveHudLiveDispatch({
        previewActive: false,
        liveActive: true,
        inFlight: true,
        signature: 'latest',
        appliedSignature: 'older'
      })
    ).toBe('wait')
  })
})

describe('KEVIN HUD copy helpers', () => {
  const sourceHud = normalizeHudSettings({
    ...DEFAULT_KEVIN_HUD,
    absorbLauncher: false,
    backgroundMode: 'gradient',
    gradient: CUSTOM_GRADIENT,
    foregroundOpacity: 0.4,
    backgroundOpacity: 0.6,
    itemStyle: {
      ...DEFAULT_KEVIN_HUD_ITEM_STYLE,
      minWidth: 180,
      gap: 6,
      descriptionAlign: 'center',
      valueAlign: 'left',
      descriptionColor: '#112233',
      valueColor: '#445566'
    },
    itemStyles: {
      fps: {
        minWidth: 160,
        gap: 7,
        descriptionAlign: 'right',
        valueAlign: 'center',
        descriptionColor: '#778899',
        valueColor: '#AABBCC',
        orientation: 'vertical',
        valueSize: 30
      }
    },
    metrics: ['fps', 'memory']
  })

  it('lists only other valid apps and normalizes each candidate', () => {
    const sources = buildHudCopySources(
      [
        { id: 'app-1', name: '当前应用', kevinHud: CONFIG },
        { id: 'app-2', name: '  源应用  ', kevinHud: sourceHud },
        { id: 'app-2', name: '重复应用', kevinHud: CONFIG },
        { id: 'app-3', name: '默认应用', kevinHud: undefined },
        { id: '', name: '坏数据', kevinHud: CONFIG }
      ],
      'app-1'
    )

    expect(sources.map((source) => source.name)).toEqual(['源应用', '默认应用'])
    expect(sources.map((source) => source.id)).toEqual(['app-2', 'app-3'])
    expect(sources[0].config.absorbLauncher).toBe(false)
    expect(sources[0].config.backgroundMode).toBe('gradient')
    expect(sources[0].config.gradient).toEqual(CUSTOM_GRADIENT)
    expect(sources[0].config.foregroundOpacity).toBe(0.4)
    expect(sources[0].config.backgroundOpacity).toBe(0.6)
    expect(sources[0].config.itemStyles.fps).toEqual({
      minWidth: 160,
      gap: 7,
      descriptionAlign: 'right',
      valueAlign: 'center',
      descriptionColor: '#778899',
      valueColor: '#AABBCC'
    })
    expect(sources[0].config.itemStyle.minWidth).toBe(180)
    expect(sources[0].config.itemStyle.descriptionAlign).toBe('center')
    expect(sources[0].config.itemStyles).not.toBe(sourceHud.itemStyles)
    expect(sources[1].config).toEqual(normalizeHudSettings(DEFAULT_KEVIN_HUD))
  })

  it('returns no candidates when no other app has data', () => {
    expect(buildHudCopySources([], 'app-1')).toEqual([])
    expect(buildHudCopySources([{ id: 'app-1', name: '当前', kevinHud: CONFIG }], 'app-1')).toEqual(
      []
    )
  })

  it('clones nested settings into an independent normalized object', () => {
    const copy = cloneHudSettingsForCopy(sourceHud)
    expect(copy).toEqual(sourceHud)
    expect(copy).not.toBe(sourceHud)
    expect(copy.metrics).not.toBe(sourceHud.metrics)
    expect(copy.gradient).not.toBe(sourceHud.gradient)
    expect(copy.gradient.stops).not.toBe(sourceHud.gradient.stops)
    expect(copy.itemStyle).not.toBe(sourceHud.itemStyle)
    expect(copy.itemStyles).not.toBe(sourceHud.itemStyles)
    expect(copy.itemStyles.fps).not.toBe(sourceHud.itemStyles.fps)

    copy.metrics.push('clock')
    copy.gradient.stops[0].color = '#000000'
    copy.foregroundOpacity = 0.1
    copy.backgroundOpacity = 0.2
    copy.itemStyles.fps!.gap = 9
    copy.itemStyles.fps!.minWidth = 220
    copy.itemStyle.valueColor = '#000000'
    copy.itemStyle.descriptionAlign = 'left'
    expect(sourceHud.metrics).toEqual(['fps', 'memory'])
    expect(sourceHud.gradient).toEqual(CUSTOM_GRADIENT)
    expect(sourceHud.foregroundOpacity).toBe(0.4)
    expect(sourceHud.backgroundOpacity).toBe(0.6)
    expect(sourceHud.itemStyles.fps?.gap).toBe(7)
    expect(sourceHud.itemStyles.fps?.minWidth).toBe(160)
    expect(sourceHud.itemStyle.valueColor).toBe('#445566')
    expect(sourceHud.itemStyle.descriptionAlign).toBe('center')
    // Nested, not flattened: the copied override still lives under itemStyles.
    expect(copy.itemStyles.fps?.valueColor).toBe('#AABBCC')
  })

  it('plans a newer immediate save so an older debounce cannot win', () => {
    const plan = planHudCopyApply(sourceHud, 7)
    expect(plan.immediate).toBe(true)
    expect(plan.revision).toBe(8)
    expect(plan.revision).toBeGreaterThan(7)
    expect(plan.config).toEqual(sourceHud)
    expect(plan.config).not.toBe(sourceHud)
    expect(plan.config.gradient).not.toBe(sourceHud.gradient)
    expect(plan.config.itemStyles).not.toBe(sourceHud.itemStyles)
    expect(plan.config.foregroundOpacity).toBe(0.4)
    expect(plan.config.backgroundOpacity).toBe(0.6)
  })
})

describe('KEVIN HUD sizing and item-style fallbacks', () => {
  const base = CONFIG

  it('preserves a legacy fixed width as both bounds and keeps grow width broad', () => {
    const fixed = normalizeHudSettings({
      ...DEFAULT_KEVIN_HUD,
      width: 520,
      autoWidth: false,
      maxWidth: undefined
    })
    expect(resolveKevinHudWidthBounds(fixed)).toEqual({
      minWidth: 520,
      maxWidth: 520,
      auto: false
    })

    const grow = normalizeHudSettings({
      ...DEFAULT_KEVIN_HUD,
      maxWidth: undefined,
      autoWidth: true
    })
    expect(resolveKevinHudWidthBounds(grow)).toEqual({
      minWidth: DEFAULT_KEVIN_HUD.width,
      maxWidth: HUD_WIDTH_MAX,
      auto: true
    })
  })

  it('uses the shared minimum height, item width and gap contracts', () => {
    expect(measureKevinHudMinContentHeight(base)).toBeGreaterThanOrEqual(base.height)
    const tall = normalizeHudSettings({
      ...DEFAULT_KEVIN_HUD,
      height: 48,
      metrics: ['memory'],
      itemStyle: {
        ...DEFAULT_KEVIN_HUD_ITEM_STYLE,
        orientation: 'vertical',
        valueSize: 20,
        descriptionSize: 20
      }
    })
    expect(measureKevinHudMinContentHeight(tall)).toBeGreaterThan(48)
    expect(measureKevinHudItemWidth(base, 'memory')).toBeGreaterThan(0)
    expect(HUD_ITEM_GAP_MAX).toBe(48)
  })

  it('keeps the reset result complete and equal to the shared defaults', () => {
    const reset = resetHudConfig()
    expect(reset).toEqual(normalizeHudSettings(DEFAULT_KEVIN_HUD))
    expect(reset.itemStyle).toEqual(DEFAULT_KEVIN_HUD_ITEM_STYLE)
    expect(readHudItemLayout(reset.itemStyle)).toEqual(HUD_ITEM_LAYOUT_DEFAULTS)
    expect(reset.itemStyles).toEqual({})
    expect(reset.itemGap).toBe(DEFAULT_KEVIN_HUD.itemGap)
    expect(reset.contentPadding).toBe(DEFAULT_KEVIN_HUD.contentPadding)
    expect(reset.alwaysVisible).toBe(true)
    expect(reset.borderWidth).toBe(2)
    expect(reset.backgroundMode).toBe('gradient')
    expect(reset.itemStyle.description).toBe('text')
    expect(reset.itemStyle.descriptionSize).toBe(12)
    expect(reset.metrics).toEqual(['fps', 'gpu', 'cpu'])
  })
})

function renderSettings(patch: object = {}): string {
  const config = normalizeHudSettings({ ...DEFAULT_KEVIN_HUD, ...patch })
  return renderToStaticMarkup(
    createElement(KevinHudSettings, {
      appId: 'app-1',
      appName: '测试应用',
      config,
      onSave: vi.fn(async () => undefined),
      onPreview: vi.fn(async () => undefined),
      onDismissPreview: vi.fn(async () => undefined)
    })
  )
}

function inputTag(html: string, label: string): string {
  return html.match(new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? ''
}

function rangeMax(html: string, label: string): number {
  return Number(inputTag(html, label).match(/\bmax="([^"]+)"/)?.[1])
}

function rangeValue(html: string, label: string): string {
  return inputTag(html, label).match(/\bvalue="([^"]+)"/)?.[1] ?? ''
}

function switchWindow(html: string, title: string): string {
  const titleAt = html.indexOf(`title="${title}"`)
  if (titleAt < 0) return ''
  const start = html.lastIndexOf('<span', titleAt)
  return html.slice(start, titleAt + 420)
}

function metricStyleSection(html: string, metric: string): string {
  const marker = `data-metric-style="${metric}"`
  const start = html.indexOf(marker)
  if (start < 0) return ''
  const next = html.indexOf('data-metric-style="', start + marker.length)
  return html.slice(start, next < 0 ? html.length : next)
}

function defaultStyleSection(html: string): string {
  const start = html.indexOf('id="kevin-hud-style-default"')
  if (start < 0) return ''
  const next = html.indexOf('data-metric-style="', start)
  return html.slice(start, next < 0 ? html.length : next)
}

function styleFieldRow(html: string, label: string): string {
  const marker = `<span class="kh-style-field-label">${label}</span>`
  const at = html.indexOf(marker)
  if (at < 0) return ''
  const start = html.lastIndexOf('<div class="kh-style-field-row"', at)
  const next = html.indexOf('<div class="kh-style-field-row"', at + marker.length)
  return html.slice(start, next < 0 ? html.length : next)
}

function colorTrigger(html: string, label: string): string {
  return html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? ''
}

function settingsRow(html: string, name: string): string {
  const marker = `<div class="settings-name">${name}</div>`
  const nameAt = html.indexOf(marker)
  if (nameAt < 0) return ''
  const start = html.lastIndexOf('<div class="settings-row"', nameAt)
  const next = html.indexOf('<div class="settings-row"', nameAt + marker.length)
  return html.slice(start, next < 0 ? html.length : next)
}

function firstCombobox(html: string): string {
  return html.match(/<button[^>]*role="combobox"[^>]*>/)?.[0] ?? ''
}

function segmentedActive(html: string, value: string): boolean {
  const tag = html.match(new RegExp(`<button[^>]*data-seg="${value}"[^>]*>`))?.[0] ?? ''
  return tag.includes('data-active="true"')
}

describe('KEVIN HUD settings form', () => {
  it('renders the refreshed header hierarchy and replaces the old per-app pill', () => {
    const html = renderSettings()

    expect(html).toMatch(/class="kh-head"[^>]*data-kh-anim="off"/)
    expect(html).toContain('<span class="kh-mark-text">HUD</span>')
    expect(html).toContain('<span class="kh-wordmark">KEVIN HUD</span>')
    expect(html).toContain('测试应用 · 在游戏里随时查看帧率、内存和运行状态')
    expect(html).toContain('<span class="kh-fresh">全新功能</span>')
    expect(html).not.toContain('按应用独立')
    expect(html.match(/全新功能/g)).toHaveLength(1)

    const titleAt = html.indexOf('class="kh-head-title"')
    const titleEndAt = html.indexOf('</div>', titleAt)
    const markAt = html.indexOf('class="kh-mark"')
    const wordAt = html.indexOf('class="kh-wordmark"')
    const subAt = html.indexOf('class="kh-head-sub"')
    const freshAt = html.indexOf('class="kh-fresh"')
    const rightAt = html.indexOf('class="kh-head-right"')
    const actionsAt = html.indexOf('kh-head-actions')
    expect(markAt).toBeGreaterThanOrEqual(0)
    expect(wordAt).toBeGreaterThan(markAt)
    expect(titleAt).toBeGreaterThanOrEqual(0)
    expect(freshAt).toBeGreaterThan(titleAt)
    expect(freshAt).toBeLessThan(titleEndAt)
    expect(subAt).toBeGreaterThan(freshAt)
    expect(rightAt).toBeGreaterThan(subAt)
    expect(actionsAt).toBeGreaterThan(rightAt)
    expect(html.slice(rightAt, actionsAt)).not.toContain('kh-fresh')

    // The capsule is the next DOM node after the wordmark, not beside the switch.
    const wordCloseAt = html.indexOf('</span>', wordAt)
    const freshOpenAt = html.lastIndexOf('<span', freshAt)
    expect(wordCloseAt).toBeGreaterThan(wordAt)
    expect(freshOpenAt).toBeGreaterThan(wordCloseAt)
    expect(html.slice(wordCloseAt + '</span>'.length, freshOpenAt).trim()).toBe('')
  })

  it('renders every configuration area and metric label without a home-card entry', () => {
    // The new default uses a gradient; pin solid so this exhaustive area list
    // also covers the solid-only background colour row.
    const html = renderSettings({ backgroundMode: 'solid' })

    for (const label of [
      '启用',
      '全新功能',
      '常驻显示',
      '短时显示时长',
      '刷新间隔',
      '进出场方向',
      '位置',
      '顶部居中',
      '手动位置',
      '显示器',
      '内容放不下时',
      '加宽 HUD',
      '横向滚动',
      '尺寸',
      '回弹幅度',
      '波纹强度',
      '背景模式',
      '纯色',
      '渐变色',
      '材质',
      '圆角',
      '边框宽度',
      '边框颜色',
      '背景颜色',
      '背景不透明度',
      '文字、图标和边框不透明度',
      '文字颜色',
      '字体缩放',
      '图标颜色',
      '文字偏移',
      '图标偏移',
      '吸入启动器',
      '退出后恢复启动器',
      '全局快捷键',
      '统一指标样式',
      '复制其他应用的 HUD 设置',
      '预览 HUD',
      '重置为默认'
    ]) {
      expect(html).toContain(label)
    }
    for (const metric of HUD_METRIC_INFO) expect(html).toContain(metric.label)

    expect(html).not.toContain('采样间隔')
    expect(html).not.toContain('按应用独立')
    expect(html).not.toContain('游戏内悬浮信息层')
    expect(html).toContain('游戏打开后，HUD 会浮在游戏画面上，显示你勾选的信息。')
    expect(html).toContain(
      '如果看不到，请把游戏切换为窗口化或无边框；独占全屏能否显示由游戏决定。读不到的项目会显示「--」，也可以按快捷键隐藏或显示。'
    )
  })

  it('keeps the outer switch row in the shared collapse header and the notice inside', () => {
    const html = renderSettings()
    const headAt = html.indexOf('<div class="kh-head"')
    const ownerAt = html.lastIndexOf('<div class="collapse-head"', headAt)
    const revealAt = html.indexOf('class="collapse-reveal"', headAt)

    expect(headAt).toBeGreaterThanOrEqual(0)
    expect(ownerAt).toBeGreaterThanOrEqual(0)
    expect(revealAt).toBeGreaterThan(headAt)
    expect(html.indexOf('<div class="kh-notice"')).toBeGreaterThan(revealAt)
    expect(html.indexOf('id="kevin-hud-settings-form"')).toBeGreaterThan(revealAt)
    expect(html.match(/class="kh-head"/g)).toHaveLength(1)
  })

  it('keeps the absorbed-launcher dependency visible on the restore switch', () => {
    const visible = renderSettings()
    expect(switchWindow(visible, '吸入启动器')).toContain('aria-checked="true"')
    expect(switchWindow(visible, '退出后恢复启动器')).not.toContain('aria-disabled="true"')
    expect(visible).toContain('HUD 关闭或游戏退出后，把收起的启动器窗口找回来')

    const absorbedOff = renderSettings({ absorbLauncher: false })
    expect(switchWindow(absorbedOff, '吸入启动器')).toContain('aria-checked="false"')
    expect(switchWindow(absorbedOff, '退出后恢复启动器')).toContain('aria-disabled="true"')
    expect(absorbedOff).toContain(
      '已关闭「吸入启动器」，启动器会留在窗口，无需恢复'
    )
    expect(absorbedOff).toContain('启动应用后保留启动器窗口，不收起')
  })

  it('keeps background and foreground opacity independent in every background mode', () => {
    const html = renderSettings({ backgroundOpacity: 0.35, foregroundOpacity: 0.8 })
    expect(rangeValue(html, '背景不透明度')).toBe('0.35')
    expect(rangeValue(html, '文字、图标和边框不透明度')).toBe('0.8')
    expect(rangeMax(html, '背景不透明度')).toBe(1)
    expect(rangeMax(html, '文字、图标和边框不透明度')).toBe(1)
    expect(html).toContain('0% 完全透明，100% 为实色；只影响背景，文字、图标和边框不变。')
    expect(html).toContain('0% 完全透明，100% 为实色；只影响文字、图标和边框，背景不变。')
    expect(html).not.toContain('底色不透明度')
    expect(html).not.toContain('HUD 整体不透明度')
    expect(html).not.toContain('aria-label="整体不透明度"')

    for (const backgroundMode of ['solid', 'gradient', 'app', 'custom'] as const) {
      const mode = renderSettings({
        backgroundMode,
        backgroundOpacity: 0.35,
        foregroundOpacity: 0.8
      })
      expect(inputTag(mode, '背景不透明度')).not.toContain('disabled')
      expect(inputTag(mode, '文字、图标和边框不透明度')).not.toContain('disabled')
      expect(rangeValue(mode, '背景不透明度')).toBe('0.35')
      expect(rangeValue(mode, '文字、图标和边框不透明度')).toBe('0.8')
    }
  })

  it('offers solid colour and gradient as the two inline background choices', () => {
    const solid = renderSettings({ backgroundMode: 'solid' })
    expect(segmentedActive(solid, 'solid')).toBe(true)
    expect(segmentedActive(solid, 'gradient')).toBe(false)
    expect(colorTrigger(solid, '选择背景颜色')).not.toBe('')
    expect(solid).not.toContain('data-kevin-hud-gradient')
    expect(settingsRow(solid, '材质')).toContain('纯色背景不叠加材质')
    expect(firstCombobox(settingsRow(solid, '材质'))).toContain('disabled')

    const gradient = renderSettings({ backgroundMode: 'gradient' })
    expect(segmentedActive(gradient, 'gradient')).toBe(true)
    expect(gradient).toContain('data-kevin-hud-gradient="true"')
    expect(gradient).toContain('aria-label="KEVIN HUD 渐变背景"')
    expect(gradient).toContain('渐变预览')
    expect(gradient).toContain('渐变方式')
    expect(segmentedActive(gradient, 'linear')).toBe(true)
    expect(gradient).toContain('2 个色标')
    expect(colorTrigger(gradient, '选择背景颜色')).toBe('')
    expect(gradient).not.toContain('id="kevin-hud-background-color-editor"')
    expect(gradient.indexOf('data-kevin-hud-gradient')).toBeLessThan(
      gradient.indexOf('aria-label="背景不透明度"')
    )
    expect(settingsRow(gradient, '材质')).toContain('渐变色背景不叠加材质')
    expect(firstCombobox(settingsRow(gradient, '材质'))).toContain('disabled')

    const custom = renderSettings({ backgroundMode: 'custom' })
    const customMode = settingsRow(custom, '背景模式')
    // "custom" is also a position option; scope the lookup to the background row.
    expect(segmentedActive(customMode, 'custom')).toBe(true)
    expect(firstCombobox(settingsRow(custom, '材质'))).not.toContain('disabled')
    expect(settingsRow(custom, '材质')).toContain('给自定义背景叠一层玻璃质感')
  })

  it('renders the saved gradient in the standalone editor without opening a picker', () => {
    const html = renderSettings({ backgroundMode: 'gradient', gradient: CUSTOM_GRADIENT })
    expect(html).toContain('放射')
    expect(html).toContain('中心 25% / 75%')
    expect(html).toContain('色标 1')
    expect(html).toContain('色标 2')
    expect(html).toContain('#112233')
    expect(html).toContain('#445566')
    expect(html.match(/aria-label="色标 1 位置"/g)).toHaveLength(1)
    expect(html.match(/aria-label="色标 2 位置"/g)).toHaveLength(1)
    expect(html).not.toContain('class="color-editor"')
  })

  it('matches the shared numeric bounds and makes the radius ceiling explicit', () => {
    const html = renderSettings()

    expect(rangeMax(html, '回弹幅度')).toBe(0.5)
    expect(rangeMax(html, '波纹强度')).toBe(2)
    expect(rangeMax(html, '边框宽度')).toBe(6)
    expect(rangeMax(html, '圆角')).toBe(24)
    expect(html).toContain('0 为直角；当前高度的一半（24 px）为全胶囊')
  })

  it('defaults to the preset and only reveals percentage controls for manual placement', () => {
    const preset = renderSettings()
    expect(preset).toContain('屏幕顶部居中，默认留出一小段距离')
    expect(preset).not.toContain('>屏幕锚点<')
    expect(preset).not.toContain('aria-label="水平位置"')

    const manual = renderSettings({ positionMode: 'custom' })
    expect(manual).toContain('>屏幕锚点<')
    expect(manual).toContain('aria-label="水平位置"')
    expect(manual).toContain('aria-label="垂直位置"')
  })

  it('shows the overflow choice on the old flag and explains the single-row sizing', () => {
    const fixed = renderSettings()
    expect(fixed).toContain('内容放不下时')
    expect(fixed).toContain('加宽 HUD')
    expect(fixed).toContain('横向滚动')
    expect(segmentedActive(fixed, 'grow')).toBe(false)
    expect(segmentedActive(fixed, 'scroll')).toBe(true)
    expect(fixed).toContain(
      '信息保持一行；宽度固定，放不下时在 HUD 里横向滚动'
    )
    expect(fixed).toContain('开场标题始终显示应用图标和名称')

    const grow = renderSettings({ autoWidth: true, width: 520, maxWidth: 900 })
    expect(segmentedActive(grow, 'grow')).toBe(true)
    expect(segmentedActive(grow, 'scroll')).toBe(false)
    expect(grow).toContain(
      '信息保持一行；放不下时自动加宽，到了最大宽度再在 HUD 里横向滚动'
    )
  })

  it('keeps the grow width as an editable minimum and the scroll width fixed', () => {
    const html = renderSettings()
    expect(inputTag(html, '宽')).toContain('value="448"')
    expect(inputTag(html, '最大宽度')).toContain('value="448"')
    expect(inputTag(html, '最大宽度')).toContain('disabled')
    expect(html).not.toContain('aria-label="最小宽度"')

    const grow = renderSettings({ autoWidth: true, width: 520, maxWidth: 900 })
    expect(inputTag(grow, '最小宽度')).toContain('value="520"')
    expect(inputTag(grow, '最大宽度')).toContain('value="900"')
    expect(inputTag(grow, '最大宽度')).not.toContain('disabled')
  })

  it('explains the user height lower bound and the content-driven effective minimum', () => {
    const html = renderSettings()
    expect(html).toContain('高度是设置的下限（24–240 px）')
    expect(html).toContain('当前排列至少需要')
    expect(inputTag(html, '高度')).toContain('min="24"')

    const tall = normalizeHudSettings({
      ...DEFAULT_KEVIN_HUD,
      height: 48,
      metrics: ['memory'],
      itemStyle: {
        ...DEFAULT_KEVIN_HUD_ITEM_STYLE,
        orientation: 'vertical',
        valueSize: 20,
        descriptionSize: 20
      }
    })
    const needed = measureKevinHudMinContentHeight(tall)
    expect(needed).toBeGreaterThan(48)
    const tallHtml = renderSettings(tall)
    expect(tallHtml).toContain('当前内容需要的高度比已保存值更高')
    expect(tallHtml).toContain(`把保存高度改为 ${needed} px`)
    // The persisted height remains the user's value; the HUD raises its
    // effective height only when the item layout needs the space.
    expect(inputTag(tallHtml, '高度')).toContain('value="48"')
  })

  it('shows the item gap, content padding and their shared bounds', () => {
    const html = renderSettings()
    expect(inputTag(html, '指标最小间距')).toContain('value="8"')
    expect(rangeMax(html, '指标最小间距')).toBe(48)
    expect(inputTag(html, '内容内边距')).toContain('value="12"')
    expect(rangeMax(html, '内容内边距')).toBe(32)
    expect(html).toContain('空间不足时在 HUD 里滚动')
  })

  it('tracks half the current HUD height as the full-pill radius limit', () => {
    expect(rangeMax(renderSettings({ height: 80, radius: 40 }), '圆角')).toBe(40)
  })
})

describe('KEVIN HUD item style settings', () => {
  const styled = normalizeHudSettings({
    ...DEFAULT_KEVIN_HUD,
    metrics: ['appName', 'appIcon', 'fps', 'memory'],
    itemStyle: {
      ...DEFAULT_KEVIN_HUD_ITEM_STYLE,
      orientation: 'vertical',
      description: 'text',
      minWidth: 120,
      gap: 6,
      descriptionAlign: 'center',
      valueAlign: 'left',
      valueSize: 15,
      descriptionColor: '#AABBCC',
      valueColor: null
    },
    itemStyles: {
      appName: {
        minWidth: 160,
        gap: 4,
        descriptionAlign: 'right',
        valueAlign: 'center',
        descriptionColor: '#223344',
        valueColor: '#556677'
      },
      fps: {
        minWidth: 140,
        gap: 7,
        descriptionAlign: 'right',
        valueAlign: 'center',
        descriptionColor: '#112233',
        valueColor: '#445566'
      },
      memory: { gap: 3 }
    }
  })

  it('offers one shared typography/layout editor and keeps per-item controls limited', () => {
    const html = renderSettings(styled)
    expect(html).toContain('统一指标样式')
    expect(html).toContain('所有指标共用')
    expect(html).toContain('调整统一样式')
    expect(html).toContain('恢复默认样式')
    expect(html).toContain('清除此指标覆盖')

    const defaultSection = defaultStyleSection(html)
    expect(defaultSection).toContain('统一指标样式')
    expect(defaultSection).toContain('说明形式')
    expect(defaultSection).toContain('说明字号')
    expect(defaultSection).toContain('子项最小宽度')
    expect(defaultSection).toContain('说明与数值最小间隔')
    expect(defaultSection).toContain('说明对齐')
    expect(defaultSection).toContain('数值对齐')
    expect(defaultSection).toContain('数值字号')
    expect(defaultSection).toContain('说明加粗')
    expect(defaultSection).toContain('数值加粗')
    expect(defaultSection).toContain('最小宽度 0 表示不预留')
    expect(defaultSection).toContain('最小间隔在横排和竖排都生效')
    expect(defaultSection).toContain('横排说明和数值都居中时整组居中且不重叠')
    expect(segmentedActive(defaultSection, 'vertical')).toBe(true)
    expect(segmentedActive(defaultSection, 'text')).toBe(true)
    expect(inputTag(defaultSection, '统一数值字号')).toContain('value="15"')
    expect(inputTag(defaultSection, '统一说明字号')).not.toBe('')
    expect(inputTag(defaultSection, '统一子项最小宽度')).toContain('value="120"')
    expect(inputTag(defaultSection, '统一子项最小宽度')).toContain('min="0"')
    expect(inputTag(defaultSection, '统一子项最小宽度')).toContain('max="1600"')
    expect(inputTag(defaultSection, '统一说明与数值最小间隔')).toContain('value="6"')
    expect(inputTag(defaultSection, '统一说明与数值最小间隔')).toContain('min="0"')
    expect(inputTag(defaultSection, '统一说明与数值最小间隔')).toContain('max="24"')
    expect(segmentedActive(styleFieldRow(defaultSection, '说明对齐'), 'center')).toBe(true)
    expect(segmentedActive(styleFieldRow(defaultSection, '数值对齐'), 'left')).toBe(true)

    const fps = metricStyleSection(html, 'fps')
    expect(fps).toContain('子项最小宽度')
    expect(fps).toContain('说明与数值最小间隔')
    expect(fps).toContain('最小间隔在横排和竖排都生效')
    expect(fps).toContain('竖排则各自对齐')
    expect(inputTag(fps, 'FPS子项最小宽度')).toContain('value="140"')
    expect(inputTag(fps, 'FPS说明与数值最小间隔')).toContain('value="7"')
    expect(segmentedActive(styleFieldRow(fps, '说明对齐'), 'right')).toBe(true)
    expect(segmentedActive(styleFieldRow(fps, '数值对齐'), 'center')).toBe(true)
    expect(fps).toContain('已单独调整')
    expect(fps).toContain('仅此指标')
    expect(fps).toContain('自定义 · #112233')
    expect(fps).toContain('自定义 · #445566')
    // Per-item size / weight / orientation controls are gone.
    expect(fps).not.toContain('FPS说明字号')
    expect(fps).not.toContain('FPS数值字号')
    expect(fps).not.toContain('FPS说明加粗')
    expect(fps).not.toContain('FPS数值加粗')
    expect(fps).not.toContain('垂直排列')
    // The old "inner gap" label is gone from both drawers.
    expect(html).not.toContain('说明与数值间距')
    expect(html).not.toContain('项内间距')

    const memory = metricStyleSection(html, 'memory')
    expect(inputTag(memory, '内存子项最小宽度')).toContain('value="120"')
    expect(inputTag(memory, '内存说明与数值最小间隔')).toContain('value="3"')
    expect(segmentedActive(styleFieldRow(memory, '说明对齐'), 'center')).toBe(true)
    expect(segmentedActive(styleFieldRow(memory, '数值对齐'), 'left')).toBe(true)
    expect(memory).toContain('跟随统一 · 120 px')
    expect(memory).toContain('跟随统一 · 中')
    expect(memory).toContain('跟随统一 · 左')
    expect(memory).toContain('仅此指标')
    expect(memory).toContain('跟随统一 · #AABBCC')
    expect(memory).toContain('跟随统一 · 自动（白色）')

    // The merged app identity is a normal item with its own layout / colour
    // drawer, while its description form stays fixed to the real app icon.
    const appIdentity = metricStyleSection(html, 'appName')
    expect(appIdentity).toContain('说明固定为真实应用图标')
    expect(appIdentity).toContain('数值固定为实际应用名称')
    expect(inputTag(appIdentity, '应用图标与名称子项最小宽度')).toContain('value="160"')
    expect(inputTag(appIdentity, '应用图标与名称说明与数值最小间隔')).toContain(
      'value="4"'
    )
    expect(appIdentity).toContain('自定义 · #223344')
    expect(appIdentity).toContain('自定义 · #556677')
    expect(appIdentity).not.toContain('说明形式')
    expect(appIdentity).not.toContain('垂直排列')
    expect(html).toContain('图标在说明位置，名称在数值位置')
    expect(html).not.toContain('data-metric-style="appIcon"')
    expect(html).not.toContain('aria-controls="kevin-hud-style-appIcon"')
    expect(html).not.toContain('aria-label="选择应用图标"')

    // Exactly one drawer per selected item.
    for (const metric of ['appName', 'fps', 'memory']) {
      expect(html.match(new RegExp(`data-metric-style="${metric}"`, 'g'))).toHaveLength(1)
    }
    const reservedWidth = measureKevinHudItemWidth(styled, 'fps', { appName: '测试应用' })
    expect(fps).toContain(`单项约 ${reservedWidth} px`)
    const mergedReservedWidth = measureKevinHudItemWidth(styled, 'appName', {
      appName: '测试应用'
    })
    expect(appIdentity).toContain(`单项约 ${mergedReservedWidth} px`)
  })

  it('echoes either legacy identity id once and never renders a separate icon row', () => {
    const html = renderSettings({ metrics: ['appIcon', 'appName', 'fps'] })
    expect(html.match(/<div class="kh-metric-name">应用图标与名称/g)).toHaveLength(1)
    expect(html.match(/data-metric-style="appName"/g)).toHaveLength(1)
    expect(html.match(/aria-label="应用图标与名称子项最小宽度"/g)).toHaveLength(1)
    expect(html).not.toContain('data-metric-style="appIcon"')
    expect(html).not.toContain('<div class="kh-metric-name">应用图标</div>')
    expect(html).not.toContain('<div class="kh-metric-name">应用名称</div>')
  })

  it('ignores legacy per-item layout fields in both data and markup', () => {
    const legacy = normalizeHudSettings({
      ...DEFAULT_KEVIN_HUD,
      metrics: ['fps'],
      itemStyles: {
        fps: {
          orientation: 'vertical',
          descriptionSize: 20,
          valueSize: 30,
          descriptionBold: false,
          valueBold: false,
          gap: 2,
          descriptionColor: '#123456'
        }
      }
    })
    expect(legacy.itemStyles.fps).toEqual({ gap: 2, descriptionColor: '#123456' })

    const html = renderSettings(legacy)
    const fps = metricStyleSection(html, 'fps')
    expect(fps).not.toContain('aria-label="FPS说明字号"')
    expect(fps).not.toContain('aria-label="FPS数值字号"')
    expect(fps).not.toContain('垂直排列')
    expect(fps).toContain('自定义 · #123456')
    expect(inputTag(defaultStyleSection(html), '统一数值字号')).toContain('value="14"')
  })

  it('renders one reusable metrics list with one style drawer per selected item', () => {
    const html = renderSettings({
      ...DEFAULT_KEVIN_HUD,
      metrics: ['clock', 'cpu']
    })
    expect(html.match(/class="sortable sortable-vertical"/g)).toHaveLength(1)
    expect(html.match(/data-metric-style="clock"/g)).toHaveLength(1)
    expect(html.match(/data-metric-style="cpu"/g)).toHaveLength(1)
    expect(html).not.toContain('data-metric-style="fps"')
    expect(html).toContain('aria-controls="kevin-hud-style-clock"')
    expect(html).toContain('aria-controls="kevin-hud-style-cpu"')
  })
})

describe('KEVIN HUD colour editors', () => {
  it('keeps each colour field as its own collapse directly above its panel', () => {
    // Solid keeps the background colour field mounted; gradient replaces it.
    const html = renderSettings({ backgroundMode: 'solid', iconColor: '#3778e5' })
    const editors = [
      { label: '边框颜色', panelId: 'kevin-hud-border-color-editor' },
      { label: '背景颜色', panelId: 'kevin-hud-background-color-editor' },
      { label: '文字颜色', panelId: 'kevin-hud-text-color-editor' },
      { label: '图标颜色', panelId: 'kevin-hud-icon-color-editor' }
    ]

    for (const { label, panelId } of editors) {
      const trigger = colorTrigger(html, `选择${label}`)
      expect(trigger).not.toBe('')
      expect(trigger).toContain(`aria-controls="${panelId}"`)
      const panel = new RegExp(
        `<div(?=[^>]*class="settings-color-panel)(?=[^>]*id="${panelId}")[^>]*>`
      ).exec(html)?.[0]
      expect(panel).toBeTruthy()
      expect(html.match(new RegExp(`id="${panelId}"`, 'g'))).toHaveLength(1)
      expect(html.indexOf(trigger)).toBeGreaterThanOrEqual(0)
      expect(html.indexOf(panel ?? '')).toBeGreaterThan(html.indexOf(trigger))
      const headerAt = html.lastIndexOf('<div class="collapse-head"', html.indexOf(trigger))
      expect(html.slice(headerAt, html.indexOf(trigger))).toContain(`>${label}<`)
    }

    // Closed colour panels render no picker at all.
    expect(html).not.toContain('class="color-editor"')
  })

  it('gives every item and shared colour control a distinct open panel id', () => {
    const html = renderSettings({
      backgroundMode: 'solid',
      iconColor: '#3778e5',
      metrics: ['appName', 'appIcon', 'fps', 'memory']
    })
    const targets: HudColorTarget[] = [
      { kind: 'config', field: 'border' },
      { kind: 'config', field: 'background' },
      { kind: 'config', field: 'text' },
      { kind: 'config', field: 'icon' },
      { kind: 'defaultStyle', field: 'descriptionColor' },
      { kind: 'defaultStyle', field: 'valueColor' },
      ...(['appName', 'fps', 'memory'] as const).flatMap((metric): HudColorTarget[] => [
        { kind: 'metricStyle', metric, field: 'descriptionColor' },
        { kind: 'metricStyle', metric, field: 'valueColor' }
      ])
    ]

    const seen = new Set<string>()
    for (const target of targets) {
      const id = hudColorTargetPanelId(target)
      expect(seen.has(id)).toBe(false)
      seen.add(id)
      expect(html.match(new RegExp(`id="${id}"`, 'g'))).toHaveLength(1)
    }
    expect(seen.size).toBe(12)
    expect(html).not.toContain('class="color-editor"')
  })

  it('uses distinct trigger labels for shared and per-item colour controls', () => {
    const html = renderSettings({
      metrics: ['appName', 'appIcon', 'fps', 'memory']
    })
    const defaultSection = defaultStyleSection(html)
    const appIdentity = metricStyleSection(html, 'appName')
    const fps = metricStyleSection(html, 'fps')
    const memory = metricStyleSection(html, 'memory')

    for (const [section, label, target] of [
      [
        defaultSection,
        '选择统一说明颜色',
        { kind: 'defaultStyle', field: 'descriptionColor' } as HudColorTarget
      ],
      [
        defaultSection,
        '选择统一数值颜色',
        { kind: 'defaultStyle', field: 'valueColor' } as HudColorTarget
      ],
      [
        appIdentity,
        '选择应用图标与名称说明颜色',
        { kind: 'metricStyle', metric: 'appName', field: 'descriptionColor' } as HudColorTarget
      ],
      [
        appIdentity,
        '选择应用图标与名称数值颜色',
        { kind: 'metricStyle', metric: 'appName', field: 'valueColor' } as HudColorTarget
      ],
      [
        fps,
        '选择FPS说明颜色',
        { kind: 'metricStyle', metric: 'fps', field: 'descriptionColor' } as HudColorTarget
      ],
      [
        memory,
        '选择内存数值颜色',
        { kind: 'metricStyle', metric: 'memory', field: 'valueColor' } as HudColorTarget
      ]
    ] as const) {
      const trigger = colorTrigger(section, label)
      const panelId = hudColorTargetPanelId(target)
      expect(trigger).toContain(`aria-controls="${panelId}"`)
      expect(trigger).toContain('aria-expanded="false"')
    }

    expect(HUD_REFERENCE_DESCRIPTION_COLOR).toMatch(/^#[\da-f]{6}$/i)
    expect(HUD_REFERENCE_VALUE_COLOR).toBe('#FFFFFF')
  })
})

describe('KEVIN HUD header motion', () => {
  const css = readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/kevin-hud-settings.css'),
    'utf8'
  )
  const mainCss = readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/main.css'),
    'utf8'
  )

  it('pauses decorative motion in the background and for reduced motion', () => {
    expect(css).toContain("[data-kh-anim='off'] .kh-mark-scan")
    expect(css).toContain("[data-kh-anim='off'] .kh-fresh::after")
    expect(css).not.toContain('.kh-fresh::before')
    expect(css).toContain('animation-play-state: paused')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('animation: none !important')

    const reducedMotion = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reducedMotion).toContain('.kh-fresh::after')
    // Stopping the animation must leave the quiet pastel fill, not remove it.
    expect(reducedMotion).not.toMatch(/\.kh-fresh[^{]*\{[^}]*background/)
  })

  it('keeps a quiet pastel sheen and adopts the start-button sweep', () => {
    const capsule = css.slice(
      css.indexOf('.kh-fresh {'),
      css.indexOf('.kh-fresh::after')
    )
    const sweep = css.slice(
      css.indexOf('.kh-fresh::after'),
      css.indexOf("[data-kh-anim='off']")
    )
    for (const colour of ['#93c5fd', '#c4b5fd', '#f9a8d4', '#fcd34d']) {
      expect(capsule.toLowerCase()).toContain(colour)
    }
    expect(capsule).toContain('color: var(--fg)')
    expect(capsule).toContain('var(--field-bg)')
    expect(capsule).not.toContain('box-shadow')
    expect(capsule).not.toContain('text-shadow')
    expect(sweep).toContain('115deg')
    expect(sweep).toContain('animation: btnFlow 5.2s var(--ease) infinite')
    expect(sweep).toContain('z-index: -1')
    expect(css).not.toContain('@keyframes kh-fresh-flow')
    expect(css).not.toContain('@keyframes kh-fresh-sweep')
  })

  it('animates only transform, without a blur filter or duplicate keyframes', () => {
    const btnFlow = mainCss.slice(
      mainCss.indexOf('@keyframes btnFlow'),
      mainCss.indexOf('.start-btn:active')
    )
    expect(css).toContain('@keyframes kh-mark-scan')
    expect(css).toContain('animation: btnFlow 5.2s var(--ease) infinite')
    expect(css).not.toContain('@keyframes kh-fresh')
    expect(css).not.toContain('filter: blur')
    expect(btnFlow).toContain('translateX(')
    expect(btnFlow).not.toMatch(/\bopacity\s*:/)
    expect(btnFlow).not.toMatch(/\bfilter\s*:/)
  })
})

describe('KEVIN HUD copy-settings panel', () => {
  it('shows the note first, directly before the copy action and the other settings', () => {
    const html = renderSettings()
    const formOpen = html.match(/<div class="kh-form"[^>]*>/)?.[0] ?? ''
    expect(formOpen).not.toBe('')

    const formStart = html.indexOf(formOpen)
    const noticeAt = html.indexOf('<div class="kh-notice"', formStart)
    const copyAt = html.indexOf('<div class="kh-copy">', formStart)
    const sectionAt = html.indexOf(
      '<div class="settings-group-title">显示与位置</div>',
      formStart
    )
    const firstRowAt = html.indexOf('<div class="settings-row"', formStart)
    expect(noticeAt).toBeGreaterThanOrEqual(0)
    expect(copyAt).toBeGreaterThan(noticeAt)
    expect(sectionAt).toBeGreaterThan(copyAt)
    expect(firstRowAt).toBeGreaterThan(copyAt)

    // The note is the first form node and ends directly before the copy action.
    expect(html.slice(formStart + formOpen.length, noticeAt)).toBe('')
    const noticeEndAt = html.indexOf('</div>', noticeAt) + '</div>'.length
    expect(html.slice(noticeEndAt, copyAt)).toBe('')
  })

  it('keeps the copy panel closed and does not load a source list on render', () => {
    const html = renderSettings()
    expect(html).toContain('复制其他应用的 HUD 设置')
    expect(html).toContain('选择来源')
    expect(html).toContain('aria-controls="kevin-hud-copy-settings"')
    const copyTrigger = html.match(/<button[^>]*>选择来源<\/button>/)?.[0] ?? ''
    expect(copyTrigger).toContain('aria-expanded="false"')
    expect(html).toContain('来源应用')
    expect(html).toContain('应用这套设置')
    expect(html).toContain('应用后会立即保存；如果正在预览，也会同步更新。')
    expect(html).not.toContain('正在读取其他应用')
    expect(html).not.toContain('还没有其他应用可以复制')
  })
})
