import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { UsageReport } from '@shared/types'
import { directorySize } from './updateDownload'
import { currentAppVersion } from './appVersion'
import { log } from './logger'

/**
 * Disk housekeeping.
 *
 * Everything the launcher writes to the data directory is bounded:
 * - staged update downloads are removed once they are no longer the version that
 *   is running (a failed or paused download used to stay forever),
 * - the gallery thumbnail cache and the log files can be cleared on demand from
 *   the settings ("清理与占用").
 */

const stagingDir = (): string => join(app.getPath('userData'), 'update-staging')
const thumbsDir = (): string => join(app.getPath('userData'), 'thumbs')
const logFiles = (): string[] => [
  join(app.getPath('userData'), 'launcher.log'),
  join(app.getPath('userData'), 'launcher.log.1')
]

/** Deletes staged downloads that do not belong to the running version. */
export async function cleanUpdateStaging(): Promise<number> {
  const keep = currentAppVersion()
  let removed = 0
  try {
    for (const entry of await fs.readdir(stagingDir(), { withFileTypes: true })) {
      if (entry.name === keep) continue
      await fs
        .rm(join(stagingDir(), entry.name), { recursive: true, force: true })
        .catch(() => undefined)
      removed++
    }
  } catch {
    /* nothing staged */
  }
  if (removed > 0) log(`housekeeping: removed ${removed} stale staging folder(s)`)
  return removed
}

/** Removes the gallery thumbnail cache (regenerated on demand). */
export async function clearThumbs(): Promise<void> {
  await fs.rm(thumbsDir(), { recursive: true, force: true }).catch(() => undefined)
}

/** Removes the log files. */
export async function clearLogs(): Promise<void> {
  for (const file of logFiles()) await fs.rm(file, { force: true }).catch(() => undefined)
}

/** Current size of everything the launcher caches on disk. */
export async function usage(): Promise<UsageReport> {
  const [staging, thumbs] = await Promise.all([
    directorySize(stagingDir()),
    directorySize(thumbsDir())
  ])
  let logs = 0
  for (const file of logFiles()) {
    try {
      logs += (await fs.stat(file)).size
    } catch {
      /* missing */
    }
  }
  return { staging, thumbs, logs, total: staging + thumbs + logs }
}

/** Runs the requested cleanups and reports what is left. */
export async function clean(kinds: ('staging' | 'thumbs' | 'logs')[]): Promise<UsageReport> {
  if (kinds.includes('staging')) await cleanUpdateStaging()
  if (kinds.includes('thumbs')) await clearThumbs()
  if (kinds.includes('logs')) await clearLogs()
  return usage()
}
