import { useLayoutEffect, useRef, type RefObject } from 'react'

const focusable = [
  'button', 'input', 'select', 'textarea', 'a[href]', '[tabindex]', 'video[controls]'
].join(',')
const stack: HTMLElement[] = []
const isolated = new Map<HTMLElement, boolean>()

function isolateTop(): void {
  for (const [node, previous] of isolated) node.inert = previous
  isolated.clear()
  const modal = stack.at(-1)
  if (!modal) return
  for (let child: HTMLElement | null = modal; child?.parentElement && child.id !== 'root'; child = child.parentElement) {
    for (const sibling of child.parentElement.children) {
      if (sibling === child || !(sibling instanceof HTMLElement)) continue
      isolated.set(sibling, sibling.inert)
      sibling.inert = true
    }
  }
}

function tabbable(scope: HTMLElement): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(focusable)].filter((node) =>
    node.tabIndex >= 0 && !node.matches(':disabled') && !node.closest('[inert], [hidden]') &&
    node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden'
  )
}

export function useDialogFocus(
  ref: RefObject<HTMLElement>, active: boolean, onEscape?: () => void
): void {
  const escape = useRef(onEscape)
  escape.current = onEscape
  useLayoutEffect(() => {
    const modal = ref.current
    if (!active || !modal) return
    const previous = document.activeElement
    stack.push(modal)
    isolateTop()
    const focusFirst = (): void => {
      const preferred = modal.querySelector<HTMLElement>('[data-dialog-first]')
      ;(preferred ?? tabbable(modal)[0] ?? modal).focus({ preventScroll: true })
    }
    focusFirst()
    const onFocus = (event: FocusEvent): void => {
      if (stack.at(-1) === modal && !modal.contains(event.target as Node)) focusFirst()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (stack.at(-1) !== modal || event.defaultPrevented) return
      if (event.key === 'Escape' && escape.current) {
        event.preventDefault()
        escape.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = tabbable(modal)
      const index = items.indexOf(document.activeElement as HTMLElement)
      if (items.length === 0) {
        event.preventDefault()
        modal.focus()
      } else if (index < 0 || (event.shiftKey ? index === 0 : index === items.length - 1)) {
        event.preventDefault()
        items[event.shiftKey ? items.length - 1 : 0].focus()
      }
    }
    document.addEventListener('focusin', onFocus)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('keydown', onKey)
      const index = stack.indexOf(modal)
      const wasTop = index === stack.length - 1
      if (index >= 0) stack.splice(index, 1)
      isolateTop()
      if (wasTop) queueMicrotask(() => {
        const top = stack.at(-1)
        if (top?.contains(document.activeElement)) return
        if (previous instanceof HTMLElement && previous.isConnected && !previous.closest('[inert]')) {
          previous.focus({ preventScroll: true })
        } else if (top) (tabbable(top)[0] ?? top).focus({ preventScroll: true })
      })
    }
  }, [active, ref])
}
