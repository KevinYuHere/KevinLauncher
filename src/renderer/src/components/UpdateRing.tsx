import { useState, type ReactElement } from 'react'
import type { AppUpdateInfo, AppUpdateState } from '@shared/types'
import { formatBytes, formatEta } from '../format'
import Icon from './Icon'
import Ring from './Ring'
import AtomShield from './AtomShield'
import RailShield from './RailShield'
import { useAreaTheme } from '../theme/ThemeScope'

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
  const themedRing = useAreaTheme('downloadRing') !== 'default'

  const installing = state.phase === 'installing' || state.phase === 'done'
  const paused = state.phase === 'paused'
  const critical = state.critical === true || info?.critical === true
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
        ? critical
          ? '重要更新失败，点击重试'
          : '更新失败，点击重试'
        : state.phase === 'idle'
          ? `${critical ? '重要更新' : '发现新版本'} ${info?.version ?? ''}，点击下载`
          : `${critical ? '重要更新' : '正在下载更新'} ${percent}%${critical ? '（不可暂停）' : ''}`

  const click = (): void => {
    if (state.phase === 'idle' || state.phase === 'error') onStart()
    else if (!installing && !critical) onToggle()
  }

  return (
    <div
      className={`rail-update${critical ? ' is-critical' : ''}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button className="rail-item rail-update-btn" title={label} onClick={click}>
        {state.phase === 'idle' || state.phase === 'error' ? (
          <span className="rail-update-icon">
            {themedRing && <RailShield />}
            <Icon name="launcherUpdate" size={22} />
            <span className="rail-update-dot" />
            {critical && <span className="rail-update-critical">!</span>}
          </span>
        ) : (
          <span className="rail-ring">
            {themedRing && <RailShield />}
            {themedRing ? (
              <AtomShield
                state={
                  installing
                    ? 'applying'
                    : paused
                      ? 'paused'
                      : 'downloading'
                }
                progress={value}
                size={30}
              />
            ) : (
              <Ring value={value} size={30} stroke={3} />
            )}
            <span className="rail-ring-percent">{percent}</span>
          </span>
        )}
      </button>

      {/* Only while something is actually happening — hovering the idle icon
          should not pop a panel open. */}
      {hover && state.phase !== 'idle' && (
        <div className="rail-pop glass wallpaper-region">
          <span className="wp-region-layer" aria-hidden="true" />
          <div className="rail-pop-head">
            {critical ? '重要更新 · ' : ''}
            {installing ? '正在安装更新' : paused ? '已暂停' : '正在下载更新'}
          </div>
          <div className="rail-pop-percent">{percent}%</div>
          <div className="rail-pop-row">
            <span>
              {installing ? '安装' : '下载'} {formatBytes(shownBytes)} /{' '}
              {formatBytes(installing ? (info?.installSize ?? 0) : state.total)}
            </span>
            <span>{installing ? '请勿关闭' : critical ? '不可暂停' : formatEta(remaining)}</span>
          </div>
        </div>
      )}
    </div>
  )
}
