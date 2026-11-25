import { useEffect, useLayoutEffect, useState } from 'react'
import { prepareWallpaperForDisplay, type PreparedWallpaper } from './wallpaperPrepared'

/** One lease covers a pending React commit; another covers the visible frame. */
export function usePreparedWallpaper(source: string | null, w: number, h: number, dpr: number) {
  const [display, setDisplay] = useState<{ source: string; image: PreparedWallpaper } | null>(null)
  useEffect(() => {
    if (!source) { setDisplay(null); return }
    let cancelled = false
    let lease: PreparedWallpaper | null = null
    void prepareWallpaperForDisplay(source, w, h, dpr).then(image => {
      if (!image || cancelled) return
      image.retain()
      lease = image
      setDisplay({ source, image })
    })
    return () => { cancelled = true; lease?.release() }
  }, [source, w, h, dpr])
  useLayoutEffect(() => {
    display?.image.retain()
    return () => display?.image.release()
  }, [display])
  return display
}
