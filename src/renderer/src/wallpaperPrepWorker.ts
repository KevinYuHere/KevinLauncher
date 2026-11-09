// Module worker that downscales a wallpaper off the main thread.
//
// Wallpapers can be 8K/16K illustrations (tens of MB decoded), and both the
// decode and the high-quality downscale used to run on the renderer thread —
// switching to such an app froze the whole launcher for a noticeable moment.
// The renderer reads the file into an ArrayBuffer and transfers it here; the
// resulting WebP blob is sent back.
import { MAX_WALLPAPER_EDGE, wallpaperTargetSize } from './wallpaperDisplay'

interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

const scope = self as unknown as WorkerScope

interface Task {
  key: string
  buffer: ArrayBuffer
  type: string
  cssWidth: number
  cssHeight: number
  dpr: number
}

scope.onmessage = async (event: MessageEvent): Promise<void> => {
  const { key, buffer, type, cssWidth, cssHeight, dpr } = event.data as Task
  try {
    const bitmap = await createImageBitmap(new Blob([buffer], { type: type || 'image/png' }))
    const target = wallpaperTargetSize(
      bitmap.width,
      bitmap.height,
      cssWidth,
      cssHeight,
      dpr,
      MAX_WALLPAPER_EDGE
    )
    if (!target) {
      // Already at display resolution: the caller uses the original URL.
      bitmap.close()
      scope.postMessage({ key, raw: true })
      return
    }
    const canvas = new OffscreenCanvas(target.width, target.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      scope.postMessage({ key, raw: true })
      return
    }
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, target.width, target.height)
    bitmap.close()
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.95 })
    scope.postMessage({ key, blob, width: target.width, height: target.height })
  } catch (error) {
    scope.postMessage({ key, error: String(error) })
  }
}
