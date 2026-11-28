import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, relative } from 'node:path'
import { writeFileAtomic } from '../services/atomicFile'
import { hashFile } from '../services/hash'
import { allowGameFileWrite } from '../services/writableGameFile'
import { arknightsInstallPath, arknightsPath, missingPath } from './arknightsPaths'

const WORKSPACE = '_kl_stage'
const JOURNAL = WORKSPACE + '/commit.json'
const CHECKPOINT = WORKSPACE + '/progress.json'
const MARKER = 'config.ini'
type Action = { path: string; kind: 'remove' } | {
  path: string; kind: 'install'; size: number; sha256: string
}
interface Journal {
  schema: 1
  id: string
  version: string
  actions: Action[]
  cleanup?: { package: string; predownload?: boolean }
}

export async function akStageRoot(gameDir: string): Promise<string> {
  return arknightsPath(gameDir, WORKSPACE)
}

export async function akStageFiles(gameDir: string): Promise<string> {
  return arknightsPath(gameDir, WORKSPACE + '/files')
}

function parseJournal(raw: string): Journal {
  const data = JSON.parse(raw) as Journal
  const marker = data?.actions?.at(-1)
  if (!data || data.schema !== 1 || typeof data.id !== 'string' || typeof data.version !== 'string' || !data.version ||
      !Array.isArray(data.actions) || marker?.path.toLowerCase() !== MARKER || marker.kind !== 'install') {
    throw new Error('明日方舟更新提交日志无效')
  }
  if (data.cleanup && !/^_kl_packages\/[a-f0-9]{64}$/.test(data.cleanup.package)) {
    throw new Error('明日方舟更新提交日志中的包缓存无效')
  }
  const seen = new Set<string>()
  for (const action of data.actions) {
    const path = arknightsInstallPath(action?.path)
    const key = path.toLowerCase()
    if (seen.has(key) || (action.kind !== 'remove' && action.kind !== 'install') ||
        (action.kind === 'install' && (!Number.isSafeInteger(action.size) || action.size < 0 ||
          !/^[a-f0-9]{64}$/.test(action.sha256)))) {
      throw new Error('明日方舟更新提交日志无效')
    }
    seen.add(key)
  }
  return data
}

async function readJournal(gameDir: string): Promise<Journal | null> {
  const path = await arknightsPath(gameDir, JOURNAL)
  try {
    return parseJournal(await fs.readFile(path, 'utf8'))
  } catch (error) {
    if (missingPath(error)) return null
    throw error
  }
}

/** A malformed or unreadable journal also blocks launches and requires attention. */
export async function arknightsRecoveryPending(gameDir: string): Promise<boolean> {
  return (await readJournal(gameDir)) !== null
}

async function collectStageFiles(root: string, dir = '', signal?: AbortSignal): Promise<string[]> {
  const files: string[] = []
  for await (const entry of await fs.opendir(join(root, dir))) {
    signal?.throwIfAborted()
    const rel = arknightsInstallPath(dir ? `${dir}/${entry.name}` : entry.name)
    if (entry.isDirectory()) {
      for (const file of await collectStageFiles(root, rel, signal)) files.push(file)
    } else if (entry.isFile()) files.push(rel)
    else throw new Error('补丁包含非普通文件：' + rel)
  }
  return files
}

async function saveJournal(gameDir: string, journal: Journal): Promise<void> {
  await writeFileAtomic(await arknightsPath(gameDir, JOURNAL), JSON.stringify(journal))
}

async function readCursor(checkpoint: string, journal: Journal): Promise<number> {
  try {
    const data = JSON.parse(await fs.readFile(checkpoint, 'utf8')) as { id: string; cursor: number }
    if (data.id !== journal.id || !Number.isSafeInteger(data.cursor) ||
        data.cursor < 0 || data.cursor > journal.actions.length) throw new Error('明日方舟更新进度无效')
    return data.cursor
  } catch (error) {
    if (missingPath(error)) return 0
    throw error
  }
}

/** Freeze hashes and path operations before replacing any live file. */
export async function createArknightsCommit(gameDir: string, version: string, deletions: readonly string[],
  signal?: AbortSignal, cleanup?: { packageDir: string; predownload?: boolean }
): Promise<void> {
  const stage = await akStageFiles(gameDir)
  const paths = await collectStageFiles(stage, '', signal)
  const names = new Set<string>()
  const actions: Action[] = []
  let marker: Action | undefined
  for (const path of paths.sort()) {
    signal?.throwIfAborted()
    const key = path.toLowerCase()
    if (names.has(key)) throw new Error('补丁文件名重复：' + path)
    names.add(key)
    const file = await arknightsPath(stage, path)
    const size = (await fs.stat(file)).size
    const action: Action = { path, kind: 'install', size, sha256: await hashFile(file, 'sha256', signal) }
    if (key === MARKER) marker = action
    else actions.push(action)
  }
  if (!marker) throw new Error('更新包缺少新的游戏版本文件')
  for (const deletion of deletions) {
    const path = arknightsInstallPath(deletion)
    const key = path.toLowerCase()
    if (!names.has(key)) {
      actions.push({ path, kind: 'remove' })
      names.add(key)
    }
  }
  actions.push(marker)
  for (const action of actions) await arknightsPath(gameDir, action.path)
  signal?.throwIfAborted()
  const packageCache = cleanup ? relative(gameDir, cleanup.packageDir).replace(/\\/g, '/') : null
  if (packageCache && !/^_kl_packages\/[a-f0-9]{64}$/.test(packageCache)) throw new Error('更新包缓存目录无效')
  await saveJournal(gameDir, { schema: 1, id: randomUUID(), version, actions,
    cleanup: packageCache ? { package: packageCache, predownload: cleanup?.predownload } : undefined })
}

/** Recover by proceeding from immutable, verified staged outputs. */
export async function finishArknightsCommit(gameDir: string, signal?: AbortSignal, onProgress?:
  (completed: number, total: number) => void
): Promise<boolean> {
  const journal = await readJournal(gameDir)
  if (!journal) return false
  const stage = await akStageFiles(gameDir)
  const checkpoint = await arknightsPath(gameDir, CHECKPOINT)
  let cursor = await readCursor(checkpoint, journal)
  while (cursor < journal.actions.length) {
    signal?.throwIfAborted()
    const action = journal.actions[cursor]
    const destination = await arknightsPath(gameDir, action.path)
    if (action.kind === 'install') {
      const source = await arknightsPath(stage, action.path)
      const staged = await fs.lstat(source).catch((error) => {
        if (missingPath(error)) return null
        throw error
      })
      // A crash between rename and checkpoint is recoverable by validating
      // the live file. Uncommitted results remain in their original workspace.
      const candidate = staged ? source : destination
      const stat = staged ?? await fs.lstat(destination)
      if (!stat.isFile() || stat.size !== action.size || await hashFile(candidate, 'sha256', signal) !== action.sha256) {
        throw new Error('已验证的更新暂存文件发生变化：' + action.path)
      }
      signal?.throwIfAborted()
      if (staged) {
        await fs.mkdir(dirname(destination), { recursive: true })
        await allowGameFileWrite(destination)
        await fs.rename(source, destination)
      }
    } else {
      await allowGameFileWrite(destination)
      await fs.unlink(destination).catch((error) => { if (!missingPath(error)) throw error })
    }
    cursor++
    await writeFileAtomic(checkpoint, JSON.stringify({ id: journal.id, cursor }))
    onProgress?.(cursor, journal.actions.length)
  }
  if (journal.cleanup) {
    await fs.rm(await arknightsPath(gameDir, journal.cleanup.package), { recursive: true, force: true })
    if (journal.cleanup.predownload) {
      await fs.rm(await arknightsPath(gameDir, `_kl_pre/${journal.version}`), { recursive: true, force: true })
    }
  }
  await fs.unlink(await arknightsPath(gameDir, JOURNAL))
  await fs.rm(await akStageRoot(gameDir), { recursive: true, force: true })
  return true
}
