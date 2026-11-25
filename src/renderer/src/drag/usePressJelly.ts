import type { RefObject } from 'react'
import { useJellyDrag } from './useJellyDrag'

/**
 * Click/long-press "jelly pop" for any element (no dragging) — the same shared
 * feature the modules / chips / segmented use. Spread the returned `onPointerDown`
 * onto the element.
 */
export function usePressJelly(
  ref: RefObject<HTMLElement>,
  popScale = 1.14
): { onPointerDown: (event: import('react').PointerEvent<HTMLElement>) => void } {
  return useJellyDrag(ref, { enabled: false, popScale })
}
