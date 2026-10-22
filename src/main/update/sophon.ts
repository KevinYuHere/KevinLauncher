import { promises as fs } from 'fs'
import { createHash } from 'crypto'
import { join, dirname } from 'path'
import { decompress } from 'fzstd'
import { md5File } from '../services/hash'
import { readBodyThrottled } from '../services/rateLimit'

const CHUNK_API = 'https://downloader-api.mihoyo.com/downloader/sophon_chunk/api'
const CONCURRENCY = 16

export class BuildNotFound extends Error {}

export interface SophonCategory {
  categoryId: string
  categoryName: string
  /** `game`, a numeric resource field, or an audio language (`zh-cn`, …). */
  matchingField: string
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
  tag = ''
): Promise<SophonBuild> {
  const url =
    `${CHUNK_API}/getBuild?branch=${encodeURIComponent(branch.branch)}` +
    `&package_id=${encodeURIComponent(branch.packageId)}&password=${encodeURIComponent(branch.password)}` +
    (tag ? `&tag=${encodeURIComponent(tag)}` : '')
  const res = await fetchRetry(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
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
        manifest: { id: string; compressed_size: string }
        manifest_download: { url_prefix: string; compression?: number; url_suffix?: string }
        chunk_download: { url_prefix: string; compression?: number; url_suffix?: string }
        stats?: { compressed_size?: string }
      }[]
    }
  }
  if (json.retcode === -202) throw new BuildNotFound(json.message || 'build not found')
  if (json.retcode !== 0 || !json.data) throw new Error(json.message || 'getBuild failed')
  return {
    buildId: json.data.build_id,
    tag: json.data.tag,
    categories: (json.data.manifests ?? []).map((m) => ({
      categoryId: m.category_id,
      categoryName: m.category_name,
      matchingField: m.matching_field ?? '',
      manifestId: m.manifest.id,
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

// --- minimal proto3 reader for SophonManifestProto ---

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

function parseChunk(buf: Uint8Array): SophonChunk {
  const chunk: SophonChunk = {
    name: '',
    uncompressedMd5: '',
    compressedMd5: '',
    offset: 0,
    size: 0,
    sizeDecompressed: 0
  }
  let pos = 0
  while (pos < buf.length) {
    const [tag, p1] = readVarint(buf, pos)
    pos = p1
    const field = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    if (wire === 2) {
      const [len, p2] = readVarint(buf, pos)
      const end = p2 + Number(len)
      if (field === 1) chunk.name = Buffer.from(buf.subarray(p2, end)).toString('utf8')
      else if (field === 2) chunk.uncompressedMd5 = Buffer.from(buf.subarray(p2, end)).toString('utf8')
      else if (field === 7) chunk.compressedMd5 = Buffer.from(buf.subarray(p2, end)).toString('utf8')
      pos = end
    } else if (wire === 0) {
      const [value, p2] = readVarint(buf, pos)
      pos = p2
      if (field === 3) chunk.offset = Number(value)
      else if (field === 4) chunk.size = Number(value)
      else if (field === 5) chunk.sizeDecompressed = Number(value)
    } else break
  }
  return chunk
}

function parseAsset(buf: Uint8Array): SophonAsset {
  const asset: SophonAsset = { name: '', size: 0, md5: '', chunks: [] }
  let pos = 0
  while (pos < buf.length) {
    const [tag, p1] = readVarint(buf, pos)
    pos = p1
    const field = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    if (wire === 2) {
      const [len, p2] = readVarint(buf, pos)
      const end = p2 + Number(len)
      if (field === 1) asset.name = Buffer.from(buf.subarray(p2, end)).toString('utf8')
      else if (field === 2) asset.chunks.push(parseChunk(buf.subarray(p2, end)))
      else if (field === 5) asset.md5 = Buffer.from(buf.subarray(p2, end)).toString('utf8')
      pos = end
    } else if (wire === 0) {
      const [value, p2] = readVarint(buf, pos)
      pos = p2
      if (field === 4) asset.size = Number(value)
    } else break
  }
  return asset
}

function parseManifest(buf: Uint8Array): SophonAsset[] {
  const assets: SophonAsset[] = []
  let pos = 0
  while (pos < buf.length) {
    const [tag, p1] = readVarint(buf, pos)
    pos = p1
    const field = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    if (wire === 2) {
      const [len, p2] = readVarint(buf, pos)
      const end = p2 + Number(len)
      if (field === 1) assets.push(parseAsset(buf.subarray(p2, end)))
      pos = end
    } else if (wire === 0) {
      const [, p2] = readVarint(buf, pos)
      pos = p2
    } else break
  }
  return assets
}

/** Fetch with a small exponential backoff (Starward retries transient failures). */
export async function fetchRetry(url: string, init?: RequestInit, attempts = 6): Promise<Response> {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init)
    } catch (error) {
      if (init?.signal?.aborted) throw error
      last = error
      // Starward Polly: MaxRetryAttempts = 5, linear backoff (2s, 4s, 6s, 8s, 10s).
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 2000 * (i + 1)))
    }
  }
  throw last
}
export async function fetchManifest(category: SophonCategory): Promise<SophonAsset[]> {
  const url = `${category.manifestUrlPrefix}/${category.manifestId}${category.manifestSuffix}`
  const res = await fetchRetry(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`download manifest failed HTTP ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  return parseManifest(category.manifestCompression ? decompress(bytes) : bytes)
}

export async function fetchChunk(
  prefix: string,
  name: string,
  signal?: AbortSignal,
  compression = 1,
  suffix = ''
): Promise<Buffer> {
  const res = await fetchRetry(`${prefix}/${name}${suffix}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal
  })
  if (!res.ok) throw new Error(`download chunk failed HTTP ${res.status}`)
  const bytes = new Uint8Array(await readBodyThrottled(res))
  return Buffer.from(compression ? decompress(bytes) : bytes)
}

async function fileMatches(path: string, size: number, md5: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path)
    if (stat.size !== size) return false
    if (!md5) return true
    return (await md5File(path)) === md5
  } catch {
    return false
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
  const res = await fetchRetry(`${prefix}/${name}${suffix}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal
  })
  if (!res.ok) throw new Error(`download chunk failed HTTP ${res.status}`)
  return await readBodyThrottled(res)
}

/** Reuse a cached chunk when present (+size match), else fetch and cache it. */
function md5Buffer(buffer: Buffer): string {
  return createHash('md5').update(buffer).digest('hex')
}

async function chunkFromCache(
  category: SophonCategory,
  chunk: SophonChunk,
  cacheDir: string | undefined,
  signal?: AbortSignal
): Promise<Buffer> {
  const path = cacheDir ? join(cacheDir, chunk.name) : null
  if (path) {
    try {
      const raw = await fs.readFile(path)
      // Verify both size and compressed MD5 (Starward's `CheckFileMD5Async`).
      if (
        raw.length === chunk.size &&
        (!chunk.compressedMd5 || md5Buffer(raw) === chunk.compressedMd5)
      ) {
        return Buffer.from(decompress(raw))
      }
      await fs.rm(path, { force: true })
    } catch {
      /* not cached yet */
    }
  }
  const raw = await fetchChunkRaw(category.chunkUrlPrefix, chunk.name, signal, category.chunkSuffix)
  if (chunk.compressedMd5 && md5Buffer(raw) !== chunk.compressedMd5) {
    throw new Error(`分块校验失败：${chunk.name}`)
  }
  if (path) {
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, raw)
  }
  return Buffer.from(decompress(raw))
}

/**
 * Download and assemble a Sophon build into `destDir` (Starward semantics):
 *
 * - only the `game`/resource manifests plus the **installed voice languages** are
 *   used (pre-download size therefore differs per player);
 * - when `originDir` is given, files that already match there are skipped, so a
 *   pre-download only stages the delta instead of the whole game;
 * - partially written files resume at chunk boundaries instead of restarting.
 */
async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    for (;;) {
      const i = index++
      if (i >= items.length) return
      await fn(items[i])
    }
  })
  await Promise.all(workers)
}
export async function downloadSophonBuild(
  build: SophonBuild,
  destDir: string,
  onProgress: (progress: SophonProgress) => void,
  signal?: AbortSignal,
  options: SophonDownloadOptions = {}
): Promise<void> {
  const {
    skipUnchanged = false,
    originDir,
    audioLanguages = [],
    ignoreFields = [],
    localBuild,
    cacheDir,
    cacheOnly = false,
    blacklist = []
  } = options
  const installedAudio = new Set(audioLanguages)
  const ignored = new Set(ignoreFields)
  const wanted = (field: string): boolean =>
    !ignored.has(field) && !(isLanguageField(field) && !installedAudio.has(field))

  // Target manifests, per selected category (fetched concurrently: sequential
  // fetches of ~120 categories looked like a stuck 0% progress bar).
  const targetCats: { category: SophonCategory; assets: SophonAsset[] }[] = []
  await runPool(
    build.categories.filter((category) => wanted(category.matchingField)),
    8,
    async (category) => {
      targetCats.push({ category, assets: await fetchManifest(category) })
    }
  )

  // Installed version manifests → `file → (uncompressedMd5 → {offset, size})`.
  const localChunks = new Map<string, Map<string, { offset: number; size: number }>>()
  if (localBuild && originDir) {
    await runPool(
      localBuild.categories.filter((category) => wanted(category.matchingField)),
      8,
      async (category) => {
        let assets: SophonAsset[]
        try {
          assets = await fetchManifest(category)
        } catch (error) {
          // A category absent from the local build is skipped; real errors abort.
          if (/HTTP 404/.test((error as Error).message)) return
          throw error
        }
        for (const asset of assets) {
          const map = new Map<string, { offset: number; size: number }>()
          for (const chunk of asset.chunks) {
            if (chunk.uncompressedMd5 && !map.has(chunk.uncompressedMd5)) {
              map.set(chunk.uncompressedMd5, {
                offset: chunk.offset,
                size: chunk.sizeDecompressed
              })
            }
          }
          localChunks.set(asset.name, map)
        }
      }
    )
  }

  // Plan: which chunks can be copied from the installed file, which must be
  // downloaded. `total` is the real network delta (fresh run).
  interface Plan {
    category: SophonCategory
    asset: SophonAsset
    reuse: (number | null)[]
  }
  const plans: Plan[] = []
  let total = 0
  for (const { category, assets } of targetCats) {
    for (const asset of assets) {
      if (blacklist.includes(asset.name)) continue
      const segments = asset.name.split('/')
      const originPath = originDir ? join(originDir, ...segments) : join(destDir, ...segments)
      if (skipUnchanged && (await fileMatches(originPath, asset.size, asset.md5))) continue
      const local = localChunks.get(asset.name)
      const reuse: (number | null)[] = []
      for (const chunk of asset.chunks) {
        const found = chunk.uncompressedMd5 ? local?.get(chunk.uncompressedMd5) : undefined
        if (found && found.size === chunk.sizeDecompressed) {
          reuse.push(found.offset)
        } else {
          reuse.push(null)
          total += chunk.sizeDecompressed
        }
      }
      plans.push({ category, asset, reuse })
    }
  }

  let downloaded = 0
  onProgress({ downloaded, total, currentFile: '' })

  if (cacheDir) {
    await fs.mkdir(cacheDir, { recursive: true })
    // Starward's order: download and verify every missing chunk first, then assemble.
    const unique = new Map<string, { category: SophonCategory; chunk: SophonChunk; file: string }>()
    for (const { category, asset, reuse } of plans) {
      for (let i = 0; i < asset.chunks.length; i++) {
        if (reuse[i] != null) continue
        const chunk = asset.chunks[i]
        if (!unique.has(chunk.name)) unique.set(chunk.name, { category, chunk, file: asset.name })
      }
    }
    await runPool([...unique.values()], 8, async ({ category, chunk, file }) => {
      await chunkFromCache(category, chunk, cacheDir, signal)
      downloaded += chunk.sizeDecompressed
      onProgress({ downloaded, total, currentFile: file })
    })
  }
  if (cacheOnly) return

  await runPool(plans, 4, async ({ category, asset, reuse }) => {
    if (signal?.aborted) throw new Error('cancelled')
    const segments = asset.name.split('/')
    const assetPath = join(destDir, ...segments)
    const originPath = originDir ? join(originDir, ...segments) : assetPath
    await fs.mkdir(dirname(assetPath), { recursive: true })

    // Open the installed file for chunk reuse; if it cannot be read, download.
    let originHandle: Awaited<ReturnType<typeof fs.open>> | null = null
    if (reuse.some((offset) => offset != null)) {
      try {
        originHandle = await fs.open(originPath, 'r')
      } catch {
        originHandle = null
      }
      if (!originHandle) {
        for (let i = 0; i < reuse.length; i++) reuse[i] = null
      }
    }

    try {
      let resumeFrom = 0
      try {
        const stat = await fs.stat(assetPath)
        if (stat.size > 0 && stat.size < asset.size) resumeFrom = stat.size
      } catch {
        /* new file */
      }

      let ok = false
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        if (signal?.aborted) throw new Error('cancelled')
        if (attempt > 0) {
          resumeFrom = 0
          await fs.rm(assetPath, { force: true })
        }
        let fetched = 0
        const handle = await fs.open(assetPath, resumeFrom > 0 ? 'r+' : 'w')
        try {
          for (let i = 0; i < asset.chunks.length; i += CONCURRENCY) {
            if (signal?.aborted) throw new Error('cancelled')
            const end = Math.min(i + CONCURRENCY, asset.chunks.length)
            const need: number[] = []
            for (let j = i; j < end; j++) {
              const chunk = asset.chunks[j]
              if (chunk.offset + chunk.sizeDecompressed <= resumeFrom) {
                // Already written by an earlier run (count only the downloaded ones).
                if (reuse[j] == null) downloaded += chunk.sizeDecompressed
                continue
              }
              if (reuse[j] != null && originHandle) {
                const buffer = Buffer.alloc(chunk.sizeDecompressed)
                await originHandle.read(buffer, 0, chunk.sizeDecompressed, reuse[j] as number)
                await handle.write(buffer, 0, buffer.length, chunk.offset)
              } else {
                need.push(j)
              }
            }
            if (need.length) {
              const datas = await Promise.all(
                need.map((j) => chunkFromCache(category, asset.chunks[j], cacheDir, signal))
              )
              for (let k = 0; k < need.length; k++) {
                const j = need[k]
                const data = datas[k]
                await handle.write(data, 0, data.length, asset.chunks[j].offset)
                downloaded += data.length
                fetched += data.length
                onProgress({ downloaded, total, currentFile: asset.name })
              }
            }
          }
        } finally {
          await handle.close()
        }
        ok = !asset.md5 || (await md5File(assetPath)) === asset.md5
        if (!ok) downloaded -= fetched
      }
      if (!ok) throw new Error(`文件校验失败：${asset.name}`)
    } finally {
      await originHandle?.close()
    }
  })

  // The cache is no longer needed once the game files are assembled.
  if (cacheDir) await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => undefined)
}
