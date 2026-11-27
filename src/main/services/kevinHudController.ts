import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  normalizeKevinHudConfig,
  type KevinHudConfig,
  type KevinHudFrame,
  type KevinHudMetric
} from '@shared/kevinHud'
import { KEVIN_HUD_CLOSE_DELAY_MS } from '@shared/kevinHudMotion'
import { isMediaFilename } from '@shared/mediaReferences'
import {
  normalizeLauncherFontFamily,
  resolveLauncherFonts
} from '@shared/launcherFonts'
import type {
  AppEntry,
  GlassAppearance,
  LauncherFontSelection,
  LauncherSettings,
  LinkedLaunch
} from '@shared/types'
import {
  buildKevinHudValues,
  type KevinHudSessionInfo,
  type KevinHudWindowRect
} from './kevinHudMetrics'
import {
  KevinHudLifecycle,
  type KevinHudClock,
  type KevinHudHotkeyPort,
  type KevinHudLaunchRequest,
  type KevinHudMetricValues,
  type KevinHudWindowPort
} from './kevinHudLifecycle'
import {
  playKevinHudDeparture,
  type KevinHudDepartureResult,
  type KevinHudDepartureWindow
} from './kevinHudDeparture'
import {
  measureKevinHudBaseHeight,
  measureKevinHudFrameWidth,
  measureKevinHudTargetHeight,
  placeKevinHud,
  type KevinHudDisplay,
  type KevinHudDisplayHint,
  type KevinHudRect
} from './kevinHudPlacement'

/**
 * The main-process owner of the KEVIN HUD integration.
 *
 * The lifecycle, window, placement and metrics modules are independently
 * testable. This service is the one place that connects them to the real
 * launcher: AppStore is the only source of per-app HUD settings, Runtime is the
 * only source of a verified launch identity, and the renderer only ever sends
 * an id + normalized HUD settings. No renderer-supplied path, process id or
 * owner claim is trusted.
 *
 * A launch is prepared only after `Launcher.launch` actually succeeded and
 * Runtime accepted that launch. The one-shot commit ticket is bound to the
 * invoking WebContents/BrowserWindow and expires. A commit can never create a
 * ticket, replay a consumed one, or consume another sender's pending ticket.
 */

/** A transition plus IPC latency must finish well inside this window. */
export const KEVIN_HUD_COMMIT_TTL_MS = 30_000
/** The settings preview is live until dismissed; this is only a safety cap. */
export const KEVIN_HUD_PREVIEW_MS = 5 * 60_000
/**
 * Keep the native HUD window alive for the shared reverse timeline. The
 * renderer's exit frame runs exactly `KEVIN_HUD_CLOSE_DELAY_MS`; destroying the
 * window earlier visibly cuts that animation. Reduced motion bypasses this.
 */
export const KEVIN_HUD_EXIT_MS = KEVIN_HUD_CLOSE_DELAY_MS
const GAME_RECT_TIMEOUT_MS = 900
/** Refresh the game-screen hint at most this often while monitoring. */
const GAME_HINT_REFRESH_MS = 3_000
const MAX_LABEL_LENGTH = 200
const MAX_RUNTIME_KEY_LENGTH = 180
const APP_ID = /^[\w-]+$/
const RUNTIME_KEY = /^(?:linked:)?[\w-]+$/

const SYSTEM_CLOCK: KevinHudClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export interface KevinHudRuntimeEntry {
  appId: string
  pids: readonly number[]
  rootPid?: number | null
  startedAt: string
  elapsedSec?: number
  activeSince?: string
  confirmed?: boolean
}

/** A read/subscribe view of the existing Runtime singleton. */
export interface KevinHudRuntimeSource {
  list(): readonly KevinHudRuntimeEntry[]
  onChanged(listener: () => void): () => void
}

export interface KevinHudPlayTimeSource {
  load(): Promise<void>
  totalForApp(appId: string): number
}

export interface KevinHudAppSource {
  listApps(): Promise<readonly AppEntry[]>
  listLinkedLaunches(): Promise<readonly LinkedLaunch[]>
  /**
   * Partial so embedders/tests that only know the legacy single font keep
   * working; the controller resolves missing per-script fields.
   */
  launcherSettings(): Promise<
    Partial<Pick<LauncherSettings, 'fontFamily' | 'fontFamilyEn' | 'fontFamilyZh'>>
  >
}

export interface KevinHudShellActions {
  /** Restore through behavior.showMainWindow (never a second ad-hoc show). */
  showMainWindow(): void
  /** Keep the tray reachable while the HUD owns the screen. */
  ensureTray?(): void | Promise<void>
}

export interface KevinHudDisplaySnapshot {
  displays: KevinHudDisplay[]
  primaryDisplayId: number
}

/**
 * The subset of BrowserWindow used for the departure. Production passes the
 * actual sender window, never a window looked up by title or process name.
 */
export type KevinHudMainWindow = KevinHudDepartureWindow & {
  id: number
  isVisible?(): boolean
}

/** The actual HUD window API used by the controller (KevinHudWindow fits). */
export interface KevinHudWindowSink {
  display(frame: KevinHudFrame, hint?: KevinHudDisplayHint | null): unknown
  send(frame: KevinHudFrame): boolean
  close(): void
  isOpen?(): boolean
  /**
   * Exact pre-show placement (no window created). Production passes
   * KevinHudWindow.measure so the departure and the real announcement use the
   * same phase-specific rectangle.
   */
  measure?(frame: KevinHudFrame, hint?: KevinHudDisplayHint | null): KevinHudRect | null
  /** Strict ownership check used by the HUD ready handshake. */
  ownsWebContents?(contents: unknown): boolean
}

/** A thin adapter over KevinHudMetricsService. */
export interface KevinHudMetricsBridge {
  sync(config: KevinHudConfig, session: KevinHudSessionInfo): void
  start(): void
  /** Pull-mode one-shot sample; when present the lifecycle owns the cadence. */
  sample?(): Promise<Partial<Record<KevinHudMetric, string | null>>>
  values(): Partial<Record<KevinHudMetric, string | null>>
  targetWindowRect(): Promise<KevinHudWindowRect | null>
  stop(): Promise<void>
}

export type KevinHudDeparture = (
  window: KevinHudMainWindow,
  target: KevinHudRect,
  options?: { immediate?: boolean }
) => Promise<Pick<KevinHudDepartureResult, 'hidden' | 'status'>>

export interface KevinHudHudPage {
  token: string
  /** Exact document URL loaded into the dedicated HUD window. */
  url: string
}

export interface KevinHudControllerOptions {
  windowSink: KevinHudWindowSink
  runtime: KevinHudRuntimeSource
  playTime: KevinHudPlayTimeSource
  appSource: KevinHudAppSource
  shell: KevinHudShellActions
  displays: () => KevinHudDisplaySnapshot | null
  departure?: KevinHudDeparture
  metrics?: KevinHudMetricsBridge | null
  hotkeys?: KevinHudHotkeyPort | null
  clock?: KevinHudClock
  log?: (message: string) => void
  hudPage?: KevinHudHudPage | null
  onDispose?: () => void
  commitTtlMs?: number
  previewMs?: number
  exitMs?: number
}

export interface KevinHudPrepareAppInput {
  senderId: number
  windowId: number
  mainWindow: KevinHudMainWindow
  appId: string
  launchPid: number | null
}

export interface KevinHudPrepareLinkedInput {
  senderId: number
  windowId: number
  mainWindow: KevinHudMainWindow
  linkedId: string
  /** Renderer hint only; it must exist in the app's persisted assignment. */
  ownerAppId?: string | null
  launchPid: number | null
}

export interface KevinHudCommitInput {
  senderId: number
  windowId: number
  runtimeKey: string
  reducedMotion: boolean
}

export interface KevinHudPreparedTicket {
  runtimeKey: string
  senderId: number
  windowId: number
  appId: string
  appName: string
  config: KevinHudConfig
  /** Snapshot of the normalized per-app absorption switch. */
  absorbLauncher: boolean
  iconUrl: string | null
  fontFamily: string | null
  launcherFonts: LauncherFontSelection
  appGlass: GlassAppearance | null
  launchPid: number | null
  request: KevinHudLaunchRequest
  mainWindow: KevinHudMainWindow
  createdAt: number
  expiresAt: number
}

interface LiveHudSession {
  ticket: KevinHudPreparedTicket
  sequence: number
}

function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function normalizeAppId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return id && id.length <= 128 && APP_ID.test(id) ? id : null
}

function normalizeRuntimeKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const key = value.trim()
  return key && key.length <= MAX_RUNTIME_KEY_LENGTH && RUNTIME_KEY.test(key) ? key : null
}

function cleanLabel(value: unknown, fallback: string, max = MAX_LABEL_LENGTH): string {
  if (typeof value !== 'string') return fallback
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return text ? text.slice(0, max) : fallback
}



function positivePid(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function cloneConfig(value: unknown): KevinHudConfig {
  const config = normalizeKevinHudConfig(value)
  return { ...config, metrics: [...config.metrics] }
}

function cloneGlass(value: unknown): GlassAppearance | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return { ...(value as GlassAppearance) }
}

function iconUrlForFile(iconFile: unknown): string | null {
  if (!isMediaFilename(iconFile)) return null
  return `kevin-media://icon/${encodeURIComponent(iconFile)}`
}

function measuredGameRect(value: unknown): KevinHudWindowRect | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const rect = value as Partial<KevinHudWindowRect>
  if (
    typeof rect.x !== 'number' || !Number.isFinite(rect.x) ||
    typeof rect.y !== 'number' || !Number.isFinite(rect.y) ||
    typeof rect.width !== 'number' || !Number.isFinite(rect.width) ||
    typeof rect.height !== 'number' || !Number.isFinite(rect.height) ||
    rect.width < 1 || rect.height < 1
  ) {
    return null
  }
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

/** Stable identity for the display hint used by an open monitor surface. */
function displayHintKey(hint: KevinHudDisplayHint | null | undefined): string {
  if (!hint) return ''
  const display = hint.displayId == null ? '' : String(hint.displayId)
  const game = hint.gameWindowRect
  return game
    ? `${display}:${game.x},${game.y},${game.width},${game.height}`
    : `${display}:`
}

function runtimeEntryFor(
  entries: readonly KevinHudRuntimeEntry[],
  key: string
): KevinHudRuntimeEntry | null {
  return entries.find((entry) => entry.appId === key) ?? null
}

function durationSeconds(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function isTrustedTicket(ticket: KevinHudPreparedTicket, now: number): boolean {
  if (!ticket || typeof ticket !== 'object') return false
  return (
    normalizeRuntimeKey(ticket.runtimeKey) === ticket.runtimeKey &&
    positiveInt(ticket.senderId) &&
    positiveInt(ticket.windowId) &&
    normalizeAppId(ticket.appId) === ticket.appId &&
    ticket.mainWindow !== null &&
    typeof ticket.mainWindow === 'object' &&
    ticket.mainWindow.id === ticket.windowId &&
    ticket.config !== null &&
    typeof ticket.config === 'object' &&
    typeof ticket.absorbLauncher === 'boolean' &&
    ticket.request !== null &&
    typeof ticket.request === 'object' &&
    Number.isFinite(ticket.createdAt) &&
    Number.isFinite(ticket.expiresAt) &&
    ticket.expiresAt > now
  )
}

/**
 * One-shot, sender-bound launch tickets. Kept independent from Electron so the
 * spoofing/expiry/replay rules have a small direct test surface.
 */
export class KevinHudLaunchBinder {
  private readonly pending = new Map<string, KevinHudPreparedTicket>()
  private readonly timers = new Map<string, unknown>()

  constructor(
    private readonly clock: KevinHudClock = SYSTEM_CLOCK,
    private readonly ttlMs = KEVIN_HUD_COMMIT_TTL_MS
  ) {}

  get size(): number {
    this.expireAll()
    return this.pending.size
  }

  prepare(ticket: KevinHudPreparedTicket): boolean {
    if (!isTrustedTicket(ticket, this.clock.now())) return false
    if (ticket.expiresAt - ticket.createdAt > this.ttlMs) return false
    this.remove(ticket.runtimeKey)
    this.pending.set(ticket.runtimeKey, ticket)
    const delay = Math.max(1, ticket.expiresAt - this.clock.now())
    const timer = this.clock.setTimeout(() => {
      if (this.pending.get(ticket.runtimeKey) !== ticket) return
      this.remove(ticket.runtimeKey)
    }, delay)
    this.timers.set(ticket.runtimeKey, timer)
    return true
  }

  /**
   * Consume exactly one ticket. A wrong sender/window does not consume the
   * legitimate one; an expired or forged request never succeeds.
   */
  take(runtimeKey: string, senderId: number, windowId: number): KevinHudPreparedTicket | null {
    const ticket = this.pending.get(runtimeKey)
    if (!ticket) return null
    if (this.clock.now() >= ticket.expiresAt) {
      this.remove(runtimeKey)
      return null
    }
    if (ticket.senderId !== senderId || ticket.windowId !== windowId) return null
    this.remove(runtimeKey)
    return ticket
  }

  hasSender(senderId: number): boolean {
    this.expireAll()
    for (const ticket of this.pending.values()) {
      if (ticket.senderId === senderId) return true
    }
    return false
  }

  /**
   * Replace the in-memory settings snapshot of every ticket already issued for
   * this app. The ticket keeps its one-shot identity, sender/window binding and
   * launch-time absorption decision.
   */
  updateConfigForApp(appId: string, config: KevinHudConfig): KevinHudPreparedTicket[] {
    this.expireAll()
    const updated: KevinHudPreparedTicket[] = []
    for (const ticket of this.pending.values()) {
      if (ticket.appId !== appId) continue
      ticket.config = config
      updated.push(ticket)
    }
    return updated
  }

  clear(): void {
    for (const key of [...this.pending.keys()]) this.remove(key)
  }

  private expireAll(): void {
    const now = this.clock.now()
    for (const [key, ticket] of [...this.pending]) {
      if (now >= ticket.expiresAt) this.remove(key)
    }
  }

  private remove(key: string): void {
    const timer = this.timers.get(key)
    if (timer !== undefined) {
      this.clock.clearTimeout(timer)
      this.timers.delete(key)
    }
    this.pending.delete(key)
  }
}

/**
 * Process-wide HUD controller. One instance owns the one HUD window and the
 * one lifecycle; every app/linked launch adds a session to that same surface.
 */
export class KevinHudController {
  private readonly clock: KevinHudClock
  private readonly binder: KevinHudLaunchBinder
  private readonly lifecycle: KevinHudLifecycle
  private readonly departure: KevinHudDeparture
  private readonly metrics: KevinHudMetricsBridge | null
  private readonly options: KevinHudControllerOptions
  private readonly live = new Map<string, LiveHudSession>()
  /** App currently bound to the settings preview, if it is still on screen. */
  private previewAppId: string | null = null
  private readonly hints = new Map<string, KevinHudDisplayHint | null>()
  private readonly appliedHints = new Map<string, string>()
  private readonly hintRefreshAt = new Map<string, number>()
  private readonly reducedMotion = new Map<string, boolean>()
  private readonly initialFrames = new Map<string, KevinHudFrame>()
  private readonly watchedWindows = new WeakSet<object>()
  private readonly windowPort: KevinHudWindowPort
  private runtimeUnsubscribe: (() => void) | null = null
  private pendingInitialView: { ticket: KevinHudPreparedTicket; reducedMotion: boolean } | null = null
  private latestFrame: KevinHudFrame | null = null
  private metricsQueue: Promise<void> = Promise.resolve()
  /** A live settings refresh must never open a window through the hint path. */
  private applyingLiveConfig = false
  private nextSequence = 0
  private hudFailureRestored = false
  /** True only after this controller actually hid/collapsed the launcher. */
  private launcherAbsorbed = false
  /** Whether the newest launch asked to absorb the launcher. */
  private activeAbsorbLauncher = false
  private disposed = false

  constructor(options: KevinHudControllerOptions) {
    this.options = options
    this.clock = options.clock ?? SYSTEM_CLOCK
    this.binder = new KevinHudLaunchBinder(this.clock, options.commitTtlMs ?? KEVIN_HUD_COMMIT_TTL_MS)
    this.departure = options.departure ?? playKevinHudDeparture
    this.metrics = options.metrics ?? null
    this.windowPort = this.createWindowPort()
    this.lifecycle = new KevinHudLifecycle({
      window: this.windowPort,
      runtime: {
        list: () => this.runtimeIdentities(),
        subscribe: (listener) => this.options.runtime.onChanged(listener)
      },
      sampler: {
        sample: (context) => this.sample(context.runtimeKey, context.metrics)
      },
      shell: {
        waitForMainWindowCollapse: () => this.prepareInitialView(),
        restoreLauncher: () => {
          // Lifecycle only asks for this for an absorbed session with
          // restoreLauncher enabled. Clear the ownership marker before showing.
          this.launcherAbsorbed = false
          this.options.shell.showMainWindow()
        }
      },
      hotkeys: options.hotkeys ?? undefined,
      clock: this.clock,
      log: (message) => this.report(message)
    })
    try {
      this.runtimeUnsubscribe = this.options.runtime.onChanged(() => this.handleRuntimeChanged())
    } catch (error) {
      this.report(`could not observe Runtime (${this.errorText(error)})`)
    }
  }

  /**
   * Prepare an app launch. Returns true only when a HUD ticket was actually
   * prepared (enabled + real tracked launch). Prepared is not started: the
   * renderer commits exactly once after this launch's real transition.
   */
  async prepareAppLaunch(input: KevinHudPrepareAppInput): Promise<boolean> {
    if (this.disposed) return false
    const appId = normalizeAppId(input?.appId)
    if (!appId || !this.validSenderWindow(input)) return false
    if (!this.launchWasTracked(appId, input.launchPid)) return false
    await this.ensurePlayTime()
    const app = await this.findApp(appId)
    if (!app) return false
    if (this.disposed || input.mainWindow.isDestroyed()) return false
    const ticket = await this.buildTicket({
      runtimeKey: appId,
      appId,
      appName: app.name,
      config: app.kevinHud,
      iconFile: app.iconFile,
      glass: app.glass,
      launchPid: input.launchPid,
      senderId: input.senderId,
      windowId: input.windowId,
      mainWindow: input.mainWindow
    })
    if (!ticket || this.disposed || input.mainWindow.isDestroyed()) return false
    return this.binder.prepare(ticket)
  }

  /**
   * Prepare a linked launch. The owner is chosen only from persisted
   * `linkedLaunchIds`: a supplied owner must match that assignment; with no hint
   * exactly one app must be assigned. More than one candidate is ambiguous and
   * therefore never gets HUD authority.
   *
   * Returns true when a ticket was prepared; the renderer still commits it
   * after the transition.
   */
  async prepareLinkedLaunch(input: KevinHudPrepareLinkedInput): Promise<boolean> {
    if (this.disposed) return false
    const linkedId = normalizeAppId(input?.linkedId)
    if (!linkedId || !this.validSenderWindow(input)) return false
    const runtimeKey = `linked:${linkedId}`
    if (!this.launchWasTracked(runtimeKey, input.launchPid)) return false
    await this.ensurePlayTime()

    const [apps, linkedLaunches] = await Promise.all([
      this.options.appSource.listApps(),
      this.options.appSource.listLinkedLaunches()
    ])
    const linked = linkedLaunches.find((entry) => entry.id === linkedId)
    if (!linked) return false
    const candidates = apps.filter((entry) => entry.linkedLaunchIds?.includes(linkedId))
    let owner: AppEntry | null = null
    if (input.ownerAppId === undefined || input.ownerAppId === null) {
      if (candidates.length === 1) owner = candidates[0]
    } else {
      const hint = normalizeAppId(input.ownerAppId)
      owner = hint ? candidates.find((entry) => entry.id === hint) ?? null : null
    }
    if (!owner) return false
    if (this.disposed || input.mainWindow.isDestroyed()) return false

    const ticket = await this.buildTicket({
      runtimeKey,
      appId: owner.id,
      appName: linked.name || owner.name,
      config: owner.kevinHud,
      iconFile: owner.iconFile,
      glass: owner.glass,
      launchPid: input.launchPid,
      senderId: input.senderId,
      windowId: input.windowId,
      mainWindow: input.mainWindow
    })
    if (!ticket || this.disposed || input.mainWindow.isDestroyed()) return false
    return this.binder.prepare(ticket)
  }

  /** Commit the one pending ticket, after the renderer's transition finished. */
  commitLaunch(input: KevinHudCommitInput): boolean {
    if (this.disposed) return false
    const runtimeKey = normalizeRuntimeKey(input?.runtimeKey)
    if (!runtimeKey || !positiveInt(input.senderId) || !positiveInt(input.windowId)) return false
    const ticket = this.binder.take(runtimeKey, input.senderId, input.windowId)
    if (!ticket) return false
    return this.consumeTicket(ticket, input.reducedMotion === true)
  }

  /**
   * Open or refresh the live settings preview. Latest settings always win.
   * `mainWindow` is the authorized IPC sender's own BrowserWindow (optional so
   * existing callers/tests keep working). It is watched only when supplied:
   * with a preview as the first HUD operation, closing it must dispose the HUD
   * instead of leaving an extra window that blocks `window-all-closed`.
   */
  async preview(
    appId: unknown,
    rawConfig: unknown,
    mainWindow?: KevinHudMainWindow | null
  ): Promise<void> {
    if (this.disposed) throw new Error('HUD 不可用')
    const id = normalizeAppId(appId)
    if (!id) throw new Error('应用不存在')
    const app = await this.findApp(id)
    if (!app) throw new Error('应用不存在')
    const settings = await this.options.appSource.launcherSettings().catch(() => null)
    const launcherFonts = resolveLauncherFonts(settings ?? {})
    const handle = this.lifecycle.startPreview({
      appName: app.name,
      config: cloneConfig(rawConfig),
      iconUrl: iconUrlForFile(app.iconFile),
      fontFamily: normalizeLauncherFontFamily(settings?.fontFamily),
      launcherFonts,
      appGlass: cloneGlass(app.glass),
      durationMs: this.options.previewMs ?? KEVIN_HUD_PREVIEW_MS
    })
    if (!handle) throw new Error('无法打开 HUD 预览')
    // The preview itself does not know app ids. Keep the binding here so live
    // settings can only ever amend the app whose preview was actually opened.
    this.previewAppId = id
    if (mainWindow && this.validPreviewWindow(mainWindow)) {
      this.watchMainWindow(mainWindow)
    }
    void this.requestMetricsStop()
  }

  dismissPreview(): void {
    if (this.disposed) return
    this.previewAppId = null
    this.lifecycle.dismissPreview()
  }

  /**
   * Push a newer persisted settings snapshot to an already bound real HUD,
   * preview, or a launch ticket that has been issued but not committed yet.
   *
   * This is deliberately memory-only: no AppStore read, no persistence wait and
   * no window creation. If the app is not currently bound, the call is a no-op,
   * so a stale settings editor can never open a HUD for another app or after
   * the game ended. Each matching surface receives its own normalized copy;
   * launch-time absorption and timeline state stay untouched.
   */
  updateLive(appId: unknown, rawConfig: unknown): boolean {
    if (this.disposed) return false
    const id = normalizeAppId(appId)
    if (!id) return false
    if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) return false
    let config: KevinHudConfig
    try {
      config = cloneConfig(rawConfig)
    } catch (error) {
      this.report(`could not normalize live HUD settings (${this.errorText(error)})`)
      return false
    }

    const sessions: LiveHudSession[] = []
    for (const session of this.live.values()) {
      if (session.ticket.appId === id) sessions.push(session)
    }
    const pending = this.binder.updateConfigForApp(id, config)
    const previewBound = this.previewAppId === id && this.lifecycle.getState().preview
    if (this.previewAppId === id && !previewBound) this.previewAppId = null
    // The issued ticket may have been prepared while the settings were saving,
    // but an expired or unrelated one still leaves us with nothing to update.
    if (sessions.length === 0 && pending.length === 0 && !previewBound) return false

    const render = this.hudWindowOpen()
    const wasApplyingLiveConfig = this.applyingLiveConfig
    this.applyingLiveConfig = true
    let updated = false
    try {
      for (const ticket of pending) {
        ticket.config = cloneConfig(config)
        if (this.lifecycle.updatePreparedLaunch(ticket.request, ticket.config)) updated = true
      }
      for (const session of sessions) {
        const next = cloneConfig(config)
        session.ticket.config = next
        // The launch snapshot only existed to keep the pre-show announcement
        // rectangle stable. New metric selections must win now; dropping it
        // lets the normal enricher fill the updated slots on the next frame.
        this.initialFrames.delete(session.ticket.runtimeKey)
        if (this.lifecycle.updateLive(session.ticket.runtimeKey, next, render)) updated = true
      }
      if (previewBound) {
        if (this.lifecycle.updatePreview(cloneConfig(config), render)) updated = true
      }
    } finally {
      this.applyingLiveConfig = wasApplyingLiveConfig
    }
    return updated
  }

  setLocked(locked: boolean): void {
    if (!this.disposed) this.lifecycle.setLocked(locked === true)
  }

  setSuspended(suspended: boolean): void {
    if (!this.disposed) this.lifecycle.setSuspended(suspended === true)
  }

  /**
   * The HUD page token + exact document URL. A caller still has to verify the
   * main frame and that the sender is not the launcher's own WebContents.
   */
  isTrustedHudPage(url: unknown): boolean {
    const page = this.options.hudPage
    if (!page || typeof url !== 'string') return false
    const actual = this.parseHudUrl(url)
    const expected = this.parseHudUrl(page.url)
    if (!actual || !expected) return false
    if (actual.hash !== '' || expected.hash !== '') return false
    if (actual.href !== expected.href) return false
    const token = actual.searchParams.get('kevinHudToken')
    return token !== null && token === page.token
  }

  isMainSender(senderId: number): boolean {
    if (this.binder.hasSender(senderId)) return true
    for (const session of this.live.values()) {
      if (session.ticket.senderId === senderId) return true
    }
    return false
  }

  /** True only for the exact live WebContents owned by the HUD BrowserWindow. */
  ownsHudContents(contents: unknown): boolean {
    try {
      return this.options.windowSink.ownsWebContents?.(contents) === true
    } catch {
      return false
    }
  }

  /** Cached main->renderer frame for the HUD ready handshake. */
  getLatestHudFrame(): KevinHudFrame | null {
    if (!this.latestFrame) return null
    if (this.options.windowSink.isOpen && !this.options.windowSink.isOpen()) return null
    return this.latestFrame
  }

  get previewVisible(): boolean {
    return this.lifecycle.getState().preview
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.pendingInitialView = null
    this.launcherAbsorbed = false
    this.activeAbsorbLauncher = false
    this.binder.clear()
    this.live.clear()
    this.previewAppId = null
    this.hints.clear()
    this.appliedHints.clear()
    this.hintRefreshAt.clear()
    this.reducedMotion.clear()
    this.initialFrames.clear()
    const unsubscribe = this.runtimeUnsubscribe
    this.runtimeUnsubscribe = null
    try {
      unsubscribe?.()
    } catch (error) {
      this.report(`Runtime unsubscribe failed (${this.errorText(error)})`)
    }
    this.lifecycle.dispose()
    this.latestFrame = null
    try {
      await this.requestMetricsStop()
    } catch (error) {
      this.report(`could not stop HUD metrics (${this.errorText(error)})`)
    }
    try {
      this.options.onDispose?.()
    } catch (error) {
      this.report(`HUD environment cleanup failed (${this.errorText(error)})`)
    }
  }

  private createWindowPort(): KevinHudWindowPort {
    return {
      show: async (frame) => {
        const enriched = this.enrichFrame(frame)
        this.latestFrame = enriched
        const state = this.lifecycle.getState()
        const hint = !state.preview && state.runtimeKey
          ? this.hints.get(state.runtimeKey) ?? null
          : null
        const hintKey = displayHintKey(hint)
        try {
          const result = await this.options.windowSink.display(enriched, hint)
          if (
            result === null &&
            this.options.windowSink.isOpen &&
            !this.options.windowSink.isOpen()
          ) {
            throw new Error('HUD window is unavailable')
          }
          if (!state.preview && state.runtimeKey) {
            this.appliedHints.set(state.runtimeKey, hintKey)
          }
          this.hudFailureRestored = false
        } catch (error) {
          // The main window was already collapsed for the departure. Do not
          // leave the user with neither a launcher nor a working HUD.
          this.restoreLauncherAfterHudFailure()
          throw error
        }
      },
      update: (frame) => {
        const enriched = this.enrichFrame(frame)
        this.latestFrame = enriched
        // A live settings refresh has to stay on the send-only path: even the
        // delayed game-hint display() could create a native window, which a
        // settings update must never do. The next normal monitor tick applies
        // any pending hint without losing it.
        if (!this.applyingLiveConfig && this.applyMonitorHint(enriched)) return
        if (!this.options.windowSink.send(enriched)) this.restoreLauncherAfterHudFailure()
      },
      retract: (frame) => {
        const enriched = this.enrichFrame({ ...frame, phase: 'exit' })
        this.latestFrame = enriched
        const sent = this.options.windowSink.send(enriched)
        if (!sent) {
          this.restoreLauncherAfterHudFailure()
          return undefined
        }
        const state = this.lifecycle.getState()
        // `current` is normally cleared before the reverse retraction starts,
        // so the lifecycle exposes the exiting key explicitly. The preference
        // map intentionally survives Runtime removal until this wait is done.
        const key = state.runtimeKey ?? this.lifecycle.getExitingRuntimeKey()
        const reduced = key ? this.reducedMotion.get(key) === true : false
        if (reduced) return undefined
        return new Promise<void>((resolve) => {
          this.clock.setTimeout(resolve, this.options.exitMs ?? KEVIN_HUD_EXIT_MS)
        })
      },
      hide: () => {
        this.latestFrame = null
        this.hudFailureRestored = false
        // Any hide (natural exit, lock, suspend, hotkey, preview takeover)
        // releases the shared sampler/helper; a later monitor resumes it.
        void this.requestMetricsStop()
        try {
          this.options.windowSink.close()
        } catch (error) {
          this.report(`could not close the HUD window (${this.errorText(error)})`)
        }
      }
    }
  }

  /**
   * A live monitor frame is the only place a freshly measured game-display hint
   * is allowed to take effect. `display` reuses the already-open window, so a
   * changed hint moves/resizes it without a renderer reload or a new entrance.
   * Unchanged hints keep the normal lightweight frame send.
   */
  private applyMonitorHint(frame: KevinHudFrame): boolean {
    const state = this.lifecycle.getState()
    const key = state.runtimeKey
    if (!key || state.preview || state.locked || state.suspended || !state.visible) return false
    if (state.phase !== 'monitor' || !this.live.has(key)) return false
    const applied = this.appliedHints.get(key)
    if (applied === undefined) return false
    const hint = this.hints.get(key) ?? null
    const next = displayHintKey(hint)
    if (next === applied) return false
    try {
      const result = this.options.windowSink.display(frame, hint)
      this.appliedHints.set(key, next)
      if (
        result === null &&
        this.options.windowSink.isOpen &&
        !this.options.windowSink.isOpen()
      ) {
        this.restoreLauncherAfterHudFailure()
      }
    } catch (error) {
      this.report(`could not apply the game-display hint (${this.errorText(error)})`)
      this.restoreLauncherAfterHudFailure()
    }
    return true
  }

  private enrichFrame(frame: KevinHudFrame): KevinHudFrame {
    const state = this.lifecycle.getState()
    const key = !state.preview ? state.runtimeKey : null
    const initial = key ? this.initialFrames.get(key) : undefined
    if (initial && frame.phase === 'announce') {
      // The departure target was measured from this exact frame. Reusing its
      // values keeps the real announcement rectangle identical without another
      // measurement or a second sample before the window exists.
      return { ...frame, values: { ...initial.values } }
    }
    const session = key ? this.live.get(key) ?? null : null
    const info = session ? this.buildSessionInfo(session.ticket) : null
    const base = buildKevinHudValues({
      metrics: frame.config.metrics,
      now: this.clock.now(),
      sessionSeconds: info?.sessionSeconds ?? null,
      totalSeconds: info?.totalSeconds ?? null
    })
    const values: KevinHudMetricValues = { ...frame.values }
    let changed = false
    for (const metric of frame.config.metrics) {
      if (values[metric] !== undefined) continue
      if (base[metric] === undefined) continue
      values[metric] = base[metric] ?? null
      changed = true
    }
    return changed ? { ...frame, values } : frame
  }

  private runtimeIdentities(): { key: string; confirmed: boolean }[] {
    return this.options.runtime.list().map((entry) => ({
      key: entry.appId,
      confirmed: entry.confirmed === true || (Array.isArray(entry.pids) && entry.pids.length > 0)
    }))
  }

  private handleRuntimeChanged(): void {
    if (this.disposed) return
    let entries: readonly KevinHudRuntimeEntry[]
    try {
      entries = this.options.runtime.list()
    } catch (error) {
      this.report(`could not read Runtime for HUD cleanup (${this.errorText(error)})`)
      return
    }
    const present = new Set(entries.map((entry) => entry.appId))
    let removed = false
    for (const key of [...this.live.keys()]) {
      if (present.has(key)) continue
      this.live.delete(key)
      this.hints.delete(key)
      this.appliedHints.delete(key)
      this.hintRefreshAt.delete(key)
      // Keep reduced-motion for the pending reverse exit; dispose clears it.
      this.initialFrames.delete(key)
      removed = true
    }
    if (removed) void this.requestMetricsStop()
  }

  private async sample(
    runtimeKey: string,
    metrics: readonly KevinHudMetric[]
  ): Promise<KevinHudMetricValues | null> {
    if (this.disposed) return null
    const session = this.live.get(runtimeKey)
    if (!session) return null
    const info = this.buildSessionInfo(session.ticket)
    const fallback = buildKevinHudValues({
      metrics,
      now: this.clock.now(),
      sessionSeconds: info.sessionSeconds,
      totalSeconds: info.totalSeconds
    })
    if (!session.ticket.config.alwaysVisible || !this.metrics) return fallback
    try {
      return await this.enqueueMetrics(async () => {
        if (this.disposed || !this.metrics) return fallback
        const metricsBridge = this.metrics
        metricsBridge.sync(session.ticket.config, info)
        metricsBridge.start()
        const sampled = metricsBridge.sample
          ? await metricsBridge.sample()
          : metricsBridge.values()
        // Geometry shares the metric queue and sampling cadence. It runs only
        // for a visible game-screen monitor, so no additional timer/helper is
        // started and a hidden/preview/retracting HUD never queries the HWND.
        await this.refreshGameHint(runtimeKey, session)
        return sampled ?? fallback
      })
    } catch (error) {
      this.report(`metric sample failed (${this.errorText(error)})`)
      return fallback
    }
  }

  private canRefreshGameHint(runtimeKey: string, session: LiveHudSession): boolean {
    if (this.disposed || !this.metrics) return false
    if (!session.ticket.config.alwaysVisible || session.ticket.config.monitor !== 'game') return false
    if (this.live.get(runtimeKey) !== session) return false
    const state = this.lifecycle.getState()
    if (state.preview || state.locked || state.suspended || !state.visible) return false
    if (state.phase !== 'monitor' || state.runtimeKey !== runtimeKey) return false
    if (this.options.windowSink.isOpen && !this.options.windowSink.isOpen()) return false
    return true
  }

  private async refreshGameHint(
    runtimeKey: string,
    session: LiveHudSession
  ): Promise<void> {
    if (!this.canRefreshGameHint(runtimeKey, session) || !this.metrics) return
    const metrics = this.metrics
    const now = this.clock.now()
    const last = this.hintRefreshAt.get(runtimeKey)
    if (last !== undefined && now - last < GAME_HINT_REFRESH_MS) return
    this.hintRefreshAt.set(runtimeKey, now)

    let measured: KevinHudWindowRect | null = null
    try {
      measured = await metrics.targetWindowRect()
    } catch (error) {
      this.report(`could not refresh the game window rect (${this.errorText(error)})`)
      return
    }
    const rect = measuredGameRect(measured)
    // A minimized/hidden game window is not a valid move of the monitor
    // surface; keep the last known hint (and the normal primary fallback).
    if (!rect || !this.canRefreshGameHint(runtimeKey, session)) return
    const hint: KevinHudDisplayHint = { gameWindowRect: { ...rect } }
    if (displayHintKey(this.hints.get(runtimeKey) ?? null) === displayHintKey(hint)) return
    this.hints.set(runtimeKey, hint)
  }

  private async buildTicket(input: {
    runtimeKey: string
    appId: string
    appName: string
    config: unknown
    iconFile: unknown
    glass: unknown
    launchPid: number | null
    senderId: number
    windowId: number
    mainWindow: KevinHudMainWindow
  }): Promise<KevinHudPreparedTicket | null> {
    const config = cloneConfig(input.config)
    if (!config.enabled) return null
    // Shared normalization defaults a missing persisted value to `true`, so
    // historical configs keep absorbing the launcher.
    const absorbLauncher = config.absorbLauncher
    const settings = await this.options.appSource.launcherSettings().catch(() => null)
    const launcherFonts = resolveLauncherFonts(settings ?? {})
    const request = this.lifecycle.prepareLaunch({
      runtimeKey: input.runtimeKey,
      appName: cleanLabel(input.appName, '应用'),
      config,
      iconUrl: iconUrlForFile(input.iconFile),
      fontFamily: normalizeLauncherFontFamily(settings?.fontFamily),
      launcherFonts,
      appGlass: cloneGlass(input.glass),
      absorbLauncher
    })
    if (!request) return null
    const createdAt = this.clock.now()
    const ttl = this.options.commitTtlMs ?? KEVIN_HUD_COMMIT_TTL_MS
    return {
      runtimeKey: input.runtimeKey,
      senderId: input.senderId,
      windowId: input.windowId,
      appId: input.appId,
      appName: request.appName,
      config,
      absorbLauncher,
      iconUrl: iconUrlForFile(input.iconFile),
      fontFamily: normalizeLauncherFontFamily(settings?.fontFamily),
      launcherFonts,
      appGlass: cloneGlass(input.glass),
      launchPid: positivePid(input.launchPid),
      request,
      mainWindow: input.mainWindow,
      createdAt,
      expiresAt: createdAt + ttl
    }
  }

  private consumeTicket(ticket: KevinHudPreparedTicket, reducedMotion: boolean): boolean {
    if (this.disposed) return false
    let runtime: readonly KevinHudRuntimeEntry[]
    try {
      runtime = this.options.runtime.list()
    } catch (error) {
      this.report(`could not confirm the launch before showing HUD (${this.errorText(error)})`)
      return false
    }
    if (!runtimeEntryFor(runtime, ticket.runtimeKey)) {
      this.report('the launched process disappeared before HUD started')
      return false
    }

    // Only an absorbing launch or a game-following HUD needs the initial view
    // prepared. The primary-screen non-absorbing path stays immediate.
    const needsInitialView =
      ticket.absorbLauncher || ticket.config.monitor === 'game'
    this.pendingInitialView = needsInitialView ? { ticket, reducedMotion } : null
    this.hudFailureRestored = false
    // A new launch owns a new announcement. Never reuse a display hint from the
    // previous session before this run has measured its own (if needed).
    this.initialFrames.delete(ticket.runtimeKey)
    this.hints.delete(ticket.runtimeKey)
    this.appliedHints.delete(ticket.runtimeKey)
    this.hintRefreshAt.delete(ticket.runtimeKey)
    const session: LiveHudSession = { ticket, sequence: ++this.nextSequence }
    this.live.set(ticket.runtimeKey, session)
    this.reducedMotion.set(ticket.runtimeKey, reducedMotion)
    this.watchMainWindow(ticket.mainWindow)
    const committed = this.lifecycle.commitLaunch(ticket.request)
    if (!committed) {
      this.pendingInitialView = null
      this.live.delete(ticket.runtimeKey)
      this.reducedMotion.delete(ticket.runtimeKey)
      return false
    }
    this.activeAbsorbLauncher = ticket.absorbLauncher
    void this.requestMetricsStop()
    return true
  }

  private validSenderWindow(input: { senderId: number; windowId: number; mainWindow: KevinHudMainWindow }): boolean {
    if (!input) return false
    return (
      positiveInt(input.senderId) &&
      positiveInt(input.windowId) &&
      !!input.mainWindow &&
      !input.mainWindow.isDestroyed() &&
      input.mainWindow.id === input.windowId
    )
  }

  private validPreviewWindow(value: KevinHudMainWindow): boolean {
    if (!value || typeof value !== 'object' || !positiveInt(value.id)) return false
    try {
      return !value.isDestroyed()
    } catch {
      return false
    }
  }

  /**
   * True when the HUD surface exists (or when a test/embedder does not expose
   * an ownership check). `updateLive` uses this only to suppress a frame push;
   * it still updates the stored snapshot so a later natural resume is correct.
   */
  private hudWindowOpen(): boolean {
    const isOpen = this.options.windowSink.isOpen
    if (!isOpen) return true
    try {
      return isOpen.call(this.options.windowSink) === true
    } catch {
      return false
    }
  }

  /**
   * Closing the main window normally quits the launcher. The extra HUD window
   * would otherwise keep `window-all-closed` from firing, so close the overlay
   * and release its services first. A preview uses the authorized IPC sender's
   * own BrowserWindow here, never a window discovered by title or process.
   * Destroying/recreating the main window while the app intentionally stays
   * alive is not a supported HUD path.
   */
  private watchMainWindow(win: KevinHudMainWindow): void {
    if (this.watchedWindows.has(win)) return
    const evented = win as unknown as {
      once?: (event: 'closed', listener: () => void) => unknown
    }
    if (typeof evented.once !== 'function') return
    this.watchedWindows.add(win)
    evented.once('closed', () => {
      void this.dispose()
    })
  }

  private launchWasTracked(runtimeKey: string, launchPid: number | null): boolean {
    let entries: readonly KevinHudRuntimeEntry[]
    try {
      entries = this.options.runtime.list()
    } catch (error) {
      this.report(`could not read Runtime after launch (${this.errorText(error)})`)
      return false
    }
    const entry = runtimeEntryFor(entries, runtimeKey)
    if (!entry) return false
    const pid = positivePid(launchPid)
    if (pid === null) return true
    if (entry.rootPid === pid) return true
    return Array.isArray(entry.pids) && entry.pids.includes(pid)
  }

  private async findApp(appId: string): Promise<AppEntry | null> {
    try {
      const apps = await this.options.appSource.listApps()
      return apps.find((entry) => entry.id === appId) ?? null
    } catch (error) {
      this.report(`could not read app settings (${this.errorText(error)})`)
      return null
    }
  }

  private async ensurePlayTime(): Promise<void> {
    try {
      await this.options.playTime.load()
    } catch (error) {
      this.report(`could not load play-time totals (${this.errorText(error)})`)
    }
  }

  private buildSessionInfo(ticket: KevinHudPreparedTicket): KevinHudSessionInfo & {
    activeSeconds: number
  } {
    let entry: KevinHudRuntimeEntry | null = null
    try {
      entry = runtimeEntryFor(this.options.runtime.list(), ticket.runtimeKey)
    } catch (error) {
      this.report(`could not read Runtime metrics (${this.errorText(error)})`)
    }
    const now = this.clock.now()
    // Pass the complete Runtime-verified identity set, not just the first PID.
    // Indirect launches commonly expose the wrapper root first; the game is
    // discovered later. The native sampler filters Present events to exactly
    // this set and selects the PID that actually presents.
    const pids: number[] = []
    if (Array.isArray(entry?.pids)) {
      for (const value of entry.pids) {
        if (positivePid(value) && !pids.includes(value)) pids.push(value)
      }
    }
    const rootCandidate = entry?.rootPid ?? null
    const rootPid = positivePid(rootCandidate) ? rootCandidate : null
    // Do not present the wrapper (or any first PID) as the target. With more
    // than one verified identity the legacy field stays null; native Present
    // telemetry is the only selector.
    const pid = pids.length === 1 ? pids[0] : null
    const activeSince = typeof entry?.activeSince === 'string' ? Date.parse(entry.activeSince) : NaN
    // Runtime reports `activeSince` only while the verified session is active.
    // Falling back to `startedAt` here would keep counting through a suspend or
    // while a resume is still pending, double-counting a checkpointed segment.
    const activeSeconds = Number.isFinite(activeSince)
      ? Math.max(0, (now - activeSince) / 1000)
      : 0
    const elapsed = durationSeconds(entry?.elapsedSec)
    let totalBase = 0
    try {
      totalBase = durationSeconds(this.options.playTime.totalForApp(ticket.appId))
    } catch (error) {
      this.report(`could not read play-time total (${this.errorText(error)})`)
    }
    return {
      pid,
      pids,
      rootPid,
      appName: ticket.appName,
      iconUrl: ticket.iconUrl,
      fontFamily: ticket.fontFamily,
      launcherFonts: ticket.launcherFonts,
      appGlass: ticket.appGlass,
      sessionSeconds: elapsed + activeSeconds,
      totalSeconds: totalBase + activeSeconds,
      activeSeconds
    }
  }

  private async prepareInitialView(): Promise<void> {
    const pending = this.pendingInitialView
    this.pendingInitialView = null
    if (!pending || this.disposed) return
    const { ticket, reducedMotion } = pending

    let hint: KevinHudDisplayHint | null = null
    if (ticket.config.monitor === 'game' && this.metrics) {
      // Reuse the bounded monitor measurement so the first display already
      // resolves the game's display, including when the launcher is not absorbed.
      hint = await this.measureGameHint(ticket)
      if (this.disposed || this.live.get(ticket.runtimeKey)?.ticket !== ticket) return
      if (ticket.config.alwaysVisible) {
        // The launch measurement counts toward the monitor refresh cadence.
        this.hintRefreshAt.set(ticket.runtimeKey, this.clock.now())
      } else {
        void this.requestMetricsStop()
      }
    }
    this.hints.set(ticket.runtimeKey, hint)
    this.reducedMotion.set(ticket.runtimeKey, reducedMotion)

    // Without absorption the preparation ends here. The HUD's own placement
    // still follows the user's monitor choice; no departure or main-window API
    // is invoked on this path.
    if (!ticket.absorbLauncher) return

    const win = ticket.mainWindow
    if (!win || win.isDestroyed()) return
    const initial = this.announceFrame(ticket)
    this.initialFrames.set(ticket.runtimeKey, initial)

    const visible = typeof win.isVisible === 'function' ? win.isVisible() : true
    if (!visible) return
    const target = this.options.windowSink.measure?.(initial, hint)
      ?? this.measureTargetBounds(ticket, initial, hint)
    if (!target) {
      this.hideMainWindow(win)
      return
    }
    try {
      const result = await this.departure(win, target, { immediate: reducedMotion })
      if (!result.hidden) {
        this.hideMainWindow(win)
      } else {
        this.launcherAbsorbed = true
        this.ensureTrayReachable()
      }
    } catch (error) {
      this.report(`main-window departure failed (${this.errorText(error)})`)
      this.hideMainWindow(win)
    }
  }

  private announceFrame(ticket: KevinHudPreparedTicket): KevinHudFrame {
    const info = this.buildSessionInfo(ticket)
    return {
      phase: 'announce',
      config: ticket.config,
      appName: ticket.appName,
      iconUrl: ticket.iconUrl,
      fontFamily: ticket.fontFamily,
      fontFamilyEn: ticket.launcherFonts.en,
      fontFamilyZh: ticket.launcherFonts.zh,
      appGlass: ticket.appGlass,
      values: buildKevinHudValues({
        metrics: ticket.config.metrics,
        now: this.clock.now(),
        sessionSeconds: info.sessionSeconds,
        totalSeconds: info.totalSeconds
      })
    }
  }

  private async measureGameHint(ticket: KevinHudPreparedTicket): Promise<KevinHudDisplayHint | null> {
    if (!this.metrics) return null
    const info = this.buildSessionInfo(ticket)
    let timer: unknown
    const timed = new Promise<null>((resolve) => {
      timer = this.clock.setTimeout(() => resolve(null), GAME_RECT_TIMEOUT_MS)
    })
    const measured = this.enqueueMetrics(async () => {
      if (this.disposed || !this.metrics) return null
      this.metrics.sync(ticket.config, info)
      return this.metrics.targetWindowRect()
    }).catch((error) => {
      this.report(`could not read the game window rect (${this.errorText(error)})`)
      return null
    })
    const rect = await Promise.race([measured, timed])
    if (timer !== undefined) this.clock.clearTimeout(timer)
    return rect ? { gameWindowRect: { ...rect } } : null
  }

  private measureTargetBounds(
    ticket: KevinHudPreparedTicket,
    initial: KevinHudFrame,
    hint: KevinHudDisplayHint | null
  ): KevinHudRect | null {
    let snapshot: KevinHudDisplaySnapshot | null = null
    try {
      snapshot = this.options.displays()
    } catch (error) {
      this.report(`could not read displays (${this.errorText(error)})`)
    }
    if (!snapshot || !snapshot.displays.length) return null
    // Mirror KevinHudWindow.measure for embedders/tests that do not supply it:
    // the departure targets the exact announcement host (identity-only auto
    // width and the peak title height), while the settled plate stays at the
    // configured height so preset placement keeps its visible inset.
    const width = measureKevinHudFrameWidth(initial)
    const height = measureKevinHudTargetHeight(initial)
    try {
      return placeKevinHud({
        displays: snapshot.displays,
        primaryDisplayId: snapshot.primaryDisplayId,
        displayHint: hint,
        monitor: ticket.config.monitor,
        anchor: ticket.config.anchor,
        x: ticket.config.x,
        y: ticket.config.y,
        width,
        height,
        positionMode: ticket.config.positionMode,
        plateHeight: measureKevinHudBaseHeight(ticket.config)
      })?.bounds ?? null
    } catch (error) {
      this.report(`could not place the HUD target (${this.errorText(error)})`)
      return null
    }
  }

  private hideMainWindow(win: KevinHudMainWindow): void {
    try {
      if (!win.isDestroyed() && (typeof win.isVisible !== 'function' || win.isVisible())) {
        win.hide()
        this.launcherAbsorbed = true
      }
    } catch (error) {
      this.report(`could not hide the main window (${this.errorText(error)})`)
    }
    this.ensureTrayReachable()
  }

  private ensureTrayReachable(): void {
    try {
      void Promise.resolve(this.options.shell.ensureTray?.()).catch((error) => {
        this.report(`could not ensure the tray (${this.errorText(error)})`)
      })
    } catch (error) {
      this.report(`could not ensure the tray (${this.errorText(error)})`)
    }
  }

  private restoreLauncherAfterHudFailure(): void {
    if (this.hudFailureRestored || this.disposed) return
    this.hudFailureRestored = true
    // Only undo a collapse this controller actually performed for a launch
    // that asked to absorb. With absorbLauncher=false the launcher was never
    // hidden, and a HUD error must not show/focus/move it (or bring it back
    // after the session ended).
    if (this.activeAbsorbLauncher && this.launcherAbsorbed) {
      this.launcherAbsorbed = false
      try {
        this.options.shell.showMainWindow()
      } catch (error) {
        this.report(`could not restore the launcher after a HUD failure (${this.errorText(error)})`)
      }
    }
    void this.requestMetricsStop()
  }

  private enqueueMetrics<T>(action: () => T | Promise<T>): Promise<T> {
    const next = this.metricsQueue.then(action, action)
    this.metricsQueue = next.then(() => undefined, () => undefined)
    return next
  }

  private requestMetricsStop(): Promise<void> {
    if (!this.metrics) return Promise.resolve()
    return this.enqueueMetrics(async () => {
      await this.metrics?.stop()
    })
  }

  private parseHudUrl(value: string): URL | null {
    try {
      const url = new URL(value)
      if (url.username || url.password) return null
      if (url.protocol !== 'file:' && url.protocol !== 'http:' && url.protocol !== 'https:') return null
      if (url.protocol === 'file:' && url.host && url.host !== 'localhost') return null
      return url
    } catch {
      return null
    }
  }

  private report(message: string): void {
    try {
      this.options.log?.(`kevinHud: ${message}`)
    } catch {
      /* diagnostics must never break the HUD */
    }
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
}

/**
 * Production wiring. Kept here (not in an IPC file) so the integration has one
 * owner; it is loaded lazily so the controller/binder can be tested without
 * Electron or the real game/runtime environment.
 */
export interface KevinHudDefaultFactoryInput {
  runtime: KevinHudRuntimeSource
  playTime: KevinHudPlayTimeSource
  log?: (message: string) => void
}

function buildHudPageUrl(token: string): string {
  const dev = process.env.ELECTRON_RENDERER_URL?.trim()
  let url: URL
  if (dev) {
    url = /^[a-zA-Z]:[\\/]/.test(dev) || dev.startsWith('\\\\')
      ? pathToFileURL(dev)
      : new URL(dev)
    if (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.pathname === '' || url.pathname === '/')
    ) {
      url.pathname = '/hud.html'
    }
  } else {
    url = pathToFileURL(join(__dirname, '../renderer/hud.html'))
  }
  url.searchParams.set('kevinHud', '1')
  url.searchParams.set('kevinHudToken', token)
  url.hash = ''
  return url.href
}

function displaySnapshot(electron: typeof import('electron')): KevinHudDisplaySnapshot | null {
  try {
    const primary = electron.screen.getPrimaryDisplay()
    const displays = electron.screen.getAllDisplays().map((display): KevinHudDisplay => {
      let physicalBounds: KevinHudRect | undefined
      if (process.platform === 'win32') {
        try {
          const physical = electron.screen.dipToScreenRect(null, display.bounds)
          physicalBounds = {
            x: physical.x,
            y: physical.y,
            width: physical.width,
            height: physical.height
          }
        } catch {
          // Placement falls back to DIP for this display.
        }
      }
      return {
        id: display.id,
        bounds: { ...display.bounds },
        workArea: { ...display.workArea },
        scaleFactor: display.scaleFactor,
        physicalBounds
      }
    })
    return { displays, primaryDisplayId: primary.id }
  } catch {
    return null
  }
}

export async function createKevinHudController(
  input: KevinHudDefaultFactoryInput
): Promise<KevinHudController> {
  const [windowModule, metricsModule, appStoreModule, behaviorModule, electron] = await Promise.all([
    import('./kevinHudWindow'),
    import('./kevinHudMetrics'),
    import('./appStore'),
    import('./behavior'),
    import('electron')
  ])

  const token = randomBytes(16).toString('hex')
  const pageUrl = buildHudPageUrl(token)
  const hudWindow = new windowModule.KevinHudWindow({ rendererUrl: pageUrl })
  const metricsService = new metricsModule.KevinHudMetricsService({
    samplingMode: 'pull',
    onError: (error) => input.log?.(`kevinHud: metrics (${error.message})`)
  })
  const metrics: KevinHudMetricsBridge = {
    sync: (config, session) => {
      metricsService.setConfig(config)
      metricsService.setSession(session)
    },
    start: () => metricsService.start(),
    sample: () => metricsService.sampleOnce(),
    values: () => metricsService.frame('monitor').values,
    targetWindowRect: () => metricsService.getTargetWindowRect(),
    stop: () => metricsService.stop()
  }
  const appSource: KevinHudAppSource = {
    listApps: async () => (await appStoreModule.AppStore.load()).apps,
    listLinkedLaunches: async () => (await appStoreModule.AppStore.linkedLaunches()),
    launcherSettings: async () => appStoreModule.AppStore.launcherSettings()
  }
  const hotkeys: KevinHudHotkeyPort = {
    register(accelerator, onToggle) {
      if (!electron.globalShortcut.register(accelerator, onToggle)) {
        throw new Error('快捷键已被占用')
      }
      return () => {
        try {
          electron.globalShortcut.unregister(accelerator)
        } catch {
          /* the application is already shutting down */
        }
      }
    }
  }

  const cleanup: (() => void)[] = []
  const controller = new KevinHudController({
    windowSink: hudWindow,
    runtime: input.runtime,
    playTime: input.playTime,
    appSource,
    shell: {
      showMainWindow: () => behaviorModule.showMainWindow(),
      ensureTray: () => behaviorModule.ensureTray()
    },
    displays: () => displaySnapshot(electron),
    metrics,
    hotkeys,
    hudPage: { token, url: pageUrl },
    log: input.log,
    onDispose: () => {
      for (const remove of cleanup.splice(0)) {
        try {
          remove()
        } catch {
          /* best-effort platform listener cleanup */
        }
      }
    }
  })

  try {
    const lock = (): void => controller.setLocked(true)
    const unlock = (): void => controller.setLocked(false)
    const suspend = (): void => controller.setSuspended(true)
    const resume = (): void => controller.setSuspended(false)
    electron.powerMonitor.on('lock-screen', lock)
    electron.powerMonitor.on('unlock-screen', unlock)
    electron.powerMonitor.on('suspend', suspend)
    electron.powerMonitor.on('resume', resume)
    cleanup.push(
      () => electron.powerMonitor.removeListener('lock-screen', lock),
      () => electron.powerMonitor.removeListener('unlock-screen', unlock),
      () => electron.powerMonitor.removeListener('suspend', suspend),
      () => electron.powerMonitor.removeListener('resume', resume)
    )
  } catch (error) {
    input.log?.(`kevinHud: power monitor listeners unavailable (${String(error)})`)
  }

  return controller
}
