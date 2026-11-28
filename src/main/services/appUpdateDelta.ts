import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { sha256Bytes, sha256File } from './hash.ts'
import { isSha256, SAFE_VERSION } from './appUpdateManifest.ts'

/**
 * Application-only delta updates.
 *
 * Format 1 is `gzip(JSON)` and uses short per-file fields to keep the transfer
 * small:
 *
 * {
 *   format: 1,
 *   fromVersion, toVersion, appSize,
 *   files: [
 *     { p, s, h },        // unchanged at the same path: copy baseRoot/p
 *     { p, s, h, r },     // unchanged content at another base path: copy r
 *     { p, s, h, d }      // changed: d is the complete file as base64
 *   ]
 * }
 *
 * `p` target path, `s` length, `h` SHA-256, `r` base path, `d` base64 data.
 * Reused files are selected by SHA-256, so a rename with identical content is
 * still a reference. Paths are always canonical `/`-separated relative paths.
 *
 * The delta is only an optimization: any validation failure rejects it so the
 * caller can fall back to the conventional full application ZIP. It never links
 * to the old tree and never writes outside the prepared target.
 */
const DELTA_FORMAT = 1
const MAX_FILES = 50_000
const MAX_FILE_BYTES = 256 * 1024 * 1024
const MAX_APP_BYTES = 8 * 1024 * 1024 * 1024
const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024
const MAX_JSON_BYTES = 256 * 1024 * 1024
const MAX_PATH_CHARS = 240
const READ_CHUNK = 256 * 1024
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const RESERVED_WINDOWS_NAME =
  /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i

export interface AppTreeFile {
  path: string
  size: number
  sha256: string
}

export interface AppTreeInventory {
  version: string
  files: AppTreeFile[]
}

interface DeltaFile {
  path: string
  size: number
  sha256: string
  /** Base path to copy; absent means the base path equals `path`. */
  basePath: string
  /** Base64 content for a changed file; absent means reuse from the base. */
  data?: string
}

interface ParsedDelta {
  fromVersion: string
  toVersion: string
  appSize: number
  files: DeltaFile[]
}

interface EncodedDeltaFile {
  p: string
  s: number
  h: string
  r?: string
  d?: string
}

function invalid(message: string): never {
  throw new Error(`应用差量更新失败：${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFileSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validateVersion(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_VERSION.test(value)) {
    invalid(`${label}无效`)
  }
  return value
}

/**
 * Only canonical relative paths that can be materialized on Windows. Rejecting
 * aliases (`..`, empty segments, drive paths) and Windows-normalized variants
 * (trailing dots/spaces, device names, forbidden characters) keeps the prepared
 * tree unambiguous on every platform.
 */
function validateAppPath(value: unknown, label = '文件路径'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_CHARS ||
      value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.includes('\\')) {
    invalid(`${label}不是规范的相对路径`)
  }
  for (const segment of value.split('/')) {
    if (segment.length === 0 || segment === '.' || segment === '..' ||
        /[<>:"|?*\u0000-\u001f]/.test(segment) ||
        segment.endsWith('.') || segment.endsWith(' ')) {
      invalid(`${label}不是安全的 Windows 相对路径`)
    }
    const baseName = segment.split('.')[0].trimEnd().toUpperCase()
    if (RESERVED_WINDOWS_NAME.test(baseName)) {
      invalid(`${label}使用了 Windows 保留名称`)
    }
  }
  return value
}

function pathKey(path: string): string {
  return path.toLowerCase()
}

function comparePaths(left: { path: string }, right: { path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function requireAppDirectory(root: string, label: string): Promise<string> {
  if (typeof root !== 'string' || root.trim().length === 0) invalid(`${label}无效`)
  const absolute = resolve(root)
  const info = await lstatOrNull(absolute)
  if (!info || !info.isDirectory() || info.isSymbolicLink()) {
    invalid(`${label}不是普通文件夹`)
  }
  return absolute
}

function addFileSize(total: number, size: number): number {
  const next = total + size
  if (!Number.isSafeInteger(next) || next > MAX_APP_BYTES) invalid('应用总大小超出限制')
  return next
}

function normalizeInventoryFiles(rawFiles: unknown, label: string): {
  files: AppTreeFile[]
  size: number
} {
  if (!Array.isArray(rawFiles) || rawFiles.length > MAX_FILES) {
    invalid(`${label}的文件列表无效或文件过多`)
  }
  const files: AppTreeFile[] = []
  const seen = new Set<string>()
  let size = 0
  for (const raw of rawFiles) {
    if (!isRecord(raw)) invalid(`${label}的文件项无效`)
    const path = validateAppPath(raw.path, `${label}中的文件路径`)
    if (!isFileSize(raw.size) || raw.size > MAX_FILE_BYTES) {
      invalid(`${label}中的文件大小无效`)
    }
    if (!isSha256(raw.sha256)) invalid(`${label}中的文件校验值无效`)
    const key = pathKey(path)
    if (seen.has(key)) invalid(`${label}包含重复文件：${path}`)
    seen.add(key)
    size = addFileSize(size, raw.size)
    files.push({ path, size: raw.size, sha256: raw.sha256.toLowerCase() })
  }
  files.sort(comparePaths)
  return { files, size }
}

function parseInventory(value: unknown, label: string): AppTreeInventory {
  if (!isRecord(value)) invalid(`${label}格式无效`)
  const version = validateVersion(value.version, `${label}版本`)
  const { files } = normalizeInventoryFiles(value.files, label)
  return { version, files }
}

/**
 * Enumerate one exact versioned application directory. Files are sorted and
 * hashed; symlinks, junctions, special files and noncanonical names are rejected
 * instead of being followed.
 */
export async function inventoryAppTree(root: string, version: string): Promise<AppTreeInventory> {
  validateVersion(version, '应用版本')
  const base = await requireAppDirectory(root, '应用目录')
  const files: AppTreeFile[] = []
  const seen = new Set<string>()
  let total = 0
  let count = 0

  const walk = async (directory: string, prefix: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch (error) {
      invalid(`无法读取应用目录：${nameOf(error)}`)
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      validateAppPath(path, '应用文件路径')
      const full = join(directory, entry.name)
      const info = await lstatOrNull(full)
      if (!info) invalid(`应用文件在读取前消失：${path}`)
      if (info.isSymbolicLink()) invalid(`应用目录包含符号链接或重解析点：${path}`)
      if (info.isDirectory()) {
        await walk(full, path)
        continue
      }
      if (!info.isFile()) invalid(`应用目录包含不支持的文件类型：${path}`)
      if (++count > MAX_FILES) invalid('应用文件数量超出限制')
      if (!isFileSize(info.size) || info.size > MAX_FILE_BYTES) {
        invalid(`应用文件过大：${path}`)
      }
      const key = pathKey(path)
      if (seen.has(key)) invalid(`应用目录包含仅大小写不同的重复文件：${path}`)
      seen.add(key)
      total = addFileSize(total, info.size)
      let digest: string
      try {
        digest = await sha256File(full)
      } catch (error) {
        invalid(`无法读取应用文件 ${path}：${nameOf(error)}`)
      }
      const after = await lstatOrNull(full)
      if (!after || !after.isFile() || after.isSymbolicLink() || after.size !== info.size) {
        invalid(`应用文件在读取时发生变化：${path}`)
      }
      files.push({ path, size: info.size, sha256: digest.toLowerCase() })
    }
  }

  await walk(base, '')
  files.sort(comparePaths)
  return { version, files }
}

async function readChangedFile(root: string, file: AppTreeFile): Promise<Buffer> {
  const full = join(root, ...file.path.split('/'))
  const info = await lstatOrNull(full)
  if (!info || !info.isFile() || info.isSymbolicLink() || info.size !== file.size) {
    invalid(`目标文件在打包时发生变化：${file.path}`)
  }
  let data: Buffer
  try {
    data = await fs.readFile(full)
  } catch (error) {
    invalid(`无法读取目标文件 ${file.path}：${nameOf(error)}`)
  }
  if (data.length !== file.size || sha256Bytes(data) !== file.sha256) {
    invalid(`目标文件在打包时发生变化：${file.path}`)
  }
  return data
}

/**
 * Build a compact delta from a previously published inventory of `fromVersion`
 * and the exact target tree. Unchanged contents are referenced by SHA-256;
 * changed contents are embedded in full. The output is byte-for-byte
 * deterministic for identical trees.
 */
export async function buildAppDelta(
  base: unknown,
  targetRoot: string,
  targetVersion: string
): Promise<Buffer> {
  validateVersion(targetVersion, '目标版本')
  const baseInventory = parseInventory(base, '基础应用清单')
  const target = await inventoryAppTree(targetRoot, targetVersion)
  const targetPath = resolve(targetRoot)

  const candidates = new Map<string, AppTreeFile[]>()
  for (const file of baseInventory.files) {
    const list = candidates.get(file.sha256) ?? []
    list.push(file)
    candidates.set(file.sha256, list)
  }

  const files: EncodedDeltaFile[] = []
  let appSize = 0
  let encodedBytes = 0
  for (const file of target.files) {
    appSize = addFileSize(appSize, file.size)
    const matches = candidates.get(file.sha256) ?? []
    const reusable = matches.find(candidate =>
      candidate.path === file.path && candidate.size === file.size
    ) ?? matches.find(candidate => candidate.size === file.size)
    const encoded: EncodedDeltaFile = {
      p: file.path,
      s: file.size,
      h: file.sha256
    }
    if (reusable) {
      if (reusable.path !== file.path) encoded.r = reusable.path
    } else {
      const base64Length = Math.ceil(file.size / 3) * 4
      if (encodedBytes + base64Length > MAX_JSON_BYTES) {
        invalid('变更内容过多，无法生成轻量差量包')
      }
      const data = await readChangedFile(targetPath, file)
      encoded.d = data.toString('base64')
      encodedBytes += encoded.d.length
    }
    files.push(encoded)
  }

  const payload = {
    format: DELTA_FORMAT,
    fromVersion: baseInventory.version,
    toVersion: targetVersion,
    appSize,
    files
  }
  const json = Buffer.from(JSON.stringify(payload), 'utf8')
  if (json.length > MAX_JSON_BYTES) invalid('差量包内容超过大小上限')

  const archive = gzipSync(json, { level: 9 })
  if (archive.length > MAX_COMPRESSED_BYTES) invalid('差量包压缩后仍超过大小上限')
  // Pin the gzip timestamp and OS byte so the same application tree produces
  // the same archive regardless of when or where it was built.
  if (archive.length > 9) {
    archive.writeUInt32LE(0, 4)
    archive[9] = 0xff
  }
  return archive
}

function parseDelta(value: unknown): ParsedDelta {
  if (!isRecord(value) || value.format !== DELTA_FORMAT) invalid('差量包格式不受支持')
  const fromVersion = validateVersion(value.fromVersion, '差量包源版本')
  const toVersion = validateVersion(value.toVersion, '差量包目标版本')
  if (!isFileSize(value.appSize) || value.appSize > MAX_APP_BYTES) {
    invalid('差量包的应用大小无效')
  }
  if (!Array.isArray(value.files) || value.files.length > MAX_FILES) {
    invalid('差量包文件列表无效或文件过多')
  }

  const files: DeltaFile[] = []
  const seen = new Set<string>()
  let size = 0
  for (const raw of value.files) {
    if (!isRecord(raw)) invalid('差量包文件项无效')
    const path = validateAppPath(raw.p, '差量包文件路径')
    if (!isFileSize(raw.s) || raw.s > MAX_FILE_BYTES) invalid(`差量包中的文件大小无效：${path}`)
    if (!isSha256(raw.h)) invalid(`差量包中的文件校验值无效：${path}`)
    const key = pathKey(path)
    if (seen.has(key)) invalid(`差量包包含重复文件：${path}`)
    seen.add(key)

    const hasData = Object.prototype.hasOwnProperty.call(raw, 'd')
    const hasBase = Object.prototype.hasOwnProperty.call(raw, 'r')
    if (hasData && hasBase) invalid(`差量包中的文件同时包含内容和复用路径：${path}`)
    let data: string | undefined
    let basePath = path
    if (hasData) {
      if (typeof raw.d !== 'string' || !BASE64.test(raw.d) ||
          raw.d.length !== Math.ceil(raw.s / 3) * 4) {
        invalid(`差量包中的文件内容编码无效：${path}`)
      }
      data = raw.d
    } else if (hasBase) {
      if (typeof raw.r !== 'string') invalid(`差量包中的复用路径无效：${path}`)
      basePath = validateAppPath(raw.r, '差量包复用路径')
    }
    size = addFileSize(size, raw.s)
    files.push({
      path,
      size: raw.s,
      sha256: raw.h.toLowerCase(),
      basePath,
      ...(data === undefined ? {} : { data })
    })
  }
  if (size !== value.appSize) invalid('差量包的文件总大小与应用大小不一致')

  const filePaths = new Set(files.map(file => pathKey(file.path)))
  for (const file of files) {
    const segments = file.path.split('/')
    let prefix = ''
    for (let index = 0; index < segments.length - 1; index++) {
      prefix = prefix ? `${prefix}/${segments[index]}` : segments[index]
      if (filePaths.has(pathKey(prefix))) invalid(`差量包包含文件与目录路径冲突：${file.path}`)
    }
  }
  files.sort(comparePaths)
  return { fromVersion, toVersion, appSize: value.appSize, files }
}

async function readDeltaArchive(archivePath: string): Promise<unknown> {
  if (typeof archivePath !== 'string' || archivePath.trim().length === 0) invalid('差量包路径无效')
  const info = await lstatOrNull(archivePath)
  if (!info || !info.isFile() || info.isSymbolicLink() ||
      !isFileSize(info.size) || info.size === 0 || info.size > MAX_COMPRESSED_BYTES) {
    invalid('差量包不是大小有效的普通文件')
  }
  let compressed: Buffer
  try {
    compressed = await fs.readFile(archivePath)
  } catch (error) {
    invalid(`无法读取差量包：${nameOf(error)}`)
  }
  if (compressed.length > MAX_COMPRESSED_BYTES) invalid('差量包超过大小上限')
  let json: Buffer
  try {
    json = gunzipSync(compressed, { maxOutputLength: MAX_JSON_BYTES })
  } catch {
    invalid('差量包无法解压或解压后过大')
  }
  if (json.length > MAX_JSON_BYTES) invalid('差量包内容超过大小上限')
  try {
    return JSON.parse(json.toString('utf8')) as unknown
  } catch {
    invalid('差量包不是有效的 JSON')
  }
}

function isSameOrInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function prepareTargetRoot(root: string): Promise<string> {
  if (typeof root !== 'string' || root.trim().length === 0) invalid('目标准备目录无效')
  const absolute = resolve(root)
  const existing = await lstatOrNull(absolute)
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      invalid('目标准备目录不是普通文件夹')
    }
  } else {
    try {
      await fs.mkdir(absolute, { recursive: true })
    } catch (error) {
      invalid(`无法创建目标准备目录：${nameOf(error)}`)
    }
  }
  const check = await lstatOrNull(absolute)
  if (!check || !check.isDirectory() || check.isSymbolicLink()) {
    invalid('目标准备目录不是普通文件夹')
  }
  const entries = await fs.readdir(absolute)
  if (entries.length > 0) invalid('目标准备目录必须为空')
  return absolute
}

async function ensureTargetParent(
  root: string,
  relativePath: string,
  checked: Set<string>
): Promise<string> {
  const segments = relativePath.split('/')
  let directory = root
  for (let index = 0; index < segments.length - 1; index++) {
    directory = join(directory, segments[index])
    if (checked.has(directory)) continue
    const info = await lstatOrNull(directory)
    if (info) {
      if (!info.isDirectory() || info.isSymbolicLink()) {
        invalid(`目标路径包含符号链接或非目录：${relativePath}`)
      }
    } else {
      try {
        await fs.mkdir(directory)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    checked.add(directory)
  }
  return directory
}

async function resolveBaseFile(
  base: string,
  file: DeltaFile,
  checkedDirectories: Set<string>
): Promise<string> {
  const segments = file.basePath.split('/')
  let directory = base
  for (let index = 0; index < segments.length - 1; index++) {
    directory = join(directory, segments[index])
    if (checkedDirectories.has(directory)) continue
    const info = await lstatOrNull(directory)
    if (!info || !info.isDirectory() || info.isSymbolicLink()) {
      invalid(`旧版本目录包含符号链接或缺失目录：${file.basePath}`)
    }
    checkedDirectories.add(directory)
  }
  const source = join(directory, segments[segments.length - 1])
  const info = await lstatOrNull(source)
  if (!info || !info.isFile() || info.isSymbolicLink()) {
    invalid(`本地旧版本文件缺失或不是普通文件：${file.basePath}`)
  }
  if (info.size !== file.size) {
    invalid(`本地旧版本文件大小已变化：${file.basePath}`)
  }
  return source
}

async function writeAll(handle: FileHandle, data: Buffer, position: number): Promise<void> {
  let written = 0
  while (written < data.length) {
    const result = await handle.write(data, written, data.length - written, position + written)
    if (result.bytesWritten <= 0) invalid('无法写入更新文件')
    written += result.bytesWritten
  }
}

async function writeChangedFile(
  root: string,
  file: DeltaFile,
  checkedDirectories: Set<string>
): Promise<void> {
  const encoded = file.data as string
  const data = Buffer.from(encoded, 'base64')
  if (data.length !== file.size || data.toString('base64') !== encoded ||
      sha256Bytes(data) !== file.sha256) {
    invalid(`差量包中的文件内容校验失败：${file.path}`)
  }
  const directory = await ensureTargetParent(root, file.path, checkedDirectories)
  const target = join(directory, file.path.split('/').at(-1) as string)
  const handle = await fs.open(target, 'wx')
  try {
    await writeAll(handle, data, 0)
    const info = await handle.stat()
    if (!info.isFile() || info.size !== file.size) {
      invalid(`写入目标文件失败：${file.path}`)
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function copyReusedFile(
  base: string,
  root: string,
  file: DeltaFile,
  baseDirectories: Set<string>,
  targetDirectories: Set<string>
): Promise<void> {
  const source = await resolveBaseFile(base, file, baseDirectories)
  const directory = await ensureTargetParent(root, file.path, targetDirectories)
  const target = join(directory, file.path.split('/').at(-1) as string)
  const input = await fs.open(source, 'r')
  let output: FileHandle | undefined
  try {
    const opened = await input.stat()
    if (!opened.isFile() || opened.size !== file.size) {
      invalid(`本地旧版本文件大小已变化：${file.basePath}`)
    }
    output = await fs.open(target, 'wx')
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK, Math.max(1, file.size)))
    let copied = 0
    while (copied < file.size) {
      const read = await input.read(
        buffer,
        0,
        Math.min(buffer.length, file.size - copied),
        copied
      )
      if (read.bytesRead === 0) break
      const chunk = buffer.subarray(0, read.bytesRead)
      digest.update(chunk)
      await writeAll(output, chunk, copied)
      copied += read.bytesRead
    }
    if (copied !== file.size) invalid(`本地旧版本文件不完整：${file.basePath}`)
    if (digest.digest('hex') !== file.sha256) {
      invalid(`本地旧版本文件已损坏：${file.basePath}`)
    }
    const written = await output.stat()
    if (!written.isFile() || written.size !== file.size) {
      invalid(`写入目标文件失败：${file.path}`)
    }
  } finally {
    await output?.close().catch(() => undefined)
    await input.close().catch(() => undefined)
  }
}

async function clearPreparedRoot(root: string): Promise<void> {
  try {
    for (const entry of await fs.readdir(root)) {
      await fs.rm(join(root, entry), { recursive: true, force: true })
    }
  } catch {
    /* The caller discards the staging directory when the delta is rejected. */
  }
}

/**
 * Rebuild the target tree from the exact old application plus a delta. Every
 * file is streamed into a new file (never hard-linked), and the complete target
 * is inventoried again before this function succeeds. Any mismatch rejects the
 * whole operation so the engine can fall back to the full application ZIP.
 */
export async function applyAppDelta(
  archivePath: string,
  baseRoot: string,
  preparedRoot: string,
  fromVersion: string,
  toVersion: string,
  expectedAppSize: number,
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  const expectedFrom = validateVersion(fromVersion, '当前安装版本')
  const expectedTo = validateVersion(toVersion, '目标更新版本')
  if (!isFileSize(expectedAppSize) || expectedAppSize > MAX_APP_BYTES) {
    invalid('更新清单中的应用大小无效')
  }
  const delta = parseDelta(await readDeltaArchive(archivePath))
  if (delta.fromVersion !== expectedFrom) {
    invalid(`差量包源版本为 ${delta.fromVersion}，当前安装版本为 ${expectedFrom}`)
  }
  if (delta.toVersion !== expectedTo) {
    invalid(`差量包目标版本为 ${delta.toVersion}，更新版本为 ${expectedTo}`)
  }
  if (delta.appSize !== expectedAppSize) {
    invalid('差量包的应用大小与更新清单不一致')
  }

  const base = await requireAppDirectory(baseRoot, '本地旧版本目录')
  if (typeof preparedRoot !== 'string' || preparedRoot.trim().length === 0) {
    invalid('目标准备目录无效')
  }
  const prepared = resolve(preparedRoot)
  if (isSameOrInside(base, prepared) || isSameOrInside(prepared, base)) {
    invalid('目标准备目录不能与旧版本目录重叠')
  }
  const target = await prepareTargetRoot(prepared)

  const total = expectedAppSize
  let reported = -1
  const report = (done: number): void => {
    if (done === reported) return
    reported = done
    try {
      onProgress?.(done, total)
    } catch {
      /* Progress reporting must not be able to reject a verified update. */
    }
  }

  const baseDirectories = new Set<string>([base])
  const targetDirectories = new Set<string>([target])
  let done = 0
  try {
    report(0)
    for (const file of delta.files) {
      if (file.data !== undefined) {
        await writeChangedFile(target, file, targetDirectories)
      } else {
        await copyReusedFile(base, target, file, baseDirectories, targetDirectories)
      }
      done = addFileSize(done, file.size)
      if (done < total) report(done)
    }
    if (done !== total) invalid('差量包没有生成完整的目标应用')

    const verified = await inventoryAppTree(target, expectedTo)
    if (verified.files.length !== delta.files.length) invalid('目标应用文件数量与差量包不一致')
    let verifiedSize = 0
    for (let index = 0; index < delta.files.length; index++) {
      const expected = delta.files[index]
      const actual = verified.files[index]
      if (actual.path !== expected.path || actual.size !== expected.size ||
          actual.sha256 !== expected.sha256) {
        invalid(`目标文件校验失败：${expected.path}`)
      }
      verifiedSize = addFileSize(verifiedSize, actual.size)
    }
    if (verifiedSize !== total) invalid('目标应用总大小与更新清单不一致')
    report(total)
  } catch (error) {
    await clearPreparedRoot(target)
    throw error
  }
}
