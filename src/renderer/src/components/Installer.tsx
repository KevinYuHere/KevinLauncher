import { useEffect, useState, type ReactElement } from 'react'
import type { InstallerInfo, InstallerProgress, InstallTarget } from '@shared/types'
import { formatBytes } from '../format'

type Step = 'location' | 'confirm' | 'progress' | 'done'

/**
 * Self-drawn installer (the app running in "install mode": the portable
 * `KevinLauncher-Installer-<version>.exe`, see docs/INSTALLER.md).
 *
 * A full-window page — not a dialog — with an animated aurora background built
 * from the theme colour and a plain theme-coloured progress bar (the ring is
 * reserved for in-app upgrades).
 */
export default function Installer(): ReactElement | null {
  const [info, setInfo] = useState<InstallerInfo | null>(null)
  const [dir, setDir] = useState('')
  const [dataDir, setDataDir] = useState('')
  const [target, setTarget] = useState<InstallTarget | null>(null)
  const [free, setFree] = useState(0)
  const [step, setStep] = useState<Step>('location')
  const [progress, setProgress] = useState<InstallerProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [elevating, setElevating] = useState(false)

  useEffect(() => {
    void window.api.installerInfo().then((data) => {
      setInfo(data)
      setTarget(data.target)
      setDir(data.prefillDir)
      setDataDir(data.dataDir)
    })
    return window.api.onInstallerProgress(setProgress)
  }, [])

  useEffect(() => {
    if (!dir) return
    let cancelled = false
    void window.api.installerInspect(dir).then((value) => !cancelled && setTarget(value))
    void window.api.installerFreeSpace(dir).then((value) => !cancelled && setFree(value))
    return () => {
      cancelled = true
    }
  }, [dir])

  const browse = async (): Promise<void> => {
    const picked = await window.api.installerPickDirectory(dir)
    if (picked) setDir(await window.api.installerNormalize(picked))
  }

  const browseDataDir = async (): Promise<void> => {
    const picked = await window.api.dataDirPick(dataDir)
    if (picked) setDataDir(picked)
  }

  const start = async (): Promise<void> => {
    setError(null)
    setStep('progress')
    try {
      const done = await window.api.installerRun(dir, dataDir)
      // `false` means the installer restarted itself elevated (UAC) and this
      // process is about to exit.
      if (done) setStep('done')
      else setElevating(true)
    } catch (e) {
      setError((e as Error).message)
      setStep('location')
    }
  }

  if (elevating) {
    return (
      <div className="setup">
        <Aurora />
        <div className="setup-center">
          <div className="setup-title-lg">正在请求管理员权限…</div>
          <div className="setup-sub">允许后安装将继续进行</div>
        </div>
      </div>
    )
  }

  const percent =
    progress && progress.total > 0
      ? Math.min(100, (progress.done / progress.total) * 100)
      : progress?.phase === 'shortcuts'
        ? 100
        : 0

  const steps: { id: Step; label: string }[] = [
    { id: 'location', label: '选择位置' },
    { id: 'confirm', label: '确认' },
    { id: 'progress', label: '安装' }
  ]

  return (
    <div className="setup">
      <Aurora />
      <div className="setup-drag" />

      <header className="setup-top">
        <img className="setup-logo" src="kevin-media://default/icon.png" alt="" />
        <div className="setup-brand">
          <div className="setup-brand-name">KevinLauncher</div>
          <div className="setup-brand-sub">
            {info ? `安装程序 · ${info.version}` : '正在读取安装信息…'}
          </div>
        </div>
        <button className="setup-close" title="取消安装" onClick={() => window.api.windowClose()}>
          ✕
        </button>
      </header>

      <main className="setup-main">
        <div className="setup-steps">
          {steps.map((entry, index) => (
            <div
              key={entry.id}
              className={`setup-step${
                step === entry.id ? ' active' : index < steps.findIndex((s) => s.id === step) ? ' done' : ''
              }`}
            >
              <span>{index + 1}</span>
              {entry.label}
            </div>
          ))}
        </div>

        {step === 'location' && (
          <section className="setup-panel">
            <h1 className="setup-title-lg">选择安装位置</h1>
            <p className="setup-sub">
              将安装到下面的目录，并创建开始菜单与桌面快捷方式。
            </p>

            <div className="setup-field">
              <label className="setup-field-label">安装位置</label>
              <div className="setup-path">
                <input value={dir} spellCheck={false} onChange={(e) => setDir(e.target.value)} />
                <button className="btn" onClick={() => void browse()}>
                  浏览…
                </button>
              </div>
            </div>

            <div className="setup-field">
              <label className="setup-field-label">用户数据目录</label>
              <div className="setup-path">
                <input
                  value={dataDir}
                  spellCheck={false}
                  onChange={(e) => setDataDir(e.target.value)}
                />
                <button className="btn" onClick={() => void browseDataDir()}>
                  浏览…
                </button>
              </div>
            </div>

            {target?.isInstalled && (
              <div className="setup-note">
                检测到已安装 <b>{target.version ?? '旧版本'}</b>
                ，将<b>覆盖安装</b>并<b>保留全部用户数据</b>。
                {target.version && info && compare(target.version, info.version) > 0 && (
                  <div className="setup-warn">注意：本机版本更高，这是降级安装。</div>
                )}
              </div>
            )}
            {target && target.exists && !target.isInstalled && (
              <div className="setup-warn">
                该目录已存在且不是 KevinLauncher 安装目录，将直接写入其中（{target.fileCount} 个文件）。
              </div>
            )}
            {info?.running.length ? (
              <div className="setup-note">
                检测到正在运行的 KevinLauncher（{info.running[0]}），安装前会自动关闭。
              </div>
            ) : null}

            <div className="setup-meta">
              <span>需要约 {formatBytes(info?.payloadSize ?? 0)}</span>
              <span>可用 {formatBytes(free)}</span>
            </div>
          </section>
        )}

        {step === 'confirm' && (
          <section className="setup-panel">
            <h1 className="setup-title-lg">确认安装</h1>
            <p className="setup-sub">以下内容将自动完成，无需其他选择。</p>
            <ul className="setup-list">
              <li>
                <span>安装到</span>
                <em>{dir}</em>
              </li>
              <li>
                <span>开始菜单快捷方式</span>
                <em>创建</em>
              </li>
              <li>
                <span>桌面快捷方式</span>
                <em>创建</em>
              </li>
              <li>
                <span>卸载入口</span>
                <em>写入</em>
              </li>
              <li>
                <span>开机自启</span>
                <em>默认开启</em>
              </li>
              <li>
                <span>用户数据</span>
                <em>{dataDir || info?.dataDir}</em>
              </li>
            </ul>
          </section>
        )}

        {step === 'progress' && (
          <section className="setup-panel">
            <h1 className="setup-title-lg">
              {progress?.phase === 'shortcuts' ? '正在创建快捷方式' : '正在安装'}
            </h1>
            <div className="setup-bar">
              <span style={{ width: `${percent}%` }} />
            </div>
            <div className="setup-meta">
              <span className="setup-current">{progress?.current ?? ''}</span>
              <span>
                {progress && progress.total > 0
                  ? `${formatBytes(progress.done)} / ${formatBytes(progress.total)}`
                  : `${Math.round(percent)}%`}
              </span>
            </div>
          </section>
        )}

        {step === 'done' && (
          <section className="setup-panel">
            <h1 className="setup-title-lg">安装完成</h1>
            <p className="setup-sub">
              KevinLauncher {info?.version} 已安装到 <b>{dir}</b>。
            </p>
          </section>
        )}

        {error && <div className="setup-warn setup-warn-block">安装失败：{error}</div>}
      </main>

      <footer className="setup-actions">
        {step === 'location' && (
          <>
            <button className="btn" onClick={() => window.api.windowClose()}>
              取消
            </button>
            <button className="btn primary" disabled={!dir} onClick={() => setStep('confirm')}>
              下一步
            </button>
          </>
        )}
        {step === 'confirm' && (
          <>
            <button className="btn" onClick={() => setStep('location')}>
              返回
            </button>
            <button className="btn primary" onClick={() => void start()}>
              开始安装
            </button>
          </>
        )}
        {step === 'progress' && (
          <button className="btn" disabled>
            安装中…
          </button>
        )}
        {step === 'done' && (
          <>
            <button className="btn" onClick={() => window.api.windowClose()}>
              关闭
            </button>
            <button className="btn primary" onClick={() => void window.api.installerLaunch(dir)}>
              立即启动
            </button>
          </>
        )}
      </footer>
    </div>
  )
}

/** Animated aurora built from the theme colour (brand + two complements). */
function Aurora(): ReactElement {
  return (
    <div className="setup-aurora" aria-hidden="true">
      <span className="aurora-a" />
      <span className="aurora-b" />
      <span className="aurora-c" />
      <div className="setup-grid" />
    </div>
  )
}

/** Minimal dotted comparator (only used to warn about a downgrade). */
function compare(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}
