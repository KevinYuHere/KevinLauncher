import { promises as fs, createReadStream } from 'fs'
import { join, dirname } from 'path'
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { decompress } from 'fzstd'
import {
  fetchChunk,
  fetchManifest,
  type SophonAsset,
  type SophonBuild
} from './sophon'

const exec = promisify(execFile)
const CHUNK_API = 'https://downloader-api.mihoyo.com/downloader/sophon_chunk/api'
const CONCURRENCY = 16

export interface PatchCategory {
  categoryId: string
  manifestId: string
  manifestUrlPrefix: string
  diffUrlPrefix: string
  versions: Record<string, { compressedSize: number; fileCount: number }>
}
export interface PatchBuild {
  patchId: string
  tag: string
  categories: PatchCategory[]
}

interface PatchChunk {
  patchName: string
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
  const res = await fetch(url, { method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0' } })
  const json = (await res.json()) as {
    retcode: number
    message: string
    data?: {
      patch_id: string
      tag: string
      manifests: {
        category_id: string
        manifest: { id: string }
        manifest_download: { url_prefix: string }
        diff_download: { url_prefix: string }
        stats?: Record<string, { compressed_size?: string; file_count?: string }>
      }[]
    }
  }
  if (json.retcode !== 0 || !json.data) throw new Error(json.message || 'getPatchBuild 失败')
  return {
    patchId: json.data.patch_id,
    tag: json.data.tag,
    categories: (json.data.manifests ?? []).map((m) => ({
      categoryId: m.category_id,
      manifestId: m.manifest.id,
      manifestUrlPrefix: m.manifest_download.url_prefix,
      diffUrlPrefix: m.diff_download.url_prefix,
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
    patchOffset: 0,
    patchLength: 0,
    originalFileName: '',
    originalFileLength: 0,
    originalFileMd5: ''
  }
  for (const f of fields(buf)) {
    if (f.wire === 2 && f.sub) {
      if (f.field === 1) chunk.patchName = str(f.sub)
      else if (f.field === 8) chunk.originalFileName = str(f.sub)
      else if (f.field === 10) chunk.originalFileMd5 = str(f.sub)
    } else if (f.wire === 0 && f.num !== undefined) {
      if (f.field === 6) chunk.patchOffset = Number(f.num)
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
      const datas = await Promise.all(batch.map((c) => fetchChunk(chunkPrefix, c.name, signal)))
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
export async function applySophonPatch(
  patchBuild: PatchBuild,
  mainBuild: SophonBuild,
  localVersion: string,
  gameDir: string,
  hpatchzPath: string,
  onProgress: (downloaded: number, total: number) => void,
  signal?: AbortSignal
): Promise<void> {
  // Index main build assets for the DownloadOver fallback.
  const mainAssets = new Map<string, { asset: SophonAsset; chunkPrefix: string }>()
  for (const category of mainBuild.categories) {
    const assets = await fetchManifest(category)
    for (const asset of assets) mainAssets.set(asset.name, { asset, chunkPrefix: category.chunkUrlPrefix })
  }

  let total = 0
  for (const category of patchBuild.categories) {
    total += category.versions[localVersion]?.compressedSize ?? 0
  }
  let downloaded = 0
  const patchCache = new Map<string, Buffer>()
  onProgress(0, total)

  for (const category of patchBuild.categories) {
    if (!category.versions[localVersion]) continue
    const url = `${category.manifestUrlPrefix}/${category.manifestId}`
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) continue
    const proto = parsePatchProto(decompress(new Uint8Array(await res.arrayBuffer())))

    for (const unused of proto.unusedAssets) {
      if (unused.versionTag !== localVersion) continue
      for (const file of unused.files) {
        try {
          await fs.rm(join(gameDir, ...file.fileName.split('/')), { force: true })
        } catch {
          /* ignore */
        }
      }
    }

    for (const asset of proto.patchAssets) {
      if (signal?.aborted) throw new Error('已取消')
      const info = asset.infos.find((i) => i.versionTag === localVersion)
      if (!info) continue // unchanged
      const chunk = info.chunk
      const targetPath = join(gameDir, ...asset.assetName.split('/'))
      const originalPath = join(
        gameDir,
        ...(chunk.originalFileName || asset.assetName).split('/')
      )

      if (await fileMatches(originalPath, chunk.originalFileLength, chunk.originalFileMd5)) {
        let patchData = patchCache.get(chunk.patchName)
        if (!patchData) {
          const pr = await fetch(`${category.diffUrlPrefix}/${chunk.patchName}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal
          })
          if (!pr.ok) throw new Error(`下载补丁文件失败 HTTP ${pr.status}`)
          patchData = Buffer.from(await pr.arrayBuffer())
          patchCache.set(chunk.patchName, patchData)
        }
        const fragment = patchData.subarray(chunk.patchOffset, chunk.patchOffset + chunk.patchLength)
        const diffTmp = `${targetPath}.hdiff.tmp`
        const outTmp = `${targetPath}.new.tmp`
        await fs.writeFile(diffTmp, fragment)
        try {
          await exec(hpatchzPath, ['-f', originalPath, diffTmp, outTmp], {
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024
          })
          await fs.rm(targetPath, { force: true })
          await fs.rename(outTmp, targetPath)
        } finally {
          await fs.rm(diffTmp, { force: true })
          await fs.rm(outTmp, { force: true })
        }
        downloaded += chunk.patchLength
      } else {
        // Original file missing/mismatched → download the full file.
        const entry = mainAssets.get(asset.assetName)
        if (entry) {
          await writeChunks(entry.asset, entry.chunkPrefix, targetPath, signal, (n) => {
            downloaded += n
            onProgress(downloaded, total)
          })
        }
      }
      onProgress(downloaded, total)
    }
  }
}
