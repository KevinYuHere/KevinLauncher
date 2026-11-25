import { useLayoutEffect, type RefObject } from 'react'

/**
 * Snapshot where the dialog was *opened* (the live `--dx/--dy` at mount) onto the
 * modal element as `--open-dx/--open-dy`. The close animation then collapses back
 * to that point — not to wherever the close button was clicked.
 */
export function useOpenOrigin(ref: RefObject<HTMLElement | null>): void {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const cs = getComputedStyle(document.documentElement)
    el.style.setProperty('--open-dx', cs.getPropertyValue('--dx').trim() || '0px')
    el.style.setProperty('--open-dy', cs.getPropertyValue('--dy').trim() || '0px')
  }, [])
}
