import { promises as fs } from 'fs'
import { basename, dirname, isAbsolute, join } from 'path'
import { directoriesOverlap } from '@shared/paths'
import { loadJsonSafe, writeFileAtomic } from './atomicFile'
import { isFileSystemRoot, realDirectoryPath, sameDirectoryPath } from './directoryPath'
import { verifySnapshot } from './settingsBackup'
import { log } from './logger'

const FILE = 'data-move.json'
export const DATA_MOVE_PREFIX = '.kevin-data-move-'

interface DataMoveJournal {
  source: string
  target: string
  work: string
  hadTarget: boolean
}

export class DataDirectoryRecoveryError extends Error {}

async function lstat(path: string) {
  return fs.lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
}

export async function recordDataMove(journal: DataMoveJournal, stage: string): Promise<void> {
  const encoded = JSON.stringify(journal)
  // The directory that the registry points to determines the outcome after power loss.
  await writeFileAtomic(join(journal.work, FILE), encoded)
  await writeFileAtomic(join(stage, FILE), encoded)
  await writeFileAtomic(join(journal.source, FILE), encoded)
}

export async function clearDataMoveJournal(root: string): Promise<void> {
  await fs.rm(join(root, FILE), { force: true })
}

async function readJournal(root: string): Promise<DataMoveJournal | undefined> {
  const file = join(root, FILE)
  const info = await lstat(file)
  if (!info) return undefined
  if (!info.isFile()) throw new DataDirectoryRecoveryError('数据迁移记录不是普通文件')
  const result = await loadJsonSafe<DataMoveJournal | null>(file)
  if (result.status !== 'ok') throw new DataDirectoryRecoveryError('无法读取数据迁移记录')
  const journal = result.value
  if (!journal || typeof journal.source !== 'string' || typeof journal.target !== 'string' ||
      typeof journal.work !== 'string' || typeof journal.hadTarget !== 'boolean' ||
      ![journal.source, journal.target, journal.work].every((path) => isAbsolute(path) && !isFileSystemRoot(path)) ||
      directoriesOverlap(journal.source, journal.target) ||
      directoriesOverlap(journal.source, journal.work) ||
      directoriesOverlap(journal.target, journal.work) ||
      !sameDirectoryPath(dirname(journal.work), dirname(journal.target)) ||
      !basename(journal.work).startsWith(DATA_MOVE_PREFIX)) {
    throw new DataDirectoryRecoveryError('数据迁移记录无效')
  }
  return journal
}

function matches(left: DataMoveJournal, right: DataMoveJournal | undefined): boolean {
  return !!right && left.source === right.source && left.target === right.target &&
    left.work === right.work && left.hadTarget === right.hadTarget
}

/** Recover the destination while the registry still identifies the authoritative source. */
export async function recoverDataMove(root: string): Promise<void> {
  const canonical = await realDirectoryPath(root)
  const journal = await readJournal(canonical)
  if (!journal) return
  const { source, target, work, hadTarget } = journal
  if (!sameDirectoryPath(canonical, source) && !sameDirectoryPath(canonical, target)) {
    throw new DataDirectoryRecoveryError('数据迁移记录与当前目录不符')
  }
  if (!(await lstat(work))?.isDirectory() || !sameDirectoryPath(await realDirectoryPath(work), work) ||
      !matches(journal, await readJournal(work))) {
    throw new DataDirectoryRecoveryError(`无法验证数据迁移暂存区 ${work}`)
  }
  if (sameDirectoryPath(canonical, target)) {
    await verifySnapshot(canonical)
    // Keep the old data and any original destination after a stopped process.
    if (matches(journal, await readJournal(source))) await clearDataMoveJournal(source)
    await clearDataMoveJournal(canonical)
    log(`dataDir: confirmed switched directory; recovery files retained at ${work}`)
    return
  }
  const original = join(work, 'previous')
  const staged = join(work, 'next')
  const targetInfo = await lstat(target)
  if (targetInfo && (!targetInfo.isDirectory() || !sameDirectoryPath(await realDirectoryPath(target), target))) {
    throw new DataDirectoryRecoveryError('数据迁移目标的实际目录已变化')
  }
  if (targetInfo && matches(journal, await readJournal(target))) {
    if (await lstat(staged)) throw new DataDirectoryRecoveryError(`数据迁移暂存区需要手动确认：${work}`)
    await fs.rename(target, staged)
  }
  const oldTarget = await lstat(original)
  if (oldTarget) {
    if (!oldTarget.isDirectory() || await lstat(target)) {
      throw new DataDirectoryRecoveryError(`原目标目录已保留，请检查：${original}`)
    }
    await fs.rename(original, target)
  } else if (hadTarget && !(await lstat(target))) {
    throw new DataDirectoryRecoveryError(`原目标目录缺失，请检查：${work}`)
  }
  await clearDataMoveJournal(canonical)
  await fs.rm(work, { recursive: true, force: true }).catch((error) =>
    log(`dataDir: could not remove migration workspace (${String(error)})`))
}
