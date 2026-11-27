import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { installVisualPause } from './visualPause'

export function windowVisible(): boolean {
  return !document.hidden
}

function subscribe(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}

export function useWindowVisible(): boolean {
  return useSyncExternalStore(subscribe, windowVisible)
}

function windowFocused(): boolean {
  return document.hasFocus()
}

function subscribeFocus(onChange: () => void): () => void {
  // `focus` alone misses the tray/restore path on some Windows set-ups: the
  // document can become visible again before (or without) a second focus
  // event. Re-read `hasFocus()` on visibility changes as well so an actually
  // focusable window resumes immediately instead of staying paused.
  window.addEventListener('focus', onChange)
  window.addEventListener('blur', onChange)
  window.addEventListener('pageshow', onChange)
  document.addEventListener('visibilitychange', onChange)
  return () => {
    window.removeEventListener('focus', onChange)
    window.removeEventListener('blur', onChange)
    window.removeEventListener('pageshow', onChange)
    document.removeEventListener('visibilitychange', onChange)
  }
}

export interface VisualActivityState {
  /** Any game tracked by the launcher is running. */
  gameRunning: boolean
  /** The document is not hidden (covers minimize and tray). */
  windowVisible: boolean
  /** The launcher window has OS focus (loss of focus must pause too). */
  windowFocused: boolean
  /** The main process reports an unlocked, awake display. */
  systemAwake: boolean
}

/**
 * Power-saving gate for continuous visuals.
 *
 * The triggers are deliberately OR-ed: a running game, a hidden/minimized/tray
 * window, loss of focus, a locked screen or sleep all suspend video playback,
 * CSS animations and SMIL. Visuals may resume only after every trigger is
 * clear, but non-animated UI stays fully operable in the meantime.
 */
export function shouldPauseVisuals(state: VisualActivityState): boolean {
  return (
    state.gameRunning ||
    !state.windowVisible ||
    !state.windowFocused ||
    !state.systemAwake
  )
}

export function useVisualActivity(gameRunning: boolean): boolean {
  const visible = useWindowVisible()
  const focused = useSyncExternalStore(subscribeFocus, windowFocused)
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

  // SMIL animations ignore `animation-play-state`; freeze their SVG timelines
  // while the shared marker is present. CSS animations are handled by main.css
  // and the wallpaper video by App.tsx.
  useLayoutEffect(() => installVisualPause(), [])

  return !shouldPauseVisuals({
    gameRunning,
    windowVisible: visible,
    windowFocused: focused,
    systemAwake: awake
  })
}
