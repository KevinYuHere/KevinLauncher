import { promises as fs, constants, createReadStream, createWriteStream } from 'fs'
import { pipeline } from 'stream/promises'
import { gamePath, requirePlainGamePath, retryHoYo } from './hoyoFiles'
import { join, dirname } from 'path'
import { fields } from './sophonProto'
import type { HardLinkService } from '../services/hardLinkService'
import { forEachResource, resourceProgress } from './hoyoSchedule'
import { cacheHoYoResource } from './hoyoResourceCache'
import type { RecordSophonCache } from './sophonCacheOwnership'
import { md5File } from '../services/hash'
import { allowGameFileWrite } from '../services/writableGameFile'
import { requireDiskSpace } from '../services/diskSpace'
import { runTaskProcess } from '../services/taskProcess'
import { temporaryGameFile } from './hoyoTemp'
import { downloadGameFile, downloadManifest, getHoYoMetadata, hoyoFetch } from './hoyoNetwork'

const CHUNK_API = 'https://downloader-api.mihoyo.com/downloader/sophon_chunk/api'

export class PatchBuildNotFound extends Error {}

export interface PatchCategory {
  categoryId: string
  matchingField: string
  manifestMd5?: string
  manifestSize?: number
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
  size: number
  md5: string
  infos: { versionTag: string; chunk: PatchChunk }[]
}
interface UnusedAsset {
  versionTag: string
  files: { fileName: string }[]
}
interface PatchProto {
  mode: number
  patchAssets: PatchAsset[]
  unusedAssets: UnusedAsset[]
}

export async function getPatchBuild(branch: {
  branch: string
  packageId: string
  password: string
}, signal?: AbortSignal): Promise<PatchBuild> {
  const url =
    `${CHUNK_API}/getPatchBuild?branch=${encodeURIComponent(branch.branch)}` +
    `&package_id=${encodeURIComponent(branch.packageId)}&password=${encodeURIComponent(branch.password)}`
  return getHoYoMetadata(`GameSophonPatchBuild_${JSON.stringify([branch.packageId, branch.branch])}`,
    async token => parsePatchBuild(await hoyoFetch(url, { signal: token, method: 'POST' })), signal)
}

async function parsePatchBuild(res: Response): Promise<PatchBuild> {
  const json = (await res.json()) as {
    retcode: number
    message: string
    data?: {
      patch_id: string
      tag: string
      manifests: {
        category_id: string
        matching_field?: string
        manifest: { id: string; uncompressed_size?: string; checksum?: string }
        manifest_download: { url_prefix: string; compression?: number; url_suffix?: string }
        diff_download: { url_prefix: string; compression?: number; url_suffix?: string }
        stats?: Record<string, { compressed_size?: string; file_count?: string }>
      }[]
    }
  }
  if (json.retcode === -202 || (json.retcode === 0 && !json.data)) throw new PatchBuildNotFound(json.message || 'patch build not found')
  if (json.retcode !== 0 || !json.data) throw new Error(json.message || 'getPatchBuild 失败')
  return {
    patchId: json.data.patch_id,
    tag: json.data.tag,
    categories: (json.data.manifests ?? []).map((m) => ({
      categoryId: m.category_id,
      matchingField: m.matching_field ?? '',
      manifestId: m.manifest.id,
      manifestMd5: m.manifest.checksum,
      manifestSize: m.manifest.uncompressed_size === undefined ? undefined : Number(m.manifest.uncompressed_size),
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
  const proto: PatchProto = { mode: 0, patchAssets: [], unusedAssets: [] }
  for (const f of fields(buf)) {
    if (f.field === 3 && f.wire === 0) proto.mode = Number(f.num)
    if (f.wire !== 2 || !f.sub) continue
    if (f.field === 1) {
      const asset: PatchAsset = { assetName: '', size: 0, md5: '', infos: [] }
      for (const af of fields(f.sub)) {
        if (af.field === 2 && af.wire === 0) asset.size = Number(af.num)
        if (af.wire === 2 && af.sub) {
          if (af.field === 1) asset.assetName = str(af.sub)
          else if (af.field === 3) asset.md5 = str(af.sub)
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
    if (stat.size !== size) return false
    if (!md5) return true
    return (await md5File(path)) === md5.toLowerCase()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}



interface PatchTask { category: PatchCategory; asset: PatchAsset; chunk: PatchChunk; mode: number }

export async function collectPatchFiles(build: PatchBuild, version: string, blacklist: string[], signal: AbortSignal) {
  const tasks: PatchTask[] = []
  const deletes: string[] = []
  await forEachResource(build.categories, signal, async (category, token) => {
    const manifest = await retryHoYo(async () => {
      const plain = await downloadManifest({
        id: category.manifestId,
        url: category.manifestUrlPrefix + '/' + category.manifestId + category.manifestSuffix,
        compressed: category.manifestCompression !== 0,
        uncompressedSize: category.manifestSize,
        md5: category.manifestMd5
      }, token)
      return parsePatchProto(plain)
    }, token)
    for (const asset of manifest.patchAssets) {
      const info = asset.infos.find(item => item.versionTag === version)
      if (info && !blacklist.includes(asset.assetName)) tasks.push({ category, asset, chunk: info.chunk, mode: manifest.mode })
    }
    const removed = manifest.unusedAssets.find(item => item.versionTag === version)
    for (const file of removed?.files ?? []) deletes.push(file.fileName)
  }, false)
  return { tasks, deletes }
}

async function patchSlice(root: string, dir: string, task: PatchTask, signal: AbortSignal, onProgress: (bytes: number) => void, work?: string): Promise<string> {
  const { chunk, category } = task
  const blob = gamePath(dir, chunk.patchName)
  const previousSlice = blob + '_' + chunk.patchOffset
  const slice = work ? temporaryGameFile(root, work, 'slices', previousSlice) : previousSlice
  const end = chunk.patchOffset + chunk.patchLength - 1
  await requirePlainGamePath(root, blob)
  await requirePlainGamePath(root, slice)
  await fs.mkdir(dirname(slice), { recursive: true })
  if (await fileMatches(blob, chunk.patchFileSize, chunk.patchFileMd5)) {
    await fs.rm(slice, { force: true })
    if (chunk.patchLength === 0) await fs.writeFile(slice, '')
    else await pipeline(createReadStream(blob, { start: chunk.patchOffset, end }), createWriteStream(slice), { signal })
    return slice
  }
  if (work) {
    await requirePlainGamePath(root, previousSlice)
    const previousSize = await fs.stat(previousSlice).then(stat => stat.isFile() ? stat.size : -1, () => -1)
    if (previousSize > 0 && previousSize <= chunk.patchLength) {
      await fs.copyFile(previousSlice, slice, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST' && error.code !== 'ENOENT') throw error
      })
    }
  }
  const url = category.diffUrlPrefix + '/' + chunk.patchName + category.diffSuffix
  await downloadGameFile({ url, path: slice, size: chunk.patchLength, offset: chunk.patchOffset, signal, onProgress })
  return slice
}

export async function runSophonPatch(build: PatchBuild, version: string, dir: string, predownload: boolean,
  hpatchz: string, blacklist: string[], progress: (done: number, total: number) => void, signal: AbortSignal,
  links?: HardLinkService, prepared?: Awaited<ReturnType<typeof collectPatchFiles>>, finished = new Set<string>(),
  work?: string, recordCache?: RecordSophonCache
): Promise<void> {
  const { tasks, deletes } = prepared ?? await collectPatchFiles(build, version, blacklist, signal)
  const cache = join(dir, 'ldiff')

  if (predownload) {
    const unique = new Map<string, PatchTask>()
    for (const task of tasks) if (!unique.has(task.chunk.patchName)) unique.set(task.chunk.patchName, task)
    const total = [...unique.values()].reduce((sum, t) => sum + t.chunk.patchFileSize, 0)
    if (work) {
      let required = 0
      for (const { chunk } of unique.values()) {
        if (!await fileMatches(gamePath(cache, chunk.patchName), chunk.patchFileSize, chunk.patchFileMd5)) {
          required += chunk.patchFileSize
        }
      }
      await requireDiskSpace([{ path: cache, bytes: required }])
    }
    const report = resourceProgress(total, progress)
    await forEachResource([...unique.values()], signal, async ({ category, chunk }, token) => {
      const count = (n: number) => report(chunk.patchName, n)
      if (!finished.has(chunk.patchName)) {
        const path = gamePath(cache, chunk.patchName)
        const published = await cacheHoYoResource(dir, path, category.diffUrlPrefix + '/' + chunk.patchName + category.diffSuffix,
          chunk.patchFileSize, chunk.patchFileMd5, links, token, count, work)
        await recordCache?.(path, published)
        finished.add(chunk.patchName)
      }
      count(chunk.patchFileSize)
    })
    return
  }
  const total = tasks.reduce((sum, task) => sum + task.chunk.patchLength, 0)
  if (work) {
    let missing = 0
    let patchBytes = 0
    for (const { asset, chunk } of tasks) {
      signal.throwIfAborted()
      if (finished.has(asset.assetName) || await fileMatches(gamePath(dir, asset.assetName), asset.size, asset.md5)) continue
      missing += asset.size
      patchBytes += chunk.patchLength
    }
    await requireDiskSpace([{ path: dir, bytes: missing }, { path: cache, bytes: patchBytes }])
  }
  const count = resourceProgress(total, progress)
  await forEachResource(tasks, signal, async (task, token) => {
    const { asset, chunk } = task
    const target = gamePath(dir, asset.assetName)
    const source = chunk.originalFileName ? gamePath(dir, chunk.originalFileName) : null
    const removeSource = async () => {
      if (source) {
        await allowGameFileWrite(source)
        await fs.rm(source, { force: true })
        links?.deleteFile(source)
      }
    }
    if (!finished.has(asset.assetName)) {
      await requirePlainGamePath(dir, target)
      if (source) await requirePlainGamePath(dir, source)
      const linked = links && await links.tryLink(target, asset.size, asset.md5, token)
      if (linked) {
        if (source && target.toLowerCase() !== source.toLowerCase()) await removeSource()
      } else if (await fileMatches(target, asset.size, asset.md5)) {
        if (source && target.toLowerCase() !== source.toLowerCase()) await removeSource()
        void links?.insert(target, asset.size, asset.md5)
      } else if (!source || await fileMatches(source, chunk.originalFileLength, chunk.originalFileMd5)) {
        const slice = await retryHoYo(() => patchSlice(dir, cache, task, token, n => count(asset.assetName, n), work), token)
        const temp = work ? temporaryGameFile(dir, work, 'patches', target) : target + '.tmp'
        await requirePlainGamePath(dir, temp)
        await fs.mkdir(dirname(target), { recursive: true })
        await fs.mkdir(dirname(temp), { recursive: true })
        try {
          await fs.rm(temp, { force: true })
          if (!source && (task.mode === 0 || task.mode === 1)) await fs.copyFile(slice, temp)
          else await runTaskProcess(hpatchz, ['-f', source ?? '', slice, temp], { signal: token })
          if (await fileMatches(temp, asset.size, asset.md5)) {
            await allowGameFileWrite(target)
            await fs.rename(temp, target)
            if (source && target.toLowerCase() !== source.toLowerCase()) await removeSource()
            void links?.insert(target, asset.size, asset.md5)
          }
        } finally { await fs.rm(temp, { force: true }) }
      }
      finished.add(asset.assetName)
    }
    count(asset.assetName, chunk.patchLength)
  })
  for (const name of deletes) {
    const path = gamePath(dir, name)
    await requirePlainGamePath(dir, path)
    await allowGameFileWrite(path)
    await fs.rm(path, { force: true })
    links?.deleteFile(path)
  }
}
