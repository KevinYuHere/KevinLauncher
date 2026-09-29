import { promises as fs, createReadStream } from 'fs'
import { join, dirname } from 'path'
import { createHash } from 'crypto'
import { decompress } from 'fzstd'

const CHUNK_API = 'https://downloader-api.mihoyo.com/downloader/sophon_chunk/api'
const CONCURRENCY = 16

export interface SophonCategory {
  categoryId: string
  categoryName: string
  manifestId: string
  manifestUrlPrefix: string
  chunkUrlPrefix: string
  compressedSize: number
}

export interface SophonBuild {
  buildId: string
  tag: string
  categories: SophonCategory[]
}

export interface SophonChunk {
  name: string
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

export async function getSophonBuild(branch: {
  branch: string
  packageId: string
  password: string
}): Promise<SophonBuild> {
  const url =
    `${CHUNK_API}/getBuild?branch=${encodeURIComponent(branch.branch)}` +
    `&package_id=${encodeURIComponent(branch.packageId)}&password=${encodeURIComponent(branch.password)}`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  const json = (await res.json()) as {
    retcode: number
    message: string
    data?: {
      build_id: string
      tag: string
      manifests: {
        category_id: string
        category_name: string
        manifest: { id: string; compressed_size: string }
        manifest_download: { url_prefix: string }
        chunk_download: { url_prefix: string }
        stats?: { compressed_size?: string }
      }[]
    }
  }
  if (json.retcode !== 0 || !json.data) throw new Error(json.message || 'getBuild failed')
  return {
    buildId: json.data.build_id,
    tag: json.data.tag,
    categories: (json.data.manifests ?? []).map((m) => ({
      categoryId: m.category_id,
      categoryName: m.category_name,
      manifestId: m.manifest.id,
      manifestUrlPrefix: m.manifest_download.url_prefix,
      chunkUrlPrefix: m.chunk_download.url_prefix,
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
  const chunk: SophonChunk = { name: '', offset: 0, size: 0, sizeDecompressed: 0 }
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

export async function fetchManifest(category: SophonCategory): Promise<SophonAsset[]> {
  const url = `${category.manifestUrlPrefix}/${category.manifestId}`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`download manifest failed HTTP ${res.status}`)
  return parseManifest(decompress(new Uint8Array(await res.arrayBuffer())))
}

export async function fetchChunk(prefix: string, name: string, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetch(`${prefix}/${name}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal })
  if (!res.ok) throw new Error(`download chunk failed HTTP ${res.status}`)
  return Buffer.from(decompress(new Uint8Array(await res.arrayBuffer())))
}

function md5File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5')
    const stream = createReadStream(path)
    stream.on('data', (d) => hash.update(d))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
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

/**
 * Download and assemble a Sophon build into `destDir`. When `skipUnchanged` is
 * set, files already present with a matching size/MD5 are skipped — this gives
 * incremental updates (only changed files) and resumable downloads.
 */
export async function downloadSophonBuild(
  build: SophonBuild,
  destDir: string,
  onProgress: (progress: SophonProgress) => void,
  signal?: AbortSignal,
  skipUnchanged = false
): Promise<void> {
  let total = 0
  const categoryAssets: { category: SophonCategory; assets: SophonAsset[] }[] = []
  for (const category of build.categories) {
    const assets = await fetchManifest(category)
    for (const asset of assets) total += asset.size
    categoryAssets.push({ category, assets })
  }

  let downloaded = 0
  onProgress({ downloaded, total, currentFile: '' })

  for (const { category, assets } of categoryAssets) {
    for (const asset of assets) {
      if (signal?.aborted) throw new Error('cancelled')
      const assetPath = join(destDir, ...asset.name.split('/'))

      if (skipUnchanged && (await fileMatches(assetPath, asset.size, asset.md5))) {
        downloaded += asset.size
        onProgress({ downloaded, total, currentFile: asset.name })
        continue
      }

      await fs.mkdir(dirname(assetPath), { recursive: true })
      let assetBytes = 0
      let ok = false
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        if (signal?.aborted) throw new Error('cancelled')
        if (attempt > 0) {
          downloaded -= assetBytes
          assetBytes = 0
        }
        const handle = await fs.open(assetPath, 'w')
        try {
          for (let i = 0; i < asset.chunks.length; i += CONCURRENCY) {
            if (signal?.aborted) throw new Error('cancelled')
            const batch = asset.chunks.slice(i, i + CONCURRENCY)
            const datas = await Promise.all(
              batch.map((chunk) => fetchChunk(category.chunkUrlPrefix, chunk.name, signal))
            )
            for (let j = 0; j < batch.length; j++) {
              const data = datas[j]
              await handle.write(data, 0, data.length, batch[j].offset)
              assetBytes += data.length
              downloaded += data.length
              onProgress({ downloaded, total, currentFile: asset.name })
            }
          }
        } finally {
          await handle.close()
        }
        ok = !asset.md5 || (await md5File(assetPath)) === asset.md5
      }
      if (!ok) throw new Error(`文件校验失败：${asset.name}`)
    }
  }
}
