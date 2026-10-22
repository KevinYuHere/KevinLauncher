import { useEffect } from 'react'
import { useAreaTheme } from '../theme/ThemeScope'
import { burstThemeTriangles } from '../themeParticles'

/**
 * 霆骇列律 click effect: triangles burst out of the pointer in the app's theme
 * colour. Holding the button keeps emitting. The games-bar toggle has its own
 * burst at the toggle, so it is excluded here to avoid two overlapping bursts.
 */
export default function ThemeClickEffect(): null {
  const theme = useAreaTheme('clickEffect')

  useEffect(() => {
    if (theme === 'default') return undefined

    let holdTimer = 0
    let held = false
    let holdX = 0
    let holdY = 0
    const stop = (): void => {
      held = false
      if (holdTimer) {
        window.clearInterval(holdTimer)
        holdTimer = 0
      }
    }
    const onDown = (event: PointerEvent): void => {
      if (event.button !== 0) return
      const target = event.target as HTMLElement | null
      if (
        target?.closest('.games-toggle') &&
        document.documentElement.getAttribute('data-special-games-bar') === 'starsnow'
      ) {
        return
      }
      stop()
      held = true
      holdX = event.clientX
      holdY = event.clientY
      burstThemeTriangles(holdX, holdY, { count: 12 })
      holdTimer = window.setInterval(() => {
        if (held) burstThemeTriangles(holdX, holdY, { count: 5, size: 9 })
      }, 160)
    }
    const onMove = (event: PointerEvent): void => {
      if (!held) return
      holdX = event.clientX
      holdY = event.clientY
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
