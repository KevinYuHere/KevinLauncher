import { perf } from './perfProbe'

export interface PreparedWallpaper {
  readonly url: string
  readonly width: number
  readonly height: number
  retain(): void
  release(): void
}

const FORMAT_VERSION = 3
const CACHE_MAX = 6
const cache = new Map<string, PreparedWallpaper>()
const pending = new Map<string, Promise<PreparedWallpaper | null>>()
const requests = new Map<string, (value: StoredPrepared | null) => void>()
let worker: Worker | null = null

function prepareInWorker(key: string, url: string, cssWidth: number, cssHeight: number, dpr: number): Promise<StoredPrepared | null> {
  if (!worker) {
    worker = new Worker(new URL('./wallpaperPrepWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = ({ data }) => {
      const resolve = requests.get(data.key)
      requests.delete(data.key)
      resolve?.(data.blob ? { blob: data.blob, width: data.width, height: data.height, t: Date.now() } : null)
    }
    worker.onerror = () => {
      worker?.terminate()
      worker = null
      for (const resolve of requests.values()) resolve(null)
      requests.clear()
    }
  }
  return new Promise(resolve => {
    requests.set(key, resolve)
    try { worker!.postMessage({ key, url, cssWidth, cssHeight, dpr }) }
    catch { requests.delete(key); resolve(null) }
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
/** Upper bound on persisted entries (a few MB each, pruned to this). */
const MAX_STORED = 24

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, FORMAT_VERSION)
      request.onupgradeneeded = () => {
        // A format bump invalidates every stored image (crop semantics changed).
        if (request.result.objectStoreNames.contains(STORE)) {
          request.result.deleteObjectStore(STORE)
        }
        request.result.createObjectStore(STORE).createIndex('age', 't')
      }
      request.onblocked = () => resolve(null)
      request.onsuccess = () => resolve(request.result)
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
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      request.onsuccess = () => {
        const value = request.result as StoredPrepared | undefined
        resolve(value?.blob ? value : null)
      }
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function idbPut(key: string, value: StoredPrepared): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE)
    store.put(value, key)
    const count = store.count()
    count.onsuccess = () => {
      let excess = count.result - MAX_STORED
      if (excess <= 0) return
      const oldest = store.index('age').openKeyCursor()
      oldest.onsuccess = () => {
        const cursor = oldest.result
        if (!cursor || excess <= 0) return
        store.delete(cursor.primaryKey)
        excess--
        cursor.continue()
      }
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
  return value
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
    retain() { references++ },
    release() {
      if (--references === 0) { image.removeAttribute('src'); URL.revokeObjectURL(url) }
    }
  }
}

export function prepareWallpaperForDisplay(url: string, cssWidth: number, cssHeight: number, dpr: number): Promise<PreparedWallpaper | null> {
  const key = wallpaperCacheKey(url, cssWidth, cssHeight, dpr)
  const cached = touch(key)
  if (cached) return Promise.resolve(cached)
  const previous = pending.get(key)
  if (previous) return previous
  const job = (async () => {
    // Imported backgrounds have immutable filenames. The system desktop image
    // may be replaced in place between launches.
    const persistent = !url.startsWith('kevin-media://file/')
    const stored = persistent ? await idbGet(key) : null
    let result = stored ? await materialize(stored).catch(() => null) : null
    if (!result) {
      const value = await prepareInWorker(key, url, cssWidth, cssHeight, dpr)
      if (!value) return null
      result = await materialize(value)
      if (persistent) void idbPut(key, value)
    }
    perf(stored ? 'wp-idb-hit' : 'wp-prepared', { width: result.width, height: result.height })
    cache.set(key, result)
    while (cache.size > CACHE_MAX) {
      const oldest = cache.entries().next().value!
      cache.delete(oldest[0])
      oldest[1].release()
    }
    return result
  })().catch(() => null).finally(() => pending.delete(key))
  pending.set(key, job)
  return job
}
