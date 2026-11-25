// Module worker that prepares a wallpaper off the main thread.
//
// The original image can be 8K/16K (tens of MB decoded). We cut out the part
// that `object-fit: cover` actually shows and rasterise it to the exact
// device-pixel size of the display, so the renderer paints it 1:1 (no wasted
// resolution, no per-frame resampling). The worker reads the source directly
// and returns a display-sized blob to the renderer.
import { imageHeaderSize } from './wallpaperHeader'
import { MAX_WALLPAPER_EDGE, wallpaperCoverCrop } from './wallpaperDisplay'

interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

const scope = self as unknown as WorkerScope

interface Task {
  key: string
  url: string
  cssWidth: number
  cssHeight: number
  dpr: number
}

async function encode(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  sx = 0,
  sy = 0,
  sw = bitmap.width,
  sh = bitmap.height
): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    throw new Error('no 2d context')
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height)
  bitmap.close()
  return canvas.convertToBlob({ type: 'image/webp', quality: 0.95 })
}

async function prepare({ key, url, cssWidth, cssHeight, dpr }: Task): Promise<void> {
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error('Wallpaper unavailable')
    const blob = await response.blob()
    const dimensions = imageHeaderSize(new Uint8Array(await blob.slice(0, 128 * 1024).arrayBuffer()))
    const crop = dimensions
      ? wallpaperCoverCrop(dimensions.width, dimensions.height, cssWidth, cssHeight, dpr, MAX_WALLPAPER_EDGE)
      : null
    if (dimensions && !crop) {
      // The visible part is not bigger than the display: use the original.
      scope.postMessage({ key, blob, ...dimensions })
      return
    }
    if (crop) {
      // Ask the decoder for only the crop at display resolution.
      const bitmap = await createImageBitmap(
        blob,
        crop.sx,
        crop.sy,
        crop.sw,
        crop.sh,
        { resizeWidth: crop.width, resizeHeight: crop.height, resizeQuality: 'high' }
      )
      const out = await encode(bitmap, crop.width, crop.height)
      scope.postMessage({ key, blob: out, width: crop.width, height: crop.height })
      return
    }
    // Header dimensions unavailable: crop from the decoded bitmap instead.
    const bitmap = await createImageBitmap(blob)
    const fallback = wallpaperCoverCrop(
      bitmap.width,
      bitmap.height,
      cssWidth,
      cssHeight,
      dpr,
      MAX_WALLPAPER_EDGE
    )
    if (!fallback) {
      const { width, height } = bitmap
      bitmap.close()
      scope.postMessage({ key, blob, width, height })
      return
    }
    const out = await encode(
      bitmap,
      fallback.width,
      fallback.height,
      fallback.sx,
      fallback.sy,
      fallback.sw,
      fallback.sh
    )
    scope.postMessage({ key, blob: out, width: fallback.width, height: fallback.height })
  } catch (error) {
    scope.postMessage({ key, error: String(error) })
  }
}

/** Bound peak decode memory even when many thumbnail requests arrive together. */
let tail = Promise.resolve()
scope.onmessage = (event: MessageEvent): void => {
  const task = event.data as Task
  tail = tail.then(() => prepare(task))
}
