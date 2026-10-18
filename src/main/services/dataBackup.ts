import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { migrateData } from './dataDir'
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

export const BACKUP_DIR_NAME = 'update-backup'

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/** True for the current slot's `config.json` (used to decide if it is usable). */
function configFileOf(dir: string): string {
  return join(dir, 'config.json')
}

/**
 * Snapshot the user data into `<userData>/update-backup`, replacing the previous
 * snapshot. Best-effort: it never throws, and it keeps the old snapshot when the
 * new copy did not capture at least a `config.json`.
 */
export async function backupUserData(reason: string): Promise<{ copied: number; failed: number }> {
  const from = app.getPath('userData')
  const slot = join(from, BACKUP_DIR_NAME)
  const tmp = join(from, `${BACKUP_DIR_NAME}.new`)
  try {
    if (!(await exists(from))) return { copied: 0, failed: 0 }
    await fs.rm(tmp, { recursive: true, force: true })
    const { copied, failed } = await migrateData(from, tmp)
    // Never replace a good snapshot with an empty/partial one.
    if (!(await exists(configFileOf(tmp)))) {
      log(`backup: skipped "${reason}" (no config.json captured; ${copied} item(s))`)
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
      return { copied, failed }
    }
    await fs.rm(slot, { recursive: true, force: true }).catch(() => undefined)
    await fs.rename(tmp, slot)
    log(`backup: "${reason}" -> ${slot} (${copied} item(s), ${failed} failed)`)
    return { copied, failed }
  } catch (error) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    log(`backup: "${reason}" failed (${(error as Error).message})`)
    return { copied: 0, failed: 0 }
  }
}
