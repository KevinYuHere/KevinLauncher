import type { KevinHudDirection } from './kevinHud'

/**
 * Shared, dependency-free motion contract for the KEVIN HUD.
 *
 * The renderer draws one short, finite timeline inside a native host that no
 * longer changes height: the plate grows from a shorter pose to the exact
 * configured height, the icon glides from the centre to the leading slot, and
 * the title reveals. Closing replays the same timeline backwards on the same
 * elements. The main-process owner must keep the native window alive for
 * `KEVIN_HUD_CLOSE_DELAY_MS` before destroying it, otherwise the reverse
 * animation is cut off.
 *
 * The entrance is deliberately compact: the plate is fully shaped at 240 ms,
 * the item wave starts at 40–72 ms and ends at 260–292 ms, and even the title
 * is fully readable at 480 ms. The remaining 120 ms is the reverse tail. The
 * old 1180 ms timeline spent most of its length holding a finished plate,
 * which is why closing felt disconnected from the visible motion. Items now
 * finish just after the plate; on exit the wave starts at 308–340 ms and ends
 * at 528–560 ms, the exact time mirror of the entrance, leading the plate's
 * 360–600 ms contraction by only a little. Ordinary exits use the same
 * keyframes and delays as the Web Animations reverse of a transient close.
 *
 * Keeping these values in `shared/` means the coordinator can import the close
 * delay without pulling in React or any renderer-only module.
 */
export const KEVIN_HUD_MOTION_TOTAL_MS = 600

/**
 * Native close delay for the reverse timeline. Coordinator wiring uses this
 * constant instead of the renderer's old 380 ms exit allowance.
 */
export const KEVIN_HUD_CLOSE_DELAY_MS = KEVIN_HUD_MOTION_TOTAL_MS

/** The plate first becomes fully opaque. */
export const KEVIN_HUD_PLATE_POP_MS = 36
/** The plate reaches the exact configured height/radius (no overshoot). */
export const KEVIN_HUD_GEOMETRY_PEAK_MS = 240
/** The centred icon starts gliding to the leading slot. */
export const KEVIN_HUD_ICON_GLIDE_START_MS = 72
/** The icon arrives at the leading slot. */
export const KEVIN_HUD_ICON_GLIDE_END_MS = 330
/** The title begins fading in only after the icon has arrived. */
export const KEVIN_HUD_TITLE_REVEAL_MS = KEVIN_HUD_ICON_GLIDE_END_MS
/** The title is fully readable. */
export const KEVIN_HUD_TITLE_SHOWN_MS = 480
/** One-shot subtle edge ripple peak and end. */
export const KEVIN_HUD_RIPPLE_PEAK_MS = 48
export const KEVIN_HUD_RIPPLE_END_MS = 372
/**
 * Revealed data items (and the leading identity block) use this CSS-only
 * duration. The renderer staggers them with `--khud-reveal-delay`; reversing
 * the animation direction retracts the same elements.
 *
 * The wave is deliberately tight and starts only a few tens of milliseconds
 * after the plate: the first item trails by 40 ms, the last starts by 72 ms and
 * the whole wave is settled at 292 ms. On exit each slot starts at the mirror
 * of its entrance time, so the reversed wave runs from 308–340 ms to
 * 528–560 ms, just ahead of the plate's 360–600 ms contraction.
 */
export const KEVIN_HUD_REVEAL_DURATION_MS = 220
/** Base trail after the plate starts opening, in milliseconds. */
export const KEVIN_HUD_REVEAL_BASE_DELAY_MS = 40
/** Per-item stagger, kept short so multiple slots reveal as one wave. */
export const KEVIN_HUD_REVEAL_STAGGER_MS = 8
/** Maximum entrance delay; four stagger steps after the base. */
export const KEVIN_HUD_REVEAL_MAX_DELAY_MS = 72

export interface KevinHudMotionOrigin {
  x: number
  y: number
  scale: number
}

const DIRECTION_ORIGINS: Record<KevinHudDirection, KevinHudMotionOrigin> = {
  center: { x: 0, y: 0, scale: 0.6 },
  left: { x: -28, y: 0, scale: 0.72 },
  right: { x: 28, y: 0, scale: 0.72 },
  top: { x: 0, y: -20, scale: 0.72 },
  bottom: { x: 0, y: 20, scale: 0.72 }
}

/**
 * Pure origin of the plate motion for the five direction settings. The same
 * values are read forwards and (because the CSS animation is reversed) on
 * close, so a direction can never have two unrelated entrances/exits.
 */
export function kevinHudMotionOrigin(
  direction: KevinHudDirection | null | undefined
): KevinHudMotionOrigin {
  return DIRECTION_ORIGINS[direction ?? 'center'] ?? DIRECTION_ORIGINS.center
}

export type KevinHudDirectionVars = {
  '--khud-enter-x': string
  '--khud-enter-y': string
  '--khud-enter-scale': string
}

/** CSS custom properties consumed by the one-shot/reversed plate keyframes. */
export function kevinHudDirectionVars(
  direction: KevinHudDirection | null | undefined
): KevinHudDirectionVars {
  const origin = kevinHudMotionOrigin(direction)
  return {
    '--khud-enter-x': `${origin.x}px`,
    '--khud-enter-y': `${origin.y}px`,
    '--khud-enter-scale': String(origin.scale)
  }
}
