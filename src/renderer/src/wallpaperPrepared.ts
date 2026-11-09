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

export interface PreparedWallpaper {
  url: string
  width: number
  height: number
}

/** How many prepared wallpapers to keep (each is ~1 MB of WebP). */
const CACHE_MAX = 6

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

export function wallpaperCacheKey(
  url: string,
  cssWidth: number,
  cssHeight: number,
  dpr: number
): string {
  return `${url}|${Math.round(cssWidth)}x${Math.round(cssHeight)}@${Math.round(dpr * 100) / 100}`
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
    const instance = ensureWorker()
    if (!instance) return null
    try {
      const response = await fetch(url)
      if (!response.ok) return null
      const buffer = await response.arrayBuffer()
      const type = response.headers.get('content-type') ?? 'image/png'
      return await new Promise<PreparedWallpaper | null>((resolve) => {
        resolvers.set(key, (value) => {
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
