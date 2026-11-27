import { describe, expect, it, vi } from 'vitest'
import {
  handOffToKevinHud,
  isReducedMotion,
  linkedLaunchRuntimeKey,
  prefersReducedMotion,
  waitForLaunchFx,
  type LaunchFxOutcome
} from '../src/renderer/src/useKevinHudLaunch'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('KEVIN HUD launch helpers', () => {
  it('builds the linked runtime key without touching app ids', () => {
    expect(linkedLaunchRuntimeKey('item-1')).toBe('linked:item-1')
  })

  it('treats prefers-reduced-motion as a boolean match', () => {
    expect(isReducedMotion({ matches: true })).toBe(true)
    expect(isReducedMotion({ matches: false })).toBe(false)
    expect(isReducedMotion({ matches: 1 })).toBe(false)
    expect(isReducedMotion({ matches: 'true' })).toBe(false)
    expect(isReducedMotion(null)).toBe(false)
  })

  it('reads the media query once and installs no global listener', () => {
    const matchMedia = vi.fn(() => ({ matches: true }))
    vi.stubGlobal('window', { matchMedia })
    try {
      expect(prefersReducedMotion()).toBe(true)
      expect(matchMedia).toHaveBeenCalledTimes(1)
      expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('continues after a cancelled or failed effect wait', async () => {
    await expect(waitForLaunchFx({ done: Promise.reject(new Error('cancelled')) }))
      .resolves.toBe('cancelled')
    await expect(waitForLaunchFx({ done: Promise.resolve('cancelled') })).resolves.toBe('cancelled')
    await expect(waitForLaunchFx(null)).resolves.toBe('none')
  })
})

describe('KEVIN HUD launch hand-off', () => {
  it('waits for the real transition before confirming a prepared HUD', async () => {
    const effect = deferred<LaunchFxOutcome>()
    const order: string[] = []
    const commit = vi.fn(async (runtimeKey: string, reducedMotion: boolean) => {
      order.push(`commit:${runtimeKey}:${reducedMotion}`)
      return true
    })
    const pending = handOffToKevinHud({
      run: { done: effect.promise },
      runtimeKey: 'app-1',
      reducedMotion: true,
      prepared: true,
      commit
    })

    await Promise.resolve()
    expect(commit).not.toHaveBeenCalled()
    order.push('done')
    effect.resolve('done')

    await expect(pending).resolves.toBe(true)
    expect(order).toEqual(['done', 'commit:app-1:true'])
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('reads reduced motion after the transition, not when the request starts', async () => {
    const effect = deferred<LaunchFxOutcome>()
    const reducedMotion = vi.fn(() => true)
    const commit = vi.fn(async () => true)
    const pending = handOffToKevinHud({
      run: { done: effect.promise },
      runtimeKey: 'app-2',
      reducedMotion,
      prepared: true,
      commit
    })

    expect(reducedMotion).not.toHaveBeenCalled()
    effect.resolve('done')
    await pending

    expect(reducedMotion).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith('app-2', true)
  })

  it('returns immediately and never commits when no HUD was prepared', async () => {
    vi.useFakeTimers()
    try {
      const commit = vi.fn(async () => true)
      const pending = handOffToKevinHud({
        run: { done: new Promise(() => undefined) },
        runtimeKey: 'app-3',
        reducedMotion: true,
        prepared: false,
        commit
      })
      // Waiting even for the effect timeout would still be too late for the
      // legacy afterLaunch action.
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(pending).resolves.toBe(false)
      expect(commit).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('commits immediately when a prepared launch has no transition', async () => {
    const commit = vi.fn(async () => true)
    await expect(handOffToKevinHud({
      run: null,
      runtimeKey: 'app-4',
      reducedMotion: false,
      prepared: true,
      commit
    })).resolves.toBe(true)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith('app-4', false)
  })

  it('keeps the legacy path when confirmation fails or throws', async () => {
    await expect(handOffToKevinHud({
      run: null,
      runtimeKey: 'app-5',
      reducedMotion: false,
      prepared: true,
      commit: async () => false
    })).resolves.toBe(false)

    await expect(handOffToKevinHud({
      run: null,
      runtimeKey: 'app-6',
      reducedMotion: false,
      prepared: true,
      commit: async () => { throw new Error('ipc failed') }
    })).resolves.toBe(false)
  })

  it('times out a stale effect and still hands off the prepared HUD', async () => {
    vi.useFakeTimers()
    try {
      const commit = vi.fn(async () => true)
      const pending = handOffToKevinHud({
        run: { done: new Promise(() => undefined) },
        runtimeKey: 'linked:item-1',
        reducedMotion: false,
        prepared: true,
        fxTimeoutMs: 50,
        commit
      })
      await vi.advanceTimersByTimeAsync(60)
      await expect(pending).resolves.toBe(true)
      expect(commit).toHaveBeenCalledWith('linked:item-1', false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out a hung confirmation and keeps the legacy path', async () => {
    vi.useFakeTimers()
    try {
      const commit = vi.fn(() => new Promise<boolean>(() => undefined))
      const pending = handOffToKevinHud({
        run: null,
        runtimeKey: 'app-7',
        reducedMotion: false,
        prepared: true,
        commitTimeoutMs: 40,
        commit
      })
      // Let the no-effect wait resume and arm the confirmation timeout.
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(50)
      await expect(pending).resolves.toBe(false)
      expect(commit).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never sends a second commit after a confirmation timeout', async () => {
    vi.useFakeTimers()
    try {
      const result = deferred<boolean>()
      const commit = vi.fn(() => result.promise)
      const pending = handOffToKevinHud({
        run: null,
        runtimeKey: 'app-8',
        reducedMotion: false,
        prepared: true,
        commitTimeoutMs: 40,
        commit
      })
      await vi.advanceTimersByTimeAsync(50)
      await expect(pending).resolves.toBe(false)
      result.resolve(true)
      await Promise.resolve()
      expect(commit).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
