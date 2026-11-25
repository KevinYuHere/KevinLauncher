import { promises as fs } from 'fs'
import { md5File } from '../services/hash'
import type { HardLinkService } from '../services/hardLinkService'
import { downloadGameFile } from './hoyoNetwork'

export async function cacheHoYoResource(path: string, url: string, size: number, md5: string, links: HardLinkService | undefined, signal: AbortSignal,
  report?: (bytes: number) => void): Promise<void> {
  if (links && await links.tryLink(path, size, md5, signal)) return
  const matches = async (file: string): Promise<boolean> => {
    try { return (await fs.stat(file)).size === size && (!md5 || await md5File(file) === md5.toLowerCase()) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  if (!await matches(path)) {
    const tmp = path + '.tmp'
    await downloadGameFile({ path: tmp, url, size, signal, onProgress: report })
    if (!await matches(tmp)) {
      await fs.rm(tmp, { force: true })
      throw new Error('资源校验失败：' + path)
    }
    await fs.rename(tmp, path)
  }
  void links?.insert(path, size, md5)
}
