import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const reserved = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i
const privateRoots = new Set(['_kl_pre', '_kl_delta', '_kl_stage', '_kl_packages', 'diffs'])

export function arknightsRelativePath(value: unknown): string {
  if (typeof value !== 'string') throw new Error('补丁路径无效')
  const normalized = value.replace(/\\/g, '/')
  if (normalized.split('/').some(part => !part || part === '.' || part === '..' ||
    /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || reserved.test(part))) {
    throw new Error('补丁路径无效：' + value)
  }
  return normalized
}

export function arknightsInstallPath(value: unknown): string {
  const relative = arknightsRelativePath(value)
  if (privateRoots.has(relative.split('/')[0].toLowerCase())) throw new Error('补丁路径指向内部目录')
  return relative
}

export function arknightsFileName(value: unknown): string {
  const name = arknightsRelativePath(value)
  if (name.includes('/')) throw new Error('下载包文件名无效')
  return name
}

export function missingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** Check each existing component before an operation that may follow it. */
export async function arknightsPath(root: string, relative: unknown): Promise<string> {
  let path = root
  const parts = arknightsRelativePath(relative).split('/')
  for (const [index, component] of parts.entries()) {
    path = join(path, component)
    try {
      const found = await fs.lstat(path)
      if (found.isSymbolicLink()) throw new Error('游戏更新目录包含重解析点：' + path)
      if (index < parts.length - 1 && !found.isDirectory()) throw new Error('游戏更新目录被文件占用：' + path)
    } catch (error) {
      if (!missingPath(error)) throw error
      return join(path, ...parts.slice(index + 1))
    }
  }
  return path
}
