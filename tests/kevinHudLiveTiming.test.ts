import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_KEVIN_HUD,
  normalizeKevinHudConfig,
  type KevinHudConfig,
  type KevinHudFrame
} from '@shared/kevinHud'
import {
  KEVIN_HUD_ANNOUNCE_MS,
  KevinHudLifecycle,
  type KevinHudClock,
  type KevinHudHotkeyPort,
  type KevinHudRuntimeIdentity,
  type KevinHudRuntimePort,
  type KevinHudWindowPort
} from '../src/main/services/kevinHudLifecycle'

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

function config(patch: Partial<KevinHudConfig> = {}): KevinHudConfig {
  return normalizeKevinHudConfig({ ...DEFAULT_KEVIN_HUD, ...patch })
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
  scheduledCount = 0

  now(): number {
    return this.time
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId
    this.nextId += 1
    this.scheduledCount += 1
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

class VirtualHudWindow implements KevinHudWindowPort {
  readonly showFrames: KevinHudFrame[] = []
  readonly updateFrames: KevinHudFrame[] = []
  readonly retractFrames: KevinHudFrame[] = []
  hideCount = 0

  async show(frame: KevinHudFrame): Promise<void> {
    this.showFrames.push(frame)
  }

  update(frame: KevinHudFrame): void {
    this.updateFrames.push(frame)
  }

  async retract(frame: KevinHudFrame): Promise<void> {
    this.retractFrames.push(frame)
  }

  hide(): void {
    this.hideCount += 1
  }
}

class VirtualRuntime implements KevinHudRuntimePort {
  list(): readonly KevinHudRuntimeIdentity[] {
    return []
  }

  subscribe(_listener: () => void): () => void {
    return () => {}
  }
}

class VirtualHotkeys implements KevinHudHotkeyPort {
  private readonly releaseFns: Array<ReturnType<typeof vi.fn>> = []

  register(_accelerator: string, _onToggle: () => void): () => void {
    const release = vi.fn()
    this.releaseFns.push(release)
    return release
  }

  get releases(): readonly ReturnType<typeof vi.fn>[] {
    return this.releaseFns
  }
}

interface Harness {
  clock: FakeClock
  window: VirtualHudWindow
  hotkeys: VirtualHotkeys
  shell: {
    waitForMainWindowCollapse: ReturnType<typeof vi.fn>
    restoreLauncher: ReturnType<typeof vi.fn>
  }
  lifecycle: KevinHudLifecycle
}

function harness(): Harness {
  const clock = new FakeClock()
  const window = new VirtualHudWindow()
  const hotkeys = new VirtualHotkeys()
  const shell = {
    waitForMainWindowCollapse: vi.fn(async () => {}),
    restoreLauncher: vi.fn()
  }
  const lifecycle = new KevinHudLifecycle({
    window,
    runtime: new VirtualRuntime(),
    sampler: { sample: () => null },
    shell,
    hotkeys,
    clock
  })
  return { clock, window, hotkeys, shell, lifecycle }
}

function launch(test: Harness, hudConfig: KevinHudConfig): void {
  const request = test.lifecycle.prepareLaunch({
    runtimeKey: 'app-a',
    appName: 'Game A',
    config: hudConfig
  })
  expect(request).not.toBeNull()
  expect(test.lifecycle.commitLaunch(request!)).toBe(true)
}

describe('KEVIN HUD live timing updates', () => {
  it('does not recreate the announce timer for style-only live updates', async () => {
    const test = harness()
    launch(test, config({ alwaysVisible: false, displaySeconds: 4, metrics: [] }))
    await settle()
    await test.clock.advance(1_000)
    const scheduledBefore = test.clock.scheduledCount

    expect(test.lifecycle.updateLive('app-a', config({
      alwaysVisible: false,
      displaySeconds: 4,
      metrics: [],
      borderWidth: 3
    }))).toBe(true)
    await settle()

    expect(test.clock.scheduledCount).toBe(scheduledBefore)
    expect(test.clock.pending).toBe(1)
    expect(test.window.updateFrames.at(-1)?.config.borderWidth).toBe(3)
    await test.clock.advance(2_999)
    expect(test.window.retractFrames).toHaveLength(0)
    await test.clock.advance(1)
    await settle()
    expect(test.window.retractFrames).toHaveLength(1)
    test.lifecycle.dispose()
  })

  it('keeps spent visible time when the transient duration grows', async () => {
    const test = harness()
    launch(test, config({ alwaysVisible: false, displaySeconds: 3, metrics: [] }))
    await settle()
    await test.clock.advance(1_000)

    expect(test.lifecycle.updateLive('app-a', config({
      alwaysVisible: false,
      displaySeconds: 6,
      metrics: []
    }))).toBe(true)
    await settle()

    expect(test.window.showFrames).toHaveLength(1)
    expect(test.shell.waitForMainWindowCollapse).toHaveBeenCalledOnce()
    await test.clock.advance(4_999)
    expect(test.window.retractFrames).toHaveLength(0)
    await test.clock.advance(1)
    await settle()
    expect(test.window.retractFrames).toHaveLength(1)
    test.lifecycle.dispose()
  })

  it('does not consume announce time while locked and applies the new duration on resume', async () => {
    const test = harness()
    launch(test, config({ alwaysVisible: false, displaySeconds: 6, metrics: [] }))
    await settle()
    await test.clock.advance(4_000)

    test.lifecycle.setLocked(true)
    await settle()
    expect(test.clock.pending).toBe(0)
    await test.clock.advance(10_000)

    // Exhaust the duration while paused. The four spent seconds must survive a
    // subsequent longer edit instead of being clamped to the short duration.
    expect(test.lifecycle.updateLive('app-a', config({
      alwaysVisible: false,
      displaySeconds: 3,
      metrics: []
    }))).toBe(true)
    expect(test.clock.pending).toBe(0)
    expect(test.window.retractFrames).toHaveLength(0)

    expect(test.lifecycle.updateLive('app-a', config({
      alwaysVisible: false,
      displaySeconds: 10,
      metrics: []
    }))).toBe(true)
    expect(test.clock.pending).toBe(0)

    test.lifecycle.setLocked(false)
    await settle()
    expect(test.window.showFrames).toHaveLength(2)
    expect(test.clock.pending).toBe(1)
    await test.clock.advance(5_999)
    expect(test.window.retractFrames).toHaveLength(0)
    await test.clock.advance(1)
    await settle()
    expect(test.window.retractFrames).toHaveLength(1)
    test.lifecycle.dispose()
  })

  it('ends an always-visible monitor normally when that setting is turned off', async () => {
    const test = harness()
    launch(test, config({
      alwaysVisible: true,
      displaySeconds: 6,
      metrics: [],
      hotkey: 'Ctrl+Alt+H',
      restoreLauncher: true
    }))
    await settle()
    await test.clock.advance(KEVIN_HUD_ANNOUNCE_MS)
    expect(test.lifecycle.getState()).toMatchObject({ phase: 'monitor', visible: true })
    expect(test.hotkeys.releases).toHaveLength(1)

    expect(test.lifecycle.updateLive('app-a', config({
      alwaysVisible: false,
      displaySeconds: 6,
      metrics: [],
      hotkey: 'Ctrl+Alt+H',
      restoreLauncher: true
    }))).toBe(true)
    await settle()

    expect(test.window.showFrames).toHaveLength(1)
    expect(test.window.retractFrames).toHaveLength(1)
    expect(test.window.retractFrames[0].phase).toBe('exit')
    expect(test.window.hideCount).toBe(1)
    expect(test.hotkeys.releases[0]).toHaveBeenCalledOnce()
    expect(test.shell.restoreLauncher).toHaveBeenCalledOnce()
    expect(test.lifecycle.getState()).toMatchObject({
      phase: 'idle',
      visible: false,
      activeSessions: 0
    })
    test.lifecycle.dispose()
  })

  it('moves straight to the monitor when the new duration is already spent', async () => {
    const test = harness()
    launch(test, config({ alwaysVisible: false, displaySeconds: 10, metrics: [] }))
    await settle()
    await test.clock.advance(6_000)

    expect(test.lifecycle.updateLive('app-a', config({
      alwaysVisible: true,
      displaySeconds: 10,
      metrics: []
    }))).toBe(true)
    await settle()

    expect(test.window.showFrames).toHaveLength(1)
    expect(test.window.retractFrames).toHaveLength(0)
    expect(test.window.updateFrames.at(-1)?.phase).toBe('monitor')
    expect(test.lifecycle.getState()).toMatchObject({ phase: 'monitor', visible: true })
    test.lifecycle.dispose()
  })

  it('leaves naturally when a shortened transient has no visible time left', async () => {
    const test = harness()
    launch(test, config({ alwaysVisible: false, displaySeconds: 10, metrics: [] }))
    await settle()
    await test.clock.advance(6_000)

    expect(test.lifecycle.updateLive('app-a', config({
      alwaysVisible: false,
      displaySeconds: 3,
      metrics: []
    }))).toBe(true)
    await settle()

    expect(test.window.showFrames).toHaveLength(1)
    expect(test.window.retractFrames).toHaveLength(1)
    expect(test.window.hideCount).toBe(1)
    expect(test.lifecycle.getState()).toMatchObject({ phase: 'idle', visible: false })
    test.lifecycle.dispose()
  })

  it('extends an announcement when alwaysVisible is turned off without consuming it twice', async () => {
    const test = harness()
    launch(test, config({ alwaysVisible: true, displaySeconds: 6, metrics: [] }))
    await settle()
    await test.clock.advance(1_000)

    expect(test.lifecycle.updateLive('app-a', config({
      alwaysVisible: false,
      displaySeconds: 6,
      metrics: []
    }))).toBe(true)
    await settle()

    // The original two-second monitor deadline must be gone, but the new six
    // second transient only has five seconds left after the spent second.
    await test.clock.advance(4_999)
    expect(test.window.retractFrames).toHaveLength(0)
    await test.clock.advance(1)
    await settle()
    expect(test.window.retractFrames).toHaveLength(1)
    test.lifecycle.dispose()
  })
})
