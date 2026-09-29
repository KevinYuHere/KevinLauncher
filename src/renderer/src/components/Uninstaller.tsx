import { useEffect, useState, type ReactElement } from 'react'
import type { UninstallerInfo } from '@shared/types'
import { formatBytes } from '../format'

/**
 * Self-drawn uninstaller, opened by `KevinLauncher.exe --uninstall` — which is
 * exactly what the Windows Settings → Apps entry runs. Full-window page in the
 * same style as the installer; the user chooses whether the user data folder is
 * kept.
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
      <div className="setup-aurora" aria-hidden="true">
        <span className="aurora-a" />
        <span className="aurora-b" />
        <span className="aurora-c" />
        <div className="setup-grid" />
      </div>
      <div className="setup-drag" />

      <header className="setup-top">
        <img className="setup-logo" src="kevin-media://default/icon.png" alt="" />
        <div className="setup-brand">
          <div className="setup-brand-name">KevinLauncher</div>
          <div className="setup-brand-sub">
            {info ? `卸载程序 · ${info.version}` : '正在读取安装信息…'}
          </div>
        </div>
        <button className="setup-close" title="取消" onClick={() => window.api.windowClose()}>
          ✕
        </button>
      </header>

      <main className="setup-main">
        {step === 'confirm' ? (
          <section className="setup-panel">
            <h1 className="setup-title-lg">卸载 KevinLauncher</h1>
            <p className="setup-sub">
              程序与快捷方式、注册表项、开机自启计划任务都会被移除。
            </p>

            <ul className="setup-list">
              <li>
                <span>安装位置</span>
                <em>{info?.installDir ?? '…'}</em>
              </li>
              <li>
                <span>程序文件</span>
                <em>{formatBytes(info?.installSize ?? 0)}</em>
              </li>
            </ul>

            <label className="setup-check">
              <input
                type="checkbox"
                checked={keepUserData}
                onChange={(e) => setKeepUserData(e.target.checked)}
              />
              <span>
                保留用户数据（{formatBytes(info?.dataSize ?? 0)}
                ，含应用列表、使用时长、抽卡记录、图标与背景）
                <em className="setup-check-path">{info?.dataDir ?? ''}</em>
              </span>
            </label>

            {!keepUserData && (
              <div className="setup-warn">
                取消勾选后，上述目录会被<b>永久删除</b>，无法恢复。
              </div>
            )}
            {error && <div className="setup-warn setup-warn-block">卸载失败：{error}</div>}
          </section>
        ) : (
          <section className="setup-panel">
            <h1 className="setup-title-lg">正在卸载</h1>
            <div className="setup-bar">
              <span className="setup-bar-indeterminate" />
            </div>
            <div className="setup-meta">
              <span>{status}</span>
            </div>
          </section>
        )}
      </main>

      <footer className="setup-actions">
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
      </footer>
    </div>
  )
}
