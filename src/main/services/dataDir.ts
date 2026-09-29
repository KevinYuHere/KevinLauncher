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

/** Recursively copies `from` into `to`, returning the number of files copied. */
export async function migrateData(from: string, to: string): Promise<number> {
  if (from.toLowerCase() === to.toLowerCase()) return 0
  let copied = 0
  const walk = async (dir: string, target: string): Promise<void> => {
    await fs.mkdir(target, { recursive: true })
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const source = join(dir, entry.name)
      const destination = join(target, entry.name)
      if (entry.isDirectory()) await walk(source, destination)
      else if (entry.isFile()) {
        await fs.copyFile(source, destination)
        copied++
      }
    }
  }
  await walk(from, to)
  return copied
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
 * choice and restarts the launcher.
 */
export async function switchDataDir(
  target: string,
  onProgress?: (step: string) => void
): Promise<void> {
  const from = currentDataDir()
  await fs.mkdir(target, { recursive: true })
  onProgress?.(`正在迁移数据到 ${target}…`)
  const copied = await migrateData(from, target)
  await writeDataDir(target)
  log(`dataDir: switched to ${target} (${copied} files copied)`)
  app.relaunch()
  app.exit(0)
}
