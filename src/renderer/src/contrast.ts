/**
 * Pick the black/white foreground for text/icons drawn **directly over the game
 * background** (page titles, subtitles, pools bar, rail, game row, window
 * buttons). One value per page, from the wallpaper as actually shown:
 * wallpaper → the scrim gradient → the background dimming. Glass surfaces keep
 * using `--fg*` (glass brightness) instead.
 */

/** Elements drawn over the background (kept only to clear stale inline values). */
const TARGETS =
  '.page-title, .page-subtitle, .pools-bar .panel-title, .rail-item, .game-chip, .game-add, .games-toggle, .win-btn, .rail-update-btn'

let canvas: HTMLCanvasElement | null = null

function parseRgb(value: string): [number, number, number] {
  const match = /(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [8, 10, 15]
}

/** Recompute the page-wide over-background foreground. */
export function updateChromeContrast(): void {
  const bg = document.querySelector<HTMLImageElement | HTMLVideoElement>('.bg-layer')
  if (!bg) return

  const vw = window.innerWidth
  const vh = window.innerHeight
  if (vw < 2 || vh < 2) return
  const nw = bg instanceof HTMLVideoElement ? bg.videoWidth : bg.naturalWidth
  const nh = bg instanceof HTMLVideoElement ? bg.videoHeight : bg.naturalHeight
  if (!nw || !nh) return

  const W = 96
  const H = Math.max(2, Math.round((96 * vh) / vw))
  canvas = canvas ?? document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return

  // Draw the visible part of the background (object-fit: cover) to a small canvas.
  const scale = Math.max(vw / nw, vh / nh)
  const sx = (nw * scale - vw) / 2 / scale
  const sy = (nh * scale - vh) / 2 / scale
  try {
    ctx.drawImage(bg, sx, sy, vw / scale, vh / scale, 0, 0, W, H)
  } catch {
    return
  }
  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(0, 0, W, H).data
  } catch {
    return
  }

  const root = getComputedStyle(document.documentElement)
  const [sr, sg, sb] = parseRgb(root.getPropertyValue('--scrim-rgb'))
  const scrimLum = 0.2126 * sr + 0.7152 * sg + 0.0722 * sb
  // User-facing background dimming (0..1) — the scrim itself is scaled by it too.
  const dim = Math.max(0, Math.min(1, parseFloat(root.getPropertyValue('--bg-dim')) || 0))

  // Scrim gradients (180deg: 0.5@0%, 0.12@26%, 0.72@100%; 90deg: 0.55 fading by 22%).
  const verticalAlpha = (ty: number): number =>
    (ty <= 0.26 ? 0.5 + (0.12 - 0.5) * (ty / 0.26) : 0.12 + (0.72 - 0.12) * ((ty - 0.26) / 0.74)) *
    dim
  const horizontalAlpha = (tx: number): number => (tx >= 0.22 ? 0 : 0.55 * (1 - tx / 0.22)) * dim

  let sum = 0
  let count = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const bgLum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
      const va = verticalAlpha(y / H)
      const ha = horizontalAlpha(x / W)
      const a = 1 - (1 - va) * (1 - ha)
      // The extra black dim layer sits on top at 0.7 × dim.
      sum += (bgLum * (1 - a) + scrimLum * a) * (1 - 0.7 * dim)
      count++
    }
  }
  if (count === 0) return
  const luminance = sum / count

  const rgb = luminance < 140 ? '255, 255, 255' : '16, 19, 26'
  const rootStyle = document.documentElement.style
  rootStyle.setProperty('--chrome-fg', `rgba(${rgb}, 1)`)
  rootStyle.setProperty('--chrome-fg-2', `rgba(${rgb}, 0.72)`)
  rootStyle.setProperty('--chrome-fg-3', `rgba(${rgb}, 0.5)`)

  // Drop any stale per-element override so the page-wide value wins.
  for (const el of document.querySelectorAll<HTMLElement>(TARGETS)) {
    el.style.removeProperty('--chrome-fg')
    el.style.removeProperty('--chrome-fg-2')
    el.style.removeProperty('--chrome-fg-3')
  }
}
