import { useState, type ReactElement } from 'react'
import type { AppUpdateInfo, AppUpdateState } from '@shared/types'
import { formatBytes, formatEta } from '../format'
import Icon from './Icon'
import Ring from './Ring'

interface UpdateRingProps {
  /** Set when a newer release is available (not yet downloaded). */
  info: AppUpdateInfo | null
  state: AppUpdateState
  /** Start the download. */
  onStart: () => void
  /** Pause / resume the download. */
  onToggle: () => void
}

/**
 * Rail slot above the settings button:
 *
 * - an icon when a new version is available (click = start the download),
 * - a theme-coloured progress ring while downloading (click = pause / resume),
 * - the same ring with the install progress while installing (not clickable),
 * - hovering opens a frosted panel to the right with the percentage, the
 *   transferred / total sizes and the estimated time left.
 */
export default function UpdateRing({
  info,
  state,
  onStart,
  onToggle
}: UpdateRingProps): ReactElement | null {
  const [hover, setHover] = useState(false)

  const installing = state.phase === 'installing' || state.phase === 'done'
  const paused = state.phase === 'paused'
  const active =
    state.phase === 'downloading' || paused || installing || state.phase === 'error'
  if (!info && !active) return null

  const value = installing ? state.installPercent / 100 : state.percent / 100
  const percent = Math.floor(Math.min(1, Math.max(0, value)) * 100)
  const remaining =
    !installing && state.bytesPerSecond > 0
      ? (state.total - state.transferred) / state.bytesPerSecond
      : null
  const shownBytes = installing
    ? (state.installPercent / 100) * (info?.installSize ?? 0)
    : state.transferred

  const label = installing
    ? '正在安装更新…'
    : paused
      ? `已暂停 ${percent}%`
      : state.phase === 'error'
        ? '更新失败，点击重试'
        : state.phase === 'idle'
          ? `发现新版本 ${info?.version ?? ''}，点击下载`
          : `正在下载更新 ${percent}%`

  const click = (): void => {
    if (state.phase === 'idle' || state.phase === 'error') onStart()
    else if (!installing) onToggle()
  }

  return (
    <div
      className="rail-update"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button className="rail-item rail-update-btn" title={label} onClick={click}>
        {state.phase === 'idle' || state.phase === 'error' ? (
          <span className="rail-update-icon">
            <Icon name="launcherUpdate" size={22} />
            <span className="rail-update-dot" />
          </span>
        ) : (
          <span className="rail-ring">
            <Ring value={value} size={30} stroke={3} />
            <span className="rail-ring-percent">{percent}</span>
          </span>
        )}
      </button>

      {/* Only while something is actually happening — hovering the idle icon
          should not pop a panel open. */}
      {hover && state.phase !== 'idle' && (
        <div className="rail-pop glass">
          <div className="rail-pop-head">
            {installing ? '正在安装更新' : paused ? '已暂停' : '正在下载更新'}
          </div>
          <div className="rail-pop-percent">{percent}%</div>
          <div className="rail-pop-row">
            <span>
              {installing ? '安装' : '下载'} {formatBytes(shownBytes)} /{' '}
              {formatBytes(installing ? (info?.installSize ?? 0) : state.total)}
            </span>
            <span>{installing ? '请勿关闭' : formatEta(remaining)}</span>
          </div>
        </div>
      )}
    </div>
  )
}
