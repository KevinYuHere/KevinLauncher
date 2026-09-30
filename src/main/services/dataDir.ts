import { app } from 'electron'
import { execFile, execFileSync } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import { log } from './logger'

/**
 * Where the launcher keeps its data (`config.json`, playtime, gacha, icons …).
 *
 * Electron derives `userData` from the app name, so a custom directory has to be
 * stored **outside** of it — in the same registry key as the install location.
 * `applyDataDir()` is called before the app is ready so every store picks it up.
 *
 * Changing the directory copies the existing data over and then restarts the
 * launcher; nothing is deleted before the copy succeeded.
 */

const APP_KEY = 'HKCU\\Software\\KevinLauncher'

/** Default data directory (`%APPDATA%\kevin-launcher`). */
export function defaultDataDir(): string {
  return join(app.getPath('appData'), 'kevin-launcher')
}

/** The directory currently in use. */
export function currentDataDir(): string {
  return app.getPath('userData')
}

/** Reads the configured directory from the registry (synchronous, pre-ready). */
export function storedDataDir(): string | null {
  try {
    const output = execFileSync('reg', ['query', APP_KEY, '/v', 'DataDir'], {
      windowsHide: true,
      encoding: 'utf8'
    })
    const value = /DataDir\s+REG_\w+\s+(.+)/i.exec(output)?.[1]?.trim()
    return value && /^[a-zA-Z]:\\/.test(value) ? value : null
  } catch {
    return null
  }
}

/** Points Electron at the configured directory. Call before the app is ready. */
export function applyDataDir(): void {
  const custom = storedDataDir()
  if (!custom) return
  if (custom.toLowerCase() === defaultDataDir().toLowerCase()) return
  try {
    app.setPath('userData', custom)
    log(`dataDir: using ${custom}`)
  } catch (error) {
    log(`dataDir: cannot use ${custom} (${(error as Error).message})`)
  }
}

/** Persists the configured directory (used by the installer and the settings). */
export function writeDataDir(dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'reg',
      ['add', APP_KEY, '/v', 'DataDir', '/t', 'REG_SZ', '/d', dir, '/f'],
      { windowsHide: true },
      (error) => (error ? reject(error) : resolve())
    )
  })
}

/**
 * Entries that are never migrated or backed up: caches the browser/Electron
 * regenerates (they are often locked by the running process — copying them made
 * the migration fail with EBUSY) and transient staging/log files.
 */
const TRANSIENT_ENTRIES = new Set([
  'cache',
  'code cache',
  'gpucache',
  'dawncache',
  'dawngraphitecache',
  'dawnwebgpucache',
  'shadercache',
  'grshadercache',
  'blob_storage',
  'local storage',
  'session storage',
  'indexeddb',
  'network',
  'shared dictionary',
  'service worker',
  'crashpad',
  'webstorage',
  'dictionaries',
  'logs',
  'update-staging',
  'predownload'
])

/** True for entries a migration/backup must skip. */
export function isTransientEntry(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    TRANSIENT_ENTRIES.has(lower) ||
    lower.endsWith('.log') ||
    lower.startsWith('simulate.') ||
    lower.startsWith('singleton')
  )
}

/**
 * Recursively copies `from` into `to`, skipping transient entries and reporting
 * files that could not be copied (a locked cache file must not abort the
 * migration, but it must also keep us from deleting the source).
 */
export async function migrateData(
  from: string,
  to: string,
  onSkip?: (name: string) => void
): Promise<{ copied: number; failed: number }> {
  if (from.toLowerCase() === to.toLowerCase()) return { copied: 0, failed: 0 }
  let copied = 0
  let failed = 0
  const walk = async (dir: string, target: string, top: boolean): Promise<void> => {
    await fs.mkdir(target, { recursive: true })
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (top && isTransientEntry(entry.name)) continue
      const source = join(dir, entry.name)
      const destination = join(target, entry.name)
      try {
        if (entry.isDirectory()) await walk(source, destination, false)
        else if (entry.isFile()) {
          await fs.copyFile(source, destination)
          copied++
        }
      } catch (error) {
        failed++
        onSkip?.(entry.name)
        log(`dataDir: could not copy ${entry.name} (${(error as Error).message})`)
      }
    }
  }
  await walk(from, to, true)
  return { copied, failed }
}

/** True when `dir` holds an existing launcher configuration. */
export async function hasData(dir: string): Promise<boolean> {
  try {
    await fs.access(join(dir, 'config.json'))
    return true
  } catch {
    return false
  }
}

/**
 * Switches the data directory: moves the current contents there, remembers the
 * choice and restarts the launcher. The old directory is only removed once the
 * copy completed without errors and the new one is verifiably usable.
 */
export async function switchDataDir(
  target: string,
  onProgress?: (step: string) => void
): Promise<void> {
  const from = currentDataDir()
  await fs.mkdir(target, { recursive: true })
  onProgress?.(`正在迁移数据到 ${target}…`)
  const { copied, failed } = await migrateData(from, target)
  await writeDataDir(target)
  log(`dataDir: switched to ${target} (${copied} copied, ${failed} failed)`)

  if (failed === 0 && copied > 0 && (await hasData(target))) {
    onProgress?.('正在清理旧目录…')
    await fs.rm(from, { recursive: true, force: true }).catch((error) => {
      log(`dataDir: could not remove the old directory (${(error as Error).message})`)
    })
  } else if (failed > 0) {
    log(`dataDir: keeping ${from} because ${failed} file(s) could not be copied`)
  }

  app.relaunch()
  app.exit(0)
}

/**
 * Appends `KevinLauncherData` to a directory that is not already named like
 * that, so the data never lands directly in a drive root.
 */
export function normalizeDataDir(dir: string): string {
  const trimmed = dir.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return join(app.getPath('appData'), 'KevinLauncherData')
  if (/^[a-zA-Z]:$/.test(trimmed)) return join(`${trimmed}\\`, 'KevinLauncherData')
  if (/(^|[\\/])KevinLauncherData$/i.test(trimmed)) return trimmed
  return join(trimmed, 'KevinLauncherData')
}
