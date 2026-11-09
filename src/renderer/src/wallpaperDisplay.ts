/**
 * Display-resolution wallpaper preparation.
 *
 * A wallpaper is usually much larger than the window (an 8K illustration in a
 * 2K window). Chromium draws the `<img>` with `object-fit: cover`, i.e. it crops
 * the source to the window aspect and resamples it every frame.
 *
 * We cut out exactly the part that `cover` would show and rasterise it so that
 * **one image pixel maps to one display (device) pixel** — no wasted 8K detail,
 * no per-frame resampling. The prepared image is then painted 1:1.
 */

/** Longest edge we ever rasterise (bounds memory on absurd window sizes). */
export const MAX_WALLPAPER_EDGE = 8192

export interface WallpaperCrop {
  /** Source rectangle to cut from the original image. */
  sx: number
  sy: number
  sw: number
  sh: number
  /** Exact device-pixel size of the prepared image (1:1 with the display). */
  width: number
  height: number
}

/**
 * Compute the source rectangle that `object-fit: cover` shows in a
 * `cssWidth`×`cssHeight` box at `dpr`, plus the device-pixel size to rasterise it
 * to (one prepared pixel per display pixel).
 *
 * Returns `null` when the visible part of the source is not bigger than the
 * display: rasterising then would only upscale (more memory, no detail), so the
 * caller keeps the original image.
 */
export function wallpaperCoverCrop(
  iw: number,
  ih: number,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  maxEdge: number = MAX_WALLPAPER_EDGE
): WallpaperCrop | null {
  if (!(iw > 0) || !(ih > 0) || !(cssWidth > 0) || !(cssHeight > 0)) return null
  if (!(dpr > 0)) return null
  let width = Math.max(1, Math.round(cssWidth * dpr))
  let height = Math.max(1, Math.round(cssHeight * dpr))
  const longest = Math.max(width, height)
  if (longest > maxEdge) {
    const factor = maxEdge / longest
    width = Math.max(1, Math.round(width * factor))
    height = Math.max(1, Math.round(height * factor))
  }
  // `cover` scale: source pixels → display pixels.
  const scale = Math.max(width / iw, height / ih)
  if (!Number.isFinite(scale) || scale <= 0) return null
  // Scale >= 1 means the source is smaller than the display: showing it as is
  // (browser upscale) is equivalent and needs no prepared copy.
  if (scale >= 0.999) return null
  const sw = Math.min(iw, width / scale)
  const sh = Math.min(ih, height / scale)
  if (!(sw > 0) || !(sh > 0)) return null
  return {
    sx: (iw - sw) / 2,
    sy: (ih - sh) / 2,
    sw,
    sh,
    width,
    height
  }
}
