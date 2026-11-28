import { promises as fs } from 'node:fs'
import { relative } from 'node:path'
import { openJsonStore } from '../services/jsonStore'
import { writeFileAtomic } from '../services/atomicFile'
import { allowGameFileWrite } from '../services/writableGameFile'
import { gamePath, requirePlainGamePath } from './hoyoFiles'

interface CacheEntry {
  file: string
  identity: string
  targets: string[]
}

async function identity(path: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(path, { bigint: true })
    if (stat.isFile() && stat.ino !== 0n) {
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.birthtimeNs].join(':')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return undefined
}

/** Ownership is acquired only by publishing a cache file; observed reuse can add a reference. */
export async function openSophonCacheOwnership(dir: string, target: string) {
  const file = gamePath(dir, '.kevin-launcher-update/sophon-cache.json')
  await requirePlainGamePath(dir, file)
  const state = await openJsonStore<unknown>(file, () => [], 'sophonCache')
  const writable = state.writable && Array.isArray(state.data)
  const entries = new Map<string, CacheEntry>()
  if (Array.isArray(state.data)) for (const entry of state.data as CacheEntry[]) {
    if (typeof entry?.file !== 'string' || !/^(?:chunk|ldiff)\/[\w./-]+$/.test(entry.file) ||
        entry.file.split('/').some(part => part === '..' || part === '.') ||
        typeof entry.identity !== 'string' || !Array.isArray(entry.targets) ||
        !entry.targets.every(item => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item))) continue
    entries.set(entry.file, entry)
  }

  let changed = false
  return {
    async record(path: string, published: boolean): Promise<void> {
      if (!writable) return
      const name = relative(dir, path).replaceAll('\\', '/')
      const existing = entries.get(name)
      if (!published && !existing) return
      await requirePlainGamePath(dir, path)
      const current = await identity(path)
      if (!current || (!published && current !== existing?.identity)) return
      const targets = current === existing?.identity ? existing.targets : []
      if (!targets.includes(target)) {
        entries.set(name, { file: name, identity: current, targets: [...targets, target] })
        changed = true
      }
    },
    async release(): Promise<void> {
      if (!writable) return
      for (const entry of entries.values()) {
        if (!entry.targets.includes(target)) continue
        const targets = entry.targets.filter(item => item !== target)
        if (targets.length) entries.set(entry.file, { ...entry, targets })
        else {
          try {
            const path = gamePath(dir, entry.file)
            await requirePlainGamePath(dir, path)
            if (await identity(path) === entry.identity) {
              await allowGameFileWrite(path)
              await fs.unlink(path)
            }
          } catch { continue }
          entries.delete(entry.file)
        }
        changed = true
      }
    },
    async save(): Promise<void> {
      if (changed) {
        await requirePlainGamePath(dir, file)
        await writeFileAtomic(file, JSON.stringify([...entries.values()]))
      }
    }
  }
}

export type RecordSophonCache = (path: string, published: boolean) => Promise<void>
