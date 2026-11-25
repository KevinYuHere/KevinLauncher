import { createWriteStream, createReadStream, promises as fs } from 'fs'
import { spawn } from 'child_process'
import { dirname, join } from 'path'
import { pipeline } from 'stream/promises'
import { setTimeout as wait } from 'timers/promises'
import { throttle } from './rateLimit'
import { sha256File } from './hash'
import { isPositiveFileSize, isSha256, matchesUpdateTransfer } from './appUpdateManifest'
import { requireDiskSpace } from './diskSpace'

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
 * Idle timeout while obtaining headers or waiting for the next body chunk.
 * Waiting for the global bandwidth queue does not count as a network stall.
 */
const ATTEMPT_TIMEOUT = 45_000

export interface TransferProgress {
  transferred: number
  total: number
  bytesPerSecond: number
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await fs.stat(path)).size
  } catch {
    return 0
  }
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


const headers = { accept: 'application/octet-stream', 'user-agent': USER_AGENT }
type Part = { path: string; start: number; end: number; bytes: number }
type ReadWithTimeout = <T>(operation: () => Promise<T>) => Promise<T>

class RangeIgnored extends Error {}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

/** Only the exact requested range is eligible to extend a saved part. */
async function checkResponse(
  response: Response,
  expectedBytes: number,
  range?: { start: number; end: number; size: number }
): Promise<void> {
  const declared = response.headers.get('content-range')
  if (!response.body || !matchesUpdateTransfer(response.status, response.headers, expectedBytes, range)) {
    await cancelBody(response)
    throw new Error(`下载响应无效（HTTP ${response.status} / Content-Range: ${declared ?? '无'}）`)
  }
}

async function appendResponse(
  response: Response,
  part: Part,
  read: ReadWithTimeout,
  signal: AbortSignal
): Promise<void> {
  const offset = part.bytes
  const reader = response.body!.getReader()
  try {
    const file = await fs.open(part.path, offset === 0 ? 'w' : 'a')
    try {
      for (;;) {
        const { value, done } = await read(() => reader.read())
        if (done) break
        if (part.start + part.bytes + value.length > part.end) {
          await file.truncate(offset)
          throw new Error('下载响应超过请求范围')
        }
        await throttle(value.length, signal)
        await file.writeFile(value)
        part.bytes += value.length
      }
    } finally {
      await file.close()
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    part.bytes = await fileSize(part.path)
  }
  if (part.bytes !== part.end - part.start) throw new Error('下载不完整')
}

async function attemptRequest<T>(
  urls: string[],
  attempts: number,
  signal: AbortSignal,
  range: (() => string | undefined) | undefined,
  consume: (
    response: Response,
    read: ReadWithTimeout,
    attemptSignal: AbortSignal
  ) => Promise<T>
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    const timeout = new AbortController()
    const attemptSignal = AbortSignal.any([signal, timeout.signal])
    const read = async <R>(operation: () => Promise<R>): Promise<R> => {
      const timer = setTimeout(() => timeout.abort(new Error('下载连接超时')), ATTEMPT_TIMEOUT)
      try {
        return await operation()
      } finally {
        clearTimeout(timer)
      }
    }
    let response: Response | undefined
    try {
      const url = urls[Math.min(attempt, urls.length - 1)]
      const requestedRange = range?.()
      response = await read(() => fetch(url, {
        headers: requestedRange ? { ...headers, range: requestedRange } : headers,
        signal: attemptSignal
      }))
      return await consume(response, read, attemptSignal)
    } catch (error) {
      if (response && !response.bodyUsed) await cancelBody(response)
      if (error instanceof RangeIgnored || signal.aborted || attempt >= attempts - 1) throw error
      await wait(RETRY_DELAY * (attempt + 1), undefined, { signal })
    }
  }
}

async function assembleParts(parts: Part[], dest: string, signal: AbortSignal): Promise<void> {
  const temporary = `${dest}.joining`
  async function* contents(): AsyncGenerator<Buffer> {
    for (const part of parts) {
      for await (const chunk of createReadStream(part.path)) yield chunk as Buffer
    }
  }
  try {
    await pipeline(contents(), createWriteStream(temporary), { signal })
    await fs.rename(temporary, dest)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function removePayloadDownload(dest: string): Promise<void> {
  const names = [dest, `${dest}.joining`, `${dest}.full`,
    ...Array.from({ length: PARALLEL }, (_, index) => `${dest}.part${index}`)]
  await Promise.all(names.map(path => fs.rm(path, { force: true })))
}

/** Reuse only a verified complete asset, including after a pause or restart. */
export async function verifyPayloadDownload(
  dest: string,
  size: number,
  sha256: string
): Promise<boolean> {
  if (!isPositiveFileSize(size) || !isSha256(sha256)) throw new Error('下载校验信息无效')
  const stat = await fs.stat(dest).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (!stat) return false
  if (stat.isFile() && stat.size === size && (await sha256File(dest)) === sha256.toLowerCase()) {
    return true
  }
  await removePayloadDownload(dest)
  return false
}

/**
 * Probes range support with one request before opening parallel connections.
 * Completed, bounded parts survive pause, retry and output assembly failures.
 */
export async function downloadPayload(
  urls: string[],
  dest: string,
  size: number,
  onProgress?: (progress: TransferProgress) => void,
  signal: AbortSignal = new AbortController().signal,
  attempts = ATTEMPTS
): Promise<void> {
  signal.throwIfAborted()
  if (!Number.isSafeInteger(size) || size <= 0 || !urls.length) throw new Error('下载地址或大小无效')

  await fs.mkdir(dirname(dest), { recursive: true })
  const chunk = Math.ceil(size / PARALLEL)
  const parts: Part[] = []
  for (let start = 0; start < size; start += chunk) {
    const path = `${dest}.part${parts.length}`
    const end = Math.min(size, start + chunk)
    let bytes = await fileSize(path)
    if (bytes > end - start) {
      await fs.rm(path)
      bytes = 0
    }
    parts.push({ path, start, end, bytes })
  }
  const whole = { path: `${dest}.full`, start: 0, end: size, bytes: 0 }
  // The saved ranges and the assembled file can coexist during verification.
  // Existing reusable bytes already consume disk space.
  const reused = parts.reduce((sum, part) => sum + part.bytes, 0)
  await requireDiskSpace([{ path: dest, bytes: size * 2 - reused }])
  let singleConnection = false
  const current = (): number => singleConnection ? whole.bytes : parts.reduce((sum, part) => sum + part.bytes, 0)
  let previous = current()
  let previousTime = Date.now()
  const timer = onProgress && setInterval(() => {
    const now = Date.now()
    const value = current()
    onProgress({
      transferred: value,
      total: size,
      bytesPerSecond: Math.max(0, value - previous) / Math.max(0.001, (now - previousTime) / 1000)
    })
    previous = value
    previousTime = now
  }, 400)

  const attemptWhole = async (
    response: Response,
    read: ReadWithTimeout,
    requestSignal: AbortSignal
  ): Promise<void> => {
    singleConnection = true
    whole.bytes = 0
    await checkResponse(response, size)
    await appendResponse(response, whole, read, requestSignal)
  }

  const batch = new AbortController()
  const batchSignal = AbortSignal.any([signal, batch.signal])
  let rangesAccepted = false
  const transfer = (part: Part, ready?: () => void): Promise<void> =>
    attemptRequest(
      urls,
      attempts,
      batchSignal,
      () => singleConnection ? undefined : `bytes=${part.start + part.bytes}-${part.end - 1}`,
      async (response, read, requestSignal) => {
        // Before starting other parts, reuse the already-open full response.
        if (singleConnection || (response.status === 200 && ready && !rangesAccepted)) {
          await attemptWhole(response, read, requestSignal)
          return
        }
        if (response.status === 200) throw new RangeIgnored()
        const start = part.start + part.bytes
        await checkResponse(response, part.end - start, { start, end: part.end, size })
        rangesAccepted = true
        ready?.()
        await appendResponse(response, part, read, requestSignal)
      }
    )

  try {
    const missing = parts.filter(part => part.bytes < part.end - part.start)
    if (missing.length) {
      const [first, ...rest] = missing
      let others: Promise<void>[] = []
      // Capture the first error and drain every aborted stream before retrying
      // or letting another invocation continue the same files.
      let failed: unknown
      const track = (work: Promise<void>): Promise<void> => work.catch(error => {
        failed ??= error
        batch.abort()
      })
      const firstWork = track(transfer(first, () => {
        if (!others.length) others = rest.map(part => track(transfer(part)))
      }))
      await firstWork
      await Promise.all(others)
      if (failed instanceof RangeIgnored) {
        await attemptRequest(urls, attempts, signal, undefined, attemptWhole)
      } else if (failed) {
        throw failed
      }
    }
    signal.throwIfAborted()
    if (singleConnection) await fs.rename(whole.path, dest)
    else await assembleParts(parts, dest, signal)
    await Promise.all(parts.map(part => fs.rm(part.path, { force: true }).catch(() => undefined)))
    onProgress?.({ transferred: size, total: size, bytesPerSecond: 0 })
  } finally {
    if (timer) clearInterval(timer)
    await fs.rm(whole.path, { force: true }).catch(() => undefined)
  }
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
  await fs.rm(destDir, { recursive: true, force: true })
  await fs.mkdir(destDir, { recursive: true })

  let scanning = false
  let finished = false
  const timer = setInterval(() => {
    if (scanning) return
    scanning = true
    void directorySize(destDir).then((size) => {
      if (!finished) onProgress?.(size, expectedBytes)
      scanning = false
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
    finished = true
    clearInterval(timer)
  }
}
