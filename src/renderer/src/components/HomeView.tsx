import { useEffect, useState, type ReactElement } from 'react'
import type { AddonDescriptor, AppEntry, UpdateInfo, UpdateStatus } from '@shared/types'
import Icon from './Icon'
import Ring from './Ring'
import { formatBytes, formatEta, formatSpeed } from '../format'
import { useDownloadSpeed } from '../useDownloadSpeed'

interface HomeViewProps {
  entry: AppEntry
  addon: AddonDescriptor | undefined
  running: boolean
  startedAt?: string
  totalSec: number
  updateInfo: UpdateInfo | undefined
  updateStatus: UpdateStatus | null
  onLaunch: () => void
  onStop: () => void
  onUpdateToggle: () => void
  onPreDownloadToggle: () => void
  onShowStats: () => void
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}h ${pad(m)}m` : `${m}m ${pad(s)}s`
}

function formatTotal(totalSec: number): string {
  if (totalSec <= 0) return '暂无记录'
  const hours = totalSec / 3600
  if (hours >= 1) return `${hours.toFixed(1)} 小时`
  return `${Math.max(1, Math.round(totalSec / 60))} 分钟`
}

export default function HomeView({
  entry,
  addon,
  running,
  startedAt,
  totalSec,
  updateInfo,
  updateStatus,
  onLaunch,
  onStop,
  onUpdateToggle,
  onPreDownloadToggle,
  onShowStats
}: HomeViewProps): ReactElement {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])

  // Download speed, smoothed from successive progress samples.
  const speed = useDownloadSpeed(updateStatus)

  const elapsed = running && startedAt ? now - new Date(startedAt).getTime() : 0

  const status = updateStatus
  const active = !!status && (status.phase === 'downloading' || status.phase === 'extracting')
  const paused = status?.phase === 'paused'
  const progress = status?.progress ?? 0
  const preActive = (active || paused) && status?.mode === 'preDownload'
  const mainActive = (active || paused) && status?.mode === 'update'
  const preAvailable = !active && !paused && !!updateInfo?.preDownloadVersion
  const updateAvailable = !!updateInfo?.hasUpdate

  const remaining =
    speed > 0 && status && status.totalBytes > 0
      ? (status.totalBytes - status.downloadedBytes) / speed
      : null

  const popup = (
    <div className="dl-pop">
      <div className="dl-pop-speed">{formatSpeed(speed)}</div>
      <div className="dl-pop-row">
        <span>
          {formatBytes(status?.downloadedBytes ?? 0)} / {formatBytes(status?.totalBytes ?? 0)}
        </span>
        <span>{formatEta(remaining)}</span>
      </div>
    </div>
  )

  return (
    <div className="home">
      <div className="home-info glass">
        <div className="hi-title">{entry.name}</div>
        <div className="hi-sub">
          <span>{entry.moduleLabel?.trim() ? entry.moduleLabel : addon ? addon.name : '普通应用'}</span>
          <span className="sep" />
          <span className={running ? 'live' : ''}>{running ? '运行中' : '未运行'}</span>
        </div>
        <button className="hi-stats" onClick={onShowStats}>
          总时长 {formatTotal(totalSec)}
        </button>
      </div>

      <div className="home-actions">
        <button className="playtime-pill glass" title="查看使用时间" onClick={onShowStats}>
          <Icon name="clock" size={16} />
          <span>{running ? formatDuration(elapsed) : formatTotal(totalSec)}</span>
        </button>

        {(preActive || preAvailable) && (
          <div className="dl-wrap">
            <button className="dl-pill glass" onClick={onPreDownloadToggle} title="预下载">
              <span className="ring-box">
                {preActive ? <Ring value={progress} /> : <Icon name="update" size={20} />}
              </span>
              {preActive ? (
                <span className="dl-percent">{paused ? '已暂停' : `${Math.floor(progress * 100)}%`}</span>
              ) : (
                <span className="dl-pill-label">预下载</span>
              )}
            </button>
            {preActive && popup}
          </div>
        )}

        {mainActive ? (
          <div className="dl-wrap">
            <button className="start-btn update dl-btn" onClick={onUpdateToggle} title="点击暂停 / 继续">
              <span className="ring-box">
                <Ring value={progress} />
              </span>
              <span className="dl-btn-info">
                <span className="dl-btn-percent">
                  {paused ? '已暂停' : `${Math.floor(progress * 100)}%`}
                </span>
              </span>            </button>
            {popup}
          </div>
        ) : running ? (
          <button className="start-btn stop" onClick={onStop}>
            停止
          </button>
        ) : updateAvailable ? (
          <button className="start-btn update" onClick={onUpdateToggle}>
            开始更新
          </button>
        ) : (
          <button className="start-btn" onClick={onLaunch}>
            启动
          </button>
        )}
      </div>
    </div>
  )
}
