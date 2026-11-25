import { useEffect } from 'react'
import { useAreaTheme } from '../theme/ThemeScope'
import { burstMitiaMolecules, burstThemeTriangles, startMitiaHoldStar } from '../themeParticles'

/**
 * Themed click effect.
 *
 * - 霆骇列律: triangles burst out of the pointer in the app's theme colour.
 * - 星轨手记: a cross star pops open with a jelly wobble and spits molecules.
 *
 * Holding keeps repeating the effect. The games-bar toggle is excluded: it has
 * its own molecule trail (without a star).
 */
export default function ThemeClickEffect(): null {
  const theme = useAreaTheme('clickEffect')

  useEffect(() => {
    if (theme === 'default') return undefined
    const mitia = theme === 'mitia'

    let holdTimer = 0
    let held = false
    let holdX = 0
    let holdY = 0
    let mitiaStar: ReturnType<typeof startMitiaHoldStar> | null = null
    const stop = (): void => {
      held = false
      if (holdTimer) {
        window.clearInterval(holdTimer)
        holdTimer = 0
      }
      if (mitiaStar) {
        mitiaStar.stop()
        mitiaStar = null
      }
    }
    const onDown = (event: PointerEvent): void => {
      if (event.button !== 0) return
      const target = event.target as HTMLElement | null
      const gamesBar = document.documentElement.getAttribute('data-special-games-bar')
      if (target?.closest('.games-toggle') && (gamesBar === 'starsnow' || gamesBar === 'mitia')) {
        return
      }
      // Dragging a home module / sortable row is not a click: no star, no trail.
      if (target?.closest('.home-module.draggable, .sortable-row')) return
      stop()
      held = true
      holdX = event.clientX
      holdY = event.clientY
      if (mitia) {
        // One star for the whole press: it appears now, follows the pointer and
        // only fades on release.
        mitiaStar = startMitiaHoldStar(holdX, holdY)
        burstMitiaMolecules(holdX, holdY, { count: 1, distance: 70 })
      } else {
        burstThemeTriangles(holdX, holdY, { count: 12 })
        holdTimer = window.setInterval(() => {
          if (held) burstThemeTriangles(holdX, holdY, { count: 5, size: 9 })
        }, 160)
      }
    }
    const onMove = (event: PointerEvent): void => {
      if (!held) return
      holdX = event.clientX
      holdY = event.clientY
      mitiaStar?.move(holdX, holdY)
    }
    const onUp = (): void => stop()
    const onBlur = (): void => stop()
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      stop()
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [theme])

  return null
}
