import { promises as fs } from 'fs'
import { dirname, join, normalize, parse } from 'path'

export function isFileSystemRoot(dir: string): boolean {
  // Node's parser treats the extended UNC prefix as a device, not a share.
  const normalized = normalize(dir.replace(/^\\\\\?\\UNC\\/i, '\\\\'))
  return normalized === parse(normalized).root
}

/** Create a transaction's workspace next to its target so renames stay on the same volume. */
export async function createSiblingWorkspace(target: string, prefix: string): Promise<string> {
  const parent = dirname(target)
  // Windows rejects mkdir on a volume root even with recursive enabled.
  // mkdtemp still reports genuine errors writing there.
  if (!isFileSystemRoot(parent)) {
    const existing = await fs.lstat(parent).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (!existing) await fs.mkdir(parent, { recursive: true })
    else if (!existing.isDirectory()) throw new Error('暂存区的父路径必须是实体目录：' + parent)
  }
  return fs.mkdtemp(join(parent, prefix))
}
