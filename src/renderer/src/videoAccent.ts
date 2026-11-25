import { accentFromRgba } from '@shared/accent'

/**
 * Extract a theme colour from a video's first frame. The main process cannot
 * decode video, so the renderer samples the first frame on a canvas (the
 * `kevin-media` protocol sends CORS headers, so the canvas is not tainted).
 */
export async function extractVideoAccent(src: string): Promise<string | null> {
  const video = document.createElement('video')
  video.src = src
  video.crossOrigin = 'anonymous'
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve()
      video.onerror = () => reject(new Error('video load failed'))
      video.load()
    })
    try {
      video.currentTime = 0
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      if (video.readyState >= 2) {
        resolve()
        return
      }
      video.onseeked = () => resolve()
      window.setTimeout(resolve, 400)
    })
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, 64, 64)
    return accentFromRgba(ctx.getImageData(0, 0, 64, 64).data)
  } catch {
    return null
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}
