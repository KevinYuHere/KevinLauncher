import type { GalleryItem } from '@shared/types'
import { fileUrl } from '../media'

export interface Thumb {
  url: string
  aspect: number
}

interface CachedThumb extends Thumb {
  bytes: number
  users: number
  cached: boolean
}

interface Subscriber {
  callback: (thumb: Thumb | null) => void
  thumb?: CachedThumb
}

interface Task {
  id: number
  key: string
  path: string
  subscribers: Set<Subscriber>
  cancelling?: boolean
}

interface WorkerReply {
  id: number
  blob?: Blob
  width?: number
  height?: number
}

const CACHE_MAX = 600
const CACHE_BYTES = 48 * 1024 * 1024
const MAX_ACTIVE = 3
const cache = new Map<string, CachedThumb>()
const tasks = new Map<string, Task>()
const queue = new Map<number, Task>()
const active = new Map<number, Task>()
let cacheBytes = 0
let taskId = 0
let consumers = 0
let worker: Worker | null = null

/** A new file written to the same path receives a new cache identity. */
export function galleryImageKey(item: GalleryItem): string {
  return JSON.stringify([item.path, item.mtimeMs, item.ctimeMs, item.size])
}

function disposeIfUnused(thumb: CachedThumb): void {
  if (!thumb.cached && thumb.users === 0) URL.revokeObjectURL(thumb.url)
}

function evict(key: string, thumb: CachedThumb): number {
  cache.delete(key)
  cacheBytes -= thumb.bytes
  thumb.cached = false
  disposeIfUnused(thumb)
  return thumb.users === 0 ? thumb.bytes : 0
}

export function thumbnailCacheUsage(): number {
  return cacheBytes
}

export function clearThumbnailCache(): number {
  let reclaimed = 0
  for (const [key, thumb] of cache) {
    if (thumb.users === 0) reclaimed += evict(key, thumb)
  }
  return reclaimed
}

function deliver(subscriber: Subscriber, thumb: CachedThumb): void {
  thumb.users++
  subscriber.thumb = thumb
  subscriber.callback(thumb)
}

function onResult({ id, blob, width, height }: WorkerReply): void {
  const task = active.get(id)
  if (!task) return
  active.delete(id)
  if (task.cancelling && task.subscribers.size > 0) {
    task.cancelling = false
    task.id = ++taskId
    queue.set(task.id, task)
    pump()
    return
  }
  if (tasks.get(task.key) === task) tasks.delete(task.key)
  if (task.subscribers.size > 0 && blob && width && height) {
    const thumb: CachedThumb = {
      url: URL.createObjectURL(blob), aspect: width / height, bytes: blob.size, users: 0, cached: true
    }
    const old = cache.get(task.key)
    if (old) evict(task.key, old)
    cache.set(task.key, thumb)
    cacheBytes += thumb.bytes
    for (const subscriber of task.subscribers) deliver(subscriber, thumb)
    while (cache.size > CACHE_MAX || cacheBytes > CACHE_BYTES) {
      const oldest = cache.entries().next().value
      if (oldest) evict(...oldest)
    }
  } else {
    for (const subscriber of task.subscribers) subscriber.callback(null)
  }
  pump()
}

function stopWorker(): void {
  worker?.terminate()
  worker = null
}

function failWorker(): void {
  stopWorker()
  for (const task of tasks.values()) {
    for (const subscriber of task.subscribers) subscriber.callback(null)
  }
  active.clear()
  queue.clear()
  tasks.clear()
}

function pump(): void {
  if (queue.size === 0) {
    if (active.size === 0 && consumers === 0) stopWorker()
    return
  }
  try {
    if (!worker) {
      const current = new Worker(new URL('./thumbWorker.ts', import.meta.url), { type: 'module' })
      worker = current
      current.onmessage = (event: MessageEvent<WorkerReply>) => {
        if (worker === current) onResult(event.data)
      }
      const fail = (): void => { if (worker === current) failWorker() }
      current.onerror = fail
      current.onmessageerror = fail
    }
    while (active.size < MAX_ACTIVE && queue.size > 0) {
      const task = queue.values().next().value!
      queue.delete(task.id)
      active.set(task.id, task)
      worker.postMessage({ id: task.id, url: fileUrl(task.path) })
    }
  } catch {
    failWorker()
  }
}

/** The windowed tile owns a reference for as long as it displays the URL. */
export function subscribeThumbnail(
  item: GalleryItem,
  callback: (thumb: Thumb | null) => void
): () => void {
  const key = galleryImageKey(item)
  const subscriber: Subscriber = { callback }
  const cached = cache.get(key)
  let task: Task | undefined
  consumers++
  if (cached) {
    cache.delete(key)
    cache.set(key, cached)
    deliver(subscriber, cached)
  } else {
    task = tasks.get(key)
    if (!task) {
      task = { id: ++taskId, key, path: item.path, subscribers: new Set() }
      tasks.set(key, task)
      queue.set(task.id, task)
    }
    task.subscribers.add(subscriber)
    pump()
  }
  return () => {
    consumers--
    if (subscriber.thumb) {
      subscriber.thumb.users--
      disposeIfUnused(subscriber.thumb)
    }
    task?.subscribers.delete(subscriber)
    if (task && task.subscribers.size === 0 && tasks.get(key) === task && !task.cancelling) {
      if (queue.delete(task.id)) tasks.delete(key)
      else {
        task.cancelling = true
        try { worker?.postMessage({ id: task.id, cancel: true }) }
        catch { failWorker() }
      }
    }
    if (consumers === 0) {
      stopWorker()
      active.clear()
      queue.clear()
      tasks.clear()
    }
  }
}
