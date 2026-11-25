import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { BACKUP_DIR_NAME, isTransientEntry, migrateData, PREVIOUS_BACKUP_DIR_NAME } from './dataDir'
import { hasPersistedSettings, verifySnapshot } from './settingsBackup'
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

/** Additional space for the new snapshot while the existing slot stays valid. */
export async function estimateBackupBytes(directory: string, top = true): Promise<number> {
  let total = 0
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (top && error.code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries) {
    if (top && isTransientEntry(entry.name) || entry.isFile() && entry.name.endsWith('.tmp')) continue
    const file = join(directory, entry.name)
    if (entry.isDirectory()) total += await estimateBackupBytes(file, false)
    else if (entry.isFile()) total += (await fs.lstat(file)).size
  }
  return total
}

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
    await fs.lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export type BackupResult =
  | { status: 'complete'; copied: number; failed: 0 }
  | { status: 'not-needed'; copied: 0; failed: 0 }
  | { status: 'failed'; copied: number; failed: number; message: string }

export function requireBackup(result: BackupResult): void {
  if (result.status === 'failed') throw new Error(`无法备份用户数据：${result.message}`)
}

/**
 * Snapshot the user data into `<userData>/update-backup`, replacing the previous
 * snapshot. Best-effort: it never throws, and it keeps the old snapshot when the
 * new copy did not capture at least a `config.json`.
 */
export function backupUserData(reason: string): Promise<BackupResult> {
  const from = app.getPath('userData')
  const next = backupQueue.then(() => backupDataDirectory(from, reason))
  backupQueue = next.then(() => undefined, () => undefined)
  return next
}

export async function backupDataDirectory(
  from: string,
  reason: string
): Promise<BackupResult> {
  const slot = join(from, BACKUP_DIR_NAME)
  const previous = join(from, PREVIOUS_BACKUP_DIR_NAME)
  let tmp: string | undefined
  let copied = 0
  try {
    if (!(await hasPersistedSettings(from))) return { status: 'not-needed', copied: 0, failed: 0 }
    await cleanAbandonedCandidates(from)
    // A process might have exited between the two renames. Recover the old
    // slot before taking another snapshot.
    if (await exists(previous)) {
      if (await exists(slot)) {
        await verifySnapshot(slot)
        await fs.rm(previous, { recursive: true, force: true })
      }
      else {
        await verifySnapshot(previous)
        await fs.rename(previous, slot)
      }
    }
    tmp = await fs.mkdtemp(join(from, `${CANDIDATE_PREFIX}${process.pid}-`))
    const result = await migrateData(from, tmp)
    copied = result.copied
    if (result.failed) {
      const message = result.firstFailure ?? '部分文件无法复制'
      log(`backup: kept the previous snapshot for "${reason}" (${message})`)
      return { status: 'failed', copied, failed: result.failed, message }
    }
    await verifySnapshot(tmp)
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
    log(`backup: "${reason}" -> ${slot} (${copied} item(s))`)
    return { status: 'complete', copied, failed: 0 }
  } catch (error) {
    const message = (error as Error).message
    log(`backup: "${reason}" failed (${message})`)
    return { status: 'failed', copied, failed: 1, message }
  } finally {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
}
