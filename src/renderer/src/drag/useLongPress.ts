import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'

/**
 * Press-and-hold detection that does not conflict with a drag: the long-press
 * fires only when the pointer stays within a few px for `ms`, and moving first
 * cancels it (so "press then move" stays a drag). `consumeClick()` lets the
 * eventual click be swallowed after a long press.
 */
export function useLongPress(
  onLongPress: (rect: DOMRect, pointerId: number) => void,
  ms = 500
): {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  consumeClick: () => boolean
} {
  const callback = useRef(onLongPress)
  callback.current = onLongPress
  const timer = useRef(0)
  const fired = useRef(false)
  const stop = useRef<(() => void) | undefined>()
  useEffect(() => () => stop.current?.(), [])

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || stop.current) return
    fired.current = false
    const startX = event.clientX
    const startY = event.clientY
    const el = event.currentTarget as HTMLElement
    const pointerId = event.pointerId

    const move = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > 8) cleanup()
    }
    const up = (e: PointerEvent): void => { if (e.pointerId === pointerId) cleanup() }
    function cleanup(): void {
      stop.current = undefined
      if (timer.current) {
        window.clearTimeout(timer.current)
        timer.current = 0
      }
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('blur', cleanup)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('blur', cleanup)
    stop.current = cleanup
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      fired.current = true
      cleanup()
      callback.current(el.getBoundingClientRect(), pointerId)
    }, ms)
  }

  const consumeClick = (): boolean => {
    const value = fired.current
    fired.current = false
    return value
  }

  return { onPointerDown, consumeClick }
}
