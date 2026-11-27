import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { cpus, freemem, totalmem } from 'node:os'
import {
  normalizeKevinHudConfig,
  type KevinHudConfig,
  type KevinHudFrame,
  type KevinHudMetric
} from '@shared/kevinHud'
import { formatKevinHudMemoryDisplay } from '@shared/kevinHudMemory'
import {
  formatKevinHudDuration,
  formatKevinHudRate
} from '@shared/kevinHudMetricText'
import { normalizeLauncherFontSelection } from '@shared/launcherFonts'
import type { GlassAppearance, LauncherFontSelection } from '@shared/types'

/**
 * Kevin HUD telemetry.
 *
 * This module is deliberately independent of BrowserWindow/IPC: it formats
 * frames, owns the one shared sampling loop, and talks to one short-lived
 * read-only native helper when system frame / GPU / network values are needed.
 * The overlay window service consumes `onFrame`, while the launch lifecycle
 * supplies the verified PID and elapsed times.
 *
 * Sources:
 * - FPS: submitted IDXGISwapChain/D3D9 Present events for the verified PID
 *   set (ETW), selecting the candidate that actually presents. It never opens
 *   the game process, injects, hooks or reads its memory.
 * - GPU: Windows' PDH "GPU Engine" counter, busiest engine of the target PID,
 *   capped at 100%.
 * - Network: system interface byte counters, excluding loopback; conversion to
 *   a rate happens here.
 * - CPU / memory: Node's `os` cross-section, system-wide percentages.
 */

export interface KevinHudWindowRect {
  x: number
  y: number
  width: number
  height: number
}

export interface KevinHudSessionInfo {
  /**
   * Legacy single target, set only when exactly one identity is verified. When
   * `pids` is present, all entries there are verified candidates and the
   * native helper chooses the presenting PID.
   */
  pid?: number | null
  /**
   * The complete verified process identity set owned by the same Runtime entry
   * that owns play time. The native helper counts Present events only for these
   * PIDs and dynamically selects the one that actually presents.
   */
  pids?: readonly number[] | null
  /** Runtime's verified launch root (the wrapper for an indirect launch). */
  rootPid?: number | null
  appName: string
  iconUrl?: string | null
  fontFamily?: string | null
  launcherFonts?: LauncherFontSelection | null
  appGlass?: GlassAppearance | null
  sessionSeconds?: number | null
  totalSeconds?: number | null
}

export interface KevinHudSystemSnapshot {
  cpuIdle: number | null
  cpuTotal: number | null
  freeMemory: number | null
  totalMemory: number | null
}

export interface KevinHudHelperCapabilities {
  fps: boolean
  gpu: boolean
  net: boolean
  window: boolean
}

export interface KevinHudHelperSample {
  /** Submitted frames per second, or null when the system source is unavailable. */
  fps: number | null
  /** Verified Present-producing PID selected for this sample, when reported. */
  fpsPid?: number | null
  /** Busiest GPU engine percentage, or null when PDH cannot provide it. */
  gpu: number | null
  /** Cumulative system receive bytes, excluding loopback. */
  receivedBytes: number | null
  /** Cumulative system send bytes, excluding loopback. */
  sentBytes: number | null
}

export interface KevinHudHelper {
  readonly capabilities: KevinHudHelperCapabilities
  sample(): Promise<KevinHudHelperSample>
  windowRect(): Promise<KevinHudWindowRect | null>
  /**
   * Replace the verified candidate set without restarting the ETW session.
   * Older/embedded helpers may omit it; the service then recreates the helper.
   */
  setTargets?(pids: readonly number[], rootPid?: number | null): Promise<void>
  close(): Promise<void>
}

export interface KevinHudHelperCreateRequest {
  helperPath: string
  pid: number | null
  /** Complete verified candidate set; `pid` remains for legacy consumers. */
  pids?: readonly number[]
  rootPid?: number | null
  capabilities: KevinHudHelperCapabilities
}

export type KevinHudHelperFactory = (
  request: KevinHudHelperCreateRequest
) => Promise<KevinHudHelper | null>

/**
 * How the sampling loop is driven.
 *
 * - `auto` (default): `start()` owns the shared timer for every metric.
 * - `pull`: no internal timer; `sampleOnce()` runs one cycle on demand and the
 *   helper stays resident until `stop()` releases it.
 */
export type KevinHudSamplingMode = 'auto' | 'pull'

export interface KevinHudMetricsOptions {
  config?: KevinHudConfig
  session?: KevinHudSessionInfo | null
  /**
   * Absolute path to KevinHud.exe. Defaults to `<main bundle>/../native/KevinHud.exe`.
   * Pass null to disable the helper (CPU, memory, clock and elapsed values work).
   */
  helperPath?: string | null
  /**
   * Sampling ownership. Defaults to `auto` so existing callers keep the
   * lifecycle-owned monitoring timer. `pull` is for integrations that own the
   * cadence themselves and call `sampleOnce()`.
   */
  samplingMode?: KevinHudSamplingMode
  onFrame?: (frame: KevinHudFrame) => void
  /** Diagnostics only; never required for normal operation. */
  onError?: (error: Error) => void
  now?: () => number
  /** Monotonic milliseconds, used for network deltas. */
  monotonicNow?: () => number
  readSystem?: () => KevinHudSystemSnapshot | null
  createHelper?: KevinHudHelperFactory
}

export interface KevinHudValuesInput {
  metrics: readonly KevinHudMetric[]
  now?: number
  sessionSeconds?: number | null
  totalSeconds?: number | null
  fps?: number | null
  gpu?: number | null
  cpu?: number | null
  /** Legacy percent-only memory input, used when no size pair is available. */
  memory?: number | null
  /** Used physical memory in bytes from the same system snapshot. */
  memoryUsedBytes?: number | null
  /** Total physical memory in bytes from the same system snapshot. */
  memoryTotalBytes?: number | null
  downloadBytesPerSecond?: number | null
  uploadBytesPerSecond?: number | null
}

// Keep this list aligned with the shared contract. The values are numeric
// strings/formatted text; appName/appIcon remain top-level frame fields so the
// icon URL is never confused with a telemetry value.
const TEXT_METRICS = new Set<KevinHudMetric>([
  'sessionTime',
  'totalTime',
  'fps',
  'gpu',
  'cpu',
  'memory',
  'download',
  'upload',
  'clock'
])

const HELPER_CAPS_NONE: KevinHudHelperCapabilities = {
  fps: false,
  gpu: false,
  net: false,
  window: false
}

const MAX_FPS = 10_000
const MAX_VERIFIED_PIDS = 64
const MAX_HELPER_LINE = 16 * 1024
const DEFAULT_HELPER_START_TIMEOUT = 6_000
const DEFAULT_HELPER_REQUEST_TIMEOUT = 3_000
const HELPER_RETRY_MS = 15_000
const MIN_RATE_ELAPSED_SECONDS = 0.2

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const validPid = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const optionalSeconds = (value: unknown): number | null =>
  finite(value) && value >= 0 ? value : null

const pad2 = (value: number): string => String(value).padStart(2, '0')

// Duration and network-rate text is owned by the shared sizing contract so the
// renderer reserves width from exactly the same bounded forms. Re-exported here
// to keep this module's public API stable for existing callers.
export { formatKevinHudDuration, formatKevinHudRate }

/** Local 24-hour clock, `HH:MM`. */
export function formatKevinHudClock(now: number = Date.now()): string | null {
  if (!finite(now)) return null
  const date = new Date(now)
  if (Number.isNaN(date.getTime())) return null
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** Percent as a compact integer string, clamped to 0..100. */
export function formatKevinHudPercent(value: number | null | undefined): string | null {
  if (!finite(value)) return null
  return `${Math.round(clamp(value, 0, 100))}%`
}

/** Submitted FPS as a compact number (one decimal for fractional rates). */
export function formatKevinHudFps(value: number | null | undefined): string | null {
  if (!finite(value) || value < 0) return null
  const rounded = Math.round(clamp(value, 0, MAX_FPS) * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

export function buildKevinHudValues(
  input: KevinHudValuesInput
): Partial<Record<KevinHudMetric, string | null>> {
  const values: Partial<Record<KevinHudMetric, string | null>> = {}
  const seen = new Set<KevinHudMetric>()
  const clock = formatKevinHudClock(input.now ?? Date.now())
  for (const metric of input.metrics) {
    if (!TEXT_METRICS.has(metric) || seen.has(metric)) continue
    seen.add(metric)
    switch (metric) {
      case 'sessionTime':
        values[metric] = formatKevinHudDuration(input.sessionSeconds)
        break
      case 'totalTime':
        values[metric] = formatKevinHudDuration(input.totalSeconds)
        break
      case 'fps':
        values[metric] = formatKevinHudFps(input.fps)
        break
      case 'gpu':
        values[metric] = formatKevinHudPercent(input.gpu)
        break
      case 'cpu':
        values[metric] = formatKevinHudPercent(input.cpu)
        break
      case 'memory':
        // Prefer the real used/total pair. The percent-only input remains a
        // fallback for callers/tests that only have the legacy percentage.
        values[metric] =
          formatKevinHudMemoryDisplay(input.memoryUsedBytes, input.memoryTotalBytes) ??
          formatKevinHudPercent(input.memory)
        break
      case 'download':
        values[metric] = formatKevinHudRate(input.downloadBytesPerSecond)
        break
      case 'upload':
        values[metric] = formatKevinHudRate(input.uploadBytesPerSecond)
        break
      case 'clock':
        values[metric] = clock
        break
      default:
        break
    }
  }
  return values
}

/** Read the Node cross-section used for the system CPU/RAM percentages. */
export function readNodeSystemSnapshot(): KevinHudSystemSnapshot | null {
  try {
    const cores = cpus()
    const free = freemem()
    const totalMemory = totalmem()
    let idle = 0
    let total = 0
    for (const core of cores) {
      const times = core.times
      if (!times) continue
      idle += times.idle
      total += times.user + times.nice + times.sys + times.idle + times.irq
    }
    return {
      cpuIdle: total > 0 ? idle : null,
      cpuTotal: total > 0 ? total : null,
      freeMemory: Number.isFinite(free) ? free : null,
      totalMemory: Number.isFinite(totalMemory) && totalMemory > 0 ? totalMemory : null
    }
  } catch {
    return null
  }
}

function cpuPercent(previous: KevinHudSystemSnapshot | null, current: KevinHudSystemSnapshot): number | null {
  if (!previous || current.cpuIdle == null || current.cpuTotal == null ||
    previous.cpuIdle == null || previous.cpuTotal == null) {
    return null
  }
  const totalDelta = current.cpuTotal - previous.cpuTotal
  const idleDelta = current.cpuIdle - previous.cpuIdle
  if (!(totalDelta > 0) || !(idleDelta >= 0) || idleDelta > totalDelta) return null
  return clamp((1 - idleDelta / totalDelta) * 100, 0, 100)
}

interface KevinHudMemoryReading {
  usedBytes: number
  totalBytes: number
  percent: number
}

/**
 * Derive used memory from the same OS snapshot that already feeds CPU/RAM.
 * This never calls `os` again: the caller passes the snapshot it just read.
 */
function memoryReading(current: KevinHudSystemSnapshot): KevinHudMemoryReading | null {
  const { freeMemory, totalMemory } = current
  if (!finite(totalMemory) || !finite(freeMemory) || totalMemory <= 0 || freeMemory < 0) {
    return null
  }
  const usedBytes = totalMemory - freeMemory
  if (usedBytes < 0 || usedBytes > totalMemory) return null
  return {
    usedBytes,
    totalBytes: totalMemory,
    percent: clamp((usedBytes / totalMemory) * 100, 0, 100)
  }
}

function normalizePids(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const pids: number[] = []
  for (const candidate of value) {
    if (pids.length >= MAX_VERIFIED_PIDS) break
    if (!validPid(candidate) || pids.includes(candidate)) continue
    pids.push(candidate)
  }
  return pids
}

function normalizeSession(session: KevinHudSessionInfo | null | undefined): KevinHudSessionInfo | null {
  if (!session || typeof session !== 'object') return null
  const pid = validPid(session.pid) ? session.pid : null
  // An explicitly supplied list is the authority. Do not merge a legacy `pid`
  // into it: that could reintroduce an unrelated process after Runtime has
  // already removed it from the verified set.
  const hasPidList = Array.isArray(session.pids)
  const pids = normalizePids(session.pids)
  if (!hasPidList && pid !== null) pids.push(pid)
  const rootPid = validPid(session.rootPid) && pids.includes(session.rootPid)
    ? session.rootPid
    : null
  return {
    // Never claim one of several verified PIDs as "the" target. The native
    // helper owns that choice from actual Present telemetry.
    pid: hasPidList ? (pids.length === 1 ? pids[0] : null) : pid,
    pids,
    rootPid,
    appName: typeof session.appName === 'string' ? session.appName : '',
    iconUrl: typeof session.iconUrl === 'string' ? session.iconUrl : null,
    fontFamily: typeof session.fontFamily === 'string' ? session.fontFamily : null,
    launcherFonts: normalizeLauncherFontSelection(session.launcherFonts),
    appGlass: isRecord(session.appGlass) ? session.appGlass as unknown as GlassAppearance : null,
    sessionSeconds: optionalSeconds(session.sessionSeconds),
    totalSeconds: optionalSeconds(session.totalSeconds)
  }
}

/** Stable identity for a verified target set; order is not significant. */
function targetSetKey(pids: readonly number[], rootPid: number | null): string {
  return `${[...pids].sort((left, right) => left - right).join(',')}:${rootPid ?? 0}`
}

function normalizeConfig(config: KevinHudConfig | undefined): KevinHudConfig {
  try {
    return normalizeKevinHudConfig(config ?? {})
  } catch {
    return normalizeKevinHudConfig({})
  }
}

function rectFromUnknown(value: unknown): KevinHudWindowRect | null {
  if (!isRecord(value)) return null
  const { x, y, width, height } = value
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) return null
  if (width < 1 || height < 1 || width > 100_000 || height > 100_000) return null
  if (Math.abs(x) > 10_000_000 || Math.abs(y) > 10_000_000) return null
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height)
  }
}

export type KevinHudHelperMessage =
  | { kind: 'ready' }
  | { kind: 'targets' }
  | { kind: 'sample'; sample: KevinHudHelperSample }
  | { kind: 'rect'; rect: KevinHudWindowRect | null }
  | { kind: 'error'; error: string }

/**
 * Parse one newline-delimited helper response. JSON is treated strictly as
 * data: bad numbers degrade to null, malformed syntax is rejected, and no
 * response can be arbitrarily large.
 */
export function parseKevinHudHelperMessage(line: string): KevinHudHelperMessage {
  if (typeof line !== 'string' || line.length > MAX_HELPER_LINE) {
    throw new Error('Kevin HUD helper response is too large')
  }
  const text = line.trim()
  if (!text) throw new Error('Kevin HUD helper response is empty')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('Kevin HUD helper response is not valid JSON')
  }
  if (!isRecord(value)) throw new Error('Kevin HUD helper response is not an object')
  if (value.ok === false) {
    const error = typeof value.error === 'string' ? value.error.slice(0, 160) : 'helper_error'
    return { kind: 'error', error }
  }
  if (value.ready === true) return { kind: 'ready' }
  if (value.targets === true) return { kind: 'targets' }
  if (Object.hasOwn(value, 'rect')) {
    return { kind: 'rect', rect: value.rect === null ? null : rectFromUnknown(value.rect) }
  }
  if (Object.hasOwn(value, 'fps') || Object.hasOwn(value, 'gpu') ||
    Object.hasOwn(value, 'rx') || Object.hasOwn(value, 'tx')) {
    const sample: KevinHudHelperSample = {
      fps: finite(value.fps) && value.fps >= 0 ? clamp(value.fps, 0, MAX_FPS) : null,
      gpu: finite(value.gpu) ? clamp(value.gpu, 0, 100) : null,
      receivedBytes: Number.isSafeInteger(value.rx) && (value.rx as number) >= 0
        ? value.rx as number
        : null,
      sentBytes: Number.isSafeInteger(value.tx) && (value.tx as number) >= 0
        ? value.tx as number
        : null
    }
    if (Object.hasOwn(value, 'fpsPid')) {
      sample.fpsPid = validPid(value.fpsPid) ? value.fpsPid : null
    }
    return { kind: 'sample', sample }
  }
  throw new Error('Kevin HUD helper response has an unknown shape')
}

type HelperRequestKind = 'sample' | 'rect' | 'targets'

interface PendingRequest {
  expected: HelperRequestKind
  resolve: (message: KevinHudHelperMessage) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export interface KevinHudHelperClientOptions {
  executable: string
  pid: number | null
  pids?: readonly number[]
  rootPid?: number | null
  capabilities: KevinHudHelperCapabilities
  startTimeoutMs?: number
  requestTimeoutMs?: number
}

/**
 * One long-lived helper process with a bounded line protocol.
 *
 * Commands are serialized, output is capped, and a timeout terminates the
 * helper instead of leaving a request hanging. Every operation accepts only
 * fixed commands and the verified PIDs are passed as numeric argv entries; no
 * shell is involved.
 */
export class KevinHudHelperClient implements KevinHudHelper {
  readonly executable: string
  readonly capabilities: KevinHudHelperCapabilities
  private pids: number[]
  private rootPid: number | null
  private readonly startTimeoutMs: number
  private readonly requestTimeoutMs: number

  private child: ChildProcessWithoutNullStreams | null = null
  private started = false
  private usable = false
  private closing = false
  private failed = false
  private startPromise: Promise<void> | null = null
  private closePromise: Promise<void> | null = null
  private startTimer: NodeJS.Timeout | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null
  private pending: PendingRequest | null = null
  private queue: Promise<void> = Promise.resolve()
  private stdoutBuffer = ''
  private stderr = ''

  constructor(options: KevinHudHelperClientOptions) {
    if (!options || typeof options.executable !== 'string' || !isAbsolute(options.executable)) {
      throw new Error('Kevin HUD helper path must be absolute')
    }
    if (options.pid != null && !validPid(options.pid)) throw new Error('Kevin HUD helper PID is invalid')
    this.executable = options.executable
    const pids = normalizePids(options.pids)
    if (pids.length === 0 && options.pid != null) pids.push(options.pid)
    this.pids = pids
    this.rootPid = validPid(options.rootPid) && pids.includes(options.rootPid)
      ? options.rootPid
      : null
    this.capabilities = { ...options.capabilities }
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_HELPER_START_TIMEOUT
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_HELPER_REQUEST_TIMEOUT
  }

  get isUsable(): boolean {
    return this.usable && !this.closing
  }

  start(): Promise<void> {
    if (this.started) return Promise.resolve()
    if (this.startPromise) return this.startPromise
    if (this.closing) return Promise.reject(new Error('Kevin HUD helper is closed'))
    this.startPromise = new Promise<void>((resolveStart, rejectStart) => {
      this.readyResolve = resolveStart
      this.readyReject = rejectStart
      const args: string[] = []
      if (this.pids.length > 0) args.push('--pid', this.pids.join(','))
      if (this.rootPid !== null) args.push('--root', String(this.rootPid))
      if (this.capabilities.fps) args.push('--fps')
      if (this.capabilities.gpu) args.push('--gpu')
      if (this.capabilities.net) args.push('--net')
      if (this.capabilities.window) args.push('--window')

      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(this.executable, args, {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch (error) {
        this.fail(error as Error)
        return
      }
      this.child = child
      this.startTimer = setTimeout(() => {
        this.fail(new Error('Kevin HUD helper did not become ready'))
      }, this.startTimeoutMs)
      this.startTimer.unref?.()

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk))
      child.stderr.on('data', (chunk: string) => {
        this.stderr = (this.stderr + chunk).slice(-2048)
      })
      child.stdin.on('error', (error: Error) => this.fail(error))
      child.once('error', (error: Error) => this.fail(error))
      child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        this.child = null
        if (this.closing) return
        this.fail(new Error(
          `Kevin HUD helper exited (${code ?? 'null'}${signal ? `, ${signal}` : ''})`
        ))
      })
    })
    return this.startPromise
  }

  sample(): Promise<KevinHudHelperSample> {
    if (!this.capabilities.fps && !this.capabilities.gpu && !this.capabilities.net) {
      return Promise.resolve({ fps: null, gpu: null, receivedBytes: null, sentBytes: null })
    }
    return this.request('sample', 'sample').then((message) => {
      if (message.kind !== 'sample') throw new Error('Kevin HUD helper returned the wrong sample')
      return message.sample
    })
  }

  windowRect(): Promise<KevinHudWindowRect | null> {
    if (!this.capabilities.window) return Promise.resolve(null)
    return this.request('rect', 'rect').then((message) => {
      if (message.kind !== 'rect') throw new Error('Kevin HUD helper returned the wrong rect')
      return message.rect
    })
  }

  /**
   * Update the verified candidate set in the resident helper. The helper keeps
   * its ETW session and PID counters, so a late wrapper->game discovery does
   * not need a stop/start cycle or a background poller.
   */
  setTargets(pids: readonly number[], rootPid?: number | null): Promise<void> {
    const nextPids = normalizePids(pids)
    const nextRoot = validPid(rootPid) && nextPids.includes(rootPid) ? rootPid : null
    if (targetSetKey(nextPids, nextRoot) === targetSetKey(this.pids, this.rootPid)) {
      return Promise.resolve()
    }
    if (!this.isUsable || !this.child) {
      return Promise.reject(new Error('Kevin HUD helper is unavailable'))
    }
    const command = nextPids.length > 0
      ? `targets ${nextPids.join(',')}${nextRoot !== null ? ` ${nextRoot}` : ''}`
      : nextRoot !== null ? `targets ${nextRoot}` : 'targets'
    return this.request('targets', command).then((message) => {
      if (message.kind !== 'targets') {
        throw new Error('Kevin HUD helper returned the wrong targets acknowledgement')
      }
      this.pids = nextPids
      this.rootPid = nextRoot
    })
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.usable = false
    this.started = false
    if (this.startTimer) {
      clearTimeout(this.startTimer)
      this.startTimer = null
    }
    const closeError = new Error('Kevin HUD helper is closed')
    this.readyReject?.(closeError)
    this.readyReject = null
    this.readyResolve = null
    this.rejectPending(closeError)
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = null
      this.closePromise = Promise.resolve()
      return this.closePromise
    }
    this.closePromise = new Promise<void>((resolveClose) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolveClose()
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* already gone */ }
        finish()
      }, 1_500)
      timer.unref?.()
      child.once('exit', finish)
      try {
        child.stdin.write('quit\n')
        child.stdin.end()
      } catch {
        try { child.kill() } catch { /* already gone */ }
        finish()
      }
    })
    return this.closePromise
  }

  private request(expected: HelperRequestKind, command: string): Promise<KevinHudHelperMessage> {
    const run = this.queue.then(() => this.exchange(expected, command))
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private exchange(
    expected: HelperRequestKind,
    command: string
  ): Promise<KevinHudHelperMessage> {
    if (!this.isUsable || !this.child) {
      return Promise.reject(new Error('Kevin HUD helper is unavailable'))
    }
    if (this.pending) return Promise.reject(new Error('Kevin HUD helper request already pending'))
    return new Promise<KevinHudHelperMessage>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending = null
        rejectRequest(new Error('Kevin HUD helper request timed out'))
        this.fail(new Error('Kevin HUD helper request timed out'))
      }, this.requestTimeoutMs)
      timer.unref?.()
      this.pending = {
        expected,
        resolve: resolveRequest,
        reject: rejectRequest,
        timer
      }
      try {
        this.child?.stdin.write(`${command}\n`, (error) => {
          if (!error) return
          if (this.pending?.timer === timer) this.pending = null
          clearTimeout(timer)
          rejectRequest(error)
          this.fail(error)
        })
      } catch (error) {
        this.pending = null
        clearTimeout(timer)
        rejectRequest(error as Error)
        this.fail(error as Error)
      }
    })
  }

  private consumeStdout(chunk: string): void {
    if (this.closing || this.failed) return
    this.stdoutBuffer += chunk
    if (this.stdoutBuffer.length > MAX_HELPER_LINE * 2) {
      this.fail(new Error('Kevin HUD helper output exceeded its limit'))
      return
    }
    let newline: number
    let lines = 0
    while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '')
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (line.trim()) {
        if (++lines > 64) {
          this.fail(new Error('Kevin HUD helper output rate exceeded its limit'))
          return
        }
        this.handleLine(line)
      }
    }
    if (this.stdoutBuffer.length > MAX_HELPER_LINE) {
      this.fail(new Error('Kevin HUD helper response exceeded its limit'))
    }
  }

  private handleLine(line: string): void {
    let message: KevinHudHelperMessage
    try {
      message = parseKevinHudHelperMessage(line)
    } catch (error) {
      this.fail(error as Error)
      return
    }
    if (this.pending) {
      const pending = this.pending
      this.pending = null
      clearTimeout(pending.timer)
      if (message.kind === 'error') {
        pending.reject(new Error(message.error))
        return
      }
      if (message.kind !== pending.expected) {
        pending.reject(new Error('Kevin HUD helper sent an unexpected response'))
        this.fail(new Error('Kevin HUD helper protocol mismatch'))
        return
      }
      pending.resolve(message)
      return
    }
    if (!this.started) {
      if (message.kind === 'ready') {
        this.started = true
        this.usable = true
        if (this.startTimer) {
          clearTimeout(this.startTimer)
          this.startTimer = null
        }
        this.readyResolve?.()
        this.readyResolve = null
        this.readyReject = null
        return
      }
      if (message.kind === 'error') {
        this.fail(new Error(message.error))
        return
      }
      this.fail(new Error('Kevin HUD helper did not announce readiness'))
    }
    // A late, unsolicited response after a timeout is ignored; the timeout has
    // already rejected the request and stopped the helper.
  }

  private rejectPending(error: Error): void {
    const pending = this.pending
    this.pending = null
    if (!pending) return
    clearTimeout(pending.timer)
    pending.reject(error)
  }

  private fail(error: Error): void {
    if (this.failed) return
    this.failed = true
    this.usable = false
    this.started = false
    if (this.startTimer) {
      clearTimeout(this.startTimer)
      this.startTimer = null
    }
    this.readyReject?.(error)
    this.readyReject = null
    this.readyResolve = null
    this.rejectPending(error)
    if (this.child) {
      try { this.child.kill() } catch { /* already exited */ }
    }
  }
}

const capabilitiesCount = (capabilities: KevinHudHelperCapabilities): number =>
  Number(capabilities.fps) + Number(capabilities.gpu) +
  Number(capabilities.net) + Number(capabilities.window)

const capabilitiesEqual = (
  left: KevinHudHelperCapabilities,
  right: KevinHudHelperCapabilities
): boolean =>
  left.fps === right.fps && left.gpu === right.gpu &&
  left.net === right.net && left.window === right.window

interface NetworkBaseline {
  received: number
  sent: number
  at: number
}

interface DynamicValues {
  fps: number | null
  gpu: number | null
  cpu: number | null
  memory: number | null
  memoryUsedBytes: number | null
  memoryTotalBytes: number | null
  downloadBytesPerSecond: number | null
  uploadBytesPerSecond: number | null
}

const EMPTY_DYNAMIC: DynamicValues = {
  fps: null,
  gpu: null,
  cpu: null,
  memory: null,
  memoryUsedBytes: null,
  memoryTotalBytes: null,
  downloadBytesPerSecond: null,
  uploadBytesPerSecond: null
}

/**
 * The single shared HUD sampler.
 *
 * The default `auto` mode samples only while the service is started, the app
 * HUD is enabled, always visible, has at least one metric and has a session.
 * A single timer and a single helper are used for all metrics; an in-flight
 * tick is never duplicated. Disabling the HUD / losing the target PID closes
 * the helper.
 *
 * `pull` mode has no timer: `sampleOnce()` starts logical sampling, runs one
 * cycle, and leaves the helper resident until `stop()` releases it. Settings
 * changes never collect in the background.
 */
export class KevinHudMetricsService {
  private configValue: KevinHudConfig
  private sessionValue: KevinHudSessionInfo | null
  private readonly samplingMode: KevinHudSamplingMode
  private readonly onFrame?: (frame: KevinHudFrame) => void
  private readonly onError?: (error: Error) => void
  private readonly now: () => number
  private readonly monotonicNow: () => number
  private readonly readSystem: () => KevinHudSystemSnapshot | null
  private readonly createHelper: KevinHudHelperFactory | null
  private readonly helperPath: string | null

  private running = false
  private active = false
  private suspended = false
  private hudVisible = true
  private generation = 0
  private cycle: Promise<void> | null = null
  private sampleOnceFlight: Promise<Partial<Record<KevinHudMetric, string | null>>> | null = null
  private timer: NodeJS.Timeout | null = null

  private dynamic: DynamicValues = { ...EMPTY_DYNAMIC }
  private systemBaseline: KevinHudSystemSnapshot | null = null
  private networkBaseline: NetworkBaseline | null = null
  private windowRequested = false

  private helper: KevinHudHelper | null = null
  private helperCapabilities: KevinHudHelperCapabilities | null = null
  /** Target set currently applied to the resident helper. */
  private helperTargetKey = ''
  private helperTask: Promise<KevinHudHelper | null> | null = null
  private helperClosing: Promise<void> = Promise.resolve()
  private helperEpoch = 0
  private helperRetryAt = 0

  constructor(options: KevinHudMetricsOptions = {}) {
    this.configValue = normalizeConfig(options.config)
    this.sessionValue = normalizeSession(options.session)
    this.samplingMode = options.samplingMode === 'pull' ? 'pull' : 'auto'
    this.onFrame = options.onFrame
    this.onError = options.onError
    this.now = options.now ?? (() => Date.now())
    this.monotonicNow = options.monotonicNow ?? (() => performance.now())
    this.readSystem = options.readSystem ?? readNodeSystemSnapshot
    this.helperPath = options.helperPath === null
      ? null
      : options.helperPath
        ? resolve(options.helperPath)
        : defaultKevinHudHelperPath()
    this.createHelper = options.createHelper ?? (
      this.helperPath
        ? async (request) => {
            const client = new KevinHudHelperClient({
              executable: request.helperPath,
              pid: request.pid,
              pids: request.pids,
              rootPid: request.rootPid,
              capabilities: request.capabilities
            })
            await client.start()
            return client
          }
        : null
    )
  }

  get config(): KevinHudConfig {
    return this.configValue
  }

  get session(): KevinHudSessionInfo | null {
    return this.sessionValue
  }

  get samplingActive(): boolean {
    return this.active
  }

  /**
   * Optional visibility gate owned by the overlay integration. In `auto` mode
   * hotkey hiding, screen lock and temporary previews stop all sampling and
   * close the helper; showing the persistent monitor calls it again. The
   * default is visible so a service created at the moment a HUD is shown needs
   * no extra call. `pull` mode is driven explicitly by `sampleOnce()`.
   */
  setHudVisible(visible: boolean): void {
    const next = Boolean(visible)
    if (next === this.hudVisible) return
    this.hudVisible = next
    if (this.samplingMode === 'auto' && this.running) this.reconcile()
  }

  start(): void {
    this.suspended = false
    if (this.running) return
    this.running = true
    // Pull mode deliberately owns no loop: only sampleOnce() collects.
    if (this.samplingMode === 'auto') this.reconcile()
  }

  async stop(): Promise<void> {
    this.suspended = true
    this.running = false
    this.active = false
    this.generation++
    this.clearTimer()
    this.detachHelper()
    this.helperRetryAt = 0
    const creation = this.helperTask
    if (creation) await creation.catch(() => undefined)
    this.detachHelper()
    await this.helperClosing
    const cycle = this.cycle
    if (cycle) await cycle.catch(() => undefined)
    this.cycle = null
    this.sampleOnceFlight = null
    this.systemBaseline = null
    this.resetNetwork()
    this.windowRequested = false
    this.dynamic = { ...EMPTY_DYNAMIC }
  }

  /**
   * Run one real metric cycle and return the resulting frame values.
   *
   * In `pull` mode this is the only entry point that samples: the first call
   * starts the logical sampling state (including the helper), later calls keep
   * the resident helper until `stop()` releases it, and no internal timer is
   * armed. `stop()` suspends until `start()` re-arms it. Concurrent calls share
   * one flight. In `auto` mode it joins an in-flight cycle or runs one
   * immediately while monitoring is active.
   *
   * Metrics that need neither the helper nor the Node system snapshot resolve
   * without waiting for either.
   */
  sampleOnce(): Promise<Partial<Record<KevinHudMetric, string | null>>> {
    if (this.sampleOnceFlight) return this.sampleOnceFlight
    const flight = this.performSampleOnce()
    this.sampleOnceFlight = flight
    void flight.then(
      () => {
        if (this.sampleOnceFlight === flight) this.sampleOnceFlight = null
      },
      () => {
        if (this.sampleOnceFlight === flight) this.sampleOnceFlight = null
      }
    )
    return flight
  }

  async dispose(): Promise<void> {
    await this.stop()
  }

  setSession(session: KevinHudSessionInfo | null): void {
    const next = normalizeSession(session)
    const previousKey = targetSetKey(
      this.sessionValue?.pids ?? [],
      this.sessionValue?.rootPid ?? null
    )
    const nextKey = targetSetKey(next?.pids ?? [], next?.rootPid ?? null)
    this.sessionValue = next
    if (previousKey !== nextKey) {
      // Keep a resident helper: the next cycle applies the new verified set in
      // place (or recreates it once if the helper predates setTargets). Bumping
      // the generation discards any sample already in flight for the old set.
      this.generation++
      this.dynamic.fps = null
      this.dynamic.gpu = null
      this.systemBaseline = null
    }
    if (this.samplingMode !== 'auto' || !this.running) return
    this.reconcile()
    if (this.active) {
      this.publish()
      this.syncHelperCapabilities()
    }
  }

  setConfig(config: KevinHudConfig): void {
    const previous = this.configValue
    this.configValue = normalizeConfig(config)
    // The game monitor no longer needs geometry once the overlay moves to the
    // primary monitor; do not keep advertising window capability to sampling.
    if (this.windowRequested &&
      previous.monitor === 'game' &&
      this.configValue.monitor === 'primary') {
      this.windowRequested = false
    }
    if (this.samplingMode !== 'auto' || !this.running) return
    const wasActive = this.active
    const sampleChanged = previous.sampleSeconds !== this.configValue.sampleSeconds
    const capabilitiesChanged = !capabilitiesEqual(
      this.samplingHelperCapabilities(previous),
      this.samplingHelperCapabilities(this.configValue)
    )
    this.reconcile()
    if (!this.active) return
    if (!wasActive) {
      // reconcile() already began the first tick.
      return
    }
    if (capabilitiesChanged) {
      this.generation++
      this.clearTimer()
      this.detachHelper()
      this.helperRetryAt = 0
      this.resetNetwork()
      this.publish()
      this.beginCycle()
      return
    }
    if (sampleChanged) this.schedule()
    this.publish()
  }

  /** Build the current immutable frame. Integration may use announce/exit. */
  frame(phase: KevinHudFrame['phase'] = 'monitor'): KevinHudFrame {
    const session = this.sessionValue
    return {
      phase,
      config: this.configValue,
      appName: session?.appName ?? '',
      iconUrl: session?.iconUrl ?? null,
      fontFamily: session?.fontFamily ?? null,
      ...(session?.launcherFonts
        ? {
            fontFamilyEn: session.launcherFonts.en,
            fontFamilyZh: session.launcherFonts.zh
          }
        : {}),
      appGlass: session?.appGlass ?? null,
      values: buildKevinHudValues({
        metrics: this.configValue.metrics,
        now: this.now(),
        sessionSeconds: session?.sessionSeconds ?? null,
        totalSeconds: session?.totalSeconds ?? null,
        fps: this.dynamic.fps,
        gpu: this.dynamic.gpu,
        cpu: this.dynamic.cpu,
        memory: this.dynamic.memory,
        memoryUsedBytes: this.dynamic.memoryUsedBytes,
        memoryTotalBytes: this.dynamic.memoryTotalBytes,
        downloadBytesPerSecond: this.dynamic.downloadBytesPerSecond,
        uploadBytesPerSecond: this.dynamic.uploadBytesPerSecond
      })
    }
  }

  /**
   * Native-pixel screen rect of the largest visible top-level window owned by
   * the verified candidate set, preferring the PID that actually presents and
   * then a non-root game over the Runtime shell root. Uses only public
   * Win32/DWM window metadata. Null means unavailable or no visible window.
   *
   * Without active monitoring this uses a window-only helper and closes it
   * before returning, even on failure. While monitoring, the resident helper
   * can be reused; if it has no window capability yet, it is upgraded when no
   * sample is in flight. During a sample a short-lived window helper measures
   * instead; that one-shot measurement does not change the resident helper.
   * No extra scheduler is introduced for geometry.
   */
  async getTargetWindowRect(): Promise<KevinHudWindowRect | null> {
    if (this.sessionPids().length === 0) return null

    // No sampling loop owns a helper, so this measurement is strictly
    // short-lived. In particular, do not prewarm a sampling helper here. This
    // also covers a pull service whose metrics need no helper at all.
    if (!this.active) return this.measureWindowRectOneShot()
    const samplingCapabilities = this.samplingHelperCapabilities()
    samplingCapabilities.window = false
    if (!this.helper && capabilitiesCount(samplingCapabilities) === 0) {
      return this.measureWindowRectOneShot()
    }

    // Replacing the resident helper during an in-flight sample would break
    // that cycle. Measure with a short-lived window helper instead.
    if (this.cycle && !this.helperSupportsWindow()) {
      return this.measureWindowRectOneShot()
    }

    // Only an active request that can reuse or upgrade the resident sampler
    // records the window capability. One-shot measurements above must not leak
    // it into later sampling for an unrelated app or local-only metrics.
    this.windowRequested = true
    const capabilities = this.samplingHelperCapabilities()
    capabilities.window = true
    let helper = await this.ensureHelper(capabilities)
    if (!helper) return null
    if (!(await this.applyHelperTargets(helper))) {
      helper = await this.ensureHelper(capabilities)
      if (!helper || !(await this.applyHelperTargets(helper))) return null
    }
    try {
      return await helper.windowRect()
    } catch (error) {
      this.report(error)
      this.helperRetryAt = this.monotonicNow() + HELPER_RETRY_MS
      this.detachHelper()
      return null
    }
  }

  private helperSupportsWindow(): boolean {
    return this.helper !== null && this.helperCapabilities?.window === true
  }

  private sessionPids(): number[] {
    return normalizePids(this.sessionValue?.pids)
  }

  private sessionRootPid(pids = this.sessionPids()): number | null {
    const root = this.sessionValue?.rootPid ?? null
    return validPid(root) && pids.includes(root) ? root : null
  }

  /**
   * Apply the current Runtime-verified PID set to a resident helper. The
   * native helper updates its ETW filter in place, preserving the session and
   * counters so a late wrapper->game discovery does not start a second helper.
   * A helper without that command is replaced exactly once with a new helper
   * created for the current set.
   */
  private async applyHelperTargets(helper: KevinHudHelper): Promise<boolean> {
    const pids = this.sessionPids()
    const rootPid = this.sessionRootPid(pids)
    const key = targetSetKey(pids, rootPid)
    if (key === this.helperTargetKey) return true
    if (!helper.setTargets) {
      this.detachHelper()
      return false
    }
    try {
      await helper.setTargets(pids, rootPid)
      this.helperTargetKey = key
      return true
    } catch (error) {
      this.report(error)
      this.helperRetryAt = this.monotonicNow() + HELPER_RETRY_MS
      this.detachHelper()
      return false
    }
  }

  private async measureWindowRectOneShot(): Promise<KevinHudWindowRect | null> {
    const capabilities: KevinHudHelperCapabilities = { ...HELPER_CAPS_NONE, window: true }
    const helper = await this.createTransientHelper(capabilities)
    if (!helper) return null
    try {
      return await helper.windowRect()
    } catch (error) {
      this.report(error)
      this.helperRetryAt = this.monotonicNow() + HELPER_RETRY_MS
      return null
    } finally {
      try {
        await helper.close()
      } catch (error) {
        this.report(error)
      }
    }
  }

  private shouldSample(): boolean {
    return this.running &&
      this.hudVisible &&
      this.configValue.enabled &&
      this.configValue.alwaysVisible &&
      this.configValue.metrics.length > 0 &&
      this.sessionValue !== null
  }

  private reconcile(): void {
    if (this.samplingMode !== 'auto') return
    const shouldSample = this.shouldSample()
    if (!shouldSample) {
      if (this.active) {
        this.active = false
        this.generation++
        this.clearTimer()
        this.systemBaseline = null
        this.detachHelper()
      }
      return
    }
    if (!this.active) {
      this.active = true
      this.generation++
      this.helperRetryAt = 0
      this.publish()
      this.beginCycle()
      return
    }
    if (this.cycle) return
    if (!this.timer) this.schedule()
  }

  /**
   * One explicit pull: start the logical sampling state if needed, then join
   * or run the single shared cycle. Never rejects for sampling failures; the
   * caller gets a coherent frame built from whatever could be collected.
   */
  private async performSampleOnce(): Promise<Partial<Record<KevinHudMetric, string | null>>> {
    try {
      if (this.samplingMode === 'pull') {
        // stop() suspends pull sampling until start() explicitly re-arms it.
        if (this.suspended) return this.frame('monitor').values
        this.beginPullSampling()
      }
      if (!this.active) return this.frame('monitor').values
      this.beginCycle()
      const cycle = this.cycle
      if (cycle) await cycle
    } catch (error) {
      this.report(error)
    }
    return this.frame('monitor').values
  }

  private beginPullSampling(): void {
    if (this.active) {
      this.running = true
      return
    }
    // Pull mode has no start()-owned gate: this explicit call is what starts
    // logical sampling and keeps the helper until stop() releases it.
    this.running = true
    this.active = true
    this.generation++
    this.helperRetryAt = 0
    this.systemBaseline = null
  }

  private publish(): void {
    if (!this.onFrame) return
    try {
      this.onFrame(this.frame())
    } catch (error) {
      this.report(error)
    }
  }

  private beginCycle(): void {
    if (!this.active || this.cycle) return
    const generation = this.generation
    const cycle = this.collect(generation)
      .catch((error) => this.report(error))
      .finally(() => {
        if (this.cycle === cycle) this.cycle = null
        if (this.active && this.samplingMode === 'auto') this.schedule()
      })
    this.cycle = cycle
    void cycle
  }

  private schedule(): void {
    this.clearTimer()
    if (!this.active || this.samplingMode !== 'auto') return
    const seconds = clamp(this.configValue.sampleSeconds, 0.5, 5)
    this.timer = setTimeout(() => {
      this.timer = null
      this.beginCycle()
    }, Math.round(seconds * 1000))
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }

  private async collect(generation: number): Promise<void> {
    const config = this.configValue
    const metrics = new Set(config.metrics)
    const capabilities = this.samplingHelperCapabilities(config)
    let helperSample: KevinHudHelperSample | null = null
    let helper: KevinHudHelper | null = null

    if (capabilitiesCount(capabilities) > 0) {
      helper = await this.ensureHelper(capabilities)
      if (helper && this.current(generation) && !(await this.applyHelperTargets(helper))) {
        helper = await this.ensureHelper(capabilities)
        if (helper && !(await this.applyHelperTargets(helper))) helper = null
      }
      if (helper && this.current(generation)) {
        try {
          helperSample = await helper.sample()
        } catch (error) {
          this.report(error)
          this.helperRetryAt = this.monotonicNow() + HELPER_RETRY_MS
          this.detachHelper()
        }
      }
    }

    if (!this.current(generation)) return

    const needsSystem = metrics.has('cpu') || metrics.has('memory')
    if (needsSystem) {
      let snapshot: KevinHudSystemSnapshot | null = null
      try {
        snapshot = this.readSystem()
      } catch (error) {
        this.report(error)
      }
      if (snapshot) {
        this.dynamic.cpu = metrics.has('cpu') ? cpuPercent(this.systemBaseline, snapshot) : null
        const memory = metrics.has('memory') ? memoryReading(snapshot) : null
        this.dynamic.memory = memory?.percent ?? null
        this.dynamic.memoryUsedBytes = memory?.usedBytes ?? null
        this.dynamic.memoryTotalBytes = memory?.totalBytes ?? null
        this.systemBaseline = snapshot
      } else {
        this.systemBaseline = null
        this.dynamic.cpu = null
        this.dynamic.memory = null
        this.dynamic.memoryUsedBytes = null
        this.dynamic.memoryTotalBytes = null
      }
    } else {
      this.systemBaseline = null
      this.dynamic.cpu = null
      this.dynamic.memory = null
      this.dynamic.memoryUsedBytes = null
      this.dynamic.memoryTotalBytes = null
    }

    if (helperSample) {
      // A Present FPS is only accepted when the helper attributes it to a PID
      // in the same verified set that Runtime uses for play time. Helpers that
      // predate fpsPid are accepted for backward compatibility.
      const reportedPid = helperSample.fpsPid
      const pidVerified = reportedPid === undefined
        ? true
        : validPid(reportedPid) && this.sessionPids().includes(reportedPid)
      this.dynamic.fps = capabilities.fps && pidVerified && finite(helperSample.fps)
        ? helperSample.fps
        : null
      this.dynamic.gpu = capabilities.gpu && finite(helperSample.gpu) ? helperSample.gpu : null
      if (capabilities.net) this.updateNetwork(helperSample)
      else {
        this.resetNetwork()
        this.dynamic.downloadBytesPerSecond = null
        this.dynamic.uploadBytesPerSecond = null
      }
    } else {
      this.dynamic.fps = null
      this.dynamic.gpu = null
      this.resetNetwork()
      this.dynamic.downloadBytesPerSecond = null
      this.dynamic.uploadBytesPerSecond = null
    }

    if (!this.current(generation)) return
    this.publish()
  }

  private current(generation: number): boolean {
    return this.active && this.running && generation === this.generation
  }

  private updateNetwork(sample: KevinHudHelperSample): void {
    const received = sample.receivedBytes
    const sent = sample.sentBytes
    if (!Number.isSafeInteger(received) || !Number.isSafeInteger(sent) ||
      (received as number) < 0 || (sent as number) < 0) {
      this.resetNetwork()
      this.dynamic.downloadBytesPerSecond = null
      this.dynamic.uploadBytesPerSecond = null
      return
    }
    const now = this.monotonicNow()
    const previous = this.networkBaseline
    this.networkBaseline = { received: received as number, sent: sent as number, at: now }
    if (!previous) {
      this.dynamic.downloadBytesPerSecond = null
      this.dynamic.uploadBytesPerSecond = null
      return
    }
    const elapsed = (now - previous.at) / 1000
    if (!(elapsed >= MIN_RATE_ELAPSED_SECONDS)) {
      this.dynamic.downloadBytesPerSecond = null
      this.dynamic.uploadBytesPerSecond = null
      return
    }
    const receivedDelta = (received as number) - previous.received
    const sentDelta = (sent as number) - previous.sent
    // A counter reset (adapter changed / wrapped) must not produce a spike.
    if (receivedDelta < 0 || sentDelta < 0) {
      this.dynamic.downloadBytesPerSecond = null
      this.dynamic.uploadBytesPerSecond = null
      return
    }
    this.dynamic.downloadBytesPerSecond = receivedDelta / elapsed
    this.dynamic.uploadBytesPerSecond = sentDelta / elapsed
  }

  private resetNetwork(): void {
    this.networkBaseline = null
  }

  private samplingHelperCapabilities(config = this.configValue): KevinHudHelperCapabilities {
    const metrics = new Set(config.metrics)
    const hasTargets = this.sessionPids().length > 0
    return {
      fps: metrics.has('fps') && hasTargets,
      // GPU Engine is per-process; without a verified target it must stay
      // unavailable rather than silently sampling an unrelated process.
      gpu: metrics.has('gpu') && hasTargets,
      net: metrics.has('download') || metrics.has('upload'),
      window: this.windowRequested && hasTargets
    }
  }

  private syncHelperCapabilities(): void {
    if (this.samplingMode !== 'auto' || !this.helper) return
    const requested = this.samplingHelperCapabilities()
    if (this.helperCapabilities && capabilitiesEqual(this.helperCapabilities, requested)) return
    this.generation++
    this.detachHelper()
    this.beginCycle()
  }

  private async createTransientHelper(
    capabilities: KevinHudHelperCapabilities
  ): Promise<KevinHudHelper | null> {
    if (!this.createHelper || !this.helperPath) return null
    if (this.monotonicNow() < this.helperRetryAt) return null
    const pids = this.sessionPids()
    return this.createHelperFor(capabilities, this.helperEpoch, pids, this.sessionRootPid(pids))
  }

  private async ensureHelper(
    capabilities: KevinHudHelperCapabilities
  ): Promise<KevinHudHelper | null> {
    if (!this.createHelper || capabilitiesCount(capabilities) === 0) return null
    if (this.helper && this.helperCapabilities &&
      capabilitiesEqual(this.helperCapabilities, capabilities)) {
      return this.helper
    }
    if (this.helperTask) {
      await this.helperTask.catch(() => undefined)
      if (this.helper && this.helperCapabilities &&
        capabilitiesEqual(this.helperCapabilities, capabilities)) {
        return this.helper
      }
      return null
    }
    if (this.monotonicNow() < this.helperRetryAt) return null
    if (this.helper) this.detachHelper()
    await this.helperClosing
    const epoch = this.helperEpoch
    const pids = this.sessionPids()
    const task = this.startHelper(capabilities, epoch, pids, this.sessionRootPid(pids))
    this.helperTask = task
    try {
      return await task
    } finally {
      if (this.helperTask === task) this.helperTask = null
    }
  }

  private async createHelperFor(
    capabilities: KevinHudHelperCapabilities,
    epoch: number,
    pids: number[],
    rootPid: number | null
  ): Promise<KevinHudHelper | null> {
    const path = this.helperPath
    const createHelper = this.createHelper
    if (!path || !createHelper) return null
    try {
      const helper = await createHelper({
        helperPath: path,
        // `pid` is only a legacy single-target hint; a multi-PID set must be
        // resolved by the helper's Present telemetry, never by array order.
        pid: pids.length === 1 ? pids[0] : null,
        pids: [...pids],
        rootPid,
        capabilities: { ...capabilities }
      })
      if (!helper) return null
      if (epoch !== this.helperEpoch) {
        await helper.close().catch(() => undefined)
        return null
      }
      if (!capabilitiesEqual(helper.capabilities, capabilities)) {
        await helper.close().catch(() => undefined)
        this.report(new Error('Kevin HUD helper reported unexpected capabilities'))
        this.helperRetryAt = this.monotonicNow() + HELPER_RETRY_MS
        return null
      }
      return helper
    } catch (error) {
      this.report(error)
      this.helperRetryAt = this.monotonicNow() + HELPER_RETRY_MS
      return null
    }
  }

  private async startHelper(
    capabilities: KevinHudHelperCapabilities,
    epoch: number,
    pids: number[],
    rootPid: number | null
  ): Promise<KevinHudHelper | null> {
    const helper = await this.createHelperFor(capabilities, epoch, pids, rootPid)
    if (!helper) return null
    this.helper = helper
    this.helperCapabilities = { ...capabilities }
    this.helperTargetKey = targetSetKey(pids, rootPid)
    this.helperRetryAt = 0
    this.resetNetwork()
    return helper
  }

  private detachHelper(): void {
    this.helperEpoch++
    const helper = this.helper
    this.helper = null
    this.helperCapabilities = null
    this.helperTargetKey = ''
    this.resetNetwork()
    this.dynamic.fps = null
    this.dynamic.gpu = null
    this.dynamic.downloadBytesPerSecond = null
    this.dynamic.uploadBytesPerSecond = null
    if (!helper) return
    this.helperClosing = this.helperClosing.then(async () => {
      try {
        await helper.close()
      } catch (error) {
        this.report(error)
      }
    })
  }

  private report(error: unknown): void {
    if (!this.onError) return
    const value = error instanceof Error ? error : new Error(String(error))
    try {
      this.onError(value)
    } catch {
      // Diagnostics must never break the sampler.
    }
  }
}

/**
 * The build output lives next to the main bundle (`out/native` in development,
 * inside the versioned app payload after packaging). Integration that copies
 * the helper elsewhere can pass an explicit path instead.
 */
export function defaultKevinHudHelperPath(): string {
  const directory = typeof __dirname === 'string' ? __dirname : process.cwd()
  return join(directory, '..', 'native', 'KevinHud.exe')
}

/** Small helper for integration/tests: validate a helper path before spawning. */
export function isKevinHudHelperPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && isAbsolute(value)
}
