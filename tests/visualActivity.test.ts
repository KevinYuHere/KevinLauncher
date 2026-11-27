import { describe, expect, it } from 'vitest'
import { shouldPauseVisuals } from '../src/renderer/src/useWindowVisible'

const CLEAR = {
  gameRunning: false,
  windowVisible: true,
  windowFocused: true,
  systemAwake: true
}

describe('visual power-saving gate', () => {
  it('keeps animations running only when every trigger is clear', () => {
    expect(shouldPauseVisuals(CLEAR)).toBe(false)
  })

  it.each([
    ['a tracked game is running', { gameRunning: true }],
    ['the window is hidden, minimized or in the tray', { windowVisible: false }],
    ['the window lost focus', { windowFocused: false }],
    ['the screen is locked or the system is asleep', { systemAwake: false }]
  ])('pauses when %s', (_reason, patch) => {
    expect(shouldPauseVisuals({ ...CLEAR, ...patch })).toBe(true)
  })

  it('pauses a running game even while the launcher is visible and focused', () => {
    expect(shouldPauseVisuals({ ...CLEAR, gameRunning: true })).toBe(true)
  })

  it('stays paused until all overlapping triggers clear', () => {
    const partial = {
      ...CLEAR,
      gameRunning: true,
      windowVisible: false,
      windowFocused: false,
      systemAwake: false
    }
    expect(shouldPauseVisuals(partial)).toBe(true)
    expect(shouldPauseVisuals({ ...partial, gameRunning: false })).toBe(true)
    expect(shouldPauseVisuals({ ...partial, gameRunning: false, windowVisible: true })).toBe(true)
    expect(
      shouldPauseVisuals({ ...partial, gameRunning: false, windowVisible: true, windowFocused: true })
    ).toBe(true)
    expect(
      shouldPauseVisuals({
        gameRunning: false,
        windowVisible: true,
        windowFocused: true,
        systemAwake: true
      })
    ).toBe(false)
  })
})
