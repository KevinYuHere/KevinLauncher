/**
 * Applies the liquid/shine glass material to the launcher's glass surfaces.
 *
 * The reference effect needs a displacement map generated for the *actual size*
 * and corner radius of each surface, so a single shared filter can't be used.
 * This module keeps one SVG filter per element, sized to its box.
 *
 * Geometry scales with the element (thickness ≈ a fraction of its smaller side,
 * like the reference's small controls) so refraction stays as pronounced on small
 * pills as on big panels — with a separate (usually gentler) strength and a hard
 * scale cap for large panels.
 */
import { DEFAULT_GLASS_APPEARANCE, type GlassAppearance, type GlassMaterial } from '@shared/types'
import { buildLiquidFilter } from './liquidFilter'

/** Refraction tier of a surface. */
type Tier = 'control' | 'panel' | 'region'

/** Large surfaces. */
const PANEL_SELECTOR = [
  '.glass',
  '.panel',
  '.settings',
  '.list',
  '.modal',
  '.pool-col',
  '.stat-card',
  '.pity-card',
  '.toast',
  '.gacha-toast',
  '.home-info',
  '.select-menu',
  '.dl-pop',
  '.rail-pop',
  '.welcome',
  '.setup-card',
  '.rail-glass',
  '.segmented',
  '.tabs',
  '.glass-pop',
  '.select-menu',
  '.dl-pop',
  '.rail-pop'
].join(',')

/**
 * Small controls (take the stronger "control" refraction). The rail items and
 * game-row chips are deliberately excluded: they sit over the background and must
 * keep the same behaviour as with blur/mica (no refraction).
 */
const CONTROL_SELECTOR = [
  '.btn',
  '.dl-pill',
  '.playtime-pill',
  '.modal-close',
  '.color-trigger'
].join(',')

const SVG_NS = 'http://www.w3.org/2000/svg'
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

let defs: SVGDefsElement | null = null
let enabled = false
let material: GlassMaterial = 'blur'
let blurPx = 0
let edgeWidth = DEFAULT_GLASS_APPEARANCE.edgeWidth
let refractionControl = 1
let refractionPanel = 0.5
let highlight = 0.4
let highlightAngle = 60
let dispersion = 0
let counter = 0

const ids = new WeakMap<Element, string>()
const filters = new Map<Element, SVGFilterElement>()
const resizers = new Map<Element, ResizeObserver>()
let mutationObserver: MutationObserver | null = null
let scanQueued = false
const dirty = new Set<Element>()

function ensureDefs(): SVGDefsElement {
  if (defs) return defs
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'glass-defs')
  svg.setAttribute('aria-hidden', 'true')
  const d = document.createElementNS(SVG_NS, 'defs')
  svg.appendChild(d)
  document.body.appendChild(svg)
  defs = d
  return defs
}

/** Liquid/shine read as clear glass: only a light blur, refraction carries the look. */
function materialBlur(blur: number): number {
  return Math.min(blur * 0.12, 6)
}

interface Geometry {
  glassThickness: number
  refraction: number
  maxScale: number
}

function geometryFor(minDim: number, tier: 'control' | 'panel' | 'region'): Geometry {
  if (tier === 'control') {
    return {
      glassThickness: clamp(minDim * 0.5, 18, 140),
      refraction: refractionControl,
      maxScale: minDim * 0.9
    }
  }
  return {
    glassThickness: clamp(minDim * (tier === 'region' ? 0.35 : 0.4), 24, 220),
    refraction: refractionPanel,
    maxScale: minDim
  }
}

function clearElement(el: Element): void {
  const filter = filters.get(el)
  if (filter) {
    filter.remove()
    filters.delete(el)
  }
  resizers.get(el)?.disconnect()
  resizers.delete(el)
  const style = (el as HTMLElement).style
  style.removeProperty('backdrop-filter')
  style.removeProperty('-webkit-backdrop-filter')
  style.removeProperty('filter')
  style.removeProperty('-webkit-filter')
}

function applyElement(el: HTMLElement, tier: Tier): void {
  // Use the layout box (not the visual rect) so transforms never change the map.
  const width = el.offsetWidth
  const height = el.offsetHeight
  if (width < 4 || height < 4) {
    clearElement(el)
    return
  }
  const cs = getComputedStyle(el)
  // Use the largest corner radius; keep a small floor so square elements (like a
  // sidebar strip) still get a usable bezel band without visually rounding.
  const radius = Math.min(
    Math.max(
      8,
      parseFloat(cs.borderTopLeftRadius) || 0,
      parseFloat(cs.borderTopRightRadius) || 0,
      parseFloat(cs.borderBottomRightRadius) || 0,
      parseFloat(cs.borderBottomLeftRadius) || 0
    ),
    width / 2,
    height / 2
  )
  const id = ids.get(el) ?? `kl-liquid-${++counter}`
  ids.set(el, id)

  const geo = geometryFor(Math.min(width, height), tier)
  const markup = buildLiquidFilter(id, {
    width,
    height,
    radius,
    blur: materialBlur(blurPx),
    glassThickness: geo.glassThickness,
    bezelWidth: clamp(edgeWidth, 4, 100),
    refractiveIndex: 1.5,
    refraction: geo.refraction,
    highlight,
    highlightAngle,
    dispersion,
    specularSaturation: 4,
    maxScale: geo.maxScale
  })

  const holder = document.createElementNS(SVG_NS, 'svg')
  holder.innerHTML = markup
  const filter = holder.firstElementChild as SVGFilterElement | null
  if (!filter) return

  const previous = filters.get(el)
  if (previous) previous.replaceWith(filter)
  else ensureDefs().appendChild(filter)
  filters.set(el, filter)

  if (tier === 'region') {
    // The plan-A region layer paints the wallpaper region itself: distort that
    // image (refraction + dispersion) instead of sampling the live backdrop.
    el.style.setProperty('filter', `url(#${id})`)
    el.style.setProperty('-webkit-filter', `url(#${id})`)
  } else {
    el.style.setProperty('backdrop-filter', `url(#${id})`)
    el.style.setProperty('-webkit-backdrop-filter', `url(#${id})`)
  }
}

function observe(el: Element): void {
  if (resizers.has(el)) return
  const ro = new ResizeObserver(() => {
    dirty.add(el)
    queueScan()
  })
  ro.observe(el)
  resizers.set(el, ro)
}

function collectTargets(): Map<HTMLElement, Tier> {
  const map = new Map<HTMLElement, Tier>()
  // An element *inside* a material surface must not get the refraction again
  // (it uses a plain darkened veil instead). A `.wallpaper-region` panel (plan-A
  // dialog) carries no material, so its children are NOT wrapped and DO get it.
  const wrapped = (el: HTMLElement): boolean => {
    const panel = el.parentElement?.closest(PANEL_SELECTOR)
    if (!panel) return false
    return !panel.classList.contains('wallpaper-region')
  }
  for (const el of document.querySelectorAll<HTMLElement>(PANEL_SELECTOR)) {
    if (el.classList.contains('wallpaper-region')) continue // no material on it
    if (el.querySelector('.wp-region-layer')) continue // material is on the region layer
    if (!wrapped(el)) map.set(el, 'panel')
  }
  for (const el of document.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)) {
    if (!wrapped(el)) map.set(el, 'control')
  }
  // Plan-A region layers are children of panels but still take the material —
  // except in a dialog (which shows the wallpaper only).
  for (const el of document.querySelectorAll<HTMLElement>('.wp-region-layer')) {
    if (el.closest('.modal.wallpaper-region')) continue
    map.set(el, 'region')
  }
  return map
}

function runScan(): void {
  const targets = collectTargets()
  for (const [el, tier] of targets) {
    if (dirty.has(el) || !filters.has(el)) applyElement(el, tier)
    observe(el)
  }
  for (const el of Array.from(filters.keys())) {
    if (!targets.has(el as HTMLElement)) clearElement(el)
  }
  dirty.clear()
}

function queueScan(): void {
  if (scanQueued) return
  scanQueued = true
  requestAnimationFrame(() => {
    scanQueued = false
    if (enabled) runScan()
  })
}

function startObservers(): void {
  if (!mutationObserver) {
    mutationObserver = new MutationObserver(() => queueScan())
    mutationObserver.observe(document.body, { childList: true, subtree: true })
  }
}

function teardown(): void {
  mutationObserver?.disconnect()
  mutationObserver = null
  for (const el of Array.from(resizers.keys())) clearElement(el)
  resizers.clear()
  filters.clear()
  dirty.clear()
}

/**
 * Sync the engine with the current appearance. Cheap when only the blur changes;
 * a geometry change (edge width) rebuilds maps, everything else is a cheap markup
 * rebuild (maps cached by geometry).
 */
export function setLiquidMaterial(appearance: GlassAppearance | null | undefined): void {
  const next = { ...DEFAULT_GLASS_APPEARANCE, ...appearance }
  const nextEnabled = next.material === 'liquid' || next.material === 'shine'

  const mapsChanged = next.edgeWidth !== edgeWidth
  const sameExceptBlur =
    next.material === material &&
    next.refraction === refractionControl * 100 &&
    next.panelRefraction === refractionPanel * 100 &&
    next.highlight === highlight * 100 &&
    next.highlightAngle === highlightAngle &&
    (next.dispersion / 100) * 0.4 === dispersion
  const onlyBlur = !mapsChanged && sameExceptBlur && next.blur !== blurPx

  const wasEnabled = enabled
  material = next.material
  blurPx = next.blur
  edgeWidth = next.edgeWidth
  refractionControl = next.refraction / 100
  refractionPanel = next.panelRefraction / 100
  highlight = next.highlight / 100
  highlightAngle = next.highlightAngle
  dispersion = (next.dispersion / 100) * 0.4
  enabled = nextEnabled

  if (!enabled) {
    if (filters.size > 0 || resizers.size > 0) teardown()
    return
  }

  if (onlyBlur) {
    for (const filter of filters.values()) {
      filter.querySelector('feGaussianBlur')?.setAttribute('stdDeviation', String(materialBlur(blurPx)))
    }
  } else if (wasEnabled) {
    for (const el of Array.from(filters.keys())) dirty.add(el)
  }

  ensureDefs()
  startObservers()
  queueScan()
}
