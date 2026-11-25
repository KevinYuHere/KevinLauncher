import { app } from 'electron'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { directoriesOverlap, GAME_FILE_CATALOG_NAME } from '@shared/paths'
import { loadJsonSafe, writeFileAtomic } from './atomicFile'
import { createSiblingWorkspace, isFileSystemRoot } from './directoryPath'
import { log } from './logger'
import { runPowerShellSync } from './powershell'

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
export const BACKUP_DIR_NAME = 'update-backup'
export const PREVIOUS_BACKUP_DIR_NAME = `${BACKUP_DIR_NAME}.previous`
// The index is a regenerable cache, but can be kept when moving a quiescent
// data directory. An update backup must not copy the database and WAL apart.
const GAME_FILE_INDEX = new Set([GAME_FILE_CATALOG_NAME, `${GAME_FILE_CATALOG_NAME}-wal`])

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
    const value = runPowerShellSync(
      `$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\KevinLauncher'); if ($key) { $key.GetValue('DataDir') }`
    ).trim()
    return isAbsolute(value) ? value : null
  } catch {
    return null
  }
}

/** Points Electron at the configured directory. Call before the app is ready. */
export function applyDataDir(): void {
  // Sandbox override (used for local trials): takes priority over the registry
  // so a test build can run against a throwaway copy of the user's data without
  // touching the real data directory or the stored setting.
  const sandbox = process.env.KEVIN_LAUNCHER_DATA_DIR
  if (sandbox && sandbox.trim()) {
    try {
      app.setPath('userData', sandbox.trim())
      log(`dataDir: sandbox ${sandbox.trim()}`)
      return
    } catch (error) {
      log(`dataDir: cannot use sandbox ${sandbox} (${(error as Error).message})`)
    }
  }
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
  'thumbs',
  'hoyo-cache',
  'predownload'
])

/** True for entries a migration/backup must skip. */
export function isTransientEntry(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    TRANSIENT_ENTRIES.has(lower) ||
    lower.endsWith('.log') ||
    lower.startsWith('simulate.') ||
    lower.startsWith('singleton') ||
    lower.startsWith('import-staging') ||
    lower.startsWith('update-pkg-') ||
    GAME_FILE_INDEX.has(lower) ||
    lower === `${GAME_FILE_CATALOG_NAME}-shm` ||
    // The pre-update backup slot (and its in-progress `.new`) are never part of
    // the data being migrated / backed up.
    lower.startsWith(BACKUP_DIR_NAME)
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
  options: { includeSnapshots?: boolean; merge?: boolean } = {}
): Promise<{ copied: number; failed: number; firstFailure?: string }> {
  if (from.toLowerCase() === to.toLowerCase()) return { copied: 0, failed: 0 }
  let copied = 0
  let failed = 0
  let firstFailure: string | undefined
  const walk = async (dir: string, target: string, top: boolean): Promise<void> => {
    await fs.mkdir(target, { recursive: true })
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (top && isTransientEntry(entry.name) &&
        !(options.includeSnapshots && (
          [BACKUP_DIR_NAME, PREVIOUS_BACKUP_DIR_NAME].includes(entry.name) ||
          GAME_FILE_INDEX.has(entry.name.toLowerCase())
        ))) continue
      if (entry.isFile() && entry.name.endsWith('.tmp')) continue
      const source = join(dir, entry.name)
      const destination = join(target, entry.name)
      try {
        if (options.merge) {
          const existing = await fs.lstat(destination).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
            return null
          })
          if (existing && (
            (!entry.isDirectory() || !existing.isDirectory()) &&
            (!entry.isFile() || !existing.isFile())
          )) {
            throw new Error(`目标已存在不同类型的同名项目：${relative(to, destination)}`)
          }
        }
        if (entry.isDirectory()) await walk(source, destination, false)
        else if (entry.isFile()) {
          await fs.copyFile(source, destination)
          copied++
        } else throw new Error('unsupported file type')
      } catch (error) {
        failed++
        firstFailure ??= (error as Error).message
        log(`dataDir: could not copy ${entry.name} (${(error as Error).message})`)
      }
    }
  }
  await walk(from, to, true)
  return { copied, failed, firstFailure }
}

/** A reachable config must also be readable and structurally usable. */
export async function hasData(dir: string): Promise<boolean> {
  const result = await loadJsonSafe<{ apps?: unknown } | null>(join(dir, 'config.json'))
  return result.status === 'ok' && Array.isArray(result.value?.apps)
}

/** Resolve existing ancestors too, so junctions cannot disguise overlapping paths. */
export async function realDirectoryPath(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('请选择绝对路径')
  const canonical = resolve(path)
  try {
    return await fs.realpath(canonical)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (isFileSystemRoot(canonical)) throw error
    const parent = dirname(canonical)
    return join(await realDirectoryPath(parent), basename(canonical))
  }
}

function assertMovableDataPath(path: string): void {
  if (isFileSystemRoot(path)) throw new Error('不能将磁盘或共享目录的根目录用作数据目录')
}

async function movableDataPath(path: string): Promise<string> {
  assertMovableDataPath(path)
  const canonical = await realDirectoryPath(path)
  assertMovableDataPath(canonical)
  return canonical
}

type CommitDataDirectory = (directory: string) => Promise<void>

/** Merge in a sibling workspace; the source stays authoritative until commit. */
export async function migrateDataDirectory(
  from: string,
  to: string,
  commit: CommitDataDirectory,
  preparation: {
    beforeCopy?: () => Promise<void>
    beforePublish?: (stage: string) => Promise<void>
  } = {}
): Promise<number> {
  const source = await movableDataPath(from)
  const target = await movableDataPath(to)
  if (directoriesOverlap(source, target)) throw new Error('新旧数据目录不能相同或互相包含')
  const canCleanSource = resolve(from).toLowerCase() === source.toLowerCase()
  const targetExists = await fs.stat(target).then((stat) => {
    if (!stat.isDirectory()) throw new Error('目标路径不是目录')
    return true
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return false
  })
  await preparation.beforeCopy?.()
  const work = await createSiblingWorkspace(target, '.kevin-data-move-')
  const stage = join(work, 'next')
  const previous = join(work, 'previous')
  let originalSaved = false
  let stagedPublished = false
  let preserveWork = false
  try {
    if (!(await hasData(source))) {
      throw new Error('源配置读取失败，已保留原数据目录')
    }
    if (targetExists) {
      await fs.cp(target, stage, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
    }
    const { copied, failed, firstFailure } = await migrateData(source, stage, {
      includeSnapshots: true, merge: targetExists
    })
    if (failed) {
      throw new Error(`复制失败，已保留原数据目录（${firstFailure}）`)
    }
    if (!copied || !(await hasData(stage))) {
      throw new Error('数据复制不完整或配置读取失败，已保留原数据目录')
    }
    await preparation.beforePublish?.(stage)
    if (targetExists) {
      await fs.rename(target, previous)
      originalSaved = true
    }
    await fs.rename(stage, target)
    stagedPublished = true
    await commit(target)
    if (canCleanSource) {
      await fs.rm(source, { recursive: true, force: true }).catch((error) => {
        log(`dataDir: could not remove the old directory (${String(error)})`)
      })
    } else {
      log('dataDir: retained the original data behind a reparse point')
    }
    return copied
  } catch (error) {
    try {
      if (stagedPublished) await fs.rename(target, stage)
      if (originalSaved) await fs.rename(previous, target)
    } catch (rollback) {
      preserveWork = true
      log(`dataDir: could not roll back ${target} (${String(rollback)})`)
      const retained = originalSaved ? previous : target
      throw new Error(`无法立即恢复目标目录，已保留文件于 ${retained}。迁移失败原因：${String(error)}`)
    }
    throw error
  } finally {
    if (!preserveWork) await fs.rm(work, { recursive: true, force: true }).catch((error) => {
      log(`dataDir: could not remove the migration workspace (${String(error)})`)
    })
  }
}

/** Seed a fresh installer-selected directory; retain an existing, usable config. */
export async function seedDataDir(
  target: string,
  fallback: string,
  commit: CommitDataDirectory = async () => {}
): Promise<{ copied: number; failed: number; keptExisting: boolean }> {
  const destination = await movableDataPath(target)
  const source = await realDirectoryPath(fallback)
  if (source.toLowerCase() === destination.toLowerCase()) {
    await commit(destination)
    return { copied: 0, failed: 0, keptExisting: false }
  }
  if (directoriesOverlap(source, destination)) throw new Error('新旧数据目录不能互相包含')
  if (await hasData(destination)) {
    await commit(destination)
    return { copied: 0, failed: 0, keptExisting: true }
  }
  const config = await fs.lstat(join(source, 'config.json')).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (!config) {
    const files = await fs.readdir(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return []
    })
    if (files.some((name) => !isTransientEntry(name))) {
      throw new Error('当前目录有数据但缺少配置，已保留原目录')
    }
    await fs.mkdir(destination, { recursive: true })
    const incoming = await fs.lstat(join(destination, 'config.json')).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (incoming) throw new Error('目标配置无法读取，已保留原目录')
    await commit(destination)
    return { copied: 0, failed: 0, keptExisting: false }
  }
  const copied = await migrateDataDirectory(fallback, destination, commit)
  return { copied, failed: 0, keptExisting: false }
}

/**
 * Switches the data directory: moves the current contents there, remembers the
 * choice and restarts the launcher. The old directory is only removed once the
 * copy completed without errors and the new one is verifiably usable.
 */
export async function switchDataDir(
  target: string,
  checkpoint: () => Promise<void>,
  onProgress?: (step: string) => void
): Promise<void> {
  const from = currentDataDir()
  if (resolve(from).toLowerCase() === resolve(target).toLowerCase()) return
  onProgress?.(`正在迁移数据到 ${target}…`)
  await migrateDataDirectory(from, target, async (destination) => {
    await writeDataDir(destination)
    log(`dataDir: switched to ${destination}`)
    onProgress?.('正在清理旧目录…')
  }, {
    beforeCopy: checkpoint,
    beforePublish: async (stage) => {
      // A large wallpaper copy can take time. Capture the last segment before
      // publishing and carry the final playtime store into the staged directory.
      await checkpoint()
      const name = 'playtime.json'
      const source = join(from, name)
      const target = join(stage, name)
      const saved = await fs.readFile(source).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      if (saved) {
        const previous = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
          return null
        })
        if (previous && !previous.isFile()) throw new Error(`目标存在同名的目录或链接：${name}`)
        await writeFileAtomic(target, saved)
      }
    }
  })
  app.relaunch()
  app.exit(0)
}

/**
 * Appends `KevinLauncherData` to a directory that is not already named like
 * that, so the data never lands directly in a drive root.
 */
export function normalizeDataDir(dir: string): string {
  const selected = dir.trim()
  const trimmed = selected.replace(/[\\/]+$/, '')
  if (!trimmed) return join(app.getPath('appData'), 'KevinLauncherData')
  if (isFileSystemRoot(selected)) return join(selected, 'KevinLauncherData')
  if (/^[a-zA-Z]:$/.test(trimmed)) return join(`${trimmed}\\`, 'KevinLauncherData')
  if (/(^|[\\/])KevinLauncherData$/i.test(trimmed)) return trimmed
  return join(trimmed, 'KevinLauncherData')
}
