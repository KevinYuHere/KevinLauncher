import { useEffect, useRef, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { captureWallpaperBackground, wallpaperImageSource } from '../wallpaperTexture'

interface WallpaperBurstProps {
  /** Click origin in window-normalised top-left coordinates (0..1). */
  originX: number
  originY: number
  onDone: () => void
}

interface Pt {
  x: number
  y: number
}

interface Triangle {
  tri: [Pt, Pt, Pt]
  left: number
  top: number
  width: number
  height: number
  cx: number
  cy: number
  dx: number
  dy: number
  rot: number
  scale: number
  delay: number
  duration: number
}

const TAU = Math.PI * 2

/**
 * 「星屑碎裂」: the click-effect triangle language scaled up to the window.
 *
 * Drawn on one canvas rather than one DOM layer per shard: 240 full-viewport
 * background layers were enough to exhaust Chromium's tile memory. A canvas
 * keeps GPU memory flat and starts as soon as the wallpaper image decodes.
 */
export default function WallpaperBurst({
  originX,
  originY,
  onDone
}: WallpaperBurstProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const W = window.innerWidth
    const H = window.innerHeight
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)

    const ox = originX * W
    const oy = originY * H
    let cancelled = false
    let raf = 0
    let timer = 0

    const start = async (): Promise<void> => {
      const source = wallpaperImageSource()
      let img: CanvasImageSource | null = null
      let iw = 0
      let ih = 0
      let bgWidth = W
      let bgHeight = H
      let bgLeft = 0
      let bgTop = 0

      if (source) {
        // Reuse the already-decoded wallpaper element. Decoding a second Image
        // delayed the first frame by ~80ms, which was visible on click.
        const layer = document.querySelector<HTMLImageElement | HTMLVideoElement>('.bg-layer')
        if (layer instanceof HTMLImageElement && layer.complete && layer.naturalWidth) {
          img = layer
          iw = layer.naturalWidth
          ih = layer.naturalHeight
        } else if (layer instanceof HTMLVideoElement && layer.readyState >= 2) {
          img = layer
          iw = layer.videoWidth
          ih = layer.videoHeight
        } else {
          try {
            const image = new Image()
            image.src = source.url
            await image.decode()
            img = image
            iw = image.naturalWidth
            ih = image.naturalHeight
          } catch {
            img = null
          }
        }
        bgWidth = source.width
        bgHeight = source.height
        bgLeft = source.left
        bgTop = source.top
      }
      if (!img) {
        const fallback = captureWallpaperBackground(dpr)
        if (fallback) {
          img = fallback
          iw = fallback.width
          ih = fallback.height
        }
      }
      if (cancelled) return

      // Random independent triangles, not a lattice.
      const count = 240
      const centers: Pt[] = []
      const minDist = Math.min(W, H) * 0.028
      let attempts = 0
      while (centers.length < count && attempts < count * 55) {
        attempts += 1
        const p = { x: Math.random() * W, y: Math.random() * H }
        if (centers.every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= minDist)) {
          centers.push(p)
        }
      }
      while (centers.length < count) centers.push({ x: Math.random() * W, y: Math.random() * H })

      const shards: Triangle[] = []
      let longest = 0
      for (const center of centers) {
        const size = Math.min(W, H) * (0.07 + Math.random() * 0.23) + 20
        const a0 = Math.random() * TAU
        const a1 = a0 + 1.1 + Math.random() * 1.5
        const a2 = a1 + 1.1 + Math.random() * 1.5
        const tri = [a0, a1, a2].map((angle, i) => {
          const radius = size * (0.6 + Math.random() * 0.55)
          return {
            x: center.x + Math.cos(angle + i * 0.08) * radius,
            y: center.y + Math.sin(angle + i * 0.08) * radius
          }
        }) as [Pt, Pt, Pt]
        const left = Math.min(...tri.map((p) => p.x))
        const top = Math.min(...tri.map((p) => p.y))
        const width = Math.max(1, Math.max(...tri.map((p) => p.x)) - left)
        const height = Math.max(1, Math.max(...tri.map((p) => p.y)) - top)
        if (width < 12 || height < 12) continue
        const cx = left + width / 2
        const cy = top + height / 2
        const dist = Math.hypot(cx - ox, cy - oy)
        const delay = Math.min(190, (dist / Math.max(W, H)) * 220) + Math.random() * 40
        const duration = 1000 + Math.random() * 500
        longest = Math.max(longest, delay + duration)
        shards.push({
          tri,
          left,
          top,
          width,
          height,
          cx,
          cy,
          dx: (cx - ox) * (0.85 + Math.random() * 0.5) + (Math.random() - 0.5) * 120,
          dy: (cy - oy) * (0.85 + Math.random() * 0.5) + (Math.random() - 0.35) * 120,
          rot: (Math.random() - 0.5) * 260,
          scale: 0.16,
          delay,
          duration
        })
      }

      const begin = performance.now()
      const draw = (now: number): void => {
        if (cancelled) return
        const elapsed = now - begin
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, W, H)
        const voidFill = ctx.createRadialGradient(ox, oy, 0, ox, oy, Math.hypot(W, H))
        voidFill.addColorStop(0, '#070b16')
        voidFill.addColorStop(0.72, '#02040a')
        voidFill.addColorStop(1, '#000')
        ctx.fillStyle = voidFill
        ctx.fillRect(0, 0, W, H)

        if (img) {
          // Intact wallpaper first, then fade it as the triangles appear.
          const intact = 1 - Math.min(1, Math.max(0, (elapsed - 70) / 230))
          if (intact > 0) {
            ctx.globalAlpha = intact
            ctx.drawImage(img, bgLeft, bgTop, bgWidth, bgHeight)
            ctx.globalAlpha = 1
          }

          for (const s of shards) {
            const u = Math.min(1, Math.max(0, (elapsed - s.delay) / s.duration))
            if (u <= 0 || u >= 1) continue
            const e = 1 - Math.pow(1 - u, 3)
            const alphaIn = Math.min(1, u / 0.12)
            const alphaOut = u > 0.7 ? 1 - (u - 0.7) / 0.3 : 1
            const alpha = alphaIn * alphaOut
            if (alpha <= 0) continue

            // Source crop in image pixels for the triangle's original bbox.
            const sx = ((s.left - bgLeft) / bgWidth) * iw
            const sy = ((s.top - bgTop) / bgHeight) * ih
            const sw = (s.width / bgWidth) * iw
            const sh = (s.height / bgHeight) * ih

            ctx.save()
            ctx.globalAlpha = alpha
            ctx.translate(s.cx + s.dx * e, s.cy + s.dy * e)
            ctx.rotate((s.rot * e * Math.PI) / 180)
            const sc = 1 - (1 - s.scale) * e
            ctx.scale(sc, sc)
            ctx.beginPath()
            s.tri.forEach((p, i) => {
              const x = p.x - s.cx
              const y = p.y - s.cy
              if (i === 0) ctx.moveTo(x, y)
              else ctx.lineTo(x, y)
            })
            ctx.closePath()
            ctx.clip()
            ctx.drawImage(
              img,
              sx,
              sy,
              sw,
              sh,
              s.left - s.cx,
              s.top - s.cy,
              s.width,
              s.height
            )
            ctx.restore()
          }
        }
        if (elapsed < longest) {
          raf = requestAnimationFrame(draw)
        } else {
          timer = window.setTimeout(() => onDoneRef.current(), 80)
        }
      }
      raf = requestAnimationFrame(draw)
    }

    void start()
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
    }
  }, [originX, originY])

  return createPortal(
    <div
      className="launch-shatter launch-burst"
      aria-hidden="true"
      style={{
        ['--ox' as string]: `${originX * 100}%`,
        ['--oy' as string]: `${originY * 100}%`
      }}
    >
      <div className="launch-shatter-void" />
      <canvas ref={canvasRef} className="launch-burst-canvas" />
    </div>,
    document.body
  )
}
