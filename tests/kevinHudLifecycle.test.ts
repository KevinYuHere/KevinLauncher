import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_KEVIN_HUD,
  normalizeKevinHudConfig,
  type KevinHudConfig,
  type KevinHudFrame
} from '@shared/kevinHud'
import { DEFAULT_GLASS_APPEARANCE } from '@shared/types'
import {
  KEVIN_HUD_ANNOUNCE_MS,
  KevinHudLifecycle,
  type KevinHudClock,
  type KevinHudHotkeyPort,
  type KevinHudLifecycleDependencies,
  type KevinHudMetricValues,
  type KevinHudRuntimeIdentity,
  type KevinHudRuntimePort,
  type KevinHudSampleContext,
  type KevinHudWindowPort
} from '../src/main/services/kevinHudLifecycle'

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
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
    const id = this.nextId
    this.nextId += 1
    this.timers.set(id, { id, at: this.time + Math.max(0, delayMs), callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.timers.delete(handle)
  }

  get pending(): number {
    return this.timers.size
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

type WindowCall =
  | { method: 'show' | 'update' | 'retract'; frame: KevinHudFrame }

class VirtualHudWindow implements KevinHudWindowPort {
  readonly calls: WindowCall[] = []
  readonly showFrames: KevinHudFrame[] = []
  readonly updateFrames: KevinHudFrame[] = []
  readonly retractFrames: KevinHudFrame[] = []
  hideCount = 0
  visible = false
  retractGate: Promise<void> | null = null
  showGate: Promise<void> | null = null

  async show(frame: KevinHudFrame): Promise<void> {
    this.calls.push({ method: 'show', frame })
    this.showFrames.push(frame)
    if (this.showGate) await this.showGate
    this.visible = true
  }

  update(frame: KevinHudFrame): void {
    this.calls.push({ method: 'update', frame })
    this.updateFrames.push(frame)
  }

  async retract(frame: KevinHudFrame): Promise<void> {
    this.calls.push({ method: 'retract', frame })
    this.retractFrames.push(frame)
    if (this.retractGate) await this.retractGate
  }

  hide(): void {
    this.hideCount += 1
    this.visible = false
  }

  get lastCall(): WindowCall | null {
    return this.calls.at(-1) ?? null
  }
}

class VirtualRuntime implements KevinHudRuntimePort {
  private identities: readonly KevinHudRuntimeIdentity[] = []
  private readonly listeners = new Set<() => void>()

  list(): readonly KevinHudRuntimeIdentity[] {
    return this.identities
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  set(identities: readonly KevinHudRuntimeIdentity[]): void {
    this.identities = identities
    for (const listener of [...this.listeners]) listener()
  }

  get listenerCount(): number {
    return this.listeners.size
  }
}

interface HotkeyRegistration {
  accelerator: string
  toggle: () => void
  release: ReturnType<typeof vi.fn>
}

class VirtualHotkeys implements KevinHudHotkeyPort {
  readonly registrations: HotkeyRegistration[] = []
  fail = false

  register(accelerator: string, onToggle: () => void): () => void {
    if (this.fail) throw new Error('accelerator rejected')
    const release = vi.fn()
    this.registrations.push({ accelerator, toggle: onToggle, release })
    return release
  }

  get current(): HotkeyRegistration | undefined {
    return this.registrations.at(-1)
  }
}

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function config(patch: Partial<KevinHudConfig> = {}): KevinHudConfig {
  return normalizeKevinHudConfig({ ...DEFAULT_KEVIN_HUD, ...patch })
}

interface Harness {
  clock: FakeClock
  window: VirtualHudWindow
  runtime: VirtualRuntime
  hotkeys: VirtualHotkeys
  sampler: ReturnType<typeof vi.fn<(context: KevinHudSampleContext) => KevinHudMetricValues>>
  shell: { waitForMainWindowCollapse: ReturnType<typeof vi.fn>; restoreLauncher: ReturnType<typeof vi.fn> }
  lifecycle: KevinHudLifecycle
}

function harness(options: {
  collapse?: Promise<void>
  hotkeys?: VirtualHotkeys
  config?: KevinHudConfig
} = {}): Harness {
  const clock = new FakeClock()
  const window = new VirtualHudWindow()
  const runtime = new VirtualRuntime()
  const hotkeys = options.hotkeys ?? new VirtualHotkeys()
  const sampler = vi.fn(({ runtimeKey, metrics }: KevinHudSampleContext): KevinHudMetricValues => {
    const values: KevinHudMetricValues = {}
    for (const metric of metrics) values[metric] = `${runtimeKey}:${metric}`
    return values
  })
  const shell = {
    waitForMainWindowCollapse: vi.fn(() => options.collapse ?? Promise.resolve()),
    restoreLauncher: vi.fn()
  }
  const deps: KevinHudLifecycleDependencies = {
    window,
    runtime,
    sampler: { sample: sampler },
    shell,
    hotkeys,
    clock
  }
  return { clock, window, runtime, hotkeys, sampler, shell, lifecycle: new KevinHudLifecycle(deps) }
}

function launch(
  test: Harness,
  runtimeKey: string,
  appName: string,
  hudConfig: KevinHudConfig,
  options: { absorbLauncher?: boolean } = {}
): void {
  const request = test.lifecycle.prepareLaunch({
    runtimeKey,
    appName,
    config: hudConfig,
    iconUrl: `app://${runtimeKey}.png`,
    fontFamily: `${appName} Sans`,
    appGlass: DEFAULT_GLASS_APPEARANCE,
    absorbLauncher: options.absorbLauncher
  })
  expect(request).not.toBeNull()
  expect(test.lifecycle.commitLaunch(request!)).toBe(true)
}

async function enterPersistentMonitor(test: Harness, sample = true): Promise<void> {
  await settle()
  await test.clock.advance(KEVIN_HUD_ANNOUNCE_MS)
  if (sample) await test.clock.advance(1000)
  await settle()
}

describe('KEVIN HUD lifecycle', () => {
  it('waits for the real main-window collapse before a one-shot 6s transient and restores the launcher', async () => {
    const collapse = deferred()
    const test = harness({ collapse: collapse.promise })
    const request = test.lifecycle.prepareLaunch({
      runtimeKey: 'app-a',
      appName: 'Game A',
      config: config({ alwaysVisible: false, restoreLauncher: true }),
      iconUrl: 'app://a.png',
      fontFamily: 'Test Sans',
      appGlass: DEFAULT_GLASS_APPEARANCE
    })
    expect(request).not.toBeNull()
    expect(test.lifecycle.commitLaunch(request!)).toBe(true)
    // One ticket, one HUD request. A replay must not schedule anything.
    expect(test.lifecycle.commitLaunch(request!)).toBe(false)
    expect(test.shell.waitForMainWindowCollapse).toHaveBeenCalledOnce()
    await settle()
    expect(test.window.calls).toHaveLength(0)
    expect(test.lifecycle.getState()).toMatchObject({ phase: 'announce', visible: false, activeSessions: 1 })

    collapse.resolve()
    await settle()
    expect(test.window.showFrames).toHaveLength(1)
    expect(test.window.showFrames[0]).toMatchObject({
      phase: 'announce',
      appName: 'Game A',
      iconUrl: 'app://a.png',
      fontFamily: 'Test Sans',
      values: {}
    })
    expect(test.window.showFrames[0].appGlass).toEqual(DEFAULT_GLASS_APPEARANCE)
    expect(test.lifecycle.getState()).toMatchObject({ phase: 'announce', visible: true })

    await test.clock.advance(5_999)
    expect(test.window.retractFrames).toHaveLength(0)
    const retractGate = deferred()
    test.window.retractGate = retractGate.promise
    await test.clock.advance(1)
    expect(test.window.retractFrames).toHaveLength(1)
    expect(test.window.retractFrames[0].phase).toBe('exit')
    // The reverse animation, hide and launcher restore are ordered.
    expect(test.window.hideCount).toBe(0)
    expect(test.shell.restoreLauncher).not.toHaveBeenCalled()
    retractGate.resolve()
    await settle()
    expect(test.window.hideCount).toBe(1)
    expect(test.shell.restoreLauncher).toHaveBeenCalledOnce()
    expect(test.sampler).not.toHaveBeenCalled()
    expect(test.runtime.listenerCount).toBe(0)
    expect(test.clock.pending).toBe(0)
    expect(test.lifecycle.getState()).toMatchObject({
      phase: 'idle',
      visible: false,
      activeSessions: 0,
      appName: null
    })

    expect(test.lifecycle.prepareLaunch({
      runtimeKey: 'disabled',
      appName: 'Disabled',
      config: config({ enabled: false })
    })).toBeNull()
    test.lifecycle.dispose()
  })

  it('never restores the launcher after a non-absorbing HUD ends, even when restoreLauncher is true', async () => {
    const test = harness()
    launch(test, 'app-a', 'Game A', config({
      alwaysVisible: false,
      displaySeconds: 3,
      restoreLauncher: true
    }), { absorbLauncher: false })
    await settle()

    // The HUD still starts from the normal launch entry and shows its launch
    // frame; the shell is never asked to collapse or restore the launcher.
    expect(test.shell.waitForMainWindowCollapse).not.toHaveBeenCalled()
    expect(test.window.showFrames).toHaveLength(1)
    expect(test.window.showFrames[0]).toMatchObject({ phase: 'announce', appName: 'Game A' })

    await test.clock.advance(3_000)
    await settle()
    expect(test.window.hideCount).toBe(1)
    expect(test.shell.restoreLauncher).not.toHaveBeenCalled()
    expect(test.lifecycle.getState()).toMatchObject({ phase: 'idle', visible: false })
    test.lifecycle.dispose()
  })

  it('announces for about two seconds, samples only while visible, and releases the toggle hotkey', async () => {
    const hotkeys = new VirtualHotkeys()
    const test = harness({ hotkeys })
    launch(test, 'app-a', 'Game A', config({
      alwaysVisible: true,
      sampleSeconds: 1,
      hotkey: 'Alt+Shift+H',
      metrics: ['fps', 'clock'],
      restoreLauncher: true
    }))
    await settle()
    expect(test.window.showFrames[0]).toMatchObject({ phase: 'announce' })

    await test.clock.advance(KEVIN_HUD_ANNOUNCE_MS - 1)
    expect(test.window.updateFrames).toHaveLength(0)
    await test.clock.advance(1)
    expect(test.window.updateFrames.at(-1)).toMatchObject({ phase: 'monitor' })
    expect(hotkeys.registrations).toHaveLength(1)
    expect(hotkeys.current?.accelerator).toBe('Alt+Shift+H')

    await test.clock.advance(1_000)
    expect(test.sampler).toHaveBeenCalledOnce()
    expect(test.sampler.mock.calls[0][0]).toMatchObject({ runtimeKey: 'app-a', metrics: ['fps', 'clock'] })
    expect(test.window.updateFrames.at(-1)?.values).toEqual({ fps: 'app-a:fps', clock: 'app-a:clock' })

    // Runtime has only seen the wrapper so far; the monitor keeps waiting.
    test.runtime.set([{ key: 'app-a', confirmed: false }])
    await settle()
    expect(test.window.retractFrames).toHaveLength(0)
    expect(test.lifecycle.getState()).toMatchObject({ phase: 'monitor', visible: true })

    hotkeys.current?.toggle()
    await settle()
    expect(test.lifecycle.getState()).toMatchObject({ phase: 'monitor', visible: false })
    expect(test.window.retractFrames).toHaveLength(1)
    expect(test.window.retractFrames[0]).toMatchObject({
      phase: 'exit',
      appName: 'Game A',
      values: { fps: 'app-a:fps', clock: 'app-a:clock' }
    })
    expect(hotkeys.current?.release).not.toHaveBeenCalled()
    const callsWhileHidden = test.sampler.mock.calls.length
    await test.clock.advance(10_000)
    expect(test.sampler).toHaveBeenCalledTimes(callsWhileHidden)

    hotkeys.current?.toggle()
    await settle()
    expect(test.lifecycle.getState()).toMatchObject({ phase: 'monitor', visible: true })
    expect(hotkeys.registrations).toHaveLength(1)
    await test.clock.advance(1_000)
    expect(test.sampler.mock.calls.length).toBe(callsWhileHidden + 1)

    test.runtime.set([{ key: 'app-a', confirmed: true }])
    await settle()
    test.runtime.set([])
    await settle()
    expect(test.window.retractFrames.at(-1)).toMatchObject({ phase: 'exit' })
    expect(hotkeys.current?.release).toHaveBeenCalledOnce()
    expect(test.shell.restoreLauncher).toHaveBeenCalledOnce()
    expect(test.runtime.listenerCount).toBe(0)
    expect(test.clock.pending).toBe(0)
    test.lifecycle.dispose()
  })

  it('ignores a late hotkey retraction after a fast show and still hides on the next press', async () => {
    const hotkeys = new VirtualHotkeys()
    const test = harness({ hotkeys })
    test.runtime.set([{ key: 'app-a', confirmed: true }])
    launch(test, 'app-a', 'Game A', config({
      alwaysVisible: true,
      sampleSeconds: 1,
      metrics: ['fps'],
      hotkey: 'Ctrl+Alt+K'
    }))
    await enterPersistentMonitor(test)
    const callsBeforeHide = test.sampler.mock.calls.length

    const first = deferred()
    test.window.retractGate = first.promise
    hotkeys.current?.toggle()
    await settle()
    expect(test.window.retractFrames).toHaveLength(1)
    expect(test.window.retractFrames[0]).toMatchObject({
      phase: 'exit',
      appName: 'Game A',
      values: { fps: 'app-a:fps' }
    })
    expect(test.window.hideCount).toBe(0)
    expect(test.lifecycle.getState()).toMatchObject({ phase: 'monitor', visible: true })
    await test.clock.advance(5_000)
    expect(test.sampler).toHaveBeenCalledTimes(callsBeforeHide)

    // Show while the old reverse timeline is still waiting. Its late
    // completion must not hide this newer view or unregister the shortcut.
    hotkeys.current?.toggle()
    await settle()
    expect(test.lifecycle.getState()).toMatchObject({ phase: 'monitor', visible: true })
    expect(hotkeys.registrations).toHaveLength(1)
    expect(hotkeys.current?.release).not.toHaveBeenCalled()
    test.window.retractGate = null
    first.resolve()
    await settle()
    expect(test.window.hideCount).toBe(0)
    await test.clock.advance(1_000)
    expect(test.sampler.mock.calls.length).toBe(callsBeforeHide + 1)

    const second = deferred()
    test.window.retractGate = second.promise
    hotkeys.current?.toggle()
    await settle()
    expect(test.window.retractFrames).toHaveLength(2)
    expect(test.window.hideCount).toBe(0)
    second.resolve()
    await settle()
    expect(test.window.hideCount).toBe(1)
    expect(test.lifecycle.getState()).toMatchObject({ phase: 'monitor', visible: false })
    expect(hotkeys.current?.release).not.toHaveBeenCalled()
    test.lifecycle.dispose()
  })

  it('cancels a pending hotkey show when the shortcut hides again', async () => {
    const hotkeys = new VirtualHotkeys()
    const test = harness({ hotkeys })
    test.runtime.set([{ key: 'app-a', confirmed: true }])
    launch(test, 'app-a', 'Game A', config({
      alwaysVisible: true,
      sampleSeconds: 1,
      metrics: ['fps'],
      hotkey: 'Ctrl+Alt+K'
    }))
    await enterPersistentMonitor(test)

    // Hide once so the next show actually has to create/finish a view.
    hotkeys.current?.toggle()
    await settle()
    expect(test.window.hideCount).toBe(1)
    expect(test.lifecycle.getState()).toMatchObject({ visible: false })

    const showGate = deferred()
    test.window.showGate = showGate.promise
    hotkeys.current?.toggle()
    await settle()
    expect(test.lifecycle.getState()).toMatchObject({ visible: false })
    // Hide again while the show is still pending. Its late completion is stale
    // and must hide the native window instead of resurrecting it.
    hotkeys.current?.toggle()
    await settle()
    expect(test.lifecycle.getState()).toMatchObject({ visible: false })

    showGate.resolve()
    await settle()
    expect(test.window.visible).toBe(false)
    expect(test.window.hideCount).toBe(2)
    expect(test.lifecycle.getState()).toMatchObject({ visible: false, phase: 'monitor' })
    expect(hotkeys.current?.release).not.toHaveBeenCalled()
    test.lifecycle.dispose()
  })

  it('keeps lock immediate during a hotkey retraction and re-registers show afterwards', async () => {
    const hotkeys = new VirtualHotkeys()
    const test = harness({ hotkeys })
    test.runtime.set([{ key: 'app-a', confirmed: true }])
    launch(test, 'app-a', 'Game A', config({
      alwaysVisible: true,
      sampleSeconds: 1,
      metrics: ['fps'],
      hotkey: 'Ctrl+Alt+K'
    }))
    await enterPersistentMonitor(test)

    const gate = deferred()
    test.window.retractGate = gate.promise
    hotkeys.current?.toggle()
    await settle()
    expect(test.window.retractFrames).toHaveLength(1)
    expect(test.window.hideCount).toBe(0)

    test.lifecycle.setLocked(true)
    await settle()
    expect(test.window.hideCount).toBe(1)
    expect(test.lifecycle.getState()).toMatchObject({ locked: true, visible: false })
    expect(hotkeys.current?.release).toHaveBeenCalledOnce()
    gate.resolve()
    await settle()
    // The aborted retraction must not hide or otherwise touch the locked view.
    expect(test.window.hideCount).toBe(1)

    test.lifecycle.setLocked(false)
    await settle()
    expect(test.lifecycle.getState()).toMatchObject({ locked: false, visible: false })
    expect(hotkeys.registrations).toHaveLength(2)
    hotkeys.current?.toggle()
    await settle()
    expect(test.lifecycle.getState()).toMatchObject({ visible: true, phase: 'monitor' })
    test.lifecycle.dispose()
  })

  it('lets a preview replace an in-flight hotkey retraction without a stale hide', async () => {
    const hotkeys = new VirtualHotkeys()
    const test = harness({ hotkeys })
    test.runtime.set([{ key: 'app-a', confirmed: true }])
    launch(test, 'app-a', 'Game A', config({
      alwaysVisible: true,
      sampleSeconds: 1,
      metrics: ['fps'],
      hotkey: 'Ctrl+Alt+K'
    }))
    await enterPersistentMonitor(test)

    const gate = deferred()
    test.window.retractGate = gate.promise
    hotkeys.current?.toggle()
    await settle()
    expect(test.window.retractFrames).toHaveLength(1)

    const preview = test.lifecycle.startPreview({
      appName: 'Preview App',
      config: config({ alwaysVisible: false, displaySeconds: 3 }),
      durationMs: 3_000
    })
    expect(preview).not.toBeNull()
    await settle()
    expect(test.lifecycle.getState()).toMatchObject({
      preview: true,
      visible: true,
      appName: 'Preview App'
    })
    gate.resolve()
    await settle()
    expect(test.window.hideCount).toBe(0)
    expect(test.lifecycle.getState()).toMatchObject({
      preview: true,
      visible: true,
      appName: 'Preview App'
    })

    preview!.dismiss()
    await settle()
    expect(test.window.hideCount).toBe(1)
    expect(test.lifecycle.getState()).toMatchObject({
      preview: false,
      visible: false,
      phase: 'monitor'
    })
    expect(hotkeys.registrations).toHaveLength(2)
    test.lifecycle.dispose()
  })

  it('reuses an in-flight hotkey retraction when Runtime ends the game', async () => {
    const hotkeys = new VirtualHotkeys()
    const test = harness({ hotkeys })
    test.runtime.set([{ key: 'app-a', confirmed: true }])
    launch(test, 'app-a', 'Game A', config({
      alwaysVisible: true,
      sampleSeconds: 1,
      metrics: ['fps'],
      hotkey: 'Ctrl+Alt+K',
      restoreLauncher: true
    }))
    await enterPersistentMonitor(test)

    const gate = deferred()
    test.window.retractGate = gate.promise
    hotkeys.current?.toggle()
    await settle()
    expect(test.window.retractFrames).toHaveLength(1)
    expect(test.window.hideCount).toBe(0)

    test.runtime.set([])
    await settle()
    expect(test.lifecycle.getState()).toMatchObject({ visible: true, activeSessions: 0 })
    expect(test.window.retractFrames).toHaveLength(1)
    expect(test.window.hideCount).toBe(0)
    expect(hotkeys.current?.release).toHaveBeenCalledOnce()
    expect(test.shell.restoreLauncher).not.toHaveBeenCalled()

    gate.resolve()
    await settle()
    expect(test.window.retractFrames).toHaveLength(1)
    expect(test.window.hideCount).toBe(1)
    expect(test.shell.restoreLauncher).toHaveBeenCalledOnce()
    expect(test.runtime.listenerCount).toBe(0)
    expect(test.clock.pending).toBe(0)
    expect(test.lifecycle.getState()).toMatchObject({ phase: 'idle', visible: false, activeSessions: 0 })
    test.lifecycle.dispose()
  })

  it('previews on the same physical window without sampling or launching, then restores the live HUD', async () => {
    const test = harness()
    launch(test, 'app-a', 'Game A', config({
      alwaysVisible: true,
      sampleSeconds: 1,
      metrics: ['fps', 'memory'],
      restoreLauncher: true
    }))
    await enterPersistentMonitor(test)
    expect(test.window.updateFrames.at(-1)?.values).toEqual({
      fps: 'app-a:fps',
      memory: 'app-a:memory'
    })
    const samplesBeforePreview = test.sampler.mock.calls.length
    const collapsesBeforePreview = test.shell.waitForMainWindowCollapse.mock.calls.length
    const previewConfig = config({ alwaysVisible: false, displaySeconds: 3, metrics: ['cpu'] })
    const previewSnapshot = JSON.stringify(previewConfig)

    const handle = test.lifecycle.startPreview({
      appName: 'Preview App',
      config: previewConfig,
      iconUrl: 'app://preview.png',
      fontFamily: 'Preview Sans',
      durationMs: 3_000
    })
    expect(handle).not.toBeNull()
    await settle()
    expect(test.window.lastCall).toMatchObject({
      method: 'show',
      frame: { phase: 'announce', appName: 'Preview App', iconUrl: 'app://preview.png' }
    })
    expect(test.lifecycle.getState()).toMatchObject({
      preview: true,
      visible: true,
      appName: 'Preview App'
    })
    // A preview neither samples the live game nor asks the launcher to
    // collapse / launch anything, and it does not mutate the supplied config.
    expect(test.sampler).toHaveBeenCalledTimes(samplesBeforePreview)
    expect(test.shell.waitForMainWindowCollapse).toHaveBeenCalledTimes(collapsesBeforePreview)
    expect(JSON.stringify(previewConfig)).toBe(previewSnapshot)

    await test.clock.advance(2_999)
    expect(test.window.lastCall).toMatchObject({ frame: { appName: 'Preview App' } })
    await test.clock.advance(1)
    await settle()
    expect(test.lifecycle.getState()).toMatchObject({
      preview: false,
      phase: 'monitor',
      visible: true,
      appName: 'Game A'
    })
    expect(test.window.lastCall).toMatchObject({
      method: 'show',
      frame: {
        appName: 'Game A',
        phase: 'monitor',
        values: { fps: 'app-a:fps', memory: 'app-a:memory' }
      }
    })
    expect(test.sampler).toHaveBeenCalledTimes(samplesBeforePreview)

    const second = test.lifecycle.startPreview({
      appName: 'Preview Two',
      config: previewConfig,
      durationMs: 10_000
    })
    expect(second).not.toBeNull()
    await settle()
    second!.dismiss()
    second!.dismiss()
    await settle()
    expect(test.lifecycle.getState()).toMatchObject({ preview: false, appName: 'Game A' })
    const showsAfterDismiss = test.window.showFrames.length
    await test.clock.advance(10_000)
    expect(test.window.showFrames).toHaveLength(showsAfterDismiss)
    expect(test.shell.restoreLauncher).not.toHaveBeenCalled()
    test.lifecycle.dispose()
  })

  it('plays the reverse preview timeline before hiding on dismiss', async () => {
    const test = harness()
    const gate = deferred()
    test.window.retractGate = gate.promise
    const preview = test.lifecycle.startPreview({
      appName: 'Preview App',
      config: config(),
      durationMs: 5_000
    })
    expect(preview).not.toBeNull()
    await settle()
    expect(test.window.showFrames.at(-1)).toMatchObject({
      phase: 'announce',
      appName: 'Preview App'
    })

    preview!.dismiss()
    await settle()
    expect(test.window.retractFrames).toHaveLength(1)
    expect(test.window.retractFrames[0]).toMatchObject({
      phase: 'exit',
      appName: 'Preview App'
    })
    // The native window must survive until the renderer finishes its reverse
    // timeline; hiding it first would cut the animation off.
    expect(test.window.hideCount).toBe(0)
    expect(test.lifecycle.getState()).toMatchObject({ preview: false, visible: true })

    gate.resolve()
    await settle()
    expect(test.window.hideCount).toBe(1)
    expect(test.lifecycle.getState()).toMatchObject({ preview: false, visible: false })
    expect(test.clock.pending).toBe(0)
    test.lifecycle.dispose()
  })

  it('lets a newer preview replace an exiting preview without the stale hide landing', async () => {
    const test = harness()
    const gate = deferred()
    test.window.retractGate = gate.promise
    const first = test.lifecycle.startPreview({
      appName: 'First Preview',
      config: config(),
      durationMs: 5_000
    })
    await settle()
    first!.dismiss()
    await settle()
    expect(test.window.retractFrames).toHaveLength(1)

    const second = test.lifecycle.startPreview({
      appName: 'Second Preview',
      config: config(),
      durationMs: 5_000
    })
    expect(second).not.toBeNull()
    await settle()
    expect(test.lifecycle.getState()).toMatchObject({
      preview: true,
      visible: true,
      appName: 'Second Preview'
    })
    expect(test.window.hideCount).toBe(0)

    gate.resolve()
    await settle()
    // The first exit's completion is stale and must not hide the new preview.
    expect(test.window.hideCount).toBe(0)
    expect(test.lifecycle.getState()).toMatchObject({
      preview: true,
      visible: true,
      appName: 'Second Preview'
    })
    second!.dismiss()
    await settle()
    test.lifecycle.dispose()
  })

  it('shows the newest launch in one window, keeps each game snapshot independent, and falls back on exit', async () => {
    const test = harness()
    test.runtime.set([{ key: 'app-a', confirmed: true }])
    launch(test, 'app-a', 'Game A', config({
      alwaysVisible: true,
      sampleSeconds: 1,
      metrics: ['fps', 'clock'],
      restoreLauncher: true
    }))
    await enterPersistentMonitor(test)
    expect(test.window.updateFrames.at(-1)?.values).toEqual({
      fps: 'app-a:fps',
      clock: 'app-a:clock'
    })

    test.runtime.set([
      { key: 'app-a', confirmed: true },
      { key: 'linked:tool-b', confirmed: false }
    ])
    launch(test, 'linked:tool-b', 'Game B', config({
      alwaysVisible: true,
      sampleSeconds: 1,
      metrics: ['gpu']
    }))
    await enterPersistentMonitor(test)
    expect(test.window.showFrames.at(-1)).toMatchObject({ appName: 'Game B', phase: 'announce' })
    expect(test.window.updateFrames.at(-1)).toMatchObject({
      appName: 'Game B',
      phase: 'monitor',
      values: { gpu: 'linked:tool-b:gpu' }
    })
    expect(test.sampler.mock.calls.at(-1)?.[0]).toMatchObject({
      runtimeKey: 'linked:tool-b',
      appName: 'Game B',
      metrics: ['gpu']
    })
    expect(test.window.updateFrames.at(-1)?.values).not.toHaveProperty('fps')

    test.runtime.set([
      { key: 'app-a', confirmed: true },
      { key: 'linked:tool-b', confirmed: true }
    ])
    await settle()
    test.runtime.set([{ key: 'app-a', confirmed: true }])
    await settle()
    expect(test.window.retractFrames).toHaveLength(0)
    expect(test.window.lastCall).toMatchObject({
      method: 'show',
      frame: {
        appName: 'Game A',
        phase: 'monitor',
        values: { fps: 'app-a:fps', clock: 'app-a:clock' }
      }
    })
    expect(test.lifecycle.getState()).toMatchObject({ appName: 'Game A', visible: true })

    test.runtime.set([])
    await settle()
    expect(test.window.retractFrames).toHaveLength(1)
    expect(test.window.retractFrames[0]).toMatchObject({ appName: 'Game A', phase: 'exit' })
    expect(test.shell.restoreLauncher).toHaveBeenCalledOnce()
    expect(test.runtime.listenerCount).toBe(0)
    expect(test.clock.pending).toBe(0)
    test.lifecycle.dispose()
  })

  it('suspends and locks the overlay, stops sampling, and defers launcher restoration until it is safe', async () => {
    const hotkeys = new VirtualHotkeys()
    const test = harness({ hotkeys })
    test.runtime.set([{ key: 'app-a', confirmed: true }])
    launch(test, 'app-a', 'Game A', config({
      alwaysVisible: true,
      sampleSeconds: 1,
      metrics: ['fps'],
      hotkey: 'Ctrl+Alt+K',
      restoreLauncher: true
    }))
    await enterPersistentMonitor(test)
    expect(test.sampler).toHaveBeenCalledOnce()
    expect(hotkeys.current?.release).not.toHaveBeenCalled()

    test.lifecycle.setSuspended(true)
    await settle()
    expect(test.lifecycle.getState()).toMatchObject({ suspended: true, visible: false })
    expect(hotkeys.current?.release).toHaveBeenCalledOnce()
    const callsBeforeResume = test.sampler.mock.calls.length
    await test.clock.advance(5_000)
    expect(test.sampler).toHaveBeenCalledTimes(callsBeforeResume)

    test.lifecycle.setSuspended(false)
    await settle()
    expect(test.lifecycle.getState()).toMatchObject({ suspended: false, visible: true, phase: 'monitor' })
    expect(hotkeys.registrations).toHaveLength(2)
    await test.clock.advance(1_000)
    expect(test.sampler.mock.calls.length).toBe(callsBeforeResume + 1)

    test.lifecycle.setLocked(true)
    await settle()
    expect(test.lifecycle.getState()).toMatchObject({ locked: true, visible: false })
    test.runtime.set([])
    await settle()
    expect(test.lifecycle.getState()).toMatchObject({ locked: true, activeSessions: 0 })
    // No reverse animation is played while the desktop is locked.
    expect(test.window.retractFrames).toHaveLength(0)
    expect(test.shell.restoreLauncher).not.toHaveBeenCalled()

    test.lifecycle.setLocked(false)
    await settle()
    expect(test.lifecycle.getState()).toMatchObject({ locked: false, visible: false, activeSessions: 0 })
    expect(test.shell.restoreLauncher).toHaveBeenCalledOnce()
    expect(test.clock.pending).toBe(0)
    test.lifecycle.dispose()
  })

  it('degrades to a working HUD when hotkey registration fails', async () => {
    const hotkeys = new VirtualHotkeys()
    hotkeys.fail = true
    const test = harness({ hotkeys })
    launch(test, 'app-a', 'Game A', config({
      alwaysVisible: true,
      sampleSeconds: 1,
      metrics: ['fps'],
      hotkey: 'Not+A+Real+Accelerator'
    }))
    await enterPersistentMonitor(test)
    expect(test.lifecycle.getState()).toMatchObject({
      phase: 'monitor',
      visible: true,
      hotkeyRegistered: false,
      hotkeyFailed: true
    })
    expect(test.sampler).toHaveBeenCalledOnce()
    expect(hotkeys.registrations).toHaveLength(0)
    test.lifecycle.dispose()
    expect(test.clock.pending).toBe(0)
    expect(test.runtime.listenerCount).toBe(0)
  })

  it('updates a visible monitor in place without showing again or resetting the sampler', async () => {
    const test = harness()
    test.runtime.set([{ key: 'app-a', confirmed: true }])
    launch(test, 'app-a', 'Game A', config({
      alwaysVisible: true,
      sampleSeconds: 1,
      metrics: ['fps']
    }))
    await enterPersistentMonitor(test)
    const shows = test.window.showFrames.length
    const samples = test.sampler.mock.calls.length
    const next = config({
      alwaysVisible: true,
      sampleSeconds: 1,
      metrics: ['fps'],
      width: 520,
      backgroundColor: '#123456'
    })

    expect(test.lifecycle.updateLive('app-a', next)).toBe(true)
    await settle()
    expect(test.window.showFrames).toHaveLength(shows)
    expect(test.window.retractFrames).toHaveLength(0)
    expect(test.window.updateFrames.at(-1)).toMatchObject({
      phase: 'monitor',
      config: { width: 520, backgroundColor: '#123456' }
    })
    expect(test.sampler).toHaveBeenCalledTimes(samples)

    // The existing cadence is untouched: the next tick still belongs to the
    // original poller/session instead of a restarted timer.
    await test.clock.advance(1_000)
    expect(test.sampler.mock.calls.length).toBe(samples + 1)
    test.lifecycle.dispose()
  })

  it('re-arms the existing sampler only when cadence or metrics change', async () => {
    const test = harness()
    test.runtime.set([{ key: 'app-a', confirmed: true }])
    launch(test, 'app-a', 'Game A', config({
      alwaysVisible: true,
      sampleSeconds: 1,
      metrics: ['fps']
    }))
    await settle()
    await test.clock.advance(KEVIN_HUD_ANNOUNCE_MS)
    expect(test.sampler).not.toHaveBeenCalled()

    // Slow the cadence within the legal range. The pending one-second timer
    // must be cleared instead of firing once more.
    expect(test.lifecycle.updateLive('app-a', config({
      alwaysVisible: true,
      sampleSeconds: 4,
      metrics: ['fps']
    }))).toBe(true)
    await test.clock.advance(1_000)
    expect(test.sampler).not.toHaveBeenCalled()
    await test.clock.advance(3_000)
    expect(test.sampler).toHaveBeenCalledOnce()
    expect(test.sampler.mock.calls[0][0].metrics).toEqual(['fps'])

    // A metric change adopts the new five-second cadence on the same session.
    // Four seconds would have fired the old four-second timer, so only the
    // replacement timer can produce this sample with the new metric.
    expect(test.lifecycle.updateLive('app-a', config({
      alwaysVisible: true,
      sampleSeconds: 5,
      metrics: ['gpu']
    }))).toBe(true)
    await test.clock.advance(4_000)
    expect(test.sampler).toHaveBeenCalledOnce()
    await test.clock.advance(1_000)
    expect(test.sampler).toHaveBeenCalledTimes(2)
    expect(test.sampler.mock.calls[1][0]).toMatchObject({ runtimeKey: 'app-a', metrics: ['gpu'] })
    expect(test.window.updateFrames.at(-1)?.values).toMatchObject({ gpu: 'app-a:gpu' })
    expect(test.window.showFrames).toHaveLength(1)
    test.lifecycle.dispose()
  })

  it('refreshes a visible announcement without restarting its countdown', async () => {
    const test = harness()
    launch(test, 'app-a', 'Game A', config({
      alwaysVisible: false,
      displaySeconds: 3,
      metrics: ['fps']
    }), { absorbLauncher: false })
    await settle()
    expect(test.window.showFrames).toHaveLength(1)
    await test.clock.advance(1_000)

    expect(test.lifecycle.updateLive('app-a', config({
      alwaysVisible: false,
      displaySeconds: 3,
      width: 480,
      metrics: []
    }))).toBe(true)
    await settle()
    expect(test.window.showFrames).toHaveLength(1)
    expect(test.window.updateFrames.at(-1)).toMatchObject({
      phase: 'announce',
      config: { width: 480 }
    })

    // An ordinary style/width refresh must not restart the original 3-second
    // countdown while the display duration stays unchanged.
    await test.clock.advance(1_999)
    expect(test.window.retractFrames).toHaveLength(0)
    await test.clock.advance(1)
    await settle()
    expect(test.window.retractFrames).toHaveLength(1)
    test.lifecycle.dispose()
  })

  it('updates the active preview in place without restarting its duration', async () => {
    const test = harness()
    const preview = test.lifecycle.startPreview({
      appName: 'Preview App',
      config: config({ alwaysVisible: false, displaySeconds: 5, metrics: ['fps'], width: 300 }),
      durationMs: 5_000
    })
    expect(preview).not.toBeNull()
    await settle()
    expect(test.window.showFrames).toHaveLength(1)
    await test.clock.advance(1_000)

    expect(test.lifecycle.updatePreview(config({
      alwaysVisible: false,
      displaySeconds: 40,
      metrics: ['gpu'],
      width: 640
    }))).toBe(true)
    await settle()
    expect(test.window.showFrames).toHaveLength(1)
    expect(test.window.updateFrames.at(-1)).toMatchObject({
      phase: 'announce',
      config: { width: 640, metrics: ['gpu'] }
    })
    expect(test.sampler).not.toHaveBeenCalled()

    await test.clock.advance(3_999)
    expect(test.window.retractFrames).toHaveLength(0)
    await test.clock.advance(1)
    await settle()
    expect(test.window.retractFrames).toHaveLength(1)
    test.lifecycle.dispose()
  })

  it('defers real frame updates while the preview exit still owns the surface', async () => {
    const test = harness()
    test.runtime.set([{ key: 'app-a', confirmed: true }])
    launch(test, 'app-a', 'Game A', config({
      alwaysVisible: true,
      sampleSeconds: 1,
      metrics: ['sessionTime']
    }))
    await enterPersistentMonitor(test)
    const gate = deferred()
    test.window.retractGate = gate.promise
    const preview = test.lifecycle.startPreview({
      appName: 'Preview App',
      config: config({ displaySeconds: 3 }),
      durationMs: 5_000
    })
    expect(preview).not.toBeNull()
    await settle()
    preview!.dismiss()
    await settle()
    expect(test.window.retractFrames).toHaveLength(1)
    const shows = test.window.showFrames.length
    const updates = test.window.updateFrames.length

    expect(test.lifecycle.updateLive('app-a', config({
      alwaysVisible: true,
      sampleSeconds: 1,
      metrics: ['gpu'],
      width: 733
    }))).toBe(true)
    await settle()
    expect(test.window.showFrames).toHaveLength(shows)
    expect(test.window.updateFrames).toHaveLength(updates)

    gate.resolve()
    await settle()
    expect(test.window.showFrames).toHaveLength(shows + 1)
    expect(test.window.showFrames.at(-1)).toMatchObject({
      phase: 'monitor',
      config: { width: 733, metrics: ['gpu'] }
    })
    test.lifecycle.dispose()
  })

  it('keeps a locked live snapshot for resume instead of showing it early', async () => {
    const test = harness()
    test.runtime.set([{ key: 'app-a', confirmed: true }])
    launch(test, 'app-a', 'Game A', config({
      alwaysVisible: true,
      sampleSeconds: 1,
      metrics: ['fps']
    }))
    await enterPersistentMonitor(test)
    test.lifecycle.setLocked(true)
    await settle()
    const shows = test.window.showFrames.length
    const updates = test.window.updateFrames.length

    expect(test.lifecycle.updateLive('app-a', config({
      alwaysVisible: true,
      sampleSeconds: 2,
      metrics: ['gpu'],
      width: 712
    }))).toBe(true)
    await settle()
    expect(test.window.showFrames).toHaveLength(shows)
    expect(test.window.updateFrames).toHaveLength(updates)

    test.lifecycle.setLocked(false)
    await settle()
    expect(test.window.showFrames).toHaveLength(shows + 1)
    expect(test.window.showFrames.at(-1)).toMatchObject({
      phase: 'monitor',
      config: { width: 712, metrics: ['gpu'] }
    })
    await test.clock.advance(2_000)
    expect(test.sampler.mock.calls.at(-1)?.[0]).toMatchObject({
      runtimeKey: 'app-a',
      metrics: ['gpu']
    })
    test.lifecycle.dispose()
  })

  it('does not resume a live HUD disabled during a preview', async () => {
    const test = harness()
    test.runtime.set([{ key: 'app-a', confirmed: true }])
    launch(test, 'app-a', 'Game A', config({
      alwaysVisible: true,
      sampleSeconds: 1,
      metrics: ['fps'],
      restoreLauncher: true
    }))
    await enterPersistentMonitor(test)
    const preview = test.lifecycle.startPreview({
      appName: 'Preview App',
      config: config({ displaySeconds: 5 }),
      durationMs: 5_000
    })
    expect(preview).not.toBeNull()
    await settle()

    expect(test.lifecycle.updateLive('app-a', config({
      enabled: false,
      alwaysVisible: true,
      restoreLauncher: true
    }))).toBe(true)
    await settle()
    expect(test.lifecycle.getState()).toMatchObject({
      preview: true,
      activeSessions: 0
    })

    const shows = test.window.showFrames.length
    preview!.dismiss()
    await settle()
    expect(test.window.showFrames).toHaveLength(shows)
    expect(test.lifecycle.getState()).toMatchObject({
      preview: false,
      visible: false,
      activeSessions: 0
    })
    expect(test.shell.restoreLauncher).toHaveBeenCalledOnce()
    test.lifecycle.dispose()
  })

  it('amends an issued launch ticket without touching the window', async () => {
    const test = harness()
    const request = test.lifecycle.prepareLaunch({
      runtimeKey: 'app-a',
      appName: 'Game A',
      config: config({ metrics: ['fps'] })
    })
    expect(request).not.toBeNull()

    expect(test.lifecycle.updatePreparedLaunch(request!, config({
      width: 642,
      metrics: ['gpu']
    }))).toBe(true)
    expect(test.window.calls).toHaveLength(0)
    expect(test.lifecycle.commitLaunch(request!)).toBe(true)
    await settle()
    expect(test.window.showFrames[0]).toMatchObject({
      phase: 'announce',
      config: { width: 642, metrics: ['gpu'] }
    })
    test.lifecycle.dispose()
  })

  it('disposed pending work never opens the window or restores the launcher', async () => {
    const collapse = deferred()
    const showGate = deferred()
    const test = harness({ collapse: collapse.promise })
    test.window.showGate = showGate.promise
    launch(test, 'app-a', 'Game A', config({ alwaysVisible: true, hotkey: 'Ctrl+Shift+H' }))
    const preview = test.lifecycle.startPreview({
      appName: 'Preview',
      config: config(),
      durationMs: 2_000
    })
    expect(preview).not.toBeNull()
    await settle()
    expect(test.window.showFrames).toHaveLength(1)
    expect(test.lifecycle.getState()).toMatchObject({ preview: true, visible: false })

    test.lifecycle.dispose()
    expect(test.window.hideCount).toBe(1)
    expect(test.runtime.listenerCount).toBe(0)
    expect(test.clock.pending).toBe(0)
    // Resolve the in-flight show only after disposal: the stale result must not
    // leave an orphan overlay behind.
    showGate.resolve()
    await settle()
    expect(test.window.visible).toBe(false)
    expect(test.window.hideCount).toBe(2)
    collapse.resolve()
    await settle()
    expect(test.window.showFrames).toHaveLength(1)
    expect(test.shell.restoreLauncher).not.toHaveBeenCalled()
    expect(test.lifecycle.prepareLaunch({
      runtimeKey: 'late',
      appName: 'Late',
      config: config()
    })).toBeNull()
    expect(test.lifecycle.commitLaunch(Object.freeze({
      id: 99,
      runtimeKey: 'late',
      appName: 'Late'
    }))).toBe(false)
    expect(test.lifecycle.startPreview({ appName: 'Late Preview', config: config() })).toBeNull()
  })
})
