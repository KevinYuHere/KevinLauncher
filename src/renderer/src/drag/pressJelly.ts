import { addTask, frostMotion, makeSpring, springSettled, stepSpring, type Spring } from './spring'

/**
 * Global "press jelly" for plain controls (buttons, selects, colour trigger,
 * font items, …). One delegated pointer listener pops whichever control was
 * pressed — no per-component wiring needed. Elements with their own jelly
 * (modules / game chips / switch / segmented thumb) are excluded from the
 * selector so nothing fights over `transform`.
 */
const SELECTOR = [
  '.btn',
  '.color-trigger',
  '.font-item',
  '.select-trigger',
  '.select-option',
  '.seg',
  '.tab',
  '.modal-close',
  '.games-toggle',
  '.game-add',
  '.gear-btn',
  '.launcher-icon',
  '.pre-circle',
  '.setup-close',
  '.rail-update-btn',
  '.viewer-nav'
].join(',')

const active = new Map<HTMLElement, Spring>()
let running = false

function ensure(): void {
  if (running) return
  running = true
  addTask((dt) => {
    for (const [el, spring] of active) {
      // Frost-snap (霆骇列律): a crisper, smaller pop than the elastic default.
      if (frostMotion()) stepSpring(spring, dt, 900, 25)
      else stepSpring(spring, dt, 320, 13)
      el.style.transform = `scale(${spring.v.toFixed(4)})`
      if (springSettled(spring, 0.002, 0.03)) {
        el.style.transform = ''
        active.delete(el)
      }
    }
    if (active.size === 0) {
      running = false
      return false
    }
    return true
  })
}

function bump(el: HTMLElement, target: number): void {
  let spring = active.get(el)
  if (!spring) {
    spring = makeSpring(1)
    active.set(el, spring)
  }
  spring.target = target
  ensure()
}

let pressed: HTMLElement | null = null

export function installPressJelly(): () => void {
  const onDown = (event: PointerEvent): void => {
    const target = event.target as HTMLElement | null
    const el = target?.closest?.(SELECTOR) as HTMLElement | null
    if (!el) return
    pressed = el
    bump(el, frostMotion() ? 1.06 : 1.12)
  }
  const onUp = (): void => {
    const el = pressed
    pressed = null
    if (!el) return
    const spring = active.get(el)
    if (spring && spring.v < 1.04) spring.v = 1.06 // guarantee a visible tap pop
    bump(el, 1)
  }
  window.addEventListener('pointerdown', onDown, true)
  window.addEventListener('pointerup', onUp, true)
  window.addEventListener('pointercancel', onUp, true)
  return () => {
    window.removeEventListener('pointerdown', onDown, true)
    window.removeEventListener('pointerup', onUp, true)
    window.removeEventListener('pointercancel', onUp, true)
  }
}
