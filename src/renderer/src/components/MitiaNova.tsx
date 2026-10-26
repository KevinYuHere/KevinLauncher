import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import { burstMitiaMolecules } from '../themeParticles'
import StarSpiral from './StarSpiral'

interface MitiaNovaProps {
  originX: number
  originY: number
}

const STAR_PATH =
  'M50 2C50 39.4 60 50 78 50C60 50 50 60.6 50 98C50 60.6 40 50 22 50C40 50 50 39.4 50 2Z'

/** A few ball-and-stick molecules like the material texture. */
const MOLECULE_SVGS = [
  '<svg viewBox="0 0 64 32" width="100%" height="100%">' +
    '<line x1="14" y1="16" x2="50" y2="16" stroke="#9d8bf5" stroke-width="2" stroke-opacity=".6"/>' +
    '<circle cx="14" cy="16" r="10" fill="#1b1240" stroke="#e8c87a" stroke-width="2.2"/>' +
    '<circle cx="50" cy="16" r="7.5" fill="#1b1240" stroke="#b9a8f6" stroke-width="2"/></svg>',
  '<svg viewBox="0 0 64 32" width="100%" height="100%">' +
    '<line x1="10" y1="22" x2="34" y2="9" stroke="#9d8bf5" stroke-width="2" stroke-opacity=".6"/>' +
    '<line x1="34" y1="9" x2="55" y2="22" stroke="#9d8bf5" stroke-width="2" stroke-opacity=".6"/>' +
    '<circle cx="10" cy="22" r="8" fill="#1b1240" stroke="#e8c87a" stroke-width="2"/>' +
    '<circle cx="34" cy="9" r="9.5" fill="#1b1240" stroke="#e8c87a" stroke-width="2.2"/>' +
    '<circle cx="55" cy="22" r="6" fill="#1b1240" stroke="#b9a8f6" stroke-width="1.8"/></svg>',
  '<svg viewBox="0 0 64 32" width="100%" height="100%">' +
    '<line x1="32" y1="7" x2="55" y2="16" stroke="#9d8bf5" stroke-width="1.6" stroke-opacity=".55"/>' +
    '<line x1="55" y1="16" x2="32" y2="25" stroke="#9d8bf5" stroke-width="1.6" stroke-opacity=".55"/>' +
    '<line x1="32" y1="25" x2="9" y2="16" stroke="#9d8bf5" stroke-width="1.6" stroke-opacity=".55"/>' +
    '<line x1="9" y1="16" x2="32" y2="7" stroke="#9d8bf5" stroke-width="1.6" stroke-opacity=".55"/>' +
    '<circle cx="32" cy="7" r="7" fill="#1b1240" stroke="#e8c87a" stroke-width="2"/>' +
    '<circle cx="55" cy="16" r="6" fill="#1b1240" stroke="#b9a8f6" stroke-width="1.8"/>' +
    '<circle cx="32" cy="25" r="6.5" fill="#1b1240" stroke="#e8c87a" stroke-width="1.8"/>' +
    '<circle cx="9" cy="16" r="5" fill="#1b1240" stroke="#b9a8f6" stroke-width="1.6"/></svg>'
]

interface LiveStar {
  html: string
  left: number
  top: number
  size: number
}

/**
 * 星轨手记 launch overlay.
 *
 * The cross star is reused from the live launch button when it is currently
 * shown (same look, same place) and sits on top of everything; only when the
 * button has no star do we draw a fresh one at the trigger point. Around it a
 * huge spiral of light and molecule formulas are dragged into the star while
 * the black-hole shader warps the captured wallpaper.
 */
export default function MitiaNova({ originX, originY }: MitiaNovaProps): ReactElement {
  const [live, setLive] = useState<LiveStar | null>(null)

  useEffect(() => {
    const source = document.querySelector<HTMLElement>('.start-atom .star-cross')
    if (!source) return
    const rect = source.getBoundingClientRect()
    setLive({
      html: source.outerHTML,
      left: rect.left + rect.width / 2,
      top: rect.top + rect.height / 2,
      size: rect.width
    })
  }, [])

  const cx = live ? live.left : originX * window.innerWidth
  const cy = live ? live.top : originY * window.innerHeight

  // Diameter that certainly covers the window from this star's position; the
  // late phase uses a cheap solid flood instead of scaling the SVG to it.
  const coverSpan = useMemo(() => {
    const w = window.innerWidth
    const h = window.innerHeight
    const maxDist = Math.max(
      Math.hypot(cx, cy),
      Math.hypot(w - cx, cy),
      Math.hypot(cx, h - cy),
      Math.hypot(w - cx, h - cy)
    )
    return Math.ceil(2 * maxDist + 40)
  }, [cx, cy])

  useEffect(() => {
    const timers: number[] = []
    for (let i = 0; i < 7; i += 1) {
      timers.push(
        window.setTimeout(() => {
          const angle = Math.random() * Math.PI * 2
          const distance = 220 + Math.random() * 260
          burstMitiaMolecules(cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance, {
            count: 1,
            distance
          })
        }, 80 + i * 95)
      )
    }
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [cx, cy])

  const molecules = useMemo(() => {
    return Array.from({ length: 14 }, (_, i) => {
      const angle = (i / 14) * Math.PI * 2 + Math.random() * 0.5
      const distance = 240 + Math.random() * 420
      const size = 160 + Math.random() * 120
      return {
        key: i,
        left: Math.cos(angle) * distance,
        top: Math.sin(angle) * distance,
        size,
        html: MOLECULE_SVGS[i % MOLECULE_SVGS.length],
        rot: `${Math.round((Math.random() * 2 - 1) * 220)}deg`,
        delay: `${Math.round(Math.random() * 260)}ms`
      }
    })
  }, [])

  return (
    <div className="mitia-nova" aria-hidden="true">
      <div className="mitia-nova-spiral" style={{ left: `${originX * 100}%`, top: `${originY * 100}%` }}>
        <StarSpiral />
      </div>
      {molecules.map((m) => (
        <span
          key={m.key}
          className="mitia-nova-molecule"
          style={
            {
              left: `${cx + m.left}px`,
              top: `${cy + m.top}px`,
              width: `${m.size}px`,
              height: `${m.size / 2}px`,
              '--dx': `${-m.left}px`,
              '--dy': `${-m.top}px`,
              '--rot': m.rot,
              animationDelay: m.delay
            } as CSSProperties
          }
          dangerouslySetInnerHTML={{ __html: m.html }}
        />
      ))}
      <span
        className="mitia-nova-flood"
        style={{
          left: `${cx}px`,
          top: `${cy}px`,
          width: `${coverSpan}px`,
          height: `${coverSpan}px`
        }}
      />
      {live ? (
        <span
          className="mitia-nova-star live"
          style={{
            left: `${live.left}px`,
            top: `${live.top}px`,
            width: `${live.size}px`,
            height: `${live.size}px`,
            margin: `${-live.size / 2}px 0 0 ${-live.size / 2}px`
          }}
          // A copy of the button's own star, so the launch keeps its exact look.
          dangerouslySetInnerHTML={{ __html: live.html }}
        />
      ) : (
        <span className="mitia-nova-star">
          <svg viewBox="0 0 100 100" width="100%" height="100%">
            <path d={STAR_PATH} fill="#1b1240" stroke="#c9bff2" strokeWidth="1.1" />
          </svg>
        </span>
      )}
    </div>
  )
}
