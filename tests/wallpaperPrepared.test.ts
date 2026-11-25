import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareWallpaperForDisplay, wallpaperCacheKey } from '../src/renderer/src/wallpaperPrepared'

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


afterEach(() => vi.unstubAllGlobals())

it('retries failed preparations, shares in-flight work, and revokes evicted URLs after release', async () => {
  let loads = 0
  const revoked: string[] = []
  vi.stubGlobal('Image', class { decode() { return Promise.resolve() }; removeAttribute() {} })
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL() { return 'blob:' + loads }
    static revokeObjectURL(url: string) { revoked.push(url) }
  })
  vi.stubGlobal('Worker', class {
    onmessage!: (e: { data: object }) => void
    postMessage({ key }: { key: string }) {
      loads++
      queueMicrotask(() => this.onmessage({ data: loads === 1 ? { key, error: 'decode' } : { key, blob: new Blob(), width: 80, height: 60 } }))
    }
  })
  const get = (name: string) => prepareWallpaperForDisplay(name, 80, 60, 1)
  expect(await get('A')).toBeNull()
  const second = get('A')
  expect(get('A')).toBe(second)
  const image = (await second)!
  image.retain()
  expect(await get('A')).toBe(image)
  expect(loads).toBe(2)
  for (let i = 0; i < 6; i++) await get('B' + i)
  expect(revoked).not.toContain(image.url)
  image.release()
  expect(revoked).toContain(image.url)
})
