import type { ReactElement } from 'react'

/**
 * Compact Valeri-style shield for the selected sidebar icon: a six-segment hex
 * frame, two violet energy wings, gold vertices and a slow rune orbit. It is
 * deliberately inside the 46px rail slot so the rail's octagon clip cannot cut
 * the frame.
 */
export default function RailShield(): ReactElement {
  return (
    <span className="rail-shield" aria-hidden="true">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <g className="rail-shield-segments">
          <path pathLength="100" d="M50 3 91 26" />
          <path pathLength="100" d="M91 26V74" />
          <path pathLength="100" d="M91 74 50 97" />
          <path pathLength="100" d="M50 97 9 74" />
          <path pathLength="100" d="M9 74V26" />
          <path pathLength="100" d="M9 26 50 3" />
        </g>
        <g className="rail-shield-wings">
          <path
            className="rail-shield-wing rail-shield-wing-l"
            d="M3 17C-4 32-2 65 11 85 8 65 10 37 25 23 17 21 9 18 3 17Z"
          />
          <path
            className="rail-shield-wing rail-shield-wing-r"
            d="M97 17C104 32 102 65 89 85 92 65 90 37 75 23 83 21 91 18 97 17Z"
          />
          <path
            className="rail-shield-streak rail-shield-streak-l"
            d="M5 49C12 37 19 30 30 27"
          />
          <path
            className="rail-shield-streak rail-shield-streak-r"
            d="M95 49C88 37 81 30 70 27"
          />
        </g>
        <g className="rail-shield-nodes">
          <circle cx="50" cy="3" r="1.5" />
          <circle cx="91" cy="26" r="1.5" />
          <circle cx="91" cy="74" r="1.5" />
          <circle cx="50" cy="97" r="1.5" />
          <circle cx="9" cy="74" r="1.5" />
          <circle cx="9" cy="26" r="1.5" />
        </g>
        <circle className="rail-shield-orbit" cx="50" cy="50" r="41" />
      </svg>
    </span>
  )
}
