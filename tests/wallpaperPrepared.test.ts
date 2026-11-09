import { describe, expect, it } from 'vitest'
import { peekPreparedWallpaper, wallpaperCacheKey } from '../src/renderer/src/wallpaperPrepared'

describe('wallpaperCacheKey', () => {
  it('keys by source and rounded display size', () => {
    const a = wallpaperCacheKey('kevin-media://bg/a.png', 2000.4, 1200.6, 1.5)
    const b = wallpaperCacheKey('kevin-media://bg/a.png', 2000, 1201, 1.5)
    expect(a).toBe(b)
    expect(a).toContain('kevin-media://bg/a.png')
    expect(a).toContain('2000x1201@1.5')
  })

  it('never collides across sources or display sizes', () => {
    const base = wallpaperCacheKey('kevin-media://bg/a.png', 1000, 800, 1)
    expect(base).not.toBe(wallpaperCacheKey('kevin-media://bg/b.png', 1000, 800, 1))
    expect(base).not.toBe(wallpaperCacheKey('kevin-media://bg/a.png', 2000, 1600, 1))
    expect(base).not.toBe(wallpaperCacheKey('kevin-media://bg/a.png', 1000, 800, 2))
  })
})

describe('peekPreparedWallpaper', () => {
  it('misses for a wallpaper that was never prepared', () => {
    expect(peekPreparedWallpaper('kevin-media://bg/unknown.png', 800, 600, 1)).toEqual({
      hit: false,
      value: null
    })
  })
})
