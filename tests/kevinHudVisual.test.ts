import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, type FunctionComponent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KEVIN_HUD,
  DEFAULT_KEVIN_HUD_ITEM_STYLE,
  type KevinHudConfig,
  type KevinHudFrame
} from '../src/shared/kevinHud'
import {
  KEVIN_HUD_CLOSE_DELAY_MS,
  KEVIN_HUD_GEOMETRY_PEAK_MS,
  KEVIN_HUD_ICON_GLIDE_END_MS,
  KEVIN_HUD_ICON_GLIDE_START_MS,
  KEVIN_HUD_MOTION_TOTAL_MS,
  KEVIN_HUD_PLATE_POP_MS,
  KEVIN_HUD_REVEAL_BASE_DELAY_MS,
  KEVIN_HUD_REVEAL_DURATION_MS,
  KEVIN_HUD_REVEAL_MAX_DELAY_MS,
  KEVIN_HUD_REVEAL_STAGGER_MS,
  KEVIN_HUD_TITLE_SHOWN_MS,
  kevinHudDirectionVars,
  kevinHudMotionOrigin
} from '../src/shared/kevinHudMotion'
import {
  KEVIN_HUD_ANNOUNCE_STATUS_GAP,
  KEVIN_HUD_ANNOUNCE_STATUS_SIZE,
  KEVIN_HUD_ANNOUNCE_STATUS_TEXT,
  KEVIN_HUD_ANNOUNCE_STATUS_TRACKING,
  KEVIN_HUD_METRIC_TEMPLATES,
  measureKevinHudItemWidth,
  measureKevinHudMinContentHeight,
  measureKevinHudValueWidth,
  resolveKevinHudContentPadding,
  resolveKevinHudItemGap,
  resolveKevinHudWidthBounds,
  type KevinHudSizingConfig
} from '../src/shared/kevinHudSizing'
import { MATERIAL_DEFAULTS } from '../src/shared/types'
import type { KevinHudGradient } from '../src/shared/kevinHudBackground'
import KevinHudOverlay from '../src/renderer/src/components/KevinHudOverlay'
import {
  KEVIN_HUD_MAX_REVEAL_X,
  KEVIN_HUD_MIN_CELL_GAP_PX,
  KEVIN_HUD_MIN_CELL_PX,
  formatKevinHudValue,
  kevinHudCellOrder,
  kevinHudItemAlignment,
  kevinHudMetricShowsLabel,
  kevinHudOpenHeight,
  kevinHudOpenRadius,
  kevinHudPlacement,
  kevinHudPlateGeometry,
  kevinHudRevealOrigin,
  kevinHudRipple,
  kevinHudSpring,
  kevinHudTitleOrigins,
  layoutKevinHudRows,
  orderKevinHudMetrics,
  parseKevinHudHex,
  readableKevinHudText,
  resolveKevinHudForegroundOpacity,
  resolveKevinHudItemStyle,
  resolveKevinHudItemVisual,
  resolveKevinHudVisual
} from '../src/renderer/src/components/kevinHudVisual'

const readProjectFile = (...parts: string[]): string =>
  readFileSync(join(process.cwd(), ...parts), 'utf8')

/**
 * The historical 448 x 48 solid memory capsule: 1 px edge, 8.5 px icon
 * descriptor and the 14 px value. The fresh default now uses a 2 px edge,
 * gradient fill and a 12 px text descriptor, but the dedicated memory
 * instrument keeps this exact optical reference.
 */
const LEGACY_MEMORY_REFERENCE_CONFIG: KevinHudConfig = {
  ...DEFAULT_KEVIN_HUD,
  metrics: ['memory'],
  borderWidth: 1,
  backgroundMode: 'solid',
  itemStyle: {
    ...DEFAULT_KEVIN_HUD_ITEM_STYLE,
    description: 'icon',
    descriptionSize: 8.5,
    valueSize: 14
  }
}

describe('KEVIN HUD metric rows', () => {
  it('keeps the configured order while filtering repeats and unknown metrics', () => {
    expect(
      orderKevinHudMetrics(['fps', 'cpu', 'fps', 'nope', 'appName', 'cpu'])
    ).toEqual(['fps', 'cpu', 'appName'])
    expect(orderKevinHudMetrics(undefined)).toEqual([])
  })

  it('uses -- for every missing/blank formatted value', () => {
    expect(formatKevinHudValue(null)).toEqual({ text: '--', unavailable: true })
    expect(formatKevinHudValue('  ')).toEqual({ text: '--', unavailable: true })
    expect(formatKevinHudValue(' 60 FPS ')).toEqual({ text: '60 FPS', unavailable: false })
  })

  it('keeps every chosen item in exactly one row for both width modes', () => {
    expect(layoutKevinHudRows([], false)).toEqual({ layout: 'single', rows: [] })
    expect(layoutKevinHudRows(['fps', 'cpu'], false)).toEqual({
      layout: 'single',
      rows: [['fps', 'cpu']]
    })

    const metrics = ['fps', 'gpu', 'cpu', 'memory', 'download', 'upload', 'clock'] as const
    expect(layoutKevinHudRows([...metrics], false)).toEqual({
      layout: 'single',
      rows: [[...metrics]]
    })
    expect(layoutKevinHudRows([...metrics], true)).toEqual({
      layout: 'single',
      rows: [[...metrics]]
    })
    expect(layoutKevinHudRows([...DEFAULT_KEVIN_HUD.metrics], false).rows.flat()).toEqual([
      ...DEFAULT_KEVIN_HUD.metrics
    ])
  })

  it('starts a centred stagger in the middle and keeps other directions in order', () => {
    expect(kevinHudCellOrder(0, 5, 'center')).toBe(2)
    expect(kevinHudCellOrder(2, 5, 'center')).toBe(0)
    expect(kevinHudCellOrder(0, 5, 'left')).toBe(0)
  })

  it('does not repeat a label already present in the value', () => {
    expect(kevinHudMetricShowsLabel('fps', '171 FPS')).toBe(false)
    expect(kevinHudMetricShowsLabel('fps', '171')).toBe(true)
    expect(kevinHudMetricShowsLabel('gpu', 'GPU 88%')).toBe(false)
    expect(kevinHudMetricShowsLabel('gpu', '88%')).toBe(true)
    expect(kevinHudMetricShowsLabel('cpu', 'CPU 12%')).toBe(false)
    expect(kevinHudMetricShowsLabel('sessionTime', '1:02:03')).toBe(true)
    expect(kevinHudMetricShowsLabel('clock', '--')).toBe(true)
    expect(kevinHudMetricShowsLabel('appName', 'Game')).toBe(false)
  })
})

describe('KEVIN HUD reveal origins', () => {
  it('opens centred slots away from the middle and keeps an exact centre calm', () => {
    const centeredLeft = kevinHudRevealOrigin({
      anchor: 'center',
      direction: 'center',
      centerX: 80,
      surfaceWidth: 400,
      index: 0,
      count: 4
    })
    const centeredRight = kevinHudRevealOrigin({
      anchor: 'center',
      direction: 'center',
      centerX: 320,
      surfaceWidth: 400,
      index: 3,
      count: 4
    })
    const centeredMiddle = kevinHudRevealOrigin({
      anchor: 'center',
      direction: 'center',
      centerX: 200,
      surfaceWidth: 400,
      index: 1,
      count: 3
    })
    // The left slot starts to the right of its settled pose (and moves left);
    // the right slot mirrors it. The exact middle never drifts sideways.
    expect(centeredLeft.x).toBeGreaterThan(0)
    expect(centeredRight.x).toBeLessThan(0)
    expect(centeredMiddle.x).toBe(0)

    const leftAligned = [0, 1, 2, 3].map((index) =>
      kevinHudRevealOrigin({
        anchor: 'left',
        direction: 'center',
        centerX: 80 + index * 70,
        surfaceWidth: 400,
        index,
        count: 4
      })
    )
    const rightAligned = [0, 1, 2, 3].map((index) =>
      kevinHudRevealOrigin({
        anchor: 'right',
        direction: 'center',
        centerX: 80 + index * 70,
        surfaceWidth: 400,
        index,
        count: 4
      })
    )
    expect(leftAligned.every((origin) => origin.x < 0)).toBe(true)
    expect(rightAligned.every((origin) => origin.x > 0)).toBe(true)
    for (const origin of [...leftAligned, ...rightAligned]) {
      expect(Math.abs(origin.x)).toBeLessThanOrEqual(KEVIN_HUD_MAX_REVEAL_X)
    }
  })

  it('keeps the leading identity calm and follows the configured direction', () => {
    const leading = ['left', 'center', 'right'].map((anchor) =>
      kevinHudRevealOrigin({
        anchor: anchor as 'left' | 'center' | 'right',
        direction: 'center',
        centerX: 60,
        surfaceWidth: 400,
        index: 0,
        count: 3,
        leading: true
      })
    )
    expect(leading[0].x).toBeLessThan(0)
    // The centred, centre-direction identity keeps its quiet leading-edge
    // reveal; the exact-centre data slot (tested above) is the one that stays put.
    expect(leading[1].x).toBeLessThan(0)
    expect(leading[2].x).toBeGreaterThan(0)

    const directional = ['left', 'right', 'top', 'bottom'].map((direction) =>
      kevinHudRevealOrigin({
        anchor: 'center',
        direction: direction as 'left' | 'right' | 'top' | 'bottom',
        centerX: 60,
        surfaceWidth: 400,
        index: 0,
        count: 3,
        leading: true
      })
    )
    expect(directional[0].x).toBeLessThan(0)
    expect(directional[1].x).toBeGreaterThan(0)
    expect(directional[2].x).toBe(0)
    expect(directional[2].y).toBe(-12)
    expect(directional[3].x).toBe(0)
    expect(directional[3].y).toBe(12)

    for (const origin of [...leading, ...directional]) {
      expect(Math.abs(origin.x)).toBeLessThanOrEqual(18)
      expect(origin.delayMs).toBe(0)
      expect(origin.exitDelayMs).toBe(
        KEVIN_HUD_MOTION_TOTAL_MS - KEVIN_HUD_REVEAL_DURATION_MS
      )
    }
  })

  it('gives the launch name and status independent title trajectories', () => {
    const centered = kevinHudTitleOrigins({
      anchor: 'center',
      direction: 'center',
      surfaceWidth: 448,
      nameCenterX: 96,
      statusCenterX: 392
    })
    // The centred name starts right of its landing point (and moves left);
    // the trailing status mirrors it. Neither label gains a default y offset.
    expect(centered.name.x).toBeGreaterThan(0)
    expect(centered.name.y).toBe(0)
    expect(centered.status.x).toBeLessThan(0)
    expect(centered.status.y).toBe(0)

    // A long measured name that crosses the plate middle still owns the leading
    // side instead of flipping to the status's direction.
    const crowded = kevinHudTitleOrigins({
      anchor: 'center',
      direction: 'center',
      surfaceWidth: 448,
      nameCenterX: 300,
      statusCenterX: 420
    })
    expect(crowded.name.x).toBeGreaterThan(0)
    expect(crowded.status.x).toBeLessThan(0)

    const left = kevinHudTitleOrigins({
      anchor: 'left',
      direction: 'center',
      surfaceWidth: 448,
      nameCenterX: 96,
      statusCenterX: 392
    })
    expect(left.name.x).toBeLessThan(0)
    expect(left.status.x).toBeLessThan(0)

    const right = kevinHudTitleOrigins({
      anchor: 'right',
      direction: 'center',
      surfaceWidth: 448,
      nameCenterX: 96,
      statusCenterX: 392
    })
    expect(right.name.x).toBeGreaterThan(0)
    expect(right.status.x).toBeGreaterThan(0)

    for (const pair of [centered, left, right]) {
      expect(pair.name.y).toBe(0)
      expect(pair.status.y).toBe(0)
    }

    const top = kevinHudTitleOrigins({
      anchor: 'center',
      direction: 'top',
      surfaceWidth: 448,
      nameCenterX: 96,
      statusCenterX: 392
    })
    const bottom = kevinHudTitleOrigins({
      anchor: 'center',
      direction: 'bottom',
      surfaceWidth: 448,
      nameCenterX: 96,
      statusCenterX: 392
    })
    expect(top.name.y).toBe(-12)
    expect(top.status.y).toBe(-12)
    expect(bottom.name.y).toBe(12)
    expect(bottom.status.y).toBe(12)

    // The CSS must keep the positioning wrapper static, animate both labels,
    // and drop the old fixed +5px downward pitch from both title keyframes.
    const overlayCss = readProjectFile(
      'src',
      'renderer',
      'src',
      'assets',
      'kevinHudOverlay.css'
    )
    expect(overlayCss).not.toContain('var(--khud-enter-y, 0px) + 5px')
    expect(overlayCss).not.toMatch(
      /\.kevin-hud-surface\[data-motion='(?:enter|exit)'\]\s+\.kevin-hud-title-motion\s*\{/
    )
    expect(overlayCss).toContain(
      "[data-motion='enter'] .kevin-hud-title-motion > .kevin-hud-launching"
    )
    expect(overlayCss).toContain('--khud-title-origin-x')
  })

  it('adds bounded vertical travel only for top/bottom presets', () => {
    const top = kevinHudRevealOrigin({
      anchor: 'center',
      direction: 'top',
      centerX: 100,
      surfaceWidth: 400,
      index: 0,
      count: 2
    })
    const bottom = kevinHudRevealOrigin({
      anchor: 'center',
      direction: 'bottom',
      centerX: 100,
      surfaceWidth: 400,
      index: 0,
      count: 2
    })
    const center = kevinHudRevealOrigin({
      anchor: 'center',
      direction: 'center',
      centerX: 100,
      surfaceWidth: 400,
      index: 0,
      count: 2
    })
    expect(top.y).toBe(-12)
    expect(bottom.y).toBe(12)
    expect(center.y).toBe(0)
  })

  it('bounds travel/stagger and reverses the stagger for exit', () => {
    for (let index = 0; index < 9; index += 1) {
      const origin = kevinHudRevealOrigin({
        anchor: 'center',
        direction: 'left',
        centerX: index * 120,
        surfaceWidth: 448,
        index,
        count: 9
      })
      expect(Number.isFinite(origin.x)).toBe(true)
      expect(Number.isFinite(origin.y)).toBe(true)
      expect(Math.abs(origin.x)).toBeLessThanOrEqual(KEVIN_HUD_MAX_REVEAL_X)
      expect(origin.delayMs).toBeGreaterThanOrEqual(0)
      expect(origin.exitDelayMs).toBeGreaterThanOrEqual(0)
      expect(origin.delayMs).toBeLessThanOrEqual(KEVIN_HUD_REVEAL_MAX_DELAY_MS)
      expect(origin.exitDelayMs).toBe(
        KEVIN_HUD_MOTION_TOTAL_MS - KEVIN_HUD_REVEAL_DURATION_MS - origin.delayMs
      )
    }

    const first = kevinHudRevealOrigin({
      anchor: 'left',
      direction: 'left',
      centerX: 40,
      surfaceWidth: 448,
      index: 0,
      count: 5
    })
    const last = kevinHudRevealOrigin({
      anchor: 'left',
      direction: 'left',
      centerX: 400,
      surfaceWidth: 448,
      index: 4,
      count: 5
    })
    expect(first.delayMs).toBe(KEVIN_HUD_REVEAL_BASE_DELAY_MS)
    expect(last.delayMs).toBe(
      Math.min(
        KEVIN_HUD_REVEAL_MAX_DELAY_MS,
        KEVIN_HUD_REVEAL_BASE_DELAY_MS + 4 * KEVIN_HUD_REVEAL_STAGGER_MS
      )
    )
    // The reverse wave starts at 308–340 ms and ends at 528–560 ms: the exact
    // mirror of the 40–72 / 260–292 ms entrance, just before the plate's
    // reversed 360–600 ms contraction finishes.
    expect(first.exitDelayMs).toBe(340)
    expect(last.exitDelayMs).toBe(308)
  })

  it('never emits NaN for malformed geometry inputs', () => {
    const origin = kevinHudRevealOrigin({
      anchor: 'center',
      direction: 'center',
      centerX: Number.NaN,
      surfaceWidth: Number.POSITIVE_INFINITY,
      index: Number.NaN,
      count: Number.NaN
    })
    expect(Number.isFinite(origin.x)).toBe(true)
    expect(Number.isFinite(origin.y)).toBe(true)
    expect(Number.isFinite(origin.delayMs)).toBe(true)
    expect(Number.isFinite(origin.exitDelayMs)).toBe(true)
  })
})

describe('KEVIN HUD visual arithmetic', () => {
  it('accepts only the persisted six-digit colours', () => {
    expect(parseKevinHudHex('#312F30')).toEqual({ r: 49, g: 47, b: 48, a: 1 })
    expect(parseKevinHudHex('#abc')).toBeNull()
    expect(parseKevinHudHex('312F30')).toBeNull()
    expect(parseKevinHudHex(null)).toBeNull()
  })

  it('chooses a readable foreground for light and dark fills', () => {
    expect(readableKevinHudText({ r: 242, g: 242, b: 242, a: 1 }, 1)).toBe('#0c0d0f')
    expect(readableKevinHudText({ r: 22, g: 22, b: 22, a: 1 }, 1)).toBe('#ffffff')
  })

  it('builds a spring easing without needing a requestAnimationFrame loop', () => {
    expect(kevinHudSpring(0)).toBe('cubic-bezier(0.16, 1.000, 0.24, 1)')
    expect(kevinHudSpring(0.275)).toBe('cubic-bezier(0.16, 1.495, 0.24, 1)')
    expect(kevinHudSpring(0.5)).toBe('cubic-bezier(0.16, 1.900, 0.24, 1)')
    expect(kevinHudSpring(0.8)).toBe(kevinHudSpring(0.5))
    expect(kevinHudSpring(Number.NaN)).toBe(kevinHudSpring(0.275))
  })

  it('maps ripple 0…2 while keeping 1 gentle and 2 visibly stronger', () => {
    expect(kevinHudRipple(0)).toEqual({ strength: 0, peakOpacity: 0, endScale: 1 })
    expect(kevinHudRipple(1)).toEqual({ strength: 1, peakOpacity: 0.24, endScale: 1.003 })

    const maximum = kevinHudRipple(2)
    expect(maximum.strength).toBe(2)
    expect(maximum.peakOpacity).toBeCloseTo(0.48)
    expect(maximum.endScale).toBeCloseTo(0.94)
    expect(kevinHudRipple(99)).toEqual(maximum)

    const defaultVisual = resolveKevinHudVisual(DEFAULT_KEVIN_HUD, null)
    const maximumVisual = resolveKevinHudVisual({ ...DEFAULT_KEVIN_HUD, ripple: 2 }, null)
    expect(defaultVisual.vars['--khud-ripple-peak-opacity']).toBe('0.240')
    expect(defaultVisual.vars['--khud-ripple-end-scale']).toBe('1.003')
    expect(maximumVisual.vars['--khud-ripple-strength']).toBe('2.000')
    expect(maximumVisual.vars['--khud-ripple-peak-opacity']).toBe('0.480')
    expect(Number(maximumVisual.vars['--khud-ripple-end-scale'])).toBeLessThan(0.96)
  })

  it('anchors the standalone placement without NaN or off-by-anchor transforms', () => {
    expect(kevinHudPlacement('center', 50, 3)).toEqual({
      left: '50%',
      top: '3%',
      transform: 'translateX(-50%)'
    })
    expect(kevinHudPlacement('left', 0, -5)).toEqual({
      left: '0%',
      top: '0%',
      transform: 'translateX(0)'
    })
    expect(kevinHudPlacement('right', 120, 140)).toEqual({
      left: '100%',
      top: '100%',
      transform: 'translateX(-100%)'
    })
  })

  it('keeps the settled height exactly configured in every phase', () => {
    const visual = resolveKevinHudVisual(
      { ...DEFAULT_KEVIN_HUD, textColor: 'auto' },
      null,
      { phase: 'monitor', host: 'window' }
    )
    expect(visual.material).toBe('blur')
    expect(visual.iconTint).toBeNull()
    expect(visual.vars['--khud-width']).toBe('448px')
    expect(visual.vars['--khud-min-width']).toBe('448px')
    expect(visual.vars['--khud-max-width']).toBe('448px')
    expect(visual.vars['--khud-background-opacity']).toBe('1.000')
    expect(visual.vars['--khud-foreground-opacity']).toBe('1.000')
    expect(visual.vars['--khud-opacity']).toBeUndefined()
    expect(visual.vars['--khud-fill-opacity']).toBeUndefined()
    expect(visual.gradient).toEqual(DEFAULT_KEVIN_HUD.gradient)
    expect(visual.vars['--khud-border-width']).toBe('2px')
    expect(visual.vars['--khud-height']).toBe('48px')
    expect(visual.vars['--khud-content-min-height']).toBe('48px')
    expect(visual.vars['--khud-plate-height']).toBe('48px')
    expect(visual.vars['--khud-base-height']).toBe('48px')
    expect(visual.vars['--khud-expanded-height']).toBe('48px')
    expect(visual.vars['--khud-open-height']).toBe('33px')
    expect(Number(visual.vars['--khud-open-height'].replace('px', ''))).toBeLessThan(48)
    expect(visual.vars['--khud-radius']).toBe('24px')
    expect(visual.vars['--khud-base-radius']).toBe('24px')
    expect(visual.vars['--khud-expanded-radius']).toBe('24px')
    expect(visual.vars['--khud-open-radius']).toBe('17px')
    expect(visual.vars['--khud-fill']).toBe('transparent')
    expect(visual.vars['--khud-gradient']).toBe(
      'linear-gradient(90deg, #1F1D1E 0%, #302E2F 100%)'
    )
    expect(visual.vars['--khud-backdrop']).toBe('none')
    expect(visual.vars['--khud-text']).toBe('#ffffff')
    expect(visual.vars['--khud-motion-duration']).toBe(
      `${KEVIN_HUD_MOTION_TOTAL_MS}ms`
    )
    expect(visual.vars['--khud-reveal-duration']).toBe(`${KEVIN_HUD_REVEAL_DURATION_MS}ms`)
    expect(visual.vars['--khud-cell-min']).toBe(`${KEVIN_HUD_MIN_CELL_PX}px`)
    expect(visual.vars['--khud-cell-gap']).toBe(`${KEVIN_HUD_MIN_CELL_GAP_PX}px`)
    expect(visual.vars['--khud-item-gap']).toBe(`${resolveKevinHudItemGap(DEFAULT_KEVIN_HUD)}px`)
    expect(visual.vars['--khud-content-pad-x']).toBe(
      `${resolveKevinHudContentPadding(DEFAULT_KEVIN_HUD).horizontal}px`
    )
    expect(visual.vars['--khud-content-pad-y']).toBe(
      `${resolveKevinHudContentPadding(DEFAULT_KEVIN_HUD).vertical}px`
    )
  })

  it('grows from a shorter pose to the configured height without a title peak', () => {
    const geometry = kevinHudPlateGeometry(
      { ...DEFAULT_KEVIN_HUD, height: 48, radius: 24 },
      { phase: 'announce', host: 'window' }
    )
    expect(geometry).toEqual({
      height: 48,
      openHeight: 33,
      radius: 24,
      openRadius: 17,
      baseHeight: 48,
      expandedHeight: 48,
      baseRadius: 24,
      expandedRadius: 24,
      expanded: true
    })

    const custom = kevinHudPlateGeometry({ ...DEFAULT_KEVIN_HUD, height: 72 }, {
      phase: 'announce',
      host: 'window'
    })
    expect(custom.height).toBe(72)
    expect(custom.openHeight).toBeLessThan(72)
    expect(custom.expandedHeight).toBe(72)
    expect(custom.expandedHeight).not.toBe(108)

    // A standalone preview receives the same configured height, not a taller
    // visual expansion, and the reverse exit replays that exact geometry.
    const preview = resolveKevinHudVisual(
      { ...DEFAULT_KEVIN_HUD, height: 48 },
      null,
      { phase: 'announce', host: 'viewport' }
    )
    expect(preview.vars['--khud-height']).toBe('48px')
    expect(preview.vars['--khud-expanded-height']).toBe('48px')

    const exitAnnounce = resolveKevinHudVisual(
      { ...DEFAULT_KEVIN_HUD, height: 48 },
      null,
      { phase: 'exit', host: 'window', exitFrom: 'announce' }
    )
    expect(exitAnnounce.vars['--khud-height']).toBe('48px')
    expect(exitAnnounce.vars['--khud-open-height']).toBe('33px')

    const exitMonitor = resolveKevinHudVisual(
      { ...DEFAULT_KEVIN_HUD, height: 48 },
      null,
      { phase: 'exit', host: 'window', exitFrom: 'monitor' }
    )
    expect(exitMonitor.vars['--khud-height']).toBe('48px')
    expect(exitMonitor.vars['--khud-expanded-height']).toBe('48px')

    // The minimum supported height still starts strictly shorter.
    expect(kevinHudOpenHeight(24)).toBe(16)
    expect(kevinHudOpenHeight(240)).toBeLessThan(240)
    expect(kevinHudOpenRadius(0)).toBe(0)
    expect(kevinHudOpenRadius(24)).toBe(17)
  })

  it('exposes five distinct, reversible direction origins', () => {
    const center = kevinHudMotionOrigin('center')
    const left = kevinHudMotionOrigin('left')
    const right = kevinHudMotionOrigin('right')
    const top = kevinHudMotionOrigin('top')
    const bottom = kevinHudMotionOrigin('bottom')
    expect(center).toEqual({ x: 0, y: 0, scale: 0.6 })
    expect(left.x).toBeLessThan(0)
    expect(right.x).toBeGreaterThan(0)
    expect(top.y).toBeLessThan(0)
    expect(bottom.y).toBeGreaterThan(0)
    expect(left.scale).toBeLessThan(1)
    expect(right.scale).toBe(left.scale)
    expect(kevinHudDirectionVars('left')).toEqual({
      '--khud-enter-x': '-28px',
      '--khud-enter-y': '0px',
      '--khud-enter-scale': '0.72'
    })
    expect(kevinHudDirectionVars('center')['--khud-enter-scale']).toBe('0.6')
  })

  it('respects an explicit tint and picks a local material filter for custom glass', () => {
    const visual = resolveKevinHudVisual(
      {
        ...DEFAULT_KEVIN_HUD,
        backgroundMode: 'custom',
        material: 'mica',
        iconColor: '#12AB34',
        backgroundOpacity: 0.4
      },
      null
    )
    expect(visual.material).toBe('mica')
    expect(visual.iconTint).toBe('#12AB34')
    expect(visual.vars['--khud-background-opacity']).toBe('0.400')
    expect(visual.vars['--khud-foreground-opacity']).toBe('1.000')
    expect(visual.vars['--khud-backdrop']).toContain('blur(')
  })

  it('folds existing app-glass values and theme tokens into app mode', () => {
    const visual = resolveKevinHudVisual(
      { ...DEFAULT_KEVIN_HUD, backgroundMode: 'app', textColor: 'auto' },
      {
        ...MATERIAL_DEFAULTS.liquid,
        brightness: 80,
        opacity: 40,
        blur: 12,
        saturation: 140
      }
    )
    expect(visual.material).toBe('liquid')
    expect(visual.vars['--khud-fill']).toContain('var(--glass')
    expect(visual.vars['--khud-backdrop']).toContain('var(--glass-backdrop')
    expect(visual.vars['--khud-text']).toContain('var(--fg')
    expect(visual.vars['--khud-background-opacity']).toBe('1.000')
    expect(visual.vars['--khud-foreground-opacity']).toBe('1.000')
  })

  it('keeps signed offsets exactly as configured for both text and icon', () => {
    const visual = resolveKevinHudVisual(
      { ...DEFAULT_KEVIN_HUD, textOffsetX: -17, textOffsetY: 8, iconOffsetX: 9, iconOffsetY: -3 },
      null
    )
    expect(visual.vars['--khud-text-x']).toBe('-17px')
    expect(visual.vars['--khud-text-y']).toBe('8px')
    expect(visual.vars['--khud-icon-x']).toBe('9px')
    expect(visual.vars['--khud-icon-y']).toBe('-3px')
  })

  it('clamps a malformed raw config instead of producing CSS with NaN', () => {
    const malformed = {
      ...DEFAULT_KEVIN_HUD,
      width: Number.NaN,
      height: -10,
      radius: Number.POSITIVE_INFINITY,
      fontScale: 9
    }
    const visual = resolveKevinHudVisual(malformed, null)
    const resolvedHeight = measureKevinHudMinContentHeight(malformed)
    expect(visual.vars['--khud-width']).toBe('448px')
    // The malformed height clamps to 24, then the enlarged type raises the
    // actual settled lower bound; the entrance starts shorter than that.
    expect(resolvedHeight).toBeGreaterThan(24)
    expect(visual.vars['--khud-height']).toBe(`${resolvedHeight}px`)
    expect(visual.vars['--khud-open-height']).toBe(
      `${kevinHudOpenHeight(resolvedHeight)}px`
    )
    expect(visual.vars['--khud-radius']).toBe('24px')
    expect(visual.vars['--khud-font-scale']).toBe('1.250')
  })
})

describe('KEVIN HUD shared item sizing', () => {
  it('uses the fresh 448 x 48 gradient, metrics and item defaults', () => {
    expect(DEFAULT_KEVIN_HUD.width).toBe(448)
    expect(DEFAULT_KEVIN_HUD.maxWidth).toBe(448)
    expect(DEFAULT_KEVIN_HUD.height).toBe(48)
    expect(DEFAULT_KEVIN_HUD.radius).toBe(24)
    expect(DEFAULT_KEVIN_HUD.backgroundColor).toBe('#312F30')
    expect(DEFAULT_KEVIN_HUD.alwaysVisible).toBe(true)
    expect(DEFAULT_KEVIN_HUD.metrics).toEqual(['fps', 'gpu', 'cpu'])
    expect(DEFAULT_KEVIN_HUD.backgroundMode).toBe('gradient')
    expect(DEFAULT_KEVIN_HUD.borderWidth).toBe(2)
    expect(DEFAULT_KEVIN_HUD.borderColor).toBe('#A7AD48')
    expect(DEFAULT_KEVIN_HUD_ITEM_STYLE.minWidth).toBe(0)
    expect(DEFAULT_KEVIN_HUD_ITEM_STYLE.descriptionAlign).toBe('left')
    expect(DEFAULT_KEVIN_HUD_ITEM_STYLE.valueAlign).toBe('right')
    expect(DEFAULT_KEVIN_HUD.backgroundOpacity).toBe(1)
    expect(DEFAULT_KEVIN_HUD.absorbLauncher).toBe(true)
    expect(DEFAULT_KEVIN_HUD_ITEM_STYLE.valueSize).toBe(14)
    expect(DEFAULT_KEVIN_HUD_ITEM_STYLE.description).toBe('text')
    expect(DEFAULT_KEVIN_HUD_ITEM_STYLE.descriptionSize).toBe(12)
    expect(DEFAULT_KEVIN_HUD_ITEM_STYLE.descriptionColor).toBeNull()
    expect(DEFAULT_KEVIN_HUD_ITEM_STYLE.valueColor).toBeNull()

    const visual = resolveKevinHudVisual(DEFAULT_KEVIN_HUD, null)
    expect(visual.vars['--khud-width']).toBe('448px')
    expect(visual.vars['--khud-height']).toBe('48px')
    expect(visual.vars['--khud-border-width']).toBe('2px')
    expect(visual.gradient).not.toBeNull()
    expect(visual.vars['--khud-gradient']).toContain('linear-gradient(90deg')
  })

  it('keeps legacy fixed widths and resolves positive ordered grow bounds', () => {
    expect(
      resolveKevinHudWidthBounds({
        width: 448,
        autoWidth: false,
        maxWidth: 1600
      })
    ).toEqual({ minWidth: 448, maxWidth: 1600, auto: false })

    // A historical fixed config has no maxWidth; both ends stay at its width.
    expect(resolveKevinHudWidthBounds({ width: 448, autoWidth: false })).toEqual({
      minWidth: 448,
      maxWidth: 448,
      auto: false
    })

    // Legacy grow mode with no explicit max keeps the broad saved contract,
    // while an explicit max is honoured and can never invert min/max.
    expect(
      resolveKevinHudWidthBounds({ width: 448, autoWidth: true })
    ).toMatchObject({ minWidth: 448, maxWidth: 1600, auto: true })
    expect(
      resolveKevinHudWidthBounds({ width: 448, autoWidth: true, maxWidth: 720 })
    ).toMatchObject({ minWidth: 448, maxWidth: 720, auto: true })
    expect(
      resolveKevinHudWidthBounds({ width: 448, autoWidth: true, maxWidth: 200 })
    ).toMatchObject({ minWidth: 448, maxWidth: 448, auto: true })

    // Malformed sizes never produce zero/NaN CSS lengths.
    const malformed = resolveKevinHudWidthBounds({
      width: Number.NaN,
      autoWidth: true,
      maxWidth: Number.POSITIVE_INFINITY
    } as KevinHudSizingConfig)
    expect(Number.isFinite(malformed.minWidth)).toBe(true)
    expect(Number.isFinite(malformed.maxWidth)).toBe(true)
    expect(malformed.minWidth).toBeGreaterThan(0)
    expect(malformed.maxWidth).toBeGreaterThanOrEqual(malformed.minWidth)
  })

  it('applies only gap/colour per-metric overrides and ignores legacy beta fields', () => {
    const config = {
      ...DEFAULT_KEVIN_HUD,
      itemStyle: {
        ...DEFAULT_KEVIN_HUD_ITEM_STYLE,
        orientation: 'vertical',
        description: 'icon',
        gap: 12,
        descriptionSize: 16,
        valueSize: 24,
        descriptionBold: false,
        valueBold: false,
        descriptionColor: null,
        valueColor: null
      },
      itemStyles: {
        // These are the three supported fields.
        fps: {
          gap: 9,
          descriptionColor: '#C6CA4C',
          valueColor: '#123456',
          // Fields from the old beta item editor must be ignored, not applied.
          orientation: 'horizontal',
          description: 'text',
          descriptionSize: 24,
          valueSize: 30,
          descriptionBold: true,
          valueBold: true
        },
        appName: {
          gap: 11,
          descriptionColor: '#C6CA4C',
          valueColor: '#123456',
          orientation: 'vertical',
          valueSize: 30
        }
      }
    } as unknown as KevinHudConfig

    expect(resolveKevinHudItemStyle(config, 'fps')).toMatchObject({
      orientation: 'vertical',
      description: 'icon',
      gap: 9,
      descriptionSize: 16,
      valueSize: 24,
      descriptionBold: false,
      valueBold: false,
      descriptionColor: '#C6CA4C',
      valueColor: '#123456'
    })
    // The settled app identity is a normal row item now: app-wide orientation
    // and type, a fixed real-icon description, and only the appName
    // gap/colour patch.
    expect(resolveKevinHudItemStyle(config, 'appName')).toMatchObject({
      orientation: 'vertical',
      description: 'icon',
      gap: 11,
      descriptionSize: 16,
      valueSize: 24,
      descriptionBold: false,
      valueBold: false,
      descriptionColor: '#C6CA4C',
      valueColor: '#123456'
    })

    const fps = resolveKevinHudItemVisual(config, 'fps')
    expect(fps.vars['--khud-item-description-color']).toBe('#C6CA4C')
    expect(fps.vars['--khud-item-value-color']).toBe('#123456')
    expect(fps.vars['--khud-item-value-size']).toBe('24px')
    expect(fps.vars['--khud-copy-gap']).toBe('9px')

    const appNameVisual = resolveKevinHudItemVisual(config, 'appName', '测试应用')
    expect(appNameVisual.style.description).toBe('icon')
    expect(appNameVisual.vars['--khud-item-description-color']).toBe('#C6CA4C')
    expect(appNameVisual.vars['--khud-item-value-color']).toBe('#123456')
    expect(appNameVisual.vars['--khud-copy-gap']).toBe('11px')
    expect(appNameVisual.vars['--khud-item-description-size']).toBe('16px')
    expect(appNameVisual.vars['--khud-item-value-size']).toBe('24px')
    expect(appNameVisual.vars['--khud-item-icon-size']).toBe('22px')
    expect(appNameVisual.width).toBeGreaterThan(54)
    expect(Number(appNameVisual.vars['--khud-value-width'].replace('px', ''))).toBeGreaterThan(0)

    const unified = resolveKevinHudItemVisual(DEFAULT_KEVIN_HUD, 'fps')
    expect(unified.vars['--khud-item-value-color']).toBe(
      'var(--khud-text, #ffffff)'
    )
    expect(unified.vars['--khud-item-description-color']).toContain('color-mix')
    expect(unified.style.valueSize).toBe(DEFAULT_KEVIN_HUD_ITEM_STYLE.valueSize)

    // An explicit per-item null is a reset, not "fall back to the app-wide
    // custom colour". Other items keep that app-wide colour.
    const withGlobalColor: KevinHudConfig = {
      ...DEFAULT_KEVIN_HUD,
      itemStyle: {
        ...DEFAULT_KEVIN_HUD_ITEM_STYLE,
        valueColor: '#ABCDEF',
        descriptionColor: '#123456'
      },
      itemStyles: { fps: { valueColor: null, descriptionColor: null } }
    }
    expect(resolveKevinHudItemStyle(withGlobalColor, 'fps')).toMatchObject({
      valueColor: null,
      descriptionColor: null
    })
    expect(resolveKevinHudItemStyle(withGlobalColor, 'gpu')).toMatchObject({
      valueColor: '#ABCDEF',
      descriptionColor: '#123456'
    })
    // The merged app identity also follows the app-wide colours and keeps its
    // fixed real-icon descriptor.
    expect(resolveKevinHudItemStyle(withGlobalColor, 'appName')).toMatchObject({
      description: 'icon',
      valueColor: '#ABCDEF',
      descriptionColor: '#123456'
    })
  })

  it('keeps background and foreground opacity fully independent', () => {
    const foreground = (foregroundOpacity: number): KevinHudConfig =>
      ({ ...DEFAULT_KEVIN_HUD, foregroundOpacity })
    expect(resolveKevinHudForegroundOpacity(foreground(0.35))).toBe(0.35)
    expect(resolveKevinHudForegroundOpacity(foreground(7))).toBe(1)
    expect(resolveKevinHudForegroundOpacity(foreground(-1))).toBe(0)
    expect(resolveKevinHudForegroundOpacity(foreground(Number.NaN))).toBe(1)

    const visual = resolveKevinHudVisual(
      {
        ...DEFAULT_KEVIN_HUD,
        backgroundOpacity: 0.6,
        foregroundOpacity: 0.42
      },
      null
    )
    expect(visual.vars['--khud-background-opacity']).toBe('0.600')
    expect(visual.vars['--khud-foreground-opacity']).toBe('0.420')
    // The previous whole-HUD opacity token and the fill-only opacity must be
    // gone: neither one can fade the other layer.
    expect(visual.vars['--khud-opacity']).toBeUndefined()
    expect(visual.vars['--khud-fill-opacity']).toBeUndefined()

    const overlayCss = readProjectFile(
      'src',
      'renderer',
      'src',
      'assets',
      'kevinHudOverlay.css'
    )
    const rootRule = (
      /\.kevin-hud-root\s*\{([^}]*)\}/s.exec(overlayCss)?.[1] ?? ''
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(rootRule).not.toContain('opacity')
    expect(overlayCss).toContain('opacity: var(--khud-background-opacity, 1)')
    expect(overlayCss).toContain('opacity: var(--khud-foreground-opacity, 1)')
    // The animated surface keeps its own reversible opacity keyframes and must
    // not gain a second, animation-overriding opacity declaration.
    const surfaceRule = (
      /\.kevin-hud-surface\s*\{([^}]*)\}/s.exec(overlayCss)?.[1] ?? ''
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(surfaceRule).not.toContain('opacity:')
  })

  it('drops the complete glass face, including keyword backdrop, at zero background', () => {
    const zero = resolveKevinHudVisual(
      {
        ...DEFAULT_KEVIN_HUD,
        backgroundMode: 'app',
        backgroundOpacity: 0,
        foregroundOpacity: 0
      },
      {
        ...MATERIAL_DEFAULTS.liquid,
        brightness: 72,
        opacity: 50,
        blur: 14,
        saturation: 130
      }
    )
    expect(zero.vars['--khud-background-opacity']).toBe('0.000')
    expect(zero.vars['--khud-foreground-opacity']).toBe('0.000')
    expect(zero.vars['--khud-backdrop']).toBe('none')
    expect(zero.vars['--khud-fill']).toContain('var(--glass')

    const overlayCss = readProjectFile(
      'src',
      'renderer',
      'src',
      'assets',
      'kevinHudOverlay.css'
    )
    const backgroundRule = (
      /^\.kevin-hud-background\s*\{([^}]*)\}/m.exec(overlayCss)?.[1] ?? ''
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(backgroundRule).toContain('opacity: var(--khud-background-opacity, 1)')
    // The backdrop belongs to the background group, not to the surface, so a
    // zero background opacity cannot leave a filtered ghost behind.
    expect(overlayCss).toContain("[data-background='app'] .kevin-hud-background")
    expect(overlayCss).toContain("[data-background='custom'] .kevin-hud-background")
    const surfaceRule = (
      /\.kevin-hud-surface\s*\{([^}]*)\}/s.exec(overlayCss)?.[1] ?? ''
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(surfaceRule).not.toContain('backdrop-filter')
  })

  it('paints the shared normalized gradient CSS in gradient mode', () => {
    const gradient: KevinHudGradient = {
      kind: 'radial',
      angle: 135,
      centerX: 25,
      centerY: 75,
      shape: 'circle',
      stops: [
        { color: '#112233', position: 0 },
        { color: '#AABBCC', position: 55 },
        { color: '#445566', position: 100 }
      ]
    }
    const visual = resolveKevinHudVisual(
      {
        ...DEFAULT_KEVIN_HUD,
        backgroundMode: 'gradient',
        backgroundOpacity: 0.45,
        foregroundOpacity: 0.8,
        gradient
      },
      null
    )
    expect(visual.gradient).toEqual(gradient)
    expect(visual.vars['--khud-gradient']).toBe(
      'radial-gradient(circle at 25% 75%, #112233 0%, #AABBCC 55%, #445566 100%)'
    )
    expect(visual.vars['--khud-fill']).toBe('transparent')
    expect(visual.vars['--khud-background-opacity']).toBe('0.450')
    expect(visual.vars['--khud-foreground-opacity']).toBe('0.800')
    expect(visual.vars['--khud-backdrop']).toBe('none')

    // Malformed input is sanitized by the shared helper, not interpolated raw.
    const sanitized = resolveKevinHudVisual(
      {
        ...DEFAULT_KEVIN_HUD,
        backgroundMode: 'gradient',
        gradient: {
          ...gradient,
          kind: 'linear',
          angle: 999,
          stops: [{ color: 'red', position: 0 }]
        }
      },
      null
    )
    expect(sanitized.vars['--khud-gradient']).toBe(
      'linear-gradient(360deg, #1F1D1E 0%, #302E2F 100%)'
    )

    const overlayCss = readProjectFile(
      'src',
      'renderer',
      'src',
      'assets',
      'kevinHudOverlay.css'
    )
    expect(overlayCss).toContain("[data-background='gradient'] .kevin-hud-fill")
    expect(overlayCss).toContain('background-image: var(--khud-gradient, none)')
  })

  it('keeps solid mode on the matte fill even when another material is saved', () => {
    const visual = resolveKevinHudVisual(
      {
        ...DEFAULT_KEVIN_HUD,
        backgroundMode: 'solid',
        material: 'shine',
        backgroundColor: '#123456'
      },
      null
    )
    expect(visual.material).toBe('shine')
    expect(visual.vars['--khud-fill']).toBe('rgba(18, 52, 86, 1.000)')
    expect(visual.vars['--khud-gradient']).toBe('none')
    expect(visual.vars['--khud-backdrop']).toBe('none')

    const overlayCss = readProjectFile(
      'src',
      'renderer',
      'src',
      'assets',
      'kevinHudOverlay.css'
    )
    expect(overlayCss).toContain("[data-background='solid'] .kevin-hud-material")
    expect(overlayCss).not.toContain(
      "[data-background='solid']:not([data-material='blur'])"
    )
    expect(overlayCss).not.toContain(
      "[data-background='solid'][data-material='blur']"
    )
  })

  it('reserves finite value/item widths and grows with type or app name', () => {
    for (const [metric, template] of Object.entries(KEVIN_HUD_METRIC_TEMPLATES)) {
      expect(template.template.length).toBeGreaterThan(0)
      const valueWidth = measureKevinHudValueWidth(
        DEFAULT_KEVIN_HUD,
        metric as keyof typeof KEVIN_HUD_METRIC_TEMPLATES
      )
      expect(Number.isFinite(valueWidth)).toBe(true)
      expect(valueWidth).toBeGreaterThan(0)
    }

    const fps = measureKevinHudItemWidth(DEFAULT_KEVIN_HUD, 'fps')
    expect(Number.isFinite(fps)).toBe(true)
    expect(fps).toBeGreaterThan(measureKevinHudValueWidth(DEFAULT_KEVIN_HUD, 'fps'))

    const largerType = measureKevinHudItemWidth(
      {
        ...DEFAULT_KEVIN_HUD,
        itemStyle: { ...DEFAULT_KEVIN_HUD_ITEM_STYLE, valueSize: 32 }
      },
      'fps'
    )
    expect(largerType).toBeGreaterThan(fps)

    const shortName = measureKevinHudItemWidth(DEFAULT_KEVIN_HUD, 'appName', {
      appName: 'A'
    })
    const longName = measureKevinHudItemWidth(DEFAULT_KEVIN_HUD, 'appName', {
      appName: 'A'.repeat(80)
    })
    expect(shortName).toBeGreaterThanOrEqual(54)
    expect(longName).toBeGreaterThan(shortName)
  })

  it('uses the user height as a lower bound and grows vertical descriptors', () => {
    expect(measureKevinHudMinContentHeight(DEFAULT_KEVIN_HUD)).toBe(
      DEFAULT_KEVIN_HUD.height
    )

    const vertical: KevinHudConfig = {
      ...DEFAULT_KEVIN_HUD,
      metrics: ['fps'],
      contentPadding: 32,
      itemStyle: {
        ...DEFAULT_KEVIN_HUD_ITEM_STYLE,
        orientation: 'vertical',
        descriptionSize: 24,
        valueSize: 32,
        gap: 24
      }
    }
    const needed = measureKevinHudMinContentHeight(vertical)
    expect(needed).toBeGreaterThan(DEFAULT_KEVIN_HUD.height)
    expect(needed).toBeLessThanOrEqual(240)

    expect(resolveKevinHudItemGap({ itemGap: 999 })).toBe(48)
    expect(resolveKevinHudContentPadding({ height: 48, contentPadding: 12 })).toEqual({
      horizontal: 12,
      vertical: 4
    })
    expect(resolveKevinHudContentPadding({ height: 24, contentPadding: 32 }).vertical)
      .toBeLessThanOrEqual(5)
  })

  it('keeps the launch marker left of the icon and the status at the trailing edge', () => {
    const Overlay = KevinHudOverlay as unknown as FunctionComponent<{
      frame: KevinHudFrame
    }>
    const frame: KevinHudFrame = {
      phase: 'announce',
      config: { ...DEFAULT_KEVIN_HUD, metrics: ['memory'] },
      appName: '测试应用',
      iconUrl: null,
      fontFamily: null,
      appGlass: null,
      values: {}
    }
    const html = renderToStaticMarkup(createElement(Overlay, { frame }))
    const sign = html.indexOf('kevin-hud-launch-sign')
    const icon = html.indexOf('kevin-hud-icon-frame')
    const name = html.indexOf('kevin-hud-app-name')
    const launching = html.indexOf('kevin-hud-launching')
    expect(sign).toBeGreaterThan(-1)
    expect(icon).toBeGreaterThan(sign)
    expect(name).toBeGreaterThan(icon)
    expect(launching).toBeGreaterThan(name)
    expect(html).toContain('data-launching="true"')
    expect(html).toContain(KEVIN_HUD_ANNOUNCE_STATUS_TEXT)

    const visual = resolveKevinHudVisual(DEFAULT_KEVIN_HUD, null)
    expect(visual.vars['--khud-icon-slot-left']).toBe('25px')
    expect(visual.vars['--khud-title-left']).toBe('42px')
    expect(visual.vars['--khud-launch-mark-width']).toBe('7px')
    expect(visual.vars['--khud-launch-mark-gap']).toBe('7px')
    expect(visual.vars['--khud-status-size']).toBe(
      `${KEVIN_HUD_ANNOUNCE_STATUS_SIZE}px`
    )
    expect(visual.vars['--khud-status-gap']).toBe(
      `${KEVIN_HUD_ANNOUNCE_STATUS_GAP}px`
    )
    expect(visual.vars['--khud-status-tracking']).toBe(
      `${KEVIN_HUD_ANNOUNCE_STATUS_TRACKING}em`
    )

    const overlayCss = readProjectFile(
      'src',
      'renderer',
      'src',
      'assets',
      'kevinHudOverlay.css'
    )
    expect(overlayCss).toContain('.kevin-hud-icon-motion .kevin-hud-launch-sign')
    expect(overlayCss).toContain('.kevin-hud-identity .kevin-hud-icon-frame')
    expect(overlayCss).toContain('border-radius: 50%')
    expect(overlayCss).toContain(
      "[data-motion='enter'] .kevin-hud-icon-motion"
    )
    expect(overlayCss).toContain(
      "[data-motion='enter'] .kevin-hud-title-motion > .kevin-hud-title-block"
    )
    expect(overlayCss).toContain(
      "[data-motion='exit'] .kevin-hud-title-motion > .kevin-hud-title-block"
    )
  })

  it('renders one background group and one independent foreground group', () => {
    const Overlay = KevinHudOverlay as unknown as FunctionComponent<{
      frame: KevinHudFrame
    }>
    const frame: KevinHudFrame = {
      phase: 'monitor',
      config: { ...DEFAULT_KEVIN_HUD, metrics: ['memory'] },
      appName: '测试应用',
      iconUrl: null,
      fontFamily: null,
      appGlass: null,
      values: { memory: '9.7 / 31.3 GB · 31%' }
    }
    const html = renderToStaticMarkup(createElement(Overlay, { frame }))
    const background = html.indexOf('kevin-hud-background')
    const fill = html.indexOf('kevin-hud-fill')
    const material = html.indexOf('kevin-hud-material')
    const foreground = html.indexOf('kevin-hud-foreground')
    const content = html.indexOf('kevin-hud-content')
    const ripple = html.indexOf('kevin-hud-ripple')
    expect(background).toBeGreaterThan(-1)
    expect(fill).toBeGreaterThan(background)
    expect(material).toBeGreaterThan(fill)
    expect(foreground).toBeGreaterThan(material)
    expect(content).toBeGreaterThan(foreground)
    expect(ripple).toBeGreaterThan(content)
    expect(html).toContain('--khud-background-opacity:1.000')
    expect(html).toContain('--khud-foreground-opacity:1.000')
    expect(html).not.toContain('--khud-opacity')
    expect(html).not.toContain('--khud-fill-opacity')
  })

  it('draws the reference memory readout with fixed type and item-size scales', () => {
    const memoryCss = readProjectFile(
      'src',
      'renderer',
      'src',
      'assets',
      'kevinHudMemoryReadout.css'
    )
    // 448 x 48 reference: used 20.8, total 11.2, percent 17.6, sign 10.4,
    // badge 36.8, ring 3.6, text left 51.2, right inset 4, group gap 11.2.
    // The type uses those fixed sizes with independent item-size multipliers;
    // the settled plate height is never a font input.
    expect(memoryCss).toContain('20.8px * var(--_khmr-value-scale)')
    expect(memoryCss).toContain('11.2px * var(--_khmr-value-scale)')
    expect(memoryCss).toContain('17.6px * var(--_khmr-value-scale)')
    expect(memoryCss).toContain('10.4px * var(--_khmr-value-scale)')
    expect(memoryCss).toContain('--_khmr-description-scale: var(--khmr-description-scale, 1)')
    expect(memoryCss).toContain('11.2px * var(--_khmr-description-scale)')
    expect(memoryCss).toContain('16.8px * var(--_khmr-description-scale)')
    expect(memoryCss).toContain('--_khmr-badge-size: 36.8px')
    expect(memoryCss).toContain('--_khmr-ring: 3.6px')
    expect(memoryCss).not.toMatch(
      /--_khmr-(?:used-size|total-size|percent-size|percent-sign-size):[^;]*var\(--_khmr-height\)/
    )
    expect(memoryCss).toContain('#c6ca4c')
    expect(memoryCss).toContain('#262425')
    expect(memoryCss).toContain('conic-gradient(')
    expect(memoryCss).toContain('from 0deg')
    expect(memoryCss).toContain('color: var(--_khmr-description-color)')
    expect(memoryCss).toContain('color: var(--_khmr-value-color)')
    expect(memoryCss).toContain('min-inline-size: 4ch')
    expect(memoryCss).toContain('min-inline-size: 5ch')

    // The reference badge paints only the dark disc and the filled lime arc:
    // no full grey track and no extra inset edge shadow beneath it.
    const arcRule = (
      /\.kevin-hud-memory-readout__arc\s*\{([^}]*)\}/s.exec(memoryCss)?.[1] ?? ''
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(arcRule).toContain('background: var(--_khmr-badge)')
    expect(arcRule).not.toContain('box-shadow')
    expect(memoryCss).not.toContain('--_khmr-track')
    expect(memoryCss).not.toContain('.kevin-hud-memory-readout__arc::before')
    const arcAfterRule = (
      /\.kevin-hud-memory-readout__arc::after\s*\{([^}]*)\}/s.exec(memoryCss)?.[1] ?? ''
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(arcAfterRule).toContain('var(--_khmr-ring)')
    expect(arcAfterRule).toContain('-webkit-mask: radial-gradient(')
    expect(arcAfterRule).toContain('mask: radial-gradient(')

    const overlayCss = readProjectFile(
      'src',
      'renderer',
      'src',
      'assets',
      'kevinHudOverlay.css'
    )
    expect(overlayCss).toContain(
      ".kevin-hud-content[data-memory-only='true']"
    )
    expect(overlayCss).toContain('padding: 0;')
    expect(overlayCss).toContain('--khud-border-color, #A7AD48')

    // The dedicated memory instrument is a historical optical reference. Pin
    // its original 1 px edge, solid fill and 8.5 px icon descriptor instead of
    // following the fresh gradient/2 px/12 px text defaults.
    const visual = resolveKevinHudVisual(LEGACY_MEMORY_REFERENCE_CONFIG, null)
    expect(visual.vars['--khud-height']).toBe('48px')
    expect(visual.vars['--khud-radius']).toBe('24px')
    expect(visual.vars['--khud-border-width']).toBe('1px')
    expect(visual.vars['--khud-border-color']).toBe('#A7AD48')
    expect(visual.vars['--khud-fill']).toBe('rgba(49, 47, 48, 1.000)')
    expect(visual.vars['--khud-background-opacity']).toBe('1.000')
    expect(visual.vars['--khud-foreground-opacity']).toBe('1.000')

    const Overlay = KevinHudOverlay as unknown as FunctionComponent<{
      frame: KevinHudFrame
    }>
    const memoryFrame: KevinHudFrame = {
      phase: 'monitor',
      config: LEGACY_MEMORY_REFERENCE_CONFIG,
      appName: '测试应用',
      iconUrl: null,
      fontFamily: null,
      appGlass: null,
      values: { memory: '9.7 / 31.3 GB · 31%' }
    }
    const defaultHtml = renderToStaticMarkup(createElement(Overlay, { frame: memoryFrame }))
    expect(defaultHtml).toContain('--khmr-value-scale:1')
    expect(defaultHtml).toContain('--khmr-description-scale:1')

    const scaledHtml = renderToStaticMarkup(
      createElement(Overlay, {
        frame: {
          ...memoryFrame,
          config: {
            ...memoryFrame.config,
            itemStyle: {
              ...DEFAULT_KEVIN_HUD_ITEM_STYLE,
              valueSize: 28,
              descriptionSize: 17
            }
          }
        }
      })
    )
    expect(scaledHtml).toContain('--khmr-value-scale:2')
    expect(scaledHtml).toContain('--khmr-description-scale:2')
  })

  it('renders per-metric and merged app identity markup from the unified item style', () => {
    // The component's optional/defaulted props still describe a valid function
    // component; an explicit interface avoids createElement's intrinsic fallback.
    const Overlay = KevinHudOverlay as unknown as FunctionComponent<{
      frame: KevinHudFrame
    }>
    const verticalFrame: KevinHudFrame = {
      phase: 'monitor',
      config: {
        ...DEFAULT_KEVIN_HUD,
        autoWidth: false,
        metrics: ['fps', 'gpu'],
        itemGap: 18,
        contentPadding: 20,
        itemStyle: {
          ...DEFAULT_KEVIN_HUD_ITEM_STYLE,
          orientation: 'vertical',
          description: 'icon',
          gap: 9,
          valueSize: 16,
          valueBold: false
        }
      },
      appName: '测试应用',
      iconUrl: null,
      fontFamily: null,
      appGlass: null,
      values: { fps: '171', gpu: '88%' }
    }
    const html = renderToStaticMarkup(
      createElement(Overlay, { frame: verticalFrame })
    )
    expect(html).toContain('data-orientation="vertical"')
    expect(html).toContain('data-description="icon"')
    expect(html).toContain('kevin-hud-metric-icon')
    expect(html).toContain('data-value-bold="false"')
    expect(html).toContain('--khud-value-width')
    expect(html).toContain('--khud-cell-width')
    expect(html).toContain('--khud-copy-gap:9px')
    expect(html).toContain('--khud-item-gap:18px')

    const identityFrame: KevinHudFrame = {
      ...verticalFrame,
      config: {
        ...verticalFrame.config,
        metrics: ['appName'],
        itemStyles: {
          appName: {
            gap: 11,
            descriptionColor: '#C6CA4C',
            valueColor: '#123456'
          }
        }
      },
      iconUrl: 'app://test-icon.png',
      values: { appName: 'sampled-should-not-show' }
    }
    const identityHtml = renderToStaticMarkup(
      createElement(Overlay, { frame: identityFrame })
    )
    const appNameTag =
      /<div[^>]*data-cell="appName"[^>]*>/.exec(identityHtml)?.[0] ?? ''
    // One ordinary metric cell: unified vertical type, real icon description,
    // actual name value, and the appName-specific gap and two colours.
    expect(appNameTag).toContain('kevin-hud-metric')
    expect(appNameTag).toContain('data-orientation="vertical"')
    expect(appNameTag).toContain('data-description="icon"')
    expect(appNameTag).toContain('data-value-bold="false"')
    expect(appNameTag).toContain('应用名称：测试应用')
    expect(identityHtml).not.toContain('data-cell="appIcon"')
    expect(identityHtml).toContain('kevin-hud-metric-app-icon')
    expect(identityHtml).toContain('flood-color="#C6CA4C"')
    expect(identityHtml).toContain('href="app://test-icon.png"')
    expect(identityHtml).toContain('--khud-copy-gap:11px')
    expect(identityHtml).toContain('--khud-item-description-color:#C6CA4C')
    expect(identityHtml).toContain('--khud-item-value-color:#123456')
    expect(identityHtml).toContain('--khud-item-value-size:16px')
    expect(identityHtml).toContain('测试应用')
    expect(identityHtml).not.toContain('sampled-should-not-show')

    // No description colour and no HUD-wide icon colour keep the original
    // artwork colours.
    const plainIconHtml = renderToStaticMarkup(
      createElement(Overlay, {
        frame: {
          ...identityFrame,
          config: { ...identityFrame.config, itemStyles: {} }
        }
      })
    )
    expect(plainIconHtml).toContain('src="app://test-icon.png"')
    expect(plainIconHtml).not.toContain('flood-color')

    // The HUD-wide icon colour still tints the monitored app icon when no
    // appName-specific description colour overrides it.
    const globalTintHtml = renderToStaticMarkup(
      createElement(Overlay, {
        frame: {
          ...identityFrame,
          config: {
            ...identityFrame.config,
            itemStyles: {},
            iconColor: '#12AB34'
          }
        }
      })
    )
    expect(globalTintHtml).toContain('flood-color="#12AB34"')

    // A missing icon uses the existing Kevin fallback mark.
    const fallbackHtml = renderToStaticMarkup(
      createElement(Overlay, {
        frame: { ...identityFrame, iconUrl: null }
      })
    )
    expect(fallbackHtml).toContain('kevin-hud-icon-mark')

    // A long name is part of the reserve and stays in the existing bank scroll
    // instead of being capped at the old identity width or ellipsized.
    const longName = '崩坏：星穹铁道 — 开拓者档案'.repeat(6)
    const shortNameVisual = resolveKevinHudItemVisual(
      identityFrame.config,
      'appName',
      '原神'
    )
    const longNameVisual = resolveKevinHudItemVisual(
      identityFrame.config,
      'appName',
      longName
    )
    expect(longNameVisual.width).toBeGreaterThan(shortNameVisual.width)
    expect(longNameVisual.valueWidth).toBeGreaterThan(shortNameVisual.valueWidth)
    expect(longNameVisual.width).toBeGreaterThan(360)
    const longHtml = renderToStaticMarkup(
      createElement(Overlay, {
        frame: { ...identityFrame, appName: longName }
      })
    )
    expect(longHtml).toContain(longName)
    const overlayCss = readProjectFile(
      'src',
      'renderer',
      'src',
      'assets',
      'kevinHudOverlay.css'
    )
    const appNameCellRule =
      /\.kevin-hud-cell\[data-cell='appName'\],\s*\.kevin-hud-cell\[data-memory-full='true'\]\s*\{([^}]*)\}/s.exec(
        overlayCss
      )?.[1] ?? ''
    expect(appNameCellRule).toContain('min-width: max-content')
    const copyRule =
      /(?:^|\n)\.kevin-hud-copy\s*\{([^}]*)\}/s.exec(overlayCss)?.[1] ?? ''
    expect(copyRule).toContain('min-width: var(--khud-cell-width')
    expect(overlayCss).not.toContain(
      ".kevin-hud-cell[data-cell='appName'] .kevin-hud-app-name"
    )

    const memoryHtml = renderToStaticMarkup(
      createElement(Overlay, {
        frame: {
          ...verticalFrame,
          config: { ...verticalFrame.config, metrics: ['memory'] },
          values: { memory: '9.7 / 31.3 GB · 31%' }
        }
      })
    )
    expect(memoryHtml).toContain('kevin-hud-memory-readout__glyph')
    expect(memoryHtml).toContain('kevin-hud-memory-readout__used')
    expect(memoryHtml).toContain('kevin-hud-memory-readout__percent-value')
    expect(memoryHtml).toContain('kevin-hud-memory-readout__percent-sign')
    expect(memoryHtml).toContain('--khmr-value-color')
    expect(memoryHtml).toContain('9.7')
    expect(memoryHtml).toContain('31.3')
    expect(memoryHtml).toContain('31%')
  })

  it('keeps values unclipped, tabular and scroll-only on true overflow', () => {
    const css = readProjectFile(
      'src',
      'renderer',
      'src',
      'assets',
      'kevinHudOverlay.css'
    )
    const valueRule = (
      /\.kevin-hud-metric-value\s*\{([^}]*)\}/s.exec(css)?.[1] ?? ''
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(valueRule).toContain('font-variant-numeric: tabular-nums')
    expect(valueRule).not.toContain('text-overflow')
    expect(valueRule).not.toContain('overflow: hidden')
    expect(css).toContain('--khud-item-gap')
    expect(css).toContain('--khud-content-pad-x')
    expect(css).toContain('--khud-min-width')
    expect(css).toContain('--khud-max-width')
    expect(css).toContain('--khud-plate-height')
    expect(css).toContain('height: var(--khud-plate-height')
    expect(css).toContain("[data-orientation='vertical']")
    // Stable per-metric reserves with a zero flex base; free space is shared
    // evenly instead of each sample re-measuring its own content width.
    expect(css).toContain('flex: 1 1 0')
    expect(css).toContain('min-width: max(')
    expect(css).toContain('--khud-cell-width')
    expect(css).toContain('--khud-cell-min-width')
    expect(css).not.toContain('max(2px, var(--khud-copy-gap')
    expect(css).toContain("[data-overflow='true']")

    const overlayTsx = readProjectFile(
      'src',
      'renderer',
      'src',
      'components',
      'KevinHudOverlay.tsx'
    )
    expect(overlayTsx).not.toContain('new MutationObserver')

    const memoryCss = readProjectFile(
      'src',
      'renderer',
      'src',
      'assets',
      'kevinHudMemoryReadout.css'
    )
    expect(memoryCss).toContain('--_khmr-used-size')
    expect(memoryCss).toContain('font-variant-numeric: tabular-nums')
    expect(memoryCss).toContain('overflow: visible')
    expect(memoryCss).toContain("[data-orientation='vertical']")
    expect(memoryCss).toContain('min-inline-size: 5ch')
    expect(memoryCss).toContain('min-inline-size: 4ch')
    expect(memoryCss).not.toContain('max(5px, var(--_khmr-gap)')
    expect(memoryCss).not.toMatch(/__total\s*\{[^}]*display:\s*none/s)
  })
})

describe('KEVIN HUD item alignment and minimum width', () => {
  it('resolves every alignment pair into one deterministic layout mode', () => {
    expect(kevinHudItemAlignment(DEFAULT_KEVIN_HUD_ITEM_STYLE)).toEqual({
      description: 'left',
      value: 'right',
      mode: 'split',
      center: null,
      reverse: false
    })
    expect(
      kevinHudItemAlignment({
        ...DEFAULT_KEVIN_HUD_ITEM_STYLE,
        descriptionAlign: 'center',
        valueAlign: 'center'
      })
    ).toMatchObject({ mode: 'center', center: null })
    expect(
      kevinHudItemAlignment({
        ...DEFAULT_KEVIN_HUD_ITEM_STYLE,
        descriptionAlign: 'right',
        valueAlign: 'right'
      })
    ).toMatchObject({ mode: 'right', center: null })
    expect(
      kevinHudItemAlignment({
        ...DEFAULT_KEVIN_HUD_ITEM_STYLE,
        descriptionAlign: 'left',
        valueAlign: 'center'
      })
    ).toMatchObject({ mode: 'mixed', center: 'value' })
    expect(
      kevinHudItemAlignment({
        ...DEFAULT_KEVIN_HUD_ITEM_STYLE,
        descriptionAlign: 'right',
        valueAlign: 'left'
      })
    ).toMatchObject({ mode: 'split', reverse: true })
  })

  it('honors global and per-item minWidth/alignment without capping content', () => {
    const config: KevinHudConfig = {
      ...DEFAULT_KEVIN_HUD,
      metrics: ['fps', 'gpu', 'appName'],
      itemStyle: {
        ...DEFAULT_KEVIN_HUD_ITEM_STYLE,
        minWidth: 420,
        descriptionAlign: 'right',
        valueAlign: 'center'
      },
      itemStyles: {
        fps: {
          minWidth: 320,
          descriptionAlign: 'center',
          valueAlign: 'left'
        }
      }
    }
    expect(resolveKevinHudItemStyle(config, 'fps')).toMatchObject({
      gap: DEFAULT_KEVIN_HUD_ITEM_STYLE.gap,
      minWidth: 320,
      descriptionAlign: 'center',
      valueAlign: 'left'
    })
    expect(resolveKevinHudItemStyle(config, 'gpu')).toMatchObject({
      minWidth: 420,
      descriptionAlign: 'right',
      valueAlign: 'center'
    })

    const fps = resolveKevinHudItemVisual(config, 'fps')
    expect(fps.width).toBeGreaterThanOrEqual(320)
    expect(fps.vars['--khud-cell-min-width']).toBe('320px')
    expect(fps.vars['--khud-description-align']).toBe('center')
    expect(fps.vars['--khud-value-align']).toBe('left')
    expect(fps.vars['--khud-copy-gap']).toBe(
      `${DEFAULT_KEVIN_HUD_ITEM_STYLE.gap}px`
    )

    const gpu = resolveKevinHudItemVisual(config, 'gpu')
    expect(gpu.width).toBeGreaterThanOrEqual(420)
    expect(gpu.vars['--khud-cell-min-width']).toBe('420px')

    // A long actual app name still outgrows the configured floor instead of
    // being clipped or capped by it.
    const shortName = resolveKevinHudItemVisual(
      { ...config, itemStyle: { ...DEFAULT_KEVIN_HUD_ITEM_STYLE, minWidth: 0 } },
      'appName',
      '原神'
    )
    const longName = resolveKevinHudItemVisual(
      { ...config, itemStyle: { ...DEFAULT_KEVIN_HUD_ITEM_STYLE, minWidth: 0 } },
      'appName',
      '崩坏：星穹铁道 — 开拓者档案'.repeat(8)
    )
    expect(longName.width).toBeGreaterThan(shortName.width)
    expect(longName.width).toBeGreaterThan(360)
  })

  it('renders same-side groups, opposite sides and vertical mixed alignment markup', () => {
    const Overlay = KevinHudOverlay as unknown as FunctionComponent<{
      frame: KevinHudFrame
    }>
    const frame = (config: KevinHudConfig): KevinHudFrame => ({
      phase: 'monitor',
      config,
      appName: '测试应用',
      iconUrl: null,
      fontFamily: null,
      appGlass: null,
      values: { fps: '171 FPS', cpu: '12%', sessionTime: '1:02:03' }
    })

    const centered = renderToStaticMarkup(
      createElement(Overlay, {
        frame: frame({
          ...DEFAULT_KEVIN_HUD,
          metrics: ['fps', 'cpu'],
          itemStyle: {
            ...DEFAULT_KEVIN_HUD_ITEM_STYLE,
            gap: 12,
            minWidth: 160,
            descriptionAlign: 'center',
            valueAlign: 'center'
          }
        })
      })
    )
    expect(centered.match(/data-align-mode="center"/g)?.length).toBe(2)
    expect(centered.match(/data-description-align="center"/g)?.length).toBe(2)
    expect(centered.match(/data-value-align="center"/g)?.length).toBe(2)
    expect(centered).toContain('--khud-cell-min-width:160px')
    expect(centered).toContain('--khud-copy-gap:12px')

    const reversed = renderToStaticMarkup(
      createElement(Overlay, {
        frame: frame({
          ...DEFAULT_KEVIN_HUD,
          metrics: ['fps'],
          itemStyle: {
            ...DEFAULT_KEVIN_HUD_ITEM_STYLE,
            descriptionAlign: 'right',
            valueAlign: 'left'
          }
        })
      })
    )
    expect(reversed).toContain('data-align-mode="split"')
    expect(reversed).toContain('data-align-reverse="true"')

    const vertical = renderToStaticMarkup(
      createElement(Overlay, {
        frame: frame({
          ...DEFAULT_KEVIN_HUD,
          metrics: ['appName', 'fps'],
          itemStyle: {
            ...DEFAULT_KEVIN_HUD_ITEM_STYLE,
            orientation: 'vertical',
            gap: 9,
            minWidth: 140,
            descriptionAlign: 'right',
            valueAlign: 'left'
          }
        })
      })
    )
    expect(vertical.match(/data-orientation="vertical"/g)?.length).toBe(2)
    expect(vertical.match(/data-description-align="right"/g)?.length).toBe(2)
    expect(vertical.match(/data-value-align="left"/g)?.length).toBe(2)

    const css = readProjectFile(
      'src',
      'renderer',
      'src',
      'assets',
      'kevinHudOverlay.css'
    )
    const centerRule = (
      /\[data-align-mode='center'\]\s+\.kevin-hud-copy\s*\{([^}]*)\}/s.exec(css)?.[1] ?? ''
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(centerRule).toContain('justify-content: center')
    expect(css).toContain('grid-template-columns: minmax(max-content, 1fr) auto 1fr')
    expect(css).toContain('grid-template-columns: 1fr auto minmax(max-content, 1fr)')
    expect(css).toContain("[data-align-reverse='true']")
    expect(css).toContain('margin-inline-end: var(--khud-copy-gap')
    expect(css).toContain('margin-inline-start: var(--khud-copy-gap')
    const verticalCopyRule = (
      /\.kevin-hud-metric\[data-orientation='vertical'\]\s+\.kevin-hud-copy\s*\{([^}]*)\}/s.exec(css)?.[1] ?? ''
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(verticalCopyRule).toContain('flex-direction: column')
    expect(verticalCopyRule).toContain('row-gap: var(--khud-copy-gap')
    expect(css).toMatch(
      /\.kevin-hud-metric\[data-orientation='vertical'\]\s+\.kevin-hud-metric-description\[data-align='right'\]/
    )
    expect(css).toMatch(
      /\.kevin-hud-metric\[data-orientation='vertical'\]\s+\.kevin-hud-metric-value\[data-align='left'\]/
    )
  })

  it('keeps the reference memory gauge and switches custom alignment to full data', () => {
    const Overlay = KevinHudOverlay as unknown as FunctionComponent<{
      frame: KevinHudFrame
    }>
    const frame = (config: KevinHudConfig): KevinHudFrame => ({
      phase: 'monitor',
      config,
      appName: '测试应用',
      iconUrl: null,
      fontFamily: null,
      appGlass: null,
      values: { memory: '9.7 / 31.3 GB · 31%' }
    })

    const gauge = renderToStaticMarkup(
      createElement(Overlay, {
        frame: frame(LEGACY_MEMORY_REFERENCE_CONFIG)
      })
    )
    expect(gauge).toContain('kevin-hud-memory-readout')
    expect(gauge).toContain('data-memory-mode="gauge"')
    expect(gauge).toContain('data-memory-only="true"')

    // The dedicated instrument still owns the default vertical pair; the
    // alignment-based switch is the shared condition, not only horizontal.
    const verticalGauge = renderToStaticMarkup(
      createElement(Overlay, {
        frame: frame({
          ...LEGACY_MEMORY_REFERENCE_CONFIG,
          itemStyle: {
            ...LEGACY_MEMORY_REFERENCE_CONFIG.itemStyle,
            orientation: 'vertical'
          }
        })
      })
    )
    expect(verticalGauge).toContain('kevin-hud-memory-readout')
    expect(verticalGauge).toContain('data-orientation="vertical"')

    const custom = renderToStaticMarkup(
      createElement(Overlay, {
        frame: frame({
          ...LEGACY_MEMORY_REFERENCE_CONFIG,
          itemStyle: {
            ...LEGACY_MEMORY_REFERENCE_CONFIG.itemStyle,
            minWidth: 360,
            descriptionAlign: 'center',
            valueAlign: 'left'
          }
        })
      })
    )
    expect(custom).toContain('data-memory-mode="aligned"')
    expect(custom).toContain('data-memory-full="true"')
    expect(custom).toContain('data-align-mode="mixed"')
    expect(custom).toContain('data-align-center="description"')
    expect(custom).toContain('9.7 / 31.3 GB · 31%')
    expect(custom).toContain('--khud-cell-min-width:360px')
    expect(custom).not.toContain('kevin-hud-memory-readout')
  })

  it('uses the shared 2px lime CSS fallback without forcing a saved zero border', () => {
    const css = readProjectFile(
      'src',
      'renderer',
      'src',
      'assets',
      'kevinHudOverlay.css'
    )
    expect(css).toContain(
      'border: var(--khud-border-width, 2px) solid var(--khud-border-color, #A7AD48)'
    )
    expect(css).toContain(
      'border: 1px solid var(--khud-border-color, #A7AD48)'
    )

    const legacy = resolveKevinHudVisual(
      { ...DEFAULT_KEVIN_HUD, borderWidth: 0, borderColor: '#656363' },
      null
    )
    expect(legacy.vars['--khud-border-width']).toBe('0px')
    expect(legacy.vars['--khud-border-color']).toBe('#656363')
  })
})

describe('KEVIN HUD motion contract', () => {
  it('keeps the coordinator close delay equal to the renderer timeline', () => {
    expect(KEVIN_HUD_MOTION_TOTAL_MS).toBe(600)
    expect(KEVIN_HUD_CLOSE_DELAY_MS).toBe(KEVIN_HUD_MOTION_TOTAL_MS)
  })

  it('orders one short beat so items and frame finish together', () => {
    expect(KEVIN_HUD_PLATE_POP_MS).toBe(36)
    expect(KEVIN_HUD_GEOMETRY_PEAK_MS).toBe(240)
    expect(KEVIN_HUD_ICON_GLIDE_START_MS).toBe(72)
    expect(KEVIN_HUD_ICON_GLIDE_END_MS).toBe(330)
    expect(KEVIN_HUD_TITLE_SHOWN_MS).toBe(480)
    expect(KEVIN_HUD_PLATE_POP_MS).toBeLessThan(KEVIN_HUD_GEOMETRY_PEAK_MS)
    expect(KEVIN_HUD_GEOMETRY_PEAK_MS).toBeLessThan(KEVIN_HUD_ICON_GLIDE_END_MS)
    expect(KEVIN_HUD_ICON_GLIDE_START_MS).toBeLessThan(KEVIN_HUD_ICON_GLIDE_END_MS)
    expect(KEVIN_HUD_ICON_GLIDE_END_MS).toBeLessThan(KEVIN_HUD_TITLE_SHOWN_MS)
    expect(KEVIN_HUD_TITLE_SHOWN_MS).toBeLessThan(KEVIN_HUD_MOTION_TOTAL_MS)
    expect(KEVIN_HUD_REVEAL_BASE_DELAY_MS).toBeGreaterThan(0)
    expect(KEVIN_HUD_REVEAL_DURATION_MS).toBeGreaterThan(0)
    expect(KEVIN_HUD_REVEAL_DURATION_MS).toBeLessThan(KEVIN_HUD_MOTION_TOTAL_MS)
    expect(KEVIN_HUD_REVEAL_STAGGER_MS).toBeGreaterThan(0)
    expect(KEVIN_HUD_REVEAL_MAX_DELAY_MS).toBeLessThanOrEqual(
      KEVIN_HUD_REVEAL_BASE_DELAY_MS + 4 * KEVIN_HUD_REVEAL_STAGGER_MS
    )
    // Items open a few tens of milliseconds after the plate and finish just
    // after the frame shapes. The exit mirrors the entrance on the shared
    // 600 ms clock: it starts at 308–340 ms, only a few frames before the
    // plate begins contracting (TOTAL - GEOMETRY_PEAK), and every slot is gone
    // before the reversed timeline ends.
    const revealEnd =
      KEVIN_HUD_REVEAL_MAX_DELAY_MS + KEVIN_HUD_REVEAL_DURATION_MS
    const plateExitStart = KEVIN_HUD_MOTION_TOTAL_MS - KEVIN_HUD_GEOMETRY_PEAK_MS
    const revealExitStart =
      KEVIN_HUD_MOTION_TOTAL_MS -
      KEVIN_HUD_REVEAL_DURATION_MS -
      KEVIN_HUD_REVEAL_MAX_DELAY_MS
    const revealExitEnd =
      KEVIN_HUD_MOTION_TOTAL_MS - KEVIN_HUD_REVEAL_BASE_DELAY_MS
    expect(KEVIN_HUD_REVEAL_BASE_DELAY_MS).toBeLessThan(KEVIN_HUD_GEOMETRY_PEAK_MS)
    expect(revealEnd).toBeGreaterThan(KEVIN_HUD_GEOMETRY_PEAK_MS)
    expect(revealEnd).toBeLessThan(KEVIN_HUD_MOTION_TOTAL_MS)
    expect(revealExitStart).toBeLessThan(plateExitStart)
    expect(plateExitStart - revealExitStart).toBe(
      revealEnd - KEVIN_HUD_GEOMETRY_PEAK_MS
    )
    expect(revealExitEnd).toBeLessThan(KEVIN_HUD_CLOSE_DELAY_MS)
  })

  it('uses one reversible CSS timeline with a bounded overflow-only loop', () => {
    const css = readProjectFile(
      'src',
      'renderer',
      'src',
      'assets',
      'kevinHudOverlay.css'
    )
    expect(css).toContain('@keyframes kevin-hud-plate')
    expect(css).toContain('@keyframes kevin-hud-icon')
    expect(css).toContain('@keyframes kevin-hud-title')
    expect(css).toContain('@keyframes kevin-hud-reveal')
    expect(css).toContain('@keyframes kevin-hud-scroll')
    expect(css).toContain('@keyframes kevin-hud-plate-exit')
    expect(css).toContain('@keyframes kevin-hud-reveal-exit')
    expect(css.match(/animation-direction: reverse/g)?.length).toBeGreaterThanOrEqual(4)
    expect(css.match(/infinite/g)?.length).toBe(1)
    expect(css).toContain("[data-overflow='true']")
    expect(css).toContain('animation-play-state: paused')
    expect(css).not.toContain('--khud-expanded-height, 72px')
    expect(css).not.toContain('infinite alternate 2')
    expect(css).not.toContain('kevin-hud-surface-out')
    expect(css).not.toContain('kevin-hud-weave')
    expect(css).not.toContain('kevin-hud-subline')
    expect(css).not.toContain('kevin-hud-cap')
    expect(css).toContain("data-background='solid'")
    expect(css).toContain('prefers-reduced-motion: reduce')
    expect(css).toContain('font-family: var(--app-font')
    expect(css).not.toContain('fontStack')
  })

  it('installs launcher fonts through the shared helper, not an inline stack', () => {
    const overlay = readProjectFile(
      'src',
      'renderer',
      'src',
      'components',
      'KevinHudOverlay.tsx'
    )
    expect(overlay).toContain("from '../launcherTypography'")
    expect(overlay).toContain('applyLauncherTypography(document')
    expect(overlay).toContain('fontFamilyEn')
    expect(overlay).toContain('fontFamilyZh')
    expect(overlay).not.toContain('fontStack')
    expect(overlay).not.toContain('Microsoft YaHei UI')
  })
})
