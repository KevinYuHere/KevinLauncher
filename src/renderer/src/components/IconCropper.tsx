import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'

interface IconCropperProps {
  source: string
  onCancel: () => void
  onConfirm: (dataUrl: string) => void
}

const STAGE = 380
const CROP = 260
const OUTPUT = 256
const MAX_ZOOM = 6
const MIN_ZOOM = 0.1

export default function IconCropper({
  source,
  onCancel,
  onConfirm
}: IconCropperProps): ReactElement {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)

  const fit = useMemo(() => {
    if (!natural || !natural.w || !natural.h) return null
    const scale = Math.min(STAGE / natural.w, STAGE / natural.h)
    return { w: Math.max(1, natural.w * scale), h: Math.max(1, natural.h * scale) }
  }, [natural])

  // Smallest zoom = whole image fits inside the crop box (so an icon can be
  // selected in full); largest = MAX_ZOOM for fine-grained crops.
  const minZoom = fit ? Math.max(0.1, Math.min(CROP / fit.w, CROP / fit.h)) : MIN_ZOOM
  const dispW = fit ? fit.w * zoom : 0
  const dispH = fit ? fit.h * zoom : 0

  // Start fully zoomed out once the image size is known.
  useEffect(() => {
    if (!fit) return
    setZoom(minZoom)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit])

  const clampOffset = useCallback(
    (o: { x: number; y: number }, w: number, h: number): { x: number; y: number } => {
      if (w <= 0 || h <= 0) return o
      const maxX = Math.max(0, (w - CROP) / 2)
      const maxY = Math.max(0, (h - CROP) / 2)
      const x = Math.min(maxX, Math.max(-maxX, o.x))
      const y = Math.min(maxY, Math.max(-maxY, o.y))
      return x === o.x && y === o.y ? o : { x, y }
    },
    []
  )

  // Keep the pan offset valid as the zoom / image size changes. Bail out when
  // unchanged so this never loops.
  useEffect(() => {
    setOffset((o) => clampOffset(o, dispW, dispH))
  }, [dispW, dispH, clampOffset])

  // Wheel zoom.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      setZoom((z) => Math.min(MAX_ZOOM, Math.max(minZoom, z * Math.exp(-e.deltaY * 0.0015))))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [minZoom])

  // Drag to pan the image under the fixed crop box.
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const drag = dragRef.current
      if (!drag) return
      setOffset(
        clampOffset(
          { x: drag.ox + (e.clientX - drag.x), y: drag.oy + (e.clientY - drag.y) },
          dispW,
          dispH
        )
      )
    }
    const onUp = (): void => {
      dragRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [clampOffset, dispW, dispH])

  const confirm = useCallback((): void => {
    const img = imgRef.current
    if (!img || !natural || dispW <= 0) return
    // `scale` = natural pixels per displayed pixel (a multiplier).
    const scale = natural.w / dispW
    const imgLeft = STAGE / 2 + offset.x - dispW / 2
    const imgTop = STAGE / 2 + offset.y - dispH / 2
    const sx = (STAGE / 2 - CROP / 2 - imgLeft) * scale
    const sy = (STAGE / 2 - CROP / 2 - imgTop) * scale
    const sSize = CROP * scale
    const canvas = document.createElement('canvas')
    canvas.width = OUTPUT
    canvas.height = OUTPUT
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, OUTPUT, OUTPUT)
    onConfirm(canvas.toDataURL('image/png'))
  }, [natural, dispW, dispH, offset, onConfirm])

  const imgLeft = STAGE / 2 + offset.x - dispW / 2
  const imgTop = STAGE / 2 + offset.y - dispH / 2

  return (
    <div className="modal-mask">
      <div className="modal" style={{ width: 'min(460px, 92vw)' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>框选图标（正方形）</h2>
          <button className="modal-close" onClick={onCancel}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div
            ref={stageRef}
            className="crop-stage"
            style={{ width: STAGE, height: STAGE }}
            onMouseDown={(e) => {
              if (dispW <= 0) return
              dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
              e.preventDefault()
            }}
          >
            <img
              ref={imgRef}
              className="crop-img"
              src={source}
              alt=""
              draggable={false}
              style={
                dispW > 0
                  ? { left: imgLeft, top: imgTop, width: dispW, height: dispH }
                  : {
                      left: 0,
                      top: 0,
                      width: '100%',
                      height: '100%',
                      objectFit: 'contain',
                      opacity: 0
                    }
              }
              onLoad={(e) =>
                setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
              }
            />
            <div
              className="crop-box"
              style={{
                left: STAGE / 2 - CROP / 2,
                top: STAGE / 2 - CROP / 2,
                width: CROP,
                height: CROP
              }}
            />
          </div>
          <div className="crop-zoom">
            <span>缩放</span>
            <input
              className="slider"
              type="range"
              min={minZoom}
              max={MAX_ZOOM}
              step={0.01}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
            />
          </div>
          <div className="crop-hint">拖动图片调整位置，滚轮或滑块缩放</div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn primary" onClick={confirm}>
            确定
          </button>
        </div>
      </div>
    </div>
  )
}
