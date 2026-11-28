import { imageHeaderSize } from '../wallpaperHeader'

type Task = { id: number; url: string } | { id: number; cancel: true }

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Task>) => void) | null
  postMessage(message: unknown): void
}
const EDGE = 480
const active = new Map<number, AbortController>()

function thumbnailSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, EDGE / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

async function prepare(id: number, url: string, signal: AbortSignal): Promise<void> {
  let bitmap: ImageBitmap | undefined
  try {
    const response = await fetch(url, { signal, cache: 'no-store' })
    if (!response.ok) throw new Error('Image unavailable')
    const blob = await response.blob()
    const original = imageHeaderSize(new Uint8Array(await blob.slice(0, 128 * 1024).arrayBuffer()))
    signal.throwIfAborted()
    const size = original && thumbnailSize(original.width, original.height)
    bitmap = await createImageBitmap(blob, size ? {
      resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'medium'
    } : undefined)
    signal.throwIfAborted()
    const { width, height } = thumbnailSize(bitmap.width, bitmap.height)
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('No canvas context')
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    bitmap = undefined
    const result = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 })
    signal.throwIfAborted()
    scope.postMessage({ id, blob: result, width, height })
  } catch {
    scope.postMessage({ id })
  } finally {
    bitmap?.close()
    active.delete(id)
  }
}

scope.onmessage = ({ data }): void => {
  if ('cancel' in data) {
    active.get(data.id)?.abort()
    return
  }
  const controller = new AbortController()
  active.set(data.id, controller)
  void prepare(data.id, data.url, controller.signal)
}
