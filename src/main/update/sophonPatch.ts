import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { decompress } from 'fzstd'
import { md5File } from '../services/hash'
import { readBodyThrottled } from '../services/rateLimit'
import {
  fetchChunk,
  fetchManifest,
  fetchRetry,
  isLanguageField,
  type SophonAsset,
  type SophonBuild
} from './sophon'

const exec = promisify(execFile)
const CHUNK_API = 'https://downloader-api.mihoyo.com/downloader/sophon_chunk/api'
const CONCURRENCY = 16

export class PatchBuildNotFound extends Error {}

export interface PatchCategory {
  categoryId: string
  matchingField: string
  manifestId: string
  manifestUrlPrefix: string
  manifestCompression: number
  manifestSuffix: string
  diffUrlPrefix: string
  diffCompression: number
  diffSuffix: string
  versions: Record<string, { compressedSize: number; fileCount: number }>
}
export interface PatchBuild {
  patchId: string
  tag: string
  categories: PatchCategory[]
}

interface PatchChunk {
  patchName: string
  patchFileSize: number
  patchFileMd5: string
  patchOffset: number
  patchLength: number
  originalFileName: string
  originalFileLength: number
  originalFileMd5: string
}
interface PatchAsset {
  assetName: string
  infos: { versionTag: string; chunk: PatchChunk }[]
}
interface UnusedAsset {
  versionTag: string
  files: { fileName: string }[]
}
interface PatchProto {
  patchAssets: PatchAsset[]
  unusedAssets: UnusedAsset[]
}

export async function getPatchBuild(branch: {
  branch: string
  packageId: string
  password: string
}): Promise<PatchBuild> {
  const url =
    `${CHUNK_API}/getPatchBuild?branch=${encodeURIComponent(branch.branch)}` +
    `&package_id=${encodeURIComponent(branch.packageId)}&password=${encodeURIComponent(branch.password)}`
  const res = await fetchRetry(url, { method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0' } })
  const json = (await res.json()) as {
    retcode: number
    message: string
    data?: {
      patch_id: string
      tag: string
      manifests: {
        category_id: string
        matching_field?: string
        manifest: { id: string }
        manifest_download: { url_prefix: string; compression?: number; url_suffix?: string }
        diff_download: { url_prefix: string; compression?: number; url_suffix?: string }
        stats?: Record<string, { compressed_size?: string; file_count?: string }>
      }[]
    }
  }
  if (json.retcode === -202) throw new PatchBuildNotFound(json.message || 'patch build not found')
  if (json.retcode !== 0 || !json.data) throw new Error(json.message || 'getPatchBuild 失败')
  return {
    patchId: json.data.patch_id,
    tag: json.data.tag,
    categories: (json.data.manifests ?? []).map((m) => ({
      categoryId: m.category_id,
      matchingField: m.matching_field ?? '',
      manifestId: m.manifest.id,
      manifestUrlPrefix: m.manifest_download.url_prefix,
      manifestCompression: m.manifest_download.compression ?? 1,
      manifestSuffix: m.manifest_download.url_suffix ?? '',
      diffUrlPrefix: m.diff_download.url_prefix,
      diffCompression: m.diff_download.compression ?? 1,
      diffSuffix: m.diff_download.url_suffix ?? '',
      versions: Object.fromEntries(
        Object.entries(m.stats ?? {}).map(([k, v]) => [
          k,
          { compressedSize: Number(v.compressed_size ?? 0), fileCount: Number(v.file_count ?? 0) }
        ])
      )
    }))
  }
}

// --- proto3 reader for SophonPatchProto ---

function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let result = 0n
  let shift = 0n
  for (;;) {
    const b = buf[pos++]
    result |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) break
    shift += 7n
  }
  return [result, pos]
}

function fields(buf: Uint8Array): { field: number; wire: number; str?: string; num?: bigint; sub?: Uint8Array }[] {
  const out: { field: number; wire: number; str?: string; num?: bigint; sub?: Uint8Array }[] = []
  let pos = 0
  while (pos < buf.length) {
    const [tag, p1] = readVarint(buf, pos)
    pos = p1
    const field = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    if (wire === 2) {
      const [len, p2] = readVarint(buf, pos)
      const end = p2 + Number(len)
      out.push({ field, wire, sub: buf.subarray(p2, end) })
      pos = end
    } else if (wire === 0) {
      const [value, p2] = readVarint(buf, pos)
      out.push({ field, wire, num: value })
      pos = p2
    } else break
  }
  return out
}

const str = (b: Uint8Array): string => Buffer.from(b).toString('utf8')

function parsePatchChunk(buf: Uint8Array): PatchChunk {
  const chunk: PatchChunk = {
    patchName: '',
    patchFileSize: 0,
    patchFileMd5: '',
    patchOffset: 0,
    patchLength: 0,
    originalFileName: '',
    originalFileLength: 0,
    originalFileMd5: ''
  }
  for (const f of fields(buf)) {
    if (f.wire === 2 && f.sub) {
      if (f.field === 1) chunk.patchName = str(f.sub)
      else if (f.field === 5) chunk.patchFileMd5 = str(f.sub)
      else if (f.field === 8) chunk.originalFileName = str(f.sub)
      else if (f.field === 10) chunk.originalFileMd5 = str(f.sub)
    } else if (f.wire === 0 && f.num !== undefined) {
      if (f.field === 4) chunk.patchFileSize = Number(f.num)
      else if (f.field === 6) chunk.patchOffset = Number(f.num)
      else if (f.field === 7) chunk.patchLength = Number(f.num)
      else if (f.field === 9) chunk.originalFileLength = Number(f.num)
    }
  }
  return chunk
}

function parsePatchProto(buf: Uint8Array): PatchProto {
  const proto: PatchProto = { patchAssets: [], unusedAssets: [] }
  for (const f of fields(buf)) {
    if (f.wire !== 2 || !f.sub) continue
    if (f.field === 1) {
      const asset: PatchAsset = { assetName: '', infos: [] }
      for (const af of fields(f.sub)) {
        if (af.wire === 2 && af.sub) {
          if (af.field === 1) asset.assetName = str(af.sub)
          else if (af.field === 4) {
            const info = { versionTag: '', chunk: parsePatchChunk(new Uint8Array()) }
            for (const inf of fields(af.sub)) {
              if (inf.wire === 2 && inf.sub) {
                if (inf.field === 1) info.versionTag = str(inf.sub)
                else if (inf.field === 2) info.chunk = parsePatchChunk(inf.sub)
              }
            }
            asset.infos.push(info)
          }
        }
      }
      proto.patchAssets.push(asset)
    } else if (f.field === 2) {
      const unused: UnusedAsset = { versionTag: '', files: [] }
      for (const uf of fields(f.sub)) {
        if (uf.wire === 2 && uf.sub) {
          if (uf.field === 1) unused.versionTag = str(uf.sub)
          else if (uf.field === 2) {
            for (const inf of fields(uf.sub)) {
              if (inf.field === 1 && inf.wire === 2 && inf.sub) {
                for (const filef of fields(inf.sub)) {
                  if (filef.field === 1 && filef.wire === 2 && filef.sub) {
                    unused.files.push({ fileName: str(filef.sub) })
                  }
                }
              }
            }
          }
        }
      }
      proto.unusedAssets.push(unused)
    }
  }
  return proto
}

async function fileMatches(path: string, size: number, md5: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path)
    if (size && stat.size !== size) return false
    if (!md5) return true
    return (await md5File(path)) === md5
  } catch {
    return false
  }
}

async function writeChunks(
  asset: SophonAsset,
  chunkPrefix: string,
  compression: number,
  suffix: string,
  destPath: string,
  signal: AbortSignal | undefined,
  onBytes: (n: number) => void
): Promise<void> {
  await fs.mkdir(dirname(destPath), { recursive: true })
  const handle = await fs.open(destPath, 'w')
  try {
    for (let i = 0; i < asset.chunks.length; i += CONCURRENCY) {
      if (signal?.aborted) throw new Error('已取消')
      const batch = asset.chunks.slice(i, i + CONCURRENCY)
      const datas = await Promise.all(
        batch.map((c) => fetchChunk(chunkPrefix, c.name, signal, compression, suffix))
      )
      for (let j = 0; j < batch.length; j++) {
        await handle.write(datas[j], 0, datas[j].length, batch[j].offset)
        onBytes(datas[j].length)
      }
    }
  } finally {
    await handle.close()
  }
}

/**
 * Apply a block-level Sophon patch from `localVersion` to the latest version.
 * Files that don't match their expected original are re-downloaded in full.
 */
async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const current = index++
      if (current >= items.length) return
      await fn(items[current])
    }
  })
  await Promise.all(workers)
}

async function fileSizeMatches(path: string, size: number): Promise<boolean> {
  try {
    const stat = await fs.stat(path)
    return !size || stat.size === size
  } catch {
    return false
  }
}

/**
 * Apply a block-level Sophon patch from `localVersion` to the latest version.
 * Files that don't match their expected original are re-downloaded in full.
 */
export async function applySophonPatch(
  patchBuild: PatchBuild,
  mainBuild: SophonBuild,
  localVersion: string,
  originDir: string,
  destDir: string,
  hpatchzPath: string,
  onProgress: (downloaded: number, total: number) => void,
  signal?: AbortSignal,
  audioLanguages: string[] = [],
  ignoreFields: string[] = [],
  cacheDir?: string,
  cacheOnly = false,
  blacklist: string[] = [],
  applyDeletes = true
): Promise<string[]> {
  // Target assets (name → manifest entry) let every patched file be verified.
  const mainAssets = new Map<
    string,
    { asset: SophonAsset; chunkPrefix: string; compression: number; suffix: string }
  >()
  await runPool(mainBuild.categories, 8, async (category) => {
    const assets = await fetchManifest(category)
    for (const asset of assets) {
      mainAssets.set(asset.name, {
        asset,
        chunkPrefix: category.chunkUrlPrefix,
        compression: category.chunkCompression,
        suffix: category.chunkSuffix
      })
    }
  })

  const installedAudio = new Set(audioLanguages)
  const ignored = new Set(ignoreFields)
  const selected = (field: string): boolean =>
    !ignored.has(field) && !(isLanguageField(field) && !installedAudio.has(field))
  if (cacheDir) await fs.mkdir(cacheDir, { recursive: true })

  interface PatchTask {
    category: PatchCategory
    asset: PatchAsset
    chunk: PatchChunk
  }
  const tasks: PatchTask[] = []
  const deletes: string[] = []
  // Fetch the patch manifests concurrently and flatten every changed file into
  // one task list; applying them serially was the main bottleneck.
  await runPool(
    patchBuild.categories.filter(
      (category) => selected(category.matchingField) && !!category.versions[localVersion]
    ),
    8,
    async (category) => {
      const url = `${category.manifestUrlPrefix}/${category.manifestId}${category.manifestSuffix}`
      const res = await fetchRetry(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal })
      // A failed manifest fetch must fail the task: silently skipping a category
      // would mark an incomplete pre-download as finished.
      if (!res.ok) throw new Error(`获取补丁清单失败 HTTP ${res.status}`)
      const manifestBytes = new Uint8Array(await res.arrayBuffer())
      const proto = parsePatchProto(
        category.manifestCompression ? decompress(manifestBytes) : manifestBytes
      )
      for (const unused of proto.unusedAssets) {
        if (unused.versionTag !== localVersion) continue
        for (const file of unused.files) {
          deletes.push(file.fileName)
          if (applyDeletes) {
            try {
              await fs.rm(join(destDir, ...file.fileName.split('/')), { force: true })
            } catch {
              /* ignore */
            }
          }
        }
      }
      for (const asset of proto.patchAssets) {
        if (blacklist.includes(asset.assetName)) continue
        const info = asset.infos.find((i) => i.versionTag === localVersion)
        if (!info) continue // unchanged
        tasks.push({ category, asset, chunk: info.chunk })
      }
    }
  )

  let total = 0
  for (const task of tasks) {
    total += mainAssets.get(task.asset.assetName)?.asset.size ?? task.chunk.originalFileLength
  }
  let downloaded = 0
  onProgress(downloaded, total)

  // One download/verify per patch blob, shared by every asset it contains. The
  // blob itself is a concatenation of complete HDiff (`HDIF`) files.
  const blobs = new Map<string, Promise<void>>()
  const ensureBlob = (category: PatchCategory, chunk: PatchChunk): Promise<void> => {
    const name = chunk.patchName
    let promise = blobs.get(name)
    if (promise) return promise
    promise = (async () => {
      const path = join(cacheDir!, name)
      try {
        if ((await fs.stat(path)).size === chunk.patchFileSize) return
      } catch {
        /* missing */
      }
      const pr = await fetchRetry(
        `${category.diffUrlPrefix}/${name}${category.diffSuffix}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal }
      )
      if (!pr.ok) throw new Error(`下载补丁文件失败 HTTP ${pr.status}`)
      const data = await readBodyThrottled(pr)
      await fs.writeFile(path, data)
      if (chunk.patchFileMd5 && (await md5File(path)) !== chunk.patchFileMd5) {
        await fs.rm(path, { force: true }).catch(() => undefined)
        throw new Error(`补丁文件校验失败：${name}`)
      }
    })()
    blobs.set(name, promise)
    promise.catch(() => blobs.delete(name))
    return promise
  }

  await runPool(tasks, 6, async ({ category, asset, chunk }) => {
    if (signal?.aborted) throw new Error('已取消')
    const targetPath = join(destDir, ...asset.assetName.split('/'))
    const originalPath = join(
      originDir,
      ...(chunk.originalFileName || asset.assetName).split('/')
    )
    const targetAsset = mainAssets.get(asset.assetName)

    // Already staged (e.g. a resumed update): the size mismatch short-circuits
    // the hash for every ordinary old file, so this stays cheap.
    if (
      targetAsset &&
      (await fileMatches(targetPath, targetAsset.asset.size, targetAsset.asset.md5))
    ) {
      return
    }

    // The base only needs a cheap size check: `hpatchz` plus the output MD5
    // catch a wrong base, so we avoid a second full-file hash here.
    if (!(await fileSizeMatches(originalPath, chunk.originalFileLength))) {
      const entry = targetAsset
      if (!entry) throw new Error(`缺少目标清单：${asset.assetName}`)
      await writeChunks(
        entry.asset,
        entry.chunkPrefix,
        entry.compression,
        entry.suffix,
        targetPath,
        signal,
        (n) => {
          downloaded += n
          onProgress(downloaded, total)
        }
      )
      if (!(await fileMatches(targetPath, entry.asset.size, entry.asset.md5))) {
        throw new Error(`文件校验失败：${asset.assetName}`)
      }
      return
    }

    let raw: Buffer
    if (cacheDir) {
      await ensureBlob(category, chunk)
      const handle = await fs.open(join(cacheDir, chunk.patchName), 'r')
      try {
        raw = Buffer.alloc(chunk.patchLength)
        await handle.read(raw, 0, chunk.patchLength, chunk.patchOffset)
      } finally {
        await handle.close()
      }
    } else {
      const pr = await fetchRetry(
        `${category.diffUrlPrefix}/${chunk.patchName}${category.diffSuffix}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal }
      )
      if (!pr.ok) throw new Error(`下载补丁文件失败 HTTP ${pr.status}`)
      const blob = await readBodyThrottled(pr)
      raw = blob.subarray(chunk.patchOffset, chunk.patchOffset + chunk.patchLength)
    }

    // The slice is already a complete HDiff file (the blob is a concatenation of
    // `HDIF` files, with zstd inside the HDiff stream) — never zstd-decompress it.
    const diffTmp = `${targetPath}.hdiff.tmp`
    const outTmp = `${targetPath}.new.tmp`
    await fs.mkdir(dirname(targetPath), { recursive: true })
    await fs.writeFile(diffTmp, raw)
    try {
      await exec(hpatchzPath, ['-f', originalPath, diffTmp, outTmp], {
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024
      })
      await fs.rm(targetPath, { force: true })
      await fs.rename(outTmp, targetPath)
      // E27: verify the patched file against the target manifest; a mismatch
      // fails the update (no full-file fallback, like Starward).
      if (
        targetAsset &&
        !(await fileMatches(targetPath, targetAsset.asset.size, targetAsset.asset.md5))
      ) {
        throw new Error(`文件校验失败：${asset.assetName}`)
      }
    } catch (error) {
      throw new Error(`补丁应用失败：${asset.assetName}（${(error as Error).message}）`)
    } finally {
      await fs.rm(diffTmp, { force: true })
      await fs.rm(outTmp, { force: true })
    }
    downloaded += targetAsset?.asset.size ?? chunk.originalFileLength
    onProgress(downloaded, total)
  })

  // The ldiff cache is no longer needed once the files are patched.
  if (cacheDir && !cacheOnly) {
    await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => undefined)
  }
  return deletes
}

/**
 * Pre-download step (Starward's `GetPredownloadFiles`): enumerate every unique
 * patch blob referenced by the selected categories and make sure each one is in
 * `<install>/ldiff`, verified by size + MD5. Only then may the task be marked
 * complete. Nothing is applied to the game here.
 */
/**
 * Pre-download step (Starward's `GetPredownloadFiles`): enumerate every unique
 * patch blob referenced by the selected categories and make sure each one is in
 * `<install>/ldiff`, verified by size + MD5. Only then may the task be marked
 * complete. Nothing is applied to the game here.
 */
export async function preparePatchCache(
  patchBuild: PatchBuild,
  localVersion: string,
  installDir: string,
  audioLanguages: string[],
  ignoreFields: string[],
  onProgress: (downloaded: number, total: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const cacheDir = join(installDir, 'ldiff')
  await fs.mkdir(cacheDir, { recursive: true })
  const installedAudio = new Set(audioLanguages)
  const ignored = new Set(ignoreFields)
  const selected = (field: string): boolean =>
    !ignored.has(field) && !(isLanguageField(field) && !installedAudio.has(field))

  const blobs = new Map<string, { size: number; md5: string; category: PatchCategory }>()
  await runPool(
    patchBuild.categories.filter(
      (category) => selected(category.matchingField) && !!category.versions[localVersion]
    ),
    8,
    async (category) => {
      const url = `${category.manifestUrlPrefix}/${category.manifestId}${category.manifestSuffix}`
      const res = await fetchRetry(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal })
      if (!res.ok) throw new Error(`获取补丁清单失败 HTTP ${res.status}`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      const proto = parsePatchProto(category.manifestCompression ? decompress(bytes) : bytes)
      for (const asset of proto.patchAssets) {
        for (const info of asset.infos) {
          if (info.versionTag !== localVersion) continue
          const chunk = info.chunk
          if (!chunk.patchName || blobs.has(chunk.patchName)) continue
          blobs.set(chunk.patchName, {
            size: chunk.patchFileSize,
            md5: chunk.patchFileMd5,
            category
          })
        }
      }
    }
  )

  let total = 0
  for (const blob of blobs.values()) total += blob.size
  let downloaded = 0
  onProgress(downloaded, total)
  await runPool([...blobs.entries()], 6, async ([name, blob]) => {
    if (signal?.aborted) throw new Error('cancelled')
    const path = join(cacheDir, name)
    let present = false
    try {
      present = (await fs.stat(path)).size === blob.size
      if (present && blob.md5) present = (await md5File(path)) === blob.md5
    } catch {
      present = false
    }
    if (!present) {
      const pr = await fetchRetry(
        `${blob.category.diffUrlPrefix}/${name}${blob.category.diffSuffix}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal }
      )
      if (!pr.ok) throw new Error(`下载补丁文件失败 HTTP ${pr.status}`)
      const data = await readBodyThrottled(pr)
      await fs.writeFile(path, data)
      if (blob.md5 && (await md5File(path)) !== blob.md5) {
        await fs.rm(path, { force: true }).catch(() => undefined)
        throw new Error(`补丁文件校验失败：${name}`)
      }
      downloaded += data.length
    } else {
      downloaded += blob.size
    }
    onProgress(downloaded, total)
  })
}
