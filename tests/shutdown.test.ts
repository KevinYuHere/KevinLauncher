import { describe, expect, it, vi } from 'vitest'
import { flushBeforeShutdown, onBeforeShutdown } from '../src/main/services/shutdown'
import { runWithDataAccess, withExclusiveDataAccess } from '../src/main/ipc/dataAccess'
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
