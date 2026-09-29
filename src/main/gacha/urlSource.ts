import { join } from 'path'
import { promises as fs } from 'fs'
import { MIHOYO } from './metadata'

type MiHoYoGame = 'genshin' | 'starrail' | 'zzz'

const MAX_BYTES = 512 * 1024 * 1024

/**
 * Read the cached gacha page URL out of a Chromium cache `data_2` file.
 *
 * Ported from Starward (Scighost/Starward, MIT): find the LAST occurrence of a
 * known `webstatic` URL prefix and read until a NUL byte or `"`.
 */
async function findUrlInDataFile(path: string, prefixes: string[]): Promise<string | null> {
  let buffer: Buffer
  try {
    const stat = await fs.stat(path)
    if (stat.size === 0 || stat.size > MAX_BYTES) return null
    buffer = await fs.readFile(path)
  } catch {
    return null
  }
  for (const prefix of prefixes) {
    const index = buffer.lastIndexOf(Buffer.from(prefix, 'utf8'))
    if (index < 0) continue
    let end = index
    while (end < buffer.length && buffer[end] !== 0x00 && buffer[end] !== 0x22) end++
    const url = buffer.subarray(index, end).toString('utf8')
    if (url.includes('authkey=')) return url
  }
  return null
}

/**
 * Locate the captured gacha page URL in the game's browser cache. Mirrors
 * Starward: prefer the most recently modified `<webCaches>\<ver>\Cache\
 * Cache_Data\data_2`, then the un-versioned one.
 */
export async function scanWebCache(gameDir: string, game: MiHoYoGame): Promise<string | null> {
  const meta = MIHOYO[game]
  const candidates: { path: string; mtime: number }[] = []

  const add = async (file: string): Promise<void> => {
    try {
      const stat = await fs.stat(file)
      candidates.push({ path: file, mtime: stat.mtimeMs })
    } catch {
      /* not present */
    }
  }

  for (const dir of meta.webCacheDirs) {
    const webCaches = join(gameDir, dir)
    await add(join(webCaches, 'Cache', 'Cache_Data', 'data_2'))
    try {
      for (const entry of await fs.readdir(webCaches, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        await add(join(webCaches, entry.name, 'Cache', 'Cache_Data', 'data_2'))
      }
    } catch {
      /* no such webCaches folder */
    }
  }

  candidates.sort((a, b) => b.mtime - a.mtime)
  for (const candidate of candidates) {
    const url = await findUrlInDataFile(candidate.path, meta.urlPrefixes)
    if (url) return url
  }
  return null
}
