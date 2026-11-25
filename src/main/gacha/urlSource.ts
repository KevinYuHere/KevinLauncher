import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { MIHOYO, type MiHoYoGame } from './metadata'
import { parseMiHoYoLink } from './mihoyoLink'

const BLOCK_BYTES = 128 * 1024
const MAX_LINK_BYTES = 16 * 1024
const MAX_CACHE_BYTES = 512 * 1024 * 1024
const HTTPS = Buffer.from('https://')
const DISK_CACHE_FILE = /^(?:data_[0-3]|f_[\da-f]{6,}|[\da-f]{16}_[0-2])$/i

interface Candidate {
  path: string
  modified: number
}

function urlByte(byte: number): boolean {
  return byte > 0x20 && byte < 0x7f &&
    byte !== 0x22 && byte !== 0x27 && byte !== 0x3c &&
    byte !== 0x3e && byte !== 0x5c && byte !== 0x60
}

async function newestLink(path: string, game: MiHoYoGame): Promise<string | null> {
  const file = await fs.open(path, 'r')
  try {
    const { size } = await file.stat()
    if (size === 0 || size > MAX_CACHE_BYTES) return null
    const buffer = Buffer.allocUnsafe(BLOCK_BYTES + MAX_LINK_BYTES)
    // A block owns its first bytes. Its right-hand overlap only completes
    // candidates starting inside the block, including links split at a boundary.
    for (let end = size; end > 0; end -= BLOCK_BYTES) {
      const start = Math.max(0, end - BLOCK_BYTES)
      const length = Math.min(size - start, end - start + MAX_LINK_BYTES)
      const { bytesRead } = await file.read(buffer, 0, length, start)
      if (bytesRead < HTTPS.length) continue
      const window = buffer.subarray(0, bytesRead)
      let index = window.lastIndexOf(HTTPS, end - start - 1)
      while (index >= 0) {
        const limit = Math.min(index + MAX_LINK_BYTES, window.length)
        let cursor = index + HTTPS.length
        while (cursor < limit && urlByte(window[cursor])) cursor++
        if (cursor < limit || start + cursor === size) {
          const candidate = window.toString('utf8', index, cursor)
          try {
            parseMiHoYoLink(game, candidate)
            return candidate
          } catch {
            // Ordinary Chromium entries may contain other pages or old tokens.
          }
        }
        index = index > 0 ? window.lastIndexOf(HTTPS, index - 1) : -1
      }
    }
    return null
  } finally {
    await file.close()
  }
}

async function cacheFiles(gameDir: string, game: MiHoYoGame): Promise<Candidate[]> {
  const candidates: Candidate[] = []
  for (const relativeDir of MIHOYO[game].webCacheDirs) {
    const base = join(gameDir, relativeDir)
    const children = await fs.readdir(base, { withFileTypes: true }).catch(() => [])
    const roots = [base, ...children
      .filter(entry => entry.isDirectory() && entry.name.toLowerCase() !== 'cache')
      .map(entry => join(base, entry.name))]
    for (const root of roots) {
      for (const folder of [join(root, 'Cache'), join(root, 'Cache', 'Cache_Data')]) {
        const files = await fs.readdir(folder, { withFileTypes: true }).catch(() => [])
        for (const entry of files) {
          if (!entry.isFile() || !DISK_CACHE_FILE.test(entry.name)) continue
          const path = join(folder, entry.name)
          const stat = await fs.stat(path).catch(() => null)
          if (stat && stat.size > 0 && stat.size <= MAX_CACHE_BYTES) {
            candidates.push({ path, modified: stat.mtimeMs })
          }
        }
      }
    }
  }
  return candidates.sort((left, right) => right.modified - left.modified)
}

/** Look for the newest recognised link in the selected game's WebView cache. */
export async function scanWebCache(gameDir: string, game: MiHoYoGame): Promise<string | null> {
  for (const { path } of await cacheFiles(gameDir, game)) {
    const candidate = await newestLink(path, game).catch(() => null)
    if (candidate) return candidate
  }
  return null
}
