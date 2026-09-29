import type { ReactElement } from 'react'
import Icon, { type IconName } from './Icon'
import type { ViewId } from '../viewTypes'

// Left navigation rail. Only the pages relevant to the current app are shown
// (gacha needs a game add-on, update needs an updatable module); settings is
// pinned to the bottom.
interface RailProps {
  view: ViewId
  onNavigate: (view: ViewId) => void
  showGacha: boolean
  showUpdate: boolean
}

interface RailEntry {
  id: ViewId
  icon: IconName
  label: string
  visible: boolean
}

export default function Rail({ view, onNavigate, showGacha, showUpdate }: RailProps): ReactElement {
  // `visible` is resolved from the app's modules, not from the current view.
  const entries: RailEntry[] = [
    { id: 'home', icon: 'home', label: '主页', visible: true },
    { id: 'playtime', icon: 'clock', label: '使用时长', visible: true },
    { id: 'gacha', icon: 'gacha', label: '抽卡记录', visible: showGacha },
    { id: 'gallery', icon: 'gallery', label: '图库', visible: true },
    { id: 'update', icon: 'update', label: '更新', visible: showUpdate }
  ]

  return (
    <nav className="rail">
      {entries
        .filter((e) => e.visible)
        .map((e) => (
          <button
            key={e.id}
            className={`rail-item${view === e.id ? ' active' : ''}`}
            title={e.label}
            onClick={() => onNavigate(e.id)}
          >
            <Icon name={e.icon} />
          </button>
        ))}

      <div className="rail-spacer" />

      <button
        className={`rail-item${view === 'settings' ? ' active' : ''}`}
        title="设置"
        onClick={() => onNavigate('settings')}
      >
        <Icon name="settings" />
      </button>
    </nav>
  )
}
