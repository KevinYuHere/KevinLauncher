import { DEFAULT_GLASS_APPEARANCE, type GlassAppearance } from '@shared/types'
import { updateChromeContrast } from './contrast'
import { setLiquidMaterial } from './liquidMaterial'

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!match) return null
  const value = parseInt(match[1], 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

function lighten(hex: string, amount: number): string {
  const color = parseHex(hex)
  if (!color) return hex
  const mix = (v: number): string =>
    Math.round(v + (255 - v) * amount)
      .toString(16)
      .padStart(2, '0')
  return `#${mix(color.r)}${mix(color.g)}${mix(color.b)}`
}

/** WCAG relative luminance (0 = black, 1 = white). */
function relativeLuminance(color: { r: number; g: number; b: number }): number {
  const channel = (value: number): number => {
    const s = value / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

/** Default accent (matches the CSS `--brand`), used when an app has no theme colour. */
const DEFAULT_BRAND = '#3778e5'

/**
 * Foreground of text/icons drawn **directly over the game background** (page
 * titles, pools bar, rail, game row, window buttons). Black or white, chosen by
 * the theme colour's luminance. (Glass surfaces use `--fg*` instead.)
 */
function applyChromeForeground(hex: string | null): void {
  const color = parseHex(hex ?? DEFAULT_BRAND) ?? { r: 55, g: 120, b: 229 }
  const rgb = relativeLuminance(color) > 0.5 ? '16, 19, 26' : '255, 255, 255'
  const root = document.documentElement
  root.style.setProperty('--chrome-fg', `rgba(${rgb}, 1)`)
  root.style.setProperty('--chrome-fg-2', `rgba(${rgb}, 0.72)`)
  root.style.setProperty('--chrome-fg-3', `rgba(${rgb}, 0.5)`)
}

/** Apply (or reset) the accent colour used across the whole UI. */
export function applyTheme(hex: string | null): void {
  const root = document.documentElement
  applyChromeForeground(hex)
  if (!hex) {
    root.style.removeProperty('--brand')
    root.style.removeProperty('--brand-hover')
    root.style.removeProperty('--brand-dim')
    root.style.removeProperty('--brand-line')
    root.style.removeProperty('--on-brand')
    root.style.removeProperty('--on-brand-soft')
    return
  }
  const color = parseHex(hex)
  root.style.setProperty('--brand', hex)
  root.style.setProperty('--brand-hover', lighten(hex, 0.18))
  if (color) {
    root.style.setProperty('--brand-dim', `rgba(${color.r}, ${color.g}, ${color.b}, 0.18)`)
    root.style.setProperty('--brand-line', `rgba(${color.r}, ${color.g}, ${color.b}, 0.5)`)
    // Text / icons drawn on top of the accent colour. Bright accents (close to
    // white) need dark foregrounds to stay legible.
    const light = relativeLuminance(color) > 0.5
    root.style.setProperty('--on-brand', light ? '#10131a' : '#ffffff')
    root.style.setProperty(
      '--on-brand-soft',
      light ? 'rgba(16, 19, 26, 0.6)' : 'rgba(255, 255, 255, 0.6)'
    )
  }
}

/** A glass surface token: tint endpoints + the alpha at "no background" / "clear". */
interface SurfaceToken {
  name: string
  dark: [number, number, number]
  light: [number, number, number]
  /** alpha when `opacity` = 0 (opaque, no background influence). */
  aOpaque: number
  /** alpha when `opacity` = 100 (fully see-through). */
  aClear: number
}

/**
 * Surface tokens: the **tint** follows `brightness`, the **alpha** follows
 * `opacity`. At opacity 0 the surface is opaque (background invisible → no
 * material), and growing opacity lets the backdrop (blur/refraction) show.
 */
const SURFACE_TOKENS: SurfaceToken[] = [
  // aClear = 0 → at opacity 100 the surface adds *no* black/white at all.
  { name: '--glass', dark: [18, 20, 26], light: [255, 255, 255], aOpaque: 1, aClear: 0 },
  { name: '--glass-2', dark: [18, 20, 26], light: [255, 255, 255], aOpaque: 1, aClear: 0 },
  { name: '--glass-overlay', dark: [18, 20, 26], light: [255, 255, 255], aOpaque: 1, aClear: 0 }
]

/** Tint-only tokens still interpolated between dark and light by brightness. */
type Rgba = [number, number, number, number]
const TINT_TOKENS: { name: string; dark: Rgba; light: Rgba }[] = [
  { name: '--glass-hover', dark: [255, 255, 255, 0.12], light: [0, 0, 0, 0.06] },
  { name: '--field-bg', dark: [0, 0, 0, 0.28], light: [0, 0, 0, 0.1] },
  { name: '--line', dark: [255, 255, 255, 0.14], light: [0, 0, 0, 0.12] },
  { name: '--line-strong', dark: [255, 255, 255, 0.26], light: [0, 0, 0, 0.22] }
]

/** Foreground presets, with the alpha used by each `--fg-N` token. */
const FG_LIGHT = '255, 255, 255'
const FG_DARK = '24, 27, 34'
const FG_ALPHA = ['1', '0.72', '0.5', '0.32']

/** Backdrop scrim: interpolated dark → light with the brightness (no hard flip). */
const SCRIM_DARK: [number, number, number] = [8, 10, 15]
const SCRIM_LIGHT: [number, number, number] = [236, 240, 246]

const mix = (a: number, b: number, t: number): number => a + (b - a) * t

/** A tiled SVG fractal-noise data URI whose alpha encodes the grain strength. */
function grainDataUri(grain: number): string {
  const a = ((Math.max(0, Math.min(100, grain)) / 100) * 0.6).toFixed(3)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">` +
    `<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/>` +
    `<feColorMatrix type="saturate" values="0"/>` +
    `<feComponentTransfer><feFuncA type="table" tableValues="0 ${a}"/></feComponentTransfer></filter>` +
    `<rect width="100%" height="100%" filter="url(#n)"/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

const SHEEN =
  'linear-gradient(120deg, rgba(255,255,255,0) 30%, rgba(255,255,255,0.2) 47%, rgba(255,255,255,0) 64%)'

/**
 * Apply the app's glass appearance.
 *
 * `brightness` tints the surfaces (and the scrim, continuously); `opacity`
 * decides how much the backdrop is allowed through. The foreground **inside
 * glass** (`--fg*`) switches black/white by a contrast threshold on `brightness`.
 * Chrome drawn over the game art uses `--chrome-fg*` (contrast.ts).
 */
export function applyGlass(appearance: GlassAppearance | null | undefined): void {
  const { brightness, opacity, material, blur, saturation, grain } = {
    ...DEFAULT_GLASS_APPEARANCE,
    ...appearance
  }
  const root = document.documentElement
  const t = Math.max(0, Math.min(100, brightness)) / 100
  const influence = Math.max(0, Math.min(100, opacity)) / 100
  const lightUi = t >= 0.5

  for (const token of SURFACE_TOKENS) {
    const r = Math.round(mix(token.dark[0], token.light[0], t))
    const g = Math.round(mix(token.dark[1], token.light[1], t))
    const b = Math.round(mix(token.dark[2], token.light[2], t))
    const a = mix(token.aOpaque, token.aClear, influence)
    root.style.setProperty(token.name, `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`)
  }
  for (const token of TINT_TOKENS) {
    const r = Math.round(mix(token.dark[0], token.light[0], t))
    const g = Math.round(mix(token.dark[1], token.light[1], t))
    const b = Math.round(mix(token.dark[2], token.light[2], t))
    const a = mix(token.dark[3], token.light[3], t)
    root.style.setProperty(token.name, `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`)
  }

  const fg = lightUi ? FG_DARK : FG_LIGHT
  root.style.setProperty('--fg', `rgba(${fg}, ${FG_ALPHA[0]})`)
  root.style.setProperty('--fg-2', `rgba(${fg}, ${FG_ALPHA[1]})`)
  root.style.setProperty('--fg-3', `rgba(${fg}, ${FG_ALPHA[2]})`)
  root.style.setProperty('--fg-4', `rgba(${fg}, ${FG_ALPHA[3]})`)

  // Scrim colour lifts with the brightness (never jumps); its *strength* is the
  // background-influence, i.e. it disappears at opacity 100 so the glass reads as
  // clear and brightness then only touches the (invisible) fill.
  const sc = SCRIM_DARK.map((v, i) => Math.round(mix(v, SCRIM_LIGHT[i], t)))
  root.style.setProperty('--scrim-rgb', `${sc[0]}, ${sc[1]}, ${sc[2]}`)
  root.style.setProperty('--scrim-strength', (1 - influence).toFixed(3))

  root.style.setProperty('--glass-blur', `${Math.max(0, blur)}px`)
  root.style.setProperty('--glass-saturate', `${Math.max(0, saturation)}%`)
  root.dataset.material = material
  root.style.colorScheme = lightUi ? 'light' : 'dark'

  // Surface texture: cloud/mica grain, or the shine light band (never both).
  if (material === 'mica' && grain > 0) {
    root.style.setProperty('--glass-sheen', grainDataUri(grain))
    root.style.setProperty('--glass-repeat', 'repeat')
    root.style.setProperty('--glass-size', '140px 140px')
  } else if (material === 'shine') {
    root.style.setProperty('--glass-sheen', SHEEN)
    root.style.setProperty('--glass-repeat', 'no-repeat')
    root.style.setProperty('--glass-size', 'cover')
  } else {
    root.style.setProperty('--glass-sheen', 'none')
    root.style.setProperty('--glass-repeat', 'no-repeat')
    root.style.setProperty('--glass-size', 'auto')
  }

  // Liquid/shine need a per-surface SVG refraction filter (size + corner radius
  // dependent), so they are driven imperatively rather than by a CSS token.
  setLiquidMaterial({ ...{ ...DEFAULT_GLASS_APPEARANCE, ...appearance } })

  // The over-background foreground depends on the scrim (brightness) — recompute.
  requestAnimationFrame(() => updateChromeContrast())
}
