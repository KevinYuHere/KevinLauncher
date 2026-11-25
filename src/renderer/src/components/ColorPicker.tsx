import { useEffect, useRef, useState, type ReactElement } from 'react'
import { HexColorPicker } from 'react-colorful'

interface ColorPickerProps {
  value: string | null
  onChange: (hex: string) => void
}

const PRESETS = [
  '#3778e5',
  '#8b5cf6',
  '#ec4899',
  '#ef4444',
  '#f59e0b',
  '#22c55e',
  '#06b6d4',
  '#94a3b8'
]

const FALLBACK = '#3778e5'

function normalize(hex: string): string {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  return match ? `#${match[1].toLowerCase()}` : FALLBACK
}

/** Parse `#rgb` / `#rrggbb` / `rgb(r, g, b)` / `rrggbb` into `#rrggbb`. */
function parseColor(input: string): string | null {
  const text = input.trim().toLowerCase()
  const rgb = /^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})/.exec(text)
  if (rgb) {
    const channels = [rgb[1], rgb[2], rgb[3]].map((n) => Math.max(0, Math.min(255, Number(n))))
    return `#${channels.map((n) => n.toString(16).padStart(2, '0')).join('')}`
  }
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text)
  if (!hex) return null
  const value = hex[1]
  return `#${value.length === 3 ? value.replace(/./g, (c) => c + c) : value}`
}

/**
 * Colour editor built on [react-colorful](https://github.com/omgovich/react-colorful)
 * (a dependency-free, styleable picker): saturation square + hue slider, a
 * hex/RGB text field and a few presets. Rendered inside a glass popup so it
 * follows the current material.
 */
export default function ColorPicker({ value, onChange }: ColorPickerProps): ReactElement {
  const current = normalize(value ?? FALLBACK)
  const [text, setText] = useState(current)
  const lastEmitted = useRef<string | null>(null)

  // Adopt an incoming value only when we did not just emit it ourselves.
  useEffect(() => {
    if (value && normalize(value) !== lastEmitted.current) setText(normalize(value))
  }, [value])

  const emit = (hex: string): void => {
    const next = normalize(hex)
    lastEmitted.current = next
    setText(next)
    onChange(next)
  }

  const commitText = (): void => {
    const hex = parseColor(text)
    if (!hex) {
      setText(current)
      return
    }
    emit(hex)
  }

  return (
    <div className="color-editor">
      <HexColorPicker color={current} onChange={emit} />
      <div className="color-editor-foot">
        <span className="color-preview" style={{ background: current }} />
        <input
          className="input color-text"
          value={text}
          placeholder="#rrggbb 或 rgb(r, g, b)"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitText()
          }}
        />
      </div>
      <div className="color-presets">
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className="color-swatch"
            style={{ background: preset }}
            title={preset}
            onClick={() => emit(preset)}
          />
        ))}
      </div>
    </div>
  )
}
