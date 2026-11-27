import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_KEVIN_HUD,
  normalizeKevinHudConfig,
  type KevinHudConfig,
  type KevinHudFrame
} from '@shared/kevinHud'
import { DEFAULT_GLASS_APPEARANCE, type AppEntry, type LinkedLaunch } from '@shared/types'
import {
  KEVIN_HUD_COMMIT_TTL_MS,
  KevinHudController,
  type KevinHudDeparture,
  type KevinHudDisplaySnapshot,
  type KevinHudMainWindow,
  type KevinHudMetricsBridge,
  type KevinHudRuntimeEntry,
  type KevinHudWindowSink
} from '../src/main/services/kevinHudController'
import type { KevinHudDisplayHint } from '../src/main/services/kevinHudPlacement'
import type { KevinHudClock } from '../src/main/services/kevinHudLifecycle'

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

interface FakeTimer {
  id: number
  at: number
  callback: () => void
}

class FakeClock implements KevinHudClock {
  private time = 1_000_000
  private nextId = 1
  private readonly timers = new Map<number, FakeTimer>()

  now(): number {
    return this.time
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++
    this.timers.set(id, { id, at: this.time + Math.max(0, delayMs), callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.timers.delete(handle)
  }

  async advance(ms: number): Promise<void> {
    const target = this.time + Math.max(0, ms)
    for (;;) {
      let next: FakeTimer | undefined
      for (const timer of this.timers.values()) {
        if (timer.at > target) continue
        if (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id)) next = timer
      }
      if (!next) break
      this.timers.delete(next.id)
      this.time = Math.max(this.time, next.at)
      next.callback()
      await settle()
    }
    this.time = target
    await settle()
  }
}

class FakeRuntime {
  readonly entries: KevinHudRuntimeEntry[] = []
  private readonly listeners = new Set<() => void>()

  list(): readonly KevinHudRuntimeEntry[] {
    return this.entries
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  track(appId: string, now: number, pids: number[] = [123], elapsedSec = 0): KevinHudRuntimeEntry {
    const entry: KevinHudRuntimeEntry = {
      appId,
      pids,
      rootPid: pids[0] ?? null,
      startedAt: new Date(now).toISOString(),
      activeSince: new Date(now).toISOString(),
      elapsedSec,
      confirmed: pids.length > 0
    }
    this.entries.push(entry)
    for (const listener of [...this.listeners]) listener()
    return entry
  }

  updatePids(appId: string, pids: number[], rootPid = pids[0] ?? null): void {
    const index = this.entries.findIndex((entry) => entry.appId === appId)
    if (index < 0) return
    this.entries[index] = { ...this.entries[index], pids: [...pids], rootPid }
    for (const listener of [...this.listeners]) listener()
  }

  remove(appId: string): void {
    const index = this.entries.findIndex((entry) => entry.appId === appId)
    if (index >= 0) this.entries.splice(index, 1)
    for (const listener of [...this.listeners]) listener()
  }
}

class FakeHudWindow implements KevinHudWindowSink {
  open = true
  readonly events: string[] = []
  readonly frames: KevinHudFrame[] = []
  readonly displayHints: (KevinHudDisplayHint | null)[] = []
  closeCalls = 0
  sendCalls = 0
  measure?: (frame: KevinHudFrame) => { x: number; y: number; width: number; height: number }
  ownsWebContents?: (contents: unknown) => boolean

  display(frame: KevinHudFrame, hint: KevinHudDisplayHint | null = null): unknown {
    this.events.push('display')
    this.frames.push(frame)
    this.displayHints.push(hint)
    return { x: 0, y: 0, width: 400, height: 60 }
  }

  send(frame: KevinHudFrame): boolean {
    this.sendCalls += 1
    this.frames.push(frame)
    return true
  }

  close(): void {
    this.closeCalls += 1
    this.open = false
  }

  isOpen(): boolean {
    return this.open
  }
}

interface TrackedMainWindow extends KevinHudMainWindow {
  hide: ReturnType<typeof vi.fn>
  setBounds: ReturnType<typeof vi.fn>
  setOpacity: ReturnType<typeof vi.fn>
  isVisible: () => boolean
}

function mainWindow(): TrackedMainWindow {
  let visible = true
  return {
    id: 7,
    getBounds: () => ({ x: 100, y: 100, width: 1000, height: 700 }),
    setBounds: vi.fn(),
    getOpacity: () => 1,
    setOpacity: vi.fn(),
    isDestroyed: () => false,
    isVisible: () => visible,
    hide: vi.fn(() => {
      visible = false
    })
  } as unknown as TrackedMainWindow
}

/** Build an app HUD config with the absorption switch via the real normalizer. */
function hudConfig(
  absorbLauncher: boolean | undefined,
  patch: Partial<KevinHudConfig> = {}
): KevinHudConfig {
  return normalizeKevinHudConfig({
    ...DEFAULT_KEVIN_HUD,
    ...patch,
    ...(absorbLauncher === undefined ? {} : { absorbLauncher })
  })
}

function closeableWindow(id: number): {
  window: KevinHudMainWindow
  close: () => void
} {
  let closed: (() => void) | null = null
  const window = {
    ...mainWindow(),
    id,
    once: (event: string, listener: () => void): void => {
      if (event === 'closed') closed = listener
    }
  } as KevinHudMainWindow & { once: (event: string, listener: () => void) => void }
  return {
    window,
    close: () => {
      const listener = closed
      closed = null
      listener?.()
    }
  }
}

function appEntry(
  id: string,
  patch: Partial<AppEntry> = {},
  config: KevinHudConfig = normalizeKevinHudConfig(DEFAULT_KEVIN_HUD)
): AppEntry {
  return {
    id,
    name: id === 'app-1' ? '原神' : '其他应用',
    moduleLabel: null,
    launchMethods: [],
    defaultLaunchMethodId: id,
    gameDirectory: null,
    environmentVariables: {},
    addonId: null,
    iconFile: null,
    wallpapers: [],
    wallpaperSettings: { strategy: 'loop', trigger: 'launcherStart', intervalMinutes: 30 },
    wallpaperIndex: 0,
    themeColor: null,
    glass: { ...DEFAULT_GLASS_APPEARANCE },
    autoTheme: false,
    backgroundBlur: 0,
    backgroundDim: 25,
    screenshotDirectory: null,
    monitorProcessNames: [],
    gachaShowSecond: true,
    linkedLaunchIds: [],
    defaultLinkedLaunchId: null,
    launchEffect: 'shockwave',
    kevinHud: config,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...patch
  }
}

function linked(id: string, name = '联动启动'): LinkedLaunch {
  return {
    id,
    name,
    targetPath: 'C:\\games\\linked.exe',
    arguments: '',
    workingDirectory: '',
    runAsAdmin: false,
    showInGamesRow: true
  }
}

function displays(): KevinHudDisplaySnapshot {
  return {
    primaryDisplayId: 1,
    displays: [{
      id: 1,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      scaleFactor: 1
    }]
  }
}

function twoScreenDisplays(): KevinHudDisplaySnapshot {
  return {
    primaryDisplayId: 1,
    displays: [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
        scaleFactor: 1
      },
      {
        id: 2,
        bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
        workArea: { x: 1920, y: 0, width: 1920, height: 1040 },
        scaleFactor: 1
      }
    ]
  }
}

interface Harness {
  clock: FakeClock
  runtime: FakeRuntime
  window: FakeHudWindow
  main: TrackedMainWindow
  order: string[]
  departure: ReturnType<typeof vi.fn>
  showMainWindow: ReturnType<typeof vi.fn>
  controller: KevinHudController
}

function harness(options: {
  apps?: AppEntry[]
  linked?: LinkedLaunch[]
  hudPage?: { token: string; url: string }
  metrics?: KevinHudMetricsBridge | null
  displaySnapshot?: KevinHudDisplaySnapshot
} = {}): Harness {
  const clock = new FakeClock()
  const runtime = new FakeRuntime()
  const window = new FakeHudWindow()
  const main = mainWindow()
  const order: string[] = []
  const departure = vi.fn(async (win: KevinHudMainWindow) => {
    order.push('departure')
    win.hide()
    return { status: 'completed', hidden: true }
  })
  const showMainWindow = vi.fn()
  const controller = new KevinHudController({
    windowSink: window,
    runtime,
    playTime: { load: async () => undefined, totalForApp: () => 3_600 },
    appSource: {
      listApps: async () => options.apps ?? [],
      listLinkedLaunches: async () => options.linked ?? [],
      launcherSettings: async () => ({ fontFamily: null })
    },
    shell: { showMainWindow },
    displays: () => options.displaySnapshot ?? displays(),
    departure: departure as unknown as KevinHudDeparture,
    metrics: options.metrics ?? null,
    hotkeys: null,
    clock,
    hudPage: options.hudPage ?? null,
    commitTtlMs: KEVIN_HUD_COMMIT_TTL_MS,
    exitMs: 10
  })
  const originalDisplay = window.display.bind(window)
  window.display = (frame, hint) => {
    order.push('display')
    return originalDisplay(frame, hint)
  }
  return { clock, runtime, window, main, order, departure, showMainWindow, controller }
}

function prepareApp(test: Harness, appId = 'app-1'): Promise<boolean> {
  return test.controller.prepareAppLaunch({
    senderId: 11,
    windowId: 7,
    mainWindow: test.main,
    appId,
    launchPid: 123
  })
}

describe('Kevin HUD launch binder', () => {
  it('commits only from the same sender/window, exactly once', async () => {
    const test = harness({
      apps: [appEntry('app-1', {}, normalizeKevinHudConfig({
        ...DEFAULT_KEVIN_HUD,
        metrics: ['sessionTime', 'totalTime']
      }))]
    })
    test.runtime.track('app-1', test.clock.now())

    expect(await prepareApp(test)).toBe(true)
    expect(test.window.events).toEqual([])
    expect(test.controller.commitLaunch({
      senderId: 12,
      windowId: 7,
      runtimeKey: 'app-1',
      reducedMotion: false
    })).toBe(false)
    expect(test.controller.commitLaunch({
      senderId: 11,
      windowId: 8,
      runtimeKey: 'app-1',
      reducedMotion: false
    })).toBe(false)
    expect(test.controller.commitLaunch({
      senderId: 11,
      windowId: 7,
      runtimeKey: 'app-1',
      reducedMotion: false
    })).toBe(true)
    expect(test.controller.commitLaunch({
      senderId: 11,
      windowId: 7,
      runtimeKey: 'app-1',
      reducedMotion: false
    })).toBe(false)

    await settle()
    expect(test.order).toEqual(['departure', 'display'])
    expect(test.departure).toHaveBeenCalledTimes(1)
    expect(test.window.frames[0]?.config.enabled).toBe(true)
    expect(test.window.frames[0]?.values.sessionTime).toBe('0:00:00')
    expect(test.window.frames[0]?.values.totalTime).toBe('1:00:00')
    expect(test.controller.getLatestHudFrame()?.phase).toBe('announce')
    await test.controller.dispose()
    expect(test.controller.getLatestHudFrame()).toBeNull()
  })

  it('rejects forged commits that were never prepared and tickets after expiry', async () => {
    const test = harness({ apps: [appEntry('app-1')] })
    test.runtime.track('app-1', test.clock.now())

    expect(test.controller.commitLaunch({
      senderId: 11,
      windowId: 7,
      runtimeKey: 'app-1',
      reducedMotion: true
    })).toBe(false)

    expect(await prepareApp(test)).toBe(true)
    await test.clock.advance(KEVIN_HUD_COMMIT_TTL_MS)
    expect(test.controller.commitLaunch({
      senderId: 11,
      windowId: 7,
      runtimeKey: 'app-1',
      reducedMotion: true
    })).toBe(false)
    await settle()
    expect(test.departure).not.toHaveBeenCalled()
    expect(test.window.events).toEqual([])
    await test.controller.dispose()
  })

  it('prepares without showing until the renderer commits, even with no transition', async () => {
    const test = harness({
      apps: [appEntry('app-1', { launchEffect: 'none' })]
    })
    test.runtime.track('app-1', test.clock.now())

    expect(await prepareApp(test)).toBe(true)
    await settle()
    expect(test.order).toEqual([])
    expect(test.controller.commitLaunch({
      senderId: 11,
      windowId: 7,
      runtimeKey: 'app-1',
      reducedMotion: false
    })).toBe(true)
    await settle()
    expect(test.order).toEqual(['departure', 'display'])
    await test.controller.dispose()
  })

  it('starts the HUD immediately and never touches the launcher when absorption is off', async () => {
    const test = harness({
      apps: [appEntry('app-1', {}, hudConfig(false))]
    })
    test.runtime.track('app-1', test.clock.now())

    expect(await prepareApp(test)).toBe(true)
    expect(test.controller.commitLaunch({
      senderId: 11,
      windowId: 7,
      runtimeKey: 'app-1',
      reducedMotion: false
    })).toBe(true)
    await settle()

    // Normal app launch entry, direct "launching" HUD frame, no departure or
    // target measurement, and no bounds/opacity/visibility/focus change.
    expect(test.order).toEqual(['display'])
    expect(test.window.frames[0]?.phase).toBe('announce')
    expect(test.departure).not.toHaveBeenCalled()
    expect(test.main.setBounds).not.toHaveBeenCalled()
    expect(test.main.setOpacity).not.toHaveBeenCalled()
    expect(test.main.hide).not.toHaveBeenCalled()
    expect(test.main.isVisible()).toBe(true)
    await test.controller.dispose()
  })

  it('keeps the measured second-screen game hint when absorption is off', async () => {
    const gameRect = { x: 1920, y: 0, width: 1920, height: 1080 }
    const targetWindowRect = vi.fn(async () => gameRect)
    const metrics: KevinHudMetricsBridge = {
      sync: vi.fn(),
      start: vi.fn(),
      values: () => ({}),
      targetWindowRect,
      stop: vi.fn(async () => undefined)
    }
    const test = harness({
      apps: [appEntry('app-1', {}, hudConfig(false, { monitor: 'game' }))],
      metrics,
      displaySnapshot: twoScreenDisplays()
    })
    test.window.measure = vi.fn()
    test.runtime.track('app-1', test.clock.now())

    expect(await prepareApp(test)).toBe(true)
    expect(test.controller.commitLaunch({
      senderId: 11,
      windowId: 7,
      runtimeKey: 'app-1',
      reducedMotion: false
    })).toBe(true)
    await settle()

    // The bounded initial measurement still resolves the HUD display even when
    // the launcher is not absorbed. The HUD keeps the normal initial hint and
    // the main window is untouched: no target measurement, departure, hide or
    // bounds/opacity change, and no restore request.
    expect(targetWindowRect).toHaveBeenCalledTimes(1)
    expect(test.order).toEqual(['display'])
    expect(test.window.displayHints[0]?.gameWindowRect).toEqual(gameRect)
    expect(test.window.measure).not.toHaveBeenCalled()
    expect(test.departure).not.toHaveBeenCalled()
    expect(test.main.hide).not.toHaveBeenCalled()
    expect(test.main.setBounds).not.toHaveBeenCalled()
    expect(test.main.setOpacity).not.toHaveBeenCalled()
    expect(test.main.isVisible()).toBe(true)
    expect(test.showMainWindow).not.toHaveBeenCalled()
    await test.controller.dispose()
  })

  it('does not bring the launcher back when a non-absorbing HUD fails', async () => {
    const test = harness({
      apps: [appEntry('app-1', {}, hudConfig(false))]
    })
    test.runtime.track('app-1', test.clock.now())
    test.window.display = () => {
      test.window.open = false
      return null
    }

    expect(await prepareApp(test)).toBe(true)
    expect(test.controller.commitLaunch({
      senderId: 11,
      windowId: 7,
      runtimeKey: 'app-1',
      reducedMotion: false
    })).toBe(true)
    await settle()

    expect(test.departure).not.toHaveBeenCalled()
    expect(test.showMainWindow).not.toHaveBeenCalled()
    expect(test.main.hide).not.toHaveBeenCalled()
    expect(test.main.isVisible()).toBe(true)
    await test.controller.dispose()
  })

  it('does not restore the launcher after a non-absorbing session ends', async () => {
    const test = harness({
      apps: [appEntry('app-1', {
        kevinHud: hudConfig(false, { alwaysVisible: false, restoreLauncher: true })
      })]
    })
    test.runtime.track('app-1', test.clock.now())

    expect(await prepareApp(test)).toBe(true)
    expect(test.controller.commitLaunch({
      senderId: 11,
      windowId: 7,
      runtimeKey: 'app-1',
      reducedMotion: false
    })).toBe(true)
    await settle()
    await test.clock.advance(6_000)
    await test.clock.advance(10)

    // Even the persisted "restore launcher" preference must not pull back a
    // window the HUD never absorbed.
    expect(test.departure).not.toHaveBeenCalled()
    expect(test.showMainWindow).not.toHaveBeenCalled()
    expect(test.main.hide).not.toHaveBeenCalled()
    expect(test.main.isVisible()).toBe(true)
    expect(test.window.closeCalls).toBeGreaterThan(0)
    await test.controller.dispose()
  })

  it('does not prepare a HUD for a disabled app or an untracked launch', async () => {
    const disabled = harness({
      apps: [appEntry('app-1', {}, normalizeKevinHudConfig({
        ...DEFAULT_KEVIN_HUD,
        enabled: false
      }))]
    })
    disabled.runtime.track('app-1', disabled.clock.now())
    expect(await prepareApp(disabled)).toBe(false)

    const untracked = harness({ apps: [appEntry('app-1')] })
    expect(await prepareApp(untracked)).toBe(false)
    expect(untracked.controller.commitLaunch({
      senderId: 11,
      windowId: 7,
      runtimeKey: 'app-1',
      reducedMotion: false
    })).toBe(false)
    await disabled.controller.dispose()
    await untracked.controller.dispose()
  })

  it('does not prepare a HUD whose launch disappeared before commit', async () => {
    const test = harness({ apps: [appEntry('app-1')] })
    test.runtime.track('app-1', test.clock.now())
    test.runtime.remove('app-1')
    expect(await prepareApp(test)).toBe(false)
    await settle()
    expect(test.window.events).toEqual([])
    await test.controller.dispose()
  })

  it('starts the metrics port only when a resident HUD enters monitor', async () => {
    const sample = vi.fn(async () => ({ sessionTime: '0:00:05' }))
    const metrics: KevinHudMetricsBridge = {
      sync: vi.fn(),
      start: vi.fn(),
      sample,
      values: () => ({}),
      targetWindowRect: vi.fn(async () => null),
      stop: vi.fn(async () => undefined)
    }
    const resident = normalizeKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      alwaysVisible: true,
      sampleSeconds: 1,
      metrics: ['sessionTime']
    })
    const test = harness({
      apps: [appEntry('app-1', { kevinHud: resident })],
      metrics
    })
    test.runtime.track('app-1', test.clock.now())
    expect(await prepareApp(test)).toBe(true)
    expect(test.controller.commitLaunch({
      senderId: 11,
      windowId: 7,
      runtimeKey: 'app-1',
      reducedMotion: false
    })).toBe(true)
    await settle()
    expect(metrics.start).not.toHaveBeenCalled()
    expect(sample).not.toHaveBeenCalled()

    await test.clock.advance(2_000)
    await test.clock.advance(1_000)
    expect(metrics.start).toHaveBeenCalled()
    expect(sample).toHaveBeenCalledTimes(1)
    expect(test.window.frames.some((frame) => frame.values.sessionTime === '0:00:05')).toBe(true)
    await test.controller.dispose()
    expect(metrics.stop).toHaveBeenCalled()
  })

  it('hands the complete verified Runtime PID set to the monitor and follows a late game PID', async () => {
    const sync = vi.fn()
    const metrics: KevinHudMetricsBridge = {
      sync,
      start: vi.fn(),
      sample: vi.fn(async () => ({ sessionTime: '0:00:05' })),
      values: () => ({}),
      targetWindowRect: vi.fn(async () => null),
      stop: vi.fn(async () => undefined)
    }
    const resident = normalizeKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      alwaysVisible: true,
      sampleSeconds: 1,
      metrics: ['sessionTime']
    })
    const test = harness({
      apps: [appEntry('app-1', { kevinHud: resident })],
      metrics
    })
    // Enter through the normal launch sequence: Runtime tracks the launch PID,
    // then the HUD ticket is prepared and committed. Only afterwards does the
    // indirect launcher surface its wrapper, with the child game process found
    // by a later Runtime scan.
    test.runtime.track('app-1', test.clock.now())
    expect(await prepareApp(test)).toBe(true)
    expect(test.controller.commitLaunch({
      senderId: 11,
      windowId: 7,
      runtimeKey: 'app-1',
      reducedMotion: false
    })).toBe(true)
    // The fake clock only fires timers that are already scheduled. Let the
    // committed session finish its asynchronous announcement setup before
    // advancing through announce -> monitor, matching the game-screen cadence
    // test below. The wrapper's moved PID set arrives as a later Runtime scan.
    await settle()
    test.runtime.updatePids('app-1', [1000, 1001], 1000)

    await test.clock.advance(2_000)
    await test.clock.advance(1_000)
    await settle()
    expect(sync).toHaveBeenCalled()
    const first = sync.mock.calls.at(-1)?.[1] as { pid?: number; pids?: number[]; rootPid?: number }
    expect(first.pid).toBeNull()
    expect(first.pids).toEqual([1000, 1001])
    expect(first.rootPid).toBe(1000)

    test.runtime.updatePids('app-1', [1000, 1001, 1002], 1000)
    await test.clock.advance(1_000)
    await settle()
    const latest = sync.mock.calls.at(-1)?.[1] as { pid?: number; pids?: number[]; rootPid?: number }
    expect(latest.pids).toEqual([1000, 1001, 1002])
    expect(latest.rootPid).toBe(1000)
    await test.controller.dispose()
  })

  it('refreshes a moved game-screen hint on the monitor cadence, not on a timer', async () => {
    const firstRect = { x: 0, y: 0, width: 1920, height: 1080 }
    const secondRect = { x: 1920, y: 0, width: 1920, height: 1080 }
    let currentRect = firstRect
    const targetWindowRect = vi.fn(async () => currentRect)
    const metrics: KevinHudMetricsBridge = {
      sync: vi.fn(),
      start: vi.fn(),
      sample: vi.fn(async () => ({ sessionTime: '0:00:03' })),
      values: () => ({}),
      targetWindowRect,
      stop: vi.fn(async () => undefined)
    }
    const resident = normalizeKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      alwaysVisible: true,
      monitor: 'game',
      sampleSeconds: 1
    })
    const test = harness({
      apps: [appEntry('app-1', { kevinHud: resident })],
      metrics
    })
    test.runtime.track('app-1', test.clock.now())
    expect(await prepareApp(test)).toBe(true)
    expect(test.controller.commitLaunch({
      senderId: 11,
      windowId: 7,
      runtimeKey: 'app-1',
      reducedMotion: false
    })).toBe(true)
    await settle()
    expect(targetWindowRect).toHaveBeenCalledTimes(1)
    expect(test.window.displayHints[0]?.gameWindowRect).toEqual(firstRect)

    await test.clock.advance(2_000)
    expect(test.window.events.filter((event) => event === 'display')).toHaveLength(1)
    expect(test.window.sendCalls).toBeGreaterThan(0)

    currentRect = secondRect
    await test.clock.advance(1_000)
    await settle()
    expect(targetWindowRect).toHaveBeenCalledTimes(2)
    expect(test.window.events.filter((event) => event === 'display')).toHaveLength(2)
    expect(test.window.displayHints[1]?.gameWindowRect).toEqual(secondRect)

    currentRect = { x: 3840, y: 0, width: 1920, height: 1080 }
    await test.clock.advance(1_000)
    await settle()
    expect(targetWindowRect).toHaveBeenCalledTimes(2)

    test.controller.setSuspended(true)
    await test.clock.advance(3_000)
    await settle()
    expect(targetWindowRect).toHaveBeenCalledTimes(2)
    await test.controller.dispose()
  })

  it('measures the game target once and never shows the HUD before the departure', async () => {
    const targetWindowRect = vi.fn(async () => ({ x: 100, y: 100, width: 1000, height: 700 }))
    const metrics: KevinHudMetricsBridge = {
      sync: vi.fn(),
      start: vi.fn(),
      values: () => ({}),
      targetWindowRect,
      stop: vi.fn(async () => undefined)
    }
    const gameConfig = normalizeKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      monitor: 'game',
      autoWidth: false
    })
    const test = harness({
      apps: [appEntry('app-1', { kevinHud: gameConfig })],
      metrics
    })
    test.runtime.track('app-1', test.clock.now())
    const measured = { x: 0, y: 0, width: gameConfig.width, height: gameConfig.height }
    const measure = vi.fn(() => measured)
    test.window.measure = measure

    expect(await prepareApp(test)).toBe(true)
    expect(test.controller.commitLaunch({
      senderId: 11,
      windowId: 7,
      runtimeKey: 'app-1',
      reducedMotion: false
    })).toBe(true)
    await settle()
    expect(targetWindowRect).toHaveBeenCalledTimes(1)
    expect(measure).toHaveBeenCalledTimes(1)
    expect(test.order).toEqual(['departure', 'display'])
    const target = test.departure.mock.calls[0]?.[1] as { width: number; height: number } | undefined
    expect(target).toEqual(measured)
    await test.controller.dispose()
  })

  it('falls back to exact announcement placement with the configured preset mode and plate height', async () => {
    const preset = normalizeKevinHudConfig({
      ...DEFAULT_KEVIN_HUD,
      positionMode: 'preset',
      autoWidth: true,
      width: 200,
      height: 60,
      metrics: ['appName']
    })
    const test = harness({ apps: [appEntry('app-1', { kevinHud: preset })] })
    test.runtime.track('app-1', test.clock.now())
    // The production window service always supplies measure(); this fixture
    // exercises the fallback used by lighter embedders.
    expect(test.window.measure).toBeUndefined()

    expect(await prepareApp(test)).toBe(true)
    expect(test.controller.commitLaunch({
      senderId: 11,
      windowId: 7,
      runtimeKey: 'app-1',
      reducedMotion: false
    })).toBe(true)
    await settle()
    const target = test.departure.mock.calls[0]?.[1] as
      | { x: number; y: number; width: number; height: number }
      | undefined
    // The announcement host is the same 60-DIP height as the settled plate, so
    // the preset top inset 16 leaves the native host at y=16.
    expect(target).toEqual({ x: 860, y: 16, width: 200, height: 60 })
    await test.controller.dispose()
  })
})

describe('Kevin HUD linked-launch ownership', () => {
  it('uses a unique persisted binding when no owner hint is present', async () => {
    const test = harness({
      apps: [appEntry('app-1', { linkedLaunchIds: ['link-1'] })],
      linked: [linked('link-1')]
    })
    test.runtime.track('linked:link-1', test.clock.now())

    expect(await test.controller.prepareLinkedLaunch({
      senderId: 11,
      windowId: 7,
      mainWindow: test.main,
      linkedId: 'link-1',
      launchPid: 123
    })).toBe(true)
    expect(test.controller.commitLaunch({
      senderId: 11,
      windowId: 7,
      runtimeKey: 'linked:link-1',
      reducedMotion: false
    })).toBe(true)
    await settle()
    expect(test.window.frames[0]?.appName).toBe('联动启动')
    await test.controller.dispose()
  })

  it('refuses an ambiguous unowned ID and an unassigned owner hint', async () => {
    const test = harness({
      apps: [
        appEntry('app-1', { linkedLaunchIds: ['link-1'] }),
        appEntry('app-2', { linkedLaunchIds: ['link-1'] })
      ],
      linked: [linked('link-1')]
    })
    test.runtime.track('linked:link-1', test.clock.now())

    expect(await test.controller.prepareLinkedLaunch({
      senderId: 11,
      windowId: 7,
      mainWindow: test.main,
      linkedId: 'link-1',
      launchPid: 123
    })).toBe(false)
    expect(await test.controller.prepareLinkedLaunch({
      senderId: 11,
      windowId: 7,
      mainWindow: test.main,
      linkedId: 'link-1',
      ownerAppId: 'app-3',
      launchPid: 123
    })).toBe(false)
    expect(test.controller.commitLaunch({
      senderId: 11,
      windowId: 7,
      runtimeKey: 'linked:link-1',
      reducedMotion: false
    })).toBe(false)
    await test.controller.dispose()
  })

  it('honours a hint only when that app still owns the linked launch', async () => {
    const test = harness({
      apps: [
        appEntry('app-1', { linkedLaunchIds: ['link-1'] }),
        appEntry('app-2', { linkedLaunchIds: ['link-1'] })
      ],
      linked: [linked('link-1')]
    })
    test.runtime.track('linked:link-1', test.clock.now())

    expect(await test.controller.prepareLinkedLaunch({
      senderId: 11,
      windowId: 7,
      mainWindow: test.main,
      linkedId: 'link-1',
      ownerAppId: 'app-2',
      launchPid: 123
    })).toBe(true)
    expect(test.controller.commitLaunch({
      senderId: 11,
      windowId: 7,
      runtimeKey: 'linked:link-1',
      reducedMotion: false
    })).toBe(true)
    await test.controller.dispose()
  })

  it('still shows the linked HUD directly when absorption is off', async () => {
    const test = harness({
      apps: [appEntry('app-1', { linkedLaunchIds: ['link-1'] }, hudConfig(false))],
      linked: [linked('link-1')]
    })
    test.runtime.track('linked:link-1', test.clock.now())

    expect(await test.controller.prepareLinkedLaunch({
      senderId: 11,
      windowId: 7,
      mainWindow: test.main,
      linkedId: 'link-1',
      launchPid: 123
    })).toBe(true)
    expect(test.controller.commitLaunch({
      senderId: 11,
      windowId: 7,
      runtimeKey: 'linked:link-1',
      reducedMotion: false
    })).toBe(true)
    await settle()

    expect(test.order).toEqual(['display'])
    expect(test.window.frames[0]?.appName).toBe('联动启动')
    expect(test.departure).not.toHaveBeenCalled()
    expect(test.main.hide).not.toHaveBeenCalled()
    expect(test.main.isVisible()).toBe(true)
    await test.controller.dispose()
  })
})

describe('Kevin HUD live settings', () => {
  async function enterResidentMonitor(test: Harness): Promise<void> {
    await settle()
    await test.clock.advance(2_000)
    expect(test.controller.getLatestHudFrame()?.phase).toBe('monitor')
  }

  it('updates a visible real HUD in place without another show or departure', async () => {
    const resident = hudConfig(true, {
      alwaysVisible: true,
      sampleSeconds: 1,
      metrics: ['sessionTime'],
      width: 420
    })
    const test = harness({
      apps: [appEntry('app-1', { kevinHud: resident })]
    })
    test.runtime.track('app-1', test.clock.now())
    expect(await prepareApp(test)).toBe(true)
    expect(test.controller.commitLaunch({
      senderId: 11,
      windowId: 7,
      runtimeKey: 'app-1',
      reducedMotion: false
    })).toBe(true)
    await enterResidentMonitor(test)

    const displays = test.window.events.filter((event) => event === 'display').length
    const departures = test.departure.mock.calls.length
    const next = hudConfig(true, {
      ...resident,
      width: 640,
      backgroundColor: '#123456'
    })
    expect(test.controller.updateLive('app-1', next)).toBe(true)
    await settle()

    expect(test.window.frames.at(-1)).toMatchObject({
      phase: 'monitor',
      config: { width: 640, backgroundColor: '#123456' }
    })
    expect(test.controller.getLatestHudFrame()?.config.width).toBe(640)
    expect(test.window.events.filter((event) => event === 'display')).toHaveLength(displays)
    expect(test.departure).toHaveBeenCalledTimes(departures)
    expect(test.main.hide).toHaveBeenCalledOnce()
    await test.controller.dispose()
  })

  it('amends an issued ticket without opening a window and keeps launch-time absorption', async () => {
    const initial = hudConfig(true, {
      displaySeconds: 3,
      metrics: []
    })
    const test = harness({
      apps: [appEntry('app-1', { kevinHud: initial })]
    })
    test.runtime.track('app-1', test.clock.now())
    expect(await prepareApp(test)).toBe(true)
    expect(test.window.events).toHaveLength(0)

    const next = hudConfig(false, {
      displaySeconds: 3,
      width: 555,
      metrics: []
    })
    expect(test.controller.updateLive('app-1', next)).toBe(true)
    expect(test.window.events).toHaveLength(0)
    expect(test.window.frames).toHaveLength(0)

    expect(test.controller.commitLaunch({
      senderId: 11,
      windowId: 7,
      runtimeKey: 'app-1',
      reducedMotion: false
    })).toBe(true)
    await settle()
    // The updated render settings are used, but absorption stays the decision
    // captured when the launch ticket was issued.
    expect(test.window.frames[0]?.config.width).toBe(555)
    expect(test.window.frames[0]?.config.absorbLauncher).toBe(false)
    expect(test.departure).toHaveBeenCalledOnce()
    expect(test.main.hide).toHaveBeenCalledOnce()
    await test.controller.dispose()
  })

  it('is a no-op for an unbound app, a mismatched app and malformed settings', async () => {
    const test = harness({
      apps: [appEntry('app-1')]
    })
    expect(test.controller.updateLive('app-1', hudConfig(true))).toBe(false)
    expect(test.controller.updateLive('missing', hudConfig(true))).toBe(false)
    expect(test.controller.updateLive('app-1', null)).toBe(false)
    expect(test.window.events).toHaveLength(0)
    await test.controller.dispose()
  })

  it('updates both the preview and the paused real HUD, then resumes with the new snapshot', async () => {
    const resident = hudConfig(true, {
      alwaysVisible: true,
      sampleSeconds: 1,
      metrics: ['sessionTime']
    })
    const test = harness({
      apps: [appEntry('app-1', { kevinHud: resident })]
    })
    test.runtime.track('app-1', test.clock.now())
    expect(await prepareApp(test)).toBe(true)
    expect(test.controller.commitLaunch({
      senderId: 11,
      windowId: 7,
      runtimeKey: 'app-1',
      reducedMotion: false
    })).toBe(true)
    await enterResidentMonitor(test)

    await test.controller.preview('app-1', hudConfig(true, {
      alwaysVisible: true,
      displaySeconds: 3,
      metrics: ['fps'],
      width: 380
    }))
    await settle()
    const displays = test.window.events.filter((event) => event === 'display').length

    const next = hudConfig(true, {
      alwaysVisible: true,
      displaySeconds: 3,
      sampleSeconds: 2,
      metrics: ['sessionTime', 'gpu'],
      width: 700
    })
    expect(test.controller.updateLive('app-1', next)).toBe(true)
    await settle()
    expect(test.window.frames.at(-1)).toMatchObject({
      phase: 'announce',
      appName: '原神',
      config: { width: 700, metrics: ['sessionTime', 'gpu'] }
    })
    expect(test.window.events.filter((event) => event === 'display')).toHaveLength(displays)

    test.controller.dismissPreview()
    await test.clock.advance(10)
    await settle()
    expect(test.window.frames.at(-1)).toMatchObject({
      phase: 'monitor',
      appName: '原神',
      config: { width: 700, metrics: ['sessionTime', 'gpu'] }
    })
    expect(test.showMainWindow).not.toHaveBeenCalled()
    await test.controller.dispose()
  })

  it('never resumes a real HUD disabled by a live update after the preview closes', async () => {
    const resident = hudConfig(true, {
      alwaysVisible: true,
      restoreLauncher: true,
      sampleSeconds: 1,
      metrics: ['sessionTime']
    })
    const test = harness({
      apps: [appEntry('app-1', { kevinHud: resident })]
    })
    test.runtime.track('app-1', test.clock.now())
    expect(await prepareApp(test)).toBe(true)
    expect(test.controller.commitLaunch({
      senderId: 11,
      windowId: 7,
      runtimeKey: 'app-1',
      reducedMotion: false
    })).toBe(true)
    await enterResidentMonitor(test)
    await test.controller.preview('app-1', hudConfig(true, {
      displaySeconds: 3
    }))
    await settle()

    expect(test.controller.updateLive('app-1', hudConfig(true, {
      enabled: false,
      alwaysVisible: true,
      restoreLauncher: true
    }))).toBe(true)
    await settle()
    const shows = test.window.events.filter((event) => event === 'display').length

    test.controller.dismissPreview()
    await test.clock.advance(10)
    await settle()
    expect(test.window.events.filter((event) => event === 'display')).toHaveLength(shows)
    expect(test.showMainWindow).toHaveBeenCalledOnce()
    expect(test.window.frames.at(-1)?.phase).toBe('exit')
    await test.controller.dispose()
  })
})

describe('Kevin HUD preview and ready boundary', () => {
  it('normalizes preview input and uses the selected app, not renderer paths', async () => {
    const test = harness({ apps: [appEntry('app-1')] })
    await test.controller.preview('app-1', {
      width: 9_999,
      height: 1,
      metrics: ['fps', 'fps', 'bogus'],
      backgroundColor: 'javascript:alert(1)'
    })
    await settle()
    expect(test.departure).not.toHaveBeenCalled()
    const frame = test.window.frames[0]
    expect(frame?.config.width).toBe(1_600)
    expect(frame?.config.height).toBe(24)
    expect(frame?.config.metrics).toEqual(['fps'])
    expect(frame?.config.backgroundColor).toBe(DEFAULT_KEVIN_HUD.backgroundColor)

    test.controller.dismissPreview()
    await settle()
    expect(test.window.frames.at(-1)?.phase).toBe('exit')
    // The preview now closes only after its configured reverse timeline; the
    // fixture's exit delay is 10 ms.
    await test.clock.advance(10)
    expect(test.window.closeCalls).toBeGreaterThan(0)
    await expect(test.controller.preview('app-does-not-exist', {})).rejects.toThrow('应用不存在')
    await test.controller.dispose()
  })

  it('watches the preview sender window so a first-op preview cannot outlive the launcher', async () => {
    const test = harness({ apps: [appEntry('app-1')] })
    const sender = closeableWindow(9)
    const unrelated = closeableWindow(10)

    await test.controller.preview('app-1', {}, sender.window)
    await settle()
    expect(test.window.events).toEqual(['display'])
    unrelated.close()
    await settle()
    expect(test.window.closeCalls).toBe(0)

    sender.close()
    await settle()
    expect(test.window.closeCalls).toBeGreaterThan(0)
    expect(test.controller.getLatestHudFrame()).toBeNull()
    await test.controller.dispose()
  })

  it('authenticates the exact HUD document main frame token', async () => {
    const url = 'https://hud.invalid/hud.html?kevinHud=1&kevinHudToken=abcdef'
    const test = harness({ apps: [], hudPage: { token: 'abcdef', url } })
    const hudContents = { id: 99 }
    test.window.ownsWebContents = (contents) => contents === hudContents
    expect(test.controller.isTrustedHudPage(url)).toBe(true)
    expect(test.controller.isTrustedHudPage(`${url}&extra=1`)).toBe(false)
    expect(test.controller.isTrustedHudPage('https://hud.invalid/hud.html?kevinHud=1')).toBe(false)
    expect(test.controller.isTrustedHudPage(url.replace('abcdef', 'evil'))).toBe(false)
    expect(test.controller.isTrustedHudPage(`${url}#x`)).toBe(false)
    expect(test.controller.ownsHudContents(hudContents)).toBe(true)
    expect(test.controller.ownsHudContents({ id: 100 })).toBe(false)
    await test.controller.dispose()
  })
})
