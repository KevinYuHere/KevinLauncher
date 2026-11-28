import { createReadStream, promises as fs } from 'fs'
import type { FileHandle } from 'fs/promises'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { createZstdDecompress } from 'zlib'
import { createHash } from 'crypto'
import { fields } from './sophonProto'
import { dirname } from 'path'
import { allowGameFileWrite, openWritableGameFile } from '../services/writableGameFile'
import { requireDiskSpace } from '../services/diskSpace'
import type { HardLinkService } from '../services/hardLinkService'
import { forEachResource, resourceProgress } from './hoyoSchedule'
import { cacheHoYoResource } from './hoyoResourceCache'
import type { RecordSophonCache } from './sophonCacheOwnership'
import { gamePath, requirePlainGamePath, retryHoYo } from './hoyoFiles'
import { temporaryGameFile } from './hoyoTemp'

import { md5File } from '../services/hash'
import { downloadGameBytes, streamGameBytes, downloadManifest, getHoYoMetadata, hoyoFetch } from './hoyoNetwork'

const CHUNK_API = 'https://downloader-api.mihoyo.com/downloader/sophon_chunk/api'


export class BuildNotFound extends Error {}

export interface SophonCategory {
  categoryId: string
  categoryName: string
  /** `game`, a numeric resource field, or an audio language (`zh-cn`, …). */
  matchingField: string
  manifestMd5?: string
  manifestSize?: number
  manifestId: string
  manifestUrlPrefix: string
  manifestCompression: number
  manifestSuffix: string
  chunkUrlPrefix: string
  chunkCompression: number
  chunkSuffix: string
  compressedSize: number
}

export interface SophonBuild {
  buildId: string
  tag: string
  categories: SophonCategory[]
}

export interface SophonChunk {
  name: string
  /** Uncompressed chunk MD5 — used to reuse unchanged chunks from the local file. */
  uncompressedMd5: string
  /** Compressed (on-the-wire) chunk MD5 — used to verify the cache. */
  compressedMd5: string
  offset: number
  size: number
  sizeDecompressed: number
}
export interface SophonAsset {
  directory?: boolean
  name: string
  size: number
  md5: string
  chunks: SophonChunk[]
}

export async function getSophonBuild(
  branch: {
    branch: string
    packageId: string
    password: string
  },
  tag?: string,
  signal?: AbortSignal
): Promise<SophonBuild> {
  const url =
    `${CHUNK_API}/getBuild?branch=${encodeURIComponent(branch.branch)}` +
    `&package_id=${encodeURIComponent(branch.packageId)}&password=${encodeURIComponent(branch.password)}` +
    (tag ? `&tag=${encodeURIComponent(tag)}` : '')
  return getHoYoMetadata(`GameSophonChunkBuild_${JSON.stringify([branch.packageId, branch.branch, tag ?? ''])}`,
    async token => parseSophonBuild(await hoyoFetch(url, { signal: token })), signal)
}

async function parseSophonBuild(res: Response): Promise<SophonBuild> {
  const json = (await res.json()) as {
    retcode: number
    message: string
    data?: {
      build_id: string
      tag: string
      manifests: {
        category_id: string
        category_name: string
        matching_field?: string
        manifest: { id: string; compressed_size: string; uncompressed_size?: string; checksum?: string }
        manifest_download: { url_prefix: string; compression?: number; url_suffix?: string }
        chunk_download: { url_prefix: string; compression?: number; url_suffix?: string }
        stats?: { compressed_size?: string }
      }[]
    }
  }
  if (typeof json.retcode === 'number' && json.retcode !== 0) throw new BuildNotFound(json.message || 'getBuild 失败')
  if (json.retcode !== 0 || !json.data) throw new Error(json.message || 'getBuild failed')
  return {
    buildId: json.data.build_id,
    tag: json.data.tag,
    categories: (json.data.manifests ?? []).map((m) => ({
      categoryId: m.category_id,
      categoryName: m.category_name,
      matchingField: m.matching_field ?? '',
      manifestId: m.manifest.id,
      manifestMd5: m.manifest.checksum,
      manifestSize: m.manifest.uncompressed_size === undefined ? undefined : Number(m.manifest.uncompressed_size),
      manifestUrlPrefix: m.manifest_download.url_prefix,
      manifestCompression: m.manifest_download.compression ?? 1,
      manifestSuffix: m.manifest_download.url_suffix ?? '',
      chunkUrlPrefix: m.chunk_download.url_prefix,
      chunkCompression: m.chunk_download.compression ?? 1,
      chunkSuffix: m.chunk_download.url_suffix ?? '',
      compressedSize: Number(m.stats?.compressed_size ?? 0)
    }))
  }
}

function parseChunk(input: Uint8Array): SophonChunk {
  const chunk: SophonChunk = { name: '', uncompressedMd5: '', compressedMd5: '', size: 0, sizeDecompressed: 0, offset: 0 }
  for (const { field, sub, num } of fields(input)) {
    if (sub) {
      const value = Buffer.from(sub).toString('utf8')
      if (field === 1) chunk.name = value
      if (field === 2) chunk.uncompressedMd5 = value
      if (field === 7) chunk.compressedMd5 = value
    } else if (num !== undefined) {
      if (field === 3) chunk.offset = Number(num)
      if (field === 4) chunk.size = Number(num)
      if (field === 5) chunk.sizeDecompressed = Number(num)
    }
  }
  return chunk
}

function parseAsset(input: Uint8Array): SophonAsset {
  const asset: SophonAsset = { name: '', size: 0, md5: '', chunks: [] }
  for (const { field, sub, num } of fields(input)) {
    if (sub) {
      if (field === 1) asset.name = Buffer.from(sub).toString('utf8')
      if (field === 2) asset.chunks.push(parseChunk(sub))
      if (field === 5) asset.md5 = Buffer.from(sub).toString('utf8')
    } else if (num !== undefined) {
      if (field === 3) asset.directory = num === 0x40n
      if (field === 4) asset.size = Number(num)
    }
  }
  return asset
}

function parseManifest(input: Uint8Array): SophonAsset[] {
  const assets: SophonAsset[] = []
  for (const { field, sub } of fields(input)) if (field === 1 && sub) assets.push(parseAsset(sub))
  return assets
}

export async function fetchManifest(category: SophonCategory, signal?: AbortSignal): Promise<SophonAsset[]> {
  return retryHoYo(async () => {
    const plain = await downloadManifest({
      id: category.manifestId,
      url: `${category.manifestUrlPrefix}/${category.manifestId}${category.manifestSuffix}`,
      compressed: category.manifestCompression !== 0,
      uncompressedSize: category.manifestSize,
      md5: category.manifestMd5
    }, signal)
    return parseManifest(plain)
  }, signal)
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

export interface SophonProgress {
  downloaded: number
  total: number
  currentFile: string
}

/** Starward filters language-like fields (e.g. `zh-cn`, `mini-zh-cn`). */
export function isLanguageField(field: string): boolean {
  return (field.length === 5 || field.length === 10) && field.includes('-')
}

/** Resource categories the game config marks as deleted (`is_delete`). */
export interface SophonDownloadOptions {
  links?: HardLinkService
  finished?: Set<string>
  prepared?: PreparedChunkFiles
  work?: string
  repair?: boolean
  /** Skip files that already match in `originDir` (delta: never stage unchanged). */
  skipUnchanged?: boolean
  /** Installed game dir: delta comparison + partial-file resume source. */
  originDir?: string
  /** Installed voice languages (`zh-cn` / `en-us` / `ja-jp` / `ko-kr`). */
  audioLanguages?: string[]
  /** Matching fields to ignore (`res_category_launcher` entries with is_delete). */
  ignoreFields?: string[]
  /** The installed version's build — lets unchanged chunks be copied locally. */
  localBuild?: SophonBuild
  /** Starward raw-chunk cache (`<install>/chunk`); enables resume across runs. */
  cacheDir?: string
  /** Pre-download: only fill the chunk cache, do not assemble the game files. */
  cacheOnly?: boolean
  recordCache?: RecordSophonCache
  categoriesSelected?: boolean
  /** Files listed in the game's resource blacklist — never (re)downloaded. */
  blacklist?: string[]
}

/** Raw (still compressed) chunk bytes — the cache stores these as-is. */
export async function fetchChunkRaw(
  prefix: string,
  name: string,
  signal?: AbortSignal,
  suffix = ''
): Promise<Buffer> {
  return downloadGameBytes(`${prefix}/${name}${suffix}`, signal)
}

function md5Buffer(buffer: Buffer): string {
  return createHash('md5').update(buffer).digest('hex')
}

async function writeAt(file: FileHandle, data: Uint8Array, position: number): Promise<void> {
  let offset = 0
  while (offset < data.length) {
    const { bytesWritten } = await file.write(data, offset, data.length - offset, position + offset)
    if (!bytesWritten) throw new Error('无法写入游戏分块')
    offset += bytesWritten
  }
}

async function writeChunk(category: SophonCategory, chunk: SophonChunk, cacheDir: string | undefined, file: FileHandle,
  signal: AbortSignal, progress: (bytes: number) => void): Promise<void> {
  const path = cacheDir && gamePath(cacheDir, chunk.name)
  const cached = path && await fileMatches(path, chunk.size, chunk.compressedMd5)
  const url = category.chunkUrlPrefix + '/' + chunk.name + category.chunkSuffix
  const source = cached ? createReadStream(path) : Readable.from(streamGameBytes(url, signal, progress), { objectMode: false })
  let position = chunk.offset
  async function save(data: AsyncIterable<Uint8Array>): Promise<void> {
    for await (const bytes of data) {
      signal.throwIfAborted()
      await writeAt(file, bytes, position)
      position += bytes.length
    }
  }
  if (category.chunkCompression) await pipeline(source, createZstdDecompress(), save, { signal })
  else await pipeline(source, save, { signal })
}
export async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    for (;;) {
      const i = index++
      if (i >= items.length) return
      await fn(items[i])
    }
  })
  const results = await Promise.allSettled(workers)
  for (const result of results) if (result.status === 'rejected') throw result.reason
}
export interface PreparedChunkFiles {
  files: { category: SophonCategory; asset: SophonAsset }[]
  oldChunks: Map<string, MapEntry>
  oldFiles: Map<string, string>
}

interface MapEntry { file: string; offset: number }

export async function prepareChunkFiles(build: SophonBuild, options: SophonDownloadOptions, signal: AbortSignal): Promise<PreparedChunkFiles> {
  const { audioLanguages = [], ignoreFields = [], localBuild, blacklist = [] } = options
  const installedAudio = new Set(audioLanguages)
  const ignored = new Set(ignoreFields)
  const wanted = (field: string): boolean =>
    !ignored.has(field) && !(isLanguageField(field) && !installedAudio.has(field))

  const allowed = (category: SophonCategory): boolean => options.categoriesSelected === true || wanted(category.matchingField)
  const oldChunks = new Map<string, { file: string; offset: number }>()
  const oldFiles = new Map<string, string>()
  if (localBuild) {
    await forEachResource(localBuild.categories.filter(allowed), signal, async (category, token) => {
      for (const asset of await fetchManifest(category, token)) {
        if (blacklist.includes(asset.name)) continue
        if (!oldFiles.has(asset.name)) oldFiles.set(asset.name, asset.md5)
        for (const chunk of asset.chunks) {
          if (!oldChunks.has(chunk.name)) oldChunks.set(chunk.name, { file: asset.name, offset: chunk.offset })
        }
      }
    }, false)
  }

  const files: { category: SophonCategory; asset: SophonAsset }[] = []
  await forEachResource(build.categories.filter(allowed), signal, async (category, token) => {
    for (const asset of await fetchManifest(category, token)) {
      if (!blacklist.includes(asset.name)) files.push({ category, asset })
    }
  }, false)
  return { oldChunks, oldFiles, files }
}

export async function downloadSophonBuild(build: SophonBuild, destDir: string, onProgress: (progress: SophonProgress) => void,
  signal: AbortSignal = new AbortController().signal, options: SophonDownloadOptions = {}): Promise<void> {
  const { cacheDir, cacheOnly, originDir, links, finished = new Set<string>(), localBuild } = options
  const { files, oldFiles, oldChunks } = options.prepared ?? await prepareChunkFiles(build, options, signal)
  const needed = new Map<string, { category: SophonCategory; chunk: SophonChunk }>()
  const report = (done: number, total: number, name: string) => onProgress({ downloaded: done, total, currentFile: name })
  if (cacheOnly) {
    if (!cacheDir) throw new Error('缺少预下载缓存目录')
    for (const { category, asset } of files) for (const chunk of asset.chunks) {
      if (!oldChunks.has(chunk.name) && !needed.has(chunk.name)) needed.set(chunk.name, { category, chunk })
    }
    const total = [...needed.values()].reduce((sum, x) => sum + x.chunk.size, 0)
    if (options.work) {
      let remaining = 0
      for (const { chunk } of needed.values()) {
        if (!await fileMatches(gamePath(cacheDir, chunk.name), chunk.size, chunk.compressedMd5)) remaining += chunk.size
      }
      await requireDiskSpace([{ path: cacheDir, bytes: remaining }])
    }
    const count = resourceProgress(total, report)
    await forEachResource([...needed.values()], signal, async ({ category, chunk }, token) => {
      if (!finished.has(chunk.name)) {
        const path = gamePath(cacheDir, chunk.name)
        const published = await cacheHoYoResource(options.work ? destDir : cacheDir, path, category.chunkUrlPrefix + '/' + chunk.name + category.chunkSuffix,
          chunk.size, chunk.compressedMd5, links, token, n => count(chunk.name, n), options.work)
        await options.recordCache?.(path, published)
        finished.add(chunk.name)
      }
      count(chunk.name, chunk.size)
    })
    return
  }

  const work = files.filter(({ asset }) => !asset.directory && oldFiles.get(asset.name)?.toLowerCase() !== asset.md5.toLowerCase())
  const netSize = (asset: SophonAsset) => asset.chunks.reduce((sum, chunk) => sum + (oldChunks.has(chunk.name) ? 0 : chunk.size), 0)
  const total = work.reduce((sum, item) => sum + netSize(item.asset), 0)
  const present = async (asset: SophonAsset, path: string, token: AbortSignal): Promise<boolean> => {
    if (finished.has(asset.name)) return true
    if (links) {
      await requirePlainGamePath(destDir, path)
      if (await links.tryLink(path, asset.size, asset.md5, token)) { finished.add(asset.name); return true }
    }
    if ((options.skipUnchanged || options.repair) && await fileMatches(path, asset.size, asset.md5)) {
      void links?.insert(path, asset.size, asset.md5)
      finished.add(asset.name)
      return true
    }
    return false
  }
  if (options.repair) await forEachResource(work, signal, async ({ asset }, token) => {
    await present(asset, gamePath(destDir, asset.name), token)
  })
  const tempFor = (file: string): string => options.work
    ? temporaryGameFile(destDir, options.work, 'chunks', file)
    : file + '.tmp'
  if (options.work) {
    let required = 0
    for (const { asset } of work) {
      signal.throwIfAborted()
      const path = gamePath(destDir, asset.name)
      if (finished.has(asset.name) || await fileMatches(path, asset.size, asset.md5)) continue
      const partial = (await fs.stat(tempFor(path)).catch(() => undefined))?.size ?? 0
      required += Math.max(0, asset.size - Math.min(asset.size, partial))
    }
    await requireDiskSpace([{ path: destDir, bytes: required }])
  }
  const count = resourceProgress(total, report)
  report(0, total, '')
  await forEachResource(work, signal, async ({ category, asset }, token) => {
    const path = gamePath(destDir, asset.name)
    if (!await present(asset, path, token)) {
      const tmp = tempFor(path)
      await requirePlainGamePath(destDir, path)
      await requirePlainGamePath(destDir, tmp)
      await fs.mkdir(dirname(path), { recursive: true })
      await fs.mkdir(dirname(tmp), { recursive: true })
      const handle = await openWritableGameFile(tmp)
      let received = 0
      try {
        for (const chunk of asset.chunks) {
          token.throwIfAborted()
          const budget = chunk.size
          if (await verifiedSlice(handle, chunk.offset, chunk)) {
            received += budget
            count(asset.name, received)
            continue
          }
          let data: Buffer | undefined
          const previous = oldChunks.get(chunk.name)
          if (previous && originDir) {
            const original = await fs.open(gamePath(originDir, previous.file), 'r').catch(error => {
              if (error.code === 'ENOENT') return null
              throw error
            })
            if (original) {
              try { data = await verifiedSlice(original, previous.offset, chunk) } finally { await original.close() }
            }
          }
          if (data) await writeAt(handle, data, chunk.offset)
          else await writeChunk(category, chunk, cacheDir, handle, token, n => count(asset.name, received + Math.min(budget, n)))
          received += budget
          count(asset.name, received)
        }
      } catch (error) {
        count(asset.name, 0)
        throw error
      } finally { await handle.close() }
      if (!await fileMatches(tmp, asset.size, asset.md5)) {
        await fs.rm(tmp, { force: true })
        count(asset.name, 0)
        throw new Error('文件校验失败：' + asset.name)
      }
      await allowGameFileWrite(path)
      await fs.rename(tmp, path)
      void links?.insert(path, asset.size, asset.md5)
      finished.add(asset.name)
    } else count(asset.name, netSize(asset))
  })
  if (localBuild) {
    const currentFiles = new Set(files.map(({ asset }) => asset.name))
    for (const name of oldFiles.keys()) {
      if (currentFiles.has(name)) continue
      const path = gamePath(destDir, name)
      try { await requirePlainGamePath(destDir, path); await allowGameFileWrite(path); await fs.unlink(path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue
      }
      links?.deleteFile(path)
    }
  }
}

async function verifiedSlice(handle: Awaited<ReturnType<typeof fs.open>>, offset: number, chunk: SophonChunk): Promise<Buffer | undefined> {
  if (!chunk.uncompressedMd5 || (await handle.stat()).size < offset + chunk.sizeDecompressed) return undefined
  const data = Buffer.alloc(chunk.sizeDecompressed)
  const { bytesRead } = await handle.read(data, 0, data.length, offset)
  return bytesRead === data.length && md5Buffer(data) === chunk.uncompressedMd5.toLowerCase() ? data : undefined
}
