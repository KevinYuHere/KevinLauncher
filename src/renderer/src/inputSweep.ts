const TEXT_TYPES = new Set(['text', 'search', 'number', 'password', 'email', 'url', 'tel'])

function isTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true
  if (!(el instanceof HTMLInputElement)) return false
  return TEXT_TYPES.has(el.type)
}

/**
 * 霆骇列律 text-field focus effect.
 *
 * A translucent white rectangle grows from the left of the field together with
 * a bright bottom line; both stop at the right edge, then the rectangle fades.
 * The overlay is viewport-fixed because native `<input>`s cannot own
 * pseudo-elements.
 */
export function installInputSweep(): () => void {
  const sweep = (field: HTMLInputElement | HTMLTextAreaElement): void => {
    if (field.disabled) return
    // A new field replaces the previous field's remaining underline.
    document.querySelectorAll('.theme-input-sweep').forEach((el) => el.remove())
    const rect = field.getBoundingClientRect()
    if (rect.width < 8 || rect.height < 8) return
    const layer = document.createElement('div')
    layer.className = 'theme-input-sweep'
    layer.style.left = `${rect.left}px`
    layer.style.top = `${rect.top}px`
    layer.style.width = `${rect.width}px`
    layer.style.height = `${rect.height}px`
    const clip = getComputedStyle(field).clipPath
    if (clip && clip !== 'none') layer.style.clipPath = clip
    const fill = document.createElement('span')
    fill.className = 'theme-input-sweep-fill'
    fill.style.transform = 'scaleX(0)'
    const line = document.createElement('span')
    line.className = 'theme-input-sweep-line'
    line.style.transform = 'scaleX(0)'
    layer.append(fill, line)
    document.body.appendChild(layer)

    const duration = Math.min(560, Math.max(260, rect.width * 0.85))
    fill.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], {
      duration,
      easing: 'linear',
      fill: 'forwards'
    })
    line.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], {
      duration,
      easing: 'linear',
      fill: 'forwards'
    })
    const remove = (): void => {
      window.clearTimeout(cleanupTimer)
      layer.remove()
    }
    const cleanupTimer = window.setTimeout(() => {
      // The rectangle fades once it reaches the right edge; the bottom line
      // remains as the focused-field indicator until blur.
      fill.animate([{ opacity: 0.16 }, { opacity: 0 }], {
        duration: 150,
        easing: 'ease-out',
        fill: 'forwards'
      })
      if (document.activeElement !== field) remove()
    }, duration + 20)
    field.addEventListener(
      'blur',
      () => {
        window.clearTimeout(cleanupTimer)
        layer.remove()
      },
      { once: true }
    )
  }

  const onFocus = (event: FocusEvent): void => {
    const target = event.target
    if (!(target instanceof Element) || !isTextField(target)) return
    if (document.documentElement.dataset.specialInputs !== 'starsnow') return
    sweep(target)
  }
  document.addEventListener('focusin', onFocus)
  return () => document.removeEventListener('focusin', onFocus)
}
