/**
 * Collapses the real main window into a target HUD rectangle using native
 * BrowserWindow bounds/opacity updates.
 *
 * Every rectangle is in Electron's screen coordinate space (DIP), exactly as
 * `BrowserWindow.getBounds()` reports it. DIP already accounts for each
 * monitor's scale factor, and x/y may be negative on a display left of or above
 * the primary display. Never pass physical pixels here.
 *
 * The animation is deliberately self-contained: one short tween, no screenshots,
 * no recurring interval. A newer run (or a tray summon while it is running)
 * supersedes the old generation, and completion always puts the original window
 * size/opacity back while the window remains hidden in the tray.
 *
 * The default 480 ms is deliberately exaggerated so the absorption is readable:
 * a brief anticipation ("pull back" and grow), a much tighter vertical squash
 * than horizontal shrink, suction towards the real HUD rectangle, then a rapid
 * opacity cut in the tail. It is still one native bounds/opacity tween.
 */

export const KEVIN_HUD_DEPARTURE_DURATION_MS = 480
export const KEVIN_HUD_DEPARTURE_FRAME_MS = 16

const DEADLINE_GRACE_MS = 160
const MIN_DURATION_MS = 16
const MAX_DURATION_MS = 1000
const MIN_WINDOW_SIZE_DIP = 1

export interface KevinHudRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The small explicit window contract used by the transition. BrowserWindow
 * implements all of it, so callers do not need to construct an adapter.
 */
export interface KevinHudDepartureWindow {
  getBounds(): KevinHudRect
  setBounds(bounds: KevinHudRect, animate?: boolean): void
  getOpacity(): number
  setOpacity(opacity: number): void
  isDestroyed(): boolean
  hide(): void
  isVisible?(): boolean
  getMinimumSize?(): number[]
  setMinimumSize?(width: number, height: number): void
}

export interface KevinHudDepartureOptions {
  /**
   * Skip the tween when the caller knows the OS asks for reduced motion
   * (`prefers-reduced-motion` / Windows animation policy). The window still
   * finishes at the HUD, hides, and restores itself.
   */
  immediate?: boolean
  /** Tween duration. Defaults to 480 ms; clamped to 16..1000 ms. */
  durationMs?: number
}

export type KevinHudDepartureOptionInput = KevinHudDepartureOptions | boolean

export type KevinHudDepartureCancelReason =
  | 'cancelled'
  | 'replaced'
  | 'window-shown'
  | 'window-hidden'
  | 'destroyed'
  | 'error'

export interface KevinHudDepartureResult {
  status: 'completed' | 'cancelled' | 'skipped' | 'failed'
  /** True only when this transition hid the window at the target HUD. */
  hidden: boolean
  /** True when the original bounds, opacity and minimum size were restored. */
  restored: boolean
  reason?: string
}

export interface KevinHudDepartureFrame {
  bounds: KevinHudRect
  opacity: number
}

interface ActiveDeparture {
  window: KevinHudDepartureWindow
  startedAt: number
  durationMs: number
  startBounds: KevinHudRect
  targetBounds: KevinHudRect
  startOpacity: number
  minimumSize: [number, number] | undefined
  minimumSizeCleared: boolean
  opacityWritable: boolean
  opacityTouched: boolean
  frameTimer: ReturnType<typeof setTimeout> | undefined
  deadlineTimer: ReturnType<typeof setTimeout> | undefined
  settled: boolean
  finishing: boolean
  listenersAttached: boolean
  onShow: () => void
  onHide: () => void
  onClosed: () => void
  resolve: (result: KevinHudDepartureResult) => void
}

interface WindowEvents {
  on?: (event: 'show' | 'hide' | 'closed', listener: () => void) => unknown
  removeListener?: (event: 'show' | 'hide' | 'closed', listener: () => void) => unknown
}

/**
 * Per-window active run. The map itself is the generation: replacing or
 * deleting an entry makes every timer callback from the previous run stale.
 */
const activeDepartures = new WeakMap<KevinHudDepartureWindow, ActiveDeparture>()

function copyRect(bounds: KevinHudRect): KevinHudRect {
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
}

function isValidRect(bounds: unknown): bounds is KevinHudRect {
  if (!bounds || typeof bounds !== 'object') return false
  const value = bounds as Partial<KevinHudRect>
  return (
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height) &&
    (value.width as number) >= MIN_WINDOW_SIZE_DIP &&
    (value.height as number) >= MIN_WINDOW_SIZE_DIP
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Center of a DIP rectangle, including fractional and negative coordinates. */
export function kevinHudRectCenter(bounds: KevinHudRect): { x: number; y: number } {
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2
  }
}

/**
 * Phase boundaries of the exaggerated absorption. They are expressed in the
 * overall progress so the same curve works for the default 480 ms run and for
 * the short explicit durations used by embedders/tests.
 */
const ANTICIPATION_END = 0.3
const CENTER_START = 0.1
const CENTER_END = 0.84
const WIDTH_START = 0.26
const WIDTH_END = 0.86
const HEIGHT_START = 0.14
const HEIGHT_MID = 0.6
const HEIGHT_END = 0.8
const GEOMETRY_END = 0.86
const FADE_START = 0.3
const FADE_MID = 0.82
const FADE_END = 0.95
/** Small readable anticipation growth before the window starts moving in. */
const ANTICIPATION_GROWTH = 0.045
/** Pull-back in DIP, capped so a giant 4K window does not leap off screen. */
const PULLBACK_RATIO = 0.035
const MAX_PULLBACK_DIP = 28
/** The native host briefly squashes below the target height; never below 1 DIP. */
const HEIGHT_UNDERSHOOT = 0.85

function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

function lerp(start: number, end: number, progress: number): number {
  return start + (end - start) * progress
}

/** Progress of one phase; clamped so callers cannot apply another phase's easing. */
function phaseProgress(t: number, start: number, end: number): number {
  return clamp01((t - start) / (end - start))
}

function smoothstep(t: number): number {
  const value = clamp01(t)
  return value * value * (3 - 2 * value)
}

function easeInCubic(t: number): number {
  return clamp01(t) ** 3
}

function easeOutCubic(t: number): number {
  return 1 - (1 - clamp01(t)) ** 3
}

function easeInOutCubic(t: number): number {
  const value = clamp01(t)
  return value < 0.5 ? 4 * value * value * value : 1 - (-2 * value + 2) ** 3 / 2
}

/**
 * Interpolate one frame. Progress is clamped to 0..1; 0 is exactly the current
 * window bounds and opacity, and 1 is exactly the HUD's actual DIP bounds
 * (including its width and height) at zero opacity. In between the curve is
 * intentionally non-linear:
 *
 * - 0…0.30: a short anticipation; the window grows a little and pulls back
 *   opposite the HUD;
 * - 0.14…0.80: the height collapses much faster than the width, including a
 *   brief undershoot, so the launcher reads as vertically flattened;
 * - 0.26…0.86: width and centre are sucked into the exact HUD rectangle;
 * - 0.82…0.95: opacity drops sharply; the final frames are transparent at the
 *   exact target.
 *
 * The function stays pure so the target calculation can be tested without
 * Electron. All values are DIP screen coordinates, so negative positions and
 * secondary displays work unchanged.
 */
export function computeKevinHudDepartureFrame(
  startBounds: KevinHudRect,
  targetBounds: KevinHudRect,
  progress: number,
  startOpacity = 1
): KevinHudDepartureFrame {
  if (!isValidRect(startBounds)) throw new RangeError('Invalid start bounds for HUD departure')
  if (!isValidRect(targetBounds)) throw new RangeError('Invalid target bounds for HUD departure')

  const t = Number.isFinite(progress) ? clamp(progress, 0, 1) : 0
  const opacity = clamp(Number.isFinite(startOpacity) ? startOpacity : 1, 0, 1)
  if (t === 0) return { bounds: copyRect(startBounds), opacity }
  if (t === 1) return { bounds: copyRect(targetBounds), opacity: 0 }

  const startCenter = kevinHudRectCenter(startBounds)
  const targetCenter = kevinHudRectCenter(targetBounds)
  const deltaX = targetCenter.x - startCenter.x
  const deltaY = targetCenter.y - startCenter.y
  const distance = Math.hypot(deltaX, deltaY)

  // A half-sine bump peaks at ~150 ms and returns to zero exactly when the
  // suction phase really starts. A zero-distance target simply has no pull.
  const anticipation = t < ANTICIPATION_END
    ? Math.sin(Math.PI * (t / ANTICIPATION_END))
    : 0
  const pullback = Math.min(MAX_PULLBACK_DIP, distance * PULLBACK_RATIO) * anticipation
  const awayX = distance > 0 ? -deltaX / distance : 0
  const awayY = distance > 0 ? -deltaY / distance : 0

  const suction = easeInOutCubic(phaseProgress(t, CENTER_START, CENTER_END))
  const pulledCenterX = startCenter.x + awayX * pullback
  const pulledCenterY = startCenter.y + awayY * pullback
  const centerX = lerp(pulledCenterX, targetCenter.x, suction)
  const centerY = lerp(pulledCenterY, targetCenter.y, suction)

  const widthBase = lerp(
    startBounds.width,
    targetBounds.width,
    easeInOutCubic(phaseProgress(t, WIDTH_START, WIDTH_END))
  )
  const heightBase = t <= HEIGHT_MID
    ? lerp(
        startBounds.height,
        targetBounds.height * HEIGHT_UNDERSHOOT,
        easeInOutCubic(phaseProgress(t, HEIGHT_START, HEIGHT_MID))
      )
    : lerp(
        targetBounds.height * HEIGHT_UNDERSHOOT,
        targetBounds.height,
        easeOutCubic(phaseProgress(t, HEIGHT_MID, HEIGHT_END))
      )
  const growth = 1 + ANTICIPATION_GROWTH * anticipation
  const width = Math.max(MIN_WINDOW_SIZE_DIP, widthBase * growth)
  const height = Math.max(MIN_WINDOW_SIZE_DIP, heightBase * growth)

  let fadeFactor: number
  if (t <= FADE_MID) {
    fadeFactor = 1 - 0.12 * smoothstep(phaseProgress(t, FADE_START, FADE_MID))
  } else if (t >= FADE_END) {
    fadeFactor = 0
  } else {
    fadeFactor = 0.88 * (1 - easeInCubic(phaseProgress(t, FADE_MID, FADE_END)))
  }
  const frameOpacity = opacity * fadeFactor

  // The geometry is fully sucked in before the tail fade. Returning the exact
  // target here keeps every tail frame stable and guarantees the final frame is
  // not a near-miss caused by floating-point interpolation.
  if (t >= GEOMETRY_END) {
    return { bounds: copyRect(targetBounds), opacity: frameOpacity }
  }

  return {
    bounds: {
      x: centerX - width / 2,
      y: centerY - height / 2,
      width,
      height
    },
    opacity: frameOpacity
  }
}

function eventedWindow(window: KevinHudDepartureWindow): WindowEvents {
  return window as unknown as WindowEvents
}

function windowDestroyed(window: KevinHudDepartureWindow): boolean {
  try {
    return window.isDestroyed()
  } catch {
    return true
  }
}

function windowVisible(window: KevinHudDepartureWindow): boolean {
  if (!window.isVisible) return true
  try {
    return window.isVisible()
  } catch {
    return true
  }
}

function normalizeOptions(options: KevinHudDepartureOptionInput): {
  immediate: boolean
  durationMs: number
} {
  const values = typeof options === 'boolean' ? { immediate: options } : options ?? {}
  const requested = values.durationMs
  const durationMs =
    typeof requested === 'number' && Number.isFinite(requested)
      ? clamp(Math.round(requested), MIN_DURATION_MS, MAX_DURATION_MS)
      : KEVIN_HUD_DEPARTURE_DURATION_MS
  return { immediate: values.immediate === true, durationMs }
}

function readBounds(window: KevinHudDepartureWindow): KevinHudRect | null {
  try {
    const bounds = window.getBounds()
    return isValidRect(bounds) ? copyRect(bounds) : null
  } catch {
    return null
  }
}

function readOpacity(window: KevinHudDepartureWindow): number {
  try {
    const opacity = window.getOpacity()
    return Number.isFinite(opacity) ? clamp(opacity, 0, 1) : 1
  } catch {
    return 1
  }
}

function readMinimumSize(window: KevinHudDepartureWindow): [number, number] | undefined {
  if (!window.getMinimumSize) return undefined
  try {
    const size = window.getMinimumSize()
    if (!Array.isArray(size) || size.length < 2) return undefined
    const width = Number(size[0])
    const height = Number(size[1])
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) {
      return undefined
    }
    return [Math.round(width), Math.round(height)]
  } catch {
    return undefined
  }
}

function setOpacity(run: ActiveDeparture, opacity: number): void {
  if (!run.opacityWritable) return
  try {
    run.window.setOpacity(clamp(opacity, 0, 1))
    run.opacityTouched = true
  } catch {
    // Some compositors do not expose opacity. Bounds + hide still complete the
    // departure, and there is nothing useful to restore for opacity later.
    run.opacityWritable = false
  }
}

function restoreWindowState(run: ActiveDeparture): boolean {
  if (windowDestroyed(run.window)) return false
  let restored = true

  try {
    run.window.setBounds(copyRect(run.startBounds), false)
  } catch {
    restored = false
  }

  if (run.opacityTouched) {
    // Even when a later setOpacity failed (opacityWritable is now false), an
    // earlier frame may have changed the native value. Always attempt the
    // restore for that case.
    try {
      run.window.setOpacity(run.startOpacity)
    } catch {
      restored = false
    }
  }

  if (run.minimumSizeCleared && run.minimumSize && run.window.setMinimumSize) {
    try {
      run.window.setMinimumSize(run.minimumSize[0], run.minimumSize[1])
    } catch {
      restored = false
    }
  }

  return restored
}

function clearRunTimers(run: ActiveDeparture): void {
  if (run.frameTimer !== undefined) {
    clearTimeout(run.frameTimer)
    run.frameTimer = undefined
  }
  if (run.deadlineTimer !== undefined) {
    clearTimeout(run.deadlineTimer)
    run.deadlineTimer = undefined
  }
}

function detachWindowEvents(run: ActiveDeparture): void {
  if (!run.listenersAttached) return
  run.listenersAttached = false
  const events = eventedWindow(run.window)
  try {
    events.removeListener?.('show', run.onShow)
    events.removeListener?.('hide', run.onHide)
    events.removeListener?.('closed', run.onClosed)
  } catch {
    // The window may already be gone; the WeakMap state is still cleaned up.
  }
}

function forgetRun(run: ActiveDeparture): void {
  clearRunTimers(run)
  detachWindowEvents(run)
  if (activeDepartures.get(run.window) === run) activeDepartures.delete(run.window)
}

function settleDestroyed(run: ActiveDeparture): void {
  if (run.settled) return
  run.settled = true
  run.finishing = true
  clearRunTimers(run)
  detachWindowEvents(run)
  if (activeDepartures.get(run.window) === run) activeDepartures.delete(run.window)
  run.resolve({ status: 'cancelled', reason: 'destroyed', hidden: false, restored: false })
}

function cancelRun(run: ActiveDeparture, reason: KevinHudDepartureCancelReason): void {
  if (run.settled) return
  run.settled = true
  run.finishing = true
  clearRunTimers(run)

  const restored = restoreWindowState(run)
  forgetRun(run)
  run.resolve({
    status: reason === 'error' ? 'failed' : 'cancelled',
    reason,
    hidden: false,
    restored
  })
}

/**
 * After a failed hidden restore, retry as soon as the user brings the window
 * back. This only protects an exception path; the normal path restores before
 * the animation promise resolves.
 */
function repairRestoreOnShow(run: ActiveDeparture): void {
  const events = eventedWindow(run.window)
  if (!events.on || !events.removeListener) return
  const repair = (): void => {
    if (windowDestroyed(run.window)) {
      try {
        events.removeListener?.('show', repair)
      } catch {
        // The window is gone; nothing else to repair.
      }
      return
    }
    if (!restoreWindowState(run)) return
    try {
      events.removeListener?.('show', repair)
    } catch {
      // Ignore: the bounds are already repaired.
    }
  }
  try {
    events.on('show', repair)
  } catch {
    // No event API on the minimal window contract.
  }
}

function completeRun(run: ActiveDeparture): void {
  if (run.settled) return
  if (windowDestroyed(run.window)) {
    settleDestroyed(run)
    return
  }

  run.settled = true
  run.finishing = true
  clearRunTimers(run)

  let hidden = false
  let status: KevinHudDepartureResult['status'] = 'completed'
  let reason: string | undefined

  try {
    run.window.setBounds(copyRect(run.targetBounds), false)
  } catch {
    status = 'failed'
    reason = 'bounds-failed'
  }

  if (status === 'completed') {
    setOpacity(run, 0)
    try {
      run.window.hide()
      hidden = true
    } catch {
      // A foreign hide listener can throw after the native window is already
      // hidden. Only report a failure when it is still visible.
      hidden = !windowVisible(run.window)
      if (!hidden) {
        status = 'failed'
        reason = 'hide-failed'
      }
    }
  }

  const restored = restoreWindowState(run)
  forgetRun(run)
  if (hidden && !restored) repairRestoreOnShow(run)
  run.resolve({ status, reason, hidden, restored })
}

function applyFrame(run: ActiveDeparture, progress: number): void {
  const frame = computeKevinHudDepartureFrame(
    run.startBounds,
    run.targetBounds,
    progress,
    run.startOpacity
  )
  run.window.setBounds(frame.bounds, false)
  setOpacity(run, frame.opacity)
}

function runIsCurrent(run: ActiveDeparture): boolean {
  return !run.settled && activeDepartures.get(run.window) === run
}

function scheduleFrame(run: ActiveDeparture): void {
  if (!runIsCurrent(run)) return
  const elapsed = Date.now() - run.startedAt
  const remaining = run.durationMs - elapsed
  if (remaining <= 0) {
    completeRun(run)
    return
  }

  run.frameTimer = setTimeout(
    () => {
      run.frameTimer = undefined
      if (!runIsCurrent(run)) return
      if (windowDestroyed(run.window)) {
        settleDestroyed(run)
        return
      }
      if (!windowVisible(run.window)) {
        cancelRun(run, 'window-hidden')
        return
      }

      const progress = clamp((Date.now() - run.startedAt) / run.durationMs, 0, 1)
      try {
        if (progress >= 1) {
          completeRun(run)
        } else {
          // computeKevinHudDepartureFrame owns the whole intentional curve;
          // applying another easing here would double-shape the phases.
          applyFrame(run, progress)
          scheduleFrame(run)
        }
      } catch {
        cancelRun(run, 'error')
      }
    },
    Math.min(KEVIN_HUD_DEPARTURE_FRAME_MS, remaining)
  )
}

function attachWindowEvents(run: ActiveDeparture): void {
  const events = eventedWindow(run.window)
  if (!events.on) return
  run.listenersAttached = true
  try {
    events.on('show', run.onShow)
    events.on('hide', run.onHide)
    events.on('closed', run.onClosed)
  } catch {
    // Remove whichever listeners were accepted before the failure.
    detachWindowEvents(run)
  }
}

/**
 * Play the short window departure towards a HUD's actual screen-DIP bounds.
 *
 * The promise resolves after the window has reached the target, been hidden,
 * and had its original bounds/opacity/minimum size restored while hidden. A
 * newer run, an explicit cancel, the user showing/hiding the window, or the
 * window closing settles it early without leaving the window transparent or at
 * the tiny intermediate size. Errors restore the launcher and resolve with a
 * result instead of rejecting. An invalid target, a destroyed window, or a
 * window that is already hidden resolves as `skipped` without changing it.
 *
 * Pass `true` as the third argument (or `immediate: true`) for reduced motion.
 */
export function playKevinHudDeparture(
  window: KevinHudDepartureWindow,
  targetBounds: KevinHudRect,
  options: KevinHudDepartureOptionInput = {}
): Promise<KevinHudDepartureResult> {
  if (!isValidRect(targetBounds)) {
    return Promise.resolve({ status: 'skipped', hidden: false, restored: true, reason: 'invalid-target' })
  }
  if (windowDestroyed(window)) {
    return Promise.resolve({ status: 'skipped', hidden: false, restored: true, reason: 'destroyed' })
  }

  const previous = activeDepartures.get(window)
  if (previous) cancelRun(previous, 'replaced')

  if (!windowVisible(window)) {
    return Promise.resolve({
      status: 'skipped',
      hidden: false,
      restored: true,
      reason: 'not-visible'
    })
  }

  const startBounds = readBounds(window)
  if (!startBounds) {
    return Promise.resolve({
      status: 'skipped',
      hidden: false,
      restored: true,
      reason: 'bounds-unavailable'
    })
  }

  const normalized = normalizeOptions(options)
  const target = copyRect(targetBounds)
  let resolve!: (result: KevinHudDepartureResult) => void
  const finished = new Promise<KevinHudDepartureResult>((done) => {
    resolve = done
  })

  const run: ActiveDeparture = {
    window,
    startedAt: Date.now(),
    durationMs: normalized.durationMs,
    startBounds,
    targetBounds: target,
    startOpacity: readOpacity(window),
    minimumSize: readMinimumSize(window),
    minimumSizeCleared: false,
    opacityWritable: true,
    opacityTouched: false,
    frameTimer: undefined,
    deadlineTimer: undefined,
    settled: false,
    finishing: false,
    listenersAttached: false,
    onShow: () => {
      if (!run.settled && !run.finishing) cancelRun(run, 'window-shown')
    },
    onHide: () => {
      if (!run.settled && !run.finishing) cancelRun(run, 'window-hidden')
    },
    onClosed: () => {
      settleDestroyed(run)
    },
    resolve
  }

  activeDepartures.set(window, run)
  attachWindowEvents(run)

  const minimum = run.minimumSize
  if (minimum && (minimum[0] > 0 || minimum[1] > 0) && window.setMinimumSize) {
    // A real launcher window has a 900x600 minimum. Without lowering it, a
    // native setBounds call would clamp and never reach the small HUD. Mark it
    // first so even a setter that changes state and then throws gets restored.
    run.minimumSizeCleared = true
    try {
      window.setMinimumSize(0, 0)
    } catch {
      // The platform refused; bounds/hide still run with its current minimum.
    }
  }

  if (normalized.immediate) {
    completeRun(run)
    return finished
  }

  run.deadlineTimer = setTimeout(
    () => {
      run.deadlineTimer = undefined
      if (runIsCurrent(run)) completeRun(run)
    },
    run.durationMs + DEADLINE_GRACE_MS
  )
  scheduleFrame(run)
  return finished
}

/**
 * Cancel the active departure for a window and immediately put its original
 * size/opacity back. Returns false when there was no active transition.
 */
export function cancelKevinHudDeparture(
  window: KevinHudDepartureWindow,
  reason: KevinHudDepartureCancelReason = 'cancelled'
): boolean {
  const run = activeDepartures.get(window)
  if (!run || run.settled) return false
  cancelRun(run, reason)
  return true
}

/** True while a departure is tweening or finalising for this window. */
export function isKevinHudDepartureActive(window: KevinHudDepartureWindow): boolean {
  return activeDepartures.has(window)
}
