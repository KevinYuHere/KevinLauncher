import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { calculatePlayTime } from '../src/main/services/playTimeStats'
import { PlayTimeStore } from '../src/main/services/playTimeStore'
import { Runtime } from '../src/main/services/runtime'

let root: string
vi.mock('electron', () => ({ app: { getPath: () => root } }))
vi.mock('../src/main/services/processScanner', () => ({
  ProcessScanner: class {
    async snapshot() {
      return [{ pid: 20, name: 'test.exe', ppid: 0, executable: 'D:\\tests\\test.exe', createdAt: local(7, 8).getTime() }]
    }
    async dispose() {}
  }
}))

beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'kl-playtime-')) })
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  await fs.rm(root, { recursive: true, force: true })
})

const local = (date: number, hour: number, month = 0): Date => new Date(2026, month, date, hour)
const session = (start: Date, end: Date, seconds = (end.getTime() - start.getTime()) / 1000) => ({
  appId: 'example', startUtc: start.toISOString(), endUtc: end.toISOString(), durationSec: seconds
})

describe('使用时长', () => {
  it('splits at local midnight and uses whole days for the rolling windows', () => {
    const records = [
      session(local(1, 0), local(1, 1)),
      session(local(6, 23), local(7, 2)),
      session(local(7, 2), local(7, 3))
    ]
    const result = calculatePlayTime(records, 'example', 7, local(7, 18).getTime())
    expect(result).toMatchObject({ totalSec: 18000, todaySec: 10800, weekSec: 18000, monthSec: 18000 })
    expect(result.daily.map(({ sec }) => sec)).toEqual([3600, 0, 0, 0, 0, 3600, 10800])
  })

  it.each([[8, 9, 2, 23], [1, 2, 10, 25]])('preserves actual elapsed hours on DST days', (day, next, month, hours) => {
    vi.stubEnv('TZ', 'America/New_York')
    const records = [session(local(day, 0, month), local(next, 0, month))]
    const result = calculatePlayTime(records, 'example', 2, local(next, 8, month).getTime())
    expect(result.totalSec).toBe(hours * 3600)
    expect(result.daily.map(({ sec }) => sec)).toEqual([hours * 3600, 0])
  })

  it('does not persist the same checkpoint twice after retry or reload', async () => {
    const store = new PlayTimeStore()
    const record = session(local(1, 0), local(1, 1))
    await Promise.all([store.addSession(record), store.addSession(record)])
    await store.flush()
    await store.reload()
    await store.addSession(record)
    await store.flush()
    expect(store.totalForApp('example')).toBe(3600)
    const file = JSON.parse(await fs.readFile(join(root, 'playtime.json'), 'utf8'))
    expect(file.sessions).toEqual([record])
  })

  it('retains a checkpoint until a failed disk write can be retried', async () => {
    const store = new PlayTimeStore()
    const record = session(local(1, 0), local(1, 1))
    const rename = fs.rename.bind(fs)
    const file = join(root, 'playtime.json')
    const fail = vi.spyOn(fs, 'rename').mockImplementation((source, target) =>
      target === file ? Promise.reject(new Error('disk full')) : rename(source, target))
    await store.addSession(record)
    await expect(store.flush()).rejects.toThrow('disk full')
    fail.mockRestore()
    await store.flush()
    await store.addSession(record)
    await store.flush()
    expect(JSON.parse(await fs.readFile(file, 'utf8')).sessions).toEqual([record])
  })

  it('does not observe or accrue time outside an explicitly started runtime session', async () => {
    const scanner = { snapshot: vi.fn(async () => []), dispose: vi.fn(async () => {}) }
    const reopened = new Runtime(scanner)
    expect(reopened.list()).toEqual([])
    expect(reopened.checkpointSessions()).toEqual([])
    expect(scanner.snapshot).not.toHaveBeenCalled()
    await reopened.dispose()
  })

  it('settles once at suspend and only counts time after a live process is re-observed', async () => {
    const runtime = new Runtime()
    vi.useFakeTimers({ toFake: ['Date'] })
    const first = local(7, 8).getTime()
    vi.setSystemTime(first)
    try {
      runtime.start('example', 20, false, [], true, { requestedAt: first, rootExecutable: 'D:\\tests\\test.exe' })
      await vi.waitFor(() => expect(runtime.list()[0]?.confirmed).toBe(true))
      expect(runtime.suspendSessions(first + 2_000)).toEqual([
        session(new Date(first), new Date(first + 2_000))
      ])
      expect(runtime.suspendSessions(first + 3_000)).toEqual([])
      const wake = first + 3600_000
      vi.setSystemTime(wake)
      expect(runtime.checkpointSessions(wake)).toEqual([])
      runtime.resumeObservations()
      await vi.waitFor(() => expect(Date.parse(runtime.list()[0]?.activeSince ?? '')).toBeGreaterThanOrEqual(wake))
      const observed = Date.parse(runtime.list()[0].activeSince!)
      expect(runtime.checkpointSessions(observed + 4_000)).toEqual([
        session(new Date(observed), new Date(observed + 4_000))
      ])
      expect(runtime.checkpointSessions(observed + 4_000)).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })
})
