import {
  normalizeKevinHudConfig,
  type KevinHudConfig,
  type KevinHudFrame,
  type KevinHudMetric
} from '@shared/kevinHud'
import { normalizeLauncherFontSelection } from '@shared/launcherFonts'
import type { GlassAppearance, LauncherFontSelection } from '@shared/types'

/**
 * The small, dependency-injected state machine behind the KEVIN HUD.
 *
 * Scope boundary: this module decides *when* the one shared HUD window is
 * announced, monitored, retracted, previewed or hidden. It creates no Electron
 * window, starts no game, samples nothing itself, persists nothing and never
 * touches an application process. The window service, Runtime and metric
 * provider are injected later at the IPC/main owner boundary.
 *
 * The HUD is intentionally one physical window:
 * - a newer launch replaces the older one;
 * - the transient announcement ends after `displaySeconds` and hides itself;
 * - an always-visible HUD announces for about two seconds and then monitors
 *   until Runtime reports that the verified process identity has gone away;
 * - previews temporarily own that same window and restore the live HUD when
 *   they are dismissed or time out.
 */

/** How long an always-visible HUD announces before it starts monitoring. */
export const KEVIN_HUD_ANNOUNCE_MS = 2_000

const MAX_PREVIEW_MS = 5 * 60_000

/** A small clock seam so lifecycle timing can be tested deterministically. */
export interface KevinHudClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

const SYSTEM_CLOCK: KevinHudClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/**
 * The single overlay window adapter. `show` may resolve after the window really
 * exists; `retract` must resolve only after the reverse exit animation has
 * finished. `hide` removes the window without another animation.
 */
export interface KevinHudWindowPort {
  show(frame: KevinHudFrame): void | Promise<void>
  update(frame: KevinHudFrame): void
  retract(frame: KevinHudFrame): void | Promise<void>
  hide(): void
}

/**
 * Runtime's current per-launch identity keys. `key` is the app id or the
 * `linked:<id>` key used by `Runtime.start`. A key is verified only when
 * `confirmed` is true; a present but unconfirmed wrapper is allowed to wait.
 */
export interface KevinHudRuntimeIdentity {
  key: string
  confirmed: boolean
}

/** A read/subscribe view of the existing Runtime, injected to avoid a cycle. */
export interface KevinHudRuntimePort {
  list(): readonly KevinHudRuntimeIdentity[]
  subscribe(listener: () => void): () => void
}

export type KevinHudMetricValues = Partial<Record<KevinHudMetric, string | null>>

/** Everything the sampler needs to produce one game's independent values. */
export interface KevinHudSampleContext {
  runtimeKey: string
  appName: string
  metrics: readonly KevinHudMetric[]
}

/** Sampler callback. Rejections and `null` keep the previous values. */
export interface KevinHudSamplerPort {
  sample(context: KevinHudSampleContext): Promise<KevinHudMetricValues | null> | KevinHudMetricValues | null
}

/** The non-HUD parts of the launcher that the lifecycle coordinates with. */
export interface KevinHudShellPort {
  /**
   * Prepare the first HUD view before it is shown. A game-screen HUD resolves
   * its initial display hint here; an absorbing launch also collapses the main
   * window and resolves after the real animation (or hide). A non-absorbing
   * launch must resolve without touching the launcher.
   *
   * The historical name is kept for compatibility; with absorption off this
   * hook is preparation only and must not move, hide or restore the launcher.
   */
  waitForMainWindowCollapse(): Promise<void>
  /** Bring the main window back after a natural HUD exit, if configured. */
  restoreLauncher(): void | Promise<void>
}

export type KevinHudHotkeyRelease = () => void

/** Global-shortcut adapter; `register` may throw for an unsupported accelerator. */
export interface KevinHudHotkeyPort {
  register(accelerator: string, onToggle: () => void): KevinHudHotkeyRelease
}

export interface KevinHudLifecycleDependencies {
  window: KevinHudWindowPort
  runtime: KevinHudRuntimePort
  sampler: KevinHudSamplerPort
  shell: KevinHudShellPort
  /** Omit when global shortcuts are unavailable; the HUD then degrades quietly. */
  hotkeys?: KevinHudHotkeyPort
  clock?: KevinHudClock
  /** Optional diagnostics sink. The lifecycle never logs window coordinates or paths. */
  log?: (message: string) => void
}

/** A successful real launch, handed over only after the launcher accepted it. */
export interface KevinHudLaunchInput {
  /** Runtime key that owns this launch: the app id or `linked:<id>`. */
  runtimeKey: string
  appName: string
  /** The app's persisted HUD settings; normalized into an independent snapshot. */
  config: KevinHudConfig
  iconUrl?: string | null
  fontFamily?: string | null
  /** Optional independent script families; absent keeps the legacy behavior. */
  launcherFonts?: LauncherFontSelection | null
  appGlass?: GlassAppearance | null
  /**
   * Whether the real launcher window is absorbed into the HUD. Missing and
   * historical configs keep the previous behavior (`true`). When false the HUD
   * still starts from this normal launch entry, but initial preparation must
   * not collapse/hide the launcher and no natural-exit restore is requested.
   */
  absorbLauncher?: boolean
}

/** Unsaved settings preview. It never starts a game or writes persisted config. */
export interface KevinHudPreviewInput {
  appName: string
  config: KevinHudConfig
  iconUrl?: string | null
  fontFamily?: string | null
  launcherFonts?: LauncherFontSelection | null
  appGlass?: GlassAppearance | null
  /** Defaults to the normalized `displaySeconds`. */
  durationMs?: number
}

/**
 * One-shot launch ticket. It is accepted by exactly one `commitLaunch`; a
 * second commit, a ticket from another lifecycle and a commit after `dispose`
 * all return false without showing the HUD.
 */
export interface KevinHudLaunchRequest {
  readonly id: number
  readonly runtimeKey: string
  readonly appName: string
}

export interface KevinHudPreviewHandle {
  readonly id: number
  /** Idempotent; a stale handle cannot dismiss a newer preview. */
  dismiss(): void
}

export interface KevinHudLifecycleState {
  phase: 'idle' | 'announce' | 'monitor' | 'exit'
  visible: boolean
  preview: boolean
  locked: boolean
  suspended: boolean
  runtimeKey: string | null
  appName: string | null
  hotkeyRegistered: boolean
  hotkeyFailed: boolean
  activeSessions: number
}

type FramePhase = KevinHudFrame['phase']
type DisplayPhase = 'new' | 'announce' | 'monitor' | 'exit'

interface Presentation {
  runtimeKey: string | null
  appName: string
  config: KevinHudConfig
  metrics: readonly KevinHudMetric[]
  iconUrl: string | null
  fontFamily: string | null
  launcherFonts: LauncherFontSelection | null
  appGlass: GlassAppearance | null
  absorbLauncher: boolean
}

interface PreparedRequest {
  presentation: Presentation
  sequence: number
}

interface HudSession {
  id: number
  sequence: number
  presentation: Presentation
  values: KevinHudMetricValues
  /** Runtime has seen this key at least once (confirmed or wrapper). */
  observed: boolean
  ended: boolean
  ready: Promise<void>
  phase: DisplayPhase
  /** Effective duration of the current announcement, kept across live edits. */
  announceDurationMs: number
  /** Visible announce time already spent across pauses and live edits. */
  announceElapsedMs: number
  /** Unspent visible announce time; paused periods do not consume it. */
  announceRemainingMs: number
  announceDeadline: number | null
  announceTimer: unknown | null
  sampleTimer: unknown | null
  sampleToken: number
  sampleInFlight: boolean
  hiddenByHotkey: boolean
  hotkeyFailed: boolean
  everShown: boolean
}

interface PreviewState {
  id: number
  presentation: Presentation
  phase: 'announce' | 'monitor'
  remainingMs: number
  phaseRemainingMs: number
  endAt: number | null
  monitorAt: number | null
  finishTimer: unknown | null
  phaseTimer: unknown | null
  /** A preview that never painted has nothing to reverse. */
  everShown: boolean
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** The real HUD's announce length is fixed for monitors, configurable for transients. */
function announcementDurationMs(config: KevinHudConfig): number {
  return config.alwaysVisible
    ? KEVIN_HUD_ANNOUNCE_MS
    : Math.round(config.displaySeconds * 1000)
}

function optionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function cloneConfig(value: unknown): KevinHudConfig {
  const normalized = normalizeKevinHudConfig(value)
  return {
    ...normalized,
    metrics: [...new Set(normalized.metrics)]
  }
}

function sameMetrics(
  left: readonly KevinHudMetric[],
  right: readonly KevinHudMetric[]
): boolean {
  return left.length === right.length && left.every((metric, index) => metric === right[index])
}

function presentationWithConfig(
  presentation: Presentation,
  config: KevinHudConfig
): Presentation {
  return {
    ...presentation,
    config,
    metrics: config.metrics
  }
}

function clonePresentation(
  appName: unknown,
  config: unknown,
  iconUrl: unknown,
  fontFamily: unknown,
  launcherFonts: unknown,
  appGlass: unknown,
  runtimeKey: string | null,
  absorbLauncher: unknown
): Presentation | null {
  const normalizedAppName = optionalText(appName)
  if (!normalizedAppName) return null
  const normalized = cloneConfig(config)
  const glass = appGlass !== null && typeof appGlass === 'object'
    ? { ...(appGlass as GlassAppearance) }
    : null
  return {
    runtimeKey,
    appName: normalizedAppName,
    config: normalized,
    metrics: normalized.metrics,
    iconUrl: optionalText(iconUrl),
    fontFamily: optionalText(fontFamily),
    launcherFonts: normalizeLauncherFontSelection(launcherFonts),
    appGlass: glass,
    // The shared normalize fills a historical missing value with `true`; an
    // explicit launch value (already validated by the controller) wins.
    absorbLauncher: typeof absorbLauncher === 'boolean'
      ? absorbLauncher
      : normalized.absorbLauncher
  }
}

/**
 * Owns the KEVIN HUD lifecycle for one launcher process. All inputs are
 * injected; this class is safe to instantiate in tests with virtual windows,
 * a fake clock and stub Runtime/sampler.
 */
export class KevinHudLifecycle {
  private readonly clock: KevinHudClock
  private readonly requests = new WeakMap<KevinHudLaunchRequest, PreparedRequest>()
  private readonly sessions = new Map<number, HudSession>()
  private current: HudSession | null = null
  private preview: PreviewState | null = null
  private runtimeUnsubscribe: (() => void) | null = null
  private hotkeyOwner: HudSession | null = null
  private hotkeyAccelerator = ''
  private hotkeyRelease: (() => void) | null = null
  private nextRequestId = 0
  private nextSequence = 0
  private nextPreviewId = 0
  private windowVisible = false
  /** The most recent show request's logical visibility, including async shows. */
  private desiredVisible = false
  private showSerial = 0
  /** Invalidates deferred show/announce work after any view or environment change. */
  private viewEpoch = 0
  /** Serializes the (possibly asynchronous) final reverse retraction. */
  private finalExitSerial = 0
  private exitInFlight = false
  /** Serializes the reverse exit played when a settings preview closes. */
  private previewExitSerial = 0
  private previewExitInFlight = false
  /** Serializes the interactive hotkey hide's reverse timeline. */
  private hotkeyExitSerial = 0
  private hotkeyExitInFlight = false
  private hotkeyExitSession: HudSession | null = null
  /** Real session whose reverse exit is in flight, even after `current` clears. */
  private exitingRuntimeKey: string | null = null
  private pendingFinalize = false
  private pendingFinalizeConfig: KevinHudConfig | null = null
  private pendingFinalizeEligible = false
  /** Whether the launcher was actually absorbed for that pending finalize. */
  private pendingFinalizeAbsorbed = false
  /** Last real HUD settings that actually reached the window (for deferred exits). */
  private lastShownRealConfig: KevinHudConfig | null = null
  /** Absorption state paired with `lastShownRealConfig`. */
  private lastShownAbsorbLauncher = false
  private locked = false
  private suspended = false
  private disposed = false

  constructor(private readonly deps: KevinHudLifecycleDependencies) {
    this.clock = deps.clock ?? SYSTEM_CLOCK
  }

  /**
   * Build a one-shot ticket after a real launch succeeded. Returns null when
   * the HUD is disabled for that app, invalid, or the lifecycle was disposed.
   * Preparing never touches the window, Runtime, sampler or hotkeys.
   */
  prepareLaunch(input: KevinHudLaunchInput): KevinHudLaunchRequest | null {
    if (this.disposed) return null
    const runtimeKey = optionalText(input?.runtimeKey)
    if (!runtimeKey) return null
    let presentation: Presentation | null
    try {
      presentation = clonePresentation(
        input.appName,
        input.config,
        input.iconUrl,
        input.fontFamily,
        input.launcherFonts,
        input.appGlass,
        runtimeKey,
        input.absorbLauncher
      )
    } catch (error) {
      this.report(`could not normalize launch request (${this.errorText(error)})`)
      return null
    }
    if (!presentation || !presentation.config.enabled) return null
    const request: KevinHudLaunchRequest = Object.freeze({
      id: ++this.nextRequestId,
      runtimeKey,
      appName: presentation.appName
    })
    this.requests.set(request, { presentation, sequence: ++this.nextSequence })
    return request
  }

  /**
   * Commit that ticket exactly once. This is synchronous: it reserves the
   * session immediately, then waits for the main-window collapse promise in
   * the background before announcing. Returns false for stale/replayed tickets.
   */
  commitLaunch(request: KevinHudLaunchRequest): boolean {
    if (this.disposed) return false
    const prepared = this.requests.get(request)
    if (!prepared) return false
    // Deleting the private entry is the one-shot guard. WeakMap keys keep the
    // caller's handle collectable if it is never committed.
    this.requests.delete(request)
    // A prepared launch may have been amended after its ticket was issued. If
    // the newest settings disabled the HUD, commit must stay a no-op instead of
    // showing a stale or disabled overlay.
    if (!prepared.presentation.config.enabled) return false
    this.abortFinalExit()
    this.abortPreviewExit()
    this.pendingFinalize = false
    this.pendingFinalizeConfig = null
    this.pendingFinalizeEligible = false
    this.pendingFinalizeAbsorbed = false

    const sequence = prepared.sequence
    const previousSameKey = [...this.sessions.values()].filter(
      (session) => session.presentation.runtimeKey === prepared.presentation.runtimeKey
    )
    for (const session of previousSameKey) {
      this.sessions.delete(session.id)
      session.ended = true
      if (this.current === session) {
        this.pausePresentation(session)
        this.current = null
      }
    }

    // An absorbing launch always waits for the collapse. A non-absorbing HUD
    // only needs preparation when it follows the game screen to resolve the
    // initial display hint; the primary-screen path stays immediate.
    const needsInitialViewPreparation =
      prepared.presentation.absorbLauncher ||
      prepared.presentation.config.monitor === 'game'

    const announceDurationMs = announcementDurationMs(prepared.presentation.config)
    const session: HudSession = {
      id: sequence,
      sequence,
      presentation: prepared.presentation,
      values: {},
      observed: false,
      ended: false,
      // Preparation runs only for the paths above; with absorption off the
      // controller must not touch the launcher while it resolves the hint.
      ready: needsInitialViewPreparation
        ? this.prepareInitialView()
        : Promise.resolve(),
      phase: 'new',
      announceDurationMs,
      announceElapsedMs: 0,
      announceRemainingMs: announceDurationMs,
      announceDeadline: null,
      announceTimer: null,
      sampleTimer: null,
      sampleToken: 0,
      sampleInFlight: false,
      hiddenByHotkey: false,
      hotkeyFailed: false,
      everShown: false
    }
    this.sessions.set(session.id, session)
    this.syncRuntimeSubscription()
    this.refreshRuntimeState()
    this.updateView()
    return true
  }

  /**
   * Show an unsaved preview on the same physical window. It temporarily pauses
   * the live overlay, but never samples, launches a game or writes settings.
   * Safe to call repeatedly; the newest preview wins.
   */
  startPreview(input: KevinHudPreviewInput): KevinHudPreviewHandle | null {
    if (this.disposed) return null
    let presentation: Presentation | null
    try {
      presentation = clonePresentation(
        input.appName,
        input.config,
        input.iconUrl,
        input.fontFamily,
        input.launcherFonts,
        input.appGlass,
        null,
        true
      )
    } catch (error) {
      this.report(`could not normalize preview (${this.errorText(error)})`)
      return null
    }
    if (!presentation) return null

    this.abortFinalExit()
    this.abortPreviewExit()
    this.abortHotkeyExit()
    if (this.current) this.pausePresentation(this.current)
    const previous = this.preview
    if (previous) this.clearPreviewTimers(previous)

    const fallback = Math.round(presentation.config.displaySeconds * 1000)
    const requested = finiteNonNegative(input.durationMs)
    const durationMs = Math.min(requested ?? fallback, MAX_PREVIEW_MS)
    const monitorAfter = presentation.config.alwaysVisible
      ? Math.min(KEVIN_HUD_ANNOUNCE_MS, durationMs)
      : durationMs
    const preview: PreviewState = {
      id: ++this.nextPreviewId,
      presentation,
      phase: 'announce',
      remainingMs: durationMs,
      phaseRemainingMs: monitorAfter,
      endAt: null,
      monitorAt: null,
      finishTimer: null,
      phaseTimer: null,
      everShown: false
    }
    this.preview = preview
    this.viewEpoch += 1
    if (this.isEnvironmentActive) {
      void this.showPreview(preview)
    } else {
      this.hideWindow()
    }
    return Object.freeze({
      id: preview.id,
      dismiss: () => this.endPreview(preview.id)
    })
  }

  /** Dismiss the current preview, if any. Stale preview handles are ignored. */
  dismissPreview(): void {
    const preview = this.preview
    if (preview) this.endPreview(preview.id)
  }

  /**
   * Amend a prepared but not yet committed launch. This can be called while a
   * launch transition is still running; it only replaces the in-memory
   * presentation snapshot and never touches the window, Runtime or timers.
   * The launch-time absorption decision is deliberately kept.
   */
  updatePreparedLaunch(request: KevinHudLaunchRequest, config: unknown): boolean {
    if (this.disposed) return false
    const prepared = this.requests.get(request)
    if (!prepared) return false
    let next: KevinHudConfig
    try {
      next = cloneConfig(config)
    } catch (error) {
      this.report(`could not normalize live HUD settings (${this.errorText(error)})`)
      return false
    }
    prepared.presentation = presentationWithConfig(prepared.presentation, next)
    return true
  }

  /**
   * Apply newer settings to the real HUD session for `runtimeKey` in place.
   *
   * The session keeps its identity, sample token and launch-time absorption
   * state. Its effective announce duration follows the new settings while any
   * visible time already spent is preserved; lock, suspend, preview and hidden
   * periods do not consume that time. A shortened duration may therefore move
   * straight to the normal monitor/exit path. Turning `alwaysVisible` off on a
   * monitor also ends it through that same path.
   *
   * A visible announcement/monitor gets one refreshed frame; a hidden, locked,
   * suspended or preview-owned surface keeps the snapshot for the next natural
   * resume instead of being shown early. `render` is false when the native
   * surface is known to be closed, so this path can never create a window.
   */
  updateLive(runtimeKey: string, config: unknown, render = true): boolean {
    if (this.disposed) return false
    const key = optionalText(runtimeKey)
    if (!key) return false
    let session: HudSession | null = null
    for (const candidate of this.sessions.values()) {
      if (candidate.ended || candidate.presentation.runtimeKey !== key) continue
      if (!session || candidate.sequence > session.sequence) session = candidate
    }
    if (!session) return false
    let next: KevinHudConfig
    try {
      next = cloneConfig(config)
    } catch (error) {
      this.report(`could not normalize live HUD settings (${this.errorText(error)})`)
      return false
    }
    const previous = session.presentation
    session.presentation = presentationWithConfig(previous, next)
    if (this.current === session && session.everShown) {
      this.lastShownRealConfig = next
    }
    if (!next.enabled) {
      this.endSession(session)
      return true
    }
    if (session.phase === 'monitor' && !next.alwaysVisible) {
      this.endSession(session)
      return true
    }
    this.refreshSessionSurface(session, previous, render)
    this.retimeAnnouncement(session)
    return true
  }

  /**
   * Apply newer settings to the active settings preview without restarting its
   * entrance or countdown. The preview keeps sampling disabled and never
   * affects the real HUD's launcher restoration.
   */
  updatePreview(config: unknown, render = true): boolean {
    if (this.disposed) return false
    const preview = this.preview
    if (!preview) return false
    let next: KevinHudConfig
    try {
      next = cloneConfig(config)
    } catch (error) {
      this.report(`could not normalize preview HUD settings (${this.errorText(error)})`)
      return false
    }
    preview.presentation = presentationWithConfig(preview.presentation, next)
    if (render) this.refreshPreviewSurface(preview)
    return true
  }

  /** Screen lock suspends the overlay without treating the game as exited. */
  setLocked(locked: boolean): void {
    this.setEnvironmentState(Boolean(locked), this.suspended)
  }

  /** OS sleep/suspend suspends the overlay without treating the game as exited. */
  setSuspended(suspended: boolean): void {
    this.setEnvironmentState(this.locked, Boolean(suspended))
  }

  /**
   * Runtime key of the real session currently playing its reverse exit. The
   * window adapter uses this to find the reduced-motion preference after the
   * lifecycle has already retired `current`.
   */
  getExitingRuntimeKey(): string | null {
    return this.exitingRuntimeKey
  }

  /** Read-only diagnostic snapshot for the eventual IPC/main owner. */
  getState(): KevinHudLifecycleState {
    const display = this.preview ?? this.current
    let phase: KevinHudLifecycleState['phase'] = 'idle'
    if (this.preview) {
      phase = this.preview.phase
    } else if (this.current) {
      phase = this.current.phase === 'monitor'
        ? 'monitor'
        : this.current.phase === 'exit'
          ? 'exit'
          : 'announce'
    }
    return {
      phase,
      visible: this.windowVisible,
      preview: this.preview !== null,
      locked: this.locked,
      suspended: this.suspended,
      runtimeKey: this.preview ? null : this.current?.presentation.runtimeKey ?? null,
      appName: display?.presentation.appName ?? null,
      hotkeyRegistered: this.hotkeyOwner !== null,
      hotkeyFailed: this.current?.hotkeyFailed ?? false,
      activeSessions: [...this.sessions.values()].filter((session) => !session.ended).length
    }
  }

  /**
   * Release every timer, subscription and global shortcut, and hide the overlay.
   * No launcher restore is triggered: the process is closing, not the game.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.viewEpoch += 1
    this.abortFinalExit()
    this.abortPreviewExit()
    this.abortHotkeyExit()
    this.pendingFinalize = false
    this.pendingFinalizeConfig = null
    this.pendingFinalizeEligible = false
    this.pendingFinalizeAbsorbed = false
    this.lastShownRealConfig = null
    this.lastShownAbsorbLauncher = false
    for (const session of this.sessions.values()) this.pausePresentation(session)
    this.sessions.clear()
    this.current = null
    if (this.preview) {
      this.clearPreviewTimers(this.preview)
      this.preview = null
    }
    this.releaseHotkey()
    this.unsubscribeRuntime()
    this.hideWindow(true)
  }

  private setEnvironmentState(locked: boolean, suspended: boolean): void {
    if (this.disposed || (this.locked === locked && this.suspended === suspended)) return
    const wasActive = this.isEnvironmentActive
    this.locked = locked
    this.suspended = suspended
    const active = this.isEnvironmentActive
    if (wasActive === active) return
    if (!active) {
      this.viewEpoch += 1
      this.abortFinalExit()
      this.abortPreviewExit()
      this.abortHotkeyExit()
      if (this.preview) this.pausePreview(this.preview)
      if (this.current) this.pausePresentation(this.current)
      this.hideWindow(true)
      return
    }

    this.refreshRuntimeState()
    if (this.preview) {
      void this.showPreview(this.preview)
      return
    }
    if (this.current && !this.current.ended) {
      this.resumeCurrent()
      return
    }
    this.updateView(true)
    if (!this.preview && !this.current) this.flushPendingFinalize()
  }

  private get isEnvironmentActive(): boolean {
    return !this.disposed && !this.locked && !this.suspended
  }

  private prepareInitialView(): Promise<void> {
    try {
      return Promise.resolve(this.deps.shell.waitForMainWindowCollapse()).catch((error) => {
        this.report(`initial HUD preparation failed; announcing anyway (${this.errorText(error)})`)
      })
    } catch (error) {
      this.report(`initial HUD preparation failed; announcing anyway (${this.errorText(error)})`)
      return Promise.resolve()
    }
  }

  private updateView(forceResume = false): void {
    if (this.disposed || this.preview || !this.isEnvironmentActive) return
    const newest = this.newestLiveSession()
    if (!newest) {
      if (!this.current) this.flushPendingFinalize()
      return
    }
    if (this.current === newest) {
      if (forceResume) this.resumeCurrent()
      return
    }
    if (this.current) this.pausePresentation(this.current)
    // A new view supersedes any interactive reverse timeline, even one whose
    // session has already retired (so `current` is null but its retraction is
    // still pending).
    this.abortHotkeyExit()
    this.current = newest
    const epoch = ++this.viewEpoch
    void this.activateSession(newest, epoch)
  }

  private newestLiveSession(): HudSession | null {
    let newest: HudSession | null = null
    for (const session of this.sessions.values()) {
      if (session.ended) continue
      if (!newest || session.sequence > newest.sequence) newest = session
    }
    return newest
  }

  private async activateSession(session: HudSession, epoch: number): Promise<void> {
    await session.ready
    if (!this.canPresent(session, epoch)) return
    await this.presentSession(session, epoch)
  }

  private async presentSession(session: HudSession, epoch: number): Promise<void> {
    if (!this.canPresent(session, epoch)) return
    if (session.phase === 'new') session.phase = 'announce'
    if (session.phase === 'announce') {
      if (session.announceRemainingMs <= 0) {
        this.completeAnnouncement(session, epoch)
        return
      }
      const frame = this.frameFor(session.presentation, 'announce', session.values)
      if (!(await this.showFrame(frame, () => this.canPresent(session, epoch)))) return
      this.markSessionShown(session)
      // A live settings update may land while the native show is still
      // pending. Its snapshot is already newer than the frame that opened the
      // surface, so push the corrected frame once instead of waiting for a
      // later sample/resume.
      if (session.presentation.config !== frame.config) {
        this.updateWindow(this.frameFor(session.presentation, 'announce', session.values))
      }
      this.scheduleAnnouncement(session, epoch)
      return
    }
    if (session.phase === 'monitor') {
      await this.enterMonitor(session, epoch, false)
    }
  }

  private async enterMonitor(session: HudSession, epoch: number, alreadyVisible: boolean): Promise<void> {
    if (!this.canPresent(session, epoch)) return
    session.phase = 'monitor'
    const frame = this.frameFor(session.presentation, 'monitor', session.values)
    if (alreadyVisible && this.windowVisible) {
      this.updateWindow(frame)
    } else if (!(await this.showFrame(frame, () => this.canPresent(session, epoch)))) {
      return
    }
    if (!this.canPresent(session, epoch)) return
    this.markSessionShown(session)
    if (session.presentation.config !== frame.config) {
      this.updateWindow(this.frameFor(session.presentation, 'monitor', session.values))
    }
    this.scheduleSampling(session, epoch)
    this.ensureHotkey(session)
  }

  private markSessionShown(session: HudSession): void {
    session.everShown = true
    this.lastShownRealConfig = session.presentation.config
    this.lastShownAbsorbLauncher = session.presentation.absorbLauncher
  }

  private canPresent(session: HudSession, epoch: number): boolean {
    return !this.disposed &&
      !this.preview &&
      this.isEnvironmentActive &&
      this.current === session &&
      !session.ended &&
      this.viewEpoch === epoch
  }

  private resumeCurrent(): void {
    const session = this.current
    if (!session || session.ended || this.preview || !this.isEnvironmentActive) return
    this.abortHotkeyExit()
    const epoch = ++this.viewEpoch
    if (session.hiddenByHotkey && session.phase === 'monitor') {
      this.hideWindow()
      this.ensureHotkey(session)
      return
    }
    void this.presentSession(session, epoch)
  }

  /**
   * Retire the running session through the normal end path. Used when the live
   * HUD is disabled, an always-visible monitor loses that setting, or a
   * transient announcement has no time left. It never starts a new show: after
   * a preview, lock, suspension or manual hide is released, the app's HUD does
   * not return until the user launches again.
   */
  private endSession(session: HudSession): void {
    if (this.sessions.get(session.id) !== session || session.ended) return
    this.sessions.delete(session.id)
    session.ended = true
    session.phase = 'exit'
    if (this.current === session) this.retireCurrent(session)
    this.syncRuntimeSubscription()
  }

  private refreshSessionSurface(
    session: HudSession,
    previous: Presentation,
    render: boolean
  ): void {
    if (
      this.disposed ||
      this.preview ||
      // The preview has been removed but its reverse timeline still owns the
      // native surface. Pushing a real frame now would interrupt that exit.
      this.previewExitInFlight ||
      this.current !== session
    ) {
      return
    }
    if (session.phase === 'monitor' && this.isEnvironmentActive) {
      // Keep the shortcut usable even while the overlay is manually hidden.
      this.refreshHotkeyForUpdate(session, previous)
    }
    if (
      !render ||
      !this.windowVisible ||
      !this.isEnvironmentActive ||
      session.hiddenByHotkey
    ) {
      return
    }
    if (session.phase !== 'announce' && session.phase !== 'monitor') return
    this.updateWindow(this.frameFor(session.presentation, session.phase, session.values))
    if (session.phase !== 'monitor') return
    this.refreshSamplingForUpdate(session, previous)
  }

  /**
   * Only a cadence/metric selection change may touch the existing lifecycle
   * timer. The poller, session identity and sample token stay exactly the same,
   * so an in-flight sample still owns its one result.
   */
  private refreshSamplingForUpdate(session: HudSession, previous: Presentation): void {
    const next = session.presentation
    const metricsChanged = !sameMetrics(previous.metrics, next.metrics)
    const cadenceChanged = previous.config.sampleSeconds !== next.config.sampleSeconds
    if (!metricsChanged && !cadenceChanged) return
    if (next.metrics.length === 0) {
      if (session.sampleTimer !== null) {
        this.clock.clearTimeout(session.sampleTimer)
        session.sampleTimer = null
      }
      return
    }
    if (session.sampleTimer === null) {
      this.scheduleSampling(session, this.viewEpoch)
      return
    }
    // A metric-only change can wait for the already armed tick. Only a cadence
    // change owns a new deadline; neither path touches the session token or
    // starts another poller.
    if (!cadenceChanged) return
    this.clock.clearTimeout(session.sampleTimer)
    session.sampleTimer = null
    this.scheduleSampling(session, this.viewEpoch)
  }

  private refreshHotkeyForUpdate(session: HudSession, previous: Presentation): void {
    if (this.disposed || this.preview || !this.isEnvironmentActive) return
    if (this.current !== session || session.phase !== 'monitor') return
    const config = session.presentation.config
    if (config.hotkey !== previous.config.hotkey) {
      // A replaced accelerator deserves one fresh registration attempt even if
      // the previous accelerator had been rejected.
      session.hotkeyFailed = false
    }
    const desired =
      config.alwaysVisible &&
      !!config.hotkey &&
      !session.hotkeyFailed
    if (this.hotkeyOwner === session) {
      if (desired && this.hotkeyAccelerator === config.hotkey) return
      this.releaseHotkey()
    }
    if (desired) this.ensureHotkey(session)
  }

  private refreshPreviewSurface(preview: PreviewState): void {
    if (this.disposed || this.preview !== preview || !this.windowVisible) return
    if (!this.isEnvironmentActive) return
    this.updateWindow(this.frameFor(preview.presentation, preview.phase, {}))
  }

  /**
   * Re-lay the one existing announce deadline when the real duration changes.
   * Time already spent while visible is preserved; paused time is not. An
   * exhausted duration delegates to the existing completion path so it enters
   * the monitor or leaves naturally without replaying the entrance.
   */
  private retimeAnnouncement(session: HudSession): void {
    if (session.phase !== 'new' && session.phase !== 'announce') return
    const durationMs = announcementDurationMs(session.presentation.config)
    if (durationMs === session.announceDurationMs) return
    const timerActive = session.announceTimer !== null
    if (timerActive && session.announceDeadline !== null) {
      const remainingMs = Math.max(0, session.announceDeadline - this.clock.now())
      // The active segment's spent part is authoritative. Do not derive the
      // whole elapsed time from the old duration: an earlier suspended edit may
      // already have made the stored duration shorter than that time.
      session.announceElapsedMs = Math.max(
        session.announceElapsedMs,
        session.announceDurationMs - remainingMs
      )
    }
    session.announceDurationMs = durationMs
    session.announceRemainingMs = Math.max(0, durationMs - session.announceElapsedMs)
    if (!timerActive) return

    // Reuse the single announce timer instead of layering another one.
    this.clock.clearTimeout(session.announceTimer)
    session.announceTimer = null
    session.announceDeadline = null
    const epoch = this.viewEpoch
    if (session.announceRemainingMs > 0) {
      this.scheduleAnnouncement(session, epoch)
      return
    }
    this.completeAnnouncement(session, epoch)
  }

  private pausePresentation(session: HudSession): void {
    if (session.announceTimer !== null) {
      if (session.announceDeadline !== null) {
        session.announceRemainingMs = Math.max(0, session.announceDeadline - this.clock.now())
        session.announceElapsedMs = Math.max(
          session.announceElapsedMs,
          session.announceDurationMs - session.announceRemainingMs
        )
      }
      this.clock.clearTimeout(session.announceTimer)
      session.announceTimer = null
      session.announceDeadline = null
    }
    this.stopSampling(session)
    this.releaseHotkey()
    if (this.hotkeyExitSession === session && this.hotkeyExitInFlight) {
      this.abortHotkeyExit()
    }
  }

  private scheduleAnnouncement(session: HudSession, epoch: number): void {
    if (!this.canPresent(session, epoch) || session.announceTimer !== null) return
    const remaining = Math.max(0, session.announceRemainingMs)
    session.announceDeadline = this.clock.now() + remaining
    session.announceTimer = this.clock.setTimeout(() => {
      session.announceTimer = null
      session.announceDeadline = null
      if (!this.canPresent(session, epoch)) return
      session.announceElapsedMs = session.announceDurationMs
      session.announceRemainingMs = 0
      this.completeAnnouncement(session, epoch)
    }, remaining)
  }

  private completeAnnouncement(session: HudSession, epoch: number): void {
    if (!this.canPresent(session, epoch)) return
    if (session.presentation.config.alwaysVisible) {
      void this.enterMonitor(session, epoch, true)
      return
    }
    this.endSession(session)
  }

  private retireCurrent(session: HudSession): void {
    if (this.current !== session) return
    const live = this.newestLiveSession()
    // When the user hid the overlay by hotkey and Runtime settles the game
    // while that reverse timeline is still running, reuse it: restarting a
    // second retraction would flash the overlay back to its monitor pose.
    const keepHotkeyExit = !live &&
      this.hotkeyExitInFlight &&
      this.hotkeyExitSession === session
    if (keepHotkeyExit) {
      this.stopSampling(session)
      this.releaseHotkey()
    } else {
      this.pausePresentation(session)
    }
    this.current = null
    if (live) {
      this.pendingFinalize = false
      this.pendingFinalizeConfig = null
      this.pendingFinalizeEligible = false
      this.pendingFinalizeAbsorbed = false
      if (!this.preview && this.isEnvironmentActive) this.updateView()
      return
    }
    this.pendingFinalize = true
    const shownConfig = session.everShown ? session.presentation.config : this.lastShownRealConfig
    this.pendingFinalizeConfig = shownConfig ?? session.presentation.config
    this.pendingFinalizeEligible = this.pendingFinalizeEligible || session.everShown || !!shownConfig
    this.pendingFinalizeAbsorbed = session.everShown
      ? session.presentation.absorbLauncher
      : this.lastShownAbsorbLauncher
    if (this.preview) return
    if (!this.isEnvironmentActive) {
      this.hideWindow(true)
      return
    }
    if (keepHotkeyExit) {
      // Its completion hides the window and flushes this finalize.
      return
    }
    this.beginFinalExit(session)
  }

  private beginFinalExit(session: HudSession): void {
    session.phase = 'exit'
    this.abortPreviewExit()
    // A natural exit owns the one reverse timeline from here on.
    this.abortHotkeyExit()
    const serial = ++this.finalExitSerial
    const epoch = ++this.viewEpoch
    this.exitingRuntimeKey = session.presentation.runtimeKey
    if (!this.windowVisible || !session.everShown) {
      this.exitInFlight = false
      this.exitingRuntimeKey = null
      this.hideWindow()
      this.flushPendingFinalize()
      return
    }
    this.exitInFlight = true
    const frame = this.frameFor(session.presentation, 'exit', session.values)
    void (async () => {
      try {
        await this.deps.window.retract(frame)
      } catch (error) {
        this.report(`reverse retraction failed (${this.errorText(error)})`)
      }
      if (this.disposed || serial !== this.finalExitSerial || epoch !== this.viewEpoch) return
      this.exitingRuntimeKey = null
      this.hideWindow(true)
      this.exitInFlight = false
      this.flushPendingFinalize()
    })()
  }

  /**
   * Hide through the same reverse timeline the renderer plays for other exits.
   * The shortcut stays registered so the next press can bring the overlay back,
   * and sampling is already stopped by `toggleHotkey`.
   */
  private beginHotkeyExit(session: HudSession): void {
    this.abortHotkeyExit()
    // Invalidate any still-pending show from a rapid hide/show/hide. Without
    // this, its late `show` resolution could mark the window visible again
    // after the user hid it.
    this.viewEpoch += 1
    if (!this.windowVisible || !session.everShown) {
      this.hideWindow()
      return
    }
    const serial = ++this.hotkeyExitSerial
    const epoch = this.viewEpoch
    this.hotkeyExitInFlight = true
    this.hotkeyExitSession = session
    const frame = this.frameFor(session.presentation, 'exit', session.values)
    void (async () => {
      try {
        await this.deps.window.retract(frame)
      } catch (error) {
        this.report(`hotkey reverse retraction failed (${this.errorText(error)})`)
      }
      if (this.disposed || serial !== this.hotkeyExitSerial) return
      if (!this.hotkeyExitInFlight || this.hotkeyExitSession !== session) return
      this.hotkeyExitInFlight = false
      this.hotkeyExitSession = null
      // A newer show, preview, lock/suspend or replacement bumped the view
      // epoch. Its surface must never be hidden by this late completion.
      const ownsWindow =
        this.current === session ||
        (session.ended && this.current === null && !this.newestLiveSession())
      if (
        epoch === this.viewEpoch &&
        !this.preview &&
        session.hiddenByHotkey &&
        ownsWindow
      ) {
        this.hideWindow(true)
      }
      this.flushPendingFinalize()
    })()
  }

  private abortHotkeyExit(): void {
    this.hotkeyExitSerial += 1
    this.hotkeyExitInFlight = false
    this.hotkeyExitSession = null
  }

  private flushPendingFinalize(): void {
    if (
      this.disposed ||
      !this.pendingFinalize ||
      this.exitInFlight ||
      this.previewExitInFlight ||
      this.hotkeyExitInFlight
    ) {
      return
    }
    if (this.preview || !this.isEnvironmentActive || this.current || this.newestLiveSession()) return
    this.hideWindow()
    const config = this.pendingFinalizeConfig
    const eligible = this.pendingFinalizeEligible
    const absorbed = this.pendingFinalizeAbsorbed
    this.pendingFinalize = false
    this.pendingFinalizeConfig = null
    this.pendingFinalizeEligible = false
    this.pendingFinalizeAbsorbed = false
    this.lastShownRealConfig = null
    this.lastShownAbsorbLauncher = false
    // A non-absorbing HUD never moved the launcher, so its natural exit must
    // not bring the window back or move focus, even when restoreLauncher=true.
    if (eligible && absorbed && config?.restoreLauncher) this.restoreLauncher()
  }

  private abortFinalExit(): void {
    this.finalExitSerial += 1
    this.exitInFlight = false
    this.exitingRuntimeKey = null
  }

  private scheduleSampling(session: HudSession, epoch: number): void {
    if (!this.isSamplingVisible(session, epoch) || session.sampleTimer !== null) return
    if (session.presentation.metrics.length === 0) return
    const token = session.sampleToken
    const delay = Math.max(1, Math.round(session.presentation.config.sampleSeconds * 1000))
    session.sampleTimer = this.clock.setTimeout(() => {
      session.sampleTimer = null
      void this.collectSample(session, epoch, token)
    }, delay)
  }

  private async collectSample(session: HudSession, epoch: number, token: number): Promise<void> {
    if (!this.isSamplingVisible(session, epoch) || token !== session.sampleToken) return
    if (session.sampleInFlight) {
      this.scheduleSampling(session, epoch)
      return
    }
    session.sampleInFlight = true
    let values: KevinHudMetricValues | null = null
    try {
      values = await this.deps.sampler.sample({
        runtimeKey: session.presentation.runtimeKey ?? '',
        appName: session.presentation.appName,
        metrics: [...session.presentation.metrics]
      })
    } catch (error) {
      this.report(`metric sample failed (${this.errorText(error)})`)
    }
    if (token !== session.sampleToken || !this.isSamplingVisible(session, epoch)) return
    session.sampleInFlight = false
    if (values && typeof values === 'object') {
      const next: KevinHudMetricValues = { ...session.values }
      for (const metric of session.presentation.metrics) {
        if (!Object.hasOwn(values, metric)) continue
        const value = values[metric]
        if (value === null || typeof value === 'string') next[metric] = value
      }
      session.values = next
      this.updateWindow(this.frameFor(session.presentation, 'monitor', session.values))
    }
    this.scheduleSampling(session, epoch)
  }

  private isSamplingVisible(session: HudSession, epoch: number): boolean {
    return this.canPresent(session, epoch) &&
      session.phase === 'monitor' &&
      this.windowVisible &&
      !session.hiddenByHotkey
  }

  private stopSampling(session: HudSession): void {
    session.sampleToken += 1
    if (session.sampleTimer !== null) {
      this.clock.clearTimeout(session.sampleTimer)
      session.sampleTimer = null
    }
    session.sampleInFlight = false
  }

  private ensureHotkey(session: HudSession): void {
    if (this.disposed || this.preview || !this.isEnvironmentActive) return
    const accelerator = session.presentation.config.hotkey
    if (!session.presentation.config.alwaysVisible || !accelerator || session.hotkeyFailed) return
    if (session.phase !== 'monitor' || this.current !== session) return
    if (this.hotkeyOwner === session && this.hotkeyAccelerator === accelerator) return
    this.releaseHotkey()
    if (!this.deps.hotkeys) {
      session.hotkeyFailed = true
      this.report('global shortcuts are unavailable; HUD hotkey disabled')
      return
    }
    try {
      const release = this.deps.hotkeys.register(accelerator, () => this.toggleHotkey(session, accelerator))
      if (typeof release !== 'function') throw new Error('hotkey adapter returned no release function')
      this.hotkeyOwner = session
      this.hotkeyAccelerator = accelerator
      this.hotkeyRelease = release
    } catch (error) {
      session.hotkeyFailed = true
      this.report(`hotkey registration failed; continuing without it (${this.errorText(error)})`)
    }
  }

  private toggleHotkey(session: HudSession, accelerator: string): void {
    if (this.disposed || this.preview || !this.isEnvironmentActive) return
    if (this.hotkeyOwner !== session || this.hotkeyAccelerator !== accelerator) return
    if (this.current !== session || session.phase !== 'monitor') return
    if (session.presentation.config.hotkey !== accelerator) return
    session.hiddenByHotkey = !session.hiddenByHotkey
    if (session.hiddenByHotkey) {
      this.stopSampling(session)
      this.beginHotkeyExit(session)
      return
    }
    this.abortHotkeyExit()
    this.resumeCurrent()
  }

  private releaseHotkey(): void {
    const release = this.hotkeyRelease
    this.hotkeyOwner = null
    this.hotkeyAccelerator = ''
    this.hotkeyRelease = null
    if (!release) return
    try {
      release()
    } catch (error) {
      this.report(`hotkey release failed (${this.errorText(error)})`)
    }
  }

  private syncRuntimeSubscription(): void {
    if (this.disposed) return
    if (this.sessions.size === 0) {
      this.unsubscribeRuntime()
      return
    }
    if (this.runtimeUnsubscribe) return
    try {
      const unsubscribe = this.deps.runtime.subscribe(() => this.refreshRuntimeState())
      if (typeof unsubscribe !== 'function') throw new Error('runtime returned no unsubscribe function')
      this.runtimeUnsubscribe = unsubscribe
    } catch (error) {
      this.report(`runtime subscription failed (${this.errorText(error)})`)
    }
  }

  private unsubscribeRuntime(): void {
    const unsubscribe = this.runtimeUnsubscribe
    this.runtimeUnsubscribe = null
    if (!unsubscribe) return
    try {
      unsubscribe()
    } catch (error) {
      this.report(`runtime unsubscribe failed (${this.errorText(error)})`)
    }
  }

  private refreshRuntimeState(): void {
    if (this.disposed) return
    let identities: readonly KevinHudRuntimeIdentity[]
    try {
      identities = this.deps.runtime.list()
    } catch (error) {
      this.report(`could not read Runtime state; keeping the HUD session (${this.errorText(error)})`)
      return
    }
    const present = new Map<string, boolean>()
    for (const identity of identities) {
      if (!identity || typeof identity.key !== 'string') continue
      present.set(identity.key, (present.get(identity.key) ?? false) || identity.confirmed === true)
    }
    const ended: HudSession[] = []
    for (const session of this.sessions.values()) {
      const key = session.presentation.runtimeKey
      if (key === null) continue
      if (present.has(key)) {
        session.observed = true
        continue
      }
      // A launch that Runtime has not reported yet may still be starting.
      // Once it was observed, disappearance means Runtime settled it as gone.
      // An unconfirmed wrapper that is still present above keeps waiting.
      if (!session.observed) continue
      this.sessions.delete(session.id)
      session.ended = true
      ended.push(session)
    }
    for (const session of ended) {
      if (this.current === session) this.retireCurrent(session)
    }
    this.deferMissingFinalize()
    this.syncRuntimeSubscription()
  }

  /**
   * A real HUD can end while a preview owns the window, or while another game
   * is still live. If no session remains visible, retain the natural-exit
   * restoration until the preview/environment releases the window.
   */
  private deferMissingFinalize(): void {
    if (this.disposed || this.pendingFinalize || this.current || this.newestLiveSession()) return
    if (!this.lastShownRealConfig) return
    this.pendingFinalize = true
    this.pendingFinalizeConfig = this.lastShownRealConfig
    this.pendingFinalizeEligible = true
    this.pendingFinalizeAbsorbed = this.lastShownAbsorbLauncher
    if (!this.preview && this.isEnvironmentActive) this.flushPendingFinalize()
  }

  private showPreview(preview: PreviewState): void {
    if (this.disposed || this.preview !== preview || !this.isEnvironmentActive) return
    const epoch = this.viewEpoch
    const phase = preview.phase
    const frame = this.frameFor(preview.presentation, phase, {})
    void (async () => {
      if (!(await this.showFrame(frame, () => this.isPreviewCurrent(preview, epoch)))) {
        // A failed preview must not keep the live overlay paused forever.
        if (this.isPreviewCurrent(preview, epoch)) this.endPreview(preview.id)
        return
      }
      if (!this.isPreviewCurrent(preview, epoch)) return
      preview.everShown = true
      if (preview.presentation.config !== frame.config) {
        this.updateWindow(this.frameFor(preview.presentation, preview.phase, {}))
      }
      this.schedulePreview(preview)
    })()
  }

  private isPreviewCurrent(preview: PreviewState, epoch: number): boolean {
    return !this.disposed &&
      this.preview === preview &&
      this.isEnvironmentActive &&
      this.viewEpoch === epoch
  }

  private schedulePreview(preview: PreviewState): void {
    if (!this.isPreviewCurrent(preview, this.viewEpoch) || !this.windowVisible) return
    this.clearPreviewTimers(preview)
    const now = this.clock.now()
    preview.endAt = now + Math.max(0, preview.remainingMs)
    preview.finishTimer = this.clock.setTimeout(() => {
      preview.finishTimer = null
      this.endPreview(preview.id)
    }, Math.max(0, preview.remainingMs))
    if (preview.phase === 'announce' && preview.presentation.config.alwaysVisible) {
      const delay = Math.min(preview.phaseRemainingMs, preview.remainingMs)
      if (delay > 0 && delay < preview.remainingMs) {
        preview.monitorAt = now + delay
        preview.phaseTimer = this.clock.setTimeout(() => {
          preview.phaseTimer = null
          if (!this.isPreviewCurrent(preview, this.viewEpoch)) return
          if (preview.endAt !== null) {
            preview.remainingMs = Math.max(0, preview.endAt - this.clock.now())
          }
          preview.phase = 'monitor'
          preview.phaseRemainingMs = 0
          preview.monitorAt = null
          this.updateWindow(this.frameFor(preview.presentation, 'monitor', {}))
        }, delay)
      }
    }
  }

  private pausePreview(preview: PreviewState): void {
    if (preview.endAt !== null) {
      preview.remainingMs = Math.max(0, preview.endAt - this.clock.now())
    }
    if (preview.monitorAt !== null) {
      preview.phaseRemainingMs = Math.max(0, preview.monitorAt - this.clock.now())
    } else if (preview.phase === 'announce') {
      preview.phaseRemainingMs = Math.min(preview.phaseRemainingMs, preview.remainingMs)
    }
    this.clearPreviewTimers(preview)
    preview.endAt = null
    preview.monitorAt = null
  }

  private clearPreviewTimers(preview: PreviewState): void {
    if (preview.finishTimer !== null) {
      this.clock.clearTimeout(preview.finishTimer)
      preview.finishTimer = null
    }
    if (preview.phaseTimer !== null) {
      this.clock.clearTimeout(preview.phaseTimer)
      preview.phaseTimer = null
    }
  }

  private endPreview(id: number): void {
    const preview = this.preview
    if (!preview || preview.id !== id) return
    this.clearPreviewTimers(preview)
    this.preview = null
    const epoch = ++this.viewEpoch
    if (this.locked || this.suspended || this.disposed) {
      this.hideWindow(true)
      return
    }
    if (!this.windowVisible || !preview.everShown) {
      this.hideWindow()
      this.afterPreviewClosed()
      return
    }

    // A normal settings dismiss/hide plays the same reversed timeline as a real
    // exit. Lock, suspend, dispose and a replaced preview bypass this path so
    // they stay instant and cannot hide a newer surface.
    this.previewExitInFlight = true
    const serial = ++this.previewExitSerial
    const frame = this.frameFor(preview.presentation, 'exit', {})
    void (async () => {
      try {
        await this.deps.window.retract(frame)
      } catch (error) {
        this.report(`preview reverse retraction failed (${this.errorText(error)})`)
      }
      if (
        this.disposed ||
        this.preview ||
        serial !== this.previewExitSerial ||
        epoch !== this.viewEpoch
      ) {
        return
      }
      this.previewExitInFlight = false
      this.hideWindow(true)
      this.afterPreviewClosed()
    })()
  }

  /** Continue with the live HUD or a deferred launcher restore after a preview. */
  private afterPreviewClosed(): void {
    if (this.disposed) return
    if (this.current && !this.current.ended) {
      this.resumeCurrent()
      return
    }
    if (this.newestLiveSession()) {
      this.updateView(true)
      return
    }
    this.flushPendingFinalize()
  }

  private abortPreviewExit(): void {
    this.previewExitSerial += 1
    this.previewExitInFlight = false
  }

  private frameFor(
    presentation: Presentation,
    phase: FramePhase,
    source: KevinHudMetricValues
  ): KevinHudFrame {
    const values: KevinHudMetricValues = {}
    for (const metric of presentation.metrics) {
      if (Object.hasOwn(source, metric)) values[metric] = source[metric]
    }
    return {
      phase,
      config: presentation.config,
      appName: presentation.appName,
      iconUrl: presentation.iconUrl,
      fontFamily: presentation.fontFamily,
      ...(presentation.launcherFonts
        ? {
            fontFamilyEn: presentation.launcherFonts.en,
            fontFamilyZh: presentation.launcherFonts.zh
          }
        : {}),
      appGlass: presentation.appGlass,
      values
    }
  }

  private async showFrame(frame: KevinHudFrame, stillWanted: () => boolean): Promise<boolean> {
    const serial = ++this.showSerial
    this.desiredVisible = true
    try {
      await this.deps.window.show(frame)
    } catch (error) {
      this.report(`could not show the HUD window (${this.errorText(error)})`)
      if (serial === this.showSerial) {
        this.desiredVisible = false
        this.hideWindow(true)
      }
      return false
    }
    if (!stillWanted()) {
      // A slow show may finish after the window was dismissed, locked or
      // disposed. If no newer show is still wanted, make sure it cannot linger.
      if (!this.desiredVisible) this.hideWindow(true)
      return false
    }
    this.windowVisible = true
    return true
  }

  private updateWindow(frame: KevinHudFrame): void {
    if (!this.windowVisible) return
    try {
      this.deps.window.update(frame)
    } catch (error) {
      this.report(`could not update the HUD window (${this.errorText(error)})`)
    }
  }

  private hideWindow(force = false): void {
    this.desiredVisible = false
    if (!this.windowVisible && !force) return
    this.windowVisible = false
    try {
      this.deps.window.hide()
    } catch (error) {
      this.report(`could not hide the HUD window (${this.errorText(error)})`)
    }
  }

  private restoreLauncher(): void {
    if (this.disposed) return
    try {
      const result = this.deps.shell.restoreLauncher()
      void Promise.resolve(result).catch((error) => {
        this.report(`could not restore the launcher window (${this.errorText(error)})`)
      })
    } catch (error) {
      this.report(`could not restore the launcher window (${this.errorText(error)})`)
    }
  }

  private report(message: string): void {
    try {
      this.deps.log?.(`kevinHud: ${message}`)
    } catch {
      /* diagnostics must never break the lifecycle */
    }
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
}
