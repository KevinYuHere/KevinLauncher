import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { AppEntry, UpdateInfo, UpdateStatus } from '@shared/types'
import Ring from './Ring'
import { formatBytes, formatEta, formatSpeed } from '../format'
import { useDownloadSpeed } from '../useDownloadSpeed'

interface UpdateViewProps {
  entry: AppEntry
  info: UpdateInfo | undefined
  onChecked: (info: UpdateInfo) => void
  onBack: () => void
  onToast: (message: string) => void
}

const IDLE = (appId: string): UpdateStatus => ({
  appId,
  phase: 'idle',
  progress: 0,
  downloadedBytes: 0,
  totalBytes: 0
})

export default function UpdateView({
  entry,
  info,
  onChecked,
  onBack,
  onToast
}: UpdateViewProps): ReactElement {
  const [status, setStatus] = useState<UpdateStatus>(IDLE(entry.id))
  const [busy, setBusy] = useState(false)
  const autoChecked = useRef(false)

  useEffect(() => {
    void window.api.updateStatus(entry.id).then(setStatus)
    return window.api.onUpdateProgress((s) => {
      if (s.appId === entry.id) setStatus(s)
    })
  }, [entry.id])

  const check = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.api.updateInfo(entry.id)
      onChecked(res)
      if (res.message) onToast(res.message)
    } catch (error) {
      onToast(`检查失败：${(error as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [entry.id, onChecked, onToast])

  // If the startup check hasn't produced a result yet, fetch it once.
  useEffect(() => {
    if (!entry.addonId || info || autoChecked.current) return
    autoChecked.current = true
    void check()
  }, [entry.addonId, info, check])

  const start = useCallback(
    async (mode: 'update' | 'preDownload'): Promise<void> => {
      try {
        await window.api.updateStart(entry.id, mode)
      } catch (error) {
        onToast(`启动失败：${(error as Error).message}`)
      }
    },
    [entry.id, onToast]
  )

  const running = status.phase === 'downloading' || status.phase === 'extracting'
  const paused = status.phase === 'paused'
  const busyDownload = running || paused
  const speed = useDownloadSpeed(status)
  const preActive = busyDownload && status.mode === 'preDownload'
  const mainActive = busyDownload && status.mode === 'update'
  const preAvailable = !!info?.preDownloadVersion
  const updateAvailable = !!info?.hasUpdate
  const hasDownloadCard = preAvailable || updateAvailable || preActive || mainActive
  const percent = Math.round((status.progress || 0) * 100)
  const remaining =
    speed > 0 && status.totalBytes > 0 ? (status.totalBytes - status.downloadedBytes) / speed : null

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">更新 · {entry.name}</h1>
          <p className="page-subtitle">
            {info
              ? `本地 ${info.currentVersion ?? '未知'} → 最新 ${info.latestVersion ?? '未知'}`
              : '正在获取版本信息…'}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={onBack}>
            返回主页
          </button>
        </div>
      </div>

      <div className="page-body">
        <div className="panel">
          <div className="panel-head">
            <div className="panel-title">版本信息</div>
            <button className="btn sm primary" disabled={busy || running} onClick={() => void check()}>
              {busy ? '检查中…' : '检查更新'}
            </button>
          </div>
          <div className="panel-body">
            <dl className="desc">
              <dt>当前版本</dt>
              <dd>{info?.currentVersion ?? '—'}</dd>
              <dt>最新版本</dt>
              <dd>{info?.latestVersion ?? '—'}</dd>
              <dt>预下载版本</dt>
              <dd>{info?.preDownloadVersion ?? '—'}</dd>
            </dl>
            {info?.message && (
              <p className="hint" style={{ marginTop: 14 }}>
                {info.message}
              </p>
            )}
          </div>
        </div>

        {hasDownloadCard && (
          <div className="panel">
            <div className="panel-head">
              <div className="panel-title">下载</div>
              <div className="page-actions">
                {preActive ? (
                  running ? (
                    <button className="btn" onClick={() => void window.api.updateCancel(entry.id)}>
                      停止预下载
                    </button>
                  ) : (
                    <button className="btn" onClick={() => void start('preDownload')}>
                      继续预下载
                    </button>
                  )
                ) : preAvailable && !mainActive ? (
                  <button className="btn" onClick={() => void start('preDownload')}>
                    预下载
                  </button>
                ) : null}
                {mainActive ? (
                  running ? (
                    <button
                      className="btn primary"
                      onClick={() => void window.api.updateCancel(entry.id)}
                    >
                      停止更新
                    </button>
                  ) : (
                    <button className="btn primary" onClick={() => void start('update')}>
                      继续更新
                    </button>
                  )
                ) : updateAvailable && !preActive ? (
                  <button className="btn primary" onClick={() => void start('update')}>
                    更新
                  </button>
                ) : null}
              </div>
            </div>
            <div className="panel-body">
              {busyDownload ? (
                <div className="update-progress">
                  <div className="dl-row">
                    <Ring value={status.progress} />
                    <div className="dl-row-info">
                      <div className="dl-row-percent">{running ? `${percent}%` : '已暂停'}</div>
                      <div className="dl-row-sub">
                        {running ? formatSpeed(speed) : '点击继续'} ·{' '}
                        {formatBytes(status.downloadedBytes)} / {formatBytes(status.totalBytes)}
                      </div>
                    </div>
                    <div className="dl-row-eta">{running ? formatEta(remaining) : ''}</div>
                  </div>
                  <div className="progress">
                    <div className="progress-fill" style={{ width: `${percent}%` }} />
                  </div>
                  <div className="update-progress-meta">
                    <span>{status.message}</span>
                  </div>
                </div>
              ) : (
                <p className="hint">
                  {info?.supported
                    ? '更新仅下载变更文件（支持断点续传）；预下载写入独立目录。'
                    : '该游戏暂不支持在本启动器内下载更新。'}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
