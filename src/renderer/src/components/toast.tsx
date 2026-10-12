import { useEffect, useState, type ReactElement } from 'react'

/**
 * Reusable toast queue. The store lives outside React, so any module can call
 * `showToast(...)` (no context needed) and multiple toasts stack safely.
 * Appearance is unchanged (`--glass-2` style, no material).
 */
export interface ToastItem {
  id: number
  message: string
  closing?: boolean
}

let items: ToastItem[] = []
let nextId = 1
const listeners = new Set<(items: ToastItem[]) => void>()
const timers = new Map<number, number>()

function emit(): void {
  for (const listener of listeners) listener(items)
}

/** Push a toast. Returns its id (usable with `dismissToast`). */
export function showToast(message: string, duration = 3200): number {
  const id = nextId++
  items = [...items, { id, message }]
  emit()
  if (duration > 0) {
    timers.set(
      id,
      window.setTimeout(() => dismissToast(id), duration)
    )
  }
  return id
}

export function dismissToast(id: number): void {
  const timer = timers.get(id)
  if (timer) {
    window.clearTimeout(timer)
    timers.delete(id)
  }
  const item = items.find((i) => i.id === id)
  if (!item || item.closing) return
  // Play an exit animation, then remove.
  item.closing = true
  items = [...items]
  emit()
  window.setTimeout(() => {
    const next = items.filter((i) => i.id !== id)
    if (next.length === items.length) return
    items = next
    emit()
  }, 170)
}

/** The stacking host — render once, near the app root. */
export default function Toaster(): ReactElement {
  const [list, setList] = useState<ToastItem[]>(items)

  useEffect(() => {
    setList(items)
    listeners.add(setList)
    return () => {
      listeners.delete(setList)
    }
  }, [])

  return (
    <div className="toast-stack" aria-live="polite">
      {list.map((item) => (
        <div
          className={`toast${item.closing ? ' closing' : ''}`}
          key={item.id}
          onClick={() => dismissToast(item.id)}
        >
          {item.message}
        </div>
      ))}
    </div>
  )
}
