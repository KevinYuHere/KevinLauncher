/**
 * Shared background-gradient contract for the KEVIN HUD.
 *
 * This module is intentionally pure: it owns the persisted gradient shape and
 * its CSS serialization, but no opacity or renderer state. The HUD config only
 * uses this value when `backgroundMode === 'gradient'`; the default below has
 * no effect on the existing solid/app/custom modes.
 */
export type KevinHudGradientKind = 'linear' | 'radial' | 'conic'
export type KevinHudGradientShape = 'ellipse' | 'circle'

export interface KevinHudGradientStop {
  /** Six-digit hex colour (`#RRGGBB`). */
  color: string
  /** Position along the gradient, 0…100 percent. */
  position: number
}

export interface KevinHudGradient {
  kind: KevinHudGradientKind
  /** Gradient angle in degrees, 0…360. */
  angle: number
  /** Horizontal centre, 0…100 percent. */
  centerX: number
  /** Vertical centre, 0…100 percent. */
  centerY: number
  /** Radial gradient shape; retained by every kind so switching is lossless. */
  shape: KevinHudGradientShape
  /** Ordered stops, 2…5 entries. */
  stops: KevinHudGradientStop[]
}

/**
 * Quiet charcoal-to-charcoal reference fill. The full configuration remains
 * valid regardless of the selected background mode.
 */
export const DEFAULT_KEVIN_HUD_GRADIENT: KevinHudGradient = {
  kind: 'linear',
  angle: 90,
  centerX: 50,
  centerY: 50,
  shape: 'ellipse',
  stops: [
    { color: '#1F1D1E', position: 0 },
    { color: '#302E2F', position: 100 }
  ]
}

const MIN_STOPS = 2
const MAX_STOPS = 5
const HEX_COLOR = /^#[\da-f]{6}$/i
const GRADIENT_KINDS = new Set<string>(['linear', 'radial', 'conic'])
const GRADIENT_SHAPES = new Set<string>(['ellipse', 'circle'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isFiniteInRange = (value: unknown, min: number, max: number): value is number =>
  isFiniteNumber(value) && value >= min && value <= max

const isHexColor = (value: unknown): value is string =>
  typeof value === 'string' && HEX_COLOR.test(value.trim())

const isGradientKind = (value: unknown): value is KevinHudGradientKind =>
  typeof value === 'string' && GRADIENT_KINDS.has(value)

const isGradientShape = (value: unknown): value is KevinHudGradientShape =>
  typeof value === 'string' && GRADIENT_SHAPES.has(value)

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const pickNumber = (value: unknown, fallback: number, min: number, max: number): number =>
  isFiniteNumber(value) ? clamp(value, min, max) : fallback

const copyDefaultStops = (): KevinHudGradientStop[] =>
  DEFAULT_KEVIN_HUD_GRADIENT.stops.map(({ color, position }) => ({ color, position }))

/**
 * A stop list is one coherent ordered sequence. Invalid entries replace the
 * whole sequence with the default rather than silently changing its meaning;
 * extra entries beyond the supported five are ignored.
 */
function normalizeStops(value: unknown): KevinHudGradientStop[] {
  if (!Array.isArray(value) || value.length < MIN_STOPS) return copyDefaultStops()
  const stops: KevinHudGradientStop[] = []
  for (const entry of value.slice(0, MAX_STOPS)) {
    if (!isRecord(entry) || !isHexColor(entry.color) || !isFiniteNumber(entry.position)) {
      return copyDefaultStops()
    }
    stops.push({
      color: entry.color.trim(),
      position: clamp(entry.position, 0, 100)
    })
  }
  return stops.length >= MIN_STOPS ? stops : copyDefaultStops()
}

/**
 * Return a complete, validated gradient. The result is always a deep copy:
 * even an already-valid input gets a fresh object, stop array and stop objects.
 * Finite out-of-range numbers are clamped; structurally invalid values fall
 * back to the corresponding default.
 */
export function normalizeKevinHudGradient(value: unknown): KevinHudGradient {
  const source = isRecord(value) ? value : {}
  return {
    kind: isGradientKind(source.kind) ? source.kind : DEFAULT_KEVIN_HUD_GRADIENT.kind,
    angle: pickNumber(source.angle, DEFAULT_KEVIN_HUD_GRADIENT.angle, 0, 360),
    centerX: pickNumber(source.centerX, DEFAULT_KEVIN_HUD_GRADIENT.centerX, 0, 100),
    centerY: pickNumber(source.centerY, DEFAULT_KEVIN_HUD_GRADIENT.centerY, 0, 100),
    shape: isGradientShape(source.shape) ? source.shape : DEFAULT_KEVIN_HUD_GRADIENT.shape,
    stops: normalizeStops(source.stops)
  }
}

/** Validate an already-normalized gradient (for example a config write guard). */
export function isKevinHudGradient(value: unknown): value is KevinHudGradient {
  if (!isRecord(value)) return false
  if (!isGradientKind(value.kind) || !isGradientShape(value.shape)) return false
  if (!isFiniteInRange(value.angle, 0, 360)) return false
  if (!isFiniteInRange(value.centerX, 0, 100)) return false
  if (!isFiniteInRange(value.centerY, 0, 100)) return false
  if (!Array.isArray(value.stops) || value.stops.length < MIN_STOPS ||
    value.stops.length > MAX_STOPS) {
    return false
  }
  return value.stops.every((stop) =>
    isRecord(stop) &&
    isHexColor(stop.color) &&
    isFiniteInRange(stop.position, 0, 100)
  )
}

const cssNumber = (value: number): string => String(value)

/**
 * Serialize a gradient for the `background-image` property.
 *
 * Normalization happens even when the caller bypasses the type guard, so the
 * result can only contain verified six-digit colours, finite clamped numbers
 * and literal CSS syntax. Stop order is preserved.
 */
export function kevinHudGradientCss(value: KevinHudGradient): string {
  const gradient = normalizeKevinHudGradient(value)
  const stops = gradient.stops
    .map((stop) => `${stop.color} ${cssNumber(stop.position)}%`)
    .join(', ')
  const center = `${cssNumber(gradient.centerX)}% ${cssNumber(gradient.centerY)}%`

  switch (gradient.kind) {
    case 'radial':
      return `radial-gradient(${gradient.shape} at ${center}, ${stops})`
    case 'conic':
      return `conic-gradient(from ${cssNumber(gradient.angle)}deg at ${center}, ${stops})`
    case 'linear':
    default:
      return `linear-gradient(${cssNumber(gradient.angle)}deg, ${stops})`
  }
}
