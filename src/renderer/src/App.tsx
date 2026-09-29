import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type {
  AddonDescriptor,
  AppEntry,
  LauncherSettings,
  NewAppEntry,
  RunningApp,
  UpdateInfo,
  UpdateStatus
} from '@shared/types'
import Rail from './components/Rail'
import GamesRow from './components/GamesRow'
import WindowControls from './components/WindowControls'
import Icon from './components/Icon'
import HomeView from './components/HomeView'
import GachaView from './components/GachaView'
import UpdateView from './components/UpdateView'
import SettingsView from './components/SettingsView'
import GalleryView from './components/GalleryView'
import PlayTimeView from './components/PlayTimeView'
import AppFormDialog, { type AppFormMedia } from './components/AppFormDialog'
import { ConfirmHost, confirm } from './components/confirm'
import IconCropper from './components/IconCropper'
import type { ViewId } from './viewTypes'
import { backgroundUrl, brandUrl, defaultIconUrl, VIDEO_RE } from './media'
import { applyTheme } from './theme'

type DialogState = { mode: 'add' } | { mode: 'edit'; entry: AppEntry } | null

export default function App(): ReactElement {
  const [apps, setApps] = useState<AppEntry[]>([])
  const [running, setRunning] = useState<RunningApp[]>([])
  const [addons, setAddons] = useState<AddonDescriptor[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [view, setView] = useState<ViewId>('home')
  const [dialog, setDialog] = useState<DialogState>(null)
  const [totals, setTotals] = useState<Record<string, number>>({})
  const [updateInfos, setUpdateInfos] = useState<Record<string, UpdateInfo>>({})
  const [updateStatuses, setUpdateStatuses] = useState<Record<string, UpdateStatus>>({})
  const [toast, setToast] = useState<string | null>(null)
  const [gamesHidden, setGamesHidden] = useState(false)
  const [peeking, setPeeking] = useState(false)
  const [bgDisplay, setBgDisplay] = useState<{
    src: string
    kind: 'image' | 'video'
    blur: number
    dim: number
  } | null>(null)
  const bgSaveTimer = useRef<number | undefined>(undefined)
  const [launcherSettings, setLauncherSettings] = useState<LauncherSettings>({
    iconFile: null,
    fontFamily: null,
    closeAction: 'close',
    afterLaunch: 'none'
  })
  const [fonts, setFonts] = useState<string[]>([])
  const [version, setVersion] = useState('')
  const [cropSrc, setCropSrc] = useState<string | null>(null)
  const cropResolver = useRef<((value: string | null) => void) | null>(null)
  const [appsLoaded, setAppsLoaded] = useState(false)
  const [gachaNotice, setGachaNotice] = useState<{
    name: string
    bannerName: string
    page: number
  } | null>(null)
  const animRef = useRef<HTMLDivElement>(null)
  const prevViewRef = useRef<ViewId>('home')
  const checkedUpdates = useRef<Set<string>>(new Set())

  const refreshApps = useCallback(async (): Promise<void> => {
    setApps(await window.api.listApps())
  }, [])
  const refreshRunning = useCallback(async (): Promise<void> => {
    setRunning(await window.api.listRunning())
  }, [])
  const refreshTotals = useCallback(async (): Promise<void> => {
    setTotals(await window.api.playTimeTotals())
  }, [])

  const handleReorder = useCallback(async (ids: string[]): Promise<void> => {
    setApps(await window.api.reorderApps(ids))
  }, [])

  const toggleGames = useCallback(async (): Promise<void> => {
    const next = !gamesHidden
    setPeeking(false)
    setGamesHidden(next)
    await window.api.setGamesRowHidden(next)
  }, [gamesHidden])

  useEffect(() => {
    void (async (): Promise<void> => {
      setAddons(await window.api.listAddons())
      setGamesHidden((await window.api.getUiPrefs()).gamesRowHidden)
      await refreshApps()
      await refreshRunning()
      await refreshTotals()
      setAppsLoaded(true)
    })()
    const offApps = window.api.onAppsChanged(() => void refreshApps())
    const offRunning = window.api.onRunningChanged(() => void refreshRunning())
    const offPlayTime = window.api.onPlayTimeChanged(() => void refreshTotals())
    return () => {
      offApps()
      offRunning()
      offPlayTime()
    }
  }, [refreshApps, refreshRunning, refreshTotals])

  useEffect(() => {
    void window.api.getLauncherSettings().then(setLauncherSettings)
    void window.api.listFonts().then(setFonts)
    void window.api.appVersion().then(setVersion)
    return window.api.onLauncherChanged(() =>
      void window.api.getLauncherSettings().then(setLauncherSettings)
    )
  }, [])

  useEffect(() => {
    const root = document.documentElement
    if (launcherSettings.fontFamily) {
      root.style.setProperty('--app-font', `"${launcherSettings.fontFamily}"`)
    } else {
      root.style.removeProperty('--app-font')
    }
  }, [launcherSettings.fontFamily])

  // Non-blocking gacha fetch notification (survives page switches).
  useEffect(() => {
    return window.api.onGachaProgress((progress) => {
      if (progress.phase === 'done') {
        setGachaNotice(null)
        return
      }
      const app = apps.find((a) => a.id === progress.appId)
      setGachaNotice({
        name: app?.name ?? '',
        bannerName: progress.bannerName ?? '',
        page: progress.page ?? 1
      })
    })
  }, [apps])

  useEffect(() => {
    if (apps.length === 0) {
      setCurrentId(null)
      return
    }
    if (!currentId || !apps.some((a) => a.id === currentId)) setCurrentId(apps[0].id)
  }, [apps, currentId])

  const current = useMemo(() => apps.find((a) => a.id === currentId) ?? null, [apps, currentId])
  const currentAddon = useMemo(
    () => (current ? addons.find((a) => a.id === current.addonId) : undefined),
    [current, addons]
  )
  const currentRunning = useMemo(
    () => (current ? running.find((r) => r.appId === current.id) : undefined),
    [current, running]
  )

  const showToast = useCallback((message: string): void => {
    setToast(message)
    window.setTimeout(() => setToast(null), 3200)
  }, [])

  // When switching games, keep the current page if the new game supports it;
  // otherwise fall back to the home page.
  useEffect(() => {
    if (!current) return
    const caps = currentAddon?.capabilities
    if ((view === 'gacha' && !caps?.gacha) || (view === 'update' && !caps?.update)) {
      setView('home')
    }
  }, [current, currentAddon, view])

  const checkUpdate = useCallback(async (appId: string): Promise<void> => {
    try {
      const info = await window.api.updateInfo(appId)
      setUpdateInfos((prev) => ({ ...prev, [appId]: info }))
    } catch {
      /* ignore update check errors */
    }
  }, [])

  // On startup (and whenever the app list changes), check every supported game
  // for updates in the background.
  useEffect(() => {
    for (const app of apps) {
      if (!app.addonId) continue
      if (checkedUpdates.current.has(app.id)) continue
      checkedUpdates.current.add(app.id)
      void checkUpdate(app.id)
    }
  }, [apps, checkUpdate])

  const applyMedia = useCallback(
    async (appId: string, media: AppFormMedia): Promise<void> => {
      if (media.iconSource) {
        if (media.iconSource.startsWith('data:')) await window.api.setIconData(appId, media.iconSource)
        else await window.api.setIcon(appId, media.iconSource)
      } else if (media.clearIcon) {
        await window.api.resetIcon(appId)
      }
      if (media.backgroundSource) await window.api.setBackground(appId, media.backgroundSource)
      else if (media.clearBackground) await window.api.setBackground(appId, null)
    },
    []
  )

  const handleSubmit = useCallback(
    async (input: NewAppEntry, media: AppFormMedia): Promise<void> => {
      if (dialog?.mode === 'edit') {
        const entry = dialog.entry
        await window.api.updateApp({
          ...entry,
          name: input.name,
          moduleLabel: input.moduleLabel ?? null,
          targetPath: input.targetPath,
          arguments: input.arguments ?? '',
          workingDirectory: input.workingDirectory ?? '',
          gameDirectory: input.gameDirectory ?? entry.gameDirectory,
          runAsAdmin: input.runAsAdmin ?? entry.runAsAdmin,
          addonId: input.addonId ?? null,
          screenshotDirectory: input.screenshotDirectory ?? null,
          monitorProcessNames: input.monitorProcessNames ?? []
        })
        await applyMedia(entry.id, media)
        showToast('已保存')
      } else {
        const created = await window.api.addApp(input)
        await applyMedia(created.id, media)
        setCurrentId(created.id)
        setView('home')
        showToast('应用已添加')
      }
      setDialog(null)
    },
    [dialog, applyMedia, showToast]
  )

  const handleLaunch = useCallback(
    async (id: string): Promise<void> => {
      const result = await window.api.launchApp(id)
      if (!result.ok) {
        showToast(`启动失败：${result.error ?? '未知错误'}`)
        return
      }
      if (result.message) showToast(result.message)
      const action = launcherSettings.afterLaunch
      if (action === 'minimize') await window.api.windowMinimize()
      else if (action === 'tray') await window.api.hideToTray()
      else if (action === 'close') await window.api.windowClose()
    },
    [showToast, launcherSettings.afterLaunch]
  )

  const handleStop = useCallback(
    async (id: string): Promise<void> => {
      const result = await window.api.stopApp(id)
      showToast(result.killed > 0 ? `已停止（结束 ${result.killed} 个进程）` : '已停止')
    },
    [showToast]
  )

  // Live update/download progress (feeds the home-screen controls).
  useEffect(() => {
    return window.api.onUpdateProgress((status) => {
      setUpdateStatuses((prev) => ({ ...prev, [status.appId]: status }))
    })
  }, [])

  useEffect(() => {
    if (!currentId) return
    void window.api.updateStatus(currentId).then((status) => {
      setUpdateStatuses((prev) => ({ ...prev, [currentId]: status }))
    })
  }, [currentId])

  const handleUpdate = useCallback(
    async (id: string, mode: 'update' | 'preDownload'): Promise<void> => {
      const status = updateStatuses[id]
      if (status && (status.phase === 'downloading' || status.phase === 'extracting')) {
        await window.api.updateCancel(id)
        return
      }
      try {
        await window.api.updateStart(id, mode)
      } catch (error) {
        const label = mode === 'preDownload' ? '预下载' : '更新'
        showToast(`${label}失败：${(error as Error).message}`)
      }
    },
    [updateStatuses, showToast]
  )

  const handleRemove = useCallback(
    async (entry: AppEntry): Promise<void> => {
      if (!(await confirm(`确定移除「${entry.name}」吗？`))) return
      await window.api.removeApp(entry.id)
      setView('home')
      showToast('已移除')
    },
    [showToast]
  )

  const cropIcon = useCallback(async (): Promise<{ dataUrl: string; sourcePath: string } | null> => {
    const picked = await window.api.pickIconSource()
    if (!picked) return null
    const dataUrl = await new Promise<string | null>((resolve) => {
      cropResolver.current = resolve
      setCropSrc(picked.dataUrl)
    })
    return dataUrl ? { dataUrl, sourcePath: picked.path } : null
  }, [])

  const finishCrop = useCallback((result: string | null): void => {
    setCropSrc(null)
    const resolve = cropResolver.current
    cropResolver.current = null
    resolve?.(result)
  }, [])

  const pickAndSet = useCallback(
    async (appId: string, kind: 'icon' | 'background'): Promise<void> => {
      if (kind === 'icon') {
        const res = await cropIcon()
        if (res) await window.api.setIconData(appId, res.dataUrl)
        return
      }
      const source = await window.api.pickBackground()
      if (source) await window.api.setBackground(appId, source)
    },
    [cropIcon]
  )

  const pickLauncherIcon = useCallback(async (): Promise<void> => {
    const res = await cropIcon()
    if (res) setLauncherSettings(await window.api.setLauncherIcon(res.dataUrl))
  }, [cropIcon])

  const clearLauncherIcon = useCallback(async (): Promise<void> => {
    setLauncherSettings(await window.api.setLauncherIcon(null))
  }, [])

  const setLauncherFont = useCallback(async (family: string | null): Promise<void> => {
    setLauncherSettings(await window.api.setLauncherFont(family))
  }, [])

  const exportData = useCallback(async (): Promise<void> => {
    try {
      const path = await window.api.exportData()
      if (path) showToast(`已导出到 ${path}`)
    } catch (error) {
      showToast(`导出失败：${(error as Error).message}`)
    }
  }, [showToast])

  const importData = useCallback(async (): Promise<void> => {
    if (
      !(await confirm('导入会覆盖当前全部设置（应用、使用时长、抽卡记录、图标、背景），确定继续？'))
    ) {
      return
    }
    try {
      const result = await window.api.importData()
      if (result) showToast(`已导入（${result.apps} 个应用）`)
    } catch (error) {
      showToast(`导入失败：${(error as Error).message}`)
    }
  }, [showToast])

  const renderSubView = (entry: AppEntry): ReactElement => {
    const back = (): void => setView('home')
    if (view === 'playtime') {
      return <PlayTimeView entry={entry} onBack={back} />
    }
    if (view === 'gacha') {
      return (
        <GachaView
          entry={entry}
          addon={addons.find((a) => a.id === entry.addonId)}
          onBack={back}
          onToast={showToast}
          updating={gachaNotice !== null}
        />
      )
    }
    if (view === 'gallery') {
      return (
        <GalleryView entry={entry} onBack={back} onEdit={() => setDialog({ mode: 'edit', entry })} />
      )
    }
    if (view === 'update') {
      return (
        <UpdateView
          entry={entry}
          info={updateInfos[entry.id]}
          onChecked={(info) => setUpdateInfos((prev) => ({ ...prev, [entry.id]: info }))}
          onBack={back}
          onToast={showToast}
        />
      )
    }
    return (
      <SettingsView
        entry={entry}
        onBack={back}
        onEdit={() => setDialog({ mode: 'edit', entry })}
        onPickBackground={() => void pickAndSet(entry.id, 'background')}
        onRemove={() => void handleRemove(entry)}
        bgBlur={bgDisplay?.blur ?? entry.backgroundBlur ?? 0}
        bgDim={bgDisplay?.dim ?? entry.backgroundDim ?? 100}
        onBgTuning={handleBgTuning}
        onResetBackground={() => void window.api.resetBackground(entry.id)}
        launcher={launcherSettings}
        fonts={fonts}
        version={version}
        onPickLauncherIcon={() => void pickLauncherIcon()}
        onClearLauncherIcon={() => void clearLauncherIcon()}
        onSetFont={(family) => void setLauncherFont(family)}
        onSetBehavior={(patch) =>
          void window.api.setLauncherBehavior(patch).then(setLauncherSettings)
        }
        onExportData={() => void exportData()}
        onImportData={() => void importData()}
      />
    )
  }

  const bg = backgroundUrl(current?.backgroundFile ?? null)
  const isVideo = current?.backgroundFile ? VIDEO_RE.test(current.backgroundFile) : false
  const dialogEntry = dialog?.mode === 'edit' ? dialog.entry : null

  useEffect(() => {
    applyTheme(current?.themeColor ?? null)
  }, [current?.themeColor])

  // Swap the background only once the incoming image has decoded, carrying the
  // new game's blur / dim with it. The previous background (with its own blur)
  // stays on screen until then, so switching games never flashes a sharp frame.
  useEffect(() => {
    if (!bg) {
      setBgDisplay(null)
      return
    }
    const blur = current?.backgroundBlur ?? 0
    const dim = current?.backgroundDim ?? 100
    const commit = (): void => setBgDisplay({ src: bg, kind: isVideo ? 'video' : 'image', blur, dim })
    if (isVideo) {
      commit()
      return
    }
    let cancelled = false
    const image = new Image()
    image.onload = () => {
      if (!cancelled) commit()
    }
    image.onerror = () => {
      if (!cancelled) commit()
    }
    image.src = bg
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bg, isVideo, current?.id])

  // Live background tuning from the settings sliders: update instantly, persist
  // debounced.
  const handleBgTuning = useCallback(
    (blur: number, dim: number): void => {
      setBgDisplay((prev) => (prev ? { ...prev, blur, dim } : prev))
      if (bgSaveTimer.current) window.clearTimeout(bgSaveTimer.current)
      const id = current?.id
      bgSaveTimer.current = window.setTimeout(() => {
        if (id) void window.api.setBgTuning(id, { blur, dim })
      }, 180)
    },
    [current?.id]
  )

  useEffect(() => {
    document.documentElement.classList.toggle(
      'glass-light',
      (current?.glassStyle ?? 'dark') === 'light'
    )
  }, [current?.glassStyle])

  // Retrigger the transition on view / app change. The background lives inside
  // this animated element so backdrop-filter keeps blurring during the animation.
  useEffect(() => {
    const el = animRef.current
    if (!el) return
    const order: ViewId[] = ['home', 'playtime', 'gacha', 'gallery', 'update', 'settings']
    const direction = order.indexOf(view) >= order.indexOf(prevViewRef.current) ? 1 : -1
    prevViewRef.current = view
    el.style.setProperty('--anim-x', `${direction * 26}px`)
    el.classList.remove('app-anim-run')
    void el.offsetWidth
    el.classList.add('app-anim-run')
  }, [view, currentId])

  return (
    <div className="app">
      <div className="app-anim" ref={animRef}>
      {bgDisplay && bgDisplay.kind === 'image' && (
        <img
          key={bgDisplay.src}
          className="bg-layer"
          src={bgDisplay.src}
          alt=""
          style={bgDisplay.blur > 0 ? { filter: `blur(${bgDisplay.blur}px)` } : undefined}
        />
      )}
      {bgDisplay && bgDisplay.kind === 'video' && (
        <video
          key={bgDisplay.src}
          className="bg-layer"
          src={bgDisplay.src}
          autoPlay
          muted
          loop
          playsInline
          style={bgDisplay.blur > 0 ? { filter: `blur(${bgDisplay.blur}px)` } : undefined}
        />
      )}
      <div className="bg-scrim" style={{ opacity: bgDisplay ? bgDisplay.dim / 100 : 1 }} />
      {bgDisplay && <div className="bg-dim" style={{ opacity: (bgDisplay.dim / 100) * 0.7 }} />}

      <Rail
        view={view}
        onNavigate={setView}
        showGacha={!!currentAddon?.capabilities.gacha}
        showUpdate={!!currentAddon?.capabilities.update}
      />

      <div className="topbar">
        <div
          className={`games-wrap${gamesHidden && !peeking ? ' collapsed' : ''}`}
          onMouseEnter={() => {
            if (gamesHidden) setPeeking(true)
          }}
          onMouseLeave={() => {
            if (gamesHidden) setPeeking(false)
          }}
        >
          <div className={`games-collapser${!gamesHidden || peeking ? '' : ' collapsed'}`}>
            <GamesRow
              apps={apps}
              currentId={currentId}
              onSelect={(id) => setCurrentId(id)}
              onAdd={() => setDialog({ mode: 'add' })}
              onReorder={(ids) => void handleReorder(ids)}
            />
          </div>
          <button
            className="games-toggle"
            title={gamesHidden ? '固定展开游戏栏' : '收起游戏栏'}
            onClick={() => void toggleGames()}
          >
            <Icon name={gamesHidden ? 'chevronRight' : 'chevronLeft'} size={18} />
          </button>
        </div>
        <div className="topbar-drag" />
        <WindowControls />
      </div>

      <main className="stage">
          {!appsLoaded ? null : !current ? (
            <div className="welcome glass">
              <div className="welcome-logo">
                <img
                  src={
                    launcherSettings.iconFile
                      ? (brandUrl(launcherSettings.iconFile) ?? '')
                      : defaultIconUrl()
                  }
                  alt=""
                />
              </div>
              <h2>KevinLauncher</h2>
              <p>还没有任何应用。添加任意 exe / bat / 脚本或其它启动器。</p>
              <button className="start-btn" onClick={() => setDialog({ mode: 'add' })}>
                添加应用
              </button>
            </div>
          ) : view === 'home' ? (
            <HomeView
              entry={current}
              addon={currentAddon}
              running={!!currentRunning}
              startedAt={currentRunning?.startedAt}
              totalSec={totals[current.id] ?? 0}
              updateInfo={updateInfos[current.id]}
              updateStatus={updateStatuses[current.id] ?? null}
              onLaunch={() => void handleLaunch(current.id)}
              onStop={() => void handleStop(current.id)}
              onUpdateToggle={() => void handleUpdate(current.id, 'update')}
              onPreDownloadToggle={() => void handleUpdate(current.id, 'preDownload')}
              onShowStats={() => setView('playtime')}
            />
          ) : (
            renderSubView(current)
          )}
      </main>
      </div>

      {dialog && (
        <AppFormDialog
          addons={addons}
          initial={dialogEntry}
          onClose={() => setDialog(null)}
          onSubmit={handleSubmit}
          pickIconCropped={cropIcon}
        />
      )}

      {cropSrc && (
        <IconCropper
          key={cropSrc}
          source={cropSrc}
          onCancel={() => finishCrop(null)}
          onConfirm={(dataUrl) => finishCrop(dataUrl)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}

      <ConfirmHost />

      {gachaNotice && (
        <div className="gacha-toast">
          <span className="gacha-toast-spinner" />
          {`正在获取${gachaNotice.name ? `「${gachaNotice.name}」` : ''} ${gachaNotice.bannerName} 第 ${gachaNotice.page} 页…`}
        </div>
      )}
    </div>
  )
}
