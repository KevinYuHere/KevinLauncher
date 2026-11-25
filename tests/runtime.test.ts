import { describe, expect, it, vi } from 'vitest'
import { observeLaunch, type ProcessLineage } from '../src/main/services/processObservation'
import { ProcessScanner } from '../src/main/services/processScanner'
import { Runtime } from '../src/main/services/runtime'
import type { ProcessIdentity } from '../src/main/services/processTree'

const PATH = 'D:\\游戏 游戏\\game.exe'
const WRAPPER = 'D:\\游戏 游戏\\starter.exe'
const at = Date.parse('2026-11-25T01:02:03Z')
const item = (pid: number, ppid: number, executable: string, createdAt: number): ProcessIdentity =>
  ({ pid, ppid, executable, createdAt, name: executable.split('\\').at(-1)! })
const lineage = (): ProcessLineage => ({
  rootPid: 1000, monitor: new Set(['game.exe']),
  intent: { requestedAt: at, rootExecutable: WRAPPER, monitorDirectory: 'D:\\游戏 游戏' },
  seen: new Map(), inspected: false
})

describe('Windows process observation', () => {
  it('follows descendants after a short-lived parent and ignores a matching name elsewhere', () => {
    const session = lineage()
    const actual = item(1001, 1000, PATH, at + 5)
    const other = item(2000, 0, 'C:\\Games\\game.exe', at + 7)
    const older = item(1002, 0, PATH, at - 50_000)
    expect([...observeLaunch(session, [other, older, actual], () => true, at + 200).values()]).toEqual([actual])
    expect([...observeLaunch(session, [other, actual], () => true, at + 5000).values()]).toEqual([actual])
  })

  it('excludes a reused process ID and the new process descendants', () => {
    const session = lineage()
    const original = item(1000, 1, WRAPPER, at)
    observeLaunch(session, [original], () => true, at + 200)
    const reused = item(1000, 1, WRAPPER, at + 5_000)
    const unrelatedChild = item(1001, 1000, 'D:\\Other\\other.exe', at + 5_100)
    expect([...observeLaunch(session, [reused, unrelatedChild], () => true, at + 6_000)]).toEqual([])
  })

  it('tracks the same runtime across a partial stop and blocks duplicate launch requests', async () => {
    const start = Date.now()
    const root = item(1000, 1, WRAPPER, start)
    const child = item(1001, 1000, PATH, start + 1)
    let processes = [root, child]
    let childMayExit = false
    const scanner = { snapshot: vi.fn(async () => processes), dispose: vi.fn(async () => {}) }
    const terminate = vi.fn(async (process: ProcessIdentity) => {
      if (process.pid === child.pid && !childMayExit) return 'failed' as const
      processes = processes.filter(({ pid }) => pid !== process.pid)
      return 'stopped' as const
    })
    const runtime = new Runtime(scanner, terminate)
    try {
      const release = runtime.reserveLaunch('game')
      expect(release).toBeTypeOf('function')
      expect(runtime.reserveLaunch('game')).toBeNull()
      runtime.start('game', root.pid, false, [], true, { requestedAt: start, rootExecutable: WRAPPER })
      release?.()
      expect(runtime.reserveLaunch('game')).toBeNull()
      expect(await runtime.stop('game')).toMatchObject({ ok: false, killed: 1, remaining: 1 })
      expect(runtime.list()).toMatchObject([{ appId: 'game', confirmed: true, pids: [child.pid] }])
      childMayExit = true
      expect(await runtime.stop('game')).toEqual({ ok: true, killed: 1 })
      expect(runtime.list()).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  it('keeps an unobserved direct launch pending without recording its grace period', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(at)
    const scanner = { snapshot: vi.fn(async () => []), dispose: vi.fn(async () => {}) }
    const runtime = new Runtime(scanner)
    const ended = vi.fn()
    runtime.onSessionEnded(ended)
    try {
      runtime.start('forwarder', 1000, false, [], true, { requestedAt: at, rootExecutable: PATH })
      await vi.advanceTimersByTimeAsync(4_000)
      expect(runtime.list()).toMatchObject([{ confirmed: false, elapsedSec: 0, activeSince: undefined }])
      expect(runtime.checkpointSessions()).toEqual([])
      await vi.advanceTimersByTimeAsync(5 * 60_000 - 4_000)
      expect(runtime.list()).toEqual([])
      expect(ended).not.toHaveBeenCalled()

      runtime.start('forwarder', 1001, false, [], true, { requestedAt: Date.now(), rootExecutable: PATH })
      await vi.advanceTimersByTimeAsync(4_000)
      expect(runtime.endAll()).toEqual([])
    } finally {
      await runtime.dispose()
      vi.useRealTimers()
    }
  })

  it('recognizes a launch started while a previous process scan is in flight', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const now = Date.now()
    const first = item(1000, 1, WRAPPER, now)
    const second = item(2000, 1, PATH, now + 1)
    let finishFirstScan!: (value: ProcessIdentity[]) => void
    const inFlight = new Promise<ProcessIdentity[]>(resolve => { finishFirstScan = resolve })
    const snapshot = vi.fn<() => Promise<ProcessIdentity[]>>()
      .mockReturnValueOnce(inFlight).mockResolvedValue([first, second])
    const runtime = new Runtime({ snapshot, dispose: async () => {} })
    try {
      runtime.start('first', first.pid, false, [], true, { requestedAt: now, rootExecutable: WRAPPER })
      runtime.start('second', second.pid, false, [], true, { requestedAt: now + 1, rootExecutable: PATH })
      expect(snapshot).toHaveBeenCalledOnce()
      finishFirstScan([first])
      await vi.waitFor(() => expect(runtime.list()).toMatchObject([
        { appId: 'first', pids: [first.pid] }, { appId: 'second', confirmed: false }
      ]))
      await vi.advanceTimersByTimeAsync(4_000)
      expect(runtime.list()).toMatchObject([
        { appId: 'first', pids: [first.pid] }, { appId: 'second', pids: [second.pid], confirmed: true }
      ])
    } finally {
      finishFirstScan([])
      await runtime.dispose()
      vi.useRealTimers()
    }
  })
})

describe('process scanner lifecycle', () => {
  it('shares slow enumeration and aborts it permanently on dispose', async () => {
    const scan = vi.fn((signal?: AbortSignal) => new Promise<ProcessIdentity[]>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const scanner = new ProcessScanner(scan)
    const first = scanner.snapshot()
    expect(scanner.snapshot()).toBe(first)
    expect(scan).toHaveBeenCalledOnce()
    const aborted = expect(first).rejects.toThrow('aborted')
    await scanner.dispose()
    await aborted
    await expect(scanner.snapshot()).rejects.toThrow('已关闭')
    expect(scan).toHaveBeenCalledOnce()
  })
})
