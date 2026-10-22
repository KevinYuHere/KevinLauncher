import { useRef, type CSSProperties, type ReactElement } from 'react'

export type AtomShieldState =
  | 'idle'
  | 'selected'
  | 'downloading'
  | 'paused'
  | 'preparing'
  | 'applying'
  | 'done'
  | 'error'

interface AtomShieldProps {
  state?: AtomShieldState
  /** 0…1 while a job runs (shield = coarse, outer arc = fine). */
  progress?: number
  size?: number
  /** Accessible label (read by assistive tech, not drawn). */
  label?: string
  /**
   * Render only one layer. The launch button uses two instances: `orbits` behind
   * the opaque button (outer arcs peek out, the rest is occluded) and `core` in
   * front (the nucleus sits in the button's left cap), which gives a real 3D
   * depth instead of a flat mask.
   */
  parts?: 'full' | 'orbits' | 'core'
}

/** Three electrons tinted to the nucleus palette (ice / lavender / orchid). */
const ELECTRON_COLORS = ['#7dd3fc', '#c4b5fd', '#f0abfc']

/** One electron orbit: a static ellipse; only the electron travels along it. */
interface OrbitSpec {
  rotate: number
  r: number
  /** Reverse direction (so the three electrons do not move in lockstep). */
  reverse?: boolean
  /** Where the electron parks while paused (local orbit coordinates). */
  start: [number, number]
}

const ORBITS: OrbitSpec[] = [
  { rotate: 0, r: 1.2, start: [4, 16] },
  { rotate: 60, r: 1.05, reverse: true, start: [28, 16] },
  { rotate: 120, r: 0.9, start: [16, 11] }
]

/** Ellipse path used by `animateMotion` (starts at 4,16 and loops). */
const ORBIT_PATH = 'M4,16 a12,5 0 1,0 24,0 a12,5 0 1,0 -24,0'

/** Electron speed per state (SMIL `dur`). */
function electronDuration(state: AtomShieldState): string {
  switch (state) {
    case 'applying':
      return '2.2s'
    case 'downloading':
      return '5s'
    case 'preparing':
      return '3.5s'
    case 'selected':
      return '28s'
    case 'error':
      return '9s'
    default:
      return '14s'
  }
}

/**
 * 「霆核霜盾」: a dual-colour nucleus, three static orbits and a hex frost
 * shield. The shield is the coarse progress (6 segments), the outer arc the fine
 * progress.
 *
 * The orbit ellipses never rotate; each electron travels the ellipse with an
 * SVG `animateMotion` path, so the atom reads as a stable reactor instead of a
 * spinning diagram. States are CSS classes, so a theme decides what
 * "preparing" / "applying" look like.
 */
export default function AtomShield({
  state = 'idle',
  progress = 0,
  size = 30,
  label,
  parts = 'full'
}: AtomShieldProps): ReactElement {
  const showOrbits = parts !== 'core'
  const showCore = parts !== 'orbits'
  const p = Math.max(0, Math.min(1, progress))
  const circumference = 2 * Math.PI * 15
  const showArc =
    state !== 'selected' &&
    (p > 0 ||
      state === 'downloading' ||
      state === 'preparing' ||
      state === 'paused' ||
      state === 'applying')
  const animateElectrons = state !== 'paused'
  const duration = electronDuration(state)
  // Random phase per electron means the three never start from the same point.
  const phases = useRef(ORBITS.map(() => Math.random())).current

  return (
    <span
      className={`atom-shield is-${state}`}
      style={{ width: size, height: size }}
      role={showCore ? 'img' : undefined}
      aria-label={showCore ? (label ?? '霆核霜盾') : undefined}
      aria-hidden={showCore ? undefined : 'true'}
    >
      <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
        <defs>
          <radialGradient id="kl-atom-core" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#f2fbff" />
            <stop offset="48%" stopColor="#b9a6ff" />
            <stop offset="100%" stopColor="#7c5cff" />
          </radialGradient>
        </defs>
        {showOrbits && <circle className="atom-halo" cx="16" cy="16" r="15.2" />}
        {showOrbits && showArc && (
          <>
            <circle className="atom-progress-track" cx="16" cy="16" r="15" />
            <circle
              className="atom-progress"
              cx="16"
              cy="16"
              r="15"
              strokeDasharray={`${(circumference * p).toFixed(2)} ${circumference.toFixed(2)}`}
            />
          </>
        )}
        {showOrbits && (
          <g className="atom-orbits">
            {ORBITS.map((orbit, index) => (
              <g
                key={index}
                className="atom-orbit-wrapper"
                style={{ '--orbit': index } as CSSProperties}
              >
                <g transform={`rotate(${orbit.rotate} 16 16)`}>
                  <ellipse
                    className={`atom-orbit atom-orbit-${index}`}
                    cx="16"
                    cy="16"
                    rx="12"
                    ry="5"
                  />
                  <circle
                    className="atom-electron"
                    cx={animateElectrons ? 0 : orbit.start[0]}
                    cy={animateElectrons ? 0 : orbit.start[1]}
                    r={orbit.r}
                    fill={ELECTRON_COLORS[index]}
                    style={{
                      fill: ELECTRON_COLORS[index],
                      filter: `drop-shadow(0 0 3px ${ELECTRON_COLORS[index]})`
                    }}
                  >
                    {animateElectrons && (
                      <animateMotion
                        dur={duration}
                        begin={`-${(phases[index] * parseFloat(duration)).toFixed(2)}s`}
                        repeatCount="indefinite"
                        path={ORBIT_PATH}
                        calcMode="linear"
                        {...(orbit.reverse ? { keyPoints: '1;0', keyTimes: '0;1' } : {})}
                      />
                    )}
                  </circle>
                </g>
              </g>
            ))}
          </g>
        )}
        {showCore && (
          <>
            {parts === 'core' && <circle className="atom-core-ring" cx="16" cy="16" r="7.2" />}
            <circle
              className="atom-core"
              cx="16"
              cy="16"
              r={parts === 'core' ? 5.2 : 3.4}
              fill="url(#kl-atom-core)"
            />
          </>
        )}
      </svg>
    </span>
  )
}
