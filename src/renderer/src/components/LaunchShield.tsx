import { useRef, type ReactElement } from 'react'

/**
 * 瓦列里式霜盾 wrapped around the launch button.
 *
 * It appears on hover and pulses on click: six shield segments draw in, an outer
 * rune ring counter-rotates slowly, and the whole shield scales/fades out again.
 * Purely decorative — pointer events stay on the button underneath.
 */
export default function LaunchShield({ burst }: { burst: boolean }): ReactElement {
  // Random starting phase for the two rune orbits, so they never unfold from
  // the same angle on every hover.
  const angles = useRef([Math.random() * 360, Math.random() * 360]).current
  return (
    <span className={`launch-shield${burst ? ' is-burst' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 120 60" preserveAspectRatio="none">
        <polygon
          className="shield-fill"
          points="10,2 110,2 118,30 110,58 10,58 2,30"
        />
        <g className="shield-segments">
          <path pathLength="100" d="M10 3 H110" />
          <path pathLength="100" d="M110 3 L118 30" />
          <path pathLength="100" d="M118 30 L110 57" />
          <path pathLength="100" d="M110 57 H10" />
          <path pathLength="100" d="M10 57 L2 30" />
          <path pathLength="100" d="M2 30 L10 3" />
        </g>
        <g className="shield-wings">
          <path
            className="shield-wing shield-wing-l"
            d="M8 9 C -1 18, 0 42, 12 53 C 7 39, 9 22, 18 13 Z"
          />
          <path
            className="shield-wing shield-wing-r"
            d="M112 9 C 121 18, 120 42, 108 53 C 113 39, 111 22, 102 13 Z"
          />
        </g>
        <g className="shield-runes">
          <line x1="60" y1="0" x2="60" y2="4" />
          <line x1="60" y1="56" x2="60" y2="60" />
          <line x1="24" y1="6" x2="27" y2="10" />
          <line x1="96" y1="6" x2="93" y2="10" />
          <line x1="24" y1="54" x2="27" y2="50" />
          <line x1="96" y1="54" x2="93" y2="50" />
        </g>
        <ellipse
          className="shield-orbit"
          cx="60"
          cy="30"
          rx="51"
          ry="24"
          style={{ ['--shield-angle' as string]: `${angles[0].toFixed(1)}deg` }}
        />
        <ellipse
          className="shield-orbit shield-orbit-b"
          cx="60"
          cy="30"
          rx="44"
          ry="20"
          style={{ ['--shield-angle' as string]: `${angles[1].toFixed(1)}deg` }}
        />
        <g className="shield-nodes">
          <circle cx="10" cy="2" r="1.5" />
          <circle cx="110" cy="2" r="1.5" />
          <circle cx="118" cy="30" r="1.5" />
          <circle cx="110" cy="58" r="1.5" />
          <circle cx="10" cy="58" r="1.5" />
          <circle cx="2" cy="30" r="1.5" />
        </g>
      </svg>
    </span>
  )
}
