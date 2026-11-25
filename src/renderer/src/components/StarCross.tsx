import type { ReactElement } from 'react'

interface StarCrossProps {
  size?: number
  className?: string
}

/**
 * 「星轨手记」launch mark: the large tilted four-pointed *ink star* from
 * Mitia's illustration — a deep indigo brush silhouette with concave arms, a
 * violet rim and the faint cyan edge the art's ribbon leaves on it.
 */
export default function StarCross({ size = 88, className }: StarCrossProps): ReactElement {
  const classes = `star-cross${className ? ` ${className}` : ''}`
  // Smooth symmetric ink star (the previous shape), squeezed horizontally so it
  // reads as a slim sparkle rather than a wide one.
  const star =
    'M50 2C50 39.4 60 50 78 50C60 50 50 60.6 50 98C50 60.6 40 50 22 50C40 50 50 39.4 50 2Z'
  return (
    <svg
      className={classes}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="mt-ink-star" x1="16" y1="8" x2="84" y2="94" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4b3798" />
          <stop offset="0.45" stopColor="#241a52" />
          <stop offset="1" stopColor="#150e34" />
        </linearGradient>
        <linearGradient id="mt-ink-rim" x1="10" y1="6" x2="90" y2="96" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#c9bff2" />
          <stop offset="0.5" stopColor="#8f7cf0" />
          <stop offset="1" stopColor="#8fe3ff" />
        </linearGradient>
        <radialGradient id="mt-ink-bloom" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#8f7cf0" stopOpacity="0.35" />
          <stop offset="0.62" stopColor="#6c4bd8" stopOpacity="0.14" />
          <stop offset="1" stopColor="#6c4bd8" stopOpacity="0" />
        </radialGradient>
        {/* Smooth gold light band travelling along the outline (no dashes). */}
        <linearGradient id="mt-flow" gradientUnits="userSpaceOnUse" x1="-120" y1="0" x2="-40" y2="0">
          <stop offset="0" stopColor="#e8c87a" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fff3cf" stopOpacity="0.95" />
          <stop offset="1" stopColor="#e8c87a" stopOpacity="0" />
          <animate attributeName="x1" values="-120;140" dur="3.6s" repeatCount="indefinite" />
          <animate attributeName="x2" values="-40;220" dur="3.6s" repeatCount="indefinite" />
        </linearGradient>
      </defs>

      <circle className="star-cross-bloom" cx="50" cy="50" r="49" fill="url(#mt-ink-bloom)" />
      <path className="star-cross-shape" d={star} fill="url(#mt-ink-star)" />
      <path className="star-cross-sheen" d={star} fill="url(#mt-ink-rim)" opacity="0.1" />
      <path className="star-cross-edge" d={star} fill="none" stroke="url(#mt-ink-rim)" />
      {/* Restrained gold light running smoothly along the outline. */}
      <path className="mitia-flow" d={star} stroke="url(#mt-flow)" />
    </svg>
  )
}
