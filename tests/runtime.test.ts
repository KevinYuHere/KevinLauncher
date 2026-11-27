import { describe, expect, it, vi } from 'vitest'
import { observeLaunch, type ProcessLineage } from '../src/main/services/processObservation'
import { ProcessScanner } from '../src/main/services/processScanner'
import {
  BACKGROUND_POLL_INTERVAL_MS,
  FOREGROUND_POLL_INTERVAL_MS,
  Runtime
} from '../src/main/services/runtime'
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

  it('keeps a verified wrapper and its late game child in one identity set', () => {
    const session = lineage()
    const wrapper = item(1000, 1, WRAPPER, at)
    const game = item(1001, 1000, PATH, at + 5_000)
    const unrelated = item(2001, 0, 'C:\\Other\\other.exe', at + 5_000)
    expect([...observeLaunch(session, [wrapper], () => true, at + 100).keys()]).toEqual([1000])
    // The wrapper stays present while Runtime discovers the rendering child.
    // Both belong to the same play-time session; FPS selection may hand off
    // only within this verified set.
    expect([...observeLaunch(session, [wrapper, game, unrelated], () => true, at + 5_100).keys()])
      .toEqual([1000, 1001])
  })

  it('does not claim a matching executable launched after the discovery window', () => {
    const session = lineage()
    const late = item(1002, 0, PATH, at + 6 * 60_000)
    expect([...observeLaunch(session, [late], () => true, at + 6 * 60_000 + 1_000).values()]).toEqual([])
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

  it('refuses to stop from a stale PID list while observation is paused', async () => {
    const now = Date.now()
    const process = item(1000, 1, WRAPPER, now)
    let alive = true
    const scanner = {
      snapshot: vi.fn(async () => (alive ? [process] : [])),
      dispose: vi.fn(async () => {})
    }
    const terminate = vi.fn(async () => {
      alive = false
      return 'stopped' as const
    })
    const runtime = new Runtime(scanner, terminate)
    try {
      runtime.start('paused', process.pid, false, [], true, { requestedAt: now, rootExecutable: WRAPPER })
      await vi.waitFor(() => expect(runtime.list()).toMatchObject([{ pids: [process.pid] }]))
      const release = runtime.pausePolling()
      expect(await runtime.stop('paused')).toMatchObject({
        ok: false,
        killed: 0,
        error: '无法确认进程身份，未执行停止'
      })
      expect(terminate).not.toHaveBeenCalled()
      release()
      expect(await runtime.stop('paused')).toMatchObject({ ok: true, killed: 1 })
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
      await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_INTERVAL_MS)
      expect(runtime.list()).toMatchObject([
        { appId: 'first', pids: [first.pid] }, { appId: 'second', pids: [second.pid], confirmed: true }
      ])
    } finally {
      finishFirstScan([])
      await runtime.dispose()
      vi.useRealTimers()
    }
  })

  it('slows the scan while the launcher is backgrounded and ticks immediately on return', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(at)
    const snapshot = vi.fn(async () => [])
    const runtime = new Runtime({ snapshot, dispose: async () => {} })
    try {
      runtime.start('pending', 1000, false, [], true, { requestedAt: at, rootExecutable: PATH })
      await vi.advanceTimersByTimeAsync(0)
      expect(snapshot).toHaveBeenCalledOnce()

      runtime.setForeground(false)
      await vi.advanceTimersByTimeAsync(FOREGROUND_POLL_INTERVAL_MS)
      expect(snapshot).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_INTERVAL_MS - FOREGROUND_POLL_INTERVAL_MS)
      expect(snapshot).toHaveBeenCalledTimes(2)

      runtime.setForeground(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(snapshot).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(FOREGROUND_POLL_INTERVAL_MS)
      expect(snapshot).toHaveBeenCalledTimes(4)
    } finally {
      await runtime.dispose()
      vi.useRealTimers()
    }
  })

  it('slows the scan once a tracked game is confirmed, then resumes fast after it exits', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(at)
    const game = item(1000, 1, PATH, at)
    let alive = true
    const snapshot = vi.fn(async () => (alive ? [game] : []))
    const runtime = new Runtime({ snapshot, dispose: async () => {} })
    try {
      runtime.start('game', game.pid, false, [], true, { requestedAt: at, rootExecutable: PATH }, 'genshin')
      await vi.advanceTimersByTimeAsync(0)
      expect(runtime.list()).toMatchObject([{ appId: 'game', confirmed: true }])
      expect(snapshot).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(FOREGROUND_POLL_INTERVAL_MS)
      expect(snapshot).toHaveBeenCalledOnce()

      runtime.start('next', 2000, false, [], true, { requestedAt: Date.now(), rootExecutable: PATH })
      await vi.advanceTimersByTimeAsync(0)
      expect(snapshot).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_INTERVAL_MS - FOREGROUND_POLL_INTERVAL_MS)
      expect(snapshot).toHaveBeenCalledTimes(3)

      alive = false
      await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_INTERVAL_MS)
      expect(runtime.list()).toMatchObject([{ appId: 'next', confirmed: false }])
      await vi.advanceTimersByTimeAsync(FOREGROUND_POLL_INTERVAL_MS)
      expect(snapshot).toHaveBeenCalledTimes(5)
    } finally {
      await runtime.dispose()
      vi.useRealTimers()
    }
  })

  it('keeps the fast cadence for confirmed non-games and an unconfirmed game marker', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(at)
    const app = item(1000, 1, WRAPPER, at)
    const linked = item(2000, 1, 'C:\\Tools\\tool.exe', at + 1)
    const snapshot = vi.fn(async () => [app, linked])
    const runtime = new Runtime({ snapshot, dispose: async () => {} })
    try {
      runtime.start('app', app.pid, false, [], true, { requestedAt: at, rootExecutable: WRAPPER })
      runtime.start('linked:task', linked.pid, false, [], true, {
        requestedAt: at + 1, rootExecutable: 'C:\\Tools\\tool.exe'
      })
      runtime.start('waiting', 9999, false, [], true, {
        requestedAt: at + 1, rootExecutable: PATH
      }, 'starrail')
      await vi.advanceTimersByTimeAsync(0)
      expect(runtime.list()).toMatchObject([
        { appId: 'app', confirmed: true },
        { appId: 'linked:task', confirmed: false },
        { appId: 'waiting', confirmed: false }
      ])
      expect(snapshot).toHaveBeenCalledOnce()

      // The scan in flight when the other sessions start only observes the
      // entries present at its beginning. The next foreground poll must pick
      // up the linked process, and both confirmed non-games plus the
      // unconfirmed game marker must keep the 4 s cadence.
      await vi.advanceTimersByTimeAsync(FOREGROUND_POLL_INTERVAL_MS)
      expect(runtime.list()).toMatchObject([
        { appId: 'app', confirmed: true },
        { appId: 'linked:task', confirmed: true },
        { appId: 'waiting', confirmed: false }
      ])
      expect(snapshot).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(FOREGROUND_POLL_INTERVAL_MS)
      expect(runtime.list()).toMatchObject([
        { appId: 'app', confirmed: true },
        { appId: 'linked:task', confirmed: true },
        { appId: 'waiting', confirmed: false }
      ])
      expect(snapshot).toHaveBeenCalledTimes(3)
    } finally {
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
