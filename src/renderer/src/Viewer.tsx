import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { fileUrl } from './media'

interface ViewerProps {
  path: string
}

const MIN_ZOOM = 0.1
const MAX_ZOOM = 12

export default function Viewer({ path }: ViewerProps): ReactElement {
  const name = path.split(/[\\/]/).pop() ?? path
  const stageRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [stage, setStage] = useState({ w: 0, h: 0 })
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)

  // Reset when the image changes.
  useEffect(() => {
    setNatural(null)
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }, [path])

  // Track the stage size.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = (): void => setStage({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Base scale: fit the whole image inside the window (contain). This makes one
  // dimension exactly fill the window and the other stay inside it.
  const baseScale =
    natural && stage.w > 0 && stage.h > 0
      ? Math.min(stage.w / natural.w, stage.h / natural.h)
      : 1
  const scale = baseScale * zoom

  // Wheel zoom (non-passive so preventDefault works).
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const factor = Math.exp(-e.deltaY * 0.0015)
      setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Drag to pan.
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const drag = dragRef.current
      if (!drag) return
      setOffset({ x: drag.ox + (e.clientX - drag.x), y: drag.oy + (e.clientY - drag.y) })
    }
    const onUp = (): void => {
      dragRef.current = null
      setDragging(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const reset = useCallback((): void => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }, [])

  return (
    <div className="viewer">
      <div className="viewer-bar">
        <span className="viewer-name">
          {name} · {Math.round(scale * 100)}%
        </span>
        <div className="viewer-actions">
          <button className="win-btn" title="重置缩放" onClick={reset}>
            ⟲
          </button>
          <button
            className="win-btn"
            title="在文件资源管理器中打开 / 复制"
            onClick={() => void window.api.galleryContextMenu(path)}
          >
            ⋯
          </button>
          <button className="win-btn close" title="关闭" onClick={() => void window.api.windowClose()}>
            &#x2715;
          </button>
        </div>
      </div>
      <div
        ref={stageRef}
        className="viewer-stage"
        onMouseDown={(e) => {
          if (e.button !== 0) return
          dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
          setDragging(true)
          e.preventDefault()
        }}
        onDoubleClick={reset}
        onContextMenu={(e) => {
          e.preventDefault()
          void window.api.galleryContextMenu(path)
        }}
      >
        <img
          className="viewer-img"
          src={fileUrl(path)}
          alt={name}
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget
            setNatural({ w: img.naturalWidth, h: img.naturalHeight })
          }}
          style={{
            width: natural ? `${natural.w}px` : undefined,
            height: natural ? `${natural.h}px` : undefined,
            opacity: natural ? 1 : 0,
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            cursor: dragging ? 'grabbing' : 'grab'
          }}
        />
      </div>
    </div>
  )
}
