import { constants, promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Just the live file being modified may need its read-only bit cleared. */
export async function allowGameFileWrite(path: string): Promise<void> {
  try {
    const stat = await fs.lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('游戏写入目标不是普通文件：' + path)
    if ((stat.mode & 0o200) === 0) {
      if (stat.nlink > 1) throw new Error('游戏文件的只读硬链接无法安全改写：' + path)
      await fs.chmod(path, (stat.mode & 0o7777) | 0o200)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Preserve a resumable prefix without ever writing through a shared hard link. */
export async function openWritableGameFile(path: string): Promise<FileHandle> {
  await allowGameFileWrite(path)
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
