import { useEffect, useState, type ReactElement } from 'react'
import type { UninstallerInfo } from '@shared/types'
import { formatBytes } from '../format'

/**
 * Self-drawn uninstall UI, opened by `KevinLauncher.exe --uninstall` (which is
 * also what the Windows Settings → Apps entry runs). The user chooses whether
 * the user data in `%APPDATA%\kevin-launcher` is kept.
 */
export default function Uninstaller(): ReactElement {
  const [info, setInfo] = useState<UninstallerInfo | null>(null)
  const [keepUserData, setKeepUserData] = useState(true)
  const [step, setStep] = useState<'confirm' | 'progress'>('confirm')
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.uninstallerInfo().then(setInfo)
    return window.api.onUninstallerProgress((progress) => setStatus(progress.step))
  }, [])

  const run = async (): Promise<void> => {
    setStep('progress')
    setStatus('正在准备…')
    try {
      await window.api.uninstallerRun(keepUserData)
    } catch (e) {
      setError((e as Error).message)
      setStep('confirm')
    }
  }

  return (
    <div className="setup">
      <div className="setup-drag" />
      <div className="setup-card">
        <div className="setup-head">
          <img className="setup-logo" src="kevin-media://default/icon.png" alt="" />
          <div>
            <div className="setup-title">卸载 KevinLauncher</div>
            <div className="setup-sub">
              {info ? `版本 ${info.version}` : '正在读取安装信息…'}
            </div>
          </div>
          <button className="setup-close" title="取消" onClick={() => window.api.windowClose()}>
            ✕
          </button>
        </div>

        <div className="setup-body">
          {step === 'confirm' ? (
            <>
              <label className="setup-label">将从以下位置移除</label>
              <div className="setup-note">{info?.installDir ?? '…'}</div>

              <ul className="setup-list">
                <li>
                  <span>程序文件</span>
                  <em>{formatBytes(info?.installSize ?? 0)}</em>
                </li>
                <li>
                  <span>快捷方式 / 注册表 / 计划任务</span>
                  <em>删除</em>
                </li>
              </ul>

              <label className="setup-check">
                <input
                  type="checkbox"
                  checked={keepUserData}
                  onChange={(e) => setKeepUserData(e.target.checked)}
                />
                <span>
                  保留用户数据（{formatBytes(info?.dataSize ?? 0)}，含应用列表、使用时长、抽卡记录、
                  图标与背景）
                  <em className="setup-check-path">{info?.dataDir ?? ''}</em>
                </span>
              </label>

              {!keepUserData && (
                <div className="setup-warn">
                  取消勾选后，上述目录会被<b>永久删除</b>，无法恢复。
                </div>
              )}
              {error && <div className="setup-warn">卸载失败：{error}</div>}
            </>
          ) : (
            <>
              <label className="setup-label">正在卸载…</label>
              <div className="setup-bar">
                <span className="setup-bar-indeterminate" />
              </div>
              <div className="setup-meta">
                <span>{status}</span>
              </div>
            </>
          )}
        </div>

        <div className="setup-foot">
          {step === 'confirm' ? (
            <>
              <button className="btn" onClick={() => window.api.windowClose()}>
                取消
              </button>
              <button className="btn danger" onClick={() => void run()}>
                卸载
              </button>
            </>
          ) : (
            <button className="btn" disabled>
              卸载中…
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
