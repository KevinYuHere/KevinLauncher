import { promises as fs } from 'fs'
import { join, dirname, relative, sep, basename } from 'path'
import { md5File } from '../services/hash'
import { runTaskProcess } from '../services/taskProcess'
import { arknightsInstallPath, arknightsPath, arknightsRelativePath, missingPath } from './arknightsPaths'

/** A single `patch.json` file entry (VFS = Unity asset bundles). */
export interface PatchFileNode {
  name: string
  md5?: string
  size: number
  /** Present for new/changed files that are shipped whole. */
  local_path?: string
  /** Present for differential (HDiff) files. */
  patch?: {
    base_file: string
    base_md5?: string
    patch: string
  }[]
}

export interface PatchManifest {
  version?: string
  vfs_base_path?: string
  files: PatchFileNode[]
}

export interface ApplyContext {
  /** Where the encrypted archive was extracted. */
  extractDir: string
  /** The game installation directory. */
  gameDir: string
  /** Sandbox the update is assembled in before it is committed. */
  stageDir: string
  manifest: PatchManifest
  /** Path to the bundled `hpatchz` (used when `applyPatch` is not supplied). */
  hpatchzPath?: string
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
  /** Applies an HDiff patch. Defaults to the bundled `hpatchz`. */
  applyPatch?: (baseFile: string, diffFile: string, outFile: string) => Promise<void>
}

/** Recursively list files under `dir` (relative paths with `/`). */
async function listFiles(dir: string, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = []
  const walk = async (current: string): Promise<void> => {
    for await (const entry of await fs.opendir(current)) {
      signal?.throwIfAborted()
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) out.push(relative(dir, full).split(sep).join('/'))
      else throw new Error('补丁包含非普通文件：' + entry.name)
    }
  }
  await walk(dir)
  return out
}

async function copyFile(source: string, dest: string): Promise<void> {
  await fs.mkdir(dirname(dest), { recursive: true })
  await fs.copyFile(source, dest)
}

/**
 * Copy every non-VFS file of the extracted patch into the staging directory
 * (the game's own binaries, assets, manifests …). `config.ini` is handled last
 * so a version bump never lands before the files it describes.
 */
export async function stageStaticFiles(extractDir: string, stageDir: string, signal?: AbortSignal): Promise<void> {
  for (const rel of await listFiles(extractDir, signal)) {
    signal?.throwIfAborted()
    const key = rel.toLowerCase()
    if (key.startsWith('vfs_files/') || key === 'patch.json' || key === 'delete_files.txt') continue
    const path = arknightsInstallPath(rel)
    await copyFile(await arknightsPath(extractDir, path), await arknightsPath(stageDir, path))
  }
}

export function validateArknightsManifest(manifest: PatchManifest): void {
  if (!manifest || !Array.isArray(manifest.files)) throw new Error('补丁清单缺少文件列表')
  if (manifest.vfs_base_path !== undefined) arknightsInstallPath(manifest.vfs_base_path)
  const names = new Set<string>()
  for (const node of manifest.files) {
    if (!node || !Number.isSafeInteger(node.size) || node.size < 0 ||
        (node.md5 !== undefined && !/^[a-f0-9]{32}$/i.test(node.md5))) throw new Error('补丁文件校验信息无效')
    const name = arknightsRelativePath(node.name).toLowerCase()
    if (names.has(name)) throw new Error('补丁清单中有重复文件：' + node.name)
    names.add(name)
    if (node.local_path !== undefined) arknightsRelativePath(node.local_path)
    if (node.patch !== undefined) {
      if (!Array.isArray(node.patch)) throw new Error('补丁差分列表无效')
      for (const patch of node.patch) {
        if (!patch || (patch.base_md5 !== undefined && !/^[a-f0-9]{32}$/i.test(patch.base_md5))) {
          throw new Error('补丁基础文件校验信息无效')
        }
        arknightsRelativePath(patch.base_file)
        arknightsRelativePath(patch.patch)
      }
    }
  }
}

/**
 * Assemble the new VFS files into the staging directory: whole new files are
 * copied, differential files are rebuilt from the local base with HDiff.
 * Nothing under `gameDir` is modified here — a failure leaves the install as-is.
 */
export async function applyVfsManifest(context: ApplyContext): Promise<void> {
  const { extractDir, gameDir, stageDir, manifest, signal, onProgress } = context
  validateArknightsManifest(manifest)
  const applyPatch =
    context.applyPatch ??
    ((baseFile, diffFile, outFile) => runTaskProcess(context.hpatchzPath ?? 'hpatchz', ['-f', baseFile, diffFile, outFile], { signal }))
  const vfs = arknightsInstallPath(manifest.vfs_base_path ?? 'Arknights_Data/StreamingAssets/AB/Windows')

  // Index extracted files by base name so a manifest path that does not match
  // the archive layout can still be found (mirrors the reference behaviour).
  const byName = new Map<string, string | null>()
  for (const rel of await listFiles(extractDir, signal)) {
    const name = basename(rel).toLowerCase()
    byName.set(name, byName.has(name) ? null : rel)
  }
  const sourceFor = async (relative: string): Promise<string | null> => {
    const exact = await arknightsPath(extractDir, relative)
    if (await exists(exact)) return exact
    const fallback = byName.get(basename(relative).toLowerCase())
    return fallback ? arknightsPath(extractDir, fallback) : null
  }

  const actionable = manifest.files.filter(
    (node) => node.local_path || (node.patch && node.patch.length > 0)
  )
  const total = actionable.reduce((sum, node) => sum + (node.size || 0), 0)
  let done = 0
  const skipped: string[] = []

  for (const node of manifest.files) {
    signal?.throwIfAborted()
    const target = await arknightsPath(stageDir, `${vfs}/${node.name}`)

    if (node.local_path) {
      const source = await sourceFor(node.local_path)
      if (!source) {
        skipped.push(`${node.name} | 缺少文件 ${node.local_path}`)
        continue
      }
      await copyFile(source, target)
      if (!await validOutput(target, node, signal)) {
        skipped.push(`${node.name} | 复制后校验失败`)
        continue
      }
      done += node.size || 0
      onProgress?.(done, total)
      continue
    }

    const patchInfo = node.patch?.[0]
    if (!patchInfo) continue // unchanged — nothing to do

    const baseFile = await arknightsPath(gameDir, `${vfs}/${patchInfo.base_file}`)
    const diffFile = await sourceFor(`vfs_files/vfs_patch/${patchInfo.patch}`)
    if (!(await exists(baseFile))) {
      skipped.push(`${node.name} | 缺少原始文件 ${patchInfo.base_file}`)
      continue
    }
    if (!diffFile) {
      skipped.push(`${node.name} | 缺少差分文件 ${patchInfo.patch}`)
      continue
    }
    if (patchInfo.base_md5 && (await md5File(baseFile, signal)) !== patchInfo.base_md5.toLowerCase()) {
      skipped.push(`${node.name} | 原始文件校验失败`)
      continue
    }

    const stat = await fs.stat(diffFile)
    if (stat.size === 0) {
      // Empty diff means the file is unchanged in content — just carry it over.
      if (baseFile !== target) await copyFile(baseFile, target)
      if (!await validOutput(target, node, signal)) {
        skipped.push(`${node.name} | 空差分结果校验失败`)
        continue
      }
    } else {
      const tempOut = `${target}.tmp`
      await fs.mkdir(dirname(target), { recursive: true })
      await fs.rm(tempOut, { force: true })
      await applyPatch(baseFile, diffFile, tempOut)
      if (!await validOutput(tempOut, node, signal)) {
        await fs.rm(tempOut, { force: true })
        skipped.push(`${node.name} | 补丁结果校验失败`)
        continue
      }
      await fs.rename(tempOut, target)
    }
    done += node.size || 0
    onProgress?.(done, total)
  }

  if (skipped.length > 0) {
    const preview = skipped.slice(0, 10).join('；')
    throw new Error(`增量补丁无法完整应用（${skipped.length} 个文件）：${preview}`)
  }
}

async function validOutput(path: string, node: PatchFileNode, signal?: AbortSignal): Promise<boolean> {
  const size = (await fs.stat(path)).size
  return size === node.size && (!node.md5 || await md5File(path, signal) === node.md5.toLowerCase())
}

export async function readDeleteList(extractDir: string): Promise<string[]> {
  let content: string
  try {
    content = await fs.readFile(await arknightsPath(extractDir, 'delete_files.txt'), 'utf-8')
  } catch (error) {
    if (missingPath(error)) return []
    throw error
  }
  return content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(arknightsInstallPath)
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch (error) {
    if (missingPath(error)) return false
    throw error
  }
}
