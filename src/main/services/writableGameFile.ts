import { constants, promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Preserve a resumable prefix without ever writing through a shared hard link. */
export async function openWritableGameFile(path: string): Promise<FileHandle> {
  const handle = await fs.open(path, 'r+').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return fs.open(path, 'wx+')
  })
  let shared: boolean
  try {
    shared = (await handle.stat()).nlink > 1
  } catch (error) {
    await handle.close()
    throw error
  }
  if (!shared) return handle

  await handle.close()
  const work = await fs.mkdtemp(join(dirname(path), '.kevin-detach-'))
  const staged = join(work, 'download-prefix')
  try {
    await fs.copyFile(path, staged, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
    await fs.rename(staged, path)
    return await fs.open(path, 'r+')
  } finally {
    await fs.unlink(staged).catch(() => undefined)
    await fs.rmdir(work).catch(() => undefined)
  }
}
