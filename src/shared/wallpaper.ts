import type { WallpaperStrategy } from './types'

/** Next index for a manual previous / next step (list order, wraps). */
export function stepIndex(length: number, index: number, delta: number): number {
  if (length <= 0) return 0
  return (((index + delta) % length) + length) % length
}

/**
 * Next index for automatic rotation. `loop` walks the list in order; `random`
 * picks a different entry (kept useful even with two items).
 */
export function advanceIndex(
  length: number,
  index: number,
  strategy: WallpaperStrategy,
  random: () => number = Math.random
): number {
  if (length <= 0) return 0
  if (strategy === 'random' && length > 1) {
    let next = index
    // Bounded so a degenerate random source can never spin forever.
    for (let attempt = 0; attempt < 8 && next === index; attempt++) {
      next = Math.floor(random() * length) % length
    }
    if (next === index) next = (index + 1) % length
    return next
  }
  return (index + 1) % length
}
