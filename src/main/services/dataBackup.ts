import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { BACKUP_DIR_NAME, hasData, migrateData, PREVIOUS_BACKUP_DIR_NAME } from './dataDir'
import { log } from './logger'

/**
 * Pre-update user-data backup.
 *
 * Every version update (in-app hot update **and** the self-drawn installer) takes
 * a snapshot of the user data before it changes anything, so a bad update (or a
 * migration bug) can always be rolled back by hand. The slot is **single and
 * rotating** — each update overwrites the previous one, so the disk footprint
 * never grows. Caches / staging (`isTransientEntry`) are skipped, and so is the
 * slot itself.
 */

let backupQueue = Promise.resolve()
const CANDIDATE_PREFIX = `${BACKUP_DIR_NAME}.new-`

async function cleanAbandonedCandidates(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(CANDIDATE_PREFIX)) continue
    const match = /^(\d+)-[a-z0-9]+$/i.exec(entry.name.slice(CANDIDATE_PREFIX.length))
    if (!match) continue
    const pid = Number(match[1])
    if (pid < 1 || pid > 0x7fffffff) continue
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        await fs.rm(join(directory, entry.name), { recursive: true, force: true }).catch((cleanup) => {
          log(`backup: could not clean abandoned candidate (${String(cleanup)})`)
        })
      }
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Snapshot the user data into `<userData>/update-backup`, replacing the previous
 * snapshot. Best-effort: it never throws, and it keeps the old snapshot when the
 * new copy did not capture at least a `config.json`.
 */
export function backupUserData(reason: string): Promise<{ copied: number; failed: number }> {
  const from = app.getPath('userData')
  const next = backupQueue.then(() => backupDataDirectory(from, reason))
  backupQueue = next.then(() => undefined, () => undefined)
  return next
}

export async function backupDataDirectory(
  from: string,
  reason: string
): Promise<{ copied: number; failed: number }> {
  const slot = join(from, BACKUP_DIR_NAME)
  const previous = join(from, PREVIOUS_BACKUP_DIR_NAME)
  let tmp: string | undefined
  try {
    if (!(await exists(from))) return { copied: 0, failed: 0 }
    await cleanAbandonedCandidates(from)
    // A process might have exited between the two renames. Recover the old
    // slot before taking another snapshot.
    if (await exists(previous)) {
      if (await hasData(slot)) await fs.rm(previous, { recursive: true, force: true })
      else {
        if (await exists(slot)) throw new Error('present backup slot cannot be validated')
        await fs.rename(previous, slot)
      }
    }
    tmp = await fs.mkdtemp(join(from, `${CANDIDATE_PREFIX}${process.pid}-`))
    const { copied, failed } = await migrateData(from, tmp)
    if (failed > 0 || !(await hasData(tmp))) {
      log(`backup: kept the previous snapshot for "${reason}" (${copied} copied, ${failed} failed or no readable config)`)
      return { copied, failed }
    }
    const hadPrevious = await exists(slot)
    if (hadPrevious) await fs.rename(slot, previous)
    try {
      await fs.rename(tmp, slot)
    } catch (error) {
      if (hadPrevious) {
        await fs.rename(previous, slot).catch((rollback) => {
          log(`backup: previous snapshot retained in ${previous} (${String(rollback)})`)
        })
      }
      throw error
    }
    if (hadPrevious) await fs.rm(previous, { recursive: true, force: true }).catch((error) => {
      log(`backup: could not remove the previous snapshot (${String(error)})`)
    })
    log(`backup: "${reason}" -> ${slot} (${copied} item(s), ${failed} failed)`)
    return { copied, failed }
  } catch (error) {
    log(`backup: "${reason}" failed (${(error as Error).message})`)
    return { copied: 0, failed: 1 }
  } finally {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
}
