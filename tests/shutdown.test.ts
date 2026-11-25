import { describe, expect, it, vi } from 'vitest'
import { flushBeforeShutdown, onBeforeShutdown } from '../src/main/services/shutdown'
import { runWithDataAccess, withExclusiveDataAccess, withShutdownDataAccess } from '../src/main/ipc/dataAccess'
import { Runtime } from '../src/main/services/runtime'

vi.mock('../src/main/services/processScanner', () => ({
  ProcessScanner: class { dispose(): void {} }
}))

function latch(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

describe('flushBeforeShutdown', () => {
  it('gives concurrent exits the same in-flight flush', async () => {
    const disk = latch()
    const handler = vi.fn(() => disk.promise)
    onBeforeShutdown(handler)
    const first = flushBeforeShutdown()
    const second = flushBeforeShutdown()
    expect(first).toBe(second)
    disk.open()
    await Promise.all([first, second])
    await flushBeforeShutdown()
    expect(handler).toHaveBeenCalledOnce()
  })

  it('surfaces a failed save and permits a later shutdown to retry', async () => {
    vi.resetModules()
    const module = await import('../src/main/services/shutdown')
    const handler = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(undefined)
    module.onBeforeShutdown(handler)
    await expect(module.flushBeforeShutdown()).rejects.toThrow('disk full')
    await expect(module.flushBeforeShutdown()).resolves.toBeUndefined()
    expect(handler).toHaveBeenCalledTimes(2)
  })
})

describe('data transfer gate', () => {
  it('drains existing writes, defers new writes and always releases the gate', async () => {
    const updates = latch()
    const transfer = latch()
    const events: string[] = []
    const existing = runWithDataAccess('apps:update', async () => {
      await updates.promise
      events.push('existing')
    })
    const migrating = withExclusiveDataAccess(async () => {
      events.push('migrating')
      await transfer.promise
      events.push('commit')
    })
    const queued = runWithDataAccess('playtime:session-ended', () => events.push('queued'))
    await expect(withExclusiveDataAccess(async () => undefined)).rejects.toThrow('正在导入或迁移')
    expect(events).toEqual([])
    updates.open()
    await existing
    transfer.open()
    await Promise.all([migrating, queued])
    expect(events).toEqual(['existing', 'migrating', 'commit', 'queued'])
  })

  it('drains already-admitted work while blocking new work, then recovers from a save error', async () => {
    const pending = latch()
    const state: string[] = []
    const admitted = runWithDataAccess('apps:update', async () => {
      await pending.promise
      state.push('written')
    })
    const quit = withShutdownDataAccess(async () => { state.push('cancelled') }, async () => {
      state.push('flushing')
      throw new Error('disk full')
    })
    const rejection = expect(quit).rejects.toThrow('disk full')
    await expect(runWithDataAccess('apps:update', () => undefined)).rejects.toThrow('正在关闭')
    pending.open()
    await Promise.all([admitted, rejection])
    expect(state).toEqual(['cancelled', 'written', 'flushing'])
    await expect(runWithDataAccess('apps:update', () => 42)).resolves.toBe(42)
  })
})

describe('runtime checkpoints', () => {
  it('records elapsed segments once without resetting the original start time', () => {
    vi.useFakeTimers()
    const runtime = new Runtime()
    try {
      vi.setSystemTime(new Date('2026-11-24T00:00:00Z'))
      runtime.start('game', 100, false, [])
      const start = runtime.list()[0].startedAt
      vi.setSystemTime(new Date('2026-11-24T00:00:10Z'))
      expect(runtime.checkpointSessions()).toMatchObject([{ startUtc: start, durationSec: 10 }])
      expect(runtime.list()[0].startedAt).toBe(start)
      expect(runtime.checkpointSessions()).toEqual([])
      vi.setSystemTime(new Date('2026-11-24T00:00:15Z'))
      expect(runtime.endAll()).toMatchObject([{ durationSec: 5 }])
      expect(runtime.list()).toEqual([])
    } finally {
      runtime.dispose()
      vi.useRealTimers()
    }
  })
})
