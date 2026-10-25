/**
 * Display-resolution wallpaper preparation.
 *
 * Wallpapers are often much larger than the window (an 8K illustration in a 2K
 * window is a ~4x downscale). Chromium draws the `<img>` with a single bilinear
 * tap, so fine line art and sparkles alias into visible stair-steps ("jaggies")
 * even though the source is sharp.
 *
 * We downscale **once** with `createImageBitmap(..., resizeQuality: 'high')` to
 * the exact device-pixel cover size and hand the `<img>` that image instead: it
 * is then drawn 1:1, with no resampling at all. The prepared blobs are also much
 * smaller, so switching apps no longer keeps a 130 MB 8K decode around.
 */

/** Longest edge we ever rasterise (bounds memory on 4K+/8K displays). */
export const MAX_WALLPAPER_EDGE = 5120

export interface WallpaperTargetSize {
  width: number
  height: number
}

/**
 * Device-pixel size for an `object-fit: cover` wallpaper, or `null` when the
 * source is already at (or below) display resolution and needs no work.
 *
 * `cssWidth` / `cssHeight` are the rendered box in CSS pixels (the padded
 * background layer, i.e. the window plus the 64 px overhang on each side).
 */
export function wallpaperTargetSize(
  iw: number,
  ih: number,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  maxEdge: number = MAX_WALLPAPER_EDGE
): WallpaperTargetSize | null {
  if (!(iw > 0) || !(ih > 0) || !(cssWidth > 0) || !(cssHeight > 0)) return null
  if (!(dpr > 0)) return null
  const cover = Math.max((cssWidth * dpr) / iw, (cssHeight * dpr) / ih)
  if (!Number.isFinite(cover) || cover <= 0) return null
  // 0.99: rounding differences are not worth a re-encode.
  if (cover >= 0.99) return null
  let width = Math.round(iw * cover)
  let height = Math.round(ih * cover)
  const longest = Math.max(width, height)
  if (longest > maxEdge) {
    const factor = maxEdge / longest
    width = Math.max(1, Math.round(width * factor))
    height = Math.max(1, Math.round(height * factor))
  }
  return { width, height }
}

export interface PreparedWallpaper {
  /** `blob:` URL of the downscaled image. */
  url: string
  width: number
  height: number
}

/**
 * Downscale an already-decoded wallpaper for display. Returns `null` when the
 * source needs no downscale (or the browser refused), in which case the caller
 * should keep using the original URL.
 */
export async function prepareWallpaper(
  image: HTMLImageElement,
  cssWidth: number,
  cssHeight: number,
  dpr: number
): Promise<PreparedWallpaper | null> {
  const target = wallpaperTargetSize(image.naturalWidth, image.naturalHeight, cssWidth, cssHeight, dpr)
  if (!target) return null
  try {
    const bitmap = await createImageBitmap(image, {
      resizeWidth: target.width,
      resizeHeight: target.height,
      resizeQuality: 'high'
    })
    const canvas = document.createElement('canvas')
    canvas.width = target.width
    canvas.height = target.height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      return null
    }
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    // WebP keeps transparency and is much smaller than PNG; quality 0.95 is
    // visually lossless after a 4x downscale.
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/webp', 0.95)
    })
    if (!blob) return null
    return { url: URL.createObjectURL(blob), width: target.width, height: target.height }
  } catch {
    return null
  }
}
