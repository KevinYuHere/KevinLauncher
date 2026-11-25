import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectGalleryImages } from '../src/main/services/gallery'
import { masonryLayout, visibleTiles } from '../src/renderer/src/gallery/masonry'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

it('selects the newest images across the whole directory before applying its result limit', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'kl gallery-'))
  try {
    await fs.mkdir(join(root, 'Z 新截图'))
    for (const [index, name] of ['A.png', 'B.png', 'C.png', 'Z 新截图/D.png', 'Z 新截图/E.png'].entries()) {
      const file = join(root, name)
      const mtime = new Date(1_000_000 + 2_000 * index)
      await fs.writeFile(file, String(index))
      await fs.utimes(file, mtime, mtime)
    }
    await fs.writeFile(join(root, 'newest.txt'), '')
    expect((await collectGalleryImages(root, 2)).map((image) => image.name)).toEqual(['E.png', 'D.png'])
    await expect(collectGalleryImages(join(root, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

it('finds intersecting tiles in a masonry gallery while bounding the visible list', () => {
  const layout = masonryLayout(1000, Array.from({ length: 3000 }, (_, i) => 1 + i % 3))
  const top = layout.height / 2
  const matches = visibleTiles(layout, top, top + 600)
  expect(matches).toEqual(layout.boxes.flatMap((box, i) => box.y + box.h >= top && box.y <= top + 600 ? [i] : []))
  expect(matches.length).toBeLessThan(50)
})

describe('thumbnail leases', () => {
  it('loads lazily, joins in-flight requests, keeps visible URLs, and invalidates path reuse', async () => {
    const messages: { id: number; url?: string; cancel?: boolean }[] = []
    const revoked: string[] = []
    const terminated = vi.fn()
    let deliver: (data: { id: number; blob?: Blob; width?: number; height?: number }) => void
    let workers = 0
    vi.stubGlobal('Worker', class {
      onmessage?: (event: { data: unknown }) => void
      constructor() {
        workers++
        deliver = (data) => this.onmessage?.({ data })
      }
      postMessage(message: typeof messages[number]) { messages.push(message) }
      terminate = terminated
    })
    const createObjectURL = vi.fn(() => `blob:thumb-${messages.length}`)
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = createObjectURL
      static revokeObjectURL(url: string) { revoked.push(url) }
    })
    const { subscribeThumbnail, clearThumbnailCache, thumbnailCacheUsage } = await import('../src/renderer/src/gallery/thumbs')
    expect(workers).toBe(0)
    const item = { path: 'C:/screenshot.png', name: 'screenshot.png', mtimeMs: 0, ctimeMs: 0, size: 1 }
    const one = vi.fn()
    const two = vi.fn()
    const dispose1 = subscribeThumbnail(item, one)
    const dispose2 = subscribeThumbnail(item, two)
    expect(messages).toHaveLength(1)
    const blob = new Blob(['test-thumb'])
    deliver!({ id: messages[0].id, blob, width: 100, height: 50 })
    expect(one.mock.calls[0][0]).toBe(two.mock.calls[0][0])
    expect(thumbnailCacheUsage()).toBe(blob.size)
    expect(clearThumbnailCache()).toBe(0)
    dispose1()
    expect(revoked).toEqual([])

    const replace = vi.fn()
    const dispose3 = subscribeThumbnail({ ...item, ctimeMs: 5 }, replace)
    expect(messages.map((message) => Boolean(message.url))).toEqual([true, true])
    deliver!({ id: messages[1].id, blob, width: 50, height: 100 })
    expect(replace.mock.calls[0][0]).toMatchObject({ url: 'blob:thumb-2', aspect: 0.5 })
    dispose2()
    expect(clearThumbnailCache()).toBe(blob.size)
    expect(revoked).toEqual(['blob:thumb-1'])
    dispose3()
    expect(terminated).toHaveBeenCalledOnce()
    expect(clearThumbnailCache()).toBe(blob.size)
    expect(revoked).toEqual(['blob:thumb-1', 'blob:thumb-2'])
    expect(createObjectURL).toHaveBeenCalledTimes(2)
  })
})
