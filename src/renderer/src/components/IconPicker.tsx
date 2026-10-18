import type { ReactElement } from 'react'
import Icon from './Icon'

interface IconPickerProps {
  /** Current icon URL (null → the dashed "add" placeholder). */
  src: string | null
  onPick: () => void
  /** When given, a "restore default" button is shown. */
  onClear?: () => void
  label?: string
  desc?: string
  /** Smaller preview (add-app dialog / app settings). */
  small?: boolean
}

/**
 * The icon picker shared by the launcher settings, the app settings and the
 * add-app dialog. With no icon it shows the same dashed box + plus as the
 * games-bar "add app" button.
 */
export default function IconPicker({
  src,
  onPick,
  onClear,
  label = '图标',
  desc,
  small
}: IconPickerProps): ReactElement {
  return (
    <div className={`launcher-brand${small ? ' icon-picker-sm' : ''}`}>
      <button
        className={`launcher-icon${src ? ' has-image' : ' empty'}`}
        onClick={onPick}
        title="点击更换图标"
      >
        {src ? <img src={src} alt="" /> : <Icon name="plus" size={28} />}
      </button>
      <div className="launcher-brand-side">
        <div className="settings-name">{label}</div>
        {desc && <div className="settings-desc">{desc}</div>}
        <div className="media-row" style={{ gap: 8, marginTop: 10 }}>
          <button className="btn sm primary" onClick={onPick}>
            更换图标
          </button>
          {onClear && (
            <button className="btn sm ghost" onClick={onClear}>
              恢复默认
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
