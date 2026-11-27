import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KEVIN_HUD_GRADIENT,
  isKevinHudGradient,
  kevinHudGradientCss,
  normalizeKevinHudGradient
} from '../src/shared/kevinHudBackground'
import type { KevinHudGradient } from '../src/shared/kevinHudBackground'

const CUSTOM_GRADIENT: KevinHudGradient = {
  kind: 'linear',
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

const stop = (color: string, position: number) => ({ color, position })

const defaultCss = 'linear-gradient(90deg, #1F1D1E 0%, #302E2F 100%)'

describe('KEVIN HUD gradient defaults', () => {
  it('defines the quiet charcoal reference gradient exactly', () => {
    expect(DEFAULT_KEVIN_HUD_GRADIENT).toEqual({
      kind: 'linear',
      angle: 90,
      centerX: 50,
      centerY: 50,
      shape: 'ellipse',
      stops: [
        { color: '#1F1D1E', position: 0 },
        { color: '#302E2F', position: 100 }
      ]
    })
    expect(isKevinHudGradient(DEFAULT_KEVIN_HUD_GRADIENT)).toBe(true)
    expect(kevinHudGradientCss(DEFAULT_KEVIN_HUD_GRADIENT)).toBe(defaultCss)
  })

  it('normalizes into independent objects, arrays and stop entries', () => {
    const source = {
      ...CUSTOM_GRADIENT,
      stops: CUSTOM_GRADIENT.stops.map((entry) => ({ ...entry }))
    }
    const first = normalizeKevinHudGradient(source)
    const second = normalizeKevinHudGradient(source)

    expect(first).not.toBe(source)
    expect(first.stops).not.toBe(source.stops)
    expect(first.stops[0]).not.toBe(source.stops[0])
    expect(second).not.toBe(first)
    expect(second.stops).not.toBe(first.stops)
    expect(second.stops[0]).not.toBe(first.stops[0])

    first.stops[0].color = '#FFFFFF'
    first.stops.push(stop('#000000', 75))
    expect(second).toEqual(CUSTOM_GRADIENT)
    expect(source).toEqual(CUSTOM_GRADIENT)

    const firstFallback = normalizeKevinHudGradient(undefined)
    const secondFallback = normalizeKevinHudGradient({ stops: [] })
    expect(firstFallback).toEqual(DEFAULT_KEVIN_HUD_GRADIENT)
    expect(firstFallback).not.toBe(DEFAULT_KEVIN_HUD_GRADIENT)
    expect(firstFallback.stops).not.toBe(DEFAULT_KEVIN_HUD_GRADIENT.stops)
    expect(firstFallback.stops[0]).not.toBe(DEFAULT_KEVIN_HUD_GRADIENT.stops[0])
    firstFallback.stops[0].color = '#000000'
    expect(secondFallback.stops[0].color).toBe('#1F1D1E')
    expect(DEFAULT_KEVIN_HUD_GRADIENT.stops[0].color).toBe('#1F1D1E')
  })
})

describe('KEVIN HUD gradient CSS', () => {
  it('serializes all three kinds and keeps every field when the kind changes', () => {
    const stops = ' #112233 0%, #445566 50%, #778899 100%'

    expect(kevinHudGradientCss({ ...CUSTOM_GRADIENT, kind: 'linear' })).toBe(
      `linear-gradient(135deg,${stops})`
    )
    expect(kevinHudGradientCss({ ...CUSTOM_GRADIENT, kind: 'radial' })).toBe(
      `radial-gradient(circle at 25% 75%,${stops})`
    )
    expect(kevinHudGradientCss({ ...CUSTOM_GRADIENT, kind: 'conic' })).toBe(
      `conic-gradient(from 135deg at 25% 75%,${stops})`
    )

    for (const kind of ['linear', 'radial', 'conic'] as const) {
      expect(normalizeKevinHudGradient({ ...CUSTOM_GRADIENT, kind })).toMatchObject({
        kind,
        angle: 135,
        centerX: 25,
        centerY: 75,
        shape: 'circle',
        stops: CUSTOM_GRADIENT.stops
      })
    }
  })

  it('preserves the configured stop sequence', () => {
    const ordered = normalizeKevinHudGradient({
      ...CUSTOM_GRADIENT,
      kind: 'conic',
      stops: [
        stop('#FF0000', 80),
        stop('#00FF00', 10),
        stop('#0000FF', 50)
      ]
    })
    expect(ordered.stops).toEqual([
      stop('#FF0000', 80),
      stop('#00FF00', 10),
      stop('#0000FF', 50)
    ])
    expect(kevinHudGradientCss(ordered)).toBe(
      'conic-gradient(from 135deg at 25% 75%, ' +
      '#FF0000 80%, #00FF00 10%, #0000FF 50%)'
    )
    expect(isKevinHudGradient(ordered)).toBe(true)
  })

  it('ignores foreground/background opacity fields', () => {
    const opaque = {
      ...CUSTOM_GRADIENT,
      foregroundOpacity: 0.2,
      backgroundOpacity: 0.4
    }
    expect(normalizeKevinHudGradient(opaque)).toEqual(CUSTOM_GRADIENT)
    expect(Object.hasOwn(normalizeKevinHudGradient(opaque), 'foregroundOpacity')).toBe(false)
    expect(kevinHudGradientCss(opaque)).toBe(kevinHudGradientCss(CUSTOM_GRADIENT))
  })
})

describe('KEVIN HUD gradient normalization', () => {
  it('repairs malformed imports and clamps finite values', () => {
    const repaired = normalizeKevinHudGradient({
      kind: 'diagonal',
      angle: -20,
      centerX: 140,
      centerY: Number.NaN,
      shape: 'square',
      stops: [
        { color: ' #AABBCC ', position: -5 },
        { color: '#001122', position: 140 }
      ]
    })
    expect(repaired).toEqual({
      kind: 'linear',
      angle: 0,
      centerX: 100,
      centerY: 50,
      shape: 'ellipse',
      stops: [
        { color: '#AABBCC', position: 0 },
        { color: '#001122', position: 100 }
      ]
    })
    expect(isKevinHudGradient(repaired)).toBe(true)

    for (const stops of [
      undefined,
      'not-a-list',
      [],
      [stop('#123456', 0)],
      [stop('red', 0), stop('#123456', 100)],
      [stop('#123456', 0), stop('#654321', Number.POSITIVE_INFINITY)]
    ]) {
      expect(normalizeKevinHudGradient({ stops }).stops).toEqual(
        DEFAULT_KEVIN_HUD_GRADIENT.stops
      )
    }
  })

  it('enforces the 2..5 stop contract and rejects non-normalized data', () => {
    const fiveStops = [0, 25, 50, 75, 100].map((position) =>
      stop('#123456', position)
    )
    expect(normalizeKevinHudGradient({ stops: fiveStops }).stops).toEqual(fiveStops)

    const sixStops = [...fiveStops, stop('#654321', 100)]
    expect(normalizeKevinHudGradient({ stops: sixStops }).stops).toEqual(fiveStops)

    expect(isKevinHudGradient({
      ...DEFAULT_KEVIN_HUD_GRADIENT,
      stops: fiveStops
    })).toBe(true)
    expect(isKevinHudGradient({
      ...DEFAULT_KEVIN_HUD_GRADIENT,
      stops: sixStops
    })).toBe(false)
    expect(isKevinHudGradient({
      ...DEFAULT_KEVIN_HUD_GRADIENT,
      stops: [stop('#123456', 0)]
    })).toBe(false)
    expect(isKevinHudGradient({
      ...DEFAULT_KEVIN_HUD_GRADIENT,
      stops: [stop('#fff', 0), stop('#123456', 100)]
    })).toBe(false)
    expect(isKevinHudGradient({ ...CUSTOM_GRADIENT, angle: 361 })).toBe(false)
    expect(isKevinHudGradient({ ...CUSTOM_GRADIENT, centerX: -1 })).toBe(false)
    expect(isKevinHudGradient({ ...CUSTOM_GRADIENT, shape: 'square' })).toBe(false)
    expect(isKevinHudGradient(null)).toBe(false)
  })

  it('keeps CSS safe even when the type guard is bypassed at runtime', () => {
    const malformed = {
      ...CUSTOM_GRADIENT,
      kind: 'radial',
      angle: Number.NaN,
      centerX: Number.POSITIVE_INFINITY,
      centerY: Number.NEGATIVE_INFINITY,
      stops: [
        { color: 'red; background-image: url(https://example.test/x)', position: -1 },
        { color: '#000000', position: Number.NaN }
      ]
    } as unknown as KevinHudGradient

    const css = kevinHudGradientCss(malformed)
    expect(css).toBe(
      'radial-gradient(circle at 50% 50%, #1F1D1E 0%, #302E2F 100%)'
    )
    expect(css).not.toMatch(/NaN|Infinity|red|url\(|example\.test/)
    expect(() => kevinHudGradientCss(null as unknown as KevinHudGradient)).not.toThrow()
    expect(kevinHudGradientCss(null as unknown as KevinHudGradient)).toBe(defaultCss)
  })
})
