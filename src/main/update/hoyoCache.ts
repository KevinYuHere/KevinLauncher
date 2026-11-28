import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const DAY = 24 * 60 * 60_000
export const MANIFEST_BUDGET = 512 * 1024 * 1024
export const METADATA_BUDGET = 32 * 1024 * 1024
const SWEEP_INTERVAL = 60_000
const sweeps = new Map<string, { last: number; inserted: number }>()

interface CacheRules {
  stems: RegExp
  age: number
  bytes: number
  preserved?: ReadonlySet<string>
}

export async function pruneHoYoCache(directory: string, rules: CacheRules, now = Date.now()): Promise<void> {
  let contents
  try { contents = await fs.opendir(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const files: { path: string; age: number; bytes: number }[] = []
  for await (const entry of contents) {
    if (!entry.isFile() || !rules.stems.test(entry.name) || rules.preserved?.has(entry.name)) continue
    const path = join(directory, entry.name)
    const found = await fs.lstat(path).catch(() => null)
    if (found?.isFile()) files.push({ path, age: now - found.mtimeMs, bytes: found.size })
  }
  files.sort((a, b) => a.age - b.age)
  let kept = 0
  for (const file of files) {
    if (file.age > rules.age || kept + file.bytes > rules.bytes) {
      await fs.unlink(file.path).catch(() => undefined)
    } else kept += file.bytes
  }
}

export async function maintainHoYoCache(root: string, kind: 'manifest' | 'metadata', inserted: number,
  permanent?: ReadonlySet<string>
): Promise<void> {
  const directory = join(root, kind === 'manifest' ? 'game' : 'metadata')
  const rules: CacheRules = kind === 'manifest'
    ? { stems: /^[\w-]+$/, age: 30 * DAY, bytes: MANIFEST_BUDGET }
    : { stems: /^[a-f0-9]{64}\.json$/, age: 90 * DAY, bytes: METADATA_BUDGET, preserved: permanent }
  const now = Date.now()
  const previous = sweeps.get(directory)
  if (previous) {
    previous.inserted += inserted
    if (now - previous.last < SWEEP_INTERVAL && previous.inserted < rules.bytes / 16) return
  }
  sweeps.set(directory, { last: now, inserted: 0 })
  await pruneHoYoCache(directory, rules, now).catch(() => undefined)
}

export async function touchHoYoCache(path: string): Promise<void> {
  const now = Date.now()
  const stat = await fs.stat(path).catch(() => null)
  if (stat && now - stat.mtimeMs >= DAY) await fs.utimes(path, stat.atime, new Date(now)).catch(() => undefined)
}
