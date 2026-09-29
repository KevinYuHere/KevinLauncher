import { createReadStream, createWriteStream, promises as fs } from 'fs'
import { createHash } from 'crypto'
import { gunzipSync } from 'zlib'
import { dirname, join } from 'path'

/**
 * Installer downloader for the launcher's self-update.
 *
 * - **Differential** (NSIS blockmap): when the previously downloaded installer
 *   is still cached, only the byte ranges that changed are fetched; unchanged
 *   regions are copied from the old installer. This is what avoids re-downloading
 *   the huge parts that never change (Electron/Chromium, node runtime, …).
 * - **Multi-threaded**: everything is fetched over `PARALLEL` connections.
 * - **Resumable**: a plain (full) download keeps one `.partN` file per connection
 *   and continues with an HTTP `Range` request after an interruption.
 * - **Retried**: each connection retries `ATTEMPTS` times with a backoff.
 * - The result is verified against the SHA-512 from `latest.yml`; on any failure
 *   the caller can fall back to opening the release page.
 */

const USER_AGENT = 'KevinLauncher'
/** Parallel connections used for downloading. */
export const PARALLEL = 8
/** Attempts per connection before giving up. */
const ATTEMPTS = 3

export interface InstallerProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface BlockMapFile {
  name: string
  offset: number
  checksums: string[]
  sizes: number[]
}
export interface BlockMap {
  version: string
  files: BlockMapFile[]
}

export interface DiffPlan {
  /** Ranges taken from the previously downloaded installer. */
  copy: { from: number; to: number; size: number }[]
  /** Ranges that must be downloaded from the new installer. */
  download: { start: number; end: number }[]
  /** Bytes that need to be downloaded (excludes copied ranges). */
  downloadBytes: number
  /** Bytes reused from the local old installer. */
  copiedBytes: number
}

export interface InstallerSource {
  url: string
  blockmapUrl: string | null
  size: number
  sha512: string | null
  fileName: string
}

export interface CachedInstaller {
  path: string
  blockmapPath: string
}

// ---------------------------------------------------------------- block map

export function parseBlockMap(buffer: Buffer): BlockMap {
  let text: string
  try {
    text = gunzipSync(buffer).toString('utf8')
  } catch {
    // Some builds store the block map uncompressed.
    text = buffer.toString('utf8')
  }
  const parsed = JSON.parse(text) as BlockMap
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error('blockmap 格式不正确')
  }
  return parsed
}

/**
 * Works out which parts of the new installer already exist in the old one.
 * Blocks are matched by their blockmap checksum (both maps come from the same
 * generator, so equal content yields equal checksums — no re-hashing needed).
 */
export function planDiff(oldMap: BlockMap, newMap: BlockMap): DiffPlan {
  const lookup = new Map<string, { offset: number; size: number }[]>()
  for (const file of oldMap.files) {
    let offset = file.offset
    for (let i = 0; i < file.sizes.length; i++) {
      const checksum = file.checksums[i]
      const size = file.sizes[i]
      if (checksum) {
        const list = lookup.get(checksum)
        if (list) list.push({ offset, size })
        else lookup.set(checksum, [{ offset, size }])
      }
      offset += size
    }
  }

  const plan: DiffPlan = { copy: [], download: [], downloadBytes: 0, copiedBytes: 0 }
  const file = newMap.files[0]
  let offset = file.offset
  for (let i = 0; i < file.sizes.length; i++) {
    const size = file.sizes[i]
    const match = file.checksums[i]
      ? lookup.get(file.checksums[i])?.find((candidate) => candidate.size === size)
      : undefined
    if (match) {
      plan.copy.push({ from: match.offset, to: offset, size })
      plan.copiedBytes += size
    } else {
      const last = plan.download[plan.download.length - 1]
      if (last && last.end === offset) last.end = offset + size
      else plan.download.push({ start: offset, end: offset + size })
      plan.downloadBytes += size
    }
    offset += size
  }
  return plan
}

// ------------------------------------------------------------------ helpers

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function fileSize(path: string): Promise<number> {
  try {
    return (await fs.stat(path)).size
  } catch {
    return 0
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

async function sha512Base64(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('base64')))
    stream.on('error', reject)
  })
}

async function fetchBuffer(url: string, signal?: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/** Emits aggregate progress on a timer while `total` bytes are being fetched. */
function reportProgress(
  total: number,
  current: () => number,
  onProgress?: (progress: InstallerProgress) => void
): () => void {
  if (!onProgress) return () => {}
  let previous = current()
  let previousTime = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    const value = current()
    const seconds = Math.max(0.001, (now - previousTime) / 1000)
    const speed = (value - previous) / seconds
    previous = value
    previousTime = now
    onProgress({
      percent: total > 0 ? Math.min(100, (value / total) * 100) : 0,
      transferred: value,
      total,
      bytesPerSecond: speed
    })
  }, 400)
  return () => clearInterval(timer)
}

/** Reads one HTTP range straight into `handle` at its absolute offset. */
async function fetchRangeInto(
  handle: import('fs').promises.FileHandle,
  url: string,
  start: number,
  end: number,
  onDelta: (bytes: number) => void,
  signal?: AbortSignal
): Promise<void> {
  let attempt = 0
  for (;;) {
    try {
      const response = await fetch(url, {
        headers: { Range: `bytes=${start}-${end - 1}`, 'user-agent': USER_AGENT },
        signal
      })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const reader = response.body.getReader()
      let offset = start
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        await handle.write(value, 0, value.length, offset)
        offset += value.length
        onDelta(value.length)
      }
      if (offset !== end) throw new Error('下载长度不匹配')
      return
    } catch (error) {
      if (signal?.aborted) throw error
      attempt++
      if (attempt >= ATTEMPTS) throw error
      await delay(400 * attempt)
    }
  }
}

// ----------------------------------------------------------------- download

/**
 * Plain download over `PARALLEL` connections. Each connection keeps its own
 * `.partN` file, so an interrupted download resumes from where it stopped.
 */
async function downloadFull(
  source: InstallerSource,
  dest: string,
  onProgress?: (progress: InstallerProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  await fs.mkdir(dirname(dest), { recursive: true })
  const chunkSize = Math.ceil(source.size / PARALLEL)
  const parts: { path: string; start: number; end: number }[] = []
  for (let i = 0; i < PARALLEL; i++) {
    const start = i * chunkSize
    const end = Math.min(source.size, start + chunkSize)
    if (start >= end) break
    parts.push({ path: `${dest}.part${i}`, start, end })
  }

  const done = new Map<string, number>()
  await Promise.all(parts.map(async (part) => done.set(part.path, await fileSize(part.path))))
  const current = (): number => parts.reduce((sum, part) => sum + (done.get(part.path) ?? 0), 0)
  const stop = reportProgress(source.size, current, onProgress)

  try {
    await Promise.all(
      parts.map(async (part) => {
        let have = done.get(part.path) ?? 0
        for (let attempt = 0; ; attempt++) {
          try {
            if (have >= part.end - part.start) return
            const response = await fetch(source.url, {
              headers: {
                Range: `bytes=${part.start + have}-${part.end - 1}`,
                'user-agent': USER_AGENT
              },
              signal
            })
            if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
            const reader = response.body.getReader()
            const handle = await fs.open(part.path, 'a')
            try {
              for (;;) {
                const { done: finished, value } = await reader.read()
                if (finished) break
                await handle.write(value)
                have += value.length
                done.set(part.path, have)
              }
            } finally {
              await handle.close()
            }
            if (have < part.end - part.start) throw new Error('下载不完整')
            return
          } catch (error) {
            if (signal?.aborted) throw error
            if (attempt >= ATTEMPTS - 1) throw error
            await delay(400 * (attempt + 1))
            have = await fileSize(part.path)
            done.set(part.path, have)
          }
        }
      })
    )
  } finally {
    stop()
  }

  // Concatenate the parts (in range order) into the final installer.
  const output = createWriteStream(dest)
  try {
    for (const part of parts) {
      await new Promise<void>((resolve, reject) => {
        const input = createReadStream(part.path)
        input.on('data', (chunk) => output.write(chunk))
        input.on('end', resolve)
        input.on('error', reject)
      })
    }
    await new Promise<void>((resolve, reject) => {
      output.on('finish', resolve)
      output.on('error', reject)
      output.end()
    })
  } finally {
    for (const part of parts) await fs.rm(part.path, { force: true }).catch(() => {})
  }
}

/** Rebuilds the installer: fetched ranges in parallel, the rest copied locally. */
async function downloadDifferential(
  source: InstallerSource,
  dest: string,
  plan: DiffPlan,
  oldInstallerPath: string,
  onProgress?: (progress: InstallerProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  await fs.mkdir(dirname(dest), { recursive: true })
  await fs.rm(dest, { force: true })
  const output = await fs.open(dest, 'w')
  let transferred = 0
  const stop = reportProgress(source.size, () => transferred, onProgress)
  try {
    await output.truncate(source.size)
    const queue = [...plan.download]
    const workers = Math.max(1, Math.min(PARALLEL, queue.length))
    await Promise.all(
      Array.from({ length: workers }, async () => {
        for (;;) {
          const range = queue.shift()
          if (!range) return
          await fetchRangeInto(
            output,
            source.url,
            range.start,
            range.end,
            (bytes) => {
              transferred += bytes
            },
            signal
          )
        }
      })
    )
    // Fill the unchanged regions straight from the previous installer.
    const previous = await fs.open(oldInstallerPath, 'r')
    try {
      for (const range of plan.copy) {
        const buffer = Buffer.allocUnsafe(range.size)
        await previous.read(buffer, 0, range.size, range.from)
        await output.write(buffer, 0, range.size, range.to)
      }
    } finally {
      await previous.close()
    }
  } finally {
    stop()
    await output.close()
  }
}

/** Downloads (differentially when possible) and verifies the new installer. */
export async function downloadInstaller(
  source: InstallerSource,
  cacheDir: string,
  previous: CachedInstaller | null,
  onProgress?: (progress: InstallerProgress) => void,
  signal?: AbortSignal
): Promise<string> {
  await fs.mkdir(cacheDir, { recursive: true })
  const dest = join(cacheDir, source.fileName)
  const blockmapPath = `${dest}.blockmap`

  try {
    if (source.blockmapUrl && previous && (await exists(previous.path))) {
      try {
        const oldRaw = await fs.readFile(previous.blockmapPath)
        const newRaw = await fetchBuffer(source.blockmapUrl, signal)
        const plan = planDiff(parseBlockMap(oldRaw), parseBlockMap(newRaw))
        // Only worth it when it actually saves a meaningful amount.
        if (plan.downloadBytes > 0 && plan.copiedBytes > 0) {
          await downloadDifferential(source, dest, plan, previous.path, onProgress, signal)
          if (await matches(dest, source)) {
            await fs.writeFile(blockmapPath, newRaw)
            return dest
          }
        }
      } catch {
        /* fall through to the full download */
      }
      await fs.rm(dest, { force: true }).catch(() => {})
    }

    await downloadFull(source, dest, onProgress, signal)
    if (!(await matches(dest, source))) {
      await fs.rm(dest, { force: true }).catch(() => {})
      throw new Error('安装包校验失败')
    }
    if (source.blockmapUrl) {
      try {
        await fs.writeFile(blockmapPath, await fetchBuffer(source.blockmapUrl, signal))
      } catch {
        /* the block map is only needed for the next differential update */
      }
    }
    return dest
  } catch (error) {
    await fs.rm(dest, { force: true }).catch(() => {})
    throw error
  }
}

/** True when the file exists, has the expected size and matches the SHA-512. */
export async function matches(path: string, source: InstallerSource): Promise<boolean> {
  if ((await fileSize(path)) !== source.size) return false
  if (!source.sha512) return true
  return (await sha512Base64(path)) === source.sha512
}
