import { app } from 'electron'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import type { UsageReport } from '@shared/types'
import { keepStagedVersion } from '@shared/version'
import { defaultLaunchMethod } from '@shared/appEntry'
import { AppStore } from './appStore'
import { directorySize } from './updateDownload'
import { currentAppVersion } from './appVersion'
import { log } from './logger'

/**
 * Disk housekeeping.
 *
 * Everything the launcher writes to the data directory is bounded:
 * - staged update downloads are removed once they are no longer needed: the
 *   folder of the running version, and the folder of a **newer** version (a
 *   download that is still pending — that is what makes a critical update resume
 *   after the user closed the launcher), are kept,
 * - the gallery thumbnail cache and the log files can be cleared on demand from
 *   the settings ("清理与占用").
 */

const stagingDir = (): string => join(app.getPath('userData'), 'update-staging')
const thumbsDir = (): string => join(app.getPath('userData'), 'thumbs')
const logFiles = (): string[] => [
  join(app.getPath('userData'), 'launcher.log'),
  join(app.getPath('userData'), 'launcher.log.1')
]

/**
 * Deletes staged downloads that can no longer be resumed: anything that is
 * neither the running version nor a newer (therefore still pending) one.
 */
export async function cleanUpdateStaging(): Promise<number> {
  const current = currentAppVersion()
  let removed = 0
  try {
    for (const entry of await fs.readdir(stagingDir(), { withFileTypes: true })) {
      // A newer version may be a download in flight (or one interrupted by
      // closing the launcher): keep its `.part` files so it resumes.
      if (keepStagedVersion(entry.name, current)) continue
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

/**
 * Arknights derived staging (`_kl_delta` / `_kl_stage`) is rebuilt on every
 * apply, so leftovers from a killed update are safe to delete at startup.
 * `_kl_pre` is deliberately kept: it is a real staged pre-download.
 */
export async function cleanArknightsStaging(): Promise<void> {
  const store = await AppStore.load()
  for (const entry of store.apps) {
    if (entry.addonId !== 'arknights') continue
    const dir =
      entry.gameDirectory?.trim() || dirname(defaultLaunchMethod(entry)?.targetPath ?? '')
    if (!dir) continue
    for (const name of ['_kl_delta', '_kl_stage']) {
      await fs.rm(join(dir, name), { recursive: true, force: true }).catch(() => undefined)
    }
  }
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
