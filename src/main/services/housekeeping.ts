import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { DiskCacheKind, DiskCleanupReport, DiskUsageReport } from '@shared/types'
import { keepStagedVersion } from '@shared/version'
import { GAME_FILE_CATALOG_NAME } from '@shared/paths'
import { currentAppVersion } from './appVersion'
import { clearLauncherLogs, launcherLogBytes, log } from './logger'

/**
 * Disk housekeeping.
 *
 * Everything the launcher writes to the data directory is bounded:
 * - staged update downloads are removed once they are no longer needed: the
 *   folder of the running version, and the folder of a **newer** version (a
 *   download that is still pending — that is what makes a critical update resume
 *   after the user closed the launcher), are kept,
 * - legacy thumbnail files and launcher logs can be cleared from settings.
 */

const stagingDir = (): string => join(app.getPath('userData'), 'update-staging')
const thumbsDir = (): string => join(app.getPath('userData'), 'thumbs')

function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function entriesAt(dir: string) {
  try {
    const stat = await fs.lstat(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('缓存目录不是普通目录')
    return await fs.readdir(dir, { withFileTypes: true })
  }
  catch (error) {
    if (absent(error)) return []
    throw error
  }
}

async function pathBytes(path: string): Promise<number> {
  try {
    const stat = await fs.lstat(path)
    if (stat.isFile()) return stat.size
    if (!stat.isDirectory()) return 0
    let bytes = 0
    for (const item of await entriesAt(path)) bytes += await pathBytes(join(path, item.name))
    return bytes
  } catch (error) {
    if (absent(error)) return 0
    throw error
  }
}

async function remove(path: string, report: DiskCleanupReport): Promise<boolean> {
  let before: number | undefined
  try {
    before = await pathBytes(path)
    await fs.rm(path, { force: false, recursive: true })
    report.diskBytes += before
    return true
  } catch (error) {
    if (!absent(error)) {
      const failure = error as NodeJS.ErrnoException
      report.failures.push(`${path}：${failure.code ?? failure.message}`)
      const remaining = await pathBytes(path).catch(() => undefined)
      if (before !== undefined && remaining !== undefined) report.diskBytes += Math.max(0, before - remaining)
    }
    return false
  }
}

async function removeStaleStaging(report: DiskCleanupReport): Promise<number> {
  const path = stagingDir()
  const current = currentAppVersion()
  let removed = 0
  try {
    for (const entry of await entriesAt(path)) {
      if (keepStagedVersion(entry.name, current)) continue
      if (await remove(join(path, entry.name), report)) removed++
    }
  } catch (error) {
    report.failures.push(`${path}：${(error as Error).message}`)
  }
  return removed
}

/**
 * Deletes staged downloads that can no longer be resumed: anything that is
 * neither the running version nor a newer (therefore still pending) one.
 */
export async function cleanUpdateStaging(): Promise<number> {
  const report: DiskCleanupReport = { diskBytes: 0, failures: [] }
  const removed = await removeStaleStaging(report)
  if (removed > 0) log(`housekeeping: removed ${removed} stale staging folder(s)`)
  for (const failure of report.failures) log(`housekeeping: ${failure}`)
  return removed
}

async function stagingUsage(): Promise<{ staleStaging: number | null; retainedStaging: number | null }> {
  try {
    const path = stagingDir()
    const current = currentAppVersion()
    let staleStaging = 0
    let retainedStaging = 0
    for (const item of await entriesAt(path)) {
      const bytes = await pathBytes(join(path, item.name))
      if (keepStagedVersion(item.name, current)) retainedStaging += bytes
      else staleStaging += bytes
    }
    return { staleStaging, retainedStaging }
  } catch {
    return { staleStaging: null, retainedStaging: null }
  }
}

/** Logical file sizes. Null is reserved for an unreadable group. */
export async function usage(): Promise<DiskUsageReport> {
  const root = app.getPath('userData')
  const groupBytes = (paths: string[]): Promise<number | null> =>
    Promise.all(paths.map((path) => pathBytes(join(root, path))))
      .then((bytes) => bytes.reduce((sum, value) => sum + value, 0), () => null)
  const [staging, legacyThumbs, logs, gameCache, media, recovery] = await Promise.all([
    stagingUsage(),
    pathBytes(thumbsDir()).catch(() => null),
    launcherLogBytes().catch(() => null),
    groupBytes(['hoyo-cache', GAME_FILE_CATALOG_NAME, GAME_FILE_CATALOG_NAME + '-wal', GAME_FILE_CATALOG_NAME + '-shm']),
    groupBytes(['bg', 'icons', 'brand']),
    groupBytes(['update-backup', 'update-backup.new', 'update-backup.old', 'config.json.corrupt'])
  ])
  return { ...staging, legacyThumbs, logs, gameCache, media, recovery }
}

export async function clean(kinds: DiskCacheKind[]): Promise<DiskCleanupReport> {
  const report: DiskCleanupReport = { diskBytes: 0, failures: [] }
  if (kinds.includes('staging')) await removeStaleStaging(report)
  if (kinds.includes('thumbs')) await remove(thumbsDir(), report)
  if (kinds.includes('logs')) {
    const result = await clearLauncherLogs()
    report.diskBytes += result.bytes
    report.failures.push(...result.failures)
  }
  return report
}
