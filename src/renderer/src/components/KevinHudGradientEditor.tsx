import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement
} from 'react'
import {
  kevinHudGradientCss,
  type KevinHudGradient,
  type KevinHudGradientStop
} from '@shared/kevinHudBackground'
import Collapse from './Collapse'
import ColorPicker from './ColorPicker'
import Segmented from './Segmented'
import '../assets/kevin-hud-gradient.css'

export interface KevinHudGradientEditorProps {
  value: KevinHudGradient
  onChange: (value: KevinHudGradient) => void
}

type GradientKind = KevinHudGradient['kind']
type GradientShape = KevinHudGradient['shape']

const MIN_STOPS = 2
const MAX_STOPS = 5
const HUD_HEX = /^#?([\da-f]{6})$/i

const KIND_OPTIONS: { value: GradientKind; label: string }[] = [
  { value: 'linear', label: '线性' },
  { value: 'radial', label: '放射' },
  { value: 'conic', label: '环形' }
]

const KIND_HINT: Record<GradientKind, string> = {
  linear: '从一边渐变到另一边',
  radial: '从中心向外扩散',
  conic: '围绕中心铺开'
}

const KIND_LABEL: Record<GradientKind, string> = {
  linear: '线性',
  radial: '放射',
  conic: '环形'
}

const SHAPE_OPTIONS: { value: GradientShape; label: string }[] = [
  { value: 'circle', label: '圆形' },
  { value: 'ellipse', label: '椭圆' }
]

const SHAPE_LABEL: Record<GradientShape, string> = {
  circle: '圆形',
  ellipse: '椭圆'
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)))
}

function normalizeHex(value: string): string {
  const match = HUD_HEX.exec(value.trim())
  return match ? `#${match[1].toUpperCase()}` : '#FFFFFF'
}

/**
 * Place a new stop in the widest gap and borrow the adjoining colour. The
 * picker opens for it immediately, so borrowing keeps the preview calm until
 * the user chooses a real colour.
 */
function createStop(stops: readonly KevinHudGradientStop[]): KevinHudGradientStop {
  const ordered = stops
    .map((stop, index) => ({ ...stop, index }))
    .sort((left, right) => left.position - right.position || left.index - right.index)
  let previous = 0
  let bestStart = 0
  let bestEnd = 100
  let bestGap = -1
  let color = ordered[0]?.color ?? '#FFFFFF'

  for (const stop of ordered) {
    const gap = stop.position - previous
    if (gap > bestGap) {
      bestGap = gap
      bestStart = previous
      bestEnd = stop.position
      color = stop.color
    }
    previous = stop.position
  }
  if (100 - previous > bestGap) {
    bestStart = previous
    bestEnd = 100
    color = ordered[ordered.length - 1]?.color ?? color
  }

  return {
    color: normalizeHex(color),
    position: clampNumber(Math.round((bestStart + bestEnd) / 2), 0, 100, 50)
  }
}

/** Compact numeric field with the same commit-on-blur behaviour as settings. */
function GradientNumber({
  ariaLabel,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange
}: {
  ariaLabel: string
  value: number
  min: number
  max: number
  step?: number
  unit: string
  onChange: (value: number) => void
}): ReactElement {
  const [text, setText] = useState(formatNumber(value))
  const [editing, setEditing] = useState(false)
  const cancelRef = useRef(false)

  useEffect(() => {
    if (!editing) setText(formatNumber(value))
  }, [value, editing])

  const commit = (): void => {
    if (!text.trim()) {
      setText(formatNumber(value))
      return
    }
    const parsed = Number(text.replace(',', '.'))
    const next = clampNumber(parsed, min, max, value)
    setText(formatNumber(next))
    if (next !== value) onChange(next)
  }

  return (
    <span className="khg-number">
      <input
        className="input khg-number-input"
        type="number"
        value={text}
        min={min}
        max={max}
        step={step}
        aria-label={ariaLabel}
        inputMode="decimal"
        onFocus={() => setEditing(true)}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          setEditing(false)
          if (cancelRef.current) {
            cancelRef.current = false
            setText(formatNumber(value))
            return
          }
          commit()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur()
          } else if (event.key === 'Escape') {
            cancelRef.current = true
            event.currentTarget.blur()
          }
        }}
      />
      <span className="khg-number-unit" aria-hidden="true">
        {unit}
      </span>
    </span>
  )
}

/**
 * Per-app gradient editor. It only edits the gradient contract; persistence
 * and the background mode stay with the settings page.
 *
 * Stops are deliberately kept in edit order. Crossing two positions changes
 * the preview but never reorders this list, so the open ColorPicker keeps
 * editing the same target while the user drags.
 */
export default function KevinHudGradientEditor({
  value,
  onChange
}: KevinHudGradientEditorProps): ReactElement {
  const baseId = useId()
  const [activeStop, setActiveStop] = useState<number | null>(null)
  const openStop =
    activeStop !== null && activeStop >= 0 && activeStop < value.stops.length
      ? activeStop
      : null

  useEffect(() => {
    if (activeStop !== null && activeStop >= value.stops.length) setActiveStop(null)
  }, [activeStop, value.stops.length])

  const update = (patch: Partial<KevinHudGradient>): void => {
    onChange({ ...value, ...patch })
  }

  const updateStop = (index: number, patch: Partial<KevinHudGradientStop>): void => {
    update({
      stops: value.stops.map((stop, stopIndex) =>
        stopIndex === index ? { ...stop, ...patch } : stop
      )
    })
  }

  const addStop = (): void => {
    if (value.stops.length >= MAX_STOPS) return
    const next = [...value.stops, createStop(value.stops)]
    onChange({ ...value, stops: next })
    setActiveStop(next.length - 1)
  }

  const removeStop = (index: number): void => {
    if (value.stops.length <= MIN_STOPS) return
    onChange({ ...value, stops: value.stops.filter((_, stopIndex) => stopIndex !== index) })
    setActiveStop((current) => {
      if (current === null) return null
      if (current === index) return null
      return current > index ? current - 1 : current
    })
  }

  const gradientCss = kevinHudGradientCss(value)
  const geometry =
    value.kind === 'radial'
      ? `${SHAPE_LABEL[value.shape]}，中心 ${Math.round(value.centerX)}% / ${Math.round(value.centerY)}%`
      : `${Math.round(value.angle)}°`
  const previewLabel = `渐变预览：${KIND_LABEL[value.kind]}，${geometry}，${value.stops.length} 个色标`

  return (
    <section className="khg-editor" aria-label="KEVIN HUD 渐变背景">
      <div className="khg-preview-row">
        <div
          className="khg-preview"
          style={{ backgroundImage: gradientCss }}
          role="img"
          aria-label={previewLabel}
        >
          {value.kind !== 'linear' && (
            <span
              className="khg-preview-pin"
              style={{ left: `${value.centerX}%`, top: `${value.centerY}%` }}
              aria-hidden="true"
            />
          )}
        </div>
        <div className="khg-preview-copy">
          <span className="khg-preview-title">渐变预览</span>
          <span>{geometry}</span>
          <span>{value.stops.length} 个色标</span>
        </div>
      </div>

      <div className="khg-fields">
        <div className="khg-row">
          <span className="khg-label">渐变方式</span>
          <div className="khg-control">
            <Segmented
              value={value.kind}
              options={KIND_OPTIONS}
              title="渐变方式"
              onChange={(kind) => update({ kind: kind as GradientKind })}
            />
            <span className="khg-hint">{KIND_HINT[value.kind]}</span>
          </div>
        </div>

        {value.kind !== 'radial' && (
          <div className="khg-row">
            <label className="khg-label" htmlFor={`${baseId}-angle`}>
              角度
            </label>
            <div className="khg-control">
              <input
                id={`${baseId}-angle`}
                className="slider khg-slider"
                type="range"
                min={0}
                max={360}
                step={1}
                value={value.angle}
                aria-label="渐变角度"
                onChange={(event) =>
                  update({
                    angle: clampNumber(Number(event.target.value), 0, 360, value.angle)
                  })
                }
              />
              <GradientNumber
                ariaLabel="渐变角度（度）"
                value={value.angle}
                min={0}
                max={360}
                unit="°"
                onChange={(angle) => update({ angle })}
              />
              <span className="khg-hint">0° 朝上，顺时针</span>
            </div>
          </div>
        )}

        {value.kind === 'radial' && (
          <>
            <div className="khg-row">
              <span className="khg-label">形状</span>
              <div className="khg-control">
                <Segmented
                  value={value.shape}
                  options={SHAPE_OPTIONS}
                  title="放射渐变形状"
                  onChange={(shape) => update({ shape: shape as GradientShape })}
                />
                <span className="khg-hint">圆形从中心等距扩散，椭圆向四周拉伸</span>
              </div>
            </div>

            <div className="khg-row">
              <span className="khg-label">中心点</span>
              <div className="khg-control">
                <span className="khg-inline-label">横向</span>
                <GradientNumber
                  ariaLabel="中心点横向位置"
                  value={value.centerX}
                  min={0}
                  max={100}
                  unit="%"
                  onChange={(centerX) => update({ centerX })}
                />
                <span className="khg-inline-label">纵向</span>
                <GradientNumber
                  ariaLabel="中心点纵向位置"
                  value={value.centerY}
                  min={0}
                  max={100}
                  unit="%"
                  onChange={(centerY) => update({ centerY })}
                />
                <span className="khg-hint">相对预览区域，0–100%</span>
              </div>
            </div>
          </>
        )}

        <div className="khg-stops-head">
          <span className="khg-stops-title">颜色与位置</span>
          <span className="khg-stops-count">
            {value.stops.length} / {MAX_STOPS} 个色标
          </span>
          <button
            type="button"
            className="btn sm ghost"
            disabled={value.stops.length >= MAX_STOPS}
            title={
              value.stops.length >= MAX_STOPS
                ? `最多 ${MAX_STOPS} 个色标`
                : '在最宽的位置间隔处添加一个色标'
            }
            onClick={addStop}
          >
            添加色标
          </button>
        </div>

        <div className="khg-stops">
          {value.stops.map((stop, index) => {
            const isOpen = openStop === index
            const color = normalizeHex(stop.color)
            const panelId = `${baseId}-gradient-color-${index}`
            return (
              <div className="khg-stop" key={index}>
                <Collapse
                  open={isOpen}
                  header={
                    <div className="khg-stop-head">
                      <div className="khg-stop-identity">
                        <span className="khg-stop-name">色标 {index + 1}</span>
                        <button
                          type="button"
                          className="color-trigger khg-color-trigger"
                          title={`选择色标 ${index + 1} 的颜色（当前 ${color}）`}
                          aria-label={`选择色标 ${index + 1} 的颜色，当前 ${color}`}
                          aria-expanded={isOpen}
                          aria-controls={panelId}
                          onClick={() => setActiveStop(isOpen ? null : index)}
                        >
                          <span
                            className="khg-swatch"
                            style={{ background: stop.color }}
                          />
                        </button>
                        <span className="khg-stop-hex">{color}</span>
                      </div>

                      <div className="khg-stop-position">
                        <span className="khg-mini-label">位置</span>
                        <input
                          className="slider khg-stop-slider"
                          type="range"
                          min={0}
                          max={100}
                          step={1}
                          value={stop.position}
                          aria-label={`色标 ${index + 1} 位置`}
                          onChange={(event) =>
                            updateStop(index, {
                              position: clampNumber(
                                Number(event.target.value),
                                0,
                                100,
                                stop.position
                              )
                            })
                          }
                        />
                        <GradientNumber
                          ariaLabel={`色标 ${index + 1} 位置（百分比）`}
                          value={stop.position}
                          min={0}
                          max={100}
                          unit="%"
                          onChange={(position) => updateStop(index, { position })}
                        />
                        <button
                          type="button"
                          className="btn sm ghost khg-remove"
                          disabled={value.stops.length <= MIN_STOPS}
                          title={
                            value.stops.length <= MIN_STOPS
                              ? `至少保留 ${MIN_STOPS} 个色标`
                              : `移除色标 ${index + 1}`
                          }
                          aria-label={`移除色标 ${index + 1}`}
                          onClick={() => removeStop(index)}
                        >
                          移除
                        </button>
                      </div>
                    </div>
                  }
                >
                  <div
                    className="settings-color-panel khg-color-panel"
                    id={panelId}
                    role="group"
                    aria-label={`色标 ${index + 1} 颜色`}
                  >
                    {isOpen && (
                      <ColorPicker
                        value={stop.color}
                        onChange={(hex) => updateStop(index, { color: normalizeHex(hex) })}
                      />
                    )}
                  </div>
                </Collapse>
              </div>
            )
          })}
        </div>
        <p className="khg-foot">
          至少保留两个色标；调整位置只会移动当前色标，其他颜色和设置不变。
        </p>
      </div>
    </section>
  )
}
