import { createWriteStream, createReadStream, promises as fs } from 'fs'
import { createHash } from 'crypto'
import { spawn } from 'child_process'
import { dirname, join } from 'path'

/**
 * Downloading / unpacking the update payload of a new launcher version.
 *
 * - The payload is a single archive (`KevinLauncher-<version>.zip`).
 * - `downloadPayload` fetches it over several connections, keeping one `.partN`
 *   file per connection so an interrupted or **paused** download continues with
 *   an HTTP `Range` request instead of starting over.
 * - `extractPayload` unpacks it with Windows' bundled bsdtar and reports the
 *   progress by watching the staging directory grow. This step is what the UI
 *   shows as "install progress" and it is deliberately not pausable.
 */

const USER_AGENT = 'KevinLauncher'
/** Parallel connections used for downloading. */
export const PARALLEL = 8
/** Attempts per connection before giving up (a flaky link may need several). */
const ATTEMPTS = 8
/** Base backoff between attempts (ms); grows linearly with the attempt number. */
const RETRY_DELAY = 700
/**
 * Per-attempt timeout. A stalled connection must not hang the whole download:
 * whatever arrived is kept and the attempt is retried with a `Range` request.
 */
const ATTEMPT_TIMEOUT = 45_000

export interface TransferProgress {
  transferred: number
  total: number
  bytesPerSecond: number
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function fileSize(path: string): Promise<number> {
  try {
    return (await fs.stat(path)).size
  } catch {
    return 0
  }
}

/** Hex SHA-256 of a file (used to verify the downloaded installer). */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/** Bytes currently stored under `dir` (used as the install progress). */
export async function directorySize(dir: string): Promise<number> {
  let total = 0
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) total += await directorySize(full)
    else if (entry.isFile()) total += await fileSize(full)
  }
  return total
}

/**
 * Downloads `urls[0]` into `dest` using `PARALLEL` connections. Each connection
 * has its own `.partN` file, so pausing (aborting `signal`) and resuming later
 * only transfers what is still missing. Every connection retries with a backoff
 * (moving on to the next URL, if any, when one is unreachable).
 */
export async function downloadPayload(
  urls: string[],
  dest: string,
  size: number,
  onProgress?: (progress: TransferProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  await fs.mkdir(dirname(dest), { recursive: true })
  const chunk = Math.ceil(size / PARALLEL)
  const parts: { path: string; start: number; end: number }[] = []
  for (let i = 0; i < PARALLEL; i++) {
    const start = i * chunk
    const end = Math.min(size, start + chunk)
    if (start >= end) break
    parts.push({ path: `${dest}.part${i}`, start, end })
  }

  const have = new Map<string, number>()
  for (const part of parts) have.set(part.path, await fileSize(part.path))
  const current = (): number => parts.reduce((sum, part) => sum + (have.get(part.path) ?? 0), 0)

  let previous = current()
  let previousTime = Date.now()
  const timer = onProgress
    ? setInterval(() => {
        const now = Date.now()
        const value = current()
        onProgress({
          transferred: value,
          total: size,
          bytesPerSecond: (value - previous) / Math.max(0.001, (now - previousTime) / 1000)
        })
        previous = value
        previousTime = now
      }, 400)
    : null

  try {
    await Promise.all(
      parts.map(async (part) => {
        let bytes = have.get(part.path) ?? 0
        for (let attempt = 0; ; attempt++) {
          try {
            if (bytes >= part.end - part.start) return
            // Abort a stalled connection after ATTEMPT_TIMEOUT (or on pause).
            const timed = AbortSignal.timeout(ATTEMPT_TIMEOUT)
            const attemptSignal = signal ? AbortSignal.any([signal, timed]) : timed
            const response = await fetch(urls[Math.min(attempt, urls.length - 1)], {
              headers: {
                Range: `bytes=${part.start + bytes}-${part.end - 1}`,
                accept: 'application/octet-stream',
                'user-agent': USER_AGENT
              },
              signal: attemptSignal
            })
            if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
            const handle = await fs.open(part.path, 'a')
            try {
              const reader = response.body.getReader()
              for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                await handle.write(value)
                bytes += value.length
                have.set(part.path, bytes)
              }
            } finally {
              await handle.close()
            }
            if (bytes < part.end - part.start) throw new Error('下载不完整')
            return
          } catch (error) {
            if (signal?.aborted) throw error
            if (attempt >= ATTEMPTS - 1) throw error
            await delay(RETRY_DELAY * (attempt + 1))
            bytes = await fileSize(part.path)
            have.set(part.path, bytes)
          }
        }
      })
    )
  } finally {
    if (timer) clearInterval(timer)
  }

  // Join the parts into the final archive.
  const output = createWriteStream(dest)
  try {
    for (const part of parts) {
      await new Promise<void>((resolve, reject) => {
        const input = createReadStream(part.path)
        input.on('data', (chunkData) => output.write(chunkData))
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
  // Final tick so the UI always reaches 100 %.
  onProgress?.({ transferred: size, total: size, bytesPerSecond: 0 })
}

/**
 * Unpacks `archive` into `destDir` with bsdtar, reporting progress as the
 * destination grows towards `expectedBytes`. Not cancellable by design.
 */
export async function extractPayload(
  archive: string,
  destDir: string,
  expectedBytes: number,
  onProgress?: (transferred: number, total: number) => void
): Promise<void> {
  await fs.rm(destDir, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(destDir, { recursive: true })

  let previous = 0
  const timer = setInterval(() => {
    void directorySize(destDir).then((size) => {
      previous = size
      onProgress?.(size, expectedBytes)
    })
  }, 500)

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('tar', ['-xf', archive, '-C', destDir], {
        windowsHide: true,
        stdio: 'ignore'
      })
      child.on('error', reject)
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`解压失败（tar 退出码 ${code}）`))
      )
    })
    onProgress?.(expectedBytes, expectedBytes)
  } finally {
    clearInterval(timer)
    void previous
  }
}
