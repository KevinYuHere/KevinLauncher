#!/usr/bin/env node
/**
 * Disposable Electron fixture for the settings Collapse drawers.
 *
 * This loads the real `src/renderer/src/components/Collapse.tsx` and the real
 * `src/renderer/src/assets/main.css` into a tiny generated page that mirrors a
 * scrolling settings view. It has no preload, never starts the launcher, and
 * uses a temporary userData/sessionData profile with a hidden, non-focusable
 * window. No game directory, installed launcher, user profile or network is
 * touched.
 *
 * The window is offscreen so the compositor advances CSS transitions even though
 * the page never becomes visible. The verifier waits on the real DOM transition
 * state and only forces an already-confirmed transition to its end (or, as a
 * fixture-only last resort, disables the reveal transition) before measuring
 * final geometry. It checks the two-level sticky header contract while open,
 * release past the drawer, no sticking while closed, native toggle focusability
 * and aria-controls/aria-expanded wiring, plus closed/open DOM state after real
 * DOM button clicks. Animation duration is not the subject.
 *
 * Usage (from the repository root):
 *   node scripts/verify-settings-drawers.cjs
 *
 * A successful run prints one JSON report and exits 0. Failures print one JSON
 * object to stderr and exit non-zero.
 */
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '..')
const RUN = 'node scripts/verify-settings-drawers.cjs'
const COMPONENT = path.join(ROOT, 'src', 'renderer', 'src', 'components', 'Collapse.tsx')
const STYLES = path.join(ROOT, 'src', 'renderer', 'src', 'assets', 'main.css')
const REACT_UMD = path.join(ROOT, 'node_modules', 'react', 'umd', 'react.production.min.js')
const REACT_DOM_UMD = path.join(
  ROOT,
  'node_modules',
  'react-dom',
  'umd',
  'react-dom.production.min.js'
)
const PROFILE_PREFIX = 'kl-settings-drawers-'
const HARD_TIMEOUT_MS = 35_000
const DIAGNOSTICS_TIMEOUT_MS = 800

/**
 * Serialisable DOM snapshot used by both the bounded wait loop and the failure
 * report. It deliberately includes the computed grid rows, every relevant box
 * height and the live CSS transition state so a failure can be diagnosed from
 * the single JSON report without another Electron launch.
 */
const DRAWER_DIAGNOSTICS = `(() => {
  const errorText = (error) => (error && error.message ? String(error.message) : String(error))
  const describeAnimation = (animation) => {
    try {
      const timing = animation.effect && typeof animation.effect.getTiming === 'function'
        ? animation.effect.getTiming()
        : null
      return {
        type: (animation.constructor && animation.constructor.name) || '',
        property: typeof animation.transitionProperty === 'string' ? animation.transitionProperty : '',
        playState: animation.playState || '',
        currentTime: typeof animation.currentTime === 'number' ? animation.currentTime : null,
        duration: timing ? timing.duration : null,
        delay: timing ? timing.delay : null,
        easing: timing ? timing.easing : ''
      }
    } catch (error) {
      return { error: errorText(error) }
    }
  }
  const readDrawer = (id) => {
    const result = {
      id,
      found: false,
      rowFound: false,
      buttonFound: false,
      ariaExpanded: null
    }
    try {
      const row = document.querySelector('[data-header="' + id + '"]')
      const head = row && row.closest('.collapse-head')
      const collapse = head && head.parentElement
      const reveal = collapse && collapse.querySelector(':scope > .collapse-reveal')
      const button = document.getElementById(id + '-toggle')
      result.rowFound = !!row
      result.buttonFound = !!button
      result.ariaExpanded = button ? button.getAttribute('aria-expanded') : null
      if (!head || !collapse || !reveal) return result
      const style = getComputedStyle(reveal)
      const headStyle = getComputedStyle(head)
      const bounds = reveal.getBoundingClientRect()
      const inner = reveal.firstElementChild
      let animations = []
      try {
        animations = reveal.getAnimations().map(describeAnimation)
      } catch (error) {
        animations = [{ error: errorText(error) }]
      }
      result.found = true
      result.open = collapse.classList.contains('open')
      result.head = {
        height: head.getBoundingClientRect().height,
        position: headStyle.position,
        top: headStyle.top,
        zIndex: headStyle.zIndex
      }
      result.reveal = {
        ariaHidden: reveal.getAttribute('aria-hidden'),
        inert: reveal.inert === true,
        height: bounds.height,
        offsetHeight: reveal.offsetHeight,
        clientHeight: reveal.clientHeight,
        scrollHeight: reveal.scrollHeight,
        gridTemplateRows: style.gridTemplateRows,
        minHeight: style.minHeight,
        overflow: style.overflow,
        transitionProperty: style.transitionProperty,
        transitionDuration: style.transitionDuration,
        transitionDelay: style.transitionDelay,
        transitionTimingFunction: style.transitionTimingFunction,
        innerHeight: inner ? inner.getBoundingClientRect().height : null,
        innerMinHeight: inner ? getComputedStyle(inner).minHeight : null
      }
      result.animations = animations
      return result
    } catch (error) {
      result.error = errorText(error)
      return result
    }
  }
  const scroller = document.getElementById('settings-scroll')
  let animations = []
  try {
    animations = document.getAnimations().map(describeAnimation)
  } catch (error) {
    animations = [{ error: errorText(error) }]
  }
  let focus = null
  try {
    focus = document.hasFocus()
  } catch (error) {
    focus = 'error: ' + errorText(error)
  }
  return {
    at: Date.now(),
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    hasFocus: focus,
    viewport: {
      width: innerWidth,
      height: innerHeight,
      devicePixelRatio: devicePixelRatio
    },
    timelineCurrentTime:
      document.timeline && document.timeline.currentTime !== null
        ? Number(document.timeline.currentTime)
        : null,
    scroll: scroller
      ? {
          scrollTop: scroller.scrollTop,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight
        }
      : null,
    transitionFallbackApplied: !!document.getElementById('fixture-disabled-drawer-transitions'),
    parent: readDrawer('parent'),
    child: readDrawer('child'),
    documentAnimations: animations
  }
})()`

let electronApi = null
try {
  const loaded = require('electron')
  // Under Node this is the executable path, not the Electron API.
  if (loaded && typeof loaded === 'object' && loaded.app && loaded.BrowserWindow) {
    electronApi = loaded
  }
} catch {
  // The bootstrap below reports a missing/invalid Electron installation.
}
if (!electronApi) bootstrapUnderElectron()

const { app, BrowserWindow } = electronApi
const startedAt = Date.now()
let stage = 'bootstrap'
let profileRoot = null
let profilePaths = null
let fixtureWindow = null
let finished = false
let hardTimeout = null
let consoleErrors = []

try {
  app.setName('kl-settings-drawers-fixture')
  app.disableHardwareAcceleration()
  prepareProfile()
  app.setPath('userData', profilePaths.userData)
  app.setPath('sessionData', profilePaths.sessionData)
  app.setPath('crashDumps', profilePaths.crashDumps)
  app.setPath('logs', profilePaths.logs)
} catch (error) {
  writeFailure(error, 'prepare isolated profile')
  cleanProfile()
  process.exit(1)
}

app.on('window-all-closed', () => {
  // Keep the process alive until the verifier emits its one report.
})
app.whenReady()
  .then(run)
  .then((report) => finishSuccess(report))
  .catch((error) => finishFailure(error))

process.on('uncaughtException', (error) => finishFailure(error))
process.on('unhandledRejection', (error) => finishFailure(error))
process.on('exit', cleanProfile)

function bootstrapUnderElectron() {
  let executable = null
  try {
    const loaded = require('electron')
    if (typeof loaded === 'string' && fs.existsSync(loaded)) executable = loaded
  } catch {
    // Fall through to the conventional local path.
  }
  if (!executable) {
    const binary = process.platform === 'win32' ? 'electron.exe' : 'electron'
    executable = path.join(ROOT, 'node_modules', 'electron', 'dist', binary)
  }
  if (!executable || !fs.existsSync(executable)) {
    bootstrapFailure(
      `Electron executable not found. Run npm install first. Tried: ${executable || '(none)'}`
    )
  }

  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE

  // File descriptors are used instead of piped stdio: Chromium already needs
  // the host to allow its own IPC, and a host sandbox may also reject extra
  // anonymous pipes. Redirecting to disposable files keeps the verifier's own
  // report readable in both normal and constrained sessions.
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${PROFILE_PREFIX}bootstrap-`))
  const stdoutPath = path.join(probeRoot, 'stdout.txt')
  const stderrPath = path.join(probeRoot, 'stderr.txt')
  let child = null
  let outFd = null
  let errFd = null
  let setupError = null
  try {
    outFd = fs.openSync(stdoutPath, 'w')
    errFd = fs.openSync(stderrPath, 'w')
    child = spawnSync(executable, [__filename, ...process.argv.slice(2)], {
      stdio: ['inherit', outFd, errFd],
      env: environment,
      windowsHide: true,
      timeout: HARD_TIMEOUT_MS + 5_000
    })
  } catch (error) {
    setupError = error
  } finally {
    if (errFd !== null) fs.closeSync(errFd)
    if (outFd !== null) fs.closeSync(outFd)
  }
  if (setupError) {
    cleanupBootstrapProbe(probeRoot)
    bootstrapFailure(
      `Could not create the Electron bootstrap capture: ${
        setupError instanceof Error ? setupError.message : String(setupError)
      }`
    )
  }

  let childStdout = ''
  let childStderr = ''
  try {
    childStdout = fs.readFileSync(stdoutPath, 'utf8')
    childStderr = fs.readFileSync(stderrPath, 'utf8')
  } catch {
    // Keep the diagnostic below even if the temp file could not be read.
  }
  const exitCode = child && typeof child.status === 'number' ? child.status : 1
  let childReport = null
  try {
    childReport = JSON.parse(childStdout)
  } catch {
    // A failure report is written to stderr; try that stream too below.
  }
  if (!childReport) {
    try {
      childReport = JSON.parse(childStderr)
    } catch {
      // Not a verifier report; summarize the captured output below.
    }
  }

  if (childReport) {
    process.stdout.write(childStdout)
    process.stderr.write(childStderr)
  } else if (child && child.error) {
    const message = `Could not start Electron: ${child.error.message}`
    cleanupBootstrapProbe(probeRoot)
    bootstrapFailure(message)
  } else if (childStdout.trim() || childStderr.trim()) {
    const detail = [childStderr.trim(), childStdout.trim()].filter(Boolean).join('\n')
    const message =
      isBreakpointExit(exitCode)
        ? `Electron aborted (Windows STATUS_BREAKPOINT 0x80000003) before loading the fixture. ` +
          `Run this verifier from a normal interactive Windows session that permits the local Electron GUI.\n${detail}`
        : `Electron exited before emitting a verifier report (exit code: ${exitCode}).\n${detail}`
    cleanupBootstrapProbe(probeRoot)
    bootstrapFailure(message)
  } else {
    const message =
      isBreakpointExit(exitCode)
        ? 'Electron aborted before loading the fixture (Windows STATUS_BREAKPOINT 0x80000003). ' +
          'Run this verifier from a normal interactive Windows session that permits the local Electron GUI; ' +
          'a host process/file sandbox that denies Chromium IPC named pipes cannot run it.'
        : `Electron exited before emitting a verifier report (exit code: ${exitCode}).`
    cleanupBootstrapProbe(probeRoot)
    bootstrapFailure(message)
  }

  cleanupBootstrapProbe(probeRoot)
  process.exit(exitCode)
}

function isBreakpointExit(status) {
  // Node exposes a Windows crash exit status either signed (-2147483645) or
  // unsigned (2147483651); both are STATUS_BREAKPOINT / 0x80000003.
  return status === -2147483645 || status === 2147483651
}

function cleanupBootstrapProbe(directory) {
  const resolved = path.resolve(directory)
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith(`${PROFILE_PREFIX}bootstrap-`)
  ) {
    return
  }
  try {
    fs.rmSync(resolved, { recursive: true, force: true })
  } catch {
    // The diagnostic files live in the OS temp area and can be retried by the
    // next run; never turn cleanup into a misleading verification failure.
  }
}

function bootstrapFailure(message) {
  process.stderr.write(
    `${JSON.stringify({ ok: false, run: RUN, stage: 'electron bootstrap', error: message }, null, 2)}\n`
  )
  process.exit(1)
}

function prepareProfile() {
  profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX))
  const resolved = path.resolve(profileRoot)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PROFILE_PREFIX)) {
    throw new Error('Refusing to create a disposable profile outside the OS temporary directory.')
  }
  profilePaths = {
    userData: path.join(profileRoot, 'user-data'),
    sessionData: path.join(profileRoot, 'session-data'),
    crashDumps: path.join(profileRoot, 'crashes'),
    logs: path.join(profileRoot, 'logs')
  }
  for (const directory of Object.values(profilePaths)) {
    fs.mkdirSync(directory, { recursive: true })
  }
}

function cleanProfile() {
  if (!profileRoot) return
  const target = path.resolve(profileRoot)
  if (
    path.dirname(target) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith(PROFILE_PREFIX)
  ) {
    return
  }
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 80 })
    profileRoot = null
  } catch {
    // Chromium can briefly hold a cache handle while the process exits.
  }
}

function writeFailure(error, failureStage = stage, diagnostics = null) {
  const message = error instanceof Error ? error.message : String(error)
  writeFd(
    2,
    `${JSON.stringify(
      {
        ok: false,
        run: RUN,
        stage: failureStage,
        error: message,
        stack: error instanceof Error ? String(error.stack || '').split('\n').slice(0, 6) : undefined,
        ...(diagnostics ? { diagnostics } : {}),
        consoleErrors
      },
      null,
      2
    )}\n`
  )
}

function withDeadline(promise, timeoutMs) {
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ error: `diagnostics timed out after ${timeoutMs}ms` }),
      timeoutMs
    )
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function writeFd(fileDescriptor, text) {
  try {
    // The parent bootstrap redirects the child's stdio to disposable files.
    // Writing synchronously guarantees the single JSON report reaches it before
    // app.exit tears the process down.
    fs.writeSync(fileDescriptor, text)
    return
  } catch {
    // Direct electron invocations may expose a TTY/pipe instead.
  }
  try {
    if (fileDescriptor === 1) process.stdout.write(text)
    else process.stderr.write(text)
  } catch {
    // There is no reliable report channel left.
  }
}

async function run() {
  stage = 'verify arguments and fixture sources'
  assert.ok(fs.existsSync(COMPONENT), `Real Collapse component not found: ${COMPONENT}`)
  assert.ok(fs.existsSync(STYLES), `Real settings stylesheet not found: ${STYLES}`)
  assert.equal(path.resolve(app.getPath('userData')), path.resolve(profilePaths.userData))
  assert.equal(path.resolve(app.getPath('sessionData')), path.resolve(profilePaths.sessionData))

  hardTimeout = setTimeout(() => {
    finishFailure(new Error(`Settings drawer verification exceeded ${HARD_TIMEOUT_MS}ms.`))
  }, HARD_TIMEOUT_MS)

  stage = 'build disposable fixture'
  assert.ok(fs.existsSync(REACT_UMD), `Local React UMD build not found: ${REACT_UMD}`)
  assert.ok(fs.existsSync(REACT_DOM_UMD), `Local ReactDOM UMD build not found: ${REACT_DOM_UMD}`)
  const work = path.join(profileRoot, 'fixture')
  fs.mkdirSync(work, { recursive: true })
  const bundlePath = path.join(work, 'fixture.js')
  const htmlPath = path.join(work, 'fixture.html')
  buildFixture(bundlePath)
  fs.writeFileSync(htmlPath, fixtureHtml(bundlePath), 'utf8')

  stage = 'create hidden non-focusable Electron window'
  const win = new BrowserWindow({
    width: 940,
    height: 640,
    show: false,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: 'Settings drawer verification fixture',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      partition: `settings-drawers-${process.pid}`,
      offscreen: true,
      backgroundThrottling: false,
      spellcheck: false
    }
  })
  fixtureWindow = win
  win.setMenuBarVisibility(false)
  assert.equal(win.isVisible(), false, 'The fixture window must stay hidden.')
  assert.equal(win.isFocused(), false, 'The fixture window must not take focus.')
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('preload-error', (_event, preload, error) => {
    recordConsoleError(`preload-error ${preload}: ${error instanceof Error ? error.message : String(error)}`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    finishFailure(new Error(`Fixture renderer process gone: ${details.reason}`))
  })
  win.webContents.on('console-message', (...args) => {
    const details = args[1] && typeof args[1] === 'object' ? args[1] : null
    if (details) {
      const level = String(details.level || '').toLowerCase()
      if (level === 'error') recordConsoleError(details.message || '')
      return
    }
    if (args[1] >= 3) recordConsoleError(String(args[2] || ''))
  })

  const execute = (source) => {
    if (win.isDestroyed()) throw new Error('Fixture window was destroyed.')
    return win.webContents.executeJavaScript(source, false)
  }
  const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  const round = (value) => Math.round(value * 100) / 100
  const readDiagnostics = async () => {
    try {
      return await withDeadline(execute(DRAWER_DIAGNOSTICS), DIAGNOSTICS_TIMEOUT_MS)
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
  const until = async (condition, label, timeout = 4_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await execute(condition)) return
      await pause(25)
    }
    const diagnostics = await readDiagnostics()
    throw new Error(
      `${label} did not settle within ${timeout}ms. Diagnostics: ${JSON.stringify(diagnostics)}`
    )
  }

  stage = 'load generated DOM fixture'
  await win.loadURL(pathToFileURL(htmlPath).href)
  await until(
    `document.readyState === 'complete' && !!document.getElementById('parent-toggle') && !!document.getElementById('child-toggle')`,
    'actual Collapse headers with header ReactNode'
  )
  await until(
    `(() => {
      const row = document.querySelector('[data-header="parent"]')
      const head = row && row.closest('.collapse-head')
      const child = document.querySelector('[data-header="child"]')?.closest('.collapse-head')
      if (!head || !child) return false
      const parentHeight = head.getBoundingClientRect().height
      const childTop = Number.parseFloat(getComputedStyle(child).top)
      return Number.isFinite(parentHeight) && Number.isFinite(childTop) && Math.abs(childTop - parentHeight) < 0.75
    })()`,
    'nested sticky offset measured by the real Collapse component'
  )

  const readState = () =>
    execute(`(() => {
      const scroller = document.getElementById('settings-scroll')
      const parentRow = document.querySelector('[data-header="parent"]')
      const childRow = document.querySelector('[data-header="child"]')
      const parentHead = parentRow.closest('.collapse-head')
      const childHead = childRow.closest('.collapse-head')
      const parentCollapse = parentHead.parentElement
      const childCollapse = childHead.parentElement
      const parentReveal = parentCollapse.querySelector(':scope > .collapse-reveal')
      const childReveal = childCollapse.querySelector(':scope > .collapse-reveal')
      const viewport = scroller.getBoundingClientRect()
      const rect = (element) => {
        const bounds = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return {
          top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right,
          height: bounds.height, width: bounds.width,
          position: style.position, topStyle: style.top, zIndex: style.zIndex
        }
      }
      const docTop = (element) => element.getBoundingClientRect().top - viewport.top + scroller.scrollTop
      const revealState = (reveal) => ({
        ariaHidden: reveal.getAttribute('aria-hidden'),
        inert: reveal.inert === true,
        height: reveal.getBoundingClientRect().height
      })
      return {
        viewport: {
          top: viewport.top, bottom: viewport.bottom, left: viewport.left, right: viewport.right,
          width: viewport.width, height: viewport.height,
          scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight
        },
        offsets: {
          parentHeader: docTop(parentHead), parentHeaderHeight: parentHead.getBoundingClientRect().height,
          childHeader: docTop(childHead), childHeaderHeight: childHead.getBoundingClientRect().height,
          parentCollapseBottom: docTop(parentCollapse) + parentCollapse.offsetHeight,
          childCollapseBottom: docTop(childCollapse) + childCollapse.offsetHeight
        },
        parent: rect(parentHead), parentRow: rect(parentRow), parentReveal: revealState(parentReveal),
        child: rect(childHead), childRow: rect(childRow), childReveal: revealState(childReveal),
        parentOpen: parentCollapse.classList.contains('open'),
        childOpen: childCollapse.classList.contains('open'),
        parentExpanded: document.getElementById('parent-toggle').getAttribute('aria-expanded'),
        childExpanded: document.getElementById('child-toggle').getAttribute('aria-expanded'),
        activeId: document.activeElement && document.activeElement.id || ''
      }
    })()`)

  const nextLayout = () =>
    execute(`new Promise((resolve) => {
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        resolve(true)
      }
      // Two real animation frames let sticky layout settle without treating a
      // wall-clock sleep as the condition. The timeout only keeps the fixture
      // bounded if a constrained compositor never delivers a frame.
      requestAnimationFrame(() => requestAnimationFrame(finish))
      setTimeout(finish, 160)
    })`)

  const scrollTo = async (requested, label) => {
    const actual = await execute(`(() => {
      const scroller = document.getElementById('settings-scroll')
      scroller.scrollTop = ${Math.round(requested)}
      return {
        scrollTop: scroller.scrollTop,
        max: scroller.scrollHeight - scroller.clientHeight
      }
    })()`)
    await nextLayout()
    const state = await readState()
    assert.ok(actual.max > 0, `${label}: the fixture viewport must be scrollable.`)
    assert.ok(
      Math.abs(state.viewport.scrollTop - actual.scrollTop) < 1,
      `${label}: fixture scroll position was not stable.`
    )
    return state
  }

  const pairRecord = (state, label) => ({
    label,
    scrollTop: round(state.viewport.scrollTop),
    parent: {
      position: state.parent.position,
      headerTopOffset: round(state.parent.top - state.viewport.top),
      headerBottomOffset: round(state.parent.bottom - state.viewport.top),
      rowTopOffset: round(state.parentRow.top - state.viewport.top),
      rowBottomOffset: round(state.parentRow.bottom - state.viewport.top),
      height: round(state.parent.height)
    },
    child: {
      position: state.child.position,
      headerTopOffset: round(state.child.top - state.viewport.top),
      headerBottomOffset: round(state.child.bottom - state.viewport.top),
      rowTopOffset: round(state.childRow.top - state.viewport.top),
      rowBottomOffset: round(state.childRow.bottom - state.viewport.top),
      height: round(state.child.height)
    },
    childOffsetBelowParent: round(state.child.top - state.parent.bottom),
    rowGap: round(state.childRow.top - state.parentRow.bottom)
  })

  const assertPinnedPair = (state, label, reference = null) => {
    const viewport = state.viewport
    assert.equal(state.parent.position, 'sticky', `${label}: open parent header must use position sticky.`)
    assert.equal(state.child.position, 'sticky', `${label}: open nested header must use position sticky.`)
    assert.equal(state.parentOpen, true, `${label}: parent drawer must be open.`)
    assert.equal(state.childOpen, true, `${label}: child drawer must be open.`)
    assert.ok(state.parent.height > 30, `${label}: parent header has no height.`)
    assert.ok(state.child.height > 30, `${label}: child header has no height.`)
    assert.ok(
      state.parent.top >= viewport.top - 1 && state.parent.bottom <= viewport.bottom + 1,
      `${label}: parent header must be visible in the viewport.`
    )
    assert.ok(
      state.child.top >= viewport.top - 1 && state.child.bottom <= viewport.bottom + 1,
      `${label}: nested header must be visible in the viewport.`
    )
    assert.ok(
      state.parentRow.top >= viewport.top - 1 && state.parentRow.bottom <= viewport.bottom + 1,
      `${label}: parent header row must be visible in the viewport.`
    )
    assert.ok(
      state.childRow.top >= viewport.top - 1 && state.childRow.bottom <= viewport.bottom + 1,
      `${label}: nested header row must be visible in the viewport.`
    )
    assert.ok(state.parentRow.height > 30, `${label}: parent header row has no height.`)
    assert.ok(state.childRow.height > 30, `${label}: nested header row has no height.`)
    assert.ok(
      state.childRow.top >= state.parentRow.bottom - 0.5,
      `${label}: parent and child header rows overlap.`
    )
    // The page has 11px top padding, so sticky top 0 may align to the scrollport
    // padding edge (11px). Anything beyond 20px would mean it is not pinned.
    const parentOffset = state.parent.top - viewport.top
    assert.ok(
      parentOffset >= -1 && parentOffset <= 20,
      `${label}: parent header must be pinned near the scrollport top (offset ${round(parentOffset)}px).`
    )
    assert.ok(
      state.child.top >= state.parent.bottom - 0.5,
      `${label}: parent and child headers overlap by ${round(state.parent.bottom - state.child.top)}px.`
    )
    assert.ok(
      state.child.top - state.parent.bottom <= 1.5,
      `${label}: child header must sit directly below the parent header.`
    )
    if (reference) {
      assert.ok(
        Math.abs(state.parent.top - reference.parent.top) <= 1,
        `${label}: parent header moved while scrolling (${round(reference.parent.top - state.parent.top)}px).`
      )
      assert.ok(
        Math.abs(state.child.top - reference.child.top) <= 1,
        `${label}: child header moved while scrolling (${round(reference.child.top - state.child.top)}px).`
      )
    }
    return pairRecord(state, label)
  }

  const transitionLog = []
  let transitionFallbackDisabled = false

  const runningAnimations = (drawer) =>
    (drawer && Array.isArray(drawer.animations) ? drawer.animations : []).filter(
      (animation) => animation && animation.playState === 'running'
    )

  const durationMsOf = (value) =>
    String(value || '')
      .split(',')
      .reduce((maximum, part) => {
        const text = part.trim()
        const amount = Number.parseFloat(text)
        if (!Number.isFinite(amount)) return maximum
        return Math.max(maximum, text.endsWith('ms') ? amount : amount * 1000)
      }, 0)

  const isDrawerSettled = (drawer, open) => {
    if (!drawer || drawer.found !== true || drawer.open !== open || !drawer.reveal) return false
    if (open) {
      return (
        drawer.ariaExpanded === 'true' &&
        drawer.reveal.ariaHidden === 'false' &&
        drawer.reveal.inert === false &&
        drawer.reveal.height > 0.75
      )
    }
    return (
      drawer.ariaExpanded === 'false' &&
      drawer.reveal.ariaHidden === 'true' &&
      drawer.reveal.inert === true &&
      drawer.reveal.height < 0.75
    )
  }

  const waitForDrawerSettled = async (id, open, timeout) => {
    const deadline = Date.now() + timeout
    let last = null
    while (Date.now() < deadline) {
      const snapshot = await readDiagnostics()
      last = snapshot && snapshot[id]
      if (isDrawerSettled(last, open) && runningAnimations(last).length === 0) return last
      await pause(20)
    }
    return last
  }

  const finishDrawerAnimations = async (id) =>
    execute(`(() => {
      const row = document.querySelector('[data-header="${id}"]')
      const head = row && row.closest('.collapse-head')
      const collapse = head && head.parentElement
      const reveal = collapse && collapse.querySelector(':scope > .collapse-reveal')
      if (!reveal) return { found: false, attempted: 0, errors: [], before: [], after: [] }
      const describe = (animation) => ({
        type: (animation.constructor && animation.constructor.name) || '',
        property: typeof animation.transitionProperty === 'string' ? animation.transitionProperty : '',
        playState: animation.playState || '',
        currentTime: typeof animation.currentTime === 'number' ? animation.currentTime : null
      })
      const animations = reveal.getAnimations()
      const before = animations.map(describe)
      const errors = []
      let attempted = 0
      for (const animation of animations) {
        if (typeof animation.finish !== 'function') continue
        try {
          animation.finish()
          attempted += 1
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error))
        }
      }
      let after = []
      try {
        after = reveal.getAnimations().map(describe)
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
      return { found: true, attempted, errors, before, after }
    })()`)

  const disableDrawerTransitions = async () =>
    execute(`(() => {
      if (document.getElementById('fixture-disabled-drawer-transitions')) {
        return { added: false, alreadyPresent: true }
      }
      // Fixture-only last resort: keep the production stylesheet and stacking
      // untouched, and only remove the reveal transition. It never runs against
      // the launcher window.
      const style = document.createElement('style')
      style.id = 'fixture-disabled-drawer-transitions'
      style.textContent = '.collapse-reveal { transition: none !important; }'
      document.head.appendChild(style)
      return { added: true, alreadyPresent: false }
    })()`)

  const settleDrawer = async (id, open, label) => {
    const startedAt = Date.now()
    const expanded = open ? 'true' : 'false'
    const ariaHidden = open ? 'false' : 'true'
    await until(
      `(() => {
        const button = document.getElementById(${JSON.stringify(id + '-toggle')})
        const row = document.querySelector(${JSON.stringify(`[data-header="${id}"]`)})
        const collapse = row && row.closest('.collapse')
        const reveal = collapse && collapse.querySelector(':scope > .collapse-reveal')
        return !!button && !!collapse && !!reveal &&
          button.getAttribute('aria-expanded') === ${JSON.stringify(expanded)} &&
          collapse.classList.contains('open') === ${open} &&
          reveal.getAttribute('aria-hidden') === ${JSON.stringify(ariaHidden)} &&
          reveal.inert === ${!open}
      })()`,
      `${label}: DOM drawer state`
    )

    let drawer = null
    let observedTransition = false
    let observedGridTransition = false
    let transitionDurationMs = 0
    let firstTransitionAt = 0
    let graceDeadline = 0
    const waitStarted = Date.now()
    const detectionDeadline = waitStarted + 600
    const overallDeadline = waitStarted + 4_000

    while (Date.now() < overallDeadline) {
      const snapshot = await readDiagnostics()
      drawer = snapshot && snapshot[id]
      if (drawer && drawer.found) {
        const animations = Array.isArray(drawer.animations) ? drawer.animations : []
        if (animations.length > 0) {
          if (
            animations.some(
              (animation) =>
                (animation && animation.type) === 'CSSTransition' ||
                String((animation && animation.property) || '') !== ''
            )
          ) {
            observedTransition = true
          }
          if (
            animations.some((animation) =>
              String((animation && animation.property) || '').includes('grid-template-rows')
            )
          ) {
            observedGridTransition = true
          }
          if (observedTransition && firstTransitionAt === 0) {
            firstTransitionAt = Date.now()
            transitionDurationMs = durationMsOf(drawer.reveal && drawer.reveal.transitionDuration)
            const transitionDelayMs = durationMsOf(drawer.reveal && drawer.reveal.transitionDelay)
            // The fixture cares about the final frame, not the 260ms duration.
            // This grace still lets a working offscreen compositor finish the
            // real transition; only a stalled one reaches the bounded finish.
            graceDeadline =
              firstTransitionAt +
              Math.min(
                900,
                Math.max(200, transitionDurationMs + transitionDelayMs + 150)
              )
          }
        }
        if (isDrawerSettled(drawer, open) && runningAnimations(drawer).length === 0) {
          transitionLog.push({
            drawer: id,
            target: open ? 'open' : 'closed',
            label,
            elapsedMs: Date.now() - startedAt,
            observedCssTransition: observedTransition,
            observedGridTemplateRowsTransition: observedGridTransition,
            transitionDurationMs: round(transitionDurationMs),
            forcedFinishAttempted: 0,
            forcedFinishErrors: [],
            disabledTransitionFallback: false,
            finalHeight: round(drawer.reveal.height),
            finalGridTemplateRows: drawer.reveal.gridTemplateRows,
            animationsRemaining: 0
          })
          return drawer
        }
      }
      const now = Date.now()
      if (observedTransition ? now >= graceDeadline : now >= detectionDeadline) break
      await pause(20)
    }

    // The DOM state has committed. If the hidden compositor did not advance the
    // already-confirmed transition, finish it and measure the same final frame
    // the user would eventually see. This fixture tests sticky/toggle behaviour,
    // not animation duration.
    const forced = observedTransition
      ? await finishDrawerAnimations(id)
      : { attempted: 0, errors: [], before: [], after: [], found: true }
    let settled = await waitForDrawerSettled(id, open, 1_000)
    let fallbackApplied = false
    if (!isDrawerSettled(settled, open) || runningAnimations(settled).length > 0) {
      // If even a forced finish cannot settle, disable only the fixture's
      // reveal transition. The production CSS, sticky positioning and stacking
      // rules remain in force, so final geometry and layering are still tested.
      const fallback = await disableDrawerTransitions()
      fallbackApplied = fallback.added === true || fallback.alreadyPresent === true
      if (fallback.added === true) transitionFallbackDisabled = true
      settled = await waitForDrawerSettled(id, open, 1_000)
    }

    const record = {
      drawer: id,
      target: open ? 'open' : 'closed',
      label,
      elapsedMs: Date.now() - startedAt,
      observedCssTransition: observedTransition,
      observedGridTemplateRowsTransition: observedGridTransition,
      transitionDurationMs: round(transitionDurationMs),
      forcedFinishAttempted: Number(forced.attempted) || 0,
      forcedFinishErrors: Array.isArray(forced.errors) ? forced.errors : [],
      disabledTransitionFallback: fallbackApplied,
      finalHeight: settled && settled.reveal ? round(settled.reveal.height) : null,
      finalGridTemplateRows: settled && settled.reveal ? settled.reveal.gridTemplateRows : null,
      animationsRemaining: runningAnimations(settled).length
    }
    transitionLog.push(record)
    if (!isDrawerSettled(settled, open) || runningAnimations(settled).length > 0) {
      const diagnostics = await readDiagnostics()
      throw new Error(
        `${label}: drawer did not reach its final DOM geometry within the bounded transition wait. ` +
        `Settle: ${JSON.stringify(record)} Diagnostics: ${JSON.stringify(diagnostics)}`
      )
    }
    return settled
  }

  stage = 'verify open parent + child sticky headers on down/up scroll'
  await settleDrawer('parent', true, 'initial open parent drawer')
  await settleDrawer('child', true, 'initial open child drawer')
  const initial = await readState()
  assert.equal(initial.parentOpen, true, 'Fixture parent drawer must start open.')
  assert.equal(initial.childOpen, true, 'Fixture child drawer must start open.')
  const downOneTarget = Math.floor(
    initial.offsets.childHeader - initial.offsets.parentHeaderHeight + 72
  )
  const downTwoTarget = Math.min(
    downOneTarget + 150,
    Math.floor(initial.offsets.childCollapseBottom - initial.offsets.childHeaderHeight - 40),
    Math.floor(initial.offsets.parentCollapseBottom - initial.offsets.parentHeaderHeight - 40)
  )
  assert.ok(downTwoTarget > downOneTarget, 'Fixture needs more room below the nested header.')
  const downOne = await scrollTo(downOneTarget, 'down one')
  const downRecord = assertPinnedPair(downOne, 'down one')
  const downTwo = await scrollTo(downTwoTarget, 'down two')
  const downTwoRecord = assertPinnedPair(downTwo, 'down two', downOne)
  const upOne = await scrollTo(downOneTarget, 'up one')
  const upRecord = assertPinnedPair(upOne, 'up one', downTwo)

  stage = 'verify sticky headers release past the parent drawer'
  const releaseTarget = Math.ceil(initial.offsets.parentCollapseBottom + initial.offsets.parentHeaderHeight + 64)
  const released = await scrollTo(releaseTarget, 'past parent drawer')
  assert.ok(
    released.viewport.scrollTop >= releaseTarget - 1,
    'Fixture does not have enough trailing content to scroll past the parent drawer.'
  )
  assert.ok(
    released.parent.bottom < released.viewport.top + 0.5,
    'Parent header stayed pinned after scrolling beyond its drawer.'
  )
  assert.ok(
    released.child.bottom < released.viewport.top + 0.5,
    'Nested header stayed pinned after scrolling beyond the parent drawer.'
  )

  stage = 'verify closed drawer does not stick'
  await scrollTo(0, 'closed setup')
  await execute("document.getElementById('parent-toggle').click(); true")
  await settleDrawer('parent', false, 'parent drawer closed and collapsed')
  const closedAtTop = await readState()
  assert.equal(closedAtTop.parentOpen, false)
  assert.equal(closedAtTop.parentReveal.inert, true, 'Closed parent content must be inert.')
  assert.equal(closedAtTop.parentReveal.ariaHidden, 'true', 'Closed parent content must be aria-hidden.')
  assert.ok(closedAtTop.parentReveal.height < 0.75, 'Closed parent content must have zero height.')
  assert.notEqual(closedAtTop.parent.position, 'sticky', 'Closed parent header must not be sticky.')
  const closedScrollTarget = Math.ceil(
    closedAtTop.offsets.parentHeader + closedAtTop.parent.height + 48
  )
  const closedScrolled = await scrollTo(closedScrollTarget, 'closed header out of view')
  assert.notEqual(closedScrolled.parent.position, 'sticky', 'Closed parent header must not stick while scrolling.')
  assert.ok(
    closedScrolled.parent.bottom < closedScrolled.viewport.top + 0.5,
    'Closed parent header stayed visible at the top while scrolling.'
  )

  stage = 'verify native toggle focusability and ARIA wiring'
  const focused = await execute(
    "(() => { const button = document.getElementById('parent-toggle'); button.focus(); return document.activeElement && document.activeElement.id || '' })()"
  )
  assert.equal(focused, 'parent-toggle', 'Parent header toggle must be focusable.')
  const parentTagName = await execute("document.getElementById('parent-toggle').tagName")
  assert.equal(parentTagName, 'BUTTON', 'The drawer affordance must be a native button.')
  const schema = await execute(`(() => {
    const parent = document.getElementById('parent-toggle')
    const child = document.getElementById('child-toggle')
    return {
      parentType: parent.getAttribute('type'),
      parentExpanded: parent.getAttribute('aria-expanded'),
      parentControls: parent.getAttribute('aria-controls'),
      parentControlExists: !!document.getElementById(parent.getAttribute('aria-controls')),
      parentTabIndex: parent.tabIndex,
      childType: child.getAttribute('type'),
      childExpanded: child.getAttribute('aria-expanded'),
      childControls: child.getAttribute('aria-controls'),
      childTabIndex: child.tabIndex,
      childControlExists: !!document.getElementById(child.getAttribute('aria-controls'))
    }
  })()`)
  assert.equal(schema.parentType, 'button')
  assert.equal(schema.childType, 'button')
  assert.ok(schema.parentTabIndex >= 0, 'Parent header toggle must be in the tab order.')
  assert.ok(schema.childTabIndex >= 0, 'Nested header toggle must be in the tab order.')
  assert.equal(schema.parentExpanded, 'false')
  assert.equal(schema.childExpanded, 'true')
  assert.equal(schema.parentControls, 'parent-content')
  assert.equal(schema.childControls, 'child-content')
  assert.ok(schema.parentControlExists, 'Parent toggle aria-controls must target rendered content.')
  assert.ok(schema.childControlExists, 'Child toggle aria-controls must target rendered content.')

  stage = 'reopen the parent drawer through the real DOM button'
  await execute("document.getElementById('parent-toggle').click(); true")
  await settleDrawer('parent', true, 'parent drawer reopened by DOM button click')
  const reopened = await readState()
  assert.equal(reopened.parentOpen, true, 'DOM button click must reopen the parent drawer.')
  assert.equal(reopened.parentExpanded, 'true', 'Parent aria-expanded must track the reopened drawer.')
  assert.equal(reopened.parentReveal.inert, false, 'Reopened parent content must not be inert.')
  assert.equal(reopened.parentReveal.ariaHidden, 'false', 'Reopened parent content must be exposed.')
  assert.ok(reopened.parentReveal.height > 0, 'Reopened parent content must be visible.')

  stage = 'close the nested drawer through the real DOM button'
  const childFocused = await execute(
    "(() => { const button = document.getElementById('child-toggle'); button.focus(); return document.activeElement && document.activeElement.id || '' })()"
  )
  assert.equal(childFocused, 'child-toggle', 'Nested header toggle must be focusable.')
  await execute("document.getElementById('child-toggle').click(); true")
  await settleDrawer('child', false, 'nested drawer closed by DOM button click')
  const closedNested = await readState()
  assert.equal(closedNested.childOpen, false, 'DOM button click must close the nested drawer.')
  assert.equal(closedNested.childExpanded, 'false', 'Child aria-expanded must track the closed drawer.')
  assert.equal(closedNested.childReveal.inert, true, 'Closed nested content must be inert.')
  assert.equal(closedNested.childReveal.ariaHidden, 'true', 'Closed nested content must be aria-hidden.')
  assert.ok(closedNested.childReveal.height < 0.75, 'Closed nested content must have zero height.')
  assert.notEqual(closedNested.child.position, 'sticky', 'Closed nested header must not be sticky.')
  assert.equal(closedNested.activeId, 'child-toggle', 'Focus must remain on the nested header after the DOM click.')

  assert.deepEqual(consoleErrors, [], 'Fixture renderer reported console errors.')

  return {
    ok: true,
    run: RUN,
    electron: process.versions.electron,
    platform: `${process.platform}-${process.arch}`,
    fixture: {
      component: path.relative(ROOT, COMPONENT),
      styles: path.relative(ROOT, STYLES),
      isolatedProfile: true,
      window: { visible: false, focused: false, focusable: false, offscreen: true },
      nestedLevels: 2,
      viewport: {
        width: round(initial.viewport.width),
        height: round(initial.viewport.height),
        scrollHeight: round(initial.viewport.scrollHeight)
      }
    },
    transitions: {
      offscreenCompositor: true,
      forcedFinishCount: transitionLog.filter((entry) => entry.forcedFinishAttempted > 0).length,
      disabledFallback: transitionFallbackDisabled,
      drawers: transitionLog
    },
    checks: {
      openedParentAndChildPinned: [downRecord, downTwoRecord, upRecord],
      releasedPastParentDrawer: {
        scrollTop: round(released.viewport.scrollTop),
        parentBottomOffset: round(released.parent.bottom - released.viewport.top),
        childBottomOffset: round(released.child.bottom - released.viewport.top)
      },
      closedDrawerDoesNotStick: {
        parentPosition: closedScrolled.parent.position,
        closedHeaderBottomOffset: round(closedScrolled.parent.bottom - closedScrolled.viewport.top),
        contentInert: closedAtTop.parentReveal.inert,
        contentAriaHidden: closedAtTop.parentReveal.ariaHidden,
        contentHeight: round(closedAtTop.parentReveal.height)
      },
      toggleControls: {
        parentTagName,
        parentFocusable: focused === 'parent-toggle',
        childFocusable: childFocused === 'child-toggle',
        parentType: schema.parentType,
        childType: schema.childType,
        parentControls: schema.parentControls,
        childControls: schema.childControls,
        parentControlExists: schema.parentControlExists,
        childControlExists: schema.childControlExists,
        parentTabIndex: schema.parentTabIndex,
        childTabIndex: schema.childTabIndex,
        parentExpandedWhenClosed: schema.parentExpanded,
        childExpandedBeforeClose: schema.childExpanded,
        parentReopenedByDomClick: reopened.parentOpen,
        parentExpandedAfterReopen: reopened.parentExpanded,
        nestedClosedByDomClick: !closedNested.childOpen,
        nestedExpandedAfterClose: closedNested.childExpanded,
        nestedPositionAfterClose: closedNested.child.position,
        focusRetainedOnNestedToggle: closedNested.activeId === 'child-toggle'
      },
      consoleErrors
    },
    elapsedMs: Date.now() - startedAt
  }
}

function buildFixture(bundlePath) {
  let ts
  try {
    ts = require('typescript')
  } catch {
    throw new Error('The local TypeScript package is required to transpile the real Collapse fixture.')
  }

  // The generated entry imports the real component over a tiny in-page CommonJS
  // shim. No dev server, bundler, preload or launcher process is involved.
  const appSource = `
    import { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import Collapse from './Collapse'

    function DrawerHeader({ id, label, description, open, onToggle }) {
      return (
        <div className="settings-row" data-header={id}>
          <div className="settings-main">
            <div className="settings-name">{label}</div>
            <div className="settings-desc">{description}</div>
          </div>
          <div className="settings-action">
            <button
              id={id + '-toggle'}
              type="button"
              className={'btn sm ghost module-caret' + (open ? ' open' : '')}
              aria-expanded={open}
              aria-controls={id + '-content'}
              onClick={onToggle}
            >
              {open ? '收起' : '展开'}
            </button>
          </div>
        </div>
      )
    }

    function FillRows({ name, count }) {
      return (
        <>
          {Array.from({ length: count }, (_, index) => (
            <div className="settings-row" key={name + index}>
              <div className="settings-main">
                <div className="settings-name">{name} {index + 1}</div>
                <div className="settings-desc">Synthetic layout row for the disposable drawer fixture.</div>
              </div>
              <div className="settings-action"><span className="fixture-mark">—</span></div>
            </div>
          ))}
        </>
      )
    }

    function App() {
      const [parentOpen, setParentOpen] = useState(true)
      const [childOpen, setChildOpen] = useState(true)
      return (
        <div className="page" id="settings-scroll">
          <div className="page-header">
            <div>
              <h1 className="page-title">设置抽屉验证</h1>
              <p className="page-subtitle">Disposable synthetic settings fixture · no user data</p>
            </div>
          </div>
          <div className="page-body">
            <div className="settings" data-fixture="intro">
              <div className="settings-group-title">前置填充行</div>
              <FillRows name="前置填充行" count={4} />
            </div>
            <div className="settings" id="outer-panel">
              <div className="settings-group-title">父级设置面板</div>
              <Collapse
                open={parentOpen}
                header={
                  <DrawerHeader
                    id="parent"
                    label="父级抽屉"
                    description="父级 header 在打开时吸附，关闭时留在文档流。"
                    open={parentOpen}
                    onToggle={() => setParentOpen((value) => !value)}
                  />
                }
              >
                <div id="parent-content" data-content="parent">
                  <FillRows name="父级填充行" count={4} />
                  <div className="settings-group-title">子级设置面板</div>
                  <Collapse
                    open={childOpen}
                    header={
                      <DrawerHeader
                        id="child"
                        label="子级抽屉"
                        description="子级 header 应停在父级 header 正下方。"
                        open={childOpen}
                        onToggle={() => setChildOpen((value) => !value)}
                      />
                    }
                  >
                    <div id="child-content" data-content="child">
                      <FillRows name="子级填充行" count={10} />
                    </div>
                  </Collapse>
                  <FillRows name="父级尾部填充行" count={7} />
                </div>
              </Collapse>
              <FillRows name="父级后置填充行" count={3} />
            </div>
            <div className="fixture-tail" aria-hidden="true"></div>
          </div>
        </div>
      )
    }

    createRoot(document.getElementById('root')).render(<App />)
  `

  const componentSource = fs.readFileSync(COMPONENT, 'utf8')
  const collapseCode = transpileTsx(ts, componentSource, COMPONENT)
  const appCode = transpileTsx(ts, appSource, path.join(ROOT, 'settings-drawers-fixture.tsx'))
  const runtime = fixtureRuntime(collapseCode, appCode)
  // Parse before handing the file to Chromium so a transpile error is reported
  // as a verifier failure with the right stage instead of a blank page.
  new Function(runtime)
  fs.writeFileSync(bundlePath, runtime, 'utf8')
}

function transpileTsx(ts, source, fileName) {
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: false,
      allowSyntheticDefaultImports: true,
      newLine: ts.NewLineKind.LineFeed
    }
  })
  const errors = (result.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  )
  if (errors.length > 0) {
    const messages = errors
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      .join('\n')
    throw new Error(`Could not transpile ${fileName}: ${messages}`)
  }
  return result.outputText
}

function fixtureRuntime(collapseCode, appCode) {
  return `(() => {
  'use strict'
  const React = window.React
  const ReactDOM = window.ReactDOM
  if (!React || !ReactDOM) throw new Error('React UMD globals were not loaded.')
  if (typeof ReactDOM.createRoot !== 'function') throw new Error('ReactDOM.createRoot is unavailable.')
  // React's classic createElement takes children as extra arguments, while the
  // automatic JSX runtime passes a separate key. Keep key inside props so the
  // children already held by props are never replaced by the key argument.
  const jsx = (type, props, key) =>
    key === undefined ? React.createElement(type, props) : React.createElement(type, { ...props, key })
  const shared = {
    'react': React,
    'react/jsx-runtime': { Fragment: React.Fragment, jsx, jsxs: jsx, jsxDEV: jsx },
    'react-dom/client': { createRoot: ReactDOM.createRoot }
  }
  const collapseModule = { exports: {} }
  const requireForFixture = (specifier) => {
    if (specifier === './Collapse') return collapseModule.exports
    if (!Object.prototype.hasOwnProperty.call(shared, specifier)) {
      throw new Error('Unexpected fixture import: ' + specifier)
    }
    return shared[specifier]
  }
  ;(function (require, module, exports) {
${collapseCode}
  })(requireForFixture, collapseModule, collapseModule.exports)
  const appModule = { exports: {} }
  ;(function (require, module, exports) {
${appCode}
  })(requireForFixture, appModule, appModule.exports)
})()`
}

function htmlAttribute(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function fixtureHtml(bundlePath) {
  const stylesheet = htmlAttribute(pathToFileURL(STYLES).href)
  const react = htmlAttribute(pathToFileURL(REACT_UMD).href)
  const reactDom = htmlAttribute(pathToFileURL(REACT_DOM_UMD).href)
  const script = htmlAttribute(pathToFileURL(bundlePath).href)
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Settings drawer verification fixture</title>
  <link rel="stylesheet" href="${stylesheet}">
  <style>
    :root {
      --fg: #eef2f7;
      --fg-2: #cfd7e2;
      --fg-3: #9ea9b8;
      --line: rgba(255, 255, 255, 0.14);
      --line-strong: rgba(255, 255, 255, 0.24);
      --glass: rgba(20, 24, 32, 0.82);
      --glass-2: rgba(20, 24, 32, 0.94);
      --glass-hover: rgba(255, 255, 255, 0.09);
      --glass-backdrop: blur(10px);
      --glass-sheen: linear-gradient(180deg, rgba(255,255,255,.06), transparent);
      --scrim-rgb: 0, 0, 0;
      --brand: #4c8dff;
      --ease: cubic-bezier(.2, .7, .2, 1);
    }
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #0b0e13; }
    body { padding: 24px; box-sizing: border-box; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; color: var(--fg); }
    #fixture {
      position: relative;
      width: 840px;
      height: 460px;
      overflow: hidden;
      border: 1px solid #2b323e;
      border-radius: 14px;
      background: radial-gradient(120% 120% at 10% 0%, #1a2230 0%, #0f131b 65%);
    }
    .fixture-mark { color: var(--fg-3); font-size: 12px; }
    .fixture-tail { height: 900px; }
  </style>
</head>
<body>
  <div id="fixture"><div id="root"></div></div>
  <script src="${react}"></script>
  <script src="${reactDom}"></script>
  <script src="${script}"></script>
</body>
</html>`
}

function recordConsoleError(message) {
  const line = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 320)
  // The real stylesheet contains app-only asset URLs; their absence in this
  // disposable page is not a Collapse failure.
  if (/Failed to load resource|ERR_FILE_NOT_FOUND|ERR_ABORTED/i.test(line)) return
  if (line && consoleErrors.length < 20) consoleErrors.push(line)
}

function finishSuccess(report) {
  if (finished) return
  finished = true
  if (hardTimeout) clearTimeout(hardTimeout)
  try {
    if (fixtureWindow && !fixtureWindow.isDestroyed()) {
      fixtureWindow.destroy()
    }
  } catch {
    // The report is more important than a best-effort teardown.
  }
  cleanProfile()
  writeFd(1, `${JSON.stringify(report, null, 2)}\n`)
  setTimeout(() => app.exit(0), 30)
}

async function finishFailure(error) {
  if (finished) return
  finished = true
  if (hardTimeout) clearTimeout(hardTimeout)

  let windowState = { present: false, destroyed: true }
  try {
    if (fixtureWindow) {
      windowState = fixtureWindow.isDestroyed()
        ? { present: true, destroyed: true }
        : {
            present: true,
            destroyed: false,
            visible: fixtureWindow.isVisible(),
            focused: fixtureWindow.isFocused()
          }
    }
  } catch (windowError) {
    windowState = {
      error: windowError instanceof Error ? windowError.message : String(windowError)
    }
  }
  let page = null
  try {
    if (fixtureWindow && !fixtureWindow.isDestroyed()) {
      page = await withDeadline(
        fixtureWindow.webContents.executeJavaScript(DRAWER_DIAGNOSTICS, false),
        DIAGNOSTICS_TIMEOUT_MS
      )
    }
  } catch (diagnosticError) {
    page = {
      error: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)
    }
  }

  try {
    if (fixtureWindow && !fixtureWindow.isDestroyed()) fixtureWindow.destroy()
  } catch {
    // Best-effort teardown.
  }
  cleanProfile()
  writeFailure(error, stage, {
    electron: process.versions.electron,
    stage,
    window: windowState,
    page
  })
  setTimeout(() => app.exit(1), 30)
}
