import { describe, expect, it, vi } from 'vitest'
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
    const second = manager.start('second', 'preDownload', 'genshin', 'd:/GAME')
    expect(run).toHaveBeenCalledOnce()
    expect(manager.status('second')).toMatchObject({ appId: 'second', phase: 'downloading' })
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
    const next = manager.start('two', 'update', 'zzz', 'D:/B')
    expect(signals).toHaveLength(1)
    expect(signals[0].aborted).toBe(true)
    firstDone.resolve()
    await first
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    const stopped = manager.stopHoYoTasks()
    expect(signals[1].aborted).toBe(true)
    await expect(manager.start('three', 'update', 'starrail', 'D:/C')).rejects.toThrow('退出')
    secondDone.resolve()
    await Promise.all([next, stopped])
    expect(manager.status('one').phase).toBe('paused')
    expect(manager.status('two').phase).toBe('paused')
  })
})
