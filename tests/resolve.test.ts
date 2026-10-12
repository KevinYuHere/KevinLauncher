import { describe, it, expect } from 'vitest'
import { pushOut2D, type Rect } from '../src/renderer/src/drag/resolve'

const bounds = { w: 1116, h: 696 }
const overlap = (a: Rect, b: Rect, gap: number): boolean =>
  a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y

describe('pushOut2D', () => {
  it('keeps the target clear instead of bouncing between two neighbours', () => {
    // Regression: a large module dropped into a crowded corner used to make the
    // launch button oscillate up/down between the target and the playtime pill,
    // so the drop was rejected with "no space".
    const playtime: Rect = { id: 'playtime', x: 370, y: 390, w: 119, h: 54 }
    const launch: Rect = { id: 'launch', x: 347, y: 458, w: 137, h: 54 }
    const target: Rect = { id: 'info', x: 300, y: 450, w: 131, h: 135 }
    const { resolved, moves } = pushOut2D([playtime, launch], target, 14, bounds)
    expect(resolved).toBe(true)
    const moved = { ...launch, ...moves.get('launch')! }
    expect(overlap(moved, target, 14)).toBe(false)
  })

  it('resolves with a wider (update-style) launch button', () => {
    const playtime: Rect = { id: 'playtime', x: 300, y: 390, w: 119, h: 54 }
    const launch: Rect = { id: 'launch', x: 320, y: 458, w: 210, h: 54 }
    const target: Rect = { id: 'info', x: 280, y: 440, w: 131, h: 135 }
    const { resolved } = pushOut2D([playtime, launch], target, 14, bounds)
    expect(resolved).toBe(true)
  })

  it('does not move anything when there is no overlap', () => {
    const a: Rect = { id: 'a', x: 0, y: 0, w: 100, h: 50 }
    const b: Rect = { id: 'b', x: 600, y: 400, w: 100, h: 50 }
    const target: Rect = { id: 't', x: 500, y: 100, w: 100, h: 50 }
    const { resolved, moves } = pushOut2D([a, b], target, 14, bounds)
    expect(resolved).toBe(true)
    expect(moves.get('a')).toEqual({ x: 0, y: 0 })
    expect(moves.get('b')).toEqual({ x: 600, y: 400 })
  })

  it('reports no space only when the target truly cannot fit', () => {
    const filled: Rect[] = []
    for (let y = 0; y < bounds.h; y += 60) {
      for (let x = 0; x < bounds.w; x += 140) {
        filled.push({ id: `f${x}-${y}`, x, y, w: 140, h: 60 })
      }
    }
    const target: Rect = { id: 'info', x: 10, y: 10, w: 131, h: 135 }
    const { resolved } = pushOut2D(filled, target, 14, bounds)
    expect(resolved).toBe(false)
  })
})
