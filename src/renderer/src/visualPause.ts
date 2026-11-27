/**
 * SVG SMIL power-saving lifecycle.
 *
 * CSS pauses for free with `animation-play-state`, but SVG `<animate>`,
 * `<animateTransform>` and `<animateMotion>` keep running. The launcher already
 * publishes one shared marker (`data-visual-paused` on `<html>`) from the
 * `useVisualActivity` gate, so this module only reacts to that marker:
 *
 * - pause every SMIL-bearing SVG timeline while paused;
 * - while paused, watch the launcher subtree so SVGs mounted later are paused
 *   too (a paused SVG that gets replaced must not animate until it is resumed);
 * - on resume, unpause only timelines this module paused, leaving SVGs that a
 *   component had paused for its own lifecycle (e.g. a paused download) alone.
 *
 * No timer, animation loop or whole-document observer is involved.
 */
const PAUSE_ATTRIBUTE = 'data-visual-paused'
const SMIL_TAGS = new Set([
  'animate',
  'animatecolor',
  'animatemotion',
  'animatetransform',
  'discard',
  'set'
])

function containsSmil(svg: SVGSVGElement): boolean {
  for (const element of svg.querySelectorAll('*')) {
    if (SMIL_TAGS.has(element.localName.toLowerCase())) return true
  }
  return false
}

function smilRoot(element: Element): SVGSVGElement | null {
  const svg = element.closest('svg')
  return svg instanceof SVGSVGElement ? svg : null
}

function pauseSvg(svg: SVGSVGElement, paused: Set<SVGSVGElement>): void {
  if (paused.has(svg) || !svg.isConnected || !containsSmil(svg)) return
  try {
    if (!svg.animationsPaused()) {
      svg.pauseAnimations()
      paused.add(svg)
    }
  } catch {
    // Older/partial SVG implementations: leave the animation alone.
  }
}

function pauseWithin(root: ParentNode, paused: Set<SVGSVGElement>): void {
  if (root instanceof SVGSVGElement) pauseSvg(root, paused)
  for (const svg of root.querySelectorAll<SVGSVGElement>('svg')) pauseSvg(svg, paused)
}

function resumeSvgAnimations(paused: Set<SVGSVGElement>): void {
  for (const svg of paused) {
    // Unpause even a detached root: it may be re-inserted into a portal after
    // the pause ends, and its timeline must not stay frozen for its lifetime.
    try {
      if (svg.animationsPaused()) svg.unpauseAnimations()
    } catch {
      // The element may have lost its SVG document while mounted.
    }
  }
  paused.clear()
}

function start(): () => void {
  const paused = new Set<SVGSVGElement>()
  let active = false
  let mutationObserver: MutationObserver | null = null

  const onMutations = (records: MutationRecord[]): void => {
    if (!active) return
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue
        // A new SMIL element added to an already present SVG (for example a
        // gradient animation mounted on demand) also needs that root paused.
        if (SMIL_TAGS.has(node.localName.toLowerCase())) {
          const root = smilRoot(node)
          if (root) pauseSvg(root, paused)
        }
        pauseWithin(node, paused)
      }
    }
  }

  const stopMutationObserver = (): void => {
    mutationObserver?.disconnect()
    mutationObserver = null
  }

  const sync = (): void => {
    const next = document.documentElement.hasAttribute(PAUSE_ATTRIBUTE)
    if (next === active) return
    active = next
    if (active) {
      pauseWithin(document, paused)
      const scope = document.querySelector('.app')
      if (scope) {
        mutationObserver = new MutationObserver(onMutations)
        mutationObserver.observe(scope, { childList: true, subtree: true })
      }
    } else {
      stopMutationObserver()
      resumeSvgAnimations(paused)
    }
  }

  // `App.tsx` owns the marker; following the attribute keeps this module out of
  // the render path while still covering initial load and StrictMode replays.
  const attributeObserver = new MutationObserver(sync)
  attributeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [PAUSE_ATTRIBUTE]
  })
  sync()

  return () => {
    attributeObserver.disconnect()
    stopMutationObserver()
    active = false
    resumeSvgAnimations(paused)
  }
}

let installs = 0
let dispose: (() => void) | null = null

/**
 * Install the shared SMIL lifecycle once. The returned cleanup is ref-counted so
 * React StrictMode (or two consumers of the hook) cannot unpause another
 * consumer's animations.
 */
export function installVisualPause(): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => undefined
  }
  if (installs === 0) dispose = start()
  installs += 1
  let released = false
  return () => {
    if (released) return
    released = true
    installs -= 1
    if (installs === 0) {
      dispose?.()
      dispose = null
    }
  }
}
