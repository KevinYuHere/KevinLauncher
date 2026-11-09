// Module worker that prepares a wallpaper off the main thread.
//
// The original image can be 8K/16K (tens of MB decoded). We cut out the part
// that `object-fit: cover` actually shows and rasterise it to the exact
// device-pixel size of the display, so the renderer paints it 1:1 (no wasted
// resolution, no per-frame resampling). The renderer reads the file into an
// ArrayBuffer and transfers it here; the resulting WebP blob is sent back.
import { MAX_WALLPAPER_EDGE, wallpaperCoverCrop } from './wallpaperDisplay'

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

interface Dimensions {
  width: number
  height: number
}

/**
 * Read the coded dimensions from the image header only (WebCodecs
 * `ImageDecoder`), so the big bitmap can be decoded **cropped and scaled**
 * instead of at full 8K size.
 */
async function readDimensions(blob: Blob, type: string): Promise<Dimensions | null> {
  try {
    const Decoder = (
      self as unknown as {
        ImageDecoder?: new (init: { data: ArrayBuffer; type: string }) => {
          tracks: {
            ready: Promise<void>
            selectedTrack?: { codedWidth?: number; codedHeight?: number }
          }
          close?: () => void
        }
      }
    ).ImageDecoder
    if (!Decoder) return null
    const decoder = new Decoder({ data: await blob.arrayBuffer(), type })
    await decoder.tracks.ready
    const track = decoder.tracks.selectedTrack
    const width = track?.codedWidth ?? 0
    const height = track?.codedHeight ?? 0
    decoder.close?.()
    return width > 0 && height > 0 ? { width, height } : null
  } catch {
    return null
  }
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

scope.onmessage = async (event: MessageEvent): Promise<void> => {
  const { key, buffer, type, cssWidth, cssHeight, dpr } = event.data as Task
  try {
    const blob = new Blob([buffer], { type: type || 'image/png' })
    const dimensions = await readDimensions(blob, type)
    const crop = dimensions
      ? wallpaperCoverCrop(dimensions.width, dimensions.height, cssWidth, cssHeight, dpr, MAX_WALLPAPER_EDGE)
      : null
    if (dimensions && !crop) {
      // The visible part is not bigger than the display: use the original.
      scope.postMessage({ key, raw: true })
      return
    }
    if (crop) {
      // Crop + scaled decode in one step (no full-size bitmap at all).
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
      bitmap.close()
      scope.postMessage({ key, raw: true })
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
