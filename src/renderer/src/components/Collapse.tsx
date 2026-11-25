import type { ReactElement, ReactNode } from 'react'

interface CollapseProps {
  open: boolean
  children: ReactNode
}

/**
 * Reusable collapsible section (the `0fr → 1fr` height reveal used all over the
 * settings). Fully collapses when closed — the inner element carries no padding
 * of its own in that state, so nothing leaks out.
 */
export default function Collapse({ open, children }: CollapseProps): ReactElement {
  return (
    <div className={`collapse${open ? ' open' : ''}`}>
      <div className="collapse-inner">{children}</div>
    </div>
  )
}
