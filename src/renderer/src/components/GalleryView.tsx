import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent, type ReactElement
} from 'react'
import type { AppEntry, GalleryItem } from '@shared/types'
import { galleryImageKey, subscribeThumbnail, type Thumb } from '../gallery/thumbs'
import { masonryLayout, visibleTiles, type TileBox } from '../gallery/masonry'

const OVERSCAN = 420
const NO_ITEMS: GalleryItem[] = []

interface GalleryViewProps {
  entry: AppEntry
  active: boolean
  onBack: () => void
  onEdit: () => void
}

function GalleryTile({
  item, paths, index, box, active, onAspect, onFocus, onKeyDown
}: {
  item: GalleryItem
  paths: string[]
  index: number
  box: TileBox
  active: boolean
  onAspect: (key: string, aspect: number) => void
  onFocus: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}): ReactElement {
  const [thumb, setThumb] = useState<Thumb | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!active) {
      setThumb(null)
      return
    }
    return subscribeThumbnail(item, (result) => {
      setThumb(result)
      setFailed(!result)
      if (result) onAspect(galleryImageKey(item), result.aspect)
    })
  }, [item, onAspect, active])
  const openActions = (): void => { void window.api.galleryContextMenu(item.path) }
  return (
    <button
      type="button"
      className="gallery-thumb"
      data-tile-index={index}
      style={{ position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h }}
      aria-label={item.name}
      title={item.name}
      onFocus={onFocus}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
          event.preventDefault()
          openActions()
        } else onKeyDown(event)
      }}
      onClick={() => void window.api.galleryOpenViewer(paths, index)}
      onContextMenu={(event) => { event.preventDefault(); openActions() }}
    >
      {thumb ? <img src={thumb.url} alt="" draggable={false} />
        : <span className={failed ? 'thumb-placeholder' : 'thumb-skeleton'} />}
    </button>
  )
}

export default function GalleryView({ entry, active, onBack, onEdit }: GalleryViewProps): ReactElement {
  const dir = entry.screenshotDirectory
  const scope = JSON.stringify([entry.id, dir])
  const [listing, setListing] = useState<{ scope: string; items: GalleryItem[] }>()
  const [error, setError] = useState<{ scope: string; message: string }>()
  const [loading, setLoading] = useState(false)
  const [refreshNumber, setRefreshNumber] = useState(0)
  const pageRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ width: 0, top: 0, height: 0 })
  const [aspects, setAspects] = useState(new Map<string, number>())
  const pendingAspects = useRef(new Map<string, number>())
  const frame = useRef(0)
  const [focused, setFocused] = useState<number | null>(null)
  const pendingFocus = useRef<number | null>(null)
  const items = listing?.scope === scope ? listing.items : NO_ITEMS
  const paths = useMemo(() => items.map((item) => item.path), [items])

  useEffect(() => {
    if (!dir) return
    let current = true
    setLoading(true)
    setError(undefined)
    void window.api.galleryList(entry.id).then(
      (next) => { if (current) setListing({ scope, items: next }) },
      (reason: unknown) => {
        if (current) setError({ scope, message: reason instanceof Error ? reason.message : String(reason) })
      }
    ).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [entry.id, dir, scope, refreshNumber])

  const onAspect = useCallback((key: string, aspect: number): void => {
    pendingAspects.current.set(key, aspect)
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const pending = pendingAspects.current
      pendingAspects.current = new Map()
      setAspects((prev) => {
        if ([...pending].every(([key, value]) => prev.get(key) === value)) return prev
        return new Map([...prev, ...pending])
      })
    })
  }, [])

  useEffect(() => () => {
    cancelAnimationFrame(frame.current)
    frame.current = 0
    pendingAspects.current.clear()
  }, [])

  useEffect(() => {
    const keys = new Set(items.map(galleryImageKey))
    setAspects((prev) => new Map([...prev].filter(([key]) => keys.has(key))))
  }, [items])

  const hasItems = items.length > 0
  const listingError = error?.scope === scope ? error : undefined
  const showGrid = Boolean(dir && hasItems && !listingError)
  useLayoutEffect(() => {
    const page = pageRef.current
    const grid = gridRef.current
    if (!showGrid || !page || !grid) return
    let frame = 0
    const measure = (): void => {
      frame = 0
      const top = page.getBoundingClientRect().top - grid.getBoundingClientRect().top
      const next = { width: grid.clientWidth, top, height: page.clientHeight }
      setViewport((prev) => prev.width === next.width && prev.top === next.top &&
        prev.height === next.height ? prev : next)
    }
    const queue = (): void => { if (!frame) frame = requestAnimationFrame(measure) }
    measure()
    const observer = new ResizeObserver(queue)
    observer.observe(page)
    observer.observe(grid)
    page.addEventListener('scroll', queue, { passive: true })
    return () => {
      page.removeEventListener('scroll', queue)
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [showGrid, scope])

  const layout = useMemo(() => masonryLayout(viewport.width,
    items.map((item) => aspects.get(galleryImageKey(item)) ?? 0)
  ), [items, aspects, viewport.width])
  const visible = visibleTiles(layout, viewport.top - OVERSCAN, viewport.top + viewport.height + OVERSCAN)
  if (focused !== null && layout.boxes[focused] && !visible.includes(focused)) {
    visible.push(focused)
    visible.sort((a, b) => a - b)
  }
  useLayoutEffect(() => {
    if (pendingFocus.current === null) return
    const target = gridRef.current?.querySelector<HTMLButtonElement>(`[data-tile-index="${pendingFocus.current}"]`)
    if (target) {
      pendingFocus.current = null
      target.focus()
    }
  }, [focused])

  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const next = {
      ArrowRight: index + 1, ArrowLeft: index - 1,
      ArrowDown: index + layout.columns.length, ArrowUp: index - layout.columns.length,
      Home: 0, End: items.length - 1
    }[event.key]
    if (next === undefined) return
    event.preventDefault()
    const target = Math.max(0, Math.min(items.length - 1, next))
    if (target !== index) {
      pendingFocus.current = target
      setFocused(target)
    }
  }

  return (
    <div className="page gallery-page" ref={pageRef}>
      <div className="page-header">
        <div>
          <h1 className="page-title">图库 · {entry.name}</h1>
          <p className="page-subtitle" aria-live="polite">{dir ? `${items.length} 张图片` : '未设置截图目录'}</p>
        </div>
        <div className="page-actions">
          {dir && <button className="btn" onClick={() => void window.api.openPath(dir)}>打开文件夹</button>}
          <button className="btn" disabled={!dir || loading} onClick={() => setRefreshNumber((n) => n + 1)}>刷新</button>
          <button className="btn ghost" onClick={onBack}>返回主页</button>
        </div>
      </div>
      <div className="page-body" aria-busy={loading}>
        {!dir ? (
          <div className="panel"><div className="empty">
            <div className="empty-icon" aria-hidden="true">▣</div>
            <div className="empty-title">未设置截图目录</div>
            <div>在「设置 → 高级设置」中填写截图目录后即可浏览</div>
            <button className="btn primary" style={{ marginTop: 12 }} onClick={onEdit}>去设置</button>
          </div></div>
        ) : listingError ? (
          <div className="panel"><div className="empty" role="alert">
            <div className="empty-title">读取截图目录失败</div>
            <div>{listingError.message}</div>
          </div></div>
        ) : !hasItems ? (
          <div className="panel"><div className="empty">
            <div className="empty-title">{loading || listing?.scope !== scope ? '正在读取…' : '没有找到图片'}</div>
          </div></div>
        ) : (
          <div key="gallery-grid" className="gallery-grid" ref={gridRef} style={{ height: layout.height }}
            onBlur={(event) => {
              if (pendingFocus.current === null && !event.currentTarget.contains(event.relatedTarget)) setFocused(null)
            }}>
            {visible.map((index) => <GalleryTile
              key={galleryImageKey(items[index])}
              item={items[index]} paths={paths} index={index} box={layout.boxes[index]}
              active={active} onAspect={onAspect}
              onFocus={() => setFocused(index)} onKeyDown={(event) => navigate(event, index)}
            />)}
          </div>
        )}
      </div>
    </div>
  )
}
