import { perf } from './perfProbe'

export interface PreparedWallpaper {
  readonly url: string
  readonly width: number
  readonly height: number
  readonly inUse: boolean
  retain(): void
  release(): void
}

const FORMAT_VERSION = 3
const CACHE_MAX = 6
const MEMORY_BYTES = 128 * 1024 * 1024
const STORED_BYTES = 96 * 1024 * 1024
const cache = new Map<string, { image: PreparedWallpaper; bytes: number }>()
const pending = new Map<string, {
  promise: Promise<PreparedWallpaper | null>
  abort: AbortController
  watchers: Set<AbortSignal>
  unscoped: boolean
}>()
const requests = new Map<string, {
  start: () => void
  resolve: (value: StoredPrepared | null) => void
}>()
let worker: Worker | null = null
let running: string | null = null
let cacheBytes = 0
let clearRevision = 0
let workerIdle: ReturnType<typeof setTimeout> | undefined

function stopWorker(): void {
  clearTimeout(workerIdle)
  workerIdle = undefined
  worker?.terminate()
  worker = null
}

function nextRequest(): void {
  if (running !== null) return
  // The most recent display request has priority.
  const job = Array.from(requests.values()).pop()
  if (job) {
    clearTimeout(workerIdle)
    workerIdle = undefined
    job.start()
  } else if (worker && !workerIdle) workerIdle = setTimeout(stopWorker, 15_000)
}

function prepareInWorker(key: string, url: string, cssWidth: number, cssHeight: number, dpr: number,
  signal: AbortSignal
): Promise<StoredPrepared | null> {
  if (signal.aborted) return Promise.resolve(null)
  return new Promise(resolve => {
    const finish = (value: StoredPrepared | null): void => {
      signal.removeEventListener('abort', cancel)
      requests.delete(key)
      if (running === key) running = null
      resolve(value)
      nextRequest()
    }
    const cancel = (): void => {
      if (running === key) stopWorker()
      finish(null)
    }
    function start(): void {
      running = key
      try {
        if (!worker) {
          const current = new Worker(new URL('./wallpaperPrepWorker.ts', import.meta.url), { type: 'module' })
          worker = current
          current.onmessage = ({ data }) => {
            if (worker !== current) return
            requests.get(data.key)?.resolve(data.blob
              ? { blob: data.blob, width: data.width, height: data.height, t: Date.now() }
              : null)
          }
          const fail = (): void => {
            if (worker !== current) return
            stopWorker()
            if (running !== null) requests.get(running)?.resolve(null)
          }
          current.onerror = fail
          current.onmessageerror = fail
        }
        worker.postMessage({ key, url, cssWidth, cssHeight, dpr })
      } catch {
        stopWorker()
        finish(null)
      }
    }
    signal.addEventListener('abort', cancel, { once: true })
    requests.set(key, { start, resolve: finish })
    nextRequest()
  })
}

interface StoredPrepared {
  t: number
  blob: Blob
  width: number
  height: number
}

const DB_NAME = 'kl-wallpaper-prepared'
const STORE = 'prepared'
const MAX_STORED = 24

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, FORMAT_VERSION)
      let blocked = false
      request.onupgradeneeded = () => {
        // A format bump invalidates every stored image (crop semantics changed).
        if (request.result.objectStoreNames.contains(STORE)) {
          request.result.deleteObjectStore(STORE)
        }
        request.result.createObjectStore(STORE).createIndex('age', 't')
      }
      request.onblocked = () => {
        blocked = true
        resolve(null)
      }
      request.onsuccess = () => {
        const db = request.result
        if (blocked) {
          db.close()
          dbPromise = null
          return
        }
        db.onversionchange = () => {
          db.close()
          dbPromise = null
        }
        resolve(db)
      }
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

async function idbGet(key: string): Promise<StoredPrepared | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const store = db.transaction(STORE, 'readwrite').objectStore(STORE)
      const request = store.get(key)
      request.onsuccess = () => {
        const value = request.result as StoredPrepared | undefined
        if (value?.blob && Date.now() - value.t > 60_000) store.put({ ...value, t: Date.now() }, key)
        resolve(value?.blob ? value : null)
      }
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function idbPut(key: string, value: StoredPrepared, revision: number): Promise<void> {
  const db = await openDb()
  if (!db || revision !== clearRevision || value.blob.size > STORED_BYTES) return
  try {
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE)
    store.put(value, key)
    const newest = store.index('age').openCursor(null, 'prev')
    let count = 0
    let bytes = 0
    newest.onsuccess = () => {
      const cursor = newest.result
      if (!cursor) return
      const size = (cursor.value as StoredPrepared).blob.size
      if (count === MAX_STORED || bytes + size > STORED_BYTES) cursor.delete()
      else { count++; bytes += size }
      cursor.continue()
    }
  } catch {
    /* cache is best effort */
  }
}

export function wallpaperCacheKey(url: string, cssWidth: number, cssHeight: number, dpr: number): string {
  return 'v' + FORMAT_VERSION + '|' + url + '|' + Math.round(cssWidth) + 'x' + Math.round(cssHeight) + '@' + Math.round(dpr * 100) / 100
}

function touch(key: string): PreparedWallpaper | undefined {
  const value = cache.get(key)
  if (value) { cache.delete(key); cache.set(key, value) }
  return value?.image
}

async function materialize(value: StoredPrepared): Promise<PreparedWallpaper> {
  const url = URL.createObjectURL(value.blob)
  // Keep the display-sized bitmap decoded on warm switches. Cache and visible
  // consumers own separate references so eviction cannot invalidate a live image.
  const image = new Image()
  image.src = url
  try { await image.decode() }
  catch (error) { URL.revokeObjectURL(url); throw error }
  let references = 1
  return {
    url, width: value.width, height: value.height,
    get inUse() { return references > 1 },
    retain() { references++ },
    release() {
      if (--references === 0) { image.removeAttribute('src'); URL.revokeObjectURL(url) }
    }
  }
}

function dropCached(key: string): number {
  const value = cache.get(key)
  if (!value) return 0
  cache.delete(key)
  cacheBytes -= value.bytes
  value.image.release()
  return value.bytes
}

export function wallpaperMemoryUsage(): number {
  return cacheBytes
}

export function wallpaperDiskUsage(): Promise<number> {
  return readWallpaperCache(false)
}

export async function clearWallpaperCache(): Promise<{ memory: number; disk: number; failure?: string }> {
  clearRevision++
  let memory = 0
  for (const [key, value] of cache) {
    if (!value.image.inUse) memory += dropCached(key)
  }
  try { return { memory, disk: await readWallpaperCache(true) } }
  catch (error) { return { memory, disk: 0, failure: (error as Error).message } }
}

async function readWallpaperCache(clear: boolean): Promise<number> {
  const db = await openDb()
  if (!db) throw new Error('无法访问壁纸派生缓存')
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, clear ? 'readwrite' : 'readonly')
    const cursorRequest = transaction.objectStore(STORE).openCursor()
    let bytes = 0
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) return
      bytes += (cursor.value as StoredPrepared).blob.size
      if (clear) cursor.delete()
      cursor.continue()
    }
    transaction.oncomplete = () => resolve(bytes)
    transaction.onabort = () => reject(transaction.error ?? new Error('壁纸缓存操作失败'))
  })
}

export function prepareWallpaperForDisplay(url: string, cssWidth: number, cssHeight: number, dpr: number,
  signal?: AbortSignal
): Promise<PreparedWallpaper | null> {
  if (signal?.aborted) return Promise.resolve(null)
  const key = wallpaperCacheKey(url, cssWidth, cssHeight, dpr)
  const cached = touch(key)
  if (cached) return Promise.resolve(cached)
  let job = pending.get(key)
  if (!job || job.abort.signal.aborted) {
    const revision = clearRevision
    const abort = new AbortController()
    const promise = (async () => {
    // Imported backgrounds have immutable filenames. The system desktop image
    // may be replaced in place between launches.
    const persistent = !url.startsWith('kevin-media://file/')
    let value = persistent ? await idbGet(key) : null
    abort.signal.throwIfAborted()
    const stored = Boolean(value)
    let result = value ? await materialize(value).catch(() => null) : null
    if (!result) {
      value = await prepareInWorker(key, url, cssWidth, cssHeight, dpr, abort.signal)
      if (!value) return null
      result = await materialize(value)
      if (persistent && !abort.signal.aborted) void idbPut(key, value, revision)
    }
    if (abort.signal.aborted) {
      result.release()
      return null
    }
    perf(stored ? 'wp-idb-hit' : 'wp-prepared', { width: result.width, height: result.height })
    const bytes = (value?.blob.size ?? 0) + result.width * result.height * 4
    if (bytes > MEMORY_BYTES || revision !== clearRevision) {
      const temporary = result
      // Consumers acquire their display lease in the promise continuation.
      setTimeout(() => temporary.release(), 0)
      return result
    }
    cache.set(key, { image: result, bytes })
    cacheBytes += bytes
    while (cache.size > CACHE_MAX || cacheBytes > MEMORY_BYTES) {
      const oldest = cache.entries().next().value!
      dropCached(oldest[0])
    }
    return result
    })().catch(() => null).finally(() => {
      if (pending.get(key)?.promise === promise) pending.delete(key)
    })
    job = { promise, abort, watchers: new Set(), unscoped: false }
    pending.set(key, job)
  }
  if (signal) {
    const current = job
    const cancel = (): void => {
      current.watchers.delete(signal)
      queueMicrotask(() => {
        if (!current.unscoped && current.watchers.size === 0) current.abort.abort()
      })
    }
    current.watchers.add(signal)
    signal.addEventListener('abort', cancel, { once: true })
    void current.promise.then(() => signal.removeEventListener('abort', cancel))
  } else job.unscoped = true
  return job.promise
}
