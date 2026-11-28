import type { CSSProperties, ReactElement } from 'react'
import {
  KEVIN_HUD_ITEM_DEFAULT,
  resolveKevinHudMemoryReadoutTypeSizing
} from '@shared/kevinHudSizing'
import type { KevinHudRenderItemStyle } from './kevinHudVisual'
import '../assets/kevinHudMemoryReadout.css'

export interface KevinHudMemoryReadoutProps {
  /** Decimal number already formatted by the caller; no unit is appended. */
  used: string | null
  /** Decimal number already formatted by the caller; the UI appends GB. */
  total: string | null
  /** Memory usage in 0–100. Null, NaN and infinities render as unknown. */
  percent: number | null
  /** Unit shared by used and total; defaults to GB. */
  unit?: string
  /** Optional per-item descriptor; defaults to the shared horizontal item. */
  itemStyle?: KevinHudRenderItemStyle
  /** Text shown when `description` is `text`; defaults to `MEM`. */
  descriptionLabel?: string
}

type ArcStyle = CSSProperties & {
  '--kevin-hud-memory-progress': string
}

type ReadoutStyle = CSSProperties & Record<`--khmr-${string}`, string>

const textValue = (value: string | null): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

const percentValue = (value: number | null): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(100, Math.max(0, Math.round(value)))
}

/**
 * One quiet CSS-drawn memory chip. The pins and inner circuit bars are plain
 * geometry, so no icon font, screenshot or third-party artwork is involved.
 */
function MemoryGlyph({ arc = false }: { arc?: boolean }): ReactElement {
  return (
    <span
      className={`kevin-hud-memory-readout__glyph${
        arc ? ' kevin-hud-memory-readout__glyph--arc' : ''
      }`}
      aria-hidden="true"
    />
  )
}

/**
 * The default monitor's memory readout. It is deliberately presentation-only:
 * it neither samples memory nor observes its host. The caller owns placement,
 * the live value pipeline and any visibility lifecycle.
 */
export default function KevinHudMemoryReadout({
  used,
  total,
  percent,
  unit = 'GB',
  itemStyle = { ...KEVIN_HUD_ITEM_DEFAULT, description: 'icon' },
  descriptionLabel = 'MEM'
}: KevinHudMemoryReadoutProps): ReactElement {
  const usedText = textValue(used)
  const totalText = textValue(total)
  const percentText = percentValue(percent)
  const displayUnit = typeof unit === 'string' && unit.trim() ? unit.trim() : 'GB'

  const usedAria = usedText ? `已用 ${usedText} ${displayUnit}` : '已用未知'
  const totalAria = totalText ? `内存总量 ${totalText} ${displayUnit}` : '内存总量未知'
  const percentAria = percentText === null ? '占用未知' : `占用 ${percentText}%`
  const ariaLabel = `内存使用：${usedAria}，${totalAria}，${percentAria}`

  const arcStyle: ArcStyle = {
    '--kevin-hud-memory-progress': `${percentText ?? 0}%`
  }
  const descriptionColor =
    itemStyle.descriptionColor ??
    'color-mix(in srgb, var(--khud-text, #ffffff) 82%, transparent)'
  const valueColor = itemStyle.valueColor ?? 'var(--khud-text, #ffffff)'
  const typeSizing = resolveKevinHudMemoryReadoutTypeSizing(itemStyle)
  const readoutStyle: ReadoutStyle = {
    '--khmr-copy-gap': `${itemStyle.gap}px`,
    // Independent multipliers over the fixed 448 x 48 reference type. The
    // inherited font scale still applies to text; these vars let a per-app
    // description or value size remain visible without the settled plate
    // height inflating its own fonts.
    '--khmr-value-scale': `${typeSizing.valueScale}`,
    '--khmr-description-scale': `${typeSizing.descriptionScale}`,
    '--khmr-description-weight': itemStyle.descriptionBold ? '700' : '500',
    '--khmr-value-weight': itemStyle.valueBold ? '650' : '450',
    // Null colours follow the unified, contrast-checked HUD text. The value is
    // white by default; the description keeps the reference's light white.
    '--khmr-description-color': descriptionColor,
    '--khmr-value-color': valueColor
  }

  return (
    <div
      className="kevin-hud-memory-readout"
      role="img"
      aria-label={ariaLabel}
      data-percent-known={percentText === null ? 'false' : 'true'}
      data-orientation={itemStyle.orientation}
      data-description={itemStyle.description}
      style={readoutStyle}
    >
      <span className="kevin-hud-memory-readout__left" aria-hidden="true">
        <span className="kevin-hud-memory-readout__description">
          {itemStyle.description === 'icon' ? (
            <MemoryGlyph />
          ) : (
            <span className="kevin-hud-memory-readout__description-text">
              {descriptionLabel.trim() || 'MEM'}
            </span>
          )}
        </span>
        <span className="kevin-hud-memory-readout__amounts">
          <span className="kevin-hud-memory-readout__used">{usedText ?? '--'}</span>
          <span className="kevin-hud-memory-readout__total">
            <span className="kevin-hud-memory-readout__divider">/</span>
            <span className="kevin-hud-memory-readout__total-value">
              {totalText ?? '--'}
            </span>
            <span className="kevin-hud-memory-readout__unit">{displayUnit}</span>
          </span>
        </span>
      </span>

      {/* Intentionally empty. The flexible centre keeps both clusters apart. */}
      <span className="kevin-hud-memory-readout__center" aria-hidden="true" />

      <span className="kevin-hud-memory-readout__right" aria-hidden="true">
        <span className="kevin-hud-memory-readout__percent">
          {percentText === null ? (
            '--'
          ) : (
            <>
              <span className="kevin-hud-memory-readout__percent-value">
                {percentText}
              </span>
              <span className="kevin-hud-memory-readout__percent-sign">%</span>
            </>
          )}
        </span>
        <span
          className="kevin-hud-memory-readout__arc"
          data-known={percentText === null ? 'false' : 'true'}
          style={arcStyle}
        >
          <MemoryGlyph arc />
        </span>
      </span>
    </div>
  )
}
