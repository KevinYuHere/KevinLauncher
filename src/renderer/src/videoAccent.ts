import { accentFromRgba } from '@shared/accent'

/**
 * Extract a theme colour from a video's first frame. The main process cannot
 * decode video, so the renderer samples the first frame on a canvas (the
 * `kevin-media` protocol sends CORS headers, so the canvas is not tainted).
 */
export async function extractVideoAccent(src: string, activeSignal: AbortSignal): Promise<string | null> {
  const signal = AbortSignal.any([activeSignal, AbortSignal.timeout(8000)])
  const video = document.createElement('video')
  video.crossOrigin = 'anonymous'
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  try {
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => reject(signal.reason)
      const finish = (error?: Error): void => {
        signal.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve()
      }
      video.onloadeddata = () => finish()
      video.onerror = () => finish(new Error('video load failed'))
      signal.addEventListener('abort', abort, { once: true })
      video.src = src
    })
    signal.throwIfAborted()
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
    video.onloadeddata = null
    video.onerror = null
    video.pause()
    video.removeAttribute('src')
    video.load()
  }
}
