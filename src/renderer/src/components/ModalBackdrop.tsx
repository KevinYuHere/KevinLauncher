import { useEffect, useState, type ReactElement } from 'react'

/**
 * Re-renders the current wallpaper (and its blur / dim) as a fresh layer inside a
 * dialog, so the dialog's own material renders over the real wallpaper — not over
 * the (dimmed/blurred) app behind the mask. Mirrors the launcher background.
 *
 * For a video wallpaper we freeze the frame that is on screen the moment the
 * dialog opens (same treatment as an image wallpaper).
 */
export default function ModalBackdrop(): ReactElement | null {
  const [state, setState] = useState<{ src: string; blur: number; dim: number } | null>(null)

  useEffect(() => {
    const layer = document.querySelector<HTMLImageElement | HTMLVideoElement>('.bg-layer')
    if (!layer) return
    const blurMatch = /blur\(([\d.]+)px\)/.exec(layer.style.filter ?? '')
    const blur = blurMatch ? parseFloat(blurMatch[1]) : 0
    const dimEl = document.querySelector<HTMLElement>('.bg-dim')
    const dim = dimEl ? parseFloat(dimEl.style.opacity || '0') : 0

    let src: string | null = null
    if (layer instanceof HTMLVideoElement) {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = layer.videoWidth || layer.clientWidth
        canvas.height = layer.videoHeight || layer.clientHeight
        const ctx = canvas.getContext('2d')
        if (ctx && canvas.width > 0 && canvas.height > 0) {
          ctx.drawImage(layer, 0, 0, canvas.width, canvas.height)
          src = canvas.toDataURL('image/png')
        }
      } catch {
        src = null
      }
    } else {
      src = layer.getAttribute('src')
    }
    if (src) setState({ src, blur, dim })
  }, [])

  if (!state) return null
  return (
    <div className="modal-backdrop" aria-hidden="true">
      <img
        src={state.src}
        alt=""
        style={state.blur > 0 ? { filter: `blur(${state.blur}px)` } : undefined}
      />
      <span style={{ opacity: state.dim }} />
    </div>
  )
}
