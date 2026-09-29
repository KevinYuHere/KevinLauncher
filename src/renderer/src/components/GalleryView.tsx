import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { AppEntry, GalleryItem } from '@shared/types'
import { getThumb, observeTile, type Thumb } from '../gallery/thumbs'

// Screenshot browser for one app. Thumbnails are generated lazily as tiles
// scroll into view and cached; clicking opens the full image in a viewer
// window, right-click shows the file actions menu.
interface GalleryViewProps {
  entry: AppEntry
  onBack: () => void
  onEdit: () => void
}

// One grid cell: shows the cached thumbnail if present and otherwise registers
// with the shared IntersectionObserver so the JPEG is produced on demand.
function GalleryTile({ item }: { item: GalleryItem }): ReactElement {
  const ref = useRef<HTMLButtonElement>(null)
  const [thumb, setThumb] = useState<Thumb | undefined>(() => getThumb(item.path))

  useEffect(() => {
    const el = ref.current
    if (!el) return
    return observeTile(el, item.path, setThumb)
  }, [item.path])

  return (
    <button
      ref={ref}
      className="gallery-thumb"
      style={{ aspectRatio: thumb ? String(thumb.aspect) : '16 / 9' }}
      title={item.name}
      onClick={() => void window.api.galleryOpenViewer(item.path)}
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
              <div>在「设置 · 编辑应用」中填写截图目录后即可浏览</div>
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
          <div className="gallery-grid">
            {items.map((item) => (
              <GalleryTile key={item.path} item={item} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
