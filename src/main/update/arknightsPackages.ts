import { promises as fs, constants } from 'node:fs'
import { dirname } from 'node:path'
import { verifiedDownload } from '../services/downloader'
import { sha256Bytes } from '../services/hash'
import { arknightsFileName, arknightsPath, missingPath } from './arknightsPaths'
import type { AkPack } from './arknightsUpdate'

export function validateArknightsPackages(parts: readonly AkPack[]): void {
  const seen = new Set<string>()
  for (const part of parts) {
    const name = arknightsFileName(part.name).toLowerCase()
    const url = new URL(part.url)
    if (!['https:', 'http:'].includes(url.protocol) || seen.has(name) || !Number.isSafeInteger(part.size) ||
        part.size < 0 || (part.md5 !== undefined && !/^[a-f0-9]{32}$/i.test(part.md5))) {
      throw new Error('明日方舟更新包清单无效')
    }
    seen.add(name)
  }
}

export async function arknightsPackageDirectory(
  gameDir: string, version: string, kind: 'delta' | 'full', parts: readonly AkPack[]
): Promise<string> {
  validateArknightsPackages(parts)
  const id = sha256Bytes(Buffer.from(JSON.stringify([version, kind, parts.map(({ name, size, md5 }) => [name, size, md5])])))
  return arknightsPath(gameDir, '_kl_packages/' + id)
}

export async function missingVolumeBytes(directory: string, parts: readonly AkPack[]): Promise<number> {
  let remaining = 0
  for (const part of parts) {
    const final = await arknightsPath(directory, part.name)
    if (await verifiedDownload(final, part.size || undefined, part.md5)) continue
    const pending = await arknightsPath(directory, part.name + '.part')
    const partialSize = await fs.stat(pending).then((info) => info.isFile() ? info.size : 0, (error) => {
      if (missingPath(error)) return 0
      throw error
    })
    remaining += partialSize < part.size ? part.size - partialSize : part.size
  }
  return remaining
}

export async function cacheArknightsVolume(
  source: string, destination: string, part: AkPack
): Promise<boolean> {
  if (!await verifiedDownload(source, part.size || undefined, part.md5)) return false
  if (await verifiedDownload(destination, part.size || undefined, part.md5)) return true
  await fs.mkdir(dirname(destination), { recursive: true })
  await fs.unlink(destination).catch((error) => { if (!missingPath(error)) throw error })
  try { await fs.link(source, destination) }
  catch { await fs.copyFile(source, destination, constants.COPYFILE_EXCL) }
  return true
}

const splitArchiveName = /^(.*\.zip)\.(\d{3})$/i

export function arknightsFullVolumes(paths: readonly string[], names: readonly string[]): string[][] {
  const archives: string[][] = []
  const split = new Map<string, string[]>()
  for (const [index, name] of names.entries()) {
    const matched = splitArchiveName.exec(name)
    if (!matched) {
      archives.push([paths[index]])
      continue
    }
    const key = matched[1].toLowerCase()
    let group = split.get(key)
    if (!group) {
      group = []
      archives.push(group)
      split.set(key, group)
    }
    const position = Number(matched[2]) - 1
    if (position < 0 || group[position]) throw new Error('明日方舟安装包分卷不连续')
    group[position] = paths[index]
  }
  for (const group of split.values()) {
    for (const volume of group) {
      if (!volume) throw new Error('明日方舟安装包分卷不连续')
    }
  }
  return archives
}

export function arknightsDeltaVolumes(paths: string[], names: string[]): string[] {
  if (!names.length || !names.every(name => splitArchiveName.test(name))) return paths
  const archives = arknightsFullVolumes(paths, names)
  if (archives.length !== 1) throw new Error('明日方舟增量包分卷不属于同一个归档')
  return archives[0]
}
