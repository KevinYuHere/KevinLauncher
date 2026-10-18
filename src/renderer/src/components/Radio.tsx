import { useRef, type ReactElement, type ReactNode, type RefObject } from 'react'
import { usePressJelly } from '../drag/usePressJelly'

interface RadioProps {
  checked: boolean
  onChange: () => void
  label?: ReactNode
  title?: string
  disabled?: boolean
}

/**
 * Radio with the shared press-jelly feedback and the theme colour when on.
 * Replaces native radios so it matches the current material / accent.
 */
export default function Radio({
  checked,
  onChange,
  label,
  title,
  disabled
}: RadioProps): ReactElement {
  const ref = useRef<HTMLButtonElement>(null)
  const { onPointerDown } = usePressJelly(ref as RefObject<HTMLElement>, 1.2)
  const pick = (): void => {
    if (!disabled) onChange()
  }
  return (
    <span className={`radio${disabled ? ' disabled' : ''}`} title={title}>
      <button
        ref={ref}
        type="button"
        role="radio"
        aria-checked={checked}
        className="radio-dot"
        data-on={checked ? 'true' : 'false'}
        disabled={disabled}
        onPointerDown={onPointerDown}
        onClick={pick}
      >
        <span className="radio-knob" />
      </button>
      {label != null && (
        <span className="radio-label" onClick={pick}>
          {label}
        </span>
      )}
    </span>
  )
}
