import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UpdateManager } from '../src/main/update/updateManager'
import * as jobs from '../src/main/update/hoyoJob'
import { HoYoSteps } from '../src/main/update/hoyoSchedule'
import { HoYoWorkerStopped } from '../src/main/update/hoyoWorker'

vi.mock('electron', () => ({ app: {
  isPackaged: false, getPath: () => '.', getAppPath: () => '.', getVersion: () => '2.0.5-beta.2'
} }))
vi.mock('../src/main/services/logger', () => ({ log: vi.fn() }))
vi.mock('../src/main/workers/sophonWorker?modulePath', () => ({ default: 'sophon' }))
vi.mock('../src/main/workers/arknightsWorker?modulePath', () => ({ default: 'arknights' }))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('HoYo game task ownership', () => {
  it('retains progress on a network error and creates a fresh worker on manual retry after a crash', async () => {
    const manager = new UpdateManager()
    const dispose = vi.fn().mockResolvedValue(undefined)
    const stage = vi.fn().mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new HoYoWorkerStopped('worker exited'))
    const prepare = vi.spyOn(jobs, 'prepareHoYoJob')
      .mockResolvedValueOnce(new HoYoSteps([stage], dispose))
      .mockResolvedValueOnce(new HoYoSteps([], async () => {}))
    try {
      const start = () => manager.start('game', 'update', 'genshin', 'D:/game')
      await start()
      expect(manager.status('game')).toMatchObject({ phase: 'error', message: 'network' })
      expect(dispose).not.toHaveBeenCalled()
      await start()
      expect(manager.status('game')).toMatchObject({ phase: 'error', message: 'worker exited' })
      expect(dispose).toHaveBeenCalledOnce()
      expect(prepare).toHaveBeenCalledOnce()
      await start()
      expect(prepare).toHaveBeenCalledTimes(2)
      expect(manager.status('game').phase).toBe('done')
    } finally { prepare.mockRestore() }
  })

  it('shares a running game with another launcher entry and reports progress with each entry ID', async () => {
    const manager = new UpdateManager()
    const done = deferred()
    const run = vi.spyOn(manager as unknown as { runHoYo: () => Promise<void> }, 'runHoYo')
      .mockImplementation(() => done.promise)
    const listener = vi.fn()
    manager.onProgress(listener)
    const first = manager.start('first', 'preDownload', 'genshin', 'D:/game')
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    const second = manager.start('second', 'preDownload', 'genshin', 'd:/GAME')
    await vi.waitFor(() => expect(manager.status('second')).toMatchObject({
      appId: 'second', phase: 'downloading', taskId: manager.status('first').taskId
    }))
    expect(run).toHaveBeenCalledOnce()
    done.resolve()
    await Promise.all([first, second])
    for (const appId of ['first', 'second']) {
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ appId, phase: 'done' }))
    }
  })

  it('keeps both entries in sync when either entry resumes a paused installation', async () => {
    const manager = new UpdateManager()
    const hold = deferred()
    type Run = (id: string, mode: string, game: string, dir: string, controller: AbortController) => Promise<void>
    const run = vi.spyOn(manager as unknown as { runHoYo: Run }, 'runHoYo')
      .mockImplementationOnce(async (_id, _mode, _game, _dir, controller) => {
        await hold.promise
        controller.signal.throwIfAborted()
      }).mockResolvedValueOnce(undefined)
    const first = manager.start('first', 'update', 'genshin', 'D:/game')
    const second = manager.start('second', 'update', 'genshin', 'D:/game')
    await vi.waitFor(() => expect(manager.status('second').phase).toBe('downloading'))
    manager.cancel('second')
    hold.resolve()
    await Promise.all([first, second])
    expect(manager.status('first').phase).toBe('paused')
    await manager.start('second', 'update', 'genshin', 'D:/game')
    expect(run).toHaveBeenCalledTimes(2)
    expect(manager.status('first')).toMatchObject({ phase: 'done', appId: 'first' })
    expect(manager.status('second')).toMatchObject({ phase: 'done', appId: 'second' })
  })

  it('cancels and drains the first operation before starting another for the same game', async () => {
    const manager = new UpdateManager()
    const firstDone = deferred()
    const secondDone = deferred()
    const signals: AbortSignal[] = []
    type Run = (id: string, mode: string, game: string, dir: string, controller: AbortController) => Promise<void>
    vi.spyOn(manager as unknown as { runHoYo: Run }, 'runHoYo')
      .mockImplementation(async (_id, _mode, _game, _dir, controller) => {
        signals.push(controller.signal)
        await (signals.length === 1 ? firstDone : secondDone).promise
        controller.signal.throwIfAborted()
      })
    const first = manager.start('one', 'preDownload', 'zzz', 'D:/A')
    await vi.waitFor(() => expect(signals).toHaveLength(1))
    const next = manager.start('two', 'update', 'zzz', 'D:/B')
    await vi.waitFor(() => expect(signals[0].aborted).toBe(true))
    expect(signals).toHaveLength(1)
    firstDone.resolve()
    await first
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    const stopped = manager.stopTasks()
    expect(signals[1].aborted).toBe(true)
    await expect(manager.start('three', 'update', 'starrail', 'D:/C')).rejects.toThrow('退出')
    secondDone.resolve()
    await Promise.all([next, stopped])
    expect(manager.status('one').phase).toBe('paused')
    expect(manager.status('two').phase).toBe('paused')
  })

  it('coordinates real directory aliases across games and drains Arknights before shutdown finishes', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'kl-directory-lock-'))
    const real = join(root, 'game')
    let alias = join(root, 'linked')
    const manager = new UpdateManager()
    const hold = deferred()
    let signal: AbortSignal | undefined
    type Run = (mode: string, dir: string, controller: AbortController) => Promise<void>
    const run = vi.spyOn(manager as unknown as { runArknights: Run }, 'runArknights')
      .mockImplementation(async (_mode, _dir, controller) => {
        signal = controller.signal
        await hold.promise
        signal.throwIfAborted()
      })
    try {
      await fs.mkdir(real)
      try { await fs.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
        alias = process.platform === 'win32' ? real.toUpperCase() : real
      }
      const started = manager.start('original', 'update', 'arknights', real)
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      const shared = manager.start('alias', 'update', 'arknights', alias)
      await vi.waitFor(() => expect(manager.status('alias').taskId).toBe(manager.status('original').taskId))
      await expect(manager.start('other-game', 'update', 'genshin', alias)).rejects.toThrow('重叠')
      let stopped = false
      const stopping = manager.stopTasks().then(() => { stopped = true })
      expect(signal?.aborted).toBe(true)
      expect(stopped).toBe(false)
      hold.resolve()
      await Promise.all([started, shared, stopping])
      expect(manager.status('original').phase).toBe('paused')
      expect(manager.status('alias').phase).toBe('paused')
    } finally {
      hold.resolve()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('releases preparation after a five-minute pause and resumes the staged operation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const manager = new UpdateManager()
    const atUpdate = deferred()
    const held = deferred()
    const first = vi.fn(async () => undefined)
    const apply = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      atUpdate.resolve()
      await held.promise
      signal.throwIfAborted()
    })
    const park = vi.fn(async () => undefined)
    const prepare = vi.spyOn(jobs, 'prepareHoYoJob')
      .mockResolvedValue(new HoYoSteps([first, apply], async () => {}, park))
    try {
      const task = manager.start('parked', 'update', 'genshin', 'D:/game')
      await atUpdate.promise
      manager.cancel('parked')
      held.resolve()
      await task
      await vi.advanceTimersByTimeAsync(300_000)
      expect(park).toHaveBeenCalledOnce()
      await manager.start('parked', 'update', 'genshin', 'D:/game')
      expect(first).toHaveBeenCalledOnce()
      expect(apply).toHaveBeenCalledTimes(2)
      expect(prepare).toHaveBeenCalledOnce()
      expect(manager.status('parked').phase).toBe('done')
    } finally {
      held.resolve()
      prepare.mockRestore()
      vi.useRealTimers()
    }
  })
})
