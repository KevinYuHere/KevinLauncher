import { promises as fs } from 'node:fs'
import { extname, join } from 'node:path'
import type { GalleryItem } from '@shared/types'

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'])
const MAX_DEPTH = 6
const STAT_BATCH = 32

function newestFirst(a: GalleryItem, b: GalleryItem): number {
  return b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path)
}

export async function collectGalleryImages(directory: string, limit = 3000): Promise<GalleryItem[]> {
  let latest: GalleryItem[] = []
  let batch: Promise<GalleryItem | null>[] = []
  const flush = async (): Promise<void> => {
    for (const result of await Promise.all(batch)) {
      if (result) latest.push(result)
    }
    batch = []
    if (latest.length >= limit * 2) latest = latest.sort(newestFirst).slice(0, limit)
  }

  const scan = async (dir: string, depth: number): Promise<void> => {
    try {
      for await (const entry of await fs.opendir(dir)) {
        const path = join(dir, entry.name)
        if (entry.isDirectory() && depth < MAX_DEPTH) {
          await scan(path, depth + 1)
        } else if (entry.isFile() && IMAGE_EXT.has(extname(entry.name).toLowerCase())) {
          batch.push(fs.stat(path).then(
            (stat) => stat.isFile() ? {
              path, name: entry.name, mtimeMs: stat.mtimeMs, size: stat.size, ctimeMs: stat.ctimeMs
            } : null,
            () => null
          ))
          if (batch.length >= STAT_BATCH) await flush()
        }
      }
    } catch (error) {
      if (depth === 0) throw error
    }
  }
  await scan(directory, 0)
  await flush()
  return latest.sort(newestFirst).slice(0, limit)
}
