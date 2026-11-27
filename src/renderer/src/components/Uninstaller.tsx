import { useEffect, useState, type ReactElement } from 'react'
import type { UninstallerInfo } from '@shared/types'
import { failureText, formatBytes } from '../format'

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
    void window.api.uninstallerInfo().then(setInfo).catch((failure: unknown) => {
      setError(failureText(
        failure,
        '无法读取卸载信息。请关闭卸载程序后重新打开。若仍失败，请从开始菜单再次运行卸载。'
      ))
    })
    return window.api.onUninstallerProgress((progress) => setStatus(progress.step))
  }, [])

  const run = async (): Promise<void> => {
    setError(null)
    setStep('progress')
    setStatus('正在准备…')
    try {
      await window.api.uninstallerRun(keepUserData)
    } catch (e) {
      setError(failureText(
        e,
        '卸载没有完成。请先退出启动器和文件管理器，再重试。不要手动删除安装目录。'
      ))
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
            {info
              ? `卸载程序 · ${info.version}`
              : error
                ? '无法读取卸载信息'
                : '正在读取卸载信息…'}
          </div>
        </div>
        <button
          className="setup-close"
          title={step === 'progress' ? '卸载进行中，无法关闭' : '关闭卸载程序'}
          aria-label={step === 'progress' ? '卸载进行中，无法关闭' : '关闭卸载程序'}
          disabled={step === 'progress'}
          onClick={() => window.api.windowClose()}
        >
          ✕
        </button>
      </header>

      <main className="setup-main">
        {step === 'confirm' ? (
          <section className="setup-panel">
            <h1 className="setup-title-lg">卸载 KevinLauncher</h1>
            <p className="setup-sub">
              将移除程序、快捷方式、Windows 卸载入口和开机自启设置。安装目录中你自己添加的文件会保留。
            </p>

            <ul className="setup-list">
              <li>
                <span>安装位置</span>
                <em>{info?.installDir ?? '…'}</em>
              </li>
              <li>
                <span>安装目录占用</span>
                <em>{info ? formatBytes(info.installSize) : '正在计算…'}</em>
              </li>
            </ul>

            <label className="setup-check">
              <input
                type="checkbox"
                checked={keepUserData}
                onChange={(e) => setKeepUserData(e.target.checked)}
              />
              <span>
                保留用户数据{info
                  ? `（${formatBytes(info.dataSize)}，含应用列表、使用时长、抽卡记录、图标与壁纸）`
                  : '（正在计算大小…）'}
                {info && <em className="setup-check-path">{info.dataDir}</em>}
              </span>
            </label>
            <p className="setup-note">默认保留。重新安装后可继续使用这些数据。</p>

            {!keepUserData && (
              <div className="setup-warn">
                取消勾选后，这个用户数据目录会被<b>永久删除</b>，无法恢复。
              </div>
            )}
            {error && <div className="setup-warn setup-warn-block" role="alert">{error}</div>}
          </section>
        ) : (
          <section className="setup-panel">
            <h1 className="setup-title-lg">正在卸载</h1>
            <p className="setup-sub">请不要关闭此窗口。移交完成后程序会自动退出。</p>
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
            <button className="btn danger" disabled={!info} onClick={() => void run()}>
              确认卸载
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
