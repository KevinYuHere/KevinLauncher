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
 * 星霜 texture: sparse frost-shard triangles with a few star glints, tiled.
 * The tile is deliberately large (360px) so the repeat is hard to spot on a
 * wide card; `grain` controls its opacity, keeping the material setting useful.
 */
function frostDataUri(grain: number, angle: number): string {
  const a = (Math.max(0, Math.min(100, grain)) / 100) * 0.55
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="360">` +
    `<g transform="rotate(${angle} 180 180)">` +
    `<g fill="none" stroke="#e6f6ff" stroke-opacity="${a.toFixed(3)}" stroke-width=".6">` +
    `<path d="M28 46 64 108H-4z"/>` +
    `<path d="M216 24 246 72H186z"/>` +
    `<path d="M300 150 340 214H260z"/>` +
    `<path d="M120 236 144 278H96z"/>` +
    `<path d="M304 58 330 98H278z"/>` +
    `<path d="M52 286 80 332H24z"/>` +
    `<path d="M188 150 214 192H162z"/>` +
    `<path d="M330 288 356 330H304z"/>` +
    `<path d="M140 30 160 62H120z"/>` +
    `<path d="M250 250 276 292H224z"/>` +
    `<path d="M14 214 34 246H-6z"/>` +
    `<path d="M268 118 288 150H248z"/>` +
    `</g>` +
    `<g fill="#8b7cf6" fill-opacity="${(a * 0.72).toFixed(3)}">` +
    `<path d="M164 92 186 126H142z"/>` +
    `<path d="M24 180 45 214H3z"/>` +
    `<path d="M286 200 306 232H266z"/>` +
    `<path d="M96 124 112 150H80z"/>` +
    `<path d="M204 316 224 348H184z"/>` +
    `</g>` +
    `<g fill="#7dd3fc" fill-opacity="${(a * 0.55).toFixed(3)}">` +
    `<path d="M230 310 252 344H208z"/>` +
    `<path d="M60 60 76 86H44z"/>` +
    `<path d="M154 196 170 222H138z"/>` +
    `</g>` +
    `<g fill="#f5d48a" fill-opacity="${(a * 0.9).toFixed(3)}">` +
    `<circle cx="37" cy="171" r=".9"/><circle cx="321" cy="55" r=".7"/>` +
    `<circle cx="176" cy="317" r=".55"/><circle cx="15" cy="8" r=".55"/>` +
    `<circle cx="128" cy="184" r=".7"/><circle cx="300" cy="272" r=".8"/>` +
    `<circle cx="72" cy="248" r=".55"/><circle cx="244" cy="104" r=".6"/>` +
    `<circle cx="338" cy="174" r=".5"/><circle cx="92" cy="332" r=".5"/>` +
    `</g></g></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

/**
 * 星轨 texture: sparse, large ball-and-stick molecules of **several distinct
 * shapes** (bent triatomic, a four-node chain, a ring with a tail, a diatomic
 * pair with a satellite, a branched V), scattered at different rotations and
 * scales — some clipped by the tile edge — so it never reads as one repeated
 * stamp. Node size follows the artwork's proportions; `grain` drives opacity.
 */
function moleculeDataUri(grain: number, angle: number): string {
  const a = (Math.max(0, Math.min(100, grain)) / 100) * 0.85
  const node = (x: number, y: number, r: number, gold = true): string =>
    `<circle cx="${x}" cy="${y}" r="${r}" fill="#1b1240" fill-opacity="${(a * 0.95).toFixed(3)}" ` +
    `stroke="${gold ? '#e8c87a' : '#b9a8f6'}" stroke-opacity="${(a * 0.95).toFixed(3)}" stroke-width="2.4"/>`
  const bond = (x1: number, y1: number, x2: number, y2: number, double = false): string => {
    const base =
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#9d8bf5" ` +
      `stroke-opacity="${(a * 0.5).toFixed(3)}" stroke-width="3"/>`
    if (!double) return base
    const dx = x2 - x1
    const dy = y2 - y1
    const len = Math.hypot(dx, dy) || 1
    const ox = (-dy / len) * 4
    const oy = (dx / len) * 4
    return (
      base +
      `<line x1="${x1 + ox}" y1="${y1 + oy}" x2="${x2 + ox}" y2="${y2 + oy}" stroke="#9d8bf5" ` +
      `stroke-opacity="${(a * 0.42).toFixed(3)}" stroke-width="2"/>`
    )
  }
  const cluster = (
    x: number,
    y: number,
    angle: number,
    scale: number,
    body: string
  ): string => `<g transform="translate(${x} ${y}) rotate(${angle}) scale(${scale})">${body}</g>`

  // A — bent triatomic (the most common shape in the art).
  const bent =
    bond(0, 0, 118, -50) + bond(118, -50, 198, 40) +
    node(0, 0, 20) + node(118, -50, 24) + node(198, 40, 16)
  // B — four-node chain with one double bond.
  const chain =
    bond(0, 0, 92, 30, true) + bond(92, 30, 182, -10) + bond(182, -10, 262, 22) +
    node(0, 0, 18) + node(92, 30, 22) + node(182, -10, 16) + node(262, 22, 13, false)
  // C — four-membered ring with a tail.
  const ringTail =
    bond(0, 0, 100, -80) + bond(100, -80, 210, 0) + bond(210, 0, 110, 80) + bond(110, 80, 0, 0) +
    bond(210, 0, 300, -50) +
    node(0, 0, 18, false) + node(100, -80, 23) + node(210, 0, 19) + node(110, 80, 16, false) +
    node(300, -50, 13, false)
  // D — diatomic pair with a small satellite node.
  const satellite =
    bond(0, 0, 110, 60) + bond(0, 0, 30, -62) +
    node(0, 0, 24) + node(110, 60, 14, false) + node(30, -62, 9, false)
  // E — branched "V".
  const branched =
    bond(0, 0, 92, 70) + bond(92, 70, 180, 0) + bond(92, 70, 92, 152) +
    node(0, 0, 18) + node(92, 70, 20) + node(180, 0, 15) + node(92, 152, 11, false)

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900">` +
    // Soft vignette so molecules fade out at the tile seam instead of being cut.
    `<defs><radialGradient id="mt-fade" cx="0.5" cy="0.5" r="0.7">` +
    `<stop offset="0.55" stop-color="#fff"/><stop offset="1" stop-color="#000"/>` +
    `</radialGradient>` +
    `<mask id="mt-mask"><rect width="900" height="900" fill="url(#mt-fade)"/></mask></defs>` +
    `<g mask="url(#mt-mask)" transform="rotate(${angle} 450 450)">` +
    cluster(190, 200, 22, 1.05, bent) +
    cluster(620, 180, -30, 0.95, chain) +
    cluster(260, 520, 35, 1.1, ringTail) +
    cluster(690, 600, 10, 1.15, satellite) +
    cluster(450, 720, -55, 0.9, branched) +
    // a couple of free glints
    `<g fill="#e8c87a" fill-opacity="${(a * 0.9).toFixed(3)}">` +
    `<circle cx="320" cy="270" r="2.6"/><circle cx="720" cy="330" r="2.2"/>` +
    `<circle cx="90" cy="380" r="2"/><circle cx="500" cy="600" r="2.4"/>` +
    `<circle cx="860" cy="180" r="1.8"/><circle cx="240" cy="700" r="2.2"/>` +
    `</g></g></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

const TEXTURE_SELECTOR = [
  '.glass',
  '.panel',
  '.settings',
  '.modal',
  '.home-info',
  '.rail-glass',
  '.select-menu',
  '.glass-pop',
  '.toast',
  '.launch-drawer',
  '.rail-pop',
  '.dl-pop-glass',
  '.confirm-modal',
  '.card',
  '.home-card',
  '.stat-card',
  '.gallery-thumb',
  '.settings-row',
  '.drawer-opt'
].join(',')

let scattered = new WeakSet<HTMLElement>()

/**
 * Give every textured surface its own random tile origin — each card, panel and
 * popup gets a different one. Elements are only scattered once per material
 * application, so a click or a re-render never makes the texture jump.
 */
export function scatterTextureOffsets(roots?: ParentNode): void {
  const nodes = roots
    ? Array.from(roots.querySelectorAll<HTMLElement>(TEXTURE_SELECTOR))
    : Array.from(document.querySelectorAll<HTMLElement>(TEXTURE_SELECTOR))
  for (const el of nodes) {
    if (scattered.has(el)) continue
    scattered.add(el)
    el.style.backgroundPosition = `${Math.round(Math.random() * 900)}px ${Math.round(
      Math.random() * 900
    )}px`
  }
}

/** A new material / rotation invalidates every previous offset. */
export function resetTextureScatter(): void {
  scattered = new WeakSet()
}

/**
 * Scatter only surfaces that appear later (page switch, dialog, dropdown).
 * The observer ignores pure re-renders and never re-randomises an existing
 * surface, which used to make the material flash on every click.
 */
let textureObserver: MutationObserver | null = null
export function installTextureScatter(): void {
  if (textureObserver) return
  let timer = 0
  textureObserver = new MutationObserver((mutations) => {
    const material = document.documentElement.dataset.material
    if (material !== 'starfrost' && material !== 'astral') return
    let found = false
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (
          node instanceof HTMLElement &&
          (node.matches(TEXTURE_SELECTOR) || node.querySelector(TEXTURE_SELECTOR))
        ) {
          found = true
          break
        }
      }
      if (found) break
    }
    if (!found) return
    window.clearTimeout(timer)
    timer = window.setTimeout(() => scatterTextureOffsets(), 90)
  })
  textureObserver.observe(document.body, { childList: true, subtree: true })
}

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

  // Every textured material gets a fresh random rotation and, below, a random
  // per-surface offset, so two surfaces on one page never look like a copy.
  const angle = Math.round(Math.random() * 360)
  // Surface texture: cloud/mica grain, star-frost shards, or the shine light band.
  if (material === 'mica' && grain > 0) {
    root.style.setProperty('--glass-sheen', grainDataUri(grain))
    root.style.setProperty('--glass-repeat', 'repeat')
    root.style.setProperty('--glass-size', '140px 140px')
  } else if (material === 'starfrost') {
    root.style.setProperty('--glass-sheen', frostDataUri(grain, angle))
    root.style.setProperty('--glass-repeat', 'repeat')
    root.style.setProperty('--glass-size', '360px 360px')
  } else if (material === 'astral') {
    root.style.setProperty('--glass-sheen', moleculeDataUri(grain, angle))
    root.style.setProperty('--glass-repeat', 'repeat')
    root.style.setProperty('--glass-size', '900px 900px')
  } else if (material === 'shine') {
    root.style.setProperty('--glass-sheen', SHEEN)
    root.style.setProperty('--glass-repeat', 'no-repeat')
    root.style.setProperty('--glass-size', 'cover')
  } else {
    root.style.setProperty('--glass-sheen', 'none')
    root.style.setProperty('--glass-repeat', 'no-repeat')
    root.style.setProperty('--glass-size', 'auto')
  }
  if (material === 'starfrost' || material === 'astral') {
    resetTextureScatter()
    scatterTextureOffsets()
  }

  // Liquid/shine need a per-surface SVG refraction filter (size + corner radius
  // dependent), so they are driven imperatively rather than by a CSS token.
  setLiquidMaterial({ ...{ ...DEFAULT_GLASS_APPEARANCE, ...appearance } })

  // The over-background foreground depends on the scrim (brightness) — recompute.
  requestAnimationFrame(() => updateChromeContrast())
}
