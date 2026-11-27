import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode
} from 'react'

interface CollapseProps {
  open: boolean
  /**
   * Persistent trigger row rendered above the animated content. While open the
   * row sticks to the top of the actual scrolling viewport; nested collapses
   * offset themselves below every open ancestor header so the rows stack
   * instead of overlapping.
   */
  header?: ReactNode
  children: ReactNode
}

/**
 * Total height of the open ancestor headers. A child collapse receives this
 * through context and uses it as its sticky `top`, which keeps the outer and
 * nested trigger rows visible at the same time.
 */
const StickyHeaderOffset = createContext(0)

/**
 * Reusable collapsible section (the `0fr → 1fr` height reveal used all over the
 * settings). Only the content is animated: an optional header stays in normal
 * flow when closed (so it remains the way to reopen the drawer) and becomes
 * sticky while the drawer is open. Fully collapses when closed — the inner
 * element carries no padding of its own in that state, so nothing leaks out.
 */
export default function Collapse({ open, header, children }: CollapseProps): ReactElement {
  const inheritedStickyTop = useContext(StickyHeaderOffset)
  const headerRef = useRef<HTMLDivElement>(null)
  const [headerHeight, setHeaderHeight] = useState(0)
  const hasHeader = header != null && header !== false

  useEffect(() => {
    const el = headerRef.current
    if (!hasHeader || !open || !el) {
      setHeaderHeight(0)
      return
    }

    const measure = (): void => {
      const next = el.getBoundingClientRect().height
      setHeaderHeight((current) => (Math.abs(current - next) < 0.5 ? current : next))
    }
    measure()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }

    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasHeader, open])

  const ownStickyHeight = open && hasHeader ? headerHeight : 0
  const headerStyle = {
    '--collapse-sticky-top': `${inheritedStickyTop}px`
  } as CSSProperties

  return (
    <div className={`collapse${open ? ' open' : ''}`}>
      {hasHeader && (
        <div ref={headerRef} className="collapse-head" style={headerStyle}>
          {header}
        </div>
      )}
      <div
        className="collapse-reveal"
        ref={(el) => { if (el) el.inert = !open }}
        aria-hidden={!open}
      >
        <div className="collapse-inner">
          {/* Descendant headers use the accumulated height as their sticky top. */}
          <StickyHeaderOffset.Provider value={inheritedStickyTop + ownStickyHeight}>
            {children}
          </StickyHeaderOffset.Provider>
        </div>
      </div>
    </div>
  )
}
