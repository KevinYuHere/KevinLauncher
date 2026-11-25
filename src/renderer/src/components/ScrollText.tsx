import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'

interface ScrollTextProps {
  text: string
  /** Max visible width (px). Defaults to the container's own width. */
  maxWidth?: number
  className?: string
}

/**
 * Shows a label; when it is wider than the available space it scrolls in a
 * **continuous loop** (the text is duplicated so the wrap-around is seamless)
 * with a soft fade on both sides instead of clipping.
 */
export default function ScrollText({ text, maxWidth, className }: ScrollTextProps): ReactElement {
  const wrapRef = useRef<HTMLSpanElement>(null)
  const trackRef = useRef<HTMLSpanElement>(null)
  const copyRef = useRef<HTMLSpanElement>(null)
  const [dist, setDist] = useState(0)

  useEffect(() => {
    const wrap = wrapRef.current
    const copy = copyRef.current
    if (!wrap || !copy) return
    const measure = (): void => {
      const copyWidth = copy.offsetWidth
      setDist(copyWidth > wrap.clientWidth + 2 ? copyWidth + 40 : 0)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(wrap)
    ro.observe(copy)
    return () => ro.disconnect()
  }, [text])

  const overflow = dist > 0
  const style = overflow
    ? ({
        '--scroll-dist': `-${dist}px`,
        animationDuration: `${Math.max(3, dist / 28)}s`
      } as CSSProperties)
    : undefined

  return (
    <span
      ref={wrapRef}
      className={`scroll-text${overflow ? ' overflow' : ''}${className ? ' ' + className : ''}`}
      style={maxWidth ? { maxWidth: `${maxWidth}px` } : undefined}
    >
      <span ref={trackRef} className="scroll-text-track" style={style}>
        <span ref={copyRef} className="scroll-text-copy">
          {text}
        </span>
        {overflow && <span className="scroll-text-copy">{text}</span>}
      </span>
    </span>
  )
}
