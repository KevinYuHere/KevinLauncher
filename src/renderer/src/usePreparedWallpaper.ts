import { useEffect, useLayoutEffect, useState } from 'react'
import { prepareWallpaperForDisplay, type PreparedWallpaper } from './wallpaperPrepared'

/** One lease covers a pending React commit; another covers the visible frame. */
export function usePreparedWallpaper(source: string | null, w: number, h: number, dpr: number, visible = true) {
  const [display, setDisplay] = useState<{ source: string; image: PreparedWallpaper } | null>(null)
  useEffect(() => {
    if (!source) { setDisplay(null); return }
    if (!visible) return
    const controller = new AbortController()
    let lease: PreparedWallpaper | null = null
    void prepareWallpaperForDisplay(source, w, h, dpr, controller.signal).then(image => {
      if (!image || controller.signal.aborted) return
      image.retain()
      lease = image
      setDisplay({ source, image })
    })
    return () => { controller.abort(); lease?.release() }
  }, [source, w, h, dpr, visible])
  useLayoutEffect(() => {
    display?.image.retain()
    return () => display?.image.release()
  }, [display])
  return display
}
