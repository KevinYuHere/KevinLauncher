import { useCallback, useEffect, useRef } from 'react'

/** The caller captures the ID and the immutable value in each save callback. */
export function useDebouncedEntitySave() {
  const pending = useRef(new Map<string, { timer: number; save: () => void }>())
  useEffect(() => () => {
    for (const { timer, save } of pending.current.values()) {
      window.clearTimeout(timer)
      save()
    }
    pending.current.clear()
  }, [])
  return useCallback((id: string, delay: number, save: () => void): void => {
    const previous = pending.current.get(id)
    if (previous) window.clearTimeout(previous.timer)
    const task = {
      save,
      timer: window.setTimeout(() => {
        if (pending.current.get(id) !== task) return
        pending.current.delete(id)
        save()
      }, delay)
    }
    pending.current.set(id, task)
  }, [])
}
