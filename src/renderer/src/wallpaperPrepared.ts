/**
 * Display-resolution wallpaper cache.
 *
 * A wallpaper can be far larger than the window (an 8K illustration in a 2K
 * window). Decoding and downscaling it on the renderer thread froze the UI when
 * switching to that app, and every switch repeated the work. This module:
 *
 * - prepares the image **once** in a worker (`wallpaperPrepWorker.ts`), so the
 *   renderer never decodes the full-size image or blocks;
 * - caches the prepared `blob:` URL per source + target size, so switching back
 *   commits instantly (no decode at all).
 */

import { perf } from './perfProbe'

export interface PreparedWallpaper {
  url: string
  width: number
  height: number
}

/** How many prepared wallpapers to keep (each is ~1 MB of WebP). */
const CACHE_MAX = 6

/**
 * Bump when the preparation algorithm changes (e.g. the crop semantics), so
 * persisted images from an older build are not reused.
 */
const FORMAT_VERSION = 2

const cache = new Map<string, PreparedWallpaper>()
/** Keys known to need no work: the caller should use the original URL. */
const rawKeys = new Set<string>()
const pending = new Map<string, Promise<PreparedWallpaper | null>>()

interface WorkerReply {
  key: string
  blob?: Blob
  width?: number
  height?: number
  raw?: boolean
  error?: string
}

interface WorkerScope {
  postMessage: (message: unknown, transfer?: Transferable[]) => void
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
}

let worker: Worker | null = null
let workerBroken = false
const resolvers = new Map<string, (value: PreparedWallpaper | null) => void>()

function ensureWorker(): Worker | null {
  if (worker || workerBroken) return worker
  try {
    worker = new Worker(new URL('./wallpaperPrepWorker.ts', import.meta.url), { type: 'module' })
    const scope = worker as unknown as WorkerScope
    scope.onmessage = (event: MessageEvent): void => {
      const reply = event.data as WorkerReply
      const resolve = resolvers.get(reply.key)
      resolvers.delete(reply.key)
      if (!resolve) return
      if (reply.error || !reply.blob) {
        resolve(null)
        return
      }
      const width = reply.width ?? 0
      const height = reply.height ?? 0
      const prepared: PreparedWallpaper = {
        url: URL.createObjectURL(reply.blob),
        width,
        height
      }
      remember(reply.key, prepared)
      void idbPut(reply.key, { t: Date.now(), blob: reply.blob, width, height })
      resolve(prepared)
    }
    scope.onerror = (): void => {
      workerBroken = true
      for (const resolve of resolvers.values()) resolve(null)
      resolvers.clear()
      pending.clear()
    }
  } catch {
    workerBroken = true
    worker = null
  }
  return worker
}

function remember(key: string, prepared: PreparedWallpaper): void {
  cache.set(key, prepared)
  // Bound memory; the URL of an evicted entry is left alive because it may still
  // be the image on screen (blob URLs die with the page anyway).
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

// ---------------------------------------------------------------- IndexedDB
// The prepared image is persisted so a launcher restart (or a window resize
// that hits an already-rendered size) does not need to decode the huge source
// again.
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
        request.result.createObjectStore(STORE)
      }
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

async function idbPrune(db: IDBDatabase): Promise<void> {
  try {
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE)
    const keys = await new Promise<IDBValidKey[]>((resolve) => {
      const request = store.getAllKeys()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve([])
    })
    if (keys.length <= MAX_STORED) return
    for (const key of keys.slice(0, keys.length - MAX_STORED)) store.delete(key)
  } catch {
    /* best effort */
  }
}

async function idbPut(key: string, value: StoredPrepared): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE)
    store.put(value, key)
    void idbPrune(db)
  } catch {
    /* cache is best effort */
  }
}

function fromStored(key: string, value: StoredPrepared): PreparedWallpaper {
  const prepared: PreparedWallpaper = {
    url: URL.createObjectURL(value.blob),
    width: value.width,
    height: value.height
  }
  remember(key, prepared)
  return prepared
}

export function wallpaperCacheKey(
  url: string,
  cssWidth: number,
  cssHeight: number,
  dpr: number
): string {
  return `v${FORMAT_VERSION}|${url}|${Math.round(cssWidth)}x${Math.round(cssHeight)}@${Math.round(dpr * 100) / 100}`
}

export interface PeekResult {
  /** `true` when the answer is known synchronously (cached or no work needed). */
  hit: boolean
  /** Prepared image, or `null` meaning "use the original URL". */
  value: PreparedWallpaper | null
}

/** Synchronous cache lookup; used to commit a cached wallpaper immediately. */
export function peekPreparedWallpaper(
  url: string,
  cssWidth: number,
  cssHeight: number,
  dpr: number
): PeekResult {
  const key = wallpaperCacheKey(url, cssWidth, cssHeight, dpr)
  const cached = cache.get(key)
  if (cached) return { hit: true, value: cached }
  if (rawKeys.has(key)) return { hit: true, value: null }
  return { hit: false, value: null }
}

/**
 * Prepare a wallpaper for display. Resolves to the downscaled image, or `null`
 * when the source needs no downscale (or preparation failed) — the caller then
 * keeps using the original URL.
 */
export function prepareWallpaperForDisplay(
  url: string,
  cssWidth: number,
  cssHeight: number,
  dpr: number
): Promise<PreparedWallpaper | null> {
  const key = wallpaperCacheKey(url, cssWidth, cssHeight, dpr)
  const cached = cache.get(key)
  if (cached) return Promise.resolve(cached)
  if (rawKeys.has(key)) return Promise.resolve(null)
  const existing = pending.get(key)
  if (existing) return existing

  const job = (async (): Promise<PreparedWallpaper | null> => {
    // Persisted prepared image first: no fetch, no decode of the huge source.
    const stored = await idbGet(key)
    if (stored) {
      perf('wp-idb-hit')
      return fromStored(key, stored)
    }
    const instance = ensureWorker()
    if (!instance) return null
    try {
      const started = performance.now()
      const response = await fetch(url)
      if (!response.ok) return null
      const buffer = await response.arrayBuffer()
      perf('wp-fetch', { ms: Math.round(performance.now() - started), bytes: buffer.byteLength })
      const type = response.headers.get('content-type') ?? 'image/png'
      return await new Promise<PreparedWallpaper | null>((resolve) => {
        resolvers.set(key, (value) => {
          perf('wp-prepared', { ok: !!value, ms: Math.round(performance.now() - started) })
          if (value === null) rawKeys.add(key)
          resolve(value)
        })
        instance.postMessage({ key, buffer, type, cssWidth, cssHeight, dpr }, [buffer])
      })
    } catch {
      return null
    }
  })()
  pending.set(key, job)
  return job.finally(() => {
    pending.delete(key)
  })
}
