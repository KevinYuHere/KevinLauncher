import { useState, type ReactElement } from 'react'
import type { AppUpdateInfo, AppUpdateState } from '@shared/types'
import { errorReason, failureText, formatBytes, formatEta } from '../format'
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

  const done = state.phase === 'done'
  const installing = state.phase === 'installing' || done
  const paused = state.phase === 'paused'
  const failed = state.phase === 'error'
  const retrying = failed && (state.retry ?? 0) > 0
  const critical = state.phase === 'idle' ? info?.critical === true : state.critical === true
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
    ? (state.installPercent / 100) * (state.installTotal ?? 0)
    : state.transferred
  const retryStatus = errorReason(state.message) || '重要更新失败，正在自动重试…'

  const label = done
    ? '更新已安装，正在重启…'
    : installing
      ? '正在安装更新…'
      : paused
        ? `已暂停 ${percent}%，点击继续`
        : failed
          ? retrying
            ? retryStatus
            : critical
              ? '重要更新失败，点击重试'
              : '更新失败，点击重试'
          : state.phase === 'idle'
            ? `${critical ? '重要更新' : '发现新版本'} ${info?.version ?? ''}，点击下载`
            : `${critical ? '重要更新' : '正在下载更新'} ${percent}%${critical ? '（不可暂停）' : ''}`

  const rawFailure = state.error || state.message || '更新失败'
  const failureContext = `${state.message} ${state.error ?? ''}`
  const failureHint = /保存失败/.test(failureContext)
    ? '请关闭占用启动器文件的程序后，点击进度图标重试。'
    : /\bENOSPC\b/i.test(failureContext)
      ? '磁盘空间不足，请清理空间后点击进度图标重试。'
      : /\b(EACCES|EPERM)\b/i.test(failureContext)
        ? '没有写入权限，请以管理员身份运行启动器后重试。'
        : '请检查网络后点击进度图标重试。'
  const retryDetail = retrying ? errorReason(state.error) : ''
  const failureSummary = retrying
    ? `${retryStatus}${retryDetail ? ` 详情：${retryDetail}` : ''}`
    : failureText(rawFailure, failureHint)

  const click = (): void => {
    if (state.phase === 'idle' || state.phase === 'error') onStart()
    else if (!installing && !critical) onToggle()
  }

  return (
    <div
      className={`rail-update${critical ? ' is-critical' : ''}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
    >
      <button className="rail-item rail-update-btn" aria-label={label} onClick={click}
        aria-disabled={installing || (critical && !['idle', 'error'].includes(state.phase))}>
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
            {critical && !failed ? '重要更新 · ' : ''}
            {failed
              ? failureSummary
              : done
                ? '更新已安装，正在重启'
                : installing
                  ? '正在安装更新'
                  : paused
                    ? '已暂停'
                    : '正在下载更新'}
          </div>
          <div className="rail-pop-percent">{percent}%</div>
          <div className="rail-pop-row">
            <span>
              {done ? (
                '更新已安装'
              ) : (
                <>
                  {installing ? '安装' : '下载'} {formatBytes(shownBytes)} /{' '}
                  {formatBytes(installing ? (state.installTotal ?? 0) : state.total)}
                </>
              )}
            </span>
            <span>
              {done
                ? '正在重启'
                : installing
                  ? '请勿关闭启动器'
                  : failed
                    ? retrying ? '自动重试中' : '点击重试'
                    : paused
                      ? '点击继续'
                      : critical
                        ? '不可暂停'
                        : formatEta(remaining)}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
