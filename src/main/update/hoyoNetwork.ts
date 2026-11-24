import { AsyncLocalStorage } from 'node:async_hooks'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { workerData } from 'node:worker_threads'
import { decompress } from 'fzstd'
import { writeFileAtomic } from '../services/atomicFile'
import { md5Bytes, sha256Bytes } from '../services/hash'
import { openJsonStore } from '../services/jsonStore'
import { throttle } from '../services/rateLimit'
import { openWritableGameFile } from '../services/writableGameFile'
import { fetchHoYoResource } from './hoyoTransportBridge'

// Scighost/Starward@747ed10: AppConfig.ServiceProvider, RpcRunner,
// GameInstall.Service.HttpService / DownloadService, and HoYoPlayService.
type HoYoContext = { directory: string; role: 'desktop' | 'runner'; installedVersion: string }
const context = new AsyncLocalStorage<HoYoContext>()
const HTTP_TIMEOUT = 100_000
const DEFAULT_CACHE_AGE = 5 * 60_000
const FALLBACK_AGE = 90 * 24 * 60 * 60_000
const FALLBACK_RETRY_DELAY = 10_000
const FALLBACK_TIMEOUT = 5_000
const DOWNLOAD_BUFFER_SIZE = 8192

export function withHoYoNetwork<T>(
  userData: string, role: HoYoContext['role'], operation: () => Promise<T>, installedVersion = ''
): Promise<T> {
  return context.run({ directory: join(userData, 'hoyo-cache'), role, installedVersion }, operation)
}

export class HoYoHttpError extends Error {
  constructor(readonly status: number) {
    super(`HoYoPlay HTTP ${status}`)
  }
}

class HoYoTimeoutError extends Error {}

/** Polly TimeSpan default with MaxRetryAttempts=2 and linear backoff. */
export async function retryHoYo<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted()
    try {
      return await operation()
    } catch (error) {
      if (attempt >= 2 || signal?.aborted || error instanceof HoYoTimeoutError) throw error
      await delay(2_000 * (attempt + 1), undefined, { signal })
    }
  }
}

/** A single HttpClient request. Polly retries belong around the calling step. */
export async function hoyoFetch(
  url: string | URL, init?: RequestInit, headersOnly = false
): Promise<Response> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new HoYoTimeoutError('HoYoPlay 请求超时')), HTTP_TIMEOUT)
  timer.unref()
  const signal = init?.signal ? AbortSignal.any([timeout.signal, init.signal]) : timeout.signal
  const scope = context.getStore()
  const product = scope?.role === 'runner' ? 'KevinLauncher.Updater' : 'KevinLauncher'
  const version = scope?.installedVersion
  const headers = new Headers(init?.headers)
  headers.set('User-Agent', version && /^[\w.+-]+$/.test(version) ? `${product}/${version}` : product)
  try {
    const response = await fetchHoYoResource(scope?.role ?? 'desktop', url, { ...init, headers, signal })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new HoYoHttpError(response.status)
    }
    if (headersOnly || !response.body) return response
    // HttpClient's default completion mode includes the small JSON body.
    return new Response(await response.arrayBuffer(), { headers: response.headers, status: response.status })
  } catch (error) {
    if (timeout.signal.aborted) throw timeout.signal.reason
    throw error
  } finally {
    clearTimeout(timer)
  }
}

// HttpService is a singleton. Keep the one-minute window shared between the
// main install flow and Sophon workers, including concurrent game tasks.
export const hoyoPortBudget: SharedArrayBuffer = workerData?.hoyoPortBudget ?? new SharedArrayBuffer(8)
const permits = new BigUint64Array(hoyoPortBudget)
function acquirePortRetry(): boolean {
  for (;;) {
    const previous = Atomics.load(permits, 0)
    const now = Date.now()
    const windowEnd = Number(previous >> 4n)
    const count = Number(previous & 15n)
    if (now < windowEnd && count >= 10) return false
    const next = now < windowEnd ? previous + 1n : (BigInt(now + 60_000) << 4n) + 1n
    if (Atomics.compareExchange(permits, 0, previous, next) === previous) return true
  }
}

export async function getGameDownload(
  url: string, options: { range?: string; signal?: AbortSignal } = {}
): Promise<Response> {
  const { signal, range } = options
  const init = { signal, headers: range ? { Range: range } : undefined }
  let response: Response | undefined
  try {
    for (let request = 0; request < 2; request++) {
      const next = await hoyoFetch(url, init, true)
      await response?.body?.cancel().catch(() => undefined)
      response = next
      if (!response.url || !new URL(response.url).port || !acquirePortRetry()) break
      // The upstream loop applies the port window after both responses, even
      // when the second response is the last permitted request in this call.
      await delay(300, undefined, { signal })
    }
    return response!
  } catch (error) {
    await response?.body?.cancel().catch(() => undefined)
    throw error
  }
}

async function* responseChunks(response: Response, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) return
  try {
    for (;;) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) return
      for (let start = 0; start < value.length; start += DOWNLOAD_BUFFER_SIZE) {
        const chunk = value.subarray(start, start + DOWNLOAD_BUFFER_SIZE)
        await throttle(chunk.length, signal)
        yield chunk
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

export async function* streamGameBytes(url: string, signal: AbortSignal, progress: (bytes: number) => void): AsyncGenerator<Uint8Array> {
  const response = await getGameDownload(url, { signal })
  let received = 0
  for await (const bytes of responseChunks(response, signal)) {
    received += bytes.length
    progress(received)
    yield bytes
  }
}

export async function downloadGameBytes(url: string, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of responseChunks(await getGameDownload(url, { signal }), signal)) chunks.push(chunk)
  return Buffer.concat(chunks)
}

interface GameDownloadOptions {
  url: string
  path: string
  size: number
  /** The source range starts here. Destinations always start at local byte 0. */
  offset?: number
  signal?: AbortSignal
  onProgress?: (bytes: number) => void
}

/** One attempt, retaining the partial file for the calling step's Polly retry. */
export async function downloadGameFile(options: GameDownloadOptions): Promise<void> {
  const { url, path, size, offset, signal, onProgress } = options
  signal?.throwIfAborted()
  if (!Number.isSafeInteger(size) || size < 0 ||
      (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + size)))) {
    throw new Error('无效的游戏资源大小或范围')
  }
  await fs.mkdir(dirname(path), { recursive: true })
  const file = await openWritableGameFile(path)
  try {
    const have = (await file.stat()).size
    if (have >= size) {
      await file.truncate(size)
      onProgress?.(size)
      return
    }
    const range = offset === undefined ? (have ? `bytes=${have}-` : undefined)
      : `bytes=${offset + have}-${offset + size - 1}`
    const response = await getGameDownload(url, { range, signal })
    const from = response.headers.get('content-range')?.match(/^bytes (\d+)-\d+\/(?:\d+|\*)$/i)?.[1]
    let position = response.status === 206
      ? (from === undefined ? have : Number(from) - (offset ?? 0))
      : 0
    try {
      onProgress?.(position)
      for await (const bytes of responseChunks(response, signal)) {
        let written = 0
        while (written < bytes.length) {
          signal?.throwIfAborted()
          const result = await file.write(bytes, written, bytes.length - written, position + written)
          if (result.bytesWritten === 0) throw new Error('未能写入游戏资源')
          written += result.bytesWritten
        }
        position += written
        onProgress?.(position)
      }
    } catch (error) {
      onProgress?.(0)
      throw error
    }
  } finally {
    await file.close()
  }
}

interface ManifestSpec {
  id: string
  url: string
  compressed: boolean
  uncompressedSize?: number
  md5?: string
}

/** Starward caches the verified, uncompressed protobuf by manifest ID. */
export async function downloadManifest(spec: ManifestSpec, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted()
  const scope = context.getStore()
  const checksum = spec.md5?.toLowerCase()
  if (scope && (!checksum || !Number.isSafeInteger(spec.uncompressedSize) || spec.uncompressedSize! < 0 ||
      !/^[a-f0-9]{32}$/.test(checksum) || !/^[\w-]+$/.test(spec.id))) {
    throw new Error('Sophon 清单缺少有效的 ID、大小或 MD5')
  }
  const path = scope ? join(scope.directory, 'game', spec.id) : undefined
  if (path) {
    const existing = await fs.readFile(path, { signal }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return null
    })
    if (existing?.length === spec.uncompressedSize && existing && md5Bytes(existing) === checksum) {
      return existing
    }
  }
  const response = await hoyoFetch(spec.url, { signal }, true)
  const raw = new Uint8Array(await response.arrayBuffer())
  const plain = spec.compressed ? decompress(raw) : raw
  signal?.throwIfAborted()
  if (checksum && md5Bytes(plain) !== checksum) {
    throw new Error(`Sophon 清单 MD5 校验失败: ${spec.id}`)
  }
  if (path) await writeFileAtomic(path, plain)
  return plain
}

type MetadataEntry = { updated: number; value: unknown }
type MetadataFactory<T> = (signal?: AbortSignal) => Promise<T>
const metadata = new Map<string, MetadataEntry>()
const refreshes = new Map<string, Promise<MetadataEntry>>()
const retryAfter = new Map<string, number>()

function interruptible<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  if (signal.aborted) {
    void work.catch(() => undefined)
    return Promise.reject(signal.reason)
  }
  return new Promise((resolve, reject) => {
    const stop = (): void => reject(signal.reason)
    signal.addEventListener('abort', stop, { once: true })
    void work.then(
      value => { signal.removeEventListener('abort', stop); resolve(value) },
      error => { signal.removeEventListener('abort', stop); reject(error) }
    )
  })
}

/** Launcher-scoped keys mirror HoYoPlayService's GameInfo, branch and build queries. */
export async function getHoYoMetadata<T>(
  key: string,
  factory: MetadataFactory<T>,
  signal?: AbortSignal,
  options?: { permanentFailSafe?: boolean }
): Promise<T> {
  signal?.throwIfAborted()
  const scope = context.getStore()
  if (!scope) return factory(signal)
  const desktop = scope.role === 'desktop'
  const cacheKey = `${scope.directory}\0${scope.role}\0${key}`
  const path = desktop ? join(scope.directory, 'metadata', sha256Bytes(Buffer.from(key)) + '.json') : null
  let entry = metadata.get(cacheKey)
  let writable = path !== null
  if (!entry && path) {
    const loaded = await openJsonStore<MetadataEntry | null>(path, () => null, 'HoYoPlay metadata')
    signal?.throwIfAborted()
    writable = loaded.writable
    if (loaded.data && Number.isFinite(loaded.data.updated) && 'value' in loaded.data) {
      entry = loaded.data
      metadata.set(cacheKey, entry)
    }
  }

  function refresh(token?: AbortSignal): Promise<MetadataEntry> {
    const existing = refreshes.get(cacheKey)
    if (existing) return existing
    const task = (async (): Promise<MetadataEntry> => {
      const value = await factory(token)
      token?.throwIfAborted()
      const next = { updated: Date.now(), value }
      if (path && writable) await writeFileAtomic(path, JSON.stringify(next)).catch(() => undefined)
      metadata.set(cacheKey, next)
      retryAfter.delete(cacheKey)
      return next
    })().finally(() => refreshes.delete(cacheKey))
    refreshes.set(cacheKey, task)
    return task
  }

  const age = entry ? Date.now() - entry.updated : Infinity
  const blockedUntil = retryAfter.get(cacheKey) ?? 0
  const canRefresh = Date.now() >= blockedUntil
  if (entry && age < DEFAULT_CACHE_AGE) {
    const eagerThreshold = DEFAULT_CACHE_AGE * (desktop ? 0.1 : 0.6)
    if (age >= eagerThreshold && canRefresh) {
      void refresh().catch(() => retryAfter.set(cacheKey, Date.now() + FALLBACK_RETRY_DELAY))
    }
    return entry.value as T
  }

  const work = (): Promise<MetadataEntry> => interruptible(refresh(signal), signal)
  if (!entry || !desktop || (!options?.permanentFailSafe && age >= FALLBACK_AGE)) {
    return (await work()).value as T
  }
  if (!canRefresh) return entry.value as T

  const deadline = new AbortController()
  try {
    const refreshed = await Promise.race([
      work(),
      delay(FALLBACK_TIMEOUT, null, { signal: deadline.signal })
    ])
    if (refreshed) return refreshed.value as T
  } catch (error) {
    if (signal?.aborted) throw error
  } finally {
    deadline.abort()
  }
  retryAfter.set(cacheKey, Date.now() + FALLBACK_RETRY_DELAY)
  return entry.value as T
}
