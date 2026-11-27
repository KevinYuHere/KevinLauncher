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
import { buildLiquidFilter, liquidMapInputs, type LiquidFilterOptions, type LiquidMaps } from './liquidFilter'

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
  '.glass-pop'
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
const REGION_SELECTOR = '.wp-region-layer'
const TARGET_SELECTOR = [PANEL_SELECTOR, CONTROL_SELECTOR, REGION_SELECTOR].join(',')
const SUBMIT_LIMIT = 6

let defs: SVGDefsElement | null = null
let enabled = false
let visible = true
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
interface Surface {
  tier: Tier
  filter?: SVGFilterElement
  signature?: string
  mapKey?: string
  maps?: LiquidMaps
  request?: { signature: string; mapKey: string; options: LiquidFilterOptions }
}
const surfaces = new Map<HTMLElement, Surface>()
let resizeObserver: ResizeObserver | null = null
let mutationObserver: MutationObserver | null = null
let frame = 0
let detached = false
const dirty = new Set<HTMLElement>()
const waiting = new Set<HTMLElement>()
const ready = new Set<HTMLElement>()
let worker: Worker | null = null
let job: { id: number; element: HTMLElement; key: string } | null = null
let requestId = 0

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

function clearFilter(el: HTMLElement, surface: Surface): void {
  surface.request = undefined
  waiting.delete(el)
  ready.delete(el)
  if (!surface.filter) return
  surface.filter.remove()
  surface.filter = undefined
  surface.signature = undefined
  surface.maps = undefined
  surface.mapKey = undefined
  const style = el.style
  style.removeProperty('backdrop-filter')
  style.removeProperty('-webkit-backdrop-filter')
  style.removeProperty('filter')
  style.removeProperty('-webkit-filter')
}

function removeSurface(el: HTMLElement, surface: Surface): void {
  clearFilter(el, surface)
  resizeObserver?.unobserve(el)
  surfaces.delete(el)
}

function readElement(el: HTMLElement, tier: Tier): LiquidFilterOptions | null {
  // Use the layout box (not the visual rect) so transforms never change the map.
  const width = el.offsetWidth
  const height = el.offsetHeight
  if (width < 4 || height < 4) return null
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
  const geo = geometryFor(Math.min(width, height), tier)
  return {
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
  }
}

function commitFilter(el: HTMLElement, surface: Surface): void {
  const request = surface.request
  if (!request || !surface.maps || surface.mapKey !== request.mapKey) return
  const id = ids.get(el) ?? `kl-liquid-${++counter}`
  ids.set(el, id)
  const markup = buildLiquidFilter(id, request.options, surface.maps)

  const holder = document.createElementNS(SVG_NS, 'svg')
  holder.innerHTML = markup
  const filter = holder.firstElementChild as SVGFilterElement | null
  if (!filter) return

  const previous = surface.filter
  if (previous) previous.replaceWith(filter)
  else ensureDefs().appendChild(filter)
  surface.filter = filter
  surface.signature = request.signature
  surface.request = undefined

  if (surface.tier === 'region') {
    // The plan-A region layer paints the wallpaper region itself: distort that
    // image (refraction + dispersion) instead of sampling the live backdrop.
    el.style.setProperty('filter', `url(#${id})`)
    el.style.setProperty('-webkit-filter', `url(#${id})`)
  } else {
    el.style.setProperty('backdrop-filter', `url(#${id})`)
    el.style.setProperty('-webkit-backdrop-filter', `url(#${id})`)
  }
}

function tierOf(el: HTMLElement): Tier | undefined {
  if (el.matches(REGION_SELECTOR)) return el.closest('.modal.wallpaper-region') ? undefined : 'region'
  const panel = el.parentElement?.closest(PANEL_SELECTOR)
  if (panel && !panel.classList.contains('wallpaper-region')) return undefined
  if (el.matches(PANEL_SELECTOR) && !el.classList.contains('wallpaper-region') &&
      !el.querySelector(REGION_SELECTOR)) return 'panel'
  if (el.matches(CONTROL_SELECTOR)) return 'control'
  return undefined
}

function scheduleMaps(): void {
  if (job || !enabled || !visible) return
  while (waiting.size > 0) {
    const element = waiting.values().next().value!
    waiting.delete(element)
    const request = surfaces.get(element)?.request
    if (!request) continue
    try {
      if (!worker) {
        worker = new Worker(new URL('./liquidMapsWorker.ts', import.meta.url), { type: 'module' })
        worker.onmessage = ({ data }: MessageEvent<{ id: number; maps?: LiquidMaps }>) => {
          const finished = job
          if (!finished || data.id !== finished.id) return
          job = null
          const surface = surfaces.get(finished.element)
          if (surface?.request?.mapKey === finished.key && data.maps) {
            surface.maps = data.maps
            surface.mapKey = finished.key
            waiting.delete(finished.element)
            ready.add(finished.element)
            queueScan()
          }
          scheduleMaps()
        }
        const fail = (): void => {
          worker?.terminate()
          worker = null
          job = null
          waiting.clear()
        }
        worker.onerror = fail
        worker.onmessageerror = fail
      }
      job = { id: ++requestId, element, key: request.mapKey }
      worker.postMessage({ id: job.id, input: liquidMapInputs(request.options, window.devicePixelRatio) })
    } catch {
      worker?.terminate()
      worker = null
      job = null
      waiting.clear()
    }
    return
  }
}

function runScan(): void {
  const measured = Array.from(dirty, (el) => {
    const tier = el.isConnected ? tierOf(el) : undefined
    return { el, tier, options: tier ? readElement(el, tier) : null }
  })
  dirty.clear()
  if (detached) {
    for (const [el, surface] of surfaces) if (!el.isConnected) removeSurface(el, surface)
    detached = false
  }
  for (const { el, tier, options } of measured) {
    let surface = surfaces.get(el)
    if (!tier) {
      if (surface) removeSurface(el, surface)
      continue
    }
    if (surface?.tier !== tier) {
      if (surface) removeSurface(el, surface)
      surface = { tier }
      surfaces.set(el, surface)
      resizeObserver?.observe(el)
    }
    if (!options) {
      clearFilter(el, surface)
      continue
    }
    const inputs = liquidMapInputs(options, window.devicePixelRatio)
    const signature = JSON.stringify([options, inputs.dpr])
    if (surface.signature === signature) {
      surface.request = undefined
      waiting.delete(el)
      continue
    }
    const mapKey = JSON.stringify([inputs.displacementKey, inputs.specularKey])
    surface.request = { signature, options, mapKey }
    if (surface.mapKey === mapKey) ready.add(el)
    else if (job?.element !== el || job.key !== mapKey) waiting.add(el)
  }
  let submitted = 0
  for (const el of ready) {
    ready.delete(el)
    const surface = surfaces.get(el)
    if (surface) commitFilter(el, surface)
    if (++submitted === SUBMIT_LIMIT) break
  }
  scheduleMaps()
  if (ready.size > 0) queueScan()
}

function queueScan(): void {
  if (frame || !enabled || !visible) return
  frame = requestAnimationFrame(() => {
    frame = 0
    runScan()
  })
}

function addTargets(node: HTMLElement): void {
  if (node.matches(TARGET_SELECTOR)) dirty.add(node)
  for (const el of node.querySelectorAll<HTMLElement>(TARGET_SELECTOR)) dirty.add(el)
}

function startObservers(): void {
  if (mutationObserver) return
  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) dirty.add(entry.target as HTMLElement)
    queueScan()
  })
  mutationObserver = new MutationObserver((records) => {
    if (!visible) return
    for (const record of records) {
      if (!(record.target instanceof HTMLElement)) continue
      const panel = record.target.closest<HTMLElement>(PANEL_SELECTOR)
      if (panel) dirty.add(panel)
      for (const node of record.addedNodes) if (node instanceof HTMLElement) addTargets(node)
      if (record.removedNodes.length > 0) detached = true
    }
    if (dirty.size > 0 || detached) queueScan()
  })
  mutationObserver.observe(document.body, { childList: true, subtree: true })
  addTargets(document.body)
}

function teardown(): void {
  cancelAnimationFrame(frame)
  frame = 0
  worker?.terminate()
  worker = null
  job = null
  waiting.clear()
  ready.clear()
  mutationObserver?.disconnect()
  mutationObserver = null
  resizeObserver?.disconnect()
  resizeObserver = null
  for (const [el, surface] of surfaces) removeSurface(el, surface)
  defs?.parentElement?.remove()
  defs = null
  dirty.clear()
  detached = false
}

export function setLiquidVisible(next: boolean): void {
  if (visible === next) return
  visible = next
  if (!enabled) return
  if (visible) {
    startObservers()
    addTargets(document.body)
    detached = true
    queueScan()
  } else {
    cancelAnimationFrame(frame)
    frame = 0
    worker?.terminate()
    worker = null
    job = null
  }
}

/**
 * Sync the engine with the current appearance. Cheap when only the blur changes;
 * a geometry change (edge width) rebuilds maps, everything else is a cheap markup
 * rebuild (maps cached by geometry).
 */
export function setLiquidMaterial(appearance: GlassAppearance | null | undefined): void {
  const next = { ...DEFAULT_GLASS_APPEARANCE, ...appearance }
  const nextEnabled = next.material === 'liquid' || next.material === 'shine'

  const sameGeometry = next.edgeWidth === edgeWidth
  const sameExceptBlur =
    next.material === material &&
    next.refraction / 100 === refractionControl &&
    next.panelRefraction / 100 === refractionPanel &&
    next.highlight / 100 === highlight &&
    next.highlightAngle === highlightAngle &&
    (next.dispersion / 100) * 0.4 === dispersion
  if (sameGeometry && sameExceptBlur && next.blur === blurPx && enabled === nextEnabled) return
  const onlyBlur = sameGeometry && sameExceptBlur

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
    if (wasEnabled) teardown()
    return
  }

  if (onlyBlur) {
    for (const [el, surface] of surfaces) {
      surface.filter?.querySelector('feGaussianBlur')?.setAttribute('stdDeviation', String(materialBlur(blurPx)))
      if (surface.request) dirty.add(el)
    }
  } else if (wasEnabled) {
    for (const el of surfaces.keys()) dirty.add(el)
  }

  if (visible) startObservers()
  queueScan()
}
