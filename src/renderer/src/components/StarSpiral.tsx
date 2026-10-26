import type { ReactElement } from 'react'

interface StarSpiralProps {
  className?: string
}

/**
 * One tapered filament: a **constant-curvature arc** from the outside into the
 * centre (a circular arc, not a spiral), so the ribbon bends just as gently
 * near the star as it does far away.
 */
function filament(offsetDeg: number, width: number): string {
  const steps = 72
  const phi = (offsetDeg * Math.PI) / 180
  // Start moved inwards (22 instead of 42) so the arc is half as long while the
  // end stays exactly at the star's centre.
  const startX = 50 + 22 * Math.cos(phi)
  const startY = 50 + 22 * Math.sin(phi)
  const endX = 50
  const endY = 50
  const dx = endX - startX
  const dy = endY - startY
  const dist = Math.hypot(dx, dy)
  const radius = 42
  const half = dist / 2
  const h = Math.sqrt(Math.max(0, radius * radius - half * half))
  const midX = (startX + endX) / 2
  const midY = (startY + endY) / 2
  // Perpendicular offset: choose the side that bows outward, consistently.
  const ox = midX + (-dy / dist) * h
  const oy = midY + (dx / dist) * h
  const a0 = Math.atan2(startY - oy, startX - ox)
  let a1 = Math.atan2(endY - oy, endX - ox)
  let delta = a1 - a0
  if (delta > Math.PI) delta -= Math.PI * 2
  if (delta < -Math.PI) delta += Math.PI * 2
  const outer: string[] = []
  const inner: string[] = []
  for (let i = 0; i <= steps; i += 1) {
    // Full arc: the band must end at the star's centre, not halfway.
    const t = i / steps
    const a = a0 + delta * t
    // Nearly constant width (as in the sketch).
    const u = t
    const w = width * (0.62 + 0.38 * (1 - u))
    const co = Math.cos(a)
    const si = Math.sin(a)
    outer.push(`${(ox + (radius + w / 2) * co).toFixed(2)} ${(oy + (radius + w / 2) * si).toFixed(2)}`)
    inner.push(`${(ox + (radius - w / 2) * co).toFixed(2)} ${(oy + (radius - w / 2) * si).toFixed(2)}`)
  }
  return `M${outer.join(' L')} L${inner.reverse().join(' L')} Z`
}

/**
 * 星轨手记 accretion energy: three wide tapered ribbons spiralling into a
 * bright core while the launch button is hovered or pressed. They breathe
 * (翕张) on their own cadence — no rotation and deliberately out of sync with
 * the star — and carry a travelling light sheen.
 */
export default function StarSpiral({ className }: StarSpiralProps): ReactElement {
  const strands = [0, 120, 240].map((angle, i) => ({
    angle: angle + i * 9,
    width: 3.4 + i * 0.5
  }))
  return (
    <svg
      className={`star-spiral${className ? ` ${className}` : ''}`}
      viewBox="0 0 100 100"
      width={240}
      height={240}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* Centred on the star (not on each path's bbox) so every ribbon is
            fully opaque at the star and fully transparent at its far end. */}
        <radialGradient
          id="mt-spiral-fill"
          gradientUnits="userSpaceOnUse"
          cx="50"
          cy="50"
          r="46"
        >
          {/* Opaque at the star, linearly fading to fully transparent at the
              far end. */}
          <stop offset="0" stopColor="#fff3cf" stopOpacity="1" />
          <stop offset="0.5" stopColor="#e8c87a" stopOpacity="0.55" />
          <stop offset="1" stopColor="#a78bfa" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="mt-spiral-core" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#fff8e2" stopOpacity="1" />
          <stop offset="0.4" stopColor="#ffeec2" stopOpacity="0.75" />
          <stop offset="1" stopColor="#e8c87a" stopOpacity="0" />
        </radialGradient>
        {/* The travelling sheen is clipped well inside the band's outer tip, so
            the outermost corners can never light up. */}
        <radialGradient
          id="mt-spiral-mask-grad"
          gradientUnits="userSpaceOnUse"
          cx="50"
          cy="50"
          r="26"
        >
          <stop offset="0" stopColor="#fff" stopOpacity="1" />
          <stop offset="0.6" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <mask id="mt-spiral-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <rect width="100" height="100" fill="url(#mt-spiral-mask-grad)" />
        </mask>
        <linearGradient id="mt-spiral-flow" x1="0" y1="0" x2="1" y2="0.35">
          <stop offset="0" stopColor="#fff8e2" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fff8e2" stopOpacity="0.85" />
          <stop offset="1" stopColor="#fff8e2" stopOpacity="0" />
          <animateTransform
            attributeName="gradientTransform"
            type="translate"
            values="-1 0; 1 0"
            dur="3.6s"
            repeatCount="indefinite"
          />
        </linearGradient>
      </defs>
      <g className="star-spiral-rotor">
        {strands.map((s, i) => {
        const phi = (s.angle * Math.PI) / 180
        const farX = 50 + 22 * Math.cos(phi)
        const farY = 50 + 22 * Math.sin(phi)
        // Gradient runs the whole arm: transparent at the outer tip, opaque at
        // the star's centre.
        return (
          <g key={i}>
            <linearGradient
              id={`mt-band-${i}`}
              gradientUnits="userSpaceOnUse"
              x1={farX.toFixed(2)}
              y1={farY.toFixed(2)}
              x2="50"
              y2="50"
            >
              {/* Yellow ↔ purple along the band: purple where it fades out,
                  yellow where it meets the star. */}
              <stop offset="0" stopColor="#8b5cf6" stopOpacity="0" />
              <stop offset="0.34" stopColor="#a78bfa" stopOpacity="0.35" />
              <stop offset="0.68" stopColor="#e8c87a" stopOpacity="0.8" />
              <stop offset="1" stopColor="#f7d97a" stopOpacity="1" />
            </linearGradient>
            <path d={filament(s.angle, s.width)} fill={`url(#mt-band-${i})`} />
            <path
              d={filament(s.angle, s.width)}
              fill="url(#mt-spiral-flow)"
              fillOpacity="0.35"
              mask="url(#mt-spiral-mask)"
            />
          </g>
        )
      })}
        <circle cx="50" cy="50" r="9" fill="url(#mt-spiral-core)" />
      </g>
    </svg>
  )
}
