import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'

/**
 * Reusable glass popup: rendered in a portal (never clipped), positioned above
 * its anchor, flipped below if it would leave the bounded area, and clamped
 * horizontally inside it. Uses the shared glass tokens so its material matches
 * the rest of the UI. Animates in **and** out, and (when `onDismiss` is given)
 * closes on a click outside the popup / anchor.
 */
interface GlassPopupProps {
  anchorRef: RefObject<HTMLElement>
  /** Bounds to stay within (e.g. the home stage). Defaults to the viewport. */
  boundsRef?: RefObject<HTMLElement>
  visible: boolean
  className?: string
  /** When set, a click outside the popup and its anchor calls this. */
  onDismiss?: () => void
  children: ReactNode
}

export default function GlassPopup({
  anchorRef,
  boundsRef,
  visible,
  className,
  onDismiss,
  children
}: GlassPopupProps): ReactElement | null {
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [mounted, setMounted] = useState(visible)
  const [closing, setClosing] = useState(false)

  // Mount on open, animate out then unmount on close.
  useEffect(() => {
    if (visible) {
      setMounted(true)
      setClosing(false)
      return undefined
    }
    if (!mounted) return undefined
    setClosing(true)
    const timer = window.setTimeout(() => {
      setMounted(false)
      setClosing(false)
    }, 170)
    return () => window.clearTimeout(timer)
  }, [visible, mounted])

  useLayoutEffect(() => {
    if (!visible) return // keep the last position while animating out
    const anchor = anchorRef.current
    const pop = popRef.current
    if (!anchor || !pop) return
    const ar = anchor.getBoundingClientRect()
    const pr = pop.getBoundingClientRect()
    const home = boundsRef?.current?.getBoundingClientRect()
    const left0 = home ? home.left : 0
    const top0 = home ? home.top : 0
    const right0 = home ? home.right : window.innerWidth
    const bottom0 = home ? home.bottom : window.innerHeight
    let left = ar.left + ar.width / 2 - pr.width / 2
    let top = ar.top - pr.height - 10
    if (top < top0 + 6) top = ar.bottom + 10 // flip below when it would overflow
    left = Math.max(left0 + 6, Math.min(right0 - pr.width - 6, left))
    top = Math.max(top0 + 6, Math.min(bottom0 - pr.height - 6, top))
    setPos({ left, top })
  }, [visible, anchorRef, boundsRef, mounted])

  // Dismiss on outside click (capture so it wins over other handlers).
  useEffect(() => {
    if (!visible || !onDismiss) return
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (popRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      onDismiss()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [visible, onDismiss, anchorRef])

  if (!mounted) return null
  return createPortal(
    <div
      ref={popRef}
      className={`glass-pop wallpaper-region${className ? ' ' + className : ''}${closing ? ' closing' : ''}`}
      style={{
        left: pos ? `${pos.left}px` : '-9999px',
        top: pos ? `${pos.top}px` : '-9999px',
        visibility: pos ? 'visible' : 'hidden'
      }}
    >
      <span className="wp-region-layer" aria-hidden="true" />
      {children}
    </div>,
    document.body
  )
}
