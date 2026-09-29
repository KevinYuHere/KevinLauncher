import { fileUrl } from '../media'

export interface Thumb {
  url: string
  aspect: number
}

const CACHE_MAX = 600
const MAX_ACTIVE = 5

const cache = new Map<string, Thumb>()
const waiters = new Map<string, Set<(thumb: Thumb) => void>>()
const queue: string[] = []
const queued = new Set<string>()
let active = 0

const worker = new Worker(new URL('./thumbWorker.ts', import.meta.url), { type: 'module' })

worker.onmessage = (event: MessageEvent): void => {
  active = Math.max(0, active - 1)
  const data = event.data as { path: string; blob?: Blob; width?: number; height?: number }
  if (data.blob) {
    const url = URL.createObjectURL(data.blob)
    const thumb: Thumb = {
      url,
      aspect: data.width && data.height ? data.width / data.height : 16 / 9
    }
    cache.set(data.path, thumb)
    if (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) {
        const evicted = cache.get(oldest)
        if (evicted) URL.revokeObjectURL(evicted.url)
        cache.delete(oldest)
      }
    }
    waiters.get(data.path)?.forEach((cb) => cb(thumb))
  }
  waiters.delete(data.path)
  pump()
}

worker.onerror = (): void => {
  active = Math.max(0, active - 1)
  pump()
}

function pump(): void {
  while (active < MAX_ACTIVE && queue.length > 0) {
    const path = queue.shift() as string
    queued.delete(path)
    active += 1
    void fetchAndSend(path)
  }
}

async function fetchAndSend(path: string): Promise<void> {
  try {
    const res = await fetch(fileUrl(path))
    const buffer = await res.arrayBuffer()
    worker.postMessage({ path, buffer }, [buffer])
  } catch {
    active = Math.max(0, active - 1)
    waiters.delete(path)
    pump()
  }
}

function enqueue(path: string): void {
  if (cache.has(path) || queued.has(path)) return
  queued.add(path)
  queue.push(path)
  pump()
}

export function getThumb(path: string): Thumb | undefined {
  return cache.get(path)
}

function subscribe(path: string, cb: (thumb: Thumb) => void): () => void {
  const set = waiters.get(path) ?? new Set<(thumb: Thumb) => void>()
  set.add(cb)
  waiters.set(path, set)
  return () => {
    set.delete(cb)
  }
}

let observer: IntersectionObserver | null = null
const pathByElement = new WeakMap<Element, string>()

/**
 * Register a tile element: its thumbnail is generated only once it scrolls
 * near the viewport, keeping the gallery responsive with many images.
 */
export function observeTile(
  element: Element,
  path: string,
  cb: (thumb: Thumb) => void
): () => void {
  const cached = cache.get(path)
  if (cached) {
    cb(cached)
    return () => {}
  }
  pathByElement.set(element, path)
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const target = pathByElement.get(entry.target)
          if (target) enqueue(target)
          observer?.unobserve(entry.target)
        }
      },
      { rootMargin: '700px 0px' }
    )
  }
  observer.observe(element)
  return subscribe(path, cb)
}
