import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  KEVIN_HUD_DEPARTURE_DURATION_MS,
  cancelKevinHudDeparture,
  computeKevinHudDepartureFrame,
  isKevinHudDepartureActive,
  kevinHudRectCenter,
  playKevinHudDeparture,
  type KevinHudDepartureWindow,
  type KevinHudRect
} from '../src/main/services/kevinHudDeparture'

class FakeWindow extends EventEmitter {
  bounds: KevinHudRect
  opacity: number
  visible = true
  destroyed = false
  minimumSize: [number, number] = [900, 600]
  hideCalls = 0
  readonly boundsWrites: KevinHudRect[] = []
  readonly minimumWrites: Array<[number, number]> = []

  constructor(bounds: KevinHudRect, opacity = 1) {
    super()
    this.bounds = { ...bounds }
    this.opacity = opacity
  }

  getBounds(): KevinHudRect {
    if (this.destroyed) throw new Error('window is destroyed')
    return { ...this.bounds }
  }

  setBounds(bounds: KevinHudRect, _animate?: boolean): void {
    if (this.destroyed) throw new Error('window is destroyed')
    this.bounds = { ...bounds }
    this.boundsWrites.push({ ...bounds })
  }

  getOpacity(): number {
    if (this.destroyed) throw new Error('window is destroyed')
    return this.opacity
  }

  setOpacity(opacity: number): void {
    if (this.destroyed) throw new Error('window is destroyed')
    this.opacity = opacity
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isVisible(): boolean {
    return this.visible
  }

  hide(): void {
    if (this.destroyed) throw new Error('window is destroyed')
    this.hideCalls += 1
    this.visible = false
    this.emit('hide')
  }

  show(): void {
    if (this.destroyed) throw new Error('window is destroyed')
    this.visible = true
    this.emit('show')
  }

  getMinimumSize(): number[] {
    return [...this.minimumSize]
  }

  setMinimumSize(width: number, height: number): void {
    if (this.destroyed) throw new Error('window is destroyed')
    this.minimumSize = [width, height]
    this.minimumWrites.push([width, height])
  }
}

const fakeTargetWindow = (window: FakeWindow): KevinHudDepartureWindow =>
  window as unknown as KevinHudDepartureWindow

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Kevin HUD departure target calculation', () => {
  it('accepts a real BrowserWindow without an adapter', () => {
    expectTypeOf<BrowserWindow>().toMatchTypeOf<KevinHudDepartureWindow>()
  })

  it('keeps the endpoints exact while exaggerating anticipation, squash, suction and the tail fade', () => {
    // Negative coordinates on a secondary display and fractional DIP values at
    // a non-100% monitor scale must pass through unchanged.
    const start = { x: -1780.5, y: 120.25, width: 1180, height: 760 }
    const target = { x: -2210.75, y: -170.5, width: 372.5, height: 168.25 }
    const startCenter = kevinHudRectCenter(start)
    const targetCenter = kevinHudRectCenter(target)
    const linearWidth = (start.width + target.width) / 2
    const linearHeight = (start.height + target.height) / 2

    expect(KEVIN_HUD_DEPARTURE_DURATION_MS).toBeGreaterThanOrEqual(420)
    expect(KEVIN_HUD_DEPARTURE_DURATION_MS).toBeLessThanOrEqual(540)

    const first = computeKevinHudDepartureFrame(start, target, 0, 0.86)
    expect(first.bounds).toEqual(start)
    expect(first.opacity).toBeCloseTo(0.86)

    // 0.15: a short readable anticipation. The window grows and recoils away
    // from the HUD before the suction begins.
    const anticipation = computeKevinHudDepartureFrame(start, target, 0.15, 0.86)
    expect(anticipation.bounds.width).toBeGreaterThan(start.width)
    expect(anticipation.bounds.height).toBeGreaterThan(start.height)
    const anticipationCenter = kevinHudRectCenter(anticipation.bounds)
    expect(anticipationCenter.x).toBeGreaterThan(startCenter.x)
    expect(anticipationCenter.y).toBeGreaterThan(startCenter.y)

    // 0.5: height collapses far faster than width. Compared with a plain
    // linear interpolation the launcher is visibly wider and much flatter.
    const middle = computeKevinHudDepartureFrame(start, target, 0.5, 0.8)
    const middleCenter = kevinHudRectCenter(middle.bounds)
    expect(middle.bounds.width).toBeGreaterThan(linearWidth)
    expect(middle.bounds.height).toBeLessThan(linearHeight)
    expect(middle.bounds.height).toBeLessThan(start.height * 0.35)
    expect(middleCenter.x).toBeLessThan(startCenter.x)
    expect(middleCenter.x).toBeGreaterThan(targetCenter.x)
    expect(middle.opacity).toBeGreaterThan(0)
    expect(middle.opacity).toBeLessThan(0.8)

    // 0.94: geometry has already snapped to the exact HUD rectangle while the
    // opacity is in its rapid tail drop.
    const tail = computeKevinHudDepartureFrame(start, target, 0.94, 1)
    expect(tail.bounds).toEqual(target)
    expect(tail.opacity).toBeGreaterThan(0)
    expect(tail.opacity).toBeLessThan(0.2)

    const last = computeKevinHudDepartureFrame(start, target, 1, 0.86)
    expect(last.bounds).toEqual(target)
    expect(kevinHudRectCenter(last.bounds)).toEqual(targetCenter)
    expect(last.opacity).toBe(0)

    expect(computeKevinHudDepartureFrame(start, target, -1).bounds).toEqual(start)
    expect(computeKevinHudDepartureFrame(start, target, 2).bounds).toEqual(target)
    expect(computeKevinHudDepartureFrame(start, target, 2).opacity).toBe(0)
  })
})

describe('Kevin HUD departure window lifecycle', () => {
  it('hides at the HUD then restores the original size, opacity and minimum size while hidden', async () => {
    vi.useFakeTimers()
    const original = { x: -1100, y: 60, width: 1180, height: 760 }
    const target = { x: -2300, y: -140, width: 360, height: 180 }
    const window = new FakeWindow(original, 0.9)
    const transition = playKevinHudDeparture(fakeTargetWindow(window), target, { durationMs: 48 })

    expect(isKevinHudDepartureActive(fakeTargetWindow(window))).toBe(true)
    await vi.advanceTimersByTimeAsync(32)
    expect(window.hideCalls).toBe(0)
    expect(window.bounds.width).toBeLessThan(original.width)
    expect(window.bounds.width).toBeGreaterThan(target.width)
    // The vertical squash is intentionally much stronger than the width shrink.
    expect(window.bounds.height).toBeLessThan(original.height * 0.5)
    expect(window.opacity).toBeLessThan(0.9)
    expect(window.opacity).toBeGreaterThan(0)
    expect(window.minimumWrites[0]).toEqual([0, 0])

    await vi.advanceTimersByTimeAsync(100)
    const result = await transition
    expect(result).toMatchObject({ status: 'completed', hidden: true, restored: true })
    expect(window.hideCalls).toBe(1)
    expect(window.visible).toBe(false)
    expect(window.bounds).toEqual(original)
    expect(window.opacity).toBeCloseTo(0.9)
    expect(window.minimumSize).toEqual([900, 600])
    expect(isKevinHudDepartureActive(fakeTargetWindow(window))).toBe(false)

    // The deadline timer must be cleared as well: no late frame may re-hide or
    // reshrink the window after the promise completed.
    const writesAfterCompletion = window.boundsWrites.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(window.boundsWrites).toHaveLength(writesAfterCompletion)
    expect(window.hideCalls).toBe(1)
  })

  it('plays the readable 480 ms anticipation, squash and tail fade, then restores exactly', async () => {
    vi.useFakeTimers()
    const original = { x: 100, y: 80, width: 1180, height: 760 }
    const target = { x: 1600, y: -140, width: 360, height: 180 }
    const window = new FakeWindow(original, 1)
    const transition = playKevinHudDeparture(fakeTargetWindow(window), target)

    await vi.advanceTimersByTimeAsync(80)
    expect(window.hideCalls).toBe(0)
    expect(window.bounds.width).toBeGreaterThan(original.width)
    expect(window.bounds.height).toBeGreaterThan(original.height)

    await vi.advanceTimersByTimeAsync(160)
    expect(window.bounds.width).toBeGreaterThan((original.width + target.width) / 2)
    expect(window.bounds.height).toBeLessThan((original.height + target.height) / 2)
    expect(window.opacity).toBeGreaterThan(0)
    expect(window.opacity).toBeLessThan(1)
    expect(window.hideCalls).toBe(0)

    await vi.advanceTimersByTimeAsync(224)
    // Tail: exact HUD geometry, fully transparent, but the native window is
    // still alive until the tween's final tick hides it.
    expect(window.bounds).toEqual(target)
    expect(window.opacity).toBe(0)
    expect(window.hideCalls).toBe(0)

    await vi.advanceTimersByTimeAsync(16)
    await expect(transition).resolves.toMatchObject({
      status: 'completed',
      hidden: true,
      restored: true
    })
    expect(window.hideCalls).toBe(1)
    expect(window.visible).toBe(false)
    expect(window.bounds).toEqual(original)
    expect(window.opacity).toBe(1)
    expect(window.minimumSize).toEqual([900, 600])
  })

  it('restores safely when a native host rejects the tiny intermediate bounds', async () => {
    vi.useFakeTimers()
    const original = { x: -900, y: 80, width: 1180, height: 760 }
    const target = { x: 200, y: 40, width: 60, height: 30 }
    const window = new FakeWindow(original, 0.8)
    const write = window.setBounds.bind(window)
    window.setBounds = (bounds: KevinHudRect, animate?: boolean): void => {
      if (bounds.width < 100) throw new Error('below the native minimum')
      write(bounds, animate)
    }

    const transition = playKevinHudDeparture(fakeTargetWindow(window), target)
    await vi.advanceTimersByTimeAsync(400)
    const result = await transition

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'error',
      hidden: false,
      restored: true
    })
    expect(window.visible).toBe(true)
    expect(window.hideCalls).toBe(0)
    expect(window.bounds).toEqual(original)
    expect(window.opacity).toBeCloseTo(0.8)
    expect(window.minimumSize).toEqual([900, 600])
    expect(isKevinHudDepartureActive(fakeTargetWindow(window))).toBe(false)
  })

  it('cancels mid-flight and restores the visible window with no later writes', async () => {
    vi.useFakeTimers()
    const original = { x: -900, y: 80, width: 1180, height: 760 }
    const target = { x: -2400, y: -200, width: 300, height: 160 }
    const window = new FakeWindow(original, 0.72)
    const transition = playKevinHudDeparture(fakeTargetWindow(window), target, { durationMs: 240 })

    await vi.advanceTimersByTimeAsync(48)
    const writesBeforeCancel = window.boundsWrites.length
    expect(cancelKevinHudDeparture(fakeTargetWindow(window))).toBe(true)

    expect(window.visible).toBe(true)
    expect(window.hideCalls).toBe(0)
    expect(window.bounds).toEqual(original)
    expect(window.opacity).toBeCloseTo(0.72)
    expect(window.minimumSize).toEqual([900, 600])

    const result = await transition
    expect(result).toMatchObject({
      status: 'cancelled',
      reason: 'cancelled',
      hidden: false,
      restored: true
    })
    expect(window.boundsWrites).toHaveLength(writesBeforeCancel + 1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(window.boundsWrites).toHaveLength(writesBeforeCancel + 1)
    expect(window.hideCalls).toBe(0)
  })

  it('restores immediately when the user shows the window during the tween', async () => {
    vi.useFakeTimers()
    const original = { x: 120, y: -200, width: 1180, height: 760 }
    const target = { x: 1600, y: -600, width: 320, height: 144 }
    const window = new FakeWindow(original)
    const transition = playKevinHudDeparture(fakeTargetWindow(window), target, { durationMs: 240 })

    await vi.advanceTimersByTimeAsync(32)
    window.visible = false
    window.show()

    const result = await transition
    expect(result).toMatchObject({
      status: 'cancelled',
      reason: 'window-shown',
      hidden: false,
      restored: true
    })
    expect(window.visible).toBe(true)
    expect(window.bounds).toEqual(original)
    expect(window.opacity).toBeCloseTo(1)
    expect(window.hideCalls).toBe(0)
  })

  it('lets a newer generation replace the active tween', async () => {
    vi.useFakeTimers()
    const original = { x: 0, y: 0, width: 1180, height: 760 }
    const firstTarget = { x: 500, y: 300, width: 300, height: 150 }
    const secondTarget = { x: 700, y: 420, width: 280, height: 140 }
    const window = new FakeWindow(original)
    const first = playKevinHudDeparture(fakeTargetWindow(window), firstTarget, { durationMs: 240 })

    await vi.advanceTimersByTimeAsync(32)
    const second = playKevinHudDeparture(fakeTargetWindow(window), secondTarget, { durationMs: 48 })
    await expect(first).resolves.toMatchObject({ status: 'cancelled', reason: 'replaced' })
    expect(window.visible).toBe(true)
    expect(window.bounds).toEqual(original)
    expect(isKevinHudDepartureActive(fakeTargetWindow(window))).toBe(true)

    await vi.advanceTimersByTimeAsync(100)
    await expect(second).resolves.toMatchObject({ status: 'completed', hidden: true, restored: true })
    expect(window.visible).toBe(false)
    expect(window.bounds).toEqual(original)
  })

  it('takes the immediate reduced-motion path and still restores while hidden', async () => {
    const original = { x: -300, y: 44, width: 1180, height: 760 }
    const target = { x: 80, y: 60, width: 340, height: 170 }
    const window = new FakeWindow(original, 0.65)
    const result = await playKevinHudDeparture(fakeTargetWindow(window), target, true)

    expect(result).toMatchObject({ status: 'completed', hidden: true, restored: true })
    expect(window.hideCalls).toBe(1)
    expect(window.visible).toBe(false)
    expect(window.bounds).toEqual(original)
    expect(window.opacity).toBeCloseTo(0.65)
    expect(window.minimumSize).toEqual([900, 600])
  })
})
