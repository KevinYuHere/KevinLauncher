import { useEffect, useState, type ReactElement } from 'react'
import type { InstallerInfo, InstallerProgress, InstallTarget } from '@shared/types'
import { directoriesOverlap } from '@shared/paths'
import { failureText, formatBytes } from '../format'
import { trialBuild } from '@shared/buildIdentity'
import { isNewerVersion } from '@shared/version'

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
  const [free, setFree] = useState<number | null>(null)
  const [step, setStep] = useState<Step>('location')
  const [progress, setProgress] = useState<InstallerProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.installerInfo().then((data) => {
      setInfo(data)
      setTarget(data.target)
      setDir(data.prefillDir)
      setDataDir(data.dataDir)
    }).catch((failure: unknown) => {
      setError(failureText(
        failure,
        '无法读取安装信息。请关闭安装程序后重新打开。若仍失败，请重新运行安装包。'
      ))
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
      await window.api.installerRun(dir, dataDir)
      setStep('done')
    } catch (e) {
      setError(failureText(
        e,
        '安装没有完成。请检查安装目录的写入权限和可用空间，然后重试。'
      ))
      setStep('location')
    }
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

  /** The data directory must not be the program directory (or inside it). */
  const overlap = !!dir && !!dataDir && directoriesOverlap(dir, dataDir)
  const insufficient = free !== null && info !== null && free < info.payloadSize

  return (
    <div className="setup">
      <Aurora />
      <div className="setup-drag" />

      <header className="setup-top">
        <img className="setup-logo" src="kevin-media://default/icon.png" alt="" />
        <div className="setup-brand">
          <div className="setup-brand-name">{trialBuild ? 'KevinLauncher 本地试用' : 'KevinLauncher'}</div>
          <div className="setup-brand-sub">
            {info
              ? `安装程序 · ${info.version}`
              : error
                ? '无法读取安装信息'
                : '正在读取安装信息…'}
          </div>
        </div>
        <button
          className="setup-close"
          title={
            step === 'progress'
              ? '安装进行中，无法关闭'
              : step === 'done'
                ? '关闭'
                : '取消安装'
          }
          aria-label={
            step === 'progress'
              ? '安装进行中，无法关闭'
              : step === 'done'
                ? '关闭安装程序'
                : '取消安装'
          }
          disabled={step === 'progress'}
          onClick={() => window.api.windowClose()}
        >
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
              {trialBuild
                ? '本地试用版会安装到独立目录，不会影响正式版。'
                : '将安装到下面的目录，并创建开始菜单与桌面快捷方式。'}
            </p>

            <div className="setup-field">
              <label className="setup-field-label">安装位置</label>
              <div className="setup-path">
                <input
                  value={dir}
                  spellCheck={false}
                  readOnly={trialBuild}
                  aria-label="安装位置"
                  onChange={(e) => setDir(e.target.value)}
                />
                <button
                  className="btn"
                  disabled={trialBuild}
                  aria-label="浏览安装位置"
                  onClick={() => void browse()}
                >
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
                  readOnly={trialBuild}
                  aria-label="用户数据目录"
                  onChange={(e) => setDataDir(e.target.value)}
                />
                <button
                  className="btn"
                  disabled={trialBuild}
                  aria-label="浏览用户数据目录"
                  onClick={() => void browseDataDir()}
                >
                  浏览…
                </button>
              </div>
            </div>
            <p className="setup-note">
              {trialBuild
                ? '本地试用版使用隔离的安装位置和数据目录，不能修改。'
                : '用户数据目录保存应用列表、使用时长、抽卡记录、图标与壁纸。建议放在安装目录之外。重装时选择同一目录即可继续使用。'}
            </p>

            {target?.isInstalled && (
              <div className="setup-note">
                检测到已安装 <b>{target.version ?? '旧版本'}</b>，将<b>覆盖安装</b>并<b>保留全部用户数据</b>。
                {target.version && info && isNewerVersion(target.version, info.version) && (
                  <div className="setup-warn">注意：本机已安装的版本更高，继续会降级安装。</div>
                )}
              </div>
            )}
            {target && target.exists && !target.isInstalled && (
              <div className="setup-warn">
                目标目录不是 KevinLauncher 安装目录，当前已有 {target.fileCount} 个文件。继续会覆盖同名文件，请确认没有需要保留的内容。
              </div>
            )}
            {info?.running.length ? (
              <div className="setup-note">
                检测到正在运行的 KevinLauncher：{info.running[0]}。安装前会自动关闭它。
              </div>
            ) : null}

            {overlap && (
              <div className="setup-warn">
                用户数据目录不能与安装目录相同，也不能互相包含——请修改其中一个目录。
              </div>
            )}

            <div className="setup-meta">
              <span>
                {info ? `安装文件约 ${formatBytes(info.payloadSize)}` : '正在计算安装大小…'}
              </span>
              <span>{free === null ? '可用空间未知' : `可用空间 ${formatBytes(free)}`}</span>
            </div>
            {insufficient && info && (
              <div className="setup-warn">
                可用空间不足：安装文件约需 {formatBytes(info.payloadSize)}，请更换安装位置或清理磁盘后再继续。
              </div>
            )}
          </section>
        )}

        {step === 'confirm' && (
          <section className="setup-panel">
            <h1 className="setup-title-lg">确认安装</h1>
            <p className="setup-sub">确认后会自动完成以下操作，无需其他选择。</p>
            <ul className="setup-list">
              <li>
                <span>安装到</span>
                <em>{dir}</em>
              </li>
              {!trialBuild && <>
                <li>
                  <span>开始菜单快捷方式</span>
                  <em>创建</em>
                </li>
                <li>
                  <span>桌面快捷方式</span>
                  <em>创建</em>
                </li>
                <li>
                  <span>Windows 卸载入口</span>
                  <em>写入「设置 → 应用」</em>
                </li>
                <li>
                  <span>开机自启</span>
                  <em>默认开启</em>
                </li>
              </>}
              <li>
                <span>用户数据</span>
                <em>{dataDir || info?.dataDir}</em>
              </li>
            </ul>
            {!trialBuild && (
              <p className="setup-note">
                开机自启会以计划任务在 Windows 登录后启动启动器，可随时在启动器设置中关闭。
              </p>
            )}
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

        {error && <div className="setup-warn setup-warn-block" role="alert">{error}</div>}
      </main>

      <footer className="setup-actions">
        {step === 'location' && (
          <>
            <button className="btn" onClick={() => window.api.windowClose()}>
              取消
            </button>
            <button
              className="btn primary"
              disabled={!dir || overlap}
              onClick={() => setStep('confirm')}
            >
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
