import { promises as fs, type Stats } from 'fs'
import { dirname, join, relative, sep } from 'path'
import { CURRENT_VERSION } from './appMigrations'
import { loadJsonSafe, writeFileAtomic } from './atomicFile'
import { migrateData } from './dataDir'
import { log } from './logger'

const WORK_DIR = 'import-staging'
const JOURNAL = 'journal.json'
const ROOT_FILES = new Set(['config.json', 'playtime.json', 'auth.json'])
const MEDIA_DIRS = new Set(['icons', 'bg', 'brand'])

interface ImportEntry {
  name: string
  existed: boolean
}

interface Journal {
  entries: ImportEntry[]
  complete: boolean
}

export class SettingsImportRecoveryError extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function isImportFile(name: string): boolean {
  const [directory, file, ...children] = name.split(sep)
  if (!file) return ROOT_FILES.has(name.toLowerCase())
  if (children.length || /[\\/:*?"<>|\x00-\x1f]|[ .]$/.test(file) ||
      /^(?:CON|NUL|PRN|AUX|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(file)) return false
  if (MEDIA_DIRS.has(directory.toLowerCase())) return true
  return directory.toLowerCase() === 'gacha' && /^[a-z0-9_-]+\.json$/i.test(file)
}

async function lstat(path: string): Promise<Stats | null> {
  return fs.lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
}

/** Verify that an archive cannot replace or follow a directory junction. */
async function destinationFile(root: string, name: string): Promise<Stats | null> {
  const dir = dirname(name)
  if (dir !== '.') {
    const parent = await lstat(join(root, dir))
    if (parent && !parent.isDirectory()) throw new Error(`数据目录无效：${dir}`)
  }
  const existing = await lstat(join(root, name))
  if (existing && !existing.isFile()) throw new Error(`数据文件无法替换：${name}`)
  return existing
}

function validVersion(value: unknown, latest: number): boolean {
  return value === undefined ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= latest)
}

function validateJson(name: string, data: unknown): void {
  if (!isObject(data)) throw new Error(`备份文件格式不正确：${name}`)
  let valid: boolean
  const store = name.toLowerCase()
  if (store === 'config.json') {
    valid = validVersion(data.version, CURRENT_VERSION) &&
      Array.isArray(data.apps) && data.apps.every((entry) =>
        isObject(entry) && typeof entry.id === 'string' && typeof entry.name === 'string' &&
        (/^[a-z0-9_-]+$/i).test(entry.id) &&
        (entry.launchMethods === undefined || Array.isArray(entry.launchMethods)) &&
        (entry.wallpapers === undefined || Array.isArray(entry.wallpapers))
      ) && (data.linkedLaunches === undefined || Array.isArray(data.linkedLaunches))
  } else if (store === 'playtime.json') {
    valid = validVersion(data.version, 1) && Array.isArray(data.sessions) && data.sessions.every(
      (record) => isObject(record) && typeof record.appId === 'string' &&
        typeof record.startUtc === 'string' && typeof record.endUtc === 'string' &&
        typeof record.durationSec === 'number' && Number.isFinite(record.durationSec)
    )
  } else if (store === 'auth.json') {
    valid = Object.values(data).every((value) => typeof value === 'string')
  } else {
    valid = validVersion(data.version, 1) && Array.isArray(data.records) && data.records.every(
      (record) => isObject(record) && typeof record.id === 'string' &&
        typeof record.time === 'string' && typeof record.gachaType === 'string'
    )
  }
  if (!valid) throw new Error(`备份文件格式或版本不受支持：${name}`)
}

/** A backup may include old ephemeral files. Read only the persisted stores and media. */
async function readImportFiles(extracted: string): Promise<string[]> {
  const names: string[] = []
  for (const entry of await fs.readdir(extracted, { withFileTypes: true })) {
    const rootName = entry.name.toLowerCase()
    if (ROOT_FILES.has(rootName)) {
      if (!entry.isFile()) throw new Error(`备份文件无效：${entry.name}`)
      names.push(entry.name)
    } else if (MEDIA_DIRS.has(rootName) || rootName === 'gacha') {
      if (!entry.isDirectory()) throw new Error(`备份目录无效：${entry.name}`)
      const dir = join(extracted, entry.name)
      for (const file of await fs.readdir(dir, { withFileTypes: true })) {
        const name = relative(extracted, join(dir, file.name))
        if (!isImportFile(name)) continue
        if (file.name.endsWith('.tmp')) continue
        if (!file.isFile()) throw new Error(`备份文件无效：${name}`)
        names.push(name)
      }
    }
  }
  if (!names.some((name) => name.toLowerCase() === 'config.json')) throw new Error('备份缺少 config.json')
  return names
}

export async function stageSettingsBackup(userData: string, stage: string): Promise<void> {
  const { failed } = await migrateData(userData, stage)
  if (failed) throw new Error('部分数据无法读取，未完成导出')
}

async function restorePrevious(userData: string, work: string, entries: ImportEntry[]): Promise<void> {
  const failures: string[] = []
  for (const { name, existed } of [...entries].reverse()) {
    try {
      const original = join(work, 'previous', name)
      const current = join(userData, name)
      if (existed ? await lstat(original) : !(await lstat(join(work, 'next', name)))) {
        await destinationFile(userData, name)
        if (existed) await fs.rename(original, current)
        else await fs.rm(current, { force: true })
      }
    } catch (error) {
      failures.push(name)
      log(`import: could not restore ${name} (${String(error)})`)
    }
  }
  if (failures.length) throw new SettingsImportRecoveryError(`部分文件暂时无法恢复：${failures.join('、')}`)
}

/** Complete rollback before any store loads on startup. */
export async function recoverSettingsImport(userData: string): Promise<void> {
  const work = join(userData, WORK_DIR)
  const directory = await lstat(work)
  if (!directory) return
  if (!directory.isDirectory()) throw new SettingsImportRecoveryError('导入恢复目录无效')
  const result = await loadJsonSafe<Journal>(join(work, JOURNAL))
  if (result.status === 'ok') {
    if (!result.value || typeof result.value.complete !== 'boolean' ||
      !Array.isArray(result.value.entries) || !result.value.entries.every(
        (entry) => entry && typeof entry.name === 'string' && isImportFile(entry.name) &&
          typeof entry.existed === 'boolean'
      )
    ) throw new SettingsImportRecoveryError('导入恢复记录无效')
    if (!result.value.complete) {
      log('import: restoring user data left by an interrupted import')
      await restorePrevious(userData, work, result.value.entries)
      await writeFileAtomic(join(work, JOURNAL), JSON.stringify({ ...result.value, complete: true }))
    }
  } else if (result.status !== 'missing') {
    throw new SettingsImportRecoveryError('导入恢复记录不可读')
  }
  await fs.rm(work, { recursive: true, force: true }).catch((error) => {
    log(`import: could not remove the completed recovery workspace (${String(error)})`)
  })
}

export async function restoreSettingsBackup(
  extracted: string,
  userData: string,
  reload: () => Promise<void>
): Promise<void> {
  const names = await readImportFiles(extracted)
  await recoverSettingsImport(userData)
  const work = join(userData, WORK_DIR)
  await fs.mkdir(work)
  const entries: ImportEntry[] = []
  let started = false
  let keepJournal = false
  try {
    // Stage the entire archive on the destination volume before moving a live file.
    for (const name of names) {
      const existing = await destinationFile(userData, name)
      const source = join(extracted, name)
      const next = join(work, 'next', name)
      if (ROOT_FILES.has(name.toLowerCase()) || name.toLowerCase().startsWith(`gacha${sep}`)) {
        const result = await loadJsonSafe<unknown>(source)
        if (result.status !== 'ok') throw new Error(`无法读取备份文件：${name}`)
        validateJson(name, result.value)
        await writeFileAtomic(next, JSON.stringify(result.value, null, 2))
      } else {
        await fs.mkdir(dirname(next), { recursive: true })
        await fs.copyFile(source, next)
      }
      entries.push({ name, existed: !!existing })
    }
    await writeFileAtomic(join(work, JOURNAL), JSON.stringify({ entries, complete: false }))
    started = true
    for (const { name, existed } of entries) {
      const target = join(userData, name)
      await fs.mkdir(dirname(target), { recursive: true })
      if (existed) {
        const original = join(work, 'previous', name)
        await fs.mkdir(dirname(original), { recursive: true })
        await fs.rename(target, original)
      }
      await fs.rename(join(work, 'next', name), target)
    }
    await reload()
    await writeFileAtomic(join(work, JOURNAL), JSON.stringify({ entries, complete: true }))
  } catch (error) {
    if (started) {
      try {
        await restorePrevious(userData, work, entries)
        await writeFileAtomic(join(work, JOURNAL), JSON.stringify({ entries, complete: true }))
      } catch (rollbackError) {
        keepJournal = true
        if (rollbackError instanceof SettingsImportRecoveryError) throw rollbackError
        throw new SettingsImportRecoveryError(`无法记录导入恢复结果：${String(rollbackError)}`)
      }
      await reload().catch((reloadError) => {
        throw new SettingsImportRecoveryError(`已恢复原文件，重新载入失败：${String(reloadError)}`)
      })
    }
    throw error
  } finally {
    if (!keepJournal) await fs.rm(work, { recursive: true, force: true }).catch((error) => {
      log(`import: could not clean the import workspace (${String(error)})`)
    })
  }
}
