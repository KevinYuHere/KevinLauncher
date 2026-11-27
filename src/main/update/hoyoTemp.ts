import { promises as fs } from 'node:fs'
import { relative } from 'node:path'
import { sha256Bytes } from '../services/hash'
import { gamePath } from './hoyoFiles'

const ROOT = '.kevin-launcher-update'

export function gameWorkKey(game: string, current: string, target: string, operation: string): string {
  return sha256Bytes(Buffer.from(JSON.stringify([game, current, target, operation])))
}

export function temporaryGameFile(dir: string, work: string, purpose: string, destination: string): string {
  const name = relative(dir, destination)
  gamePath(dir, name)
  return gamePath(dir, `${ROOT}/${work}/${purpose}/${name}`)
}

export async function validateGameWork(dir: string, work: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(work)) throw new Error('游戏更新工作目录无效')
  for (const name of [ROOT, `${ROOT}/${work}`]) {
    try {
      const info = await fs.lstat(gamePath(dir, name))
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('游戏更新工作目录包含重解析点')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

/** Cleans the exact workspace named by this job's game, versions and operation. */
export async function cleanGameWork(dir: string, work: string): Promise<void> {
  await validateGameWork(dir, work)
  await fs.rm(gamePath(dir, `${ROOT}/${work}`), { recursive: true, force: true })
}
