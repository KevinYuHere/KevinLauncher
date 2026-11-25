import type { CSSProperties, ReactElement } from 'react'

interface CubeMarkProps {
  size?: number
  className?: string
}

const FACES = ['front', 'back', 'right', 'left', 'top', 'bottom'] as const

/** Must match the `cube3d-turn` animation duration in main.css. */
const SPIN_SECONDS = 12
const spinStart = typeof performance === 'undefined' ? 0 : performance.now()

/**
 * 「星轨手记」sidebar mark: a real 3D cube (CSS transforms) that tumbles
 * continuously on all three axes, with gold edges, glassy violet faces and the
 * white triangle glyph from the name card. When the selection moves to another
 * rail item the element is re-mounted; the negative animation delay resumes the
 * same phase, so the cube keeps turning instead of snapping back.
 */
export default function CubeMark({ size = 46, className }: CubeMarkProps): ReactElement {
  const edge = Math.max(18, Math.round(size * 0.66))
  const phase = typeof performance === 'undefined' ? 0 : ((performance.now() - spinStart) / 1000) % SPIN_SECONDS
  const style = { '--cube-edge': `${edge}px` } as CSSProperties
  return (
    <span className={`cube3d${className ? ` ${className}` : ''}`} style={style} aria-hidden="true">
      <span className="cube3d-spin" style={{ animationDelay: `-${phase.toFixed(3)}s` }}>
        {FACES.map((face) => (
          <span key={face} className={`cube3d-face cube3d-${face}`} />
        ))}
      </span>
    </span>
  )
}
