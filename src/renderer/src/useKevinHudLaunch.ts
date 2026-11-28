import { useCallback, useEffect, useRef, useState } from 'react'
import type { LaunchEffect } from '@shared/types'

/**
 * A full-screen launch effect is short (the shader runs ~1.5 s). This is only a
 * safety net for an effect that never reports completion (or a window that was
 * hidden mid-animation), so a launch can never wedge the HUD hand-off.
 */
export const LAUNCH_FX_TIMEOUT_MS = 3000

/** A hung IPC call must not keep the old window action from running forever. */
export const KEVIN_HUD_COMMIT_TIMEOUT_MS = 5000

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export interface LaunchFxOrigin {
  x: number
  y: number
}

export interface LaunchFxState {
  effect: LaunchEffect
  key: number
  originX: number
  originY: number
}

export type LaunchFxOutcome = 'done' | 'cancelled' | 'timeout' | 'none'

/** The completion side of exactly one rendered `LaunchTransition`. */
export interface LaunchFxRun {
  readonly done: Promise<LaunchFxOutcome>
}

export interface KevinHudHandoffOptions {
  run: LaunchFxRun | null
  /** `appId`, or `linked:<id>` for a linked launch. */
  runtimeKey: string
  /**
   * Read after the transition finishes, so a settings change made while the
   * animation is running is respected. A function is safe to pass here.
   */
  reducedMotion: boolean | (() => boolean)
  commit(runtimeKey: string, reducedMotion: boolean): Promise<boolean>
  /**
   * `LaunchResult.kevinHudStarted`: main prepared a HUD request while this
   * launch succeeded. Prepared is not started — the request is committed here
   * after this launch's real transition. `false` keeps the legacy launch
   * timing and does not wait for the effect.
   */
  prepared: boolean
  /** Test overrides. */
  fxTimeoutMs?: number
  commitTimeoutMs?: number
}

/** Reads the media query as a real boolean; never installs a listener. */
export function isReducedMotion(value: { matches?: unknown } | null | undefined): boolean {
  return value?.matches === true
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return isReducedMotion(window.matchMedia(REDUCED_MOTION_QUERY))
  } catch {
    return false
  }
}

/** Runtime key used for a linked launch's HUD session. */
export function linkedLaunchRuntimeKey(id: string): string {
  return `linked:${id}`
}

/**
 * Wait for the effect to report `onDone`. Cancellation, a missing effect,
 * errors and the timeout all resolve so the caller can continue with the HUD
 * hand-off instead of hanging the launch path.
 */
export async function waitForLaunchFx(
  run: LaunchFxRun | null,
  timeoutMs = LAUNCH_FX_TIMEOUT_MS
): Promise<LaunchFxOutcome> {
  if (!run) return 'none'
  const done = run.done.then(
    (outcome): LaunchFxOutcome => outcome,
    (): LaunchFxOutcome => 'cancelled'
  )
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return done
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      done,
      new Promise<LaunchFxOutcome>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Confirm the prepared HUD request after this launch's transition. Returns
 * `true` only when the main process accepted/owns the HUD session; every other
 * outcome (not prepared, false, cancellation, error, timeout) resolves without
 * throwing so the caller can keep its legacy after-launch behavior.
 */
export async function handOffToKevinHud(options: KevinHudHandoffOptions): Promise<boolean> {
  // A prepared request is not a running HUD. Without one there is nothing to
  // confirm, and waiting for the visual effect would only delay the launcher's
  // existing afterLaunch action.
  if (options.prepared !== true) return false
  await waitForLaunchFx(options.run, options.fxTimeoutMs)
  let reducedMotion = false
  try {
    reducedMotion =
      typeof options.reducedMotion === 'function'
        ? options.reducedMotion() === true
        : options.reducedMotion === true
  } catch {
    // A broken media query must not block the legacy launch path.
  }
  const commit = (): Promise<boolean> => options.commit(options.runtimeKey, reducedMotion)
  const commitTimeoutMs = options.commitTimeoutMs ?? KEVIN_HUD_COMMIT_TIMEOUT_MS
  if (!Number.isFinite(commitTimeoutMs) || commitTimeoutMs <= 0) {
    try {
      return (await commit()) === true
    } catch {
      return false
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(commit).then(
        (started) => started === true,
        () => false
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), commitTimeoutMs)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

interface ActiveLaunchFx extends LaunchFxRun {
  readonly key: number
  settle(outcome: LaunchFxOutcome): void
}

function createLaunchFx(key: number): ActiveLaunchFx {
  let resolve!: (outcome: LaunchFxOutcome) => void
  let settled = false
  return {
    key,
    done: new Promise<LaunchFxOutcome>((done) => {
      resolve = done
    }),
    settle(outcome: LaunchFxOutcome): void {
      if (settled) return
      settled = true
      resolve(outcome)
    }
  }
}

export interface KevinHudLaunchOptions {
  /** Mirrors the visual-activity gate; no transition is drawn when paused. */
  visible: boolean
  commit(runtimeKey: string, reducedMotion: boolean): Promise<boolean>
  fxTimeoutMs?: number
  commitTimeoutMs?: number
}

export interface KevinHudLaunch {
  launchFx: LaunchFxState | null
  /** Start the one full-screen effect owned by this launch. */
  playLaunchFx(effect: LaunchEffect, origin: LaunchFxOrigin): LaunchFxRun | null
  /** Called by `LaunchTransition`; the key rejects a stale instance's onDone. */
  finishLaunchFx(key?: number): void
  /** Wait for that effect, then confirm the HUD session prepared by this launch. */
  handOff(run: LaunchFxRun | null, runtimeKey: string, prepared: boolean): Promise<boolean>
}

/**
 * Owns the launch-effect → KEVIN HUD hand-off. A prepared HUD is confirmed
 * only after this launch's transition (or immediately when no transition is
 * drawn), each rendered effect can confirm at most once, and a launch without
 * a prepared request returns to the legacy path without waiting.
 */
export function useKevinHudLaunch({
  visible,
  commit,
  fxTimeoutMs,
  commitTimeoutMs
}: KevinHudLaunchOptions): KevinHudLaunch {
  const [launchFx, setLaunchFx] = useState<LaunchFxState | null>(null)
  const currentRun = useRef<ActiveLaunchFx | null>(null)
  const nextKey = useRef(0)
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const commitRef = useRef(commit)
  commitRef.current = commit
  const attempts = useRef(new WeakMap<LaunchFxRun, Promise<boolean>>())

  const settleCurrent = useCallback((outcome: LaunchFxOutcome): void => {
    const run = currentRun.current
    currentRun.current = null
    run?.settle(outcome)
  }, [])

  useEffect(() => {
    if (visible) return
    settleCurrent('cancelled')
    setLaunchFx(null)
  }, [visible, settleCurrent])

  useEffect(() => () => {
    settleCurrent('cancelled')
  }, [settleCurrent])

  const playLaunchFx = useCallback((effect: LaunchEffect, origin: LaunchFxOrigin): LaunchFxRun | null => {
    // No animated launch path: the caller continues straight to confirmation.
    if (effect === 'none' || !visibleRef.current) return null
    // A newer launch replaces the visible effect; the previous wait continues
    // (cancelled) so its own launch path can still finish.
    const previous = currentRun.current
    currentRun.current = null
    previous?.settle('cancelled')
    const key = ++nextKey.current
    const run = createLaunchFx(key)
    currentRun.current = run
    setLaunchFx({ effect, key, originX: origin.x, originY: origin.y })
    return run
  }, [])

  const finishLaunchFx = useCallback((key?: number): void => {
    const run = currentRun.current
    if (!run || (key !== undefined && run.key !== key)) return
    currentRun.current = null
    run.settle('done')
    setLaunchFx(null)
  }, [])

  const handOff = useCallback(
    (run: LaunchFxRun | null, runtimeKey: string, prepared: boolean): Promise<boolean> => {
      // No prepared request: resolve without touching the transition so the
      // legacy afterLaunch action keeps its original timing.
      if (!prepared) return Promise.resolve(false)
      const cached = run ? attempts.current.get(run) : undefined
      if (cached) return cached
      const attempt = handOffToKevinHud({
        run,
        runtimeKey,
        reducedMotion: prefersReducedMotion,
        commit: (key, reduced) => commitRef.current(key, reduced),
        prepared: true,
        fxTimeoutMs,
        commitTimeoutMs
      })
      if (run) attempts.current.set(run, attempt)
      return attempt
    },
    [fxTimeoutMs, commitTimeoutMs]
  )

  return { launchFx, playLaunchFx, finishLaunchFx, handOff }
}
