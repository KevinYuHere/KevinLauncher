/**
 * A wallpaper-only texture for launch effects. This is **not** a screenshot of
 * the launcher: it draws the current wallpaper layer (including the configured
 * blur / dim) into a canvas at the window's exact cover crop, so a launch effect
 * can warp the same pixels the user sees behind the UI.
 */
export interface WallpaperImageSource {
  url: string
  /** Rendered background size in CSS px. */
  width: number
  height: number
  /** Rendered top-left in viewport CSS px. */
  left: number
  top: number
}

/**
 * Fast path for the launch shatter: use the wallpaper `<img>` source directly
 * instead of rasterising a canvas and encoding a multi-MB data URL before the
 * first frame. Falls back to `captureWallpaperBackground` for video wallpapers.
 */
export function wallpaperImageSource(): WallpaperImageSource | null {
  const layer = document.querySelector<HTMLImageElement>('.bg-layer')
  if (!(layer instanceof HTMLImageElement)) return null
  const url = layer.currentSrc || layer.src
  const iw = layer.naturalWidth
  const ih = layer.naturalHeight
  const W = window.innerWidth
  const H = window.innerHeight
  if (!url || !iw || !ih || W < 2 || H < 2) return null
  const s = Math.max((W + 128) / iw, (H + 128) / ih)
  const width = iw * s
  const height = ih * s
  return {
    url,
    width,
    height,
    left: (W + 128 - width) / 2 - 64,
    top: (H + 128 - height) / 2 - 64
  }
}

export function captureWallpaperBackground(
  dpr: number,
  options: { dim?: boolean } = {}
): HTMLCanvasElement | null {
  const layer = document.querySelector<HTMLImageElement | HTMLVideoElement>('.bg-layer')
  if (!layer) return null
  const video = layer instanceof HTMLVideoElement
  const iw = video ? layer.videoWidth : layer.naturalWidth
  const ih = video ? layer.videoHeight : layer.naturalHeight
  const W = window.innerWidth
  const H = window.innerHeight
  if (!iw || !ih || W < 2 || H < 2) return null

  // object-fit: cover over the (W+128)×(H+128) layer; the window sees the
  // central W×H of that box (see `.bg-layer` / wallpaperRegion.ts).
  const s = Math.max((W + 128) / iw, (H + 128) / ih)
  const imgX = (W + 128 - iw * s) / 2 - 64
  const imgY = (H + 128 - ih * s) / 2 - 64

  const style = getComputedStyle(document.documentElement)
  const blur = parseFloat(style.getPropertyValue('--wallpaper-blur')) || 0
  const dim = Math.min(1, Math.max(0, parseFloat(style.getPropertyValue('--wallpaper-dim')) || 0))
  // Pad by the blur radius so blurring never fades the window edges.
  const pad = blur > 0 ? Math.ceil(blur * 3) : 0
  const srcX = (-pad - imgX) / s
  const srcY = (-pad - imgY) / s
  const srcW = (W + 2 * pad) / s
  const srcH = (H + 2 * pad) / s

  const out = document.createElement('canvas')
  out.width = Math.round(W * dpr)
  out.height = Math.round(H * dpr)
  const ctx = out.getContext('2d')
  if (!ctx) return null
  try {
    if (pad > 0) {
      const tmp = document.createElement('canvas')
      tmp.width = Math.round((W + 2 * pad) * dpr)
      tmp.height = Math.round((H + 2 * pad) * dpr)
      const tctx = tmp.getContext('2d')
      if (!tctx) return null
      tctx.filter = `blur(${blur * dpr}px)`
      tctx.drawImage(layer, srcX, srcY, srcW, srcH, 0, 0, tmp.width, tmp.height)
      ctx.drawImage(tmp, pad * dpr, pad * dpr, W * dpr, H * dpr, 0, 0, out.width, out.height)
    } else {
      ctx.drawImage(layer, srcX, srcY, srcW, srcH, 0, 0, out.width, out.height)
    }
    if (dim > 0 && options.dim !== false) {
      ctx.fillStyle = `rgba(0, 0, 0, ${dim})`
      ctx.fillRect(0, 0, out.width, out.height)
    }
  } catch {
    return null
  }
  return out
}
