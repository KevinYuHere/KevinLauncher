import { promises as fs, createReadStream } from 'fs'
import { join, dirname, relative, sep, basename } from 'path'
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'

const exec = promisify(execFile)

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
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) out.push(relative(dir, full).split(sep).join('/'))
    }
  }
  await walk(dir)
  return out
}

async function copyFile(source: string, dest: string): Promise<void> {
  await fs.mkdir(dirname(dest), { recursive: true })
  await fs.copyFile(source, dest)
}

function md5File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/**
 * Copy every non-VFS file of the extracted patch into the staging directory
 * (the game's own binaries, assets, manifests …). `config.ini` is handled last
 * so a version bump never lands before the files it describes.
 */
export async function stageStaticFiles(extractDir: string, stageDir: string): Promise<void> {
  for (const rel of await listFiles(extractDir)) {
    if (rel.startsWith('vfs_files/')) continue
    if (rel === 'patch.json' || rel === 'delete_files.txt') continue
    if (rel.toLowerCase() === 'config.ini') continue
    await copyFile(join(extractDir, ...rel.split('/')), join(stageDir, ...rel.split('/')))
  }
}

/**
 * Assemble the new VFS files into the staging directory: whole new files are
 * copied, differential files are rebuilt from the local base with HDiff.
 * Nothing under `gameDir` is modified here — a failure leaves the install as-is.
 */
export async function applyVfsManifest(context: ApplyContext): Promise<void> {
  const { extractDir, gameDir, stageDir, manifest, signal, onProgress } = context
  const applyPatch =
    context.applyPatch ??
    (async (baseFile: string, diffFile: string, outFile: string): Promise<void> => {
      await exec(context.hpatchzPath ?? 'hpatchz', ['-f', baseFile, diffFile, outFile], {
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024
      })
    })

  const vfsRel = (manifest.vfs_base_path ?? 'Arknights_Data/StreamingAssets/AB/Windows')
    .replace(/\\/g, '/')
    .split('/')
  const gameVfs = join(gameDir, ...vfsRel)
  const stageVfs = join(stageDir, ...vfsRel)

  // Index extracted files by base name so a manifest path that does not match
  // the archive layout can still be found (mirrors the reference behaviour).
  const byName = new Map<string, string>()
  for (const rel of await listFiles(extractDir)) byName.set(basename(rel), join(extractDir, ...rel.split('/')))

  const actionable = manifest.files.filter(
    (node) => node.local_path || (node.patch && node.patch.length > 0)
  )
  const total = actionable.reduce((sum, node) => sum + (node.size || 0), 0)
  let done = 0
  const skipped: string[] = []

  for (const node of manifest.files) {
    if (signal?.aborted) throw new Error('已取消')
    if (!node.name) continue
    const target = join(stageVfs, ...node.name.split('/'))

    if (node.local_path) {
      const source =
        (await exists(join(extractDir, ...node.local_path.split('/'))))
          ? join(extractDir, ...node.local_path.split('/'))
          : byName.get(basename(node.local_path))
      if (!source) {
        skipped.push(`${node.name} | 缺少文件 ${node.local_path}`)
        continue
      }
      await copyFile(source, target)
      if (node.md5 && (await md5File(target)) !== node.md5) {
        skipped.push(`${node.name} | 复制后校验失败`)
        continue
      }
      done += node.size || 0
      onProgress?.(done, total)
      continue
    }

    const patchInfo = node.patch?.[0]
    if (!patchInfo) continue // unchanged — nothing to do

    const baseFile = join(gameVfs, ...patchInfo.base_file.split('/'))
    const diffFile =
      (await exists(join(extractDir, 'vfs_files', 'vfs_patch', ...patchInfo.patch.split('/'))))
        ? join(extractDir, 'vfs_files', 'vfs_patch', ...patchInfo.patch.split('/'))
        : byName.get(basename(patchInfo.patch))
    if (!(await exists(baseFile))) {
      skipped.push(`${node.name} | 缺少原始文件 ${patchInfo.base_file}`)
      continue
    }
    if (!diffFile) {
      skipped.push(`${node.name} | 缺少差分文件 ${patchInfo.patch}`)
      continue
    }
    if (patchInfo.base_md5 && (await md5File(baseFile)) !== patchInfo.base_md5) {
      skipped.push(`${node.name} | 原始文件校验失败`)
      continue
    }

    const stat = await fs.stat(diffFile)
    if (stat.size === 0) {
      // Empty diff means the file is unchanged in content — just carry it over.
      if (baseFile !== target) await copyFile(baseFile, target)
    } else {
      const tempOut = `${target}.tmp`
      await fs.mkdir(dirname(target), { recursive: true })
      await fs.rm(tempOut, { force: true })
      await applyPatch(baseFile, diffFile, tempOut)
      if (node.md5 && (await md5File(tempOut)) !== node.md5) {
        await fs.rm(tempOut, { force: true })
        skipped.push(`${node.name} | 补丁结果校验失败`)
        continue
      }
      await fs.rm(target, { force: true })
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

/** Copy every staged file over the game directory. */
export async function commitStage(stageDir: string, gameDir: string): Promise<void> {
  for (const rel of await listFiles(stageDir)) {
    await copyFile(join(stageDir, ...rel.split('/')), join(gameDir, ...rel.split('/')))
  }
}

/** Delete files the update removes, unless they were (re)written by this patch. */
export async function processDeleteList(
  extractDir: string,
  gameDir: string,
  stageDir: string
): Promise<void> {
  let content: string
  try {
    content = await fs.readFile(join(extractDir, 'delete_files.txt'), 'utf-8')
  } catch {
    return
  }
  const staged = new Set(await listFiles(stageDir))
  for (const raw of content.split(/\r?\n/)) {
    const rel = raw.trim().replace(/\\/g, '/')
    if (!rel || staged.has(rel)) continue
    await fs.rm(join(gameDir, ...rel.split('/')), { force: true }).catch(() => undefined)
  }
}

/** Write the new `config.ini` (the local version marker) last. */
export async function installConfig(extractDir: string, gameDir: string): Promise<void> {
  const config = join(extractDir, 'config.ini')
  if (!(await exists(config))) return
  const temp = join(gameDir, 'config.ini.new')
  await fs.copyFile(config, temp)
  await fs.rm(join(gameDir, 'config.ini'), { force: true })
  await fs.rename(temp, join(gameDir, 'config.ini'))
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}
