import { promises as fs, createReadStream, createWriteStream } from 'fs'
import { dirname, join, relative, sep } from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { createInflateRaw, crc32 } from 'zlib'
import { isImportFile } from './settingsBackup'

/**
 * Read-only inspection and extraction for a user-selected settings zip.
 *
 * The archive is untrusted input: the central directory is checked without
 * trusting local headers, entry names are restricted to the settings layout,
 * declared expansion is bounded before anything is written, and extraction
 * verifies the size and CRC of every file. Unknown but safe entries are
 * ignored so old exports containing extra caches remain importable.
 */

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const MAX_ENTRIES = 32_768
const MAX_EXPANDED_BYTES = 4 * 1024 * 1024 * 1024
const MAX_CENTRAL_BYTES = 32 * 1024 * 1024
const MAX_NAME_BYTES = 4096
const utf8 = new TextDecoder('utf-8', { fatal: true })

export interface BackupArchiveEntry {
  name: string
  directory: boolean
  method: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

export interface BackupArchivePlan {
  archiveSize: number
  expandedBytes: number
  entries: readonly BackupArchiveEntry[]
  files: readonly string[]
  fingerprint: string
}

interface ArchiveDirectory extends BackupArchivePlan {
  centralOffset: number
}

type FileHandle = Awaited<ReturnType<typeof fs.open>>

async function readAt(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  if (length === 0) return Buffer.alloc(0)
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, position + read)
    if (!bytesRead) throw new Error('备份压缩包已截断')
    read += bytesRead
  }
  return buffer
}

function validSegment(segment: string): boolean {
  return segment.length > 0 && segment !== '.' && segment !== '..' && segment.length <= 255 &&
    !/[<>:"\\|?*\x00-\x1f]/.test(segment) && !/[ .]$/.test(segment) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
}

/** Validate a central-directory path before it can reach the filesystem. */
function archiveName(raw: string): { name: string; directory: boolean } {
  if (!raw || raw.length > MAX_NAME_BYTES || raw.includes('\\') || /[\x00-\x1f]/.test(raw)) {
    throw new Error('备份压缩包包含无效路径')
  }
  const directory = raw.endsWith('/')
  const name = directory ? raw.slice(0, -1) : raw
  if (!name || name.startsWith('/') || name.includes('//')) {
    throw new Error('备份压缩包包含无效路径')
  }
  if (!name.split('/').every(validSegment)) throw new Error('备份压缩包包含无效路径')
  return { name, directory }
}

async function archiveDirectory(path: string): Promise<ArchiveDirectory> {
  const handle = await fs.open(path, 'r')
  try {
    const { size: archiveSize, mtimeMs } = await handle.stat()
    if (archiveSize < 22) throw new Error('备份压缩包格式异常')
    const tailLength = Math.min(archiveSize, 65_557)
    const tail = await readAt(handle, tailLength, archiveSize - tailLength)
    let eocd = -1
    for (let index = tail.length - 22; index >= 0; index--) {
      if (tail.readUInt32LE(index) !== EOCD_SIG) continue
      const comment = tail.readUInt16LE(index + 20)
      if (index + 22 + comment <= tail.length) {
        eocd = index
        break
      }
    }
    if (eocd < 0) throw new Error('备份压缩包格式异常（未找到 ZIP 目录）')

    const disk = tail.readUInt16LE(eocd + 4)
    const centralDisk = tail.readUInt16LE(eocd + 6)
    const entriesOnDisk = tail.readUInt16LE(eocd + 8)
    const entriesTotal = tail.readUInt16LE(eocd + 10)
    const centralSize = tail.readUInt32LE(eocd + 12)
    const centralOffset = tail.readUInt32LE(eocd + 16)
    if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entriesTotal) {
      throw new Error('不支持分卷备份压缩包')
    }
    if (entriesTotal === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new Error('备份压缩包过大或使用不支持的 ZIP64 格式')
    }
    if (entriesTotal > MAX_ENTRIES) throw new Error('备份压缩包文件数量超出限制')
    if (centralSize > MAX_CENTRAL_BYTES) throw new Error('备份压缩包目录过大')
    const eocdAbsolute = archiveSize - tailLength + eocd
    if (centralOffset + centralSize > eocdAbsolute) throw new Error('备份压缩包目录越界')
    const central = await readAt(handle, centralSize, centralOffset)

    const entries: BackupArchiveEntry[] = []
    const seen = new Map<string, boolean>()
    let positioned = 0
    let expandedBytes = 0
    while (positioned < central.length) {
      if (positioned + 46 > central.length || central.readUInt32LE(positioned) !== CENTRAL_SIG) {
        throw new Error('备份压缩包目录不完整')
      }
      const madeBy = central.readUInt16LE(positioned + 4)
      const flags = central.readUInt16LE(positioned + 8)
      const method = central.readUInt16LE(positioned + 10)
      const crc = central.readUInt32LE(positioned + 16)
      const compressedSize = central.readUInt32LE(positioned + 20)
      const uncompressedSize = central.readUInt32LE(positioned + 24)
      const nameLength = central.readUInt16LE(positioned + 28)
      const extraLength = central.readUInt16LE(positioned + 30)
      const commentLength = central.readUInt16LE(positioned + 32)
      const diskStart = central.readUInt16LE(positioned + 34)
      const externalAttributes = central.readUInt32LE(positioned + 38)
      const localHeaderOffset = central.readUInt32LE(positioned + 42)
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        throw new Error('备份压缩包过大或使用不支持的 ZIP64 格式')
      }
      if (positioned + 46 + nameLength + extraLength + commentLength > central.length) {
        throw new Error('备份压缩包目录项越界')
      }
      if (diskStart !== 0 || localHeaderOffset + 30 > centralOffset) {
        throw new Error('备份压缩包目录项越界')
      }
      if ((flags & 1) !== 0) throw new Error('不支持加密的备份压缩包')
      if (method !== 0 && method !== 8) throw new Error('备份压缩包使用不受支持的压缩方式')

      let name: string
      try {
        name = utf8.decode(central.subarray(positioned + 46, positioned + 46 + nameLength))
      } catch {
        throw new Error('备份压缩包文件名编码无效')
      }
      const parsed = archiveName(name)
      if (parsed.directory && uncompressedSize !== 0) throw new Error('备份压缩包目录项无效')
      const host = madeBy >>> 8
      const mode = (externalAttributes >>> 16) & 0xffff
      if ((externalAttributes & 0x400) !== 0 || ((host === 3 || host === 19) && (mode & 0xf000) === 0xa000)) {
        throw new Error('备份压缩包包含重解析或符号链接')
      }
      const key = parsed.name.toLowerCase()
      if (seen.has(key)) throw new Error('备份压缩包包含重复路径')
      seen.set(key, parsed.directory)

      entries.push({
        name: parsed.name,
        directory: parsed.directory,
        method,
        crc,
        compressedSize,
        uncompressedSize,
        localHeaderOffset
      })
      expandedBytes += uncompressedSize
      if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_EXPANDED_BYTES) {
        throw new Error('备份展开后的总大小超出限制')
      }
      positioned += 46 + nameLength + extraLength + commentLength
    }
    if (entries.length !== entriesTotal) throw new Error('备份压缩包目录项数量不一致')

    const filePaths = new Set(entries.filter((entry) => !entry.directory).map((entry) => entry.name.toLowerCase()))
    const files: string[] = []
    for (const entry of entries) {
      if (entry.directory || !isImportFile(entry.name)) continue
      const parts = entry.name.split('/')
      parts.pop()
      while (parts.length) {
        if (filePaths.has(parts.join('/').toLowerCase())) throw new Error('备份压缩包目录与文件冲突')
        parts.pop()
      }
      files.push(entry.name)
    }
    if (!files.some((name) => name.toLowerCase() === 'config.json')) {
      throw new Error('备份缺少 config.json')
    }
    const fingerprint = JSON.stringify({
      archiveSize,
      mtimeMs,
      entries: entries.map((entry) => [
        entry.name, entry.directory, entry.method, entry.crc,
        entry.compressedSize, entry.uncompressedSize, entry.localHeaderOffset
      ])
    })
    return { archiveSize, expandedBytes, entries, files, fingerprint, centralOffset }
  } finally {
    await handle.close()
  }
}

/** Validate an archive before copying or extracting anything. */
export async function inspectSettingsArchive(path: string): Promise<BackupArchivePlan> {
  const directory = await archiveDirectory(path)
  return {
    archiveSize: directory.archiveSize,
    expandedBytes: directory.expandedBytes,
    entries: directory.entries,
    files: directory.files,
    fingerprint: directory.fingerprint
  }
}

/** Extract only settings-owned files, after checking the archive did not change. */
export async function extractSettingsArchive(
  path: string,
  destination: string,
  expected: BackupArchivePlan
): Promise<void> {
  const directory = await archiveDirectory(path)
  if (directory.fingerprint !== expected.fingerprint) {
    throw new Error('备份压缩包在检查后发生变化，请重新选择')
  }
  await fs.mkdir(destination)
  const handle = await fs.open(path, 'r')
  try {
    for (const entry of directory.entries) {
      if (entry.directory || !isImportFile(entry.name)) continue
      const target = join(destination, ...entry.name.split('/'))
      const relativePath = relative(destination, target)
      if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) ||
          relativePath.startsWith(sep)) {
        throw new Error('备份压缩包路径越界')
      }
      await fs.mkdir(dirname(target), { recursive: true })
      const header = await readAt(handle, 30, entry.localHeaderOffset)
      if (header.readUInt32LE(0) !== LOCAL_SIG) throw new Error('备份压缩包文件头无效')
      const flags = header.readUInt16LE(6)
      const method = header.readUInt16LE(8)
      const nameLength = header.readUInt16LE(26)
      const extraLength = header.readUInt16LE(28)
      if ((flags & 1) !== 0 || method !== entry.method) throw new Error('备份压缩包文件头不一致')
      const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength
      if (dataStart + entry.compressedSize > directory.centralOffset) {
        throw new Error('备份压缩包文件数据越界')
      }

      let bytes = 0
      let checksum = 0
      const verify = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length
          if (bytes > entry.uncompressedSize) callback(new Error('备份文件展开大小超过清单：' + entry.name))
          else {
            checksum = crc32(chunk, checksum)
            callback(null, chunk)
          }
        }
      })
      const source = entry.compressedSize === 0
        ? Readable.from([])
        : createReadStream(path, { start: dataStart, end: dataStart + entry.compressedSize - 1 })
      const output = createWriteStream(target, { flags: 'wx' })
      if (entry.method === 8) await pipeline(source, createInflateRaw(), verify, output)
      else await pipeline(source, verify, output)
      if (bytes !== entry.uncompressedSize || checksum !== entry.crc) {
        throw new Error('备份文件数据校验失败：' + entry.name)
      }
    }
  } finally {
    await handle.close()
  }
}
