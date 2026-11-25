import { describe, expect, it } from 'vitest'
import { advanceIndex, stepIndex } from '@shared/wallpaper'

describe('wallpaper rotation', () => {
  it('steps in list order and wraps', () => {
    expect(stepIndex(3, 0, 1)).toBe(1)
    expect(stepIndex(3, 2, 1)).toBe(0)
    expect(stepIndex(3, 0, -1)).toBe(2)
    expect(stepIndex(0, 0, 1)).toBe(0)
  })

  it('loops forward for the loop strategy', () => {
    expect(advanceIndex(3, 1, 'loop')).toBe(2)
    expect(advanceIndex(3, 2, 'loop')).toBe(0)
  })

  it('never repeats the current index for random', () => {
    expect(advanceIndex(1, 0, 'random')).toBe(0)
    // A random source that always returns the current index must still advance.
    const fixed = advanceIndex(3, 1, 'random', () => 1 / 3)
    expect(fixed).not.toBe(1)
  })
})
