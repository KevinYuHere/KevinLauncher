import { useEffect, type ReactElement } from 'react'
import { burstMitiaMolecules } from '../themeParticles'

interface MitiaNovaProps {
  originX: number
  originY: number
}

const STAR_PATH =
  'M50 2C50 39.4 60 50 78 50C60 50 50 60.6 50 98C50 60.6 40 50 22 50C40 50 50 39.4 50 2Z'

/**
 * 星轨手记 launch overlay: the cross star swells to twice its size above the
 * black-hole shader (which warps the captured wallpaper). Molecules are drawn
 * into the hole while it opens.
 */
export default function MitiaNova({ originX, originY }: MitiaNovaProps): ReactElement {
  useEffect(() => {
    const cx = originX * window.innerWidth
    const cy = originY * window.innerHeight
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
  }, [originX, originY])

  return (
    <div className="mitia-nova" aria-hidden="true">
      <span className="mitia-nova-star">
        <svg viewBox="0 0 100 100" width="100%" height="100%">
          <path d={STAR_PATH} fill="#1b1240" stroke="#c9bff2" strokeWidth="1.1" />
        </svg>
      </span>
    </div>
  )
}
