import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { AppEntry, UpdateInfo, UpdateStatus } from '@shared/types'
import Ring from './Ring'
import { failureText, formatBytes, formatEta, formatSpeed } from '../format'
import { useDownloadSpeed } from '../useDownloadSpeed'

interface UpdateViewProps {
  entry: AppEntry
  info: UpdateInfo | undefined
  status?: UpdateStatus
  onCheck: (appId: string) => Promise<UpdateInfo | null>
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
  status: latestStatus,
  onCheck,
  onBack,
  onToast
}: UpdateViewProps): ReactElement {
  const status = latestStatus ?? IDLE(entry.id)
  const [busy, setBusy] = useState(false)
  const autoChecked = useRef(false)
  const active = useRef(false)

  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  const check = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await onCheck(entry.id)
      if (active.current && res?.message) onToast(res.message)
    } catch (error) {
      if (active.current) {
        onToast(failureText(error, '检查更新失败。请检查网络后重试。若仍失败，请确认游戏安装目录正确。'))
      }
    } finally {
      if (active.current) setBusy(false)
    }
  }, [entry.id, onCheck, onToast])

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
        onToast(failureText(
          error,
          mode === 'update'
            ? '无法开始更新。请确认游戏安装目录存在且磁盘空间充足，然后重试。'
            : '无法开始预下载。请确认游戏安装目录存在且磁盘空间充足，然后重试。'
        ))
      }
    },
    [entry.id, onToast]
  )

  const running = status.phase === 'downloading' || status.phase === 'extracting'
  const extracting = status.phase === 'extracting'
  const paused = status.phase === 'paused'
  const failed = status.phase === 'error'
  const done = status.phase === 'done'
  const busyDownload = running || paused
  const speed = useDownloadSpeed(status)
  const preActive = busyDownload && status.mode === 'preDownload'
  const mainActive = busyDownload && status.mode === 'update'
  const failedMode = failed ? status.mode : undefined
  const preAvailable = !!info?.preDownloadVersion && !info?.preDownloadFinished
  const updateAvailable = !!info?.hasUpdate
  const hasDownloadCard = preAvailable || updateAvailable || preActive || mainActive || failed || done
  const percent = Math.round((status.progress || 0) * 100)
  const remaining =
    speed > 0 && status.totalBytes > 0 ? (status.totalBytes - status.downloadedBytes) / speed : null
  const rawInfoNotice = info?.message?.trim()
  const infoNoticeIsTechnical = !!rawInfoNotice && (
    /Error invoking remote method/i.test(rawInfoNotice) ||
    /fetch failed/i.test(rawInfoNotice) ||
    /\b(EACCES|EPERM|ENOSPC|ENOENT|EBUSY|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET)\b/.test(rawInfoNotice)
  )
  const infoNotice = info?.preDownloadFinished && !infoNoticeIsTechnical
    ? info.hasUpdate
      ? '预下载已完成，可以直接点「更新」完成安装。'
      : '预下载已完成。版本开放后再点「更新」完成安装。'
    : rawInfoNotice

  return (
    <div className="page update-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">更新 · {entry.name}</h1>
          <p className="page-subtitle">
            {info
              ? `当前版本 ${info.currentVersion ?? '未知'} → 最新版本 ${info.latestVersion ?? '未知'}`
              : busy
                ? '正在获取版本信息…'
                : autoChecked.current
                  ? '未获取到版本信息，请点「检查更新」重试'
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
              <dd>
                {info?.preDownloadVersion
                  ? `${info.preDownloadVersion}${info.preDownloadFinished ? '（已完成）' : ''}`
                  : '—'}
              </dd>
              <dt>更新位置</dt>
              <dd>{entry.gameDirectory || '未单独设置，使用默认启动方式所在目录'}</dd>
              {info && info.hasUpdate && info.mainSizeBytes > 0 && (
                <>
                  <dt>更新包大小</dt>
                  <dd>{formatBytes(info.mainSizeBytes)}</dd>
                </>
              )}
              {info && info.preDownloadVersion && info.preDownloadSizeBytes > 0 && (
                <>
                  <dt>预下载大小</dt>
                  <dd>{formatBytes(info.preDownloadSizeBytes)}</dd>
                </>
              )}
            </dl>
            {infoNotice && (
              <p className="hint" style={{ marginTop: 14 }}>
                {infoNoticeIsTechnical
                  ? failureText(infoNotice, '读取游戏版本信息失败。请检查网络、磁盘空间和游戏安装目录后重试。')
                  : infoNotice}
              </p>
            )}
          </div>
        </div>

        {hasDownloadCard && (
          <div className="panel">
            <div className="panel-head">
              <div className="panel-title">更新下载</div>
              <div className="page-actions">
                {preActive ? (
                  running ? (
                    <button className="btn" onClick={() => void window.api.updateCancel(entry.id)}>
                      暂停预下载
                    </button>
                  ) : (
                    <button className="btn" onClick={() => void start('preDownload')}>
                      继续预下载
                    </button>
                  )
                ) : preAvailable && !mainActive && !done ? (
                  <button className="btn" onClick={() => void start('preDownload')}>
                    {failedMode === 'preDownload' ? '重试预下载' : '预下载'}
                  </button>
                ) : null}
                {mainActive ? (
                  running ? (
                    <button
                      className="btn primary"
                      onClick={() => void window.api.updateCancel(entry.id)}
                    >
                      暂停更新
                    </button>
                  ) : (
                    <button className="btn primary" onClick={() => void start('update')}>
                      继续更新
                    </button>
                  )
                ) : updateAvailable && !preActive && !done ? (
                  <button className="btn primary" onClick={() => void start('update')}>
                    {failedMode === 'update' ? '重试更新' : '下载并更新'}
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
                        {running
                          ? extracting
                            ? (status.message ?? '正在应用更新…')
                            : formatSpeed(speed)
                          : '已暂停，可点上方按钮继续'}{' '}
                        · {formatBytes(status.downloadedBytes)} / {formatBytes(status.totalBytes)}
                      </div>
                    </div>
                    <div className="dl-row-eta">
                      {running ? (extracting ? '正在安装' : formatEta(remaining)) : ''}
                    </div>
                  </div>
                  <div className="progress">
                    <div className="progress-fill" style={{ width: `${percent}%` }} />
                  </div>
                  <div className="update-progress-meta">
                    <span>
                      {extracting ? '正在写入游戏文件，请勿关闭启动器。' : status.message}
                    </span>
                  </div>
                </div>
              ) : failed ? (
                <div className="hint" role="alert">
                  <div>
                    {failureText(
                      status.message || '更新失败',
                      failedMode === 'preDownload'
                        ? '预下载没有完成。请检查网络、磁盘空间和游戏安装目录后重试。'
                        : '更新没有完成。请检查网络、磁盘空间和游戏安装目录后重试。'
                    )}
                  </div>
                  {status.totalBytes > 0 && (
                    <div style={{ marginTop: 8 }}>
                      上次进度 {percent}% · {formatBytes(status.downloadedBytes)} / {formatBytes(status.totalBytes)}
                    </div>
                  )}
                </div>
              ) : done ? (
                <p className="hint">
                  {status.mode === 'preDownload'
                    ? '预下载完成。版本开放后再点「更新」完成安装。'
                    : '更新完成，请启动游戏。'}
                </p>
              ) : (
                <>
                  {info?.supported ? (
                    <>
                      <p className="hint">
                        更新会写入游戏安装目录，只替换有变化的文件。可暂停后继续。开始前请关闭游戏、确认磁盘空间充足，重要文件请先备份。
                      </p>
                      {preAvailable && (
                        <p className="hint" style={{ marginTop: 8 }}>
                          预下载会提前下载新版本文件，版本开放后再点「更新」完成安装。
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="hint">该游戏暂不支持由本启动器下载更新，请使用游戏官方启动器更新。</p>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
