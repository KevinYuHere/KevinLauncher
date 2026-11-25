import { promises as fs } from 'fs'
import { dirname } from 'node:path'
import { md5File } from '../services/hash'
import type { HardLinkService } from '../services/hardLinkService'
import { downloadGameFile } from './hoyoNetwork'
import { requirePlainGamePath } from './hoyoFiles'
import { temporaryGameFile } from './hoyoTemp'

export async function cacheHoYoResource(root: string, path: string, url: string, size: number, md5: string, links: HardLinkService | undefined, signal: AbortSignal,
  report?: (bytes: number) => void, work?: string): Promise<boolean> {
  await requirePlainGamePath(root, path)
  const matches = async (file: string): Promise<boolean> => {
    try { return (await fs.stat(file)).size === size && (!md5 || await md5File(file) === md5.toLowerCase()) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  const published = !await matches(path)
  if (published) {
    if (links && await links.tryLink(path, size, md5, signal)) return true
    const tmp = work ? temporaryGameFile(root, work, 'cache-downloads', path) : path + '.tmp'
    await requirePlainGamePath(root, tmp)
    await downloadGameFile({ path: tmp, url, size, signal, onProgress: report })
    if (!await matches(tmp)) {
      await fs.rm(tmp, { force: true })
      throw new Error('资源校验失败：' + path)
    }
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.rename(tmp, path)
  }
  void links?.insert(path, size, md5)
  return published
}
