import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  DEFAULT_KEVIN_HUD,
  normalizeKevinHudConfig,
  type KevinHudConfig,
  type KevinHudFrame
} from '../src/shared/kevinHud'
import {
  formatKevinHudMemoryDisplay,
  parseKevinHudMemoryDisplay
} from '../src/shared/kevinHudMemory'
import {
  KevinHudMetricsService,
  buildKevinHudValues,
  formatKevinHudClock,
  formatKevinHudDuration,
  formatKevinHudFps,
  formatKevinHudPercent,
  formatKevinHudRate,
  parseKevinHudHelperMessage,
  type KevinHudHelper,
  type KevinHudHelperCapabilities,
  type KevinHudHelperSample,
  type KevinHudSessionInfo,
  type KevinHudWindowRect
} from '../src/main/services/kevinHudMetrics'

const GIB = 1024 ** 3

const baseSession: KevinHudSessionInfo = {
  pid: 4242,
  appName: 'Test Game',
  iconUrl: 'file:///icon.png',
  fontFamily: 'Test Sans',
  appGlass: null,
  sessionSeconds: 3661,
  totalSeconds: 90_061
}

const hudConfig = (patch: Partial<KevinHudConfig> = {}): KevinHudConfig =>
  normalizeKevinHudConfig({ ...DEFAULT_KEVIN_HUD, ...patch })

interface FakeHelper extends KevinHudHelper {
  sample: Mock<() => Promise<KevinHudHelperSample>>
  windowRect: Mock<() => Promise<KevinHudWindowRect | null>>
  setTargets?: Mock<(pids: readonly number[], rootPid?: number | null) => Promise<void>>
  close: Mock<() => Promise<void>>
}

interface FakeFactoryOptions {
  sample?: () => Promise<KevinHudHelperSample>
  windowRect?: () => Promise<KevinHudWindowRect | null>
  setTargets?: (pids: readonly number[], rootPid?: number | null) => Promise<void>
}

function fakeHelper(
  capabilities: KevinHudHelperCapabilities,
  options: FakeFactoryOptions = {}
): FakeHelper {
  return {
    capabilities: { ...capabilities },
    sample: vi.fn(options.sample ?? (async () => ({
      fps: 60,
      gpu: 42.2,
      receivedBytes: 0,
      sentBytes: 0
    }))),
    windowRect: vi.fn(options.windowRect ?? (async () => null)),
    setTargets: options.setTargets ? vi.fn(options.setTargets) : undefined,
    close: vi.fn(async () => undefined)
  }
}

function fakeFactory(options: FakeFactoryOptions = {}) {
  const helpers: FakeHelper[] = []
  const factory = vi.fn(async (request: {
    capabilities: KevinHudHelperCapabilities
    pids?: readonly number[]
    rootPid?: number | null
    pid?: number | null
  }) => {
    const helper = fakeHelper(request.capabilities, options)
    helpers.push(helper)
    return helper
  })
  return { factory, helpers }
}

const services: KevinHudMetricsService[] = []

function createService(
  options: ConstructorParameters<typeof KevinHudMetricsService>[0]
): KevinHudMetricsService {
  const service = new KevinHudMetricsService(options)
  services.push(service)
  return service
}

async function flushMicrotasks(count = 24): Promise<void> {
  for (let index = 0; index < count; index++) await Promise.resolve()
}

async function settle(): Promise<void> {
  await flushMicrotasks()
  await vi.advanceTimersByTimeAsync(0)
  await flushMicrotasks()
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(services.splice(0).map(async (service) => {
    await service.stop().catch(() => undefined)
  }))
})

describe('Kevin HUD formatting', () => {
  it('formats elapsed time, local clock and bounded percentages', () => {
    expect(formatKevinHudDuration(null)).toBeNull()
    expect(formatKevinHudDuration(-1)).toBeNull()
    expect(formatKevinHudDuration(0)).toBe('0:00:00')
    expect(formatKevinHudDuration(3661)).toBe('1:01:01')
    expect(formatKevinHudDuration(90_061)).toBe('25:01:01')

    const local = new Date(2026, 0, 2, 9, 7, 4).getTime()
    expect(formatKevinHudClock(local)).toBe('09:07')

    expect(formatKevinHudPercent(null)).toBeNull()
    expect(formatKevinHudPercent(-5)).toBe('0%')
    expect(formatKevinHudPercent(42.6)).toBe('43%')
    expect(formatKevinHudPercent(120)).toBe('100%')

    expect(formatKevinHudFps(59.94)).toBe('59.9')
    expect(formatKevinHudFps(60)).toBe('60')
    expect(formatKevinHudFps(12_000)).toBe('10000')
    expect(formatKevinHudFps(-1)).toBeNull()
  })

  it('states network units and uses binary increments without hiding a reset', () => {
    expect(formatKevinHudRate(null)).toBeNull()
    expect(formatKevinHudRate(-1)).toBeNull()
    expect(formatKevinHudRate(0)).toBe('0 B/s')
    expect(formatKevinHudRate(1023)).toBe('1023 B/s')
    expect(formatKevinHudRate(1024)).toBe('1.0 KB/s')
    expect(formatKevinHudRate(1024 * 1024 * 1.5)).toBe('1.5 MB/s')
  })

  it('re-exports the shared bounded duration/rate text and keeps the FPS cap', () => {
    expect(formatKevinHudDuration(999_999 * 3_600 + 3_599)).toBe('999999:59:59')
    expect(formatKevinHudDuration(1_000_000 * 3_600)).toBe('41666d')
    expect(formatKevinHudDuration(Number.MAX_VALUE)).toBe('2.1e+303d')

    expect(formatKevinHudRate(GIB)).toBe('1.0 GB/s')
    expect(formatKevinHudRate(1_000_000 * GIB)).toBe('1.0e+6 GB/s')

    expect(formatKevinHudFps(10_000)).toBe('10000')
    expect(formatKevinHudFps(10_001)).toBe('10000')
  })

  it('folds the legacy appIcon alias before building requested textual values', () => {
    // Early beta saved appName and appIcon as separate slots. Raw input still
    // migrates both onto one canonical appName before sampling builds values.
    const savedMetrics: unknown[] = [
      'appName',
      'fps',
      'appIcon',
      'clock',
      'cpu',
      'download',
      'fps'
    ]
    const metrics = normalizeKevinHudConfig({ metrics: savedMetrics }).metrics
    expect(metrics).toEqual(['appName', 'fps', 'clock', 'cpu', 'download'])

    const values = buildKevinHudValues({
      metrics,
      now: new Date(2026, 0, 2, 21, 5).getTime(),
      fps: 59.9,
      gpu: 42,
      cpu: 31.4,
      memory: 68,
      downloadBytesPerSecond: 2048,
      uploadBytesPerSecond: 512,
      sessionSeconds: 3661,
      totalSeconds: 90_061
    })
    expect(Object.keys(values)).toEqual(['fps', 'clock', 'cpu', 'download'])
    expect(values).toMatchObject({
      fps: '59.9',
      clock: '21:05',
      cpu: '31%',
      download: '2.0 KB/s'
    })
    expect(values.sessionTime).toBeUndefined()
  })

  it('keeps unavailable metrics as explicit nulls', () => {
    const values = buildKevinHudValues({
      metrics: ['fps', 'gpu', 'sessionTime', 'totalTime', 'download'],
      fps: null,
      gpu: null,
      sessionSeconds: null,
      totalSeconds: null,
      downloadBytesPerSecond: null
    })
    expect(values).toEqual({
      fps: null,
      gpu: null,
      sessionTime: null,
      totalTime: null,
      download: null
    })
  })
})

describe('Kevin HUD memory display', () => {
  it('formats real used/total bytes and parses the display for separate layout', () => {
    const text = formatKevinHudMemoryDisplay(9.7 * GIB, 31.3 * GIB)
    expect(text).toBe('9.7 / 31.3 GB · 31%')

    expect(parseKevinHudMemoryDisplay(text)).toEqual({
      text: '9.7 / 31.3 GB · 31%',
      usage: '9.7 / 31.3 GB',
      used: '9.7',
      total: '31.3',
      unit: 'GB',
      percent: '31%',
      percentValue: 31
    })

    // Old percent-only values still parse so the renderer can use the compact
    // percentage in a multi-metric layout.
    expect(parseKevinHudMemoryDisplay('31%')).toEqual({
      text: '31%',
      usage: null,
      used: null,
      total: null,
      unit: null,
      percent: '31%',
      percentValue: 31
    })
    expect(parseKevinHudMemoryDisplay(null)).toBeNull()
    expect(parseKevinHudMemoryDisplay('--')).toBeNull()
  })

  it('shares one unit and rejects invalid or fabricated measurements', () => {
    expect(formatKevinHudMemoryDisplay(512 * 1024, 1024 * 1024))
      .toBe('0.5 / 1.0 MB · 50%')
    expect(formatKevinHudMemoryDisplay(0, 100)).toBe('0 / 100 B · 0%')
    expect(formatKevinHudMemoryDisplay(null, 1)).toBeNull()
    expect(formatKevinHudMemoryDisplay(1, null)).toBeNull()
    expect(formatKevinHudMemoryDisplay(-1, 1)).toBeNull()
    expect(formatKevinHudMemoryDisplay(2, 1)).toBeNull()
    expect(formatKevinHudMemoryDisplay(0, 0)).toBeNull()
    expect(formatKevinHudMemoryDisplay(1, Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('rejects malformed display strings', () => {
    expect(parseKevinHudMemoryDisplay('')).toBeNull()
    expect(parseKevinHudMemoryDisplay('9.7 / 31.3 GB')).toBeNull()
    expect(parseKevinHudMemoryDisplay('9.7 / 0 GB · 0%')).toBeNull()
    expect(parseKevinHudMemoryDisplay('32 / 31 GB · 100%')).toBeNull()
    expect(parseKevinHudMemoryDisplay('9.7 / 31.3 GB · 101%')).toBeNull()
    expect(parseKevinHudMemoryDisplay('9.7 / 31.3 TB · 31%')).toBeNull()
    expect(parseKevinHudMemoryDisplay('not memory')).toBeNull()
  })

  it('keeps the legacy percent-only input as a fallback', () => {
    expect(buildKevinHudValues({ metrics: ['memory'], memory: 68 }).memory).toBe('68%')
    expect(buildKevinHudValues({
      metrics: ['memory'],
      memory: 68,
      memoryUsedBytes: 9.7 * GIB,
      memoryTotalBytes: 31.3 * GIB
    }).memory).toBe('9.7 / 31.3 GB · 31%')
    expect(buildKevinHudValues({ metrics: ['memory'], memory: null }).memory).toBeNull()
  })
})

describe('Kevin HUD helper protocol', () => {
  it('parses ready, sample and rect responses defensively', () => {
    expect(parseKevinHudHelperMessage('{"ok":true,"ready":true,"fps":false}'))
      .toEqual({ kind: 'ready' })

    expect(parseKevinHudHelperMessage(JSON.stringify({
      ok: true,
      fps: 59.9,
      gpu: 120,
      rx: 4096,
      tx: 2048
    }))).toEqual({
      kind: 'sample',
      sample: { fps: 59.9, gpu: 100, receivedBytes: 4096, sentBytes: 2048 }
    })

    expect(parseKevinHudHelperMessage(JSON.stringify({
      ok: true,
      fps: 'bad',
      gpu: Number.NaN,
      rx: -1,
      tx: 1.5
    }))).toEqual({
      kind: 'sample',
      sample: { fps: null, gpu: null, receivedBytes: null, sentBytes: null }
    })

    expect(parseKevinHudHelperMessage('{"ok":true,"rect":null}'))
      .toEqual({ kind: 'rect', rect: null })
    expect(parseKevinHudHelperMessage(JSON.stringify({
      ok: true,
      rect: { x: 10.4, y: -20.6, width: 1920.2, height: 1080.8 }
    }))).toEqual({
      kind: 'rect',
      rect: { x: 10, y: -21, width: 1920, height: 1081 }
    })
    expect(parseKevinHudHelperMessage('{"ok":true,"rect":{"x":0,"y":0,"width":-1,"height":0}}'))
      .toEqual({ kind: 'rect', rect: null })
  })

  it('rejects malformed or oversized output and reports protocol errors', () => {
    expect(parseKevinHudHelperMessage('{"ok":false,"error":"unsupported_command"}'))
      .toEqual({ kind: 'error', error: 'unsupported_command' })
    expect(() => parseKevinHudHelperMessage('not json')).toThrow()
    expect(() => parseKevinHudHelperMessage('{"ok":true}')).toThrow()
    expect(() => parseKevinHudHelperMessage(' '.repeat(17 * 1024))).toThrow()
  })

  it('accepts target acknowledgements and validates the Present PID', () => {
    expect(parseKevinHudHelperMessage('{"ok":true,"targets":true,"pids":2}'))
      .toEqual({ kind: 'targets' })

    expect(parseKevinHudHelperMessage(JSON.stringify({
      ok: true,
      fps: 144,
      fpsPid: 4242,
      gpu: null,
      rx: null,
      tx: null
    }))).toEqual({
      kind: 'sample',
      sample: { fps: 144, fpsPid: 4242, gpu: null, receivedBytes: null, sentBytes: null }
    })

    expect(parseKevinHudHelperMessage(JSON.stringify({
      ok: true,
      fps: 144,
      fpsPid: -1,
      gpu: null,
      rx: null,
      tx: null
    }))).toEqual({
      kind: 'sample',
      sample: { fps: 144, fpsPid: null, gpu: null, receivedBytes: null, sentBytes: null }
    })

    expect(parseKevinHudHelperMessage(JSON.stringify({
      ok: true,
      fps: null,
      gpu: null,
      rx: null,
      tx: null
    }))).toEqual({
      kind: 'sample',
      sample: { fps: null, gpu: null, receivedBytes: null, sentBytes: null }
    })
  })
})

describe('Kevin HUD sampling service', () => {
  it('samples only while enabled, always visible, with metrics and a session', async () => {
    vi.useFakeTimers()
    const frames: KevinHudFrame[] = []
    const { factory } = fakeFactory()
    const service = createService({
      config: hudConfig({ alwaysVisible: true, metrics: ['clock'] }),
      session: baseSession,
      onFrame: (frame) => frames.push(frame),
      createHelper: factory
    })

    service.start()
    await settle()
    expect(service.samplingActive).toBe(true)
    expect(factory).not.toHaveBeenCalled()
    expect(frames.at(-1)?.values.clock).toMatch(/^\d{2}:\d{2}$/)

    service.setConfig(hudConfig({ alwaysVisible: false, metrics: ['clock'] }))
    const before = frames.length
    await settle()
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(service.samplingActive).toBe(false)
    expect(frames.length).toBe(before)

    service.setConfig(hudConfig({ enabled: false, alwaysVisible: true, metrics: ['clock'] }))
    await settle()
    expect(service.samplingActive).toBe(false)

    service.setConfig(hudConfig({ enabled: true, alwaysVisible: true, metrics: [] }))
    await settle()
    expect(service.samplingActive).toBe(false)

    service.setSession(null)
    service.setConfig(hudConfig({ enabled: true, alwaysVisible: true, metrics: ['clock'] }))
    await settle()
    expect(service.samplingActive).toBe(false)
  })

  it('honours the overlay visibility gate by stopping and restarting sampling', async () => {
    vi.useFakeTimers()
    const frames: KevinHudFrame[] = []
    const { factory } = fakeFactory()
    const service = createService({
      config: hudConfig({ alwaysVisible: true, sampleSeconds: 1, metrics: ['fps'] }),
      session: baseSession,
      onFrame: (frame) => frames.push(frame),
      createHelper: factory
    })
    service.start()
    await settle()
    expect(service.samplingActive).toBe(true)

    service.setHudVisible(false)
    await settle()
    expect(service.samplingActive).toBe(false)
    const before = frames.length
    await vi.advanceTimersByTimeAsync(5_000)
    await settle()
    expect(frames.length).toBe(before)

    service.setHudVisible(true)
    await settle()
    expect(service.samplingActive).toBe(true)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('reads Node CPU/RAM cross-sections and never starts a helper for them', async () => {
    vi.useFakeTimers()
    const frames: KevinHudFrame[] = []
    let index = 0
    const totalMemory = 32 * GIB
    const snapshots = [
      { cpuIdle: 100, cpuTotal: 200, freeMemory: 8 * GIB, totalMemory },
      { cpuIdle: 120, cpuTotal: 300, freeMemory: 6.4 * GIB, totalMemory }
    ]
    const { factory } = fakeFactory()
    const service = createService({
      config: hudConfig({ alwaysVisible: true, sampleSeconds: 1, metrics: ['cpu', 'memory'] }),
      session: baseSession,
      onFrame: (frame) => frames.push(frame),
      readSystem: () => snapshots[Math.min(index++, snapshots.length - 1)],
      createHelper: factory
    })

    service.start()
    await settle()
    expect(factory).not.toHaveBeenCalled()
    expect(frames.at(-1)?.values.cpu).toBeNull()
    expect(frames.at(-1)?.values.memory).toBe('24.0 / 32.0 GB · 75%')

    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(frames.at(-1)?.values.cpu).toBe('80%')
    expect(frames.at(-1)?.values.memory).toBe('25.6 / 32.0 GB · 80%')
  })

  it('derives used/total memory from one fresh OS snapshot without extra polling', async () => {
    vi.useFakeTimers()
    const frames: KevinHudFrame[] = []
    const totalBytes = Math.round(31.3 * GIB)
    const usedBytes = Math.round(9.7 * GIB)
    const readSystem = vi.fn(() => ({
      cpuIdle: null,
      cpuTotal: null,
      freeMemory: totalBytes - usedBytes,
      totalMemory: totalBytes
    }))
    const service = createService({
      config: hudConfig({ alwaysVisible: true, sampleSeconds: 1, metrics: ['memory'] }),
      session: baseSession,
      onFrame: (frame) => frames.push(frame),
      readSystem,
      createHelper: fakeFactory().factory
    })

    service.start()
    await settle()
    expect(readSystem).toHaveBeenCalledTimes(1)
    expect(frames.at(-1)?.values.memory).toBe('9.7 / 31.3 GB · 31%')
    expect(parseKevinHudMemoryDisplay(frames.at(-1)?.values.memory)).toMatchObject({
      usage: '9.7 / 31.3 GB',
      used: '9.7',
      total: '31.3',
      unit: 'GB',
      percent: '31%',
      percentValue: 31
    })

    // Building frames between samples must reuse the collected reading instead
    // of polling the OS again.
    service.frame()
    service.frame()
    expect(readSystem).toHaveBeenCalledTimes(1)

    await service.stop()
    expect(service.frame().values.memory).toBeNull()
  })

  it('uses one helper with the exact on-demand capabilities', async () => {
    vi.useFakeTimers()
    const frames: KevinHudFrame[] = []
    const { factory, helpers } = fakeFactory()
    const service = createService({
      config: hudConfig({
        alwaysVisible: true,
        sampleSeconds: 1,
        metrics: ['fps', 'gpu', 'download', 'upload']
      }),
      session: baseSession,
      onFrame: (frame) => frames.push(frame),
      createHelper: factory
    })

    service.start()
    await settle()
    expect(factory).toHaveBeenCalledTimes(1)
    expect(factory.mock.calls[0][0].capabilities).toEqual({
      fps: true,
      gpu: true,
      net: true,
      window: false
    })
    expect(helpers[0].sample).toHaveBeenCalledTimes(1)
    expect(frames.at(-1)?.values).toMatchObject({
      fps: '60',
      gpu: '42%',
      download: null,
      upload: null
    })
  })

  it('passes every verified PID and updates a resident helper in place', async () => {
    vi.useFakeTimers()
    const targetUpdates: Array<{ pids: readonly number[]; rootPid?: number | null }> = []
    const { factory, helpers } = fakeFactory({
      setTargets: async (pids, rootPid) => {
        targetUpdates.push({ pids: [...pids], rootPid })
      }
    })
    const service = createService({
      samplingMode: 'pull',
      config: hudConfig({ alwaysVisible: true, metrics: ['fps', 'gpu'] }),
      session: { ...baseSession, pid: 500, pids: [500, 501], rootPid: 500 },
      createHelper: factory
    })

    await service.sampleOnce()
    expect(factory).toHaveBeenCalledTimes(1)
    expect(factory.mock.calls[0][0]).toMatchObject({
      pid: null,
      pids: [500, 501],
      rootPid: 500
    })

    // The wrapper PID is still present; Runtime discovers the game PID later.
    // The same native helper must receive the expanded set without a restart.
    service.setSession({ ...baseSession, pid: 500, pids: [500, 501, 502], rootPid: 500 })
    await service.sampleOnce()
    expect(factory).toHaveBeenCalledTimes(1)
    expect(helpers[0].setTargets).toHaveBeenCalledWith([500, 501, 502], 500)
    expect(targetUpdates).toEqual([{ pids: [500, 501, 502], rootPid: 500 }])
  })

  it('recreates a helper that predates dynamic target updates', async () => {
    vi.useFakeTimers()
    const { factory, helpers } = fakeFactory()
    const service = createService({
      samplingMode: 'pull',
      config: hudConfig({ alwaysVisible: true, metrics: ['fps'] }),
      session: { ...baseSession, pid: 600, pids: [600], rootPid: 600 },
      createHelper: factory
    })

    await service.sampleOnce()
    expect(factory).toHaveBeenCalledTimes(1)
    expect(helpers[0].setTargets).toBeUndefined()

    service.setSession({ ...baseSession, pid: 600, pids: [600, 601], rootPid: 600 })
    await service.sampleOnce()
    expect(factory).toHaveBeenCalledTimes(2)
    expect(factory.mock.calls[1][0]).toMatchObject({ pids: [600, 601], rootPid: 600 })
    expect(helpers[0].close).toHaveBeenCalledTimes(1)
    expect(helpers[1].sample).toHaveBeenCalledTimes(1)
  })

  it('drops an FPS attributed to a PID outside the verified set', async () => {
    vi.useFakeTimers()
    let presentPid: number | null = 999
    const { factory } = fakeFactory({
      sample: async () => ({
        fps: 60,
        fpsPid: presentPid,
        gpu: null,
        receivedBytes: null,
        sentBytes: null
      })
    })
    const service = createService({
      samplingMode: 'pull',
      config: hudConfig({ alwaysVisible: true, metrics: ['fps'] }),
      session: { ...baseSession, pid: 700, pids: [700], rootPid: null },
      createHelper: factory
    })

    expect((await service.sampleOnce()).fps).toBeNull()
    presentPid = 700
    expect((await service.sampleOnce()).fps).toBe('60')
  })

  it('computes network rates from cumulative interface counters', async () => {
    vi.useFakeTimers()
    const frames: KevinHudFrame[] = []
    let monotonic = 0
    let sampleIndex = 0
    const { factory } = fakeFactory({
      sample: async () => {
        const current = sampleIndex++
        return {
          fps: null,
          gpu: null,
          receivedBytes: current === 0 ? 1_000 : 1_000 + 1024 * 1024,
          sentBytes: current === 0 ? 2_000 : 2_000 + 512 * 1024
        }
      }
    })
    const service = createService({
      config: hudConfig({ alwaysVisible: true, sampleSeconds: 1, metrics: ['download', 'upload'] }),
      session: baseSession,
      onFrame: (frame) => frames.push(frame),
      monotonicNow: () => monotonic,
      createHelper: factory
    })

    service.start()
    await settle()
    expect(frames.at(-1)?.values.download).toBeNull()

    monotonic = 1_000
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(frames.at(-1)?.values.download).toBe('1.0 MB/s')
    expect(frames.at(-1)?.values.upload).toBe('512.0 KB/s')
  })

  it('never duplicates an in-flight sample, even when timers elapse', async () => {
    vi.useFakeTimers()
    let resolveSample!: (sample: KevinHudHelperSample) => void
    const pending = new Promise<KevinHudHelperSample>((resolve) => {
      resolveSample = resolve
    })
    let calls = 0
    const { factory } = fakeFactory({
      sample: () => {
        calls++
        return calls === 1 ? pending : Promise.resolve({
          fps: 60,
          gpu: null,
          receivedBytes: null,
          sentBytes: null
        })
      }
    })
    const service = createService({
      config: hudConfig({ alwaysVisible: true, sampleSeconds: 0.5, metrics: ['fps'] }),
      session: baseSession,
      createHelper: factory
    })

    service.start()
    await settle()
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(5_000)
    await flushMicrotasks()
    expect(calls).toBe(1)

    resolveSample({ fps: 59.9, gpu: null, receivedBytes: null, sentBytes: null })
    await settle()
    await vi.advanceTimersByTimeAsync(500)
    await settle()
    expect(calls).toBe(2)
  })

  it('degrades helper failures to null and backs off before retrying', async () => {
    vi.useFakeTimers()
    const errors: Error[] = []
    const frames: KevinHudFrame[] = []
    let monotonic = 1_000
    const factory = vi.fn(async () => {
      throw new Error('helper missing')
    })
    const service = createService({
      config: hudConfig({ alwaysVisible: true, sampleSeconds: 0.5, metrics: ['fps', 'cpu'] }),
      session: baseSession,
      onFrame: (frame) => frames.push(frame),
      onError: (error) => errors.push(error),
      monotonicNow: () => monotonic,
      createHelper: factory
    })

    service.start()
    await settle()
    expect(errors).toHaveLength(1)
    expect(frames.at(-1)?.values.fps).toBeNull()

    monotonic = 2_000
    await vi.advanceTimersByTimeAsync(500)
    await settle()
    expect(factory).toHaveBeenCalledTimes(1)

    monotonic = 17_000
    await vi.advanceTimersByTimeAsync(500)
    await settle()
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('starts and immediately releases a window-only helper on demand', async () => {
    vi.useFakeTimers()
    const rect = { x: -12, y: 4, width: 1920, height: 1080 }
    const { factory, helpers } = fakeFactory({
      windowRect: async () => rect
    })
    const service = createService({
      config: hudConfig({ alwaysVisible: false, metrics: ['clock'] }),
      session: baseSession,
      createHelper: factory
    })

    service.start()
    await settle()
    expect(factory).not.toHaveBeenCalled()
    await expect(service.getTargetWindowRect()).resolves.toEqual(rect)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(factory.mock.calls[0][0].capabilities).toEqual({
      fps: false,
      gpu: false,
      net: false,
      window: true
    })
    // Not monitoring: the helper is released as soon as the rect settles.
    expect(helpers[0].close).toHaveBeenCalledTimes(1)

    await service.stop()
    expect(helpers[0].close).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('releases a one-shot geometry helper when measuring fails', async () => {
    vi.useFakeTimers()
    const errors: Error[] = []
    const { factory, helpers } = fakeFactory({
      windowRect: async () => {
        throw new Error('no visible window')
      }
    })
    const service = createService({
      config: hudConfig({ alwaysVisible: false, metrics: ['clock'] }),
      session: baseSession,
      onError: (error) => errors.push(error),
      createHelper: factory
    })

    service.start()
    await settle()
    await expect(service.getTargetWindowRect()).resolves.toBeNull()
    expect(factory).toHaveBeenCalledTimes(1)
    expect(helpers[0].close).toHaveBeenCalledTimes(1)
    expect(errors.map((error) => error.message)).toContain('no visible window')
  })

  it('does not carry an inactive one-shot rect request into later sampling', async () => {
    vi.useFakeTimers()
    const rect = { x: 8, y: 9, width: 1280, height: 720 }
    const { factory, helpers } = fakeFactory({ windowRect: async () => rect })
    const service = createService({
      samplingMode: 'pull',
      config: hudConfig({ alwaysVisible: true, metrics: ['clock'] }),
      session: baseSession,
      createHelper: factory
    })

    await expect(service.getTargetWindowRect()).resolves.toEqual(rect)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(helpers[0].close).toHaveBeenCalledTimes(1)

    // Local-only metrics must not keep a window-only helper resident just
    // because the inactive announce measurement asked for geometry once.
    await expect(service.sampleOnce()).resolves.toMatchObject({ clock: expect.any(String) })
    expect(service.samplingActive).toBe(true)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('drops the requested window capability when sampling stops', async () => {
    vi.useFakeTimers()
    const rect = { x: 0, y: 0, width: 1920, height: 1080 }
    const { factory, helpers } = fakeFactory({ windowRect: async () => rect })
    const service = createService({
      samplingMode: 'pull',
      config: hudConfig({ alwaysVisible: true, metrics: ['fps'] }),
      session: baseSession,
      createHelper: factory
    })

    await service.sampleOnce()
    await expect(service.getTargetWindowRect()).resolves.toEqual(rect)
    expect(factory.mock.calls[1][0].capabilities.window).toBe(true)
    expect(helpers[1].close).not.toHaveBeenCalled()

    await service.stop()
    expect(helpers[1].close).toHaveBeenCalledTimes(1)

    // A later app/session with local-only metrics starts no resident helper.
    service.setConfig(hudConfig({ alwaysVisible: true, metrics: ['clock'] }))
    service.start()
    await expect(service.sampleOnce()).resolves.toMatchObject({ clock: expect.any(String) })
    expect(service.samplingActive).toBe(true)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('drops the requested window capability when switching to the primary monitor', async () => {
    vi.useFakeTimers()
    const rect = { x: 0, y: 0, width: 1920, height: 1080 }
    const { factory, helpers } = fakeFactory({ windowRect: async () => rect })
    const service = createService({
      samplingMode: 'pull',
      config: hudConfig({ alwaysVisible: true, monitor: 'game', metrics: ['fps'] }),
      session: baseSession,
      createHelper: factory
    })

    await service.sampleOnce()
    await expect(service.getTargetWindowRect()).resolves.toEqual(rect)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(factory.mock.calls[1][0].capabilities.window).toBe(true)

    service.setConfig(hudConfig({ alwaysVisible: true, monitor: 'primary', metrics: ['fps'] }))
    await service.sampleOnce()
    expect(factory).toHaveBeenCalledTimes(3)
    expect(factory.mock.calls[2][0].capabilities.window).toBe(false)
    expect(helpers[1].close).toHaveBeenCalledTimes(1)

    // An active geometry request still upgrades and reuses the sampler.
    await expect(service.getTargetWindowRect()).resolves.toEqual(rect)
    expect(factory).toHaveBeenCalledTimes(4)
    expect(factory.mock.calls[3][0].capabilities.window).toBe(true)
    await expect(service.getTargetWindowRect()).resolves.toEqual(rect)
    expect(factory).toHaveBeenCalledTimes(4)
  })

  it('only collects on explicit pull samples and releases on stop', async () => {
    vi.useFakeTimers()
    const frames: KevinHudFrame[] = []
    const { factory, helpers } = fakeFactory()
    const service = createService({
      samplingMode: 'pull',
      config: hudConfig({ alwaysVisible: true, sampleSeconds: 0.5, metrics: ['fps'] }),
      session: baseSession,
      onFrame: (frame) => frames.push(frame),
      createHelper: factory
    })

    service.start()
    await settle()
    service.setConfig(hudConfig({ alwaysVisible: true, sampleSeconds: 2, metrics: ['fps'] }))
    service.setSession({ ...baseSession, sessionSeconds: 3700 })
    await settle()
    await vi.advanceTimersByTimeAsync(10_000)
    await settle()
    expect(service.samplingActive).toBe(false)
    expect(factory).not.toHaveBeenCalled()
    expect(frames).toHaveLength(0)

    const first = service.sampleOnce()
    const second = service.sampleOnce()
    expect(second).toBe(first)
    await expect(first).resolves.toMatchObject({ fps: '60' })
    expect(factory).toHaveBeenCalledTimes(1)
    expect(helpers[0].sample).toHaveBeenCalledTimes(1)
    expect(service.samplingActive).toBe(true)
    expect(frames).toHaveLength(1)
    expect(frames[0].values.fps).toBe('60')

    // Active settings/session changes never trigger a background collection.
    service.setConfig(hudConfig({ alwaysVisible: true, sampleSeconds: 2, metrics: ['fps'] }))
    service.setSession({ ...baseSession, sessionSeconds: 3800 })
    await settle()
    expect(helpers[0].sample).toHaveBeenCalledTimes(1)
    expect(frames).toHaveLength(1)

    // Pull mode owns no timer: waiting must not collect another cycle.
    await vi.advanceTimersByTimeAsync(10_000)
    await settle()
    expect(helpers[0].sample).toHaveBeenCalledTimes(1)
    expect(frames).toHaveLength(1)

    await service.stop()
    expect(service.samplingActive).toBe(false)
    expect(helpers[0].close).toHaveBeenCalledTimes(1)

    // Configuration/session updates after stop stay suspended.
    service.setConfig(hudConfig({ alwaysVisible: true, sampleSeconds: 2, metrics: ['fps'] }))
    service.setSession({ ...baseSession, sessionSeconds: 3900 })
    await vi.advanceTimersByTimeAsync(10_000)
    await settle()
    expect(helpers[0].sample).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledTimes(1)

    // Even an explicit sample does not revive a stopped pull service.
    const suspendedValues = await service.sampleOnce()
    expect(suspendedValues.fps).toBeNull()
    expect(service.samplingActive).toBe(false)
    expect(helpers[0].sample).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledTimes(1)

    // start() is the explicit re-arm; the next sample then collects again.
    service.start()
    await expect(service.sampleOnce()).resolves.toMatchObject({ fps: '60' })
    expect(service.samplingActive).toBe(true)
    expect(helpers).toHaveLength(2)
    expect(helpers[1].sample).toHaveBeenCalledTimes(1)
  })

  it('returns pull frame values without a helper when metrics are local only', async () => {
    vi.useFakeTimers()
    const { factory } = fakeFactory()
    const service = createService({
      samplingMode: 'pull',
      config: hudConfig({ alwaysVisible: true, metrics: ['sessionTime', 'clock'] }),
      session: baseSession,
      now: () => new Date(2026, 0, 2, 9, 7).getTime(),
      createHelper: factory
    })

    const values = await service.sampleOnce()
    expect(factory).not.toHaveBeenCalled()
    expect(values).toEqual({ sessionTime: '1:01:01', clock: '09:07' })
  })

  it('adds window capability on request and reuses the monitoring helper', async () => {
    vi.useFakeTimers()
    const rect = { x: 1, y: 2, width: 1280, height: 720 }
    const { factory, helpers } = fakeFactory({ windowRect: async () => rect })
    const service = createService({
      samplingMode: 'pull',
      config: hudConfig({ alwaysVisible: true, metrics: ['fps'] }),
      session: baseSession,
      createHelper: factory
    })

    await service.sampleOnce()
    expect(factory).toHaveBeenCalledTimes(1)
    expect(factory.mock.calls[0][0].capabilities).toEqual({
      fps: true,
      gpu: false,
      net: false,
      window: false
    })

    await expect(service.getTargetWindowRect()).resolves.toEqual(rect)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(factory.mock.calls[1][0].capabilities).toEqual({
      fps: true,
      gpu: false,
      net: false,
      window: true
    })
    expect(helpers[0].close).toHaveBeenCalledTimes(1)
    expect(helpers[1].close).not.toHaveBeenCalled()

    await expect(service.getTargetWindowRect()).resolves.toEqual(rect)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(helpers[1].close).not.toHaveBeenCalled()

    await service.stop()
    expect(helpers[1].close).toHaveBeenCalledTimes(1)
  })

  it('closes the helper and stops sampling when the session ends or config changes', async () => {
    vi.useFakeTimers()
    const { factory, helpers } = fakeFactory()
    const service = createService({
      config: hudConfig({ alwaysVisible: true, sampleSeconds: 0.5, metrics: ['fps'] }),
      session: baseSession,
      createHelper: factory
    })

    service.start()
    await settle()
    expect(helpers).toHaveLength(1)

    service.setConfig(hudConfig({ alwaysVisible: false, sampleSeconds: 0.5, metrics: ['fps'] }))
    await settle()
    expect(service.samplingActive).toBe(false)
    expect(helpers[0].close).toHaveBeenCalledTimes(1)
    service.setSession({ ...baseSession, pid: 5555 })
    await settle()
    expect(factory).toHaveBeenCalledTimes(1)
    service.setSession(null)
    await settle()
    expect(service.samplingActive).toBe(false)
  })

  it('includes app metadata at the top level and supports announce/exit frames', () => {
    const service = createService({
      config: hudConfig({ alwaysVisible: true, metrics: ['sessionTime', 'totalTime'] }),
      session: baseSession,
      helperPath: null
    })
    const frame = service.frame('announce')
    expect(frame.phase).toBe('announce')
    expect(frame.appName).toBe('Test Game')
    expect(frame.iconUrl).toBe('file:///icon.png')
    expect(frame.fontFamily).toBe('Test Sans')
    expect(frame.values).toEqual({
      sessionTime: '1:01:01',
      totalTime: '25:01:01'
    })
    expect(service.frame('exit').phase).toBe('exit')
  })
})
