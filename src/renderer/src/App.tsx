import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type {
  AddonDescriptor,
  AppEntry,
  AppUpdateInfo,
  AppUpdateState,
  HomeModuleId,
  LauncherSettings,
  LaunchMethod,
  LinkedLaunch,
  NewAppEntry,
  RunningApp,
  UpdateInfo,
  UpdateStatus,
  UsageReport,
  WallpaperSettings
} from '@shared/types'
import { currentWallpaper, isVideoFile } from '@shared/appEntry'
import Rail from './components/Rail'
import GamesRow from './components/GamesRow'
import LinkedLaunchRow from './components/LinkedLaunchRow'
import WindowControls from './components/WindowControls'
import Icon from './components/Icon'
import HomeView from './components/HomeView'
import GachaView from './components/GachaView'
import UpdateView from './components/UpdateView'
import SettingsView from './components/SettingsView'
import ModuleManagerView from './components/ModuleManagerView'
import LinkedLaunchView from './components/LinkedLaunchView'
import LaunchTransition from './components/LaunchTransition'
import Toaster, { showToast } from './components/toast'
import { installPressJelly } from './drag/pressJelly'
import GalleryView from './components/GalleryView'
import PlayTimeView from './components/PlayTimeView'
import NewAppDialog from './components/NewAppDialog'
import AppUpdateDialog from './components/AppUpdateDialog'
import UpdateRing from './components/UpdateRing'
import { ConfirmHost, confirm } from './components/confirm'
import IconCropper from './components/IconCropper'
import type { ViewId } from './viewTypes'
import { backgroundUrl, brandUrl, defaultIconUrl, fileUrl } from './media'
import { directoriesOverlap } from '@shared/paths'
import { updateChromeContrast } from './contrast'
import { applyGlass, applyTheme } from './theme'
import { extractVideoAccent } from './videoAccent'
import { installWallpaperRegionUpdater, updateWallpaperRegions } from './wallpaperRegion'

/** Local calendar date as `YYYY-MM-DD` (used to run daily update checks). */
function localDate(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** No upgrade running (mirrors the main process' idle state). */
const IDLE_APP_UPDATE: AppUpdateState = {
  phase: 'idle',
  version: null,
  percent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  installPercent: 0,
  message: ''
}

export default function App(): ReactElement {
  const [apps, setApps] = useState<AppEntry[]>([])
  const [running, setRunning] = useState<RunningApp[]>([])
  const [addons, setAddons] = useState<AddonDescriptor[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [view, setView] = useState<ViewId>('home')
  const [showAdd, setShowAdd] = useState(false)
  const [moduleSection, setModuleSection] = useState<HomeModuleId | null>(null)
  const [linkedFocusId, setLinkedFocusId] = useState<string | null>(null)
  const [linkedLaunches, setLinkedLaunches] = useState<LinkedLaunch[]>([])
  const [totals, setTotals] = useState<Record<string, number>>({})
  const [updateInfos, setUpdateInfos] = useState<Record<string, UpdateInfo>>({})
  const [updateStatuses, setUpdateStatuses] = useState<Record<string, UpdateStatus>>({})

  const [gamesHidden, setGamesHidden] = useState(false)
  const [peeking, setPeeking] = useState(false)
  const [bgDisplay, setBgDisplay] = useState<{
    src: string
    kind: 'image' | 'video'
    blur: number
    dim: number
  } | null>(null)
  const bgSaveTimer = useRef<number | undefined>(undefined)
  const bgRaf = useRef(0)
  const [launcherSettings, setLauncherSettings] = useState<LauncherSettings>({
    iconFile: null,
    fontFamily: null,
    closeAction: 'close',
    afterLaunch: 'none',
    autoStart: 'off',
    sidebarMaterial: true,
    updateChannel: 'stable'
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
  /** Last date (local `YYYY-MM-DD`) each app was checked, so a check runs once a day. */
  const checkedUpdateDate = useRef<Map<string, string>>(new Map())
  const [appUpdate, setAppUpdate] = useState<AppUpdateInfo | null>(null)
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState>(IDLE_APP_UPDATE)
  const [dismissedUpdate, setDismissedUpdate] = useState<string | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [launchFx, setLaunchFx] = useState<{
    effect: AppEntry['launchEffect']
    key: number
    originX: number
    originY: number
  } | null>(null)
  const [updateCheckText, setUpdateCheckText] = useState('')
  const [dataDir, setDataDir] = useState('')
  /** Windows desktop wallpaper — background when the launcher has no apps. */
  const [desktopWall, setDesktopWall] = useState<string | null>(null)
  const [programDir, setProgramDir] = useState('')
  const [usage, setUsage] = useState<UsageReport | null>(null)

  const refreshApps = useCallback(async (): Promise<void> => {
    setApps(await window.api.listApps())
  }, [])
  const refreshRunning = useCallback(async (): Promise<void> => {
    setRunning(await window.api.listRunning())
  }, [])
  const refreshTotals = useCallback(async (): Promise<void> => {
    setTotals(await window.api.playTimeTotals())
  }, [])
  const refreshLinked = useCallback(async (): Promise<void> => {
    setLinkedLaunches(await window.api.listLinkedLaunches())
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

  const gamesWrapRef = useRef<HTMLDivElement>(null)
  // After a chip drag settles: if the row was only peeking and the pointer is no
  // longer over it, collapse it again.
  const handleGamesDragEnd = useCallback((): void => {
    window.setTimeout(() => {
      const el = gamesWrapRef.current
      if (el && gamesHidden && !el.matches(':hover')) setPeeking(false)
    }, 120)
  }, [gamesHidden])

  useEffect(() => {
    void (async (): Promise<void> => {
      setAddons(await window.api.listAddons())
      setGamesHidden((await window.api.getUiPrefs()).gamesRowHidden)
      await refreshApps()
      await refreshRunning()
      await refreshTotals()
      await refreshLinked()
      setAppsLoaded(true)
    })()
    const offApps = window.api.onAppsChanged(() => {
      void refreshApps()
      void refreshLinked()
    })
    const offRunning = window.api.onRunningChanged(() => void refreshRunning())
    const offPlayTime = window.api.onPlayTimeChanged(() => void refreshTotals())
    return () => {
      offApps()
      offRunning()
      offPlayTime()
    }
  }, [refreshApps, refreshRunning, refreshTotals, refreshLinked])

  useEffect(() => {
    void window.api.getLauncherSettings().then(setLauncherSettings)
    void window.api.listFonts().then(setFonts)
    void window.api.appVersion().then(setVersion)
    void window.api.desktopWallpaper().then(setDesktopWall)
    void window.api.dataDirGet().then((info) => {
      setDataDir(info.current)
      setProgramDir(info.programDir)
    })
    void window.api.housekeepingUsage().then(setUsage)
    return window.api.onLauncherChanged(() =>
      void window.api.getLauncherSettings().then(setLauncherSettings)
    )
  }, [])

  // Launcher self-update: adopt the result of the startup / 24h check (the main
  // process runs it) and of any later check.
  useEffect(() => {
    void window.api.appUpdateStatus().then((status) => {
      if (status.info) setAppUpdate(status.info)
    })
    return window.api.onAppUpdateAvailable(setAppUpdate)
  }, [])

  // Download / install progress for the rail indicator.
  useEffect(() => {
    void window.api.appUpdateState().then(setAppUpdateState)
    return window.api.onAppUpdateState(setAppUpdateState)
  }, [])

  const handleUpdateStart = useCallback((): void => {
    // The dialog steps aside; the rail ring shows the progress from now on.
    setAppUpdate(null)
    void window.api.appUpdateStart()
  }, [])

  const handleUpdateToggle = useCallback((): void => {
    void window.api.appUpdateToggle()
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



  /** Manual "check for updates": report the outcome as a toast. */
  const handleCheckUpdate = useCallback(async (): Promise<void> => {
    setCheckingUpdate(true)
    setUpdateCheckText('正在检查…')
    try {
      const status = await window.api.appUpdateCheck()
      if (status.hasUpdate && status.info) {
        // Same dialog as the automatic startup check.
        setDismissedUpdate(null)
        setAppUpdate(status.info)
        setUpdateCheckText(`发现新版本 ${status.info.version}`)
        showToast(`发现新版本 ${status.info.version}`)
      } else if (status.error) {
        setUpdateCheckText(`检查失败：${status.error}`)
        showToast(`检查更新失败：${status.error}`)
      } else {
        setUpdateCheckText('已是最新版本')
        showToast('已是最新版本')
      }
    } finally {
      setCheckingUpdate(false)
    }
  }, [showToast])

  /** Cleans the selected caches and refreshes the usage report. */
  const handleCleanUsage = useCallback(
    async (kinds: ('staging' | 'thumbs' | 'logs')[]): Promise<void> => {
      try {
        setUsage(await window.api.housekeepingClean(kinds))
        showToast('已清理所选缓存')
      } catch (error) {
        showToast(`清理失败：${(error as Error).message}`)
      }
    },
    [showToast]
  )

  /** Moves every setting to a new data directory (the launcher restarts). */
  const handleChangeDataDir = useCallback(async (): Promise<void> => {
    const picked = await window.api.dataDirPick(dataDir)
    if (!picked) return
    if (directoriesOverlap(picked, programDir)) {
      showToast('数据目录不能与程序目录相同，也不能互相包含')
      return
    }
    if (!(await confirm(`将把现有数据迁移到：\n${picked}\n\n完成后启动器会自动重启。`))) return
    showToast('正在迁移数据…')
    try {
      await window.api.dataDirSet(picked)
    } catch (error) {
      showToast(`更换数据目录失败：${(error as Error).message}`)
    }
  }, [dataDir, programDir, showToast])

  // When switching games, keep the current page if the new game supports it;
  // otherwise fall back to the home page.
  useEffect(() => {
    if (!current) return
    const caps = currentAddon?.capabilities
    if ((view === 'gacha' && !caps?.gacha) || (view === 'update' && !caps?.update)) {
      setView('home')
    }
  }, [current, currentAddon, view])

  // The "jump to a module section" hint is one-shot: clear it once we leave the
  // module manager so entering it normally shows every section collapsed.
  useEffect(() => {
    if (view !== 'modules') setModuleSection(null)
    if (view !== 'linkedLaunch') setLinkedFocusId(null)
  }, [view])

  const checkUpdate = useCallback(async (appId: string): Promise<void> => {
    try {
      const info = await window.api.updateInfo(appId)
      setUpdateInfos((prev) => ({ ...prev, [appId]: info }))
    } catch {
      /* ignore update check errors */
    }
  }, [])

  /** Latest app list, so the window-shown handler always sees fresh data. */
  const appsRef = useRef<AppEntry[]>([])
  useEffect(() => {
    appsRef.current = apps
  }, [apps])

  // Check every supported game for updates once per day. Runs when the app list
  // loads/changes and whenever the window becomes visible (startup or tray).
  const runDailyChecks = useCallback(
    (list?: AppEntry[]): void => {
      const date = localDate()
      for (const app of list ?? appsRef.current) {
        if (!app.addonId) continue
        if (checkedUpdateDate.current.get(app.id) === date) continue
        checkedUpdateDate.current.set(app.id, date)
        void checkUpdate(app.id)
      }
    },
    [checkUpdate]
  )

  useEffect(() => {
    runDailyChecks(apps)
  }, [apps, runDailyChecks])

  useEffect(() => window.api.onWindowShown(() => runDailyChecks()), [runDailyChecks])

  const handleAddApp = useCallback(
    async (input: NewAppEntry, iconDataUrl: string | null): Promise<void> => {
      const created = await window.api.addApp(input)
      if (iconDataUrl) await window.api.setIconData(created.id, iconDataUrl)
      setCurrentId(created.id)
      setView('home')
      setShowAdd(false)
      showToast('应用已添加')
    },
    [showToast]
  )

  /** Merge a partial change into an app (settings page edits it in place). */
  const handlePatchEntry = useCallback(
    async (entry: AppEntry, patch: Partial<AppEntry>): Promise<void> => {
      await window.api.updateApp({ ...entry, ...patch })
    },
    []
  )

  /** Play an app's launch effect, radiating from `el` (defaults to window centre). */
  const presentLaunchFx = useCallback(
    (effect: AppEntry['launchEffect'], el?: HTMLElement | null): void => {
      if (effect === 'none') return
      const r = el?.getBoundingClientRect()
      setLaunchFx({
        effect,
        key: Date.now(),
        originX: r && r.width ? (r.left + r.width / 2) / window.innerWidth : 0.5,
        originY: r && r.height ? 1 - (r.top + r.height / 2) / window.innerHeight : 0.4
      })
    },
    []
  )

  const handleLaunch = useCallback(
    async (id: string, methodId?: string): Promise<void> => {
      const entry = apps.find((a) => a.id === id)
      presentLaunchFx(
        entry?.launchEffect ?? 'none',
        document.querySelector('.home .start-wrap') as HTMLElement | null
      )
      const result = await window.api.launchApp(id, methodId)
      if (!result.ok) {
        showToast(result.error ?? '启动失败')
        return
      }
      if (result.message) showToast(result.message)
      // A launch may be a wallpaper-rotation trigger.
      if (entry?.wallpaperSettings?.trigger === 'appLaunch') {
        await window.api.wallpaperAdvance(id)
      }
      const action = launcherSettings.afterLaunch
      if (action === 'minimize') await window.api.windowMinimize()
      else if (action === 'tray') await window.api.hideToTray()
      else if (action === 'close') await window.api.windowClose()
    },
    [apps, showToast, launcherSettings.afterLaunch, presentLaunchFx]
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
      // Once an update finishes, drop the stale "hasUpdate" flag so the button
      // falls back from "开始更新" to "启动" immediately, then re-check for the
      // authoritative version.
      if (status.phase === 'done') {
        setUpdateInfos((prev) => {
          const cur = prev[status.appId]
          return cur ? { ...prev, [status.appId]: { ...cur, hasUpdate: false } } : prev
        })
        void checkUpdate(status.appId)
      }
    })
  }, [checkUpdate])

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

  const handlePickAppIcon = useCallback(async (): Promise<void> => {
    if (!currentId) return
    const res = await cropIcon()
    if (res) await window.api.setIconData(currentId, res.dataUrl)
  }, [currentId, cropIcon])

  const handleResetAppIcon = useCallback(async (): Promise<void> => {
    if (currentId) await window.api.resetIcon(currentId)
  }, [currentId])

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

  // -------------------------------------------------------------- wallpapers
  const handleWallpaperAdd = useCallback(async (): Promise<void> => {
    if (!currentId) return
    const paths = await window.api.pickWallpapers()
    for (const path of paths) await window.api.wallpaperAdd(currentId, path)
  }, [currentId])

  const handleWallpaperRemove = useCallback(
    async (id: string): Promise<void> => {
      if (currentId) await window.api.wallpaperRemove(currentId, id)
    },
    [currentId]
  )

  const handleWallpaperReorder = useCallback(
    async (ids: string[]): Promise<void> => {
      if (currentId) await window.api.wallpaperReorder(currentId, ids)
    },
    [currentId]
  )

  const handleWallpaperSettings = useCallback(
    async (patch: Partial<WallpaperSettings>): Promise<void> => {
      if (currentId) await window.api.wallpaperSettings(currentId, patch)
    },
    [currentId]
  )

  const handleWallpaperStep = useCallback(
    async (delta: number): Promise<void> => {
      if (currentId) await window.api.wallpaperStep(currentId, delta)
    },
    [currentId]
  )

  const handleWallpaperSelect = useCallback(
    async (index: number): Promise<void> => {
      if (currentId) await window.api.wallpaperSelect(currentId, index)
    },
    [currentId]
  )

  const handleWallpaperView = useCallback(
    async (index: number): Promise<void> => {
      if (currentId) await window.api.wallpaperOpenViewer(currentId, index)
    },
    [currentId]
  )

  const handleSetLaunchMethods = useCallback(
    async (appId: string, methods: LaunchMethod[], defaultId: string): Promise<void> => {
      await window.api.setLaunchMethods(appId, methods, defaultId)
    },
    []
  )

  const handleSetAppLinked = useCallback(
    async (appId: string, ids: string[], defaultId: string | null): Promise<void> => {
      await window.api.setAppLinkedLaunches(appId, ids, defaultId)
    },
    []
  )

  // ---------------------------------------------------------- linked launches
  const handleLinkedLaunch = useCallback(
    async (id: string, origin?: HTMLElement | null): Promise<void> => {
      // A linked launch is not bound to a single app: play the launch effect of
      // the app you are currently viewing, radiating from the clicked control.
      presentLaunchFx(current?.launchEffect ?? 'none', origin)
      const result = await window.api.launchLinkedLaunch(id)
      if (!result.ok) showToast(result.error ?? '启动失败')
    },
    [current, showToast, presentLaunchFx]
  )

  const handleStopLinked = useCallback(
    async (id: string): Promise<void> => {
      await window.api.stopApp(`linked:${id}`)
    },
    []
  )

  const linkedRunningKeys = useMemo(
    () => running.filter((r) => r.appId.startsWith('linked:')).map((r) => r.appId),
    [running]
  )

  const gamesRowLinked = useMemo(
    () => linkedLaunches.filter((item) => item.showInGamesRow),
    [linkedLaunches]
  )

  const handleLinkedReorder = useCallback(async (ids: string[]): Promise<void> => {
    setLinkedLaunches(await window.api.reorderLinkedLaunches(ids))
  }, [])

  const handleLinkedAdd = useCallback(async (): Promise<void> => {
    await window.api.addLinkedLaunch({
      name: '新建关联启动',
      targetPath: '',
      arguments: '',
      workingDirectory: '',
      runAsAdmin: true,
      showInGamesRow: true
    })
    setLinkedLaunches(await window.api.listLinkedLaunches())
  }, [])

  const handleLinkedUpdate = useCallback(async (entry: LinkedLaunch): Promise<void> => {
    await window.api.updateLinkedLaunch(entry)
  }, [])

  const handleLinkedRemove = useCallback(
    async (id: string): Promise<void> => {
      if (!(await confirm('确定删除该关联启动吗？'))) return
      await window.api.removeLinkedLaunch(id)
    },
    []
  )

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
      !(await confirm('导入会覆盖当前全部设置（应用、使用时长、抽卡记录、图标、壁纸），确定继续？'))
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
      return <GalleryView entry={entry} onBack={back} onEdit={() => setView('settings')} />
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
    if (view === 'linkedLaunch') {
      return (
        <LinkedLaunchView
          linkedLaunches={linkedLaunches}
          apps={apps}
          initialExpandedId={linkedFocusId}
          onBack={back}
          onAdd={() => void handleLinkedAdd()}
          onUpdate={(item) => void handleLinkedUpdate(item)}
          onRemove={(id) => void handleLinkedRemove(id)}
          onReorder={(ids) => void handleLinkedReorder(ids)}
          onSetAppLinked={(appId, ids, defaultId) => void handleSetAppLinked(appId, ids, defaultId)}
        />
      )
    }
    if (view === 'modules') {
      return (
        <ModuleManagerView
          entry={entry}
          linkedLaunches={linkedLaunches}
          initialExpanded={moduleSection}
          onBack={back}
          onSetModule={(moduleId, patch) =>
            void window.api.setHomeModule(entry.id, moduleId, patch)
          }
          onResetModulePosition={(moduleId) =>
            void window.api.setHomeModule(entry.id, moduleId, { x: null, y: null })
          }
          onSetModuleLabel={(label) => void window.api.setModuleLabel(entry.id, label)}
          onSetLaunchEffect={(effect) => void window.api.setLaunchEffect(entry.id, effect)}
          onSetLaunchMethods={(methods, defaultId) =>
            void handleSetLaunchMethods(entry.id, methods, defaultId)
          }
          onWallpaperAdd={() => void handleWallpaperAdd()}
          onWallpaperRemove={(id) => void handleWallpaperRemove(id)}
          onWallpaperReorder={(ids) => void handleWallpaperReorder(ids)}
          onWallpaperSettings={(patch) => void handleWallpaperSettings(patch)}
          onWallpaperSelect={(index) => void handleWallpaperSelect(index)}
          onWallpaperView={(index) => void handleWallpaperView(index)}
          onBgTuning={handleBgTuning}
          onSetAppLinked={(ids, defaultId) => void handleSetAppLinked(entry.id, ids, defaultId)}
          onEditLinkedLaunch={(id) => {
            setLinkedFocusId(id)
            setView('linkedLaunch')
          }}
        />
      )
    }
    return (
      <SettingsView
        entry={entry}
        addons={addons}
        onBack={back}
        onPatchEntry={(patch) => void handlePatchEntry(entry, patch)}
        onPickIcon={() => void handlePickAppIcon()}
        onResetIcon={() => void handleResetAppIcon()}
        onRemove={() => void handleRemove(entry)}
        onOpenModuleSettings={(section) => {
          setModuleSection(section)
          setView('modules')
        }}
        launcher={launcherSettings}
        fonts={fonts}
        version={version}
        onPickLauncherIcon={() => void pickLauncherIcon()}
        onClearLauncherIcon={() => void clearLauncherIcon()}
        onSetFont={(family) => void setLauncherFont(family)}
        onSetBehavior={(patch) => {
          void window.api.setLauncherBehavior(patch).then((settings) => {
            setLauncherSettings(settings)
            // Switching channel re-checks immediately so the indicator is accurate.
            if (patch.updateChannel) void handleCheckUpdate()
          })
        }}
        onExportData={() => void exportData()}
        onImportData={() => void importData()}
        dataDir={dataDir}
        onChangeDataDir={() => void handleChangeDataDir()}
        usage={usage}
        onCleanUsage={(kinds) => void handleCleanUsage(kinds)}
        onCheckUpdate={() => void handleCheckUpdate()}
        checkingUpdate={checkingUpdate}
        updateCheckText={updateCheckText}
        onExportLogs={() =>
          void window.api.exportLogs().then((p) => {
            if (p) showToast(`已导出日志到 ${p}`)
          })
        }
      />
    )
  }

  const wallpaper = current ? currentWallpaper(current) : null
  // With no apps, fall back to the Windows desktop wallpaper (never a black window).
  const desktopBg = !current && desktopWall ? fileUrl(desktopWall) : null
  const bg = desktopBg ?? backgroundUrl(wallpaper?.file ?? null)
  const isVideo = desktopBg ? isVideoFile(desktopWall) : isVideoFile(wallpaper?.file)

  useEffect(() => {
    applyTheme(current?.themeColor ?? null)
  }, [current?.themeColor])

  // Video wallpapers cannot be sampled by the main process, so decode the first
  // frame here and update the auto theme colour when the video changes.
  useEffect(() => {
    if (!current || !current.autoTheme || !isVideo || !bg) return undefined
    let cancelled = false
    const appId = current.id
    void extractVideoAccent(bg).then((color) => {
      if (!cancelled && color && color !== current.themeColor) {
        void window.api.setThemeColor(appId, color)
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bg, isVideo, current?.autoTheme, current?.id])

  // Swap the background only once the incoming image has decoded, carrying the
  // new game's blur / dim with it. The previous background (with its own blur)
  // stays on screen until then, so switching games never flashes a sharp frame.
  useEffect(() => {
    if (!bg) {
      setBgDisplay(null)
      return
    }
    const blur = current?.backgroundBlur ?? 0
    const dim = current ? current.backgroundDim : 0
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

  // Wallpaper rotation triggers: on app switch, once on launcher start (first
  // time an app is shown) and on an interval. `appLaunch` is handled in
  // `handleLaunch`.
  const startedApps = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!current) return undefined
    const settings = current.wallpaperSettings
    const trigger = settings?.trigger
    if (trigger === 'appSwitch') {
      void window.api.wallpaperAdvance(current.id)
      return undefined
    }
    if (trigger === 'launcherStart') {
      if (!startedApps.current.has(current.id)) {
        startedApps.current.add(current.id)
        void window.api.wallpaperAdvance(current.id)
      }
      return undefined
    }
    if (trigger === 'interval') {
      if (!startedApps.current.has(current.id)) {
        startedApps.current.add(current.id)
        void window.api.wallpaperAdvance(current.id)
      }
      const minutes = Math.max(1, settings?.intervalMinutes ?? 30)
      const timer = window.setInterval(
        () => void window.api.wallpaperAdvance(current.id),
        minutes * 60_000
      )
      return () => window.clearInterval(timer)
    }
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, current?.wallpaperSettings?.trigger, current?.wallpaperSettings?.intervalMinutes])

  // Live background tuning from the settings sliders: update instantly, persist
  // debounced.
  const handleBgTuning = useCallback(
    (blur: number, dim: number): void => {
      // Coalesce the live preview to one update per frame (dragging stays smooth).
      if (!bgRaf.current) {
        bgRaf.current = requestAnimationFrame(() => {
          bgRaf.current = 0
          setBgDisplay((prev) => (prev ? { ...prev, blur, dim } : prev))
        })
      }
      if (bgSaveTimer.current) window.clearTimeout(bgSaveTimer.current)
      const id = current?.id
      bgSaveTimer.current = window.setTimeout(() => {
        if (id) void window.api.setBgTuning(id, { blur, dim })
      }, 180)
    },
    [current?.id]
  )

  // Apply the current app's glass. Live edits in the settings page call
  // `applyGlass` themselves (immediate, no App re-render); this keeps other
  // views / app switches in sync.
  useEffect(() => {
    applyGlass(current?.glass)
  }, [current?.glass])

  // Plan-A popup backgrounds: publish the wallpaper image + its centre-cropped
  // geometry so every `.wallpaper-region` popup can paint the exact region under
  // it, then keep those offsets in sync.
  const [wpImage, setWpImage] = useState<{ src: string; w: number; h: number } | null>(null)
  useEffect(() => {
    if (!bg || isVideo) {
      setWpImage(null)
      return undefined
    }
    let cancelled = false
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => {
      if (!cancelled) setWpImage({ src: bg, w: image.naturalWidth, h: image.naturalHeight })
    }
    image.onerror = () => {
      if (!cancelled) setWpImage(null)
    }
    image.src = bg
    return () => {
      cancelled = true
    }
  }, [bg, isVideo])

  const [winSize, setWinSize] = useState({ w: window.innerWidth, h: window.innerHeight })
  useEffect(() => {
    const onResize = (): void => setWinSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    if (wpImage) {
      const vw = winSize.w + 128
      const vh = winSize.h + 128
      const scale = Math.max(vw / wpImage.w, vh / wpImage.h)
      const dw = wpImage.w * scale
      const dh = wpImage.h * scale
      root.style.setProperty('--wallpaper-image', `url("${wpImage.src}")`)
      root.style.setProperty('--wallpaper-display-w', `${dw}px`)
      root.style.setProperty('--wallpaper-display-h', `${dh}px`)
      root.style.setProperty('--wallpaper-cx', `${(vw - dw) / 2}px`)
      root.style.setProperty('--wallpaper-cy', `${(vh - dh) / 2}px`)
      root.dataset.wallpaperRegion = 'image'
    } else {
      root.style.setProperty('--wallpaper-image', 'none')
      root.dataset.wallpaperRegion = 'video'
    }
    updateWallpaperRegions()
  }, [wpImage, winSize])

  useEffect(() => installWallpaperRegionUpdater(), [])

  // Publish the current app's wallpaper blur / dim so popups and dialogs can
  // show the same wallpaper appearance.
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--wallpaper-blur', `${current?.backgroundBlur ?? 0}px`)
    root.style.setProperty('--wallpaper-dim', String((current?.backgroundDim ?? 0) / 100))
  }, [current?.backgroundBlur, current?.backgroundDim])

  // The sidebar material is a launcher-wide setting.
  useEffect(() => {
    document.documentElement.dataset.sidebarMaterial = launcherSettings.sidebarMaterial
      ? 'true'
      : 'false'
  }, [launcherSettings.sidebarMaterial])

  // Expose the user-facing background dimming for the contrast calculation.
  useEffect(() => {
    const dim = (bgDisplay?.dim ?? current?.backgroundDim ?? 0) / 100
    document.documentElement.style.setProperty('--bg-dim', dim.toFixed(3))
  }, [bgDisplay, current?.backgroundDim])

  // Global press-jelly for plain controls (buttons / selects / fonts / …).
  useEffect(() => installPressJelly(), [])

  // Remember where the last click was (offset from the window centre) so dialogs
  // can expand-in from it.
  useEffect(() => {
    const onDown = (event: PointerEvent): void => {
      const root = document.documentElement.style
      root.setProperty('--dx', `${Math.round(event.clientX - window.innerWidth / 2)}px`)
      root.setProperty('--dy', `${Math.round(event.clientY - window.innerHeight / 2)}px`)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [])

  // Over-background text/icons: black or white from the local background colour.
  useEffect(() => {
    let raf = 0
    const run = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => updateChromeContrast())
    }
    run()
    const settle = window.setTimeout(run, 150)
    const video = document.querySelector('.bg-layer')
    video?.addEventListener('loadeddata', run)
    window.addEventListener('resize', run)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(settle)
      video?.removeEventListener('loadeddata', run)
      window.removeEventListener('resize', run)
    }
  }, [bgDisplay, view, currentId, launcherSettings.sidebarMaterial, current?.backgroundDim])

  // Retrigger the transition on view / app change. The background lives inside
  // this animated element so backdrop-filter keeps blurring during the animation.
  useEffect(() => {
    const el = animRef.current
    if (!el) return
    const order: ViewId[] = [
      'home',
      'playtime',
      'gacha',
      'gallery',
      'update',
      'modules',
      'linkedLaunch',
      'settings'
    ]
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
          crossOrigin="anonymous"
          alt=""
          style={bgDisplay.blur > 0 ? { filter: `blur(${bgDisplay.blur}px)` } : undefined}
        />
      )}
      {bgDisplay && bgDisplay.kind === 'video' && (
        <video
          key={bgDisplay.src}
          className="bg-layer"
          src={bgDisplay.src}
          crossOrigin="anonymous"
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
        updateSlot={
          <UpdateRing
            info={appUpdate}
            state={appUpdateState}
            onStart={handleUpdateStart}
            onToggle={handleUpdateToggle}
          />
        }
      />

      <div className="topbar">
        <div
          ref={gamesWrapRef}
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
              onAdd={() => setShowAdd(true)}
              onReorder={(ids) => void handleReorder(ids)}
              onDragEnd={handleGamesDragEnd}
            />
            <LinkedLaunchRow
              items={gamesRowLinked}
              visible={view === 'home'}
              runningKeys={linkedRunningKeys}
              onLaunch={(id, el) => void handleLinkedLaunch(id, el)}
              onStop={(id) => void handleStopLinked(id)}
              onReorder={(ids) => void handleLinkedReorder(ids)}
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
              <button className="start-btn" onClick={() => setShowAdd(true)}>
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
              linkedLaunches={linkedLaunches}
              runningKeys={running.map((r) => r.appId)}
              onLaunch={(methodId) => void handleLaunch(current.id, methodId)}
              onStop={() => void handleStop(current.id)}
              onUpdateToggle={() => void handleUpdate(current.id, 'update')}
              onPreDownloadToggle={() => void handleUpdate(current.id, 'preDownload')}
              onShowStats={() => setView('playtime')}
              onWallpaperStep={(delta) => void handleWallpaperStep(delta)}
              onLaunchLinked={(id, el) => void handleLinkedLaunch(id, el)}
              onStopLinked={(id) => void handleStopLinked(id)}
              onMoveModule={(moduleId, x, y) =>
                void window.api.setHomeModule(current.id, moduleId, { x, y })
              }
              onModuleUnplaceable={(moduleId) =>
                void window.api.setHomeModule(current.id, moduleId, { visible: false })
              }
            />
          ) : (
            renderSubView(current)
          )}
      </main>
      </div>

      {showAdd && (
        <NewAppDialog
          addons={addons}
          onClose={() => setShowAdd(false)}
          onSubmit={handleAddApp}
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

      <Toaster />

      <ConfirmHost />

      <LaunchTransition trigger={launchFx} onDone={() => setLaunchFx(null)} />

      {gachaNotice && (
        <div className="gacha-toast">
          <span className="gacha-toast-spinner" />
          {`正在获取${gachaNotice.name ? `「${gachaNotice.name}」` : ''} ${gachaNotice.bannerName} 第 ${gachaNotice.page} 页…`}
        </div>
      )}

      {appUpdate && appUpdate.version !== dismissedUpdate && (
        <AppUpdateDialog
          info={appUpdate}
          onStart={handleUpdateStart}
          onDismiss={() => setDismissedUpdate(appUpdate.version)}
        />
      )}
    </div>
  )
}
