import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from 'react'
import type { AppEntry, GalleryItem } from '@shared/types'
import { getThumb, observeTile, type Thumb } from '../gallery/thumbs'

// Masonry: tiles are placed into the shortest column, in order, so columns pack
// independently while the reading order stays left→right, then next row.
const TILE_GAP = 12
const MIN_COL = 220
const FALLBACK_ASPECT = 16 / 9

interface TileBox {
  x: number
  y: number
  w: number
  h: number
}

// Screenshot browser for one app. Thumbnails are generated lazily as tiles
// scroll into view and cached; clicking opens the full image in a viewer
// window, right-click shows the file actions menu.
interface GalleryViewProps {
  entry: AppEntry
  onBack: () => void
  onEdit: () => void
}

// One tile: absolutely positioned by the parent's masonry layout; registers with
// the shared IntersectionObserver so the JPEG is produced on demand and reports
// its aspect ratio back so the layout can settle.
function GalleryTile({
  item,
  paths,
  index,
  box,
  onAspect
}: {
  item: GalleryItem
  paths: string[]
  index: number
  box: TileBox
  onAspect: (path: string, aspect: number) => void
}): ReactElement {
  const ref = useRef<HTMLButtonElement>(null)
  const [thumb, setThumb] = useState<Thumb | undefined>(() => getThumb(item.path))
  const onAspectRef = useRef(onAspect)
  onAspectRef.current = onAspect

  useEffect(() => {
    const el = ref.current
    if (!el) return
    return observeTile(el, item.path, (loaded) => {
      setThumb(loaded)
      onAspectRef.current(item.path, loaded.aspect)
    })
  }, [item.path])

  return (
    <button
      ref={ref}
      className="gallery-thumb"
      style={{ position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h }}
      title={item.name}
      onClick={() => void window.api.galleryOpenViewer(paths, index)}
      onContextMenu={(e) => {
        e.preventDefault()
        void window.api.galleryContextMenu(item.path)
      }}
    >
      {thumb ? (
        <img src={thumb.url} alt={item.name} draggable={false} />
      ) : (
        <span className="thumb-skeleton" />
      )}
    </button>
  )
}

export default function GalleryView({ entry, onBack, onEdit }: GalleryViewProps): ReactElement {
  const [items, setItems] = useState<GalleryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [width, setWidth] = useState(0)
  const [aspects, setAspects] = useState<Record<string, number>>({})
  const observerRef = useRef<ResizeObserver | null>(null)

  // Column count / size from the container width. A callback ref (rather than a
  // mount effect) because the grid only mounts once the screenshots are read.
  const bindGrid = useCallback((el: HTMLDivElement | null): void => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!el) return
    const measure = (): void => setWidth(el.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    observerRef.current = observer
  }, [])

  useEffect(() => () => observerRef.current?.disconnect(), [])

  const onAspect = useCallback((path: string, aspect: number): void => {
    setAspects((prev) => (prev[path] === aspect ? prev : { ...prev, [path]: aspect }))
  }, [])

  const cols = Math.max(1, Math.floor((width + TILE_GAP) / (MIN_COL + TILE_GAP)))
  const colWidth = width > 0 ? (width - (cols - 1) * TILE_GAP) / cols : MIN_COL

  const { boxes, height } = useMemo(() => {
    const colHeights = new Array<number>(cols).fill(0)
    const boxes: TileBox[] = items.map((item) => {
      const aspect = aspects[item.path] ?? FALLBACK_ASPECT
      const h = colWidth / aspect
      let col = 0
      for (let i = 1; i < cols; i++) if (colHeights[i] < colHeights[col]) col = i
      const box: TileBox = { x: col * (colWidth + TILE_GAP), y: colHeights[col], w: colWidth, h }
      colHeights[col] += h + TILE_GAP
      return box
    })
    return { boxes, height: colHeights.length ? Math.max(...colHeights) - TILE_GAP : 0 }
  }, [items, aspects, cols, colWidth])

  const paths = useMemo(() => items.map((item) => item.path), [items])

  // Re-read the screenshot directory for this app.
  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setItems(await window.api.galleryList(entry.id))
    } finally {
      setLoading(false)
    }
  }, [entry.id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const dir = entry.screenshotDirectory

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">图库 · {entry.name}</h1>
          <p className="page-subtitle">{dir ? `${items.length} 张图片` : '未设置截图目录'}</p>
        </div>
        <div className="page-actions">
          {dir && (
            <button className="btn" onClick={() => void window.api.openPath(dir)}>
              打开文件夹
            </button>
          )}
          <button className="btn" disabled={!dir || loading} onClick={() => void refresh()}>
            刷新
          </button>
          <button className="btn ghost" onClick={onBack}>
            返回主页
          </button>
        </div>
      </div>

      <div className="page-body">
        {!dir ? (
          <div className="panel">
            <div className="empty">
              <div className="empty-icon">▣</div>
              <div className="empty-title">未设置截图目录</div>
              <div>在「设置 → 高级设置」中填写截图目录后即可浏览</div>
              <button className="btn primary" style={{ marginTop: 12 }} onClick={onEdit}>
                去设置
              </button>
            </div>
          </div>
        ) : items.length === 0 ? (
          <div className="panel">
            <div className="empty">
              <div className="empty-icon">▣</div>
              <div className="empty-title">{loading ? '正在读取…' : '没有找到图片'}</div>
            </div>
          </div>
        ) : (
          <div
            className="gallery-grid"
            ref={bindGrid}
            style={{ height: height > 0 ? `${Math.round(height)}px` : undefined }}
          >
            {items.map((item, index) => (
              <GalleryTile
                key={item.path}
                item={item}
                paths={paths}
                index={index}
                box={boxes[index]}
                onAspect={onAspect}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
