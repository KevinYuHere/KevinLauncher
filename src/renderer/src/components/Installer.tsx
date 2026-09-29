import { useEffect, useState, type ReactElement } from 'react'
import type { InstallerInfo, InstallerProgress, InstallTarget } from '@shared/types'
import { formatBytes } from '../format'

type Step = 'location' | 'confirm' | 'progress' | 'done'

/**
 * Self-drawn installer UI (it is the app itself running in "install mode", see
 * docs/INSTALLER.md). Three pages — location, confirmation, progress — with a
 * plain theme-coloured progress bar (the ring is reserved for in-app upgrades).
 */
export default function Installer(): ReactElement {
  const [info, setInfo] = useState<InstallerInfo | null>(null)
  const [dir, setDir] = useState('')
  const [target, setTarget] = useState<InstallTarget | null>(null)
  const [free, setFree] = useState(0)
  const [step, setStep] = useState<Step>('location')
  const [progress, setProgress] = useState<InstallerProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.installerInfo().then((data) => {
      setInfo(data)
      setTarget(data.target)
      const initial = data.detected?.dir ?? data.defaultDir
      setDir(initial)
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
    if (picked) setDir(picked)
  }

  const start = async (): Promise<void> => {
    setError(null)
    setStep('progress')
    try {
      await window.api.installerRun(dir)
      setStep('done')
    } catch (e) {
      setError((e as Error).message)
      setStep('location')
    }
  }

  const percent =
    progress && progress.total > 0
      ? Math.min(100, (progress.done / progress.total) * 100)
      : progress?.phase === 'shortcuts'
        ? 100
        : 0

  return (
    <div className="setup">
      <div className="setup-drag" />
      <div className="setup-card">
        <div className="setup-head">
          <img className="setup-logo" src="kevin-media://default/icon.png" alt="" />
          <div>
            <div className="setup-title">安装 KevinLauncher</div>
            <div className="setup-sub">
              {info ? `版本 ${info.version}` : '正在读取安装信息…'}
            </div>
          </div>
          <button
            className="setup-close"
            title="取消安装"
            onClick={() => window.api.windowClose()}
          >
            ✕
          </button>
        </div>

        <div className="setup-body">
          {step === 'location' && (
            <>
              <label className="setup-label">安装位置</label>
              <div className="setup-path">
                <input
                  value={dir}
                  spellCheck={false}
                  onChange={(e) => setDir(e.target.value)}
                />
                <button className="btn sm" onClick={() => void browse()}>
                  浏览…
                </button>
              </div>

              {info?.detected && target?.isInstalled && (
                <div className="setup-note">
                  检测到已安装 <b>{target.version ?? info.detected.version ?? '旧版本'}</b>
                  ，将<b>覆盖安装</b>到该目录，<b>保留全部用户数据</b>。
                  {target.version &&
                    info.version &&
                    compare(target.version, info.version) > 0 && (
                      <div className="setup-warn">
                        注意：本机版本高于该安装包，这是<b>降级</b>安装。
                      </div>
                    )}
                </div>
              )}
              {target && target.exists && !target.isInstalled && (
                <div className="setup-warn">
                  该目录已存在且不是 KevinLauncher 安装目录，将直接写入其中（{target.fileCount} 个文件）。
                </div>
              )}

              <div className="setup-meta">
                <span>需要约 {formatBytes(info?.payloadSize ?? 0)}</span>
                <span>可用 {formatBytes(free)}</span>
              </div>
            </>
          )}

          {step === 'confirm' && (
            <>
              <label className="setup-label">即将进行</label>
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
                  <em>写入（可在 Windows 设置中卸载）</em>
                </li>
                <li>
                  <span>开机自启</span>
                  <em>默认开启（计划任务，可在设置中关闭）</em>
                </li>
                <li>
                  <span>用户数据</span>
                  <em>保留（{info?.dataDir}）</em>
                </li>
              </ul>
            </>
          )}

          {step === 'progress' && (
            <>
              <label className="setup-label">
                {progress?.phase === 'shortcuts' ? '正在创建快捷方式…' : '正在安装…'}
              </label>
              <div className="setup-bar">
                <span style={{ width: `${percent}%` }} />
              </div>
              <div className="setup-meta">
                <span className="setup-current">{progress?.current ?? ''}</span>
                <span>
                  {progress && progress.total > 0
                    ? `${formatBytes(progress.done)} / ${formatBytes(progress.total)}`
                    : ''}
                </span>
              </div>
            </>
          )}

          {step === 'done' && (
            <>
              <label className="setup-label">安装完成</label>
              <div className="setup-note">
                KevinLauncher {info?.version} 已安装到 <b>{dir}</b>，开始菜单与桌面快捷方式已创建。
              </div>
            </>
          )}

          {error && <div className="setup-warn">安装失败：{error}</div>}
        </div>

        <div className="setup-foot">
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
          {step === 'progress' && <button className="btn" disabled>安装中…</button>}
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
        </div>
      </div>
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
