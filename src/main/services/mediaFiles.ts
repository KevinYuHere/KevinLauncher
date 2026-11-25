import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { configMediaReferences, isMediaFilename, type MediaDirectory } from '@shared/mediaReferences'
import { writeFileAtomic } from './atomicFile'
import type { LauncherConfig } from './configValidation'
import { log } from './logger'

/** Refuse to resolve a managed media directory through a junction. */
export async function openMediaDirectory(path: string, create = false): Promise<void> {
  if (create) await fs.mkdir(path, { recursive: true })
  const info = await fs.lstat(path)
  if (!info.isDirectory()) throw new Error('媒体目录无效')
}

export function brandIcoName(file: string): string {
  return `${file.replace(/\.(?:png|ico)$/i, '')}.ico`
}

export async function saveMedia(path: string, name: string, contents: Buffer): Promise<string> {
  if (!isMediaFilename(name)) throw new Error('媒体文件名无效')
  await openMediaDirectory(path, true)
  await writeFileAtomic(join(path, name), contents)
  return name
}

export async function copyMedia(path: string, name: string, source: string): Promise<string> {
  if (!isMediaFilename(name)) throw new Error('媒体文件名无效')
  await openMediaDirectory(path, true)
  const temporary = join(path, `${randomUUID()}.tmp`)
  try {
    await fs.copyFile(source, temporary)
    await fs.rename(temporary, join(path, name))
    return name
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Map normalized names to the original on-disk names, retaining shared references. */
export function mediaReferences(config: LauncherConfig): Map<MediaDirectory, Map<string, string>> {
  const refs = new Map<MediaDirectory, Map<string, string>>()
  for (const [dir, file] of configMediaReferences(config)) {
    if (!isMediaFilename(file)) continue
    const files = refs.get(dir) ?? new Map<string, string>()
    files.set(file.toLowerCase(), file)
    refs.set(dir, files)
  }
  return refs
}

async function removeMedia(path: string, file: string): Promise<void> {
  try {
    await openMediaDirectory(path)
    const target = join(path, file)
    if ((await fs.lstat(target)).isFile()) await fs.unlink(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`media: could not remove ${file} (${String(error)})`)
    }
  }
}

export async function collectReplacedMedia(
  root: string,
  before: LauncherConfig,
  after: LauncherConfig
): Promise<void> {
  const retained = mediaReferences(after)
  for (const [dir, files] of mediaReferences(before)) {
    for (const [key, file] of files) {
      const current = retained.get(dir)
      if (current?.has(key)) continue
      const path = join(root, dir)
      await removeMedia(path, file)
      const ico = brandIcoName(file)
      if (dir === 'brand' && !current?.has(ico.toLowerCase())) await removeMedia(path, ico)
    }
  }
}

/** Only UUID-named files were created by these stores. Keep legacy/custom files. */
export async function collectOrphanMedia(
  root: string, config: LauncherConfig, directories: readonly MediaDirectory[] = ['icons', 'bg']
): Promise<void> {
  const refs = mediaReferences(config)
  const brand = config.launcher?.iconFile
  if (brand) refs.get('brand')?.set(brandIcoName(brand).toLowerCase(), brandIcoName(brand))
  for (const dir of directories) {
    const path = join(root, dir)
    try {
      await openMediaDirectory(path)
      for (const file of await fs.readdir(path, { withFileTypes: true })) {
        if (file.isFile() && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\.[\w-]+$/i.test(file.name) &&
          !refs.get(dir)?.has(file.name.toLowerCase())) await removeMedia(path, file.name)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log(`media: could not check ${dir} (${String(error)})`)
    }
  }
}
