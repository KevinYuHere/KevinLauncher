import { useEffect, useRef, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { captureWallpaperBackground, wallpaperImageSource } from '../wallpaperTexture'
import AtomShield from './AtomShield'

interface WallpaperShatterProps {
  /** Click origin in window-normalised top-left coordinates (0..1). */
  originX: number
  originY: number
  onDone: () => void
}

interface Pt {
  x: number
  y: number
}

const TAU = Math.PI * 2

/**
 * Randomised wallpaper shatter for launch.
 *
 * The old version cut a jittered rectangular grid, which still read as a mesh.
 * This version scatters independent irregular triangles (dart-throwing for
 * spacing), so neither the silhouettes nor the coverage form a grid. About 70%
 * of the shards are pulled into the singularity; the rest tumble/fade away.
 * The texture is the wallpaper itself, never a screenshot of the launcher.
 */
export default function WallpaperShatter({
  originX,
  originY,
  onDone
}: WallpaperShatterProps): ReactElement {
  const layerRef = useRef<HTMLDivElement>(null)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    const W = window.innerWidth
    const H = window.innerHeight
    const ox = originX * W
    const oy = originY * H
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const source = wallpaperImageSource()
    let image: string | null = source?.url ?? null
    let bgWidth = source?.width ?? W
    let bgHeight = source?.height ?? H
    let bgLeft = source?.left ?? 0
    let bgTop = source?.top ?? 0
    if (!image) {
      const canvas = captureWallpaperBackground(dpr)
      try {
        image = canvas ? canvas.toDataURL('image/jpeg', 0.82) : null
      } catch {
        image = null
      }
    }
    if (!source) {
      bgWidth = W
      bgHeight = H
      bgLeft = 0
      bgTop = 0
    }

    // Blue-noise-ish centres (rejection sampling), then one irregular triangle
    // per centre. This is intentionally not a lattice.
    const count = 60
    const centers: Pt[] = []
    const minDist = Math.min(W, H) * 0.06
    let attempts = 0
    while (centers.length < count && attempts < count * 45) {
      attempts += 1
      const p = { x: Math.random() * W, y: Math.random() * H }
      if (centers.every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= minDist)) {
        centers.push(p)
      }
    }
    while (centers.length < count) centers.push({ x: Math.random() * W, y: Math.random() * H })

    const shards: HTMLElement[] = []
    let longest = 0
    // An intact wallpaper plate crossfades into the shards, so the first frames
    // read as the page cracking open rather than a mosaic that was always there.
    const intact = document.createElement('div')
    intact.className = 'launch-intact'
    if (image) {
      intact.style.backgroundImage = `url(${image})`
      intact.style.backgroundSize = `${bgWidth}px ${bgHeight}px`
      intact.style.backgroundPosition = `${bgLeft}px ${bgTop}px`
    }
    layer.parentElement?.insertBefore(intact, layer)
    intact.animate([{ opacity: 1 }, { opacity: 1, offset: 0.35 }, { opacity: 0 }], {
      duration: 240,
      fill: 'forwards'
    })
    for (const center of centers) {
      const size = Math.min(W, H) * (0.07 + Math.random() * 0.24) + 26
      const a0 = Math.random() * TAU
      const a1 = a0 + 1.1 + Math.random() * 1.5
      const a2 = a1 + 1.1 + Math.random() * 1.5
      const tri: Pt[] = [a0, a1, a2].map((angle, i) => {
        const radius = size * (0.6 + Math.random() * 0.55)
        return {
          x: center.x + Math.cos(angle + i * 0.08) * radius,
          y: center.y + Math.sin(angle + i * 0.08) * radius
        }
      })

      const left = Math.min(...tri.map((p) => p.x))
      const top = Math.min(...tri.map((p) => p.y))
      const right = Math.max(...tri.map((p) => p.x))
      const bottom = Math.max(...tri.map((p) => p.y))
      const width = Math.max(1, right - left)
      const height = Math.max(1, bottom - top)
      if (width < 16 || height < 16) continue

      const el = document.createElement('i')
      el.className = 'launch-shard'
      el.style.left = `${left}px`
      el.style.top = `${top}px`
      el.style.width = `${width}px`
      el.style.height = `${height}px`
      if (image) {
        el.style.backgroundImage = `url(${image})`
        el.style.backgroundSize = `${bgWidth}px ${bgHeight}px`
        el.style.backgroundPosition = `${bgLeft - left}px ${bgTop - top}px`
      }
      // Slight inward clip so each shard is a distinct triangle with real gaps.
      const cx0 = tri.reduce((a, p) => a + p.x, 0) / 3
      const cy0 = tri.reduce((a, p) => a + p.y, 0) / 3
      const gapScale = 0.93
      el.style.clipPath = `polygon(${tri
        .map((p) => {
          const x = cx0 + (p.x - cx0) * gapScale
          const y = cy0 + (p.y - cy0) * gapScale
          return `${(x - left).toFixed(1)}px ${(y - top).toFixed(1)}px`
        })
        .join(',')})`
      layer.appendChild(el)
      shards.push(el)

      const cx = left + width / 2
      const cy = top + height / 2
      const sucked = Math.random() < 0.7
      const pull = 0.7 + Math.random() * 0.16
      const dx = sucked ? (ox - cx) * pull : (cx - ox) * 0.2 + (Math.random() - 0.5) * 170
      const dy = sucked
        ? (oy - cy) * pull
        : (cy - oy) * 0.2 + (Math.random() - 0.32) * 120
      const rot = (Math.random() - 0.5) * 220
      const scale = 0.03 + Math.random() * 0.2
      const dist = Math.hypot(cx - ox, cy - oy)
      const delay = Math.min(110, (dist / Math.max(W, H)) * 140) + Math.random() * 25
      const duration = (sucked ? 560 : 680) + Math.random() * 260
      longest = Math.max(longest, delay + duration)
      el.animate(
        [
          { transform: 'translate(0, 0) rotate(0deg) scale(1.02)', opacity: 0 },
          {
            offset: 0.14,
            transform: 'translate(0, 0) rotate(0deg) scale(0.96)',
            opacity: 1
          },
          {
            offset: 0.68,
            transform: `translate(${(dx * 0.58).toFixed(1)}px, ${(dy * 0.58).toFixed(
              1
            )}px) rotate(${(rot * 0.58).toFixed(1)}deg) scale(${(
              0.96 -
              (0.96 - scale) * 0.58
            ).toFixed(3)})`,
            opacity: 1
          },
          {
            transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) rotate(${rot.toFixed(
              1
            )}deg) scale(${scale.toFixed(3)})`,
            opacity: 0
          }
        ],
        {
          duration,
          delay,
          easing: 'cubic-bezier(0.45, 0, 0.78, 1)',
          fill: 'both'
        }
      )
    }

    const timer = window.setTimeout(() => onDoneRef.current(), longest + 130)
    return () => {
      window.clearTimeout(timer)
      intact.remove()
      for (const el of shards) el.remove()
    }
  }, [originX, originY])

  return createPortal(
    <div
      className="launch-shatter"
      aria-hidden="true"
      style={{
        ['--ox' as string]: `${originX * 100}%`,
        ['--oy' as string]: `${originY * 100}%`
      }}
    >
      <div className="launch-shatter-void" />
      <div className="launch-shards" ref={layerRef} />
      <div
        className="launch-distortion"
        style={{ left: `${originX * 100}%`, top: `${originY * 100}%` }}
        aria-hidden="true"
      />
      <span
        className="launch-atom"
        style={{ left: `${originX * 100}%`, top: `${originY * 100}%` }}
        aria-hidden="true"
      >
        <AtomShield state="selected" size={88} />
      </span>
      <div className="launch-shatter-flash" />
    </div>,
    document.body
  )
}
