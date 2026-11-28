/**
 * Standalone, narrow preload for the KEVIN HUD renderer.
 *
 * The owner window must deliberately load this file as its preload. Nothing
 * here creates windows, reads game state or exposes raw IPC. The only renderer
 * surface is `window.kevinHud` with two members:
 *
 * - `onFrame(listener)` receives contiguous `phase: 'announce' | 'monitor' |
 *   'exit'` frames pushed by the main process;
 * - `ready()` asks the owner for the latest cached frame. This is a recovery
 *   handshake; the owner is still expected to re-send its latest cached frame
 *   whenever the HUD page finishes loading. That repeated push covers the
 *   window between the first sample and the renderer subscribing.
 *
 * The preload keeps the latest received frame so a late subscriber gets it
 * immediately instead of waiting for the next sampling tick. It never
 * synthesizes frames, samples hardware or writes configuration.
 *
 * Authentication note: only the window owner can decide whether a sender is
 * entitled to a frame. The `ready` handshake accepts an optional opaque token
 * and forwards the sender's context unchanged; an owner that needs an extra
 * gate can validate `event.senderFrame` / `event.sender` and, if desired, that
 * token. There is intentionally no privileged/raw IPC escape hatch here.
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { KevinHudFrame } from '@shared/kevinHud'

/**
 * Channel names exported for the main-process owner's IPC module.
 * `frame` intentionally matches `src/main/services/kevinHudWindow.ts`.
 */
export const KEVIN_HUD_CHANNELS = {
  /** main -> preload: one immutable frame */
  frame: 'kevinHud:frame',
  /** renderer -> main (invoke): request the latest cached frame */
  ready: 'kevinHud:ready'
} as const

/** Owner-defined gate material; this bridge treats it as opaque. */
export interface KevinHudReadyHandshake {
  token?: string
}

export interface KevinHudBridge {
  onFrame(listener: (frame: KevinHudFrame) => void): () => void
  ready(handshake?: KevinHudReadyHandshake): Promise<KevinHudFrame | null>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Shallow transport guard only. The shared renderer contract normalizes the
 * config and metric values; rejecting malformed envelope shapes here keeps a
 * stray unrelated IPC payload from reaching the visual layer.
 */
const isKevinHudFrame = (value: unknown): value is KevinHudFrame => {
  if (!isRecord(value)) return false
  const phase = value.phase
  return (
    (phase === 'announce' || phase === 'monitor' || phase === 'exit') &&
    isRecord(value.config)
  )
}

const listeners = new Set<(frame: KevinHudFrame) => void>()
let latestFrame: KevinHudFrame | null = null

const reportListenerError = (error: unknown): void => {
  // A broken consumer must not break the IPC event loop for the others.
  console.error('[kevin-hud] frame listener failed', error)
}

const deliver = (frame: KevinHudFrame): void => {
  latestFrame = frame
  for (const listener of [...listeners]) {
    if (!listeners.has(listener)) continue
    try {
      listener(frame)
    } catch (error) {
      reportListenerError(error)
    }
  }
}

ipcRenderer.on(KEVIN_HUD_CHANNELS.frame, (_event, payload: unknown) => {
  if (!isKevinHudFrame(payload)) return
  deliver(payload)
})

const bridge: KevinHudBridge = {
  onFrame(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('kevinHud.onFrame expects a listener function')
    }
    listeners.add(listener)

    // Late subscribers see the latest pushed frame immediately. The queued
    // delivery gives the caller a chance to finish its effect setup first.
    if (latestFrame) {
      const cached = latestFrame
      queueMicrotask(() => {
        if (!listeners.has(listener)) return
        try {
          listener(cached)
        } catch (error) {
          reportListenerError(error)
        }
      })
    }

    return () => {
      listeners.delete(listener)
    }
  },

  async ready(handshake) {
    const token =
      handshake && typeof handshake.token === 'string' ? handshake.token : null
    const frame: unknown = await ipcRenderer.invoke(
      KEVIN_HUD_CHANNELS.ready,
      token === null ? null : { token }
    )
    if (!isKevinHudFrame(frame)) return null
    latestFrame = frame
    return frame
  }
}

contextBridge.exposeInMainWorld('kevinHud', bridge)
