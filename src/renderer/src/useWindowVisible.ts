import { useEffect, useState, useSyncExternalStore } from 'react'

export function windowVisible(): boolean {
  return document.visibilityState !== 'hidden'
}

function subscribe(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}

export function useWindowVisible(): boolean {
  return useSyncExternalStore(subscribe, windowVisible)
}

function subscribeFocus(onChange: () => void): () => void {
  window.addEventListener('focus', onChange)
  window.addEventListener('blur', onChange)
  return () => {
    window.removeEventListener('focus', onChange)
    window.removeEventListener('blur', onChange)
  }
}

export function useVisualActivity(gameRunning: boolean): boolean {
  const visible = useWindowVisible()
  const focused = useSyncExternalStore(subscribeFocus, () => document.hasFocus())
  const [awake, setAwake] = useState(true)
  useEffect(() => {
    let current = true
    let received = false
    const off = window.api.onWindowActivity((value) => {
      received = true
      setAwake(value)
    })
    void window.api.windowActivity().then((value) => {
      if (current && !received) setAwake(value)
    }).catch(console.error)
    return () => { current = false; off() }
  }, [])
  return visible && awake && (!gameRunning || focused)
}
