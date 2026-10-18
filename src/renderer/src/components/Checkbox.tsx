import { useRef, type ReactElement, type ReactNode, type RefObject } from 'react'
import Icon from './Icon'
import { usePressJelly } from '../drag/usePressJelly'

interface CheckboxProps {
  checked: boolean
  onChange: (value: boolean) => void
  label?: ReactNode
  title?: string
  disabled?: boolean
}

/**
 * Checkbox with the shared press-jelly feedback and the theme colour when on.
 * Replaces native checkboxes so it matches the current material / accent.
 */
export default function Checkbox({
  checked,
  onChange,
  label,
  title,
  disabled
}: CheckboxProps): ReactElement {
  const ref = useRef<HTMLButtonElement>(null)
  const { onPointerDown } = usePressJelly(ref as RefObject<HTMLElement>, 1.2)
  const toggle = (): void => {
    if (!disabled) onChange(!checked)
  }
  return (
    <span className={`checkbox${disabled ? ' disabled' : ''}`} title={title}>
      <button
        ref={ref}
        type="button"
        role="checkbox"
        aria-checked={checked}
        className="checkbox-box"
        data-on={checked ? 'true' : 'false'}
        disabled={disabled}
        onPointerDown={onPointerDown}
        onClick={toggle}
      >
        {checked && <Icon name="check" size={14} />}
      </button>
      {label != null && (
        <span className="checkbox-label" onClick={toggle}>
          {label}
        </span>
      )}
    </span>
  )
}
