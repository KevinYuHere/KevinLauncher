import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { decompress } from 'fzstd'
import { md5File } from '../services/hash'
import {
  fetchChunk,
  fetchManifest,
  isLanguageField,
  type SophonAsset,
  type SophonBuild
} from './sophon'

const exec = promisify(execFile)
const CHUNK_API = 'https://downloader-api.mihoyo.com/downloader/sophon_chunk/api'
const CONCURRENCY = 16

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
  const res = await fetch(url, { method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0' } })
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
  // Original files are read from `originDir` (the installed game) while the new
  // files are written to `destDir` — for a pre-download these differ, so the
  // game stays playable and only changed files are staged.
  const mainAssets = new Map<
    string,
    { asset: SophonAsset; chunkPrefix: string; compression: number; suffix: string }
  >()
  for (const category of mainBuild.categories) {
    const assets = await fetchManifest(category)
    for (const asset of assets) {
      mainAssets.set(asset.name, {
        asset,
        chunkPrefix: category.chunkUrlPrefix,
        compression: category.chunkCompression,
        suffix: category.chunkSuffix
      })
    }
  }

  const installedAudio = new Set(audioLanguages)
  const ignored = new Set(ignoreFields)
  const selected = (field: string): boolean =>
    !ignored.has(field) && !(isLanguageField(field) && !installedAudio.has(field))
  let total = 0
  for (const category of patchBuild.categories) {
    if (!selected(category.matchingField)) continue
    total += category.versions[localVersion]?.compressedSize ?? 0
  }
  let downloaded = 0
  const patchCache = new Map<string, Buffer>()
  const cachedPatches = new Set<string>()
  const deletes: string[] = []
  if (cacheDir) await fs.mkdir(cacheDir, { recursive: true })
  onProgress(0, total)

  for (const category of patchBuild.categories) {
    if (!selected(category.matchingField)) continue
    if (!category.versions[localVersion]) continue
    const url = `${category.manifestUrlPrefix}/${category.manifestId}${category.manifestSuffix}`
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) continue
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
      if (signal?.aborted) throw new Error('已取消')
      if (blacklist.includes(asset.assetName)) continue
      const info = asset.infos.find((i) => i.versionTag === localVersion)
      if (!info) continue // unchanged
      const chunk = info.chunk
      const targetPath = join(destDir, ...asset.assetName.split('/'))
      const originalPath = join(
        originDir,
        ...(chunk.originalFileName || asset.assetName).split('/')
      )

      // Already staged correctly (e.g. from a partially completed pre-download)
      // → nothing to do; this is what makes reusing a partial pre-download work.
      const targetAsset = mainAssets.get(asset.assetName)
      if (
        targetAsset &&
        (await fileMatches(targetPath, targetAsset.asset.size, targetAsset.asset.md5))
      ) {
        continue
      }

      let applied = false
      if (await fileMatches(originalPath, chunk.originalFileLength, chunk.originalFileMd5)) {
        try {
          let raw: Uint8Array
          const ldiffPath = cacheDir ? join(cacheDir, chunk.patchName) : null
          if (ldiffPath) {
            let present = false
            try {
              present = (await fs.stat(ldiffPath)).size === chunk.patchFileSize
              if (present && chunk.patchFileMd5) {
                present = (await md5File(ldiffPath)) === chunk.patchFileMd5
              }
            } catch {
              present = false
            }
            if (!present) {
              const pr = await fetch(
                `${category.diffUrlPrefix}/${chunk.patchName}${category.diffSuffix}`,
                { headers: { 'User-Agent': 'Mozilla/5.0' }, signal }
              )
              if (!pr.ok) throw new Error(`下载补丁文件失败 HTTP ${pr.status}`)
              const data = Buffer.from(await pr.arrayBuffer())
              await fs.writeFile(ldiffPath, data)
              if (chunk.patchFileMd5 && (await md5File(ldiffPath)) !== chunk.patchFileMd5) {
                throw new Error(`补丁文件校验失败：${chunk.patchName}`)
              }
              if (!cachedPatches.has(chunk.patchName)) {
                cachedPatches.add(chunk.patchName)
                downloaded += data.length
                onProgress(downloaded, total)
              }
            } else if (!cachedPatches.has(chunk.patchName)) {
              cachedPatches.add(chunk.patchName)
              downloaded += chunk.patchFileSize
              onProgress(downloaded, total)
            }
            if (cacheOnly) continue
            const handle = await fs.open(ldiffPath, 'r')
            const slice = Buffer.alloc(chunk.patchLength)
            await handle.read(slice, 0, chunk.patchLength, chunk.patchOffset)
            await handle.close()
            raw = slice
          } else {
            let patchData = patchCache.get(chunk.patchName)
            if (!patchData) {
              const pr = await fetch(
                `${category.diffUrlPrefix}/${chunk.patchName}${category.diffSuffix}`,
                { headers: { 'User-Agent': 'Mozilla/5.0' }, signal }
              )
              if (!pr.ok) throw new Error(`下载补丁文件失败 HTTP ${pr.status}`)
              patchData = Buffer.from(await pr.arrayBuffer())
              patchCache.set(chunk.patchName, patchData)
            }
            raw = patchData.subarray(chunk.patchOffset, chunk.patchOffset + chunk.patchLength)
          }
          let fragment: Uint8Array = raw
          if (category.diffCompression) {
            // Starward's HPatch.PatchZstandard zstd-decompresses the diff stream;
            // a failure falls through to a full-file download below.
            fragment = decompress(raw)
          }
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
            // E27: verify the patched file against the target manifest; a mismatch
            // fails the update (no full-file fallback, like Starward).
            if (
              targetAsset &&
              !(await fileMatches(targetPath, targetAsset.asset.size, targetAsset.asset.md5))
            ) {
              throw new Error(`文件校验失败：${asset.assetName}`)
            }
            applied = true
            if (!cacheDir) downloaded += chunk.patchLength
          } finally {
            await fs.rm(diffTmp, { force: true })
            await fs.rm(outTmp, { force: true })
          }
        } catch (error) {
          // Starward fails the patch here; we do not fall back to a full download.
          throw new Error(`补丁应用失败：${asset.assetName}（${(error as Error).message}）`)
        }
      }
      if (cacheOnly) continue
      if (!applied) {
        const entry = mainAssets.get(asset.assetName)
        if (entry) {
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
          // Verify the full-file fallback too (Starward checks every file).
          if (
            targetAsset &&
            !(await fileMatches(targetPath, targetAsset.asset.size, targetAsset.asset.md5))
          ) {
            throw new Error(`文件校验失败：${asset.assetName}`)
          }
        }
      }
      onProgress(downloaded, total)
    }
  }

  // The ldiff cache is no longer needed once the files are patched.
  if (cacheDir && !cacheOnly) {
    await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => undefined)
  }
  return deletes
}
