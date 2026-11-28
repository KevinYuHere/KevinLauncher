#!/usr/bin/env node
/**
 * Compact KEVIN HUD layout smoke for the real packaged HUD entry.
 *
 * This is a disposable Electron main process, not the launcher. It loads only
 * the built `renderer/hud.html` with the dedicated `preload/kevinHud.js`,
 * emulates the narrow frame channel in memory, and drives the real renderer.
 * It never starts the launcher, reads a user profile/game directory, samples
 * hardware, opens a network connection, requests elevation or injects a game.
 *
 * The fixture owns the native-host rectangle because the HUD service is not
 * loaded here. Where the effective height is content-driven, the first render's
 * own `--khud-content-min-height` token is used as the host height, so the
 * fixture follows the production sizing contract instead of duplicating it.
 * It also checks the independent background/foreground opacities, the zero
 * background glass no-ghost state, the sanitized gradient fill, a centered
 * launch identity with the status at the trailing edge, and the name/status
 * labels' opposing early title displacements (both with y = 0). Small aligned
 * cases cover a both-centered horizontal pair, right-description /
 * left-value vertical items, four horizontal mixed alignments (including the
 * reversed column orders), and the ordinary full-data memory cell used when
 * either alignment is customized.
 *
 * Usage:
 *   node scripts/verify-kevin-hud-layout.cjs --out <out-dir>
 *   node_modules/electron/dist/electron.exe scripts/verify-kevin-hud-layout.cjs --out <out-dir>
 *
 * The output directory is read-only. Set `KEVIN_HUD_LAYOUT_EVIDENCE=<file>` or
 * pass `--evidence <file>` to choose the JSON evidence path (a temp path is
 * used by default). Failures include bounded DOM/Web Animations diagnostics on
 * stderr and in that file, ready for the outer root script to collect.
 */
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const SCRIPT_PATH = __filename
const ROOT = path.resolve(__dirname, '..')
const PROFILE_PREFIX = 'kl-kevin-hud-layout-'
const CHILD_REPORT_ENV = 'KEVIN_HUD_LAYOUT_CHILD_REPORT'
const EVIDENCE_ENV = 'KEVIN_HUD_LAYOUT_EVIDENCE'
const HARD_TIMEOUT_MS = 45_000
const WIDTH = 448
const HEIGHT = 48
const MEMORY_VALUE = '9.7 / 31.3 GB · 31%'
const APP_NAME = 'KEVIN HUD Layout Smoke'

// The old verifier's bootstrap contract: Node re-executes this exact file with
// the repository's pinned Electron and receives the child's JSON via a temp
// file. No packaged launcher or game process is involved.
let electronApi = null
try {
  const loaded = require('electron')
  if (loaded && typeof loaded === 'object' && loaded.app && loaded.BrowserWindow) {
    electronApi = loaded
  }
} catch {
  // The conventional local install is resolved below.
}
if (!electronApi) {
  relaunchUnderElectron()
  // relaunchUnderElectron() never returns.
}

const { app, BrowserWindow, ipcMain } = electronApi

const BASE_CONFIG = {
  enabled: true,
  alwaysVisible: false,
  absorbLauncher: true,
  displaySeconds: 6,
  sampleSeconds: 1,
  direction: 'center',
  bounce: 0.275,
  ripple: 1,
  positionMode: 'preset',
  anchor: 'center',
  x: 50,
  y: 3,
  width: WIDTH,
  maxWidth: WIDTH,
  height: HEIGHT,
  radius: 24,
  borderWidth: 1,
  borderColor: '#A7AD48',
  backgroundMode: 'solid',
  material: 'blur',
  backgroundColor: '#312F30',
  backgroundOpacity: 1,
  foregroundOpacity: 1,
  gradient: {
    kind: 'linear',
    angle: 90,
    centerX: 50,
    centerY: 50,
    shape: 'ellipse',
    stops: [
      { color: '#1F1D1E', position: 0 },
      { color: '#302E2F', position: 100 }
    ]
  },
  textColor: '#FFFFFF',
  iconColor: null,
  textOffsetX: 0,
  textOffsetY: 0,
  iconOffsetX: 0,
  iconOffsetY: 0,
  fontScale: 1,
  itemGap: 8,
  contentPadding: 12,
  itemStyle: {
    orientation: 'horizontal',
    description: 'icon',
    gap: 5,
    minWidth: 0,
    descriptionAlign: 'left',
    valueAlign: 'right',
    descriptionSize: 8.5,
    valueSize: 14,
    descriptionBold: true,
    valueBold: true,
    descriptionColor: null,
    valueColor: null
  },
  itemStyles: {},
  monitor: 'primary',
  autoWidth: false,
  restoreLauncher: false,
  hotkey: null,
  metrics: ['memory']
}

const DEFAULT_ITEM_STYLE = { ...BASE_CONFIG.itemStyle }

let stage = 'bootstrap'
let finished = false
let startedAt = Date.now()
let hardTimer = null
let profileRoot = null
let profilePaths = null
let activeWindow = null
let activeWindowLabel = null
let rendererPath = null
let preloadPath = null
let artifacts = null
let channels = null
let latestFrame = null
let consoleMessages = []
let scenarioResults = []
let lastSnapshot = null
let outDirectory = null
let evidencePath = null

process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)
process.on('exit', cleanProfile)
app.on('quit', cleanProfile)
app.on('window-all-closed', () => {
  // The process ends after the report; this handler keeps it alive.
})

evidencePath = evidenceArgument()
try {
  const options = parseArguments()
  outDirectory = options.outDirectory
  const resolved = resolveArtifacts(outDirectory)
  outDirectory = resolved.base
  rendererPath = resolved.renderer
  preloadPath = resolved.preload
  prepareProfile()
  app.setName('kevin-hud-layout-smoke')
  app.setPath('userData', profilePaths.userData)
  app.setPath('sessionData', profilePaths.sessionData)
  app.setPath('crashDumps', profilePaths.crashDumps)
} catch (error) {
  fail(error)
}

if (!finished) {
  app.whenReady()
    .then(run)
    .then(finishSuccess)
    .catch(fail)
}

/* ------------------------------------------------------------------------- */
/* bootstrap and process lifecycle                                           */
/* ------------------------------------------------------------------------- */

function relaunchUnderElectron() {
  let executable = null
  try {
    const candidate = require('electron')
    if (typeof candidate === 'string') executable = candidate
  } catch {
    // Try the conventional local executable below.
  }
  if (!executable) {
    const binary = process.platform === 'win32' ? 'electron.exe' : 'electron'
    executable = path.join(ROOT, 'node_modules', 'electron', 'dist', binary)
  }
  if (!executable || !fs.existsSync(executable)) {
    writeJson(2, {
      ok: false,
      stage: 'electron bootstrap',
      error:
        'Electron executable not found. Run npm install first or invoke this script with the repository Electron.',
      script: SCRIPT_PATH
    })
    process.exit(1)
    return
  }

  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const reportFile = path.join(
    os.tmpdir(),
    `kl-kevin-hud-layout-boot-${process.pid}-${Date.now()}.json`
  )
  environment[CHILD_REPORT_ENV] = reportFile
  const child = spawnSync(
    executable,
    [SCRIPT_PATH, ...userArguments()],
    {
      stdio: 'inherit',
      env: environment,
      windowsHide: false
    }
  )
  let reportWritten = false
  try {
    reportWritten = fs.statSync(reportFile).size > 0
  } catch {
    // The child did not reach its report writer.
  }
  try {
    fs.unlinkSync(reportFile)
  } catch {
    // It was never created or was already removed.
  }
  if (child.error || !reportWritten) {
    const payload = {
      ok: false,
      stage: 'electron bootstrap',
      error: child.error
        ? `Could not start Electron: ${child.error.message}`
        : `Electron exited before the layout smoke wrote its report (exit code: ${
          child.status ?? 'none'
        }).`,
      electron: executable
    }
    const evidence = evidenceArgument()
    payload.evidence = evidence
    if (!writeEvidenceFile(evidence, payload)) payload.evidence = null
    writeJson(2, payload)
    process.exit(1)
  }
  process.exit(typeof child.status === 'number' ? child.status : 1)
}

/**
 * Electron may insert its own switches before the script path, and forwards the
 * script path in argv. Start after the real script entry so both the Node
 * bootstrap and a direct `electron.exe <script>` invocation parse identically.
 */
function userArguments() {
  const argv = process.argv.slice(1)
  const script = path.resolve(SCRIPT_PATH)
  const index = argv.findIndex((value) => {
    try {
      return path.resolve(value) === script
    } catch {
      return false
    }
  })
  return index >= 0 ? argv.slice(index + 1) : process.argv.slice(2)
}

function evidenceArgument() {
  const values = userArguments()
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--evidence' && index + 1 < values.length) {
      return path.resolve(values[index + 1])
    }
    if (value.startsWith('--evidence=') && value.slice('--evidence='.length)) {
      return path.resolve(value.slice('--evidence='.length))
    }
  }
  if (process.env[EVIDENCE_ENV]) return path.resolve(process.env[EVIDENCE_ENV])
  return path.join(os.tmpdir(), `kevin-hud-layout-evidence-${process.pid}.json`)
}

function parseArguments() {
  const values = userArguments()
  let outArgument = null
  let evidence = null
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--out' || value === '--evidence') {
      if (index + 1 >= values.length) {
        throw new Error(`Usage: node scripts/verify-kevin-hud-layout.cjs --out <out-dir> [--evidence <file>]`)
      }
      if (value === '--out') {
        if (outArgument !== null) throw new Error('Only one --out directory may be supplied.')
        outArgument = values[index + 1]
      } else {
        if (evidence !== null) throw new Error('Only one --evidence file may be supplied.')
        evidence = path.resolve(values[index + 1])
      }
      index += 1
      continue
    }
    if (value.startsWith('--out=')) {
      if (outArgument !== null || !value.slice('--out='.length)) {
        throw new Error('Only one non-empty --out directory may be supplied.')
      }
      outArgument = value.slice('--out='.length)
      continue
    }
    if (value.startsWith('--evidence=')) {
      if (evidence !== null || !value.slice('--evidence='.length)) {
        throw new Error('Only one non-empty --evidence file may be supplied.')
      }
      evidence = path.resolve(value.slice('--evidence='.length))
      continue
    }
    if (value.startsWith('-')) throw new Error(`Unknown argument: ${value}`)
    if (outArgument !== null) throw new Error(`Unexpected argument: ${value}`)
    outArgument = value
  }

  return {
    outDirectory: path.resolve(outArgument || path.join(ROOT, 'out')),
    evidence
  }
}

function resolveArtifacts(requestedOut) {
  if (!fs.existsSync(requestedOut) || !fs.statSync(requestedOut).isDirectory()) {
    throw new Error(`Built output directory not found: ${requestedOut}. Run npm run build first.`)
  }
  const checked = new Set()
  const candidates = [requestedOut, path.join(requestedOut, 'out')]
  const resourceRoots = [
    requestedOut,
    path.join(requestedOut, 'resources'),
    path.join(requestedOut, 'win-unpacked', 'resources')
  ]
  for (const root of resourceRoots) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue
    candidates.push(path.join(root, 'app', 'out'))
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('app-')) {
        candidates.push(path.join(root, entry.name, 'out'))
      }
    }
  }

  for (const candidate of candidates) {
    const base = path.resolve(candidate)
    if (checked.has(base)) continue
    checked.add(base)
    const renderer = path.join(base, 'renderer', 'hud.html')
    const preload = path.join(base, 'preload', 'kevinHud.js')
    if (fileNonEmpty(renderer) && fileNonEmpty(preload)) {
      return { base, renderer, preload }
    }
  }
  throw new Error(
    `KEVIN HUD entry not found under ${requestedOut}. Checked: ${[...checked]
      .map((candidate) => path.join(candidate, 'renderer', 'hud.html'))
      .join(', ')}. Run npm run build first.`
  )
}

function fileNonEmpty(file) {
  try {
    const stat = fs.statSync(file)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

function prepareProfile() {
  profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX))
  const parent = path.resolve(os.tmpdir())
  if (path.dirname(path.resolve(profileRoot)) !== parent) {
    throw new Error('Refusing to use a temporary profile outside the OS temp directory.')
  }
  profilePaths = {
    userData: path.join(profileRoot, 'user-data'),
    sessionData: path.join(profileRoot, 'session-data'),
    crashDumps: path.join(profileRoot, 'crashes')
  }
  for (const directory of Object.values(profilePaths)) {
    fs.mkdirSync(directory, { recursive: true })
  }
}

function cleanProfile() {
  if (!profileRoot) return
  const target = path.resolve(profileRoot)
  const parent = path.resolve(os.tmpdir())
  if (path.dirname(target) !== parent || !path.basename(target).startsWith(PROFILE_PREFIX)) {
    return
  }
  try {
    fs.rmSync(target, { recursive: true, force: true })
    profileRoot = null
  } catch {
    // Chromium may still own a cache handle while the process exits.
  }
}

function destroyActiveWindow() {
  const win = activeWindow
  activeWindow = null
  activeWindowLabel = null
  if (!win) return
  try {
    if (!win.isDestroyed()) win.destroy()
  } catch {
    // The process is exiting or the renderer already crashed.
  }
}

/* ------------------------------------------------------------------------- */
/* smoke scenarios                                                           */
/* ------------------------------------------------------------------------- */

async function run() {
  startedAt = Date.now()
  hardTimer = setTimeout(() => {
    fail(new Error(`KEVIN HUD layout smoke exceeded its ${HARD_TIMEOUT_MS / 1000}s budget.`))
  }, HARD_TIMEOUT_MS)

  stage = 'validate built HUD entry and preload'
  assert.ok(fileNonEmpty(rendererPath), `KEVIN HUD renderer missing: ${rendererPath}`)
  assert.ok(fileNonEmpty(preloadPath), `KEVIN HUD preload missing: ${preloadPath}`)
  artifacts = {
    outDirectory,
    renderer: path.relative(outDirectory, rendererPath),
    preload: path.relative(outDirectory, preloadPath)
  }
  channels = inspectChannels(fs.readFileSync(preloadPath, 'utf8'))
  if (channels.ready) {
    ipcMain.handle(channels.ready, () => latestFrame)
  }

  await verifyScenario('default memory plate', verifyDefaultPlate)
  await verifyScenario('independent layer opacity', verifyLayerIndependence)
  await verifyScenario('gradient background', verifyGradientBackground)
  await verifyScenario('centered launch identity', verifyLaunchIdentity)
  await verifyScenario('content height and reverse collapse', verifyHeightMotion)
  await verifyScenario('reveal origins', verifyRevealOrigins)
  await verifyScenario('stable value boxes', verifyValueWidths)
  await verifyScenario('centered horizontal item groups', verifyCenteredItemGroups)
  await verifyScenario('mixed vertical item alignment', verifyVerticalMixedAlignment)
  await verifyScenario('mixed horizontal item alignment', verifyHorizontalMixedAlignment)
  await verifyScenario('custom aligned memory data', verifyCustomMemoryAlignment)
  await verifyScenario('small max width overflow scroll', verifyOverflowScroll)

  return {
    ok: true,
    elapsedMs: Date.now() - startedAt,
    electron: process.versions.electron || null,
    isolatedProfile: Boolean(profileRoot),
    outDirectory,
    artifacts,
    ipc: { frameChannel: channels.frame, readyChannel: channels.ready },
    scenarios: scenarioResults,
    rendererConsole: consoleMessages
  }
}

async function verifyScenario(name, body) {
  stage = name
  const record = { name, ok: false }
  scenarioResults.push(record)
  const scenarioStarted = Date.now()
  try {
    await body(record)
    record.ok = true
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error)
    try {
      lastSnapshot = activeWindow ? await captureSnapshot(activeWindow) : null
    } catch (snapshotError) {
      lastSnapshot = {
        error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError)
      }
    }
    record.snapshot = lastSnapshot
    throw error
  } finally {
    record.elapsedMs = Date.now() - scenarioStarted
    destroyActiveWindow()
  }
}

async function verifyDefaultPlate(record) {
  const frame = makeFrame('monitor', { ...BASE_CONFIG }, { memory: MEMORY_VALUE })
  const ctx = await mountScenario({
    label: 'default',
    width: WIDTH,
    height: HEIGHT,
    frame
  })
  await until(
    ctx.execute,
    `!!document.querySelector('.kevin-hud-memory-readout')`,
    'memory readout'
  )
  await fontsReady(ctx.execute)
  await settleMotion(ctx.execute)

  const state = await ctx.execute(`(() => {
    const round = (value) => Math.round(value * 100) / 100
    const rect = (element) => {
      if (!element) return null
      const box = element.getBoundingClientRect()
      return {
        left: round(box.left),
        right: round(box.right),
        top: round(box.top),
        bottom: round(box.bottom),
        width: round(box.width),
        height: round(box.height),
        centerX: round(box.left + box.width / 2)
      }
    }
    const style = (selector) => {
      const element = document.querySelector(selector)
      return element ? getComputedStyle(element) : null
    }
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? ''
    const surface = document.querySelector('.kevin-hud-surface')
    const fill = document.querySelector('.kevin-hud-fill')
    const readout = document.querySelector('.kevin-hud-memory-readout')
    const left = document.querySelector('.kevin-hud-memory-readout__left')
    const center = document.querySelector('.kevin-hud-memory-readout__center')
    const right = document.querySelector('.kevin-hud-memory-readout__right')
    const percent = document.querySelector('.kevin-hud-memory-readout__percent')
    const arc = document.querySelector('.kevin-hud-memory-readout__arc')
    const used = document.querySelector('.kevin-hud-memory-readout__used')
    const totalValue = document.querySelector('.kevin-hud-memory-readout__total-value')
    const unit = document.querySelector('.kevin-hud-memory-readout__unit')
    const percentSign = document.querySelector('.kevin-hud-memory-readout__percent-sign')
    const surfaceStyle = style('.kevin-hud-surface')
    const fillStyle = style('.kevin-hud-fill')
    const backgroundStyle = style('.kevin-hud-background')
    const foregroundStyle = style('.kevin-hud-foreground')
    const rootElement = document.querySelector('.kevin-hud-root')
    const rootStyle = rootElement ? getComputedStyle(rootElement) : null
    const arcPseudo = arc ? getComputedStyle(arc, '::after') : null
    // The ring is painted by the arc's mask, not by a grey track element. Probe
    // the inherited 3.6 DIP ring token so the browser itself resolves it.
    let arcRingWidth = 0
    if (arc) {
      const probe = document.createElement('span')
      probe.style.cssText =
        'position:absolute;visibility:hidden;width:var(--_khmr-ring);height:1px'
      arc.appendChild(probe)
      arcRingWidth = probe.getBoundingClientRect().width
      probe.remove()
    }
    const surfaceRect = rect(surface)
    return {
      host: { width: window.innerWidth, height: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio,
      root: rootElement?.getAttribute('data-phase') ?? '',
      rootOpacity: rootStyle ? Number(rootStyle.opacity) : 0,
      surface: {
        rect: surfaceRect,
        offsetWidth: surface?.offsetWidth ?? 0,
        offsetHeight: surface?.offsetHeight ?? 0,
        borderRadius: surfaceStyle?.borderTopLeftRadius ?? '',
        backgroundColor: surfaceStyle?.backgroundColor ?? '',
        backgroundMode: surface?.getAttribute('data-background') ?? '',
        heightToken: surfaceStyle?.getPropertyValue('--khud-height').trim() ?? '',
        borderWidthToken: surfaceStyle?.getPropertyValue('--khud-border-width').trim() ?? '',
        backgroundOpacityToken:
          surfaceStyle?.getPropertyValue('--khud-background-opacity').trim() ?? '',
        foregroundOpacityToken:
          surfaceStyle?.getPropertyValue('--khud-foreground-opacity').trim() ?? ''
      },
      background: {
        opacity: backgroundStyle?.opacity ?? '',
        filter: backgroundStyle?.backdropFilter ?? '',
        borderRadius: backgroundStyle?.borderTopLeftRadius ?? ''
      },
      foreground: {
        opacity: foregroundStyle?.opacity ?? '',
        borderTopWidth: foregroundStyle?.borderTopWidth ?? '',
        borderTopColor: foregroundStyle?.borderTopColor ?? ''
      },
      fill: {
        color: fillStyle?.backgroundColor ?? '',
        opacity: fillStyle?.opacity ?? ''
      },
      readout: {
        present: !!readout,
        left: rect(left),
        center: rect(center),
        right: rect(right),
        percent: rect(percent),
        arc: rect(arc),
        leftText: left?.textContent?.trim() ?? '',
        centerText: center?.textContent?.trim() ?? '',
        rightText: right?.textContent?.trim() ?? '',
        percentText: text('.kevin-hud-memory-readout__percent'),
        usedText: text('.kevin-hud-memory-readout__used'),
        totalText: text('.kevin-hud-memory-readout__total-value'),
        unitText: text('.kevin-hud-memory-readout__unit'),
        usedWidth: used?.offsetWidth ?? 0,
        totalWidth: totalValue?.offsetWidth ?? 0,
        percentWidth: percent?.offsetWidth ?? 0,
        usedFont: used ? Number.parseFloat(getComputedStyle(used).fontSize) : 0,
        totalFont: totalValue ? Number.parseFloat(getComputedStyle(totalValue).fontSize) : 0,
        percentFont: percent ? Number.parseFloat(getComputedStyle(percent).fontSize) : 0,
        signFont: percentSign ? Number.parseFloat(getComputedStyle(percentSign).fontSize) : 0,
        textLeft:
          used && surfaceRect ? round(used.getBoundingClientRect().left - surfaceRect.left) : null,
        arcWidth: arc?.offsetWidth ?? 0,
        arcRingWidth,
        arcRightInset:
          arc && surfaceRect ? round(surfaceRect.right - arc.getBoundingClientRect().right) : null,
        groupGap:
          arc && percent && surfaceRect
            ? round(arc.getBoundingClientRect().left - percent.getBoundingClientRect().right)
            : null,
        arcKnown: arc?.getAttribute('data-known') ?? '',
        arcProgress: arc?.style.getPropertyValue('--kevin-hud-memory-progress') ?? '',
        arcPainted:
          (arcPseudo?.backgroundImage && arcPseudo.backgroundImage !== 'none') ||
          (arcPseudo?.maskImage && arcPseudo.maskImage !== 'none') ||
          !!arc?.querySelector('svg, canvas')
      }
    }
  })()`)

  assert.equal(state.host.width, WIDTH, 'The fixture viewport must be 448 CSS px wide.')
  assert.equal(state.host.height, HEIGHT, 'The fixture viewport must be 48 CSS px tall.')
  assert.ok(approximately(state.surface.offsetWidth, WIDTH, 0.75), 'The settled plate must be 448 px wide.')
  assert.ok(approximately(state.surface.offsetHeight, HEIGHT, 0.75), 'The settled plate must be 48 px tall.')
  assert.equal(state.surface.backgroundMode, 'solid', 'The default plate must use the solid background mode.')
  assert.ok(
    approximately(Number.parseFloat(state.surface.borderRadius), 24, 0.75),
    'The default plate must be the rounded 24 px bar.'
  )
  assert.ok(approximately(Number.parseFloat(state.fill.opacity), 1, 0.01), 'The fill layer must not fade the plate.')

  const rgba = parseColor(state.fill.color)
  assert.ok(rgba, `Could not parse the default fill colour: ${state.fill.color}`)
  assert.equal(rgba.alpha, 1, 'The default fill colour must be opaque.')
  assert.ok(
    Math.max(rgba.r, rgba.g, rgba.b) <= 80 && Math.max(rgba.r, rgba.g, rgba.b) - Math.min(rgba.r, rgba.g, rgba.b) <= 16,
    `The default fill must stay charcoal, received ${state.fill.color}.`
  )

  assert.equal(state.readout.present, true, 'The default memory-only HUD must render the memory readout.')
  assert.ok(state.readout.leftText.includes('9.7'), 'The left cluster must show the used amount.')
  assert.ok(state.readout.leftText.includes('31.3'), 'The left cluster must show the total amount.')
  assert.ok(state.readout.leftText.includes('GB'), 'The left cluster must show the unit.')
  assert.equal(state.readout.usedText, '9.7')
  assert.equal(state.readout.totalText, '31.3')
  assert.equal(state.readout.unitText, 'GB')
  assert.equal(state.readout.percentText, '31%', 'The right cluster must show the percentage.')
  assert.equal(state.readout.centerText, '', 'The readout centre must stay empty.')
  assert.ok(state.readout.arcKnown === 'true', 'The progress arc must be in its known state.')
  assert.ok(
    Number.parseFloat(state.readout.arcProgress) > 0,
    'The progress arc must carry the non-zero percentage.'
  )
  assert.ok(state.readout.arc.width >= 8, 'The progress arc must have a real visible box.')
  assert.equal(state.readout.arcPainted, true, 'The progress arc must actually paint through CSS or SVG.')

  // Measured reference parameters of the 448 x 48 memory composition. These are
  // deliberately independent from the CSS authoring units: the browser must
  // resolve the proportional tokens to the intended DIP sizes.
  assert.ok(
    approximately(state.rootOpacity, 1, 0.01),
    `There must be no global HUD opacity; received ${state.rootOpacity}.`
  )
  assert.ok(
    approximately(Number.parseFloat(state.background.opacity), 1, 0.01),
    `The default background group must stay opaque, received ${state.background.opacity}.`
  )
  assert.ok(
    approximately(Number.parseFloat(state.foreground.opacity), 1, 0.01),
    `The default foreground group must stay opaque, received ${state.foreground.opacity}.`
  )
  assert.equal(state.surface.backgroundOpacityToken, '1.000')
  assert.equal(state.surface.foregroundOpacityToken, '1.000')
  // Windows display scaling can round the CSS edge to the device pixel grid:
  // at 150% DPR Chromium reports a 1 px hairline as 0.666667 CSS px. The author
  // token must stay exactly 1 px while the painted edge stays within one
  // physical pixel of it, so the plate keeps its single-device-pixel edge
  // without depending on the host display scale.
  assert.equal(
    state.surface.borderWidthToken,
    '1px',
    'The settled surface must author the shared 1 px edge token.'
  )
  const borderTopWidth = Number.parseFloat(state.foreground.borderTopWidth)
  assert.ok(
    borderTopWidth > 0,
    `The reference plate must paint a visible edge, received ${state.foreground.borderTopWidth}.`
  )
  assert.ok(
    state.devicePixelRatio > 0 &&
      Math.abs(borderTopWidth - 1) < 1 / state.devicePixelRatio,
    `The reference edge must stay within one physical pixel of 1 css px, received ${state.foreground.borderTopWidth} at DPR ${state.devicePixelRatio}.`
  )
  const border = parseColor(state.foreground.borderTopColor)
  assert.ok(
    border &&
      Math.abs(border.r - 167) <= 2 &&
      Math.abs(border.g - 173) <= 2 &&
      Math.abs(border.b - 72) <= 2,
    `The reference edge must resolve to sampled #A7AD48, received ${state.foreground.borderTopColor}.`
  )
  assert.ok(
    approximately(state.readout.usedFont, 20.8, 0.45),
    `The used amount must resolve to 20.8 DIP, received ${state.readout.usedFont}.`
  )
  assert.ok(
    approximately(state.readout.totalFont, 11.2, 0.35),
    `The total amount must resolve to 11.2 DIP, received ${state.readout.totalFont}.`
  )
  assert.ok(
    approximately(state.readout.percentFont, 17.6, 0.45),
    `The main percentage must resolve to 17.6 DIP, received ${state.readout.percentFont}.`
  )
  assert.ok(
    approximately(state.readout.signFont, 10.4, 0.35),
    `The percent sign must resolve to 10.4 DIP, received ${state.readout.signFont}.`
  )
  assert.ok(
    approximately(state.readout.textLeft, 51.2, 1.5),
    `The left value text must start around 51.2 DIP, received ${state.readout.textLeft}.`
  )
  assert.ok(
    approximately(state.readout.arcWidth, 36.8, 0.6),
    `The progress badge must resolve to 36.8 DIP, received ${state.readout.arcWidth}.`
  )
  assert.ok(
    approximately(state.readout.arcRingWidth, 3.6, 0.4),
    `The progress ring must resolve to about 3.6 DIP, received ${state.readout.arcRingWidth}.`
  )
  assert.ok(
    approximately(state.readout.arcRightInset - borderTopWidth, 4, 1),
    `The progress badge must sit about 4 DIP inside the visible edge, received ${state.readout.arcRightInset} with a ${borderTopWidth} DIP border.`
  )
  assert.ok(
    approximately(state.readout.groupGap, 11.2, 1),
    `The percentage and badge groups must be about 11.2 DIP apart, received ${state.readout.groupGap}.`
  )

  const surface = state.surface.rect
  assert.ok(state.readout.left.centerX < surface.centerX, 'The used/total cluster must stay on the left.')
  assert.ok(state.readout.right.centerX > surface.centerX, 'The percentage/arc cluster must stay on the right.')
  assert.ok(
    state.readout.right.left - state.readout.left.right >= 8,
    'The readout must keep a real empty gap between its left and right clusters.'
  )
  assert.ok(
    !state.readout.center ||
      (state.readout.center.left >= state.readout.left.right - 0.75 &&
        state.readout.center.right <= state.readout.right.left + 0.75),
    'The readout centre must not overlap either cluster.'
  )
  assert.ok(
    state.readout.arc.left >= state.readout.percent.right - 0.75,
    'The arc must sit after the percentage at the trailing edge.'
  )

  record.defaultPlate = state

  // Digit widths for the used/total amounts must not move the same sub-item
  // boxes when the sample grows from 9.7 / 31.3 GB to 10.0 / 128.0 GB. The
  // percent/arc stay in the trailing cluster; the network-rate scenario below
  // covers the value and unit boxes.
  assert.ok(state.readout.usedWidth > 0 && state.readout.totalWidth > 0)
  ctx.send(
    makeFrame('monitor', { ...BASE_CONFIG }, { memory: '10.0 / 128.0 GB · 9%' })
  )
  await until(
    ctx.execute,
    `document.querySelector('.kevin-hud-memory-readout__percent')?.textContent?.trim() === '9%'`,
    'updated memory sample'
  )
  await nextFrames(ctx.execute)
  const updated = await ctx.execute(`(() => {
    const used = document.querySelector('.kevin-hud-memory-readout__used')
    const total = document.querySelector('.kevin-hud-memory-readout__total-value')
    const percent = document.querySelector('.kevin-hud-memory-readout__percent')
    return {
      used: used?.offsetWidth ?? 0,
      total: total?.offsetWidth ?? 0,
      percent: percent?.offsetWidth ?? 0
    }
  })()`)
  assert.ok(
    Math.abs(updated.used - state.readout.usedWidth) <= 1,
    `The used-number box moved: ${state.readout.usedWidth}px -> ${updated.used}px.`
  )
  assert.ok(
    Math.abs(updated.total - state.readout.totalWidth) <= 1,
    `The total-number box moved: ${state.readout.totalWidth}px -> ${updated.total}px.`
  )
  record.memoryWidthUpdate = {
    before: {
      used: state.readout.usedWidth,
      total: state.readout.totalWidth,
      percent: state.readout.percentWidth
    },
    after: updated
  }
}

async function verifyLayerIndependence(record) {
  const config = {
    ...BASE_CONFIG,
    backgroundMode: 'custom',
    material: 'liquid',
    backgroundOpacity: 0.35,
    foregroundOpacity: 1
  }
  const values = { memory: MEMORY_VALUE }
  const ctx = await mountScenario({
    label: 'layers',
    width: WIDTH,
    height: HEIGHT,
    frame: makeFrame('monitor', config, values)
  })
  const readLayers = () => ctx.execute(`(() => {
    const root = document.querySelector('.kevin-hud-root')
    const surface = document.querySelector('.kevin-hud-surface')
    const background = document.querySelector('.kevin-hud-background')
    const foreground = document.querySelector('.kevin-hud-foreground')
    const material = document.querySelector('.kevin-hud-material')
    if (!root || !surface || !background || !foreground || !material) return null
    const backgroundStyle = getComputedStyle(background)
    const foregroundStyle = getComputedStyle(foreground)
    const surfaceStyle = getComputedStyle(surface)
    return {
      backgroundOpacity: Number.parseFloat(backgroundStyle.opacity),
      foregroundOpacity: Number.parseFloat(foregroundStyle.opacity),
      backgroundFilter:
        backgroundStyle.backdropFilter || backgroundStyle.webkitBackdropFilter || '',
      materialImage: getComputedStyle(material).backgroundImage,
      materialOpacity: Number.parseFloat(getComputedStyle(material).opacity),
      rootOpacity: Number.parseFloat(getComputedStyle(root).opacity),
      mode: surface.getAttribute('data-background') || '',
      backgroundToken: surfaceStyle.getPropertyValue('--khud-background-opacity').trim(),
      foregroundToken: surfaceStyle.getPropertyValue('--khud-foreground-opacity').trim(),
      backdropToken: surfaceStyle.getPropertyValue('--khud-backdrop').trim()
    }
  })()`)
  await until(
    ctx.execute,
    `!!document.querySelector('.kevin-hud-background') && !!document.querySelector('.kevin-hud-foreground')`,
    'independent HUD layers'
  )
  await fontsReady(ctx.execute)
  await settleMotion(ctx.execute)

  const first = await readLayers()
  assert.ok(first, 'The default layer fixture DOM must be present.')
  assert.ok(approximately(first.backgroundOpacity, 0.35, 0.01), `Background opacity: ${first.backgroundOpacity}.`)
  assert.ok(approximately(first.foregroundOpacity, 1, 0.01), `Foreground opacity: ${first.foregroundOpacity}.`)
  assert.ok(first.backgroundFilter.includes('blur'), `Custom glass backdrop missing: ${first.backgroundFilter}.`)
  assert.ok(first.materialImage && first.materialImage !== 'none', 'The custom glass highlight must paint.')
  assert.ok(approximately(first.materialOpacity, 0.7, 0.01), `Material opacity: ${first.materialOpacity}.`)
  assert.ok(approximately(first.rootOpacity, 1, 0.01), 'The HUD root must not carry a global opacity.')

  ctx.send(
    makeFrame('monitor', { ...config, backgroundOpacity: 1, foregroundOpacity: 0.25 }, values)
  )
  await until(
    ctx.execute,
    `Math.abs(Number.parseFloat(getComputedStyle(document.querySelector('.kevin-hud-foreground')).opacity) - 0.25) < 0.01`,
    'foreground-only fade'
  )
  const second = await readLayers()
  assert.ok(second, 'The foreground-fade fixture DOM must be present.')
  assert.ok(approximately(second.backgroundOpacity, 1, 0.01), `Background must ignore the foreground fade: ${second.backgroundOpacity}.`)
  assert.ok(approximately(second.foregroundOpacity, 0.25, 0.01), `Foreground opacity: ${second.foregroundOpacity}.`)
  assert.ok(second.backgroundFilter.includes('blur'), `Background glass disappeared at foreground 0.25: ${second.backgroundFilter}.`)

  ctx.send(
    makeFrame('monitor', { ...config, backgroundOpacity: 0.5, foregroundOpacity: 0 }, values)
  )
  await until(
    ctx.execute,
    `Number.parseFloat(getComputedStyle(document.querySelector('.kevin-hud-foreground')).opacity) < 0.01`,
    'zero foreground'
  )
  const third = await readLayers()
  assert.ok(third, 'The zero-foreground fixture DOM must be present.')
  assert.ok(approximately(third.backgroundOpacity, 0.5, 0.01), `A zero foreground must keep the background: ${third.backgroundOpacity}.`)
  assert.ok(third.foregroundOpacity < 0.01, `Foreground opacity: ${third.foregroundOpacity}.`)
  assert.ok(third.backgroundFilter.includes('blur'), `Background glass disappeared at foreground 0: ${third.backgroundFilter}.`)

  // App glass at zero background: the complete background group, including
  // its backdrop filter, must be gone with no residual filtered ghost.
  ctx.send(
    makeFrame(
      'monitor',
      { ...config, backgroundMode: 'app', backgroundOpacity: 0, foregroundOpacity: 0 },
      values
    )
  )
  await until(
    ctx.execute,
    `(() => {
      const background = document.querySelector('.kevin-hud-background')
      const foreground = document.querySelector('.kevin-hud-foreground')
      return background && foreground &&
        Number.parseFloat(getComputedStyle(background).opacity) < 0.01 &&
        Number.parseFloat(getComputedStyle(foreground).opacity) < 0.01
    })()`,
    'zero background and foreground'
  )
  const zero = await readLayers()
  assert.ok(zero, 'The zero-layer fixture DOM must be present.')
  assert.equal(zero.mode, 'app')
  assert.ok(zero.backgroundOpacity < 0.01, `Zero background opacity: ${zero.backgroundOpacity}.`)
  assert.ok(zero.foregroundOpacity < 0.01, `Zero foreground opacity: ${zero.foregroundOpacity}.`)
  assert.ok(
    zero.backgroundFilter === 'none' || zero.backgroundFilter === '',
    `Zero background must drop the glass backdrop, received ${zero.backgroundFilter}.`
  )
  assert.equal(zero.backdropToken, 'none', `Zero background backdrop token: ${zero.backdropToken}.`)

  record.layerIndependence = { first, second, third, zero }
}

async function verifyGradientBackground(record) {
  const gradient = {
    kind: 'linear',
    angle: 135,
    centerX: 50,
    centerY: 50,
    shape: 'ellipse',
    stops: [
      { color: '#112233', position: 0 },
      { color: '#AABBCC', position: 55 },
      { color: '#445566', position: 100 }
    ]
  }
  const config = {
    ...BASE_CONFIG,
    backgroundMode: 'gradient',
    gradient,
    backgroundOpacity: 0.45,
    foregroundOpacity: 1
  }
  const ctx = await mountScenario({
    label: 'gradient',
    width: WIDTH,
    height: HEIGHT,
    frame: makeFrame('monitor', config, { memory: MEMORY_VALUE })
  })
  await until(
    ctx.execute,
    `document.querySelector('.kevin-hud-surface')?.getAttribute('data-background') === 'gradient'`,
    'gradient background mode'
  )
  await fontsReady(ctx.execute)
  await settleMotion(ctx.execute)
  const state = await ctx.execute(`(() => {
    const surface = document.querySelector('.kevin-hud-surface')
    const fill = document.querySelector('.kevin-hud-fill')
    const background = document.querySelector('.kevin-hud-background')
    if (!surface || !fill || !background) return null
    const style = getComputedStyle(fill)
    return {
      mode: surface.getAttribute('data-background'),
      kind: surface.getAttribute('data-gradient-kind'),
      angle: surface.getAttribute('data-gradient-angle'),
      fillImage: style.backgroundImage,
      backgroundOpacity: Number.parseFloat(getComputedStyle(background).opacity),
      gradientToken: getComputedStyle(surface).getPropertyValue('--khud-gradient').trim(),
      backdropToken: getComputedStyle(surface).getPropertyValue('--khud-backdrop').trim()
    }
  })()`)
  assert.ok(state, 'The gradient fixture DOM must be present.')
  assert.equal(state.mode, 'gradient')
  assert.equal(state.kind, 'linear')
  assert.equal(state.angle, '135')
  assert.ok(state.fillImage.includes('linear-gradient'), `Gradient fill missing: ${state.fillImage}.`)
  for (const color of ['rgb(17, 34, 51)', 'rgb(170, 187, 204)', 'rgb(68, 85, 102)']) {
    assert.ok(state.fillImage.includes(color), `Gradient fill missed ${color}: ${state.fillImage}.`)
  }
  assert.ok(
    state.gradientToken.includes('linear-gradient(135deg') &&
      state.gradientToken.includes('#AABBCC 55%'),
    `Sanitized gradient token: ${state.gradientToken}.`
  )
  assert.equal(state.backdropToken, 'none')
  assert.ok(approximately(state.backgroundOpacity, 0.45, 0.01), `Gradient background opacity: ${state.backgroundOpacity}.`)
  record.gradient = state
}

async function verifyLaunchIdentity(record) {
  const config = {
    ...BASE_CONFIG,
    positionMode: 'preset',
    anchor: 'center',
    width: WIDTH,
    maxWidth: WIDTH,
    height: HEIGHT,
    metrics: ['memory'],
    backgroundOpacity: 1,
    foregroundOpacity: 1
  }
  const ctx = await mountScenario({
    label: 'launch-identity',
    width: WIDTH,
    height: HEIGHT,
    frame: makeFrame('announce', config, { memory: MEMORY_VALUE })
  })
  await until(
    ctx.execute,
    `!!document.querySelector('.kevin-hud-launch-sign') && !!document.querySelector('.kevin-hud-launching')`,
    'launch identity'
  )
  await fontsReady(ctx.execute)
  const reducedMotion = await ctx.execute(
    'matchMedia("(prefers-reduced-motion: reduce)").matches'
  )
  let titleTrajectory = null
  if (!reducedMotion) {
    // Compare the early and settled CSS offsets of the two title labels before
    // finishing the entrance. The name must start right of its landing point
    // and the status left of its own; both stay on the same y. Reading the
    // actual keyframe poses is stronger than judging only the final frame.
    titleTrajectory = await readTitleTrajectory(ctx.execute)
    record.titleTrajectory = { reducedMotion, ...titleTrajectory }
    assert.equal(
      titleTrajectory.ok,
      true,
      `Could not inspect the title trajectory: ${JSON.stringify(titleTrajectory)}`
    )
    assert.ok(
      titleTrajectory.early.name.x > 0.5,
      `The centred app name must start right of its settled position, received ${titleTrajectory.early.name.x}px.`
    )
    assert.ok(
      titleTrajectory.early.status.x < -0.5,
      `The centred launch status must start left of its settled position, received ${titleTrajectory.early.status.x}px.`
    )
    assert.ok(
      Math.abs(titleTrajectory.early.name.y) <= 0.5 &&
        Math.abs(titleTrajectory.early.status.y) <= 0.5,
      `The default title trajectory must not pitch vertically (name ${titleTrajectory.early.name.y}px, status ${titleTrajectory.early.status.y}px).`
    )
    for (const [label, pose] of [
      ['name', titleTrajectory.settled.name],
      ['status', titleTrajectory.settled.status]
    ]) {
      assert.ok(
        Math.abs(pose.x) <= 0.5 && Math.abs(pose.y) <= 0.5,
        `The settled ${label} must return to its landing point, received (${pose.x}px, ${pose.y}px).`
      )
    }
  }
  await settleMotion(ctx.execute)
  const state = await ctx.execute(`(() => {
    const round = (value) => Math.round(value * 100) / 100
    const surface = document.querySelector('.kevin-hud-surface')
    const root = document.querySelector('.kevin-hud-root')
    const sign = document.querySelector('.kevin-hud-launch-sign')
    const icon = document.querySelector('.kevin-hud-identity .kevin-hud-icon-frame')
    const name = document.querySelector('.kevin-hud-app-name')
    const launching = document.querySelector('.kevin-hud-launching')
    if (!surface || !root || !sign || !icon || !name || !launching) return null
    const surfaceRect = surface.getBoundingClientRect()
    const rect = (element) => {
      const box = element.getBoundingClientRect()
      return {
        left: round(box.left),
        right: round(box.right),
        top: round(box.top),
        bottom: round(box.bottom),
        width: round(box.width),
        height: round(box.height)
      }
    }
    const nodes = [...surface.querySelectorAll(
      '.kevin-hud-launch-sign, .kevin-hud-identity .kevin-hud-icon-frame, .kevin-hud-app-name, .kevin-hud-launching'
    )]
    const label = (element) => {
      if (element.classList.contains('kevin-hud-launch-sign')) return 'sign'
      if (element.classList.contains('kevin-hud-icon-frame')) return 'icon'
      if (element.classList.contains('kevin-hud-app-name')) return 'name'
      if (element.classList.contains('kevin-hud-launching')) return 'launching'
      return 'unknown'
    }
    return {
      anchor: root.getAttribute('data-anchor'),
      order: nodes.map(label),
      surface: {
        left: round(surfaceRect.left),
        right: round(surfaceRect.right),
        centerX: round(surfaceRect.left + surfaceRect.width / 2)
      },
      sign: rect(sign),
      icon: rect(icon),
      name: rect(name),
      launching: rect(launching),
      nameText: name.textContent?.trim() ?? '',
      statusText: launching.textContent?.trim() ?? ''
    }
  })()`)
  assert.ok(state, 'The launch identity fixture DOM must be present.')
  assert.equal(state.anchor, 'center')
  assert.deepEqual(state.order, ['sign', 'icon', 'name', 'launching'])
  assert.ok(approximately(state.surface.centerX, WIDTH / 2, 0.75), `Centered surface x: ${state.surface.centerX}.`)
  assert.ok(state.sign.left < state.icon.left, 'The launch marker must stay left of the icon.')
  assert.ok(state.icon.right <= state.name.left + 1, 'The app icon must stay left of the app name.')
  assert.ok(state.name.right <= state.launching.left + 1, 'The app name must stay left of the launching status.')
  assert.ok(state.launching.left > state.surface.centerX, 'The launching status must sit on the right side.')
  assert.ok(
    approximately(state.launching.right, state.surface.right - 12, 2),
    `The launching status must end at the 12 DIP content inset, received ${state.launching.right}.`
  )
  assert.equal(state.nameText, APP_NAME)
  record.launchIdentity = state
  record.titleTrajectory = titleTrajectory
    ? { reducedMotion, ...titleTrajectory }
    : { reducedMotion, skipped: true }
}

async function verifyHeightMotion(record) {
  const config = {
    ...BASE_CONFIG,
    positionMode: 'custom',
    anchor: 'center',
    x: 50,
    y: 50,
    width: WIDTH,
    maxWidth: WIDTH,
    autoWidth: false,
    height: 24,
    radius: 24,
    contentPadding: 4,
    fontScale: 1.25,
    metrics: ['fps'],
    itemStyle: {
      ...DEFAULT_ITEM_STYLE,
      orientation: 'vertical',
      description: 'text',
      gap: 24,
      descriptionSize: 24,
      valueSize: 32
    }
  }
  const values = { fps: '171 FPS' }
  const frame = makeFrame('monitor', config, values)

  // First render in a generous host only to read the renderer's own settled
  // content-height floor. The actual motion fixture then uses that exact height.
  const probe = await mountScenario({
    label: 'height-probe',
    width: WIDTH,
    height: 240,
    frame
  })
  let contentMinHeight
  try {
    await until(
      probe.execute,
      `(() => {
        const surface = document.querySelector('.kevin-hud-surface')
        if (!surface) return false
        const value = Number.parseFloat(getComputedStyle(surface).getPropertyValue('--khud-content-min-height'))
        return Number.isFinite(value) && value > 24
      })()`,
      'content-driven HUD height'
    )
    contentMinHeight = await probe.execute(
      `Number.parseFloat(getComputedStyle(document.querySelector('.kevin-hud-surface')).getPropertyValue('--khud-content-min-height'))`
    )
  } finally {
    destroyActiveWindow()
  }
  assert.ok(
    Number.isFinite(contentMinHeight) && contentMinHeight > 24,
    `A 24 px vertical/large-type HUD must settle above 24 px, received ${contentMinHeight}.`
  )
  const hostHeight = Math.round(contentMinHeight)

  const ctx = await mountScenario({
    label: 'height-motion',
    width: WIDTH,
    height: hostHeight,
    frame
  })
  await until(
    ctx.execute,
    `!!document.querySelector('.kevin-hud-surface')`,
    'height fixture surface'
  )
  await fontsReady(ctx.execute)
  const reducedMotion = await ctx.execute(
    'matchMedia("(prefers-reduced-motion: reduce)").matches'
  )
  let opening = null
  let settled = null
  let closing = null
  if (!reducedMotion) {
    await untilHasHeightAnimation(ctx.execute, 'entrance height animation')
    opening = await poseHeight(ctx.execute, 'start')
    assert.equal(opening.ok, true, `Could not seek the entrance height animation: ${JSON.stringify(opening)}`)
    assert.ok(
      Number.isFinite(opening.cssHeight) && opening.cssHeight > 0,
      'The entrance pose must resolve to a real CSS height.'
    )
    const openingRatio = opening.cssHeight / hostHeight
    assert.ok(
      opening.cssHeight < hostHeight - 8,
      `The real CSS entrance height (${opening.cssHeight}px) must start clearly shorter than ${hostHeight}px.`
    )
    assert.ok(
      openingRatio >= 0.45 && openingRatio <= 0.85,
      `The real CSS entrance opening must be a percentage of the raised ${hostHeight}px plate, not of the saved 24px floor; received ${opening.cssHeight}px (${openingRatio.toFixed(3)}).`
    )

    settled = await poseHeight(ctx.execute, 'end')
    assert.equal(settled.ok, true, `Could not finish the entrance height animation: ${JSON.stringify(settled)}`)
    assert.ok(
      approximately(settled.cssHeight, hostHeight, 1),
      `The settled plate height must be ${hostHeight}px, received ${settled.cssHeight}px.`
    )
  } else {
    await settleMotion(ctx.execute)
  }
  const geometry = await readHeightGeometry(ctx.execute)
  assert.ok(geometry, 'The height fixture content must be present.')
  assert.ok(
    approximately(geometry.surfaceHeight, hostHeight, 1),
    'The laid-out plate must fill the content-driven host height.'
  )
  assert.equal(geometry.orientation, 'vertical', 'The large-type fixture must use the vertical item descriptor.')
  assert.ok(
    Number.parseFloat(geometry.heightToken) > 24,
    'The rendered plate-height token must raise the effective floor above the user 24 px lower bound.'
  )
  assert.ok(
    Number.parseFloat(geometry.contentMinToken) > 24,
    'The production content-height token must raise the effective floor above 24 px.'
  )
  assert.ok(
    geometry.copyBottom <= geometry.surfaceHeight + 1 && geometry.copyTop >= -1,
    `The raised-height content must fit inside the plate (${geometry.copyTop}..${geometry.copyBottom} of ${geometry.surfaceHeight}).`
  )

  if (!reducedMotion) {
    ctx.send(makeFrame('exit', config, values))
    await until(
      ctx.execute,
      `document.querySelector('.kevin-hud-surface')?.getAttribute('data-phase') === 'exit'`,
      'exit phase'
    )
    await untilReverseHeightAnimation(ctx.execute, 'reverse height animation')
    closing = await poseHeight(ctx.execute, 'end')
    assert.equal(closing.ok, true, `Could not seek the reverse height animation: ${JSON.stringify(closing)}`)
    assert.ok(
      closing.cssHeight < hostHeight - 8,
      `The reverse timeline must contract below ${hostHeight}px, received ${closing.cssHeight}px.`
    )
    assert.ok(
      Math.abs(closing.cssHeight - opening.cssHeight) <= 2,
      `The reverse timeline must return to its shorter opening pose (${opening.cssHeight}px), received ${closing.cssHeight}px.`
    )
  }

  record.heightMotion = {
    contentMinHeight,
    hostHeight,
    reducedMotion,
    entranceCssHeight: opening?.cssHeight ?? null,
    entranceRatio: opening ? opening.cssHeight / hostHeight : null,
    entranceKeyframes: opening?.keyframeHeights ?? [],
    settledCssHeight: settled?.cssHeight ?? geometry.surfaceHeight,
    exitCssHeight: closing?.cssHeight ?? null,
    exitKeyframes: closing?.keyframeHeights ?? [],
    content: geometry,
    note: reducedMotion
      ? 'OS reduced motion disables the entrance/reverse timeline, so only the settled content-driven height is asserted.'
      : undefined
  }
}

async function readHeightGeometry(execute) {
  return execute(`(() => {
    const surface = document.querySelector('.kevin-hud-surface')
    const content = document.querySelector('.kevin-hud-content')
    const copy = document.querySelector('.kevin-hud-cell[data-cell="fps"] .kevin-hud-copy')
    if (!surface || !content || !copy) return null
    const surfaceRect = surface.getBoundingClientRect()
    const contentRect = content.getBoundingClientRect()
    const copyRect = copy.getBoundingClientRect()
    return {
      surfaceHeight: surfaceRect.height,
      contentHeight: contentRect.height,
      copyTop: copyRect.top - surfaceRect.top,
      copyBottom: copyRect.bottom - surfaceRect.top,
      orientation: document.querySelector('.kevin-hud-cell[data-cell="fps"]').getAttribute('data-orientation'),
      heightToken: getComputedStyle(surface).getPropertyValue('--khud-height').trim(),
      contentMinToken: getComputedStyle(surface).getPropertyValue('--khud-content-min-height').trim()
    }
  })()`)
}

async function readTitleTrajectory(execute) {
  return execute(`(async () => {
    const round = (value) => Math.round(value * 100) / 100
    const name = document.querySelector('.kevin-hud-title-motion > .kevin-hud-title-block')
    const launching = document.querySelector(
      '.kevin-hud-title-motion > .kevin-hud-launching'
    )
    if (!name || !launching) return { ok: false, reason: 'title labels missing' }

    const parse = (element) => {
      const transform = getComputedStyle(element).transform
      if (!transform || transform === 'none') return { transform: '', x: 0, y: 0 }
      const numbers = (transform.match(/-?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[-+]?\\d+)?/gi) || []).map(Number)
      if (transform.startsWith('matrix3d(')) {
        return { transform, x: numbers[12], y: numbers[13] }
      }
      return { transform, x: numbers[4], y: numbers[5] }
    }
    const titleAnimations = (element) =>
      element.getAnimations().filter(
        (animation) => animation.animationName === 'kevin-hud-title'
      )
    const nameAnimations = titleAnimations(name)
    const statusAnimations = titleAnimations(launching)
    if (nameAnimations.length === 0 || statusAnimations.length === 0) {
      return {
        ok: false,
        reason: 'title animation missing',
        name: nameAnimations.length,
        status: statusAnimations.length
      }
    }

    const seek = async (fraction) => {
      for (const animation of [...nameAnimations, ...statusAnimations]) {
        const timing = animation.effect.getTiming()
        animation.pause()
        animation.currentTime =
          (Number(timing.delay) || 0) + (Number(timing.duration) || 0) * fraction
      }
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
      const namePose = parse(name)
      const statusPose = parse(launching)
      return {
        name: {
          x: round(namePose.x),
          y: round(namePose.y),
          transform: namePose.transform
        },
        status: {
          x: round(statusPose.x),
          y: round(statusPose.y),
          transform: statusPose.transform
        }
      }
    }

    return {
      ok: true,
      animationNames: [
        ...new Set(
          [...nameAnimations, ...statusAnimations].map(
            (animation) => animation.animationName || ''
          )
        )
      ],
      early: await seek(0.1),
      settled: await seek(1)
    }
  })()`)
}

async function verifyRevealOrigins(record) {
  const centerConfig = {
    ...BASE_CONFIG,
    positionMode: 'custom',
    anchor: 'center',
    x: 50,
    y: 50,
    width: WIDTH,
    maxWidth: WIDTH,
    autoWidth: false,
    height: HEIGHT,
    metrics: ['fps', 'cpu']
  }
  const values = { fps: '171 FPS', cpu: '12%' }
  const ctx = await mountScenario({
    label: 'reveal-center',
    width: WIDTH,
    height: HEIGHT,
    frame: makeFrame('monitor', centerConfig, values)
  })
  await until(
    ctx.execute,
    `document.querySelectorAll('.kevin-hud-cell[data-khud-reveal="item"]').length === 2`,
    'centered metric cells'
  )
  await fontsReady(ctx.execute)
  await settleMotion(ctx.execute)
  const centered = await readRevealCells(ctx.execute)
  assert.equal(centered.anchor, 'center')
  assert.ok(
    centered.left.length >= 1 && centered.right.length >= 1,
    `The centered row needs cells on both sides of the anchor: ${JSON.stringify(centered.cells)}`
  )
  for (const cell of centered.left) {
    assert.ok(
      cell.originX > 0,
      `The settled left slot ${cell.cell} must start right of its final position (x > 0), received ${cell.originX}.`
    )
  }
  for (const cell of centered.right) {
    assert.ok(
      cell.originX < 0,
      `The settled right slot ${cell.cell} must start left of its final position (x < 0), received ${cell.originX}.`
    )
  }

  const leftConfig = { ...centerConfig, anchor: 'left', x: 0 }
  ctx.send(makeFrame('monitor', leftConfig, values))
  await waitForAnchorOrigins(ctx.execute, 'left', (cells) => cells.every((cell) => cell.originX < 0), 'left anchor origins')
  const left = await readRevealCells(ctx.execute)
  assert.equal(left.anchor, 'left')
  assert.ok(left.cells.length === 2, 'The left-anchor row must keep both cells.')
  for (const cell of left.cells) {
    assert.ok(cell.originX < 0, `A left-anchored cell must start left of its slot, received ${cell.originX}.`)
  }

  const rightConfig = { ...centerConfig, anchor: 'right', x: 100 }
  ctx.send(makeFrame('monitor', rightConfig, values))
  await waitForAnchorOrigins(ctx.execute, 'right', (cells) => cells.every((cell) => cell.originX > 0), 'right anchor origins')
  const right = await readRevealCells(ctx.execute)
  assert.equal(right.anchor, 'right')
  assert.ok(right.cells.length === 2, 'The right-anchor row must keep both cells.')
  for (const cell of right.cells) {
    assert.ok(cell.originX > 0, `A right-anchored cell must start right of its slot, received ${cell.originX}.`)
  }

  record.revealOrigins = { centered, left, right }
}

async function verifyValueWidths(record) {
  const config = {
    ...BASE_CONFIG,
    positionMode: 'preset',
    anchor: 'center',
    width: WIDTH,
    maxWidth: WIDTH,
    autoWidth: false,
    height: HEIGHT,
    metrics: ['download']
  }
  const samples = ['9 B/s', '12.3 KB/s', '1024.0 MB/s', '1024.0 GB/s', '1.7e+299 GB/s']
  const ctx = await mountScenario({
    label: 'value-widths',
    width: WIDTH,
    height: HEIGHT,
    frame: makeFrame('monitor', config, { download: samples[0] })
  })
  await until(
    ctx.execute,
    `document.querySelector('.kevin-hud-cell[data-cell="download"] .kevin-hud-metric-value')?.textContent?.trim() === ${JSON.stringify(samples[0])}`,
    'first network-rate sample'
  )
  await fontsReady(ctx.execute)
  await settleMotion(ctx.execute)

  const snapshots = []
  for (const sample of samples) {
    if (sample !== samples[0]) {
      ctx.send(makeFrame('monitor', config, { download: sample }))
      await until(
        ctx.execute,
        `document.querySelector('.kevin-hud-cell[data-cell="download"] .kevin-hud-metric-value')?.textContent?.trim() === ${JSON.stringify(sample)}`,
        `network-rate sample ${sample}`
      )
      await nextFrames(ctx.execute)
    }
    const snapshot = await readValueBoxes(ctx.execute, 'download')
    assert.ok(snapshot, `The download value cell must exist for sample ${sample}.`)
    assert.equal(snapshot.text, sample, 'The rendered download text must match the sent sample.')
    snapshots.push(snapshot)
  }

  const first = snapshots[0]
  assert.ok(first.valueWidth > 0 && first.cellWidth > 0, 'The value and cell boxes must have real width.')
  assert.equal(first.parts.length, snapshots[snapshots.length - 1].parts.length, 'The value sub-box group changed size across samples.')
  for (const snapshot of snapshots.slice(1)) {
    assert.ok(
      Math.abs(snapshot.valueWidth - first.valueWidth) <= 1,
      `The network value box moved across samples: ${first.valueWidth}px -> ${snapshot.valueWidth}px (${snapshot.text}).`
    )
    assert.ok(
      Math.abs(snapshot.cellWidth - first.cellWidth) <= 1,
      `The network cell box moved across samples: ${first.cellWidth}px -> ${snapshot.cellWidth}px (${snapshot.text}).`
    )
    assert.ok(
      Math.abs(snapshot.cellLeft - first.cellLeft) <= 1,
      `The network cell origin moved across samples: ${first.cellLeft}px -> ${snapshot.cellLeft}px (${snapshot.text}).`
    )
    assert.ok(
      Math.abs(snapshot.valueLeft - first.valueLeft) <= 1,
      `The network value origin moved across samples: ${first.valueLeft}px -> ${snapshot.valueLeft}px (${snapshot.text}).`
    )
    assert.ok(
      Math.abs(snapshot.copyWidth - first.copyWidth) <= 1,
      `The network copy box moved across samples: ${first.copyWidth}px -> ${snapshot.copyWidth}px (${snapshot.text}).`
    )
    assert.ok(
      Math.abs(snapshot.descriptionWidth - first.descriptionWidth) <= 1,
      `The network description box moved across samples: ${first.descriptionWidth}px -> ${snapshot.descriptionWidth}px (${snapshot.text}).`
    )
    if (first.parts.length >= 2) {
      for (let index = 0; index < first.parts.length; index += 1) {
        assert.ok(
          Math.abs(snapshot.parts[index].width - first.parts[index].width) <= 1,
          `Value sub-box ${index} moved across samples: ${first.parts[index].width}px -> ${snapshot.parts[index].width}px (${snapshot.text}).`
        )
      }
    }
  }
  record.valueWidths = snapshots
}

async function verifyCenteredItemGroups(record) {
  const config = {
    ...BASE_CONFIG,
    positionMode: 'preset',
    anchor: 'center',
    width: WIDTH,
    maxWidth: WIDTH,
    autoWidth: false,
    height: HEIGHT,
    metrics: ['fps', 'cpu'],
    itemStyle: {
      ...DEFAULT_ITEM_STYLE,
      orientation: 'horizontal',
      description: 'text',
      gap: 12,
      minWidth: 160,
      descriptionAlign: 'center',
      valueAlign: 'center'
    }
  }
  const ctx = await mountScenario({
    label: 'aligned-centered',
    width: WIDTH,
    height: HEIGHT,
    frame: makeFrame('monitor', config, { fps: '171 FPS', cpu: '12%' })
  })
  await until(
    ctx.execute,
    `document.querySelectorAll('.kevin-hud-cell[data-align-mode="center"]').length === 2`,
    'centered item groups'
  )
  await fontsReady(ctx.execute)
  await settleMotion(ctx.execute)

  const state = await ctx.execute(`(() => {
    const round = (value) => Math.round(value * 100) / 100
    const rect = (element) => {
      const box = element.getBoundingClientRect()
      return {
        left: round(box.left),
        right: round(box.right),
        top: round(box.top),
        bottom: round(box.bottom),
        width: round(box.width),
        height: round(box.height),
        centerX: round(box.left + box.width / 2)
      }
    }
    const cells = [...document.querySelectorAll('.kevin-hud-cell')].map((cell) => {
      const copy = cell.querySelector('.kevin-hud-copy')
      const description = cell.querySelector('.kevin-hud-metric-description')
      const value = cell.querySelector('.kevin-hud-metric-value')
      if (!copy || !description || !value) return null
      const copyStyle = getComputedStyle(copy)
      const copyRect = copy.getBoundingClientRect()
      const descriptionRect = description.getBoundingClientRect()
      const valueRect = value.getBoundingClientRect()
      const cellStyle = getComputedStyle(cell)
      return {
        cell: cell.getAttribute('data-cell'),
        mode: cell.getAttribute('data-align-mode'),
        descriptionAlign: cell.getAttribute('data-description-align'),
        valueAlign: cell.getAttribute('data-value-align'),
        width: cell.offsetWidth,
        minWidth: Number.parseFloat(cellStyle.minWidth),
        cellWidthToken: Number.parseFloat(
          cellStyle.getPropertyValue('--khud-cell-width')
        ),
        cellMinToken: Number.parseFloat(
          cellStyle.getPropertyValue('--khud-cell-min-width')
        ),
        copyGapToken: Number.parseFloat(
          cellStyle.getPropertyValue('--khud-copy-gap')
        ),
        cellRect: rect(cell),
        description: rect(description),
        value: rect(value),
        descriptionBeforeValue: descriptionRect.left < valueRect.left,
        groupCenter: round((descriptionRect.left + valueRect.right) / 2),
        gap: round(valueRect.left - descriptionRect.right),
        textAlign: getComputedStyle(value).textAlign
      }
    })
    return {
      hostWidth: window.innerWidth,
      cells,
      overflow: document.querySelector('.kevin-hud-bank')?.getAttribute('data-overflow')
    }
  })()`)
  assert.ok(state, 'The centred-group fixture DOM must be present.')
  assert.equal(state.cells.length, 2, 'Both selected metrics must render.')
  assert.equal(state.overflow, 'false', 'A roomy centred row must not scroll.')
  const first = state.cells[0]
  assert.ok(first, 'The first centred cell must exist.')
  for (const cell of state.cells) {
    assert.ok(cell, 'Every centred cell must have a copy/description/value pair.')
    assert.equal(cell.mode, 'center')
    assert.equal(cell.descriptionAlign, 'center')
    assert.equal(cell.valueAlign, 'center')
    assert.equal(cell.descriptionBeforeValue, true, 'Description must stay before value.')
    assert.equal(cell.textAlign, 'center', `Centred value text-align: ${cell.textAlign}.`)
    assert.ok(approximately(cell.width, first.width, 1), `Centred cells must grow equally: ${first.width}px vs ${cell.width}px.`)
    assert.ok(cell.width >= 159.5, `minWidth 160 must expand the cell, received ${cell.width}px.`)
    assert.ok(cell.cellWidthToken >= 160, `Measured reserve must honor minWidth, received ${cell.cellWidthToken}.`)
    assert.ok(cell.cellMinToken >= 160, `minWidth token must reach the cell, received ${cell.cellMinToken}.`)
    assert.ok(cell.copyGapToken >= 11.5, `Configured gap token must be visible, received ${cell.copyGapToken}.`)
    assert.ok(cell.gap >= 11.5, `The centred pair must keep at least 12px gap, received ${cell.gap}px.`)
    assert.ok(
      cell.description.right <= cell.value.left + 0.75,
      `The centred pair must not overlap (${cell.description.right} > ${cell.value.left}).`
    )
    assert.ok(
      approximately(cell.groupCenter, cell.cellRect.centerX, 2),
      `The centred group must stay near the cell centre: group ${cell.groupCenter}, cell ${cell.cellRect.centerX}.`
    )
    assert.ok(
      cell.description.left >= cell.cellRect.left - 0.75 &&
        cell.value.right <= cell.cellRect.right + 0.75,
      `A centred pair must stay inside its cell (${cell.description.left}..${cell.value.right} of ${cell.cellRect.left}..${cell.cellRect.right}).`
    )
  }
  record.centeredItemGroups = state
}

async function verifyVerticalMixedAlignment(record) {
  const hostWidth = 560
  const hostHeight = 72
  const config = {
    ...BASE_CONFIG,
    positionMode: 'custom',
    anchor: 'center',
    x: 50,
    y: 50,
    width: hostWidth,
    maxWidth: hostWidth,
    autoWidth: false,
    height: hostHeight,
    metrics: ['appName', 'fps'],
    itemStyle: {
      ...DEFAULT_ITEM_STYLE,
      orientation: 'vertical',
      description: 'icon',
      gap: 9,
      minWidth: 140,
      descriptionAlign: 'right',
      valueAlign: 'left'
    }
  }
  const ctx = await mountScenario({
    label: 'aligned-vertical',
    width: hostWidth,
    height: hostHeight,
    frame: makeFrame('monitor', config, { fps: '171 FPS' })
  })
  await until(
    ctx.execute,
    `document.querySelectorAll('.kevin-hud-cell[data-orientation="vertical"][data-align-mode="split"]').length === 2`,
    'vertical mixed item groups'
  )
  await fontsReady(ctx.execute)
  await settleMotion(ctx.execute)

  const state = await ctx.execute(`(() => {
    const round = (value) => Math.round(value * 100) / 100
    const rect = (element) => {
      const box = element.getBoundingClientRect()
      return {
        left: round(box.left),
        right: round(box.right),
        top: round(box.top),
        bottom: round(box.bottom),
        width: round(box.width),
        height: round(box.height),
        centerX: round(box.left + box.width / 2)
      }
    }
    const cells = [...document.querySelectorAll('.kevin-hud-cell')].map((cell) => {
      const copy = cell.querySelector('.kevin-hud-copy')
      const description = cell.querySelector('.kevin-hud-metric-description')
      const value = cell.querySelector('.kevin-hud-metric-value')
      if (!copy || !description || !value) return null
      const copyRect = copy.getBoundingClientRect()
      const copyStyle = getComputedStyle(copy)
      return {
        cell: cell.getAttribute('data-cell'),
        mode: cell.getAttribute('data-align-mode'),
        orientation: cell.getAttribute('data-orientation'),
        descriptionAlign: cell.getAttribute('data-description-align'),
        valueAlign: cell.getAttribute('data-value-align'),
        width: cell.offsetWidth,
        cellRect: rect(cell),
        description: rect(description),
        value: rect(value),
        copyContentLeft: round(
          copyRect.left + Number.parseFloat(copyStyle.paddingLeft)
        ),
        copyContentRight: round(
          copyRect.right - Number.parseFloat(copyStyle.paddingRight)
        ),
        verticalGap: round(
          value.getBoundingClientRect().top -
            description.getBoundingClientRect().bottom
        ),
        textAlign: getComputedStyle(value).textAlign
      }
    })
    return {
      hostWidth: window.innerWidth,
      cells,
      overflow: document.querySelector('.kevin-hud-bank')?.getAttribute('data-overflow')
    }
  })()`)
  assert.ok(state, 'The vertical mixed fixture DOM must be present.')
  assert.equal(state.cells.length, 2, 'Both selected vertical items must render.')
  assert.equal(state.overflow, 'false', 'The roomy vertical row must not scroll.')
  const first = state.cells[0]
  assert.ok(first, 'The first vertical cell must exist.')
  for (const cell of state.cells) {
    assert.ok(cell, 'Every vertical cell must have a copy/description/value pair.')
    assert.equal(cell.orientation, 'vertical')
    assert.equal(cell.mode, 'split')
    assert.equal(cell.descriptionAlign, 'right')
    assert.equal(cell.valueAlign, 'left')
    assert.equal(cell.textAlign, 'left', `Left value text-align: ${cell.textAlign}.`)
    assert.ok(approximately(cell.width, first.width, 1), `Vertical cells must grow equally: ${first.width}px vs ${cell.width}px.`)
    assert.ok(cell.width >= 139.5, `minWidth 140 must expand the cell, received ${cell.width}px.`)
    assert.ok(
      cell.description.bottom + 8.5 <= cell.value.top + 0.75,
      `Description must stay above value with a 9px gap (${cell.description.bottom} -> ${cell.value.top}).`
    )
    assert.ok(
      cell.verticalGap >= 8.5,
      `The vertical gap must be at least 9px, received ${cell.verticalGap}px.`
    )
    assert.ok(
      approximately(cell.description.right, cell.copyContentRight, 1),
      `Right-aligned description must sit at the content edge (${cell.description.right} vs ${cell.copyContentRight}).`
    )
    assert.ok(
      approximately(cell.value.left, cell.copyContentLeft, 1),
      `Left-aligned value must sit at the content edge (${cell.value.left} vs ${cell.copyContentLeft}).`
    )
    assert.ok(
      cell.description.top >= cell.cellRect.top - 0.75 &&
        cell.value.bottom <= cell.cellRect.bottom + 0.75,
      `The vertical pair must stay inside its cell (${cell.description.top}..${cell.value.bottom} of ${cell.cellRect.top}..${cell.cellRect.bottom}).`
    )
  }
  record.verticalMixedAlignment = state
}

async function verifyHorizontalMixedAlignment(record) {
  // One real window, four mixed description/value combinations. Two reverse-order
  // cases place the description in a later grid column than the value (3 -> 2 and
  // 2 -> 1), so a grid row left on auto would move the value to a second implicit
  // row. Judge the settled geometry: both parts must report row 1, share a
  // horizontal centre line, overlap vertically, stay one row tall, and keep at
  // least the configured gap between their real boxes.
  const hostWidth = WIDTH
  const hostHeight = HEIGHT
  const gap = 13
  const samples = [
    { descriptionAlign: 'left', valueAlign: 'center', minWidth: 0, reverse: false },
    { descriptionAlign: 'center', valueAlign: 'left', minWidth: 240, reverse: true },
    { descriptionAlign: 'right', valueAlign: 'center', minWidth: 0, reverse: true },
    { descriptionAlign: 'center', valueAlign: 'right', minWidth: 240, reverse: false }
  ]
  const columns = { left: '1', center: '2', right: '3' }
  const values = { fps: '171 FPS' }
  const configFor = (sample) => ({
    ...BASE_CONFIG,
    positionMode: 'preset',
    anchor: 'center',
    width: hostWidth,
    maxWidth: hostWidth,
    autoWidth: false,
    height: hostHeight,
    metrics: ['fps'],
    itemStyle: {
      ...DEFAULT_ITEM_STYLE,
      orientation: 'horizontal',
      description: 'text',
      gap,
      minWidth: sample.minWidth,
      descriptionAlign: sample.descriptionAlign,
      valueAlign: sample.valueAlign
    }
  })
  const ctx = await mountScenario({
    label: 'horizontal-mixed',
    width: hostWidth,
    height: hostHeight,
    frame: makeFrame('monitor', configFor(samples[0]), values)
  })

  const snapshots = []
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]
    if (index > 0) {
      ctx.send(makeFrame('monitor', configFor(sample), values))
    }
    await until(
      ctx.execute,
      `(() => {
        const cell = document.querySelector('.kevin-hud-cell[data-cell="fps"]')
        const description = cell?.querySelector('.kevin-hud-metric-description')
        const value = cell?.querySelector('.kevin-hud-metric-value')
        return !!cell &&
          cell.getAttribute('data-align-mode') === 'mixed' &&
          cell.getAttribute('data-align-center') === ${JSON.stringify(
            sample.descriptionAlign === 'center' ? 'description' : 'value'
          )} &&
          description?.getAttribute('data-align') === ${JSON.stringify(sample.descriptionAlign)} &&
          value?.getAttribute('data-align') === ${JSON.stringify(sample.valueAlign)} &&
          value?.textContent?.trim() === ${JSON.stringify(values.fps)}
      })()`,
      `horizontal mixed ${sample.descriptionAlign}/${sample.valueAlign}`
    )
    await fontsReady(ctx.execute)
    await settleMotion(ctx.execute)

    const state = await ctx.execute(`(() => {
      const round = (value) => Math.round(value * 100) / 100
      const rect = (element) => {
        const box = element.getBoundingClientRect()
        return {
          left: round(box.left),
          right: round(box.right),
          top: round(box.top),
          bottom: round(box.bottom),
          width: round(box.width),
          height: round(box.height),
          centerY: round(box.top + box.height / 2)
        }
      }
      const cell = document.querySelector('.kevin-hud-cell[data-cell="fps"]')
      const copy = cell?.querySelector('.kevin-hud-copy')
      const description = cell?.querySelector('.kevin-hud-metric-description')
      const value = cell?.querySelector('.kevin-hud-metric-value')
      if (!cell || !copy || !description || !value) return null
      const cellStyle = getComputedStyle(cell)
      const descriptionStyle = getComputedStyle(description)
      const valueStyle = getComputedStyle(value)
      const descriptionRect = rect(description)
      const valueRect = rect(value)
      return {
        mode: cell.getAttribute('data-align-mode'),
        center: cell.getAttribute('data-align-center'),
        descriptionAlign: cell.getAttribute('data-description-align'),
        valueAlign: cell.getAttribute('data-value-align'),
        overflow: document.querySelector('.kevin-hud-bank')?.getAttribute('data-overflow'),
        minWidthToken: Number.parseFloat(
          cellStyle.getPropertyValue('--khud-cell-min-width')
        ),
        gapToken: Number.parseFloat(cellStyle.getPropertyValue('--khud-copy-gap')),
        cellWidth: cell.offsetWidth,
        copyHeight: round(copy.getBoundingClientRect().height),
        description: {
          ...descriptionRect,
          gridRowStart: descriptionStyle.gridRowStart,
          gridColumnStart: descriptionStyle.gridColumnStart
        },
        value: {
          ...valueRect,
          gridRowStart: valueStyle.gridRowStart,
          gridColumnStart: valueStyle.gridColumnStart
        },
        verticalOverlap: round(
          Math.min(descriptionRect.bottom, valueRect.bottom) -
            Math.max(descriptionRect.top, valueRect.top)
        ),
        // Disjoint horizontal distance; a negative value means the boxes overlap.
        horizontalGap: round(
          Math.max(descriptionRect.left, valueRect.left) -
            Math.min(descriptionRect.right, valueRect.right)
        ),
        descriptionBeforeValue: descriptionRect.left < valueRect.left
      }
    })()`)
    assert.ok(
      state,
      `The horizontal mixed DOM must exist for ${sample.descriptionAlign}/${sample.valueAlign}.`
    )
    snapshots.push(state)
  }

  // Publish all four measurements before asserting so a failure still shows
  // the reversed sample's real row geometry in the evidence file.
  record.horizontalMixedAlignment = { gap, samples, snapshots }

  for (let index = 0; index < snapshots.length; index += 1) {
    const state = snapshots[index]
    const sample = samples[index]
    const label = `${sample.descriptionAlign} description / ${sample.valueAlign} value, minWidth ${sample.minWidth}`
    assert.equal(state.mode, 'mixed', `${label} must use the mixed grid.`)
    assert.equal(
      state.center,
      sample.descriptionAlign === 'center' ? 'description' : 'value',
      `${label} must centre the configured part.`
    )
    assert.equal(state.descriptionAlign, sample.descriptionAlign, `${label} description attribute.`)
    assert.equal(state.valueAlign, sample.valueAlign, `${label} value attribute.`)
    assert.ok(
      state.description.width > 0 && state.value.width > 0,
      `${label} must render real description and value boxes.`
    )
    assert.equal(state.overflow, 'false', `${label} must stay in the one-row bank.`)
    assert.ok(
      approximately(state.minWidthToken, sample.minWidth, 0.01),
      `${label} must render its minWidth token, received ${state.minWidthToken}.`
    )
    assert.ok(
      approximately(state.gapToken, gap, 0.01),
      `${label} must render its non-zero gap token, received ${state.gapToken}.`
    )
    assert.equal(
      state.description.gridRowStart,
      '1',
      `${label} description must report row 1, received ${state.description.gridRowStart}.`
    )
    assert.equal(
      state.value.gridRowStart,
      '1',
      `${label} value must report row 1, received ${state.value.gridRowStart}.`
    )
    assert.equal(
      state.description.gridColumnStart,
      columns[sample.descriptionAlign],
      `${label} description grid column.`
    )
    assert.equal(
      state.value.gridColumnStart,
      columns[sample.valueAlign],
      `${label} value grid column.`
    )
    assert.ok(
      approximately(state.description.centerY, state.value.centerY, 1.25),
      `${label} description and value must share the same settled row (centre Y ${state.description.centerY} vs ${state.value.centerY}).`
    )
    assert.ok(
      state.verticalOverlap > 0.5,
      `${label} description and value boxes must overlap vertically, received ${state.verticalOverlap}px.`
    )
    assert.ok(
      state.copyHeight <= Math.max(state.description.height, state.value.height) + 1,
      `${label} copy must stay one row tall (${state.copyHeight}px for parts ${state.description.height}/${state.value.height}px).`
    )
    assert.equal(
      state.descriptionBeforeValue,
      !sample.reverse,
      `${label} visual order must ${sample.reverse ? 'mirror' : 'keep'} description and value.`
    )
    assert.ok(
      state.horizontalGap >= gap - 0.5,
      `${label} real horizontal distance must keep the ${gap}px gap, received ${state.horizontalGap}px.`
    )
    assert.ok(
      state.cellWidth >= sample.minWidth - 0.5,
      `${label} cell width must honour minWidth, received ${state.cellWidth}px.`
    )
  }
}

async function verifyCustomMemoryAlignment(record) {
  // The host is intentionally narrower than the configured 360 DIP floor: the
  // real cell must still widen to the floor and let the bank scroll, while the
  // same real used/total/percentage text follows the custom alignment.
  const hostWidth = 380
  const config = {
    ...BASE_CONFIG,
    positionMode: 'preset',
    anchor: 'center',
    width: hostWidth,
    maxWidth: hostWidth,
    autoWidth: false,
    height: HEIGHT,
    metrics: ['memory'],
    itemStyle: {
      ...DEFAULT_ITEM_STYLE,
      orientation: 'horizontal',
      gap: 7,
      minWidth: 360,
      descriptionAlign: 'center',
      valueAlign: 'left'
    }
  }
  const ctx = await mountScenario({
    label: 'aligned-memory',
    width: hostWidth,
    height: HEIGHT,
    frame: makeFrame('monitor', config, { memory: MEMORY_VALUE })
  })
  await until(
    ctx.execute,
    `document.querySelector('.kevin-hud-cell[data-cell="memory"][data-memory-full="true"]') &&
      document.querySelector('.kevin-hud-content')?.getAttribute('data-memory-mode') === 'aligned'`,
    'custom-aligned memory cell'
  )
  await fontsReady(ctx.execute)
  await settleMotion(ctx.execute)

  const state = await ctx.execute(`(() => {
    const round = (value) => Math.round(value * 100) / 100
    const rect = (element) => {
      const box = element.getBoundingClientRect()
      return {
        left: round(box.left),
        right: round(box.right),
        top: round(box.top),
        bottom: round(box.bottom),
        width: round(box.width),
        height: round(box.height),
        centerX: round(box.left + box.width / 2)
      }
    }
    const cell = document.querySelector('.kevin-hud-cell[data-cell="memory"]')
    const copy = cell?.querySelector('.kevin-hud-copy')
    const description = cell?.querySelector('.kevin-hud-metric-description')
    const value = cell?.querySelector('.kevin-hud-metric-value')
    if (!cell || !copy || !description || !value) return null
    const copyRect = copy.getBoundingClientRect()
    const copyStyle = getComputedStyle(copy)
    const valueRect = value.getBoundingClientRect()
    const descriptionRect = description.getBoundingClientRect()
    const cellStyle = getComputedStyle(cell)
    return {
      mode: document.querySelector('.kevin-hud-content')?.getAttribute('data-memory-mode'),
      overflow: document.querySelector('.kevin-hud-bank')?.getAttribute('data-overflow'),
      full: cell.getAttribute('data-memory-full'),
      alignMode: cell.getAttribute('data-align-mode'),
      alignCenter: cell.getAttribute('data-align-center'),
      descriptionAlign: cell.getAttribute('data-description-align'),
      valueAlign: cell.getAttribute('data-value-align'),
      text: value.textContent?.trim() ?? '',
      readoutPresent: !!document.querySelector('.kevin-hud-memory-readout'),
      cellWidth: cell.offsetWidth,
      minToken: Number.parseFloat(
        cellStyle.getPropertyValue('--khud-cell-min-width')
      ),
      cellRect: rect(cell),
      description: rect(description),
      value: rect(value),
      copyContentLeft: round(
        copyRect.left + Number.parseFloat(copyStyle.paddingLeft)
      ),
      gap: round(descriptionRect.left - valueRect.right),
      textAlign: getComputedStyle(value).textAlign
    }
  })()`)
  assert.ok(state, 'The custom memory fixture DOM must be present.')
  assert.equal(state.mode, 'aligned', 'Custom alignment must leave the dedicated gauge.')
  assert.equal(state.overflow, 'true', 'The 360 DIP floor must overflow the 380 DIP host and scroll.')
  assert.equal(state.full, 'true', 'The ordinary memory cell must keep the full readout.')
  assert.equal(state.readoutPresent, false, 'The dedicated gauge must not render in the ordinary cell.')
  assert.equal(state.alignMode, 'mixed')
  assert.equal(state.alignCenter, 'description')
  assert.equal(state.descriptionAlign, 'center')
  assert.equal(state.valueAlign, 'left')
  assert.equal(state.textAlign, 'left')
  assert.equal(state.text, MEMORY_VALUE, 'The same real memory data must remain visible.')
  assert.ok(state.minToken >= 360, `minWidth token must reach the memory cell, received ${state.minToken}.`)
  assert.ok(state.cellWidth >= 359.5, `The memory cell must honor minWidth 360, received ${state.cellWidth}px.`)
  assert.ok(
    approximately(state.description.centerX, state.cellRect.centerX, 2),
    `The centred memory descriptor must stay near the cell centre: ${state.description.centerX} vs ${state.cellRect.centerX}.`
  )
  assert.ok(
    approximately(state.value.left, state.copyContentLeft, 1),
    `The left memory value must sit at the content edge: ${state.value.left} vs ${state.copyContentLeft}.`
  )
  assert.ok(
    state.value.right <= state.description.left + 0.75 &&
      state.gap >= 6.5,
    `The custom memory pair must keep its 7px minimum gap, received ${state.gap}px.`
  )
  record.customMemoryAlignment = state
}

async function verifyOverflowScroll(record) {
  // The merged app identity keeps its long real name at the front of the same
  // narrow row, so the overflow case also proves the name is widened and
  // scrolled rather than ellipsized or clipped.
  const metrics = [
    'appName',
    'fps',
    'cpu',
    'gpu',
    'memory',
    'download',
    'upload',
    'clock'
  ]
  const config = {
    ...BASE_CONFIG,
    positionMode: 'preset',
    anchor: 'center',
    width: 200,
    maxWidth: 220,
    autoWidth: true,
    height: HEIGHT,
    metrics
  }
  const values = {
    fps: '144 FPS',
    cpu: '37%',
    gpu: 'GPU 62%',
    memory: '9.7 / 31.3 GB · 31%',
    download: '12.3 MB/s',
    upload: '1.2 MB/s',
    clock: '23:08'
  }
  const ctx = await mountScenario({
    label: 'overflow',
    width: 220,
    height: HEIGHT,
    frame: makeFrame('monitor', config, values)
  })
  await until(
    ctx.execute,
    `document.querySelector('.kevin-hud-bank')?.getAttribute('data-overflow') === 'true'`,
    'bank overflow state'
  )
  await fontsReady(ctx.execute)
  await settleMotion(ctx.execute, true)
  const state = await ctx.execute(`(() => {
    const round = (value) => Math.round(value * 100) / 100
    const surface = document.querySelector('.kevin-hud-surface')
    const bank = document.querySelector('.kevin-hud-bank')
    const track = document.querySelector('.kevin-hud-track')
    if (!surface || !bank || !track) return null
    const children = [...track.children]
    let contentExtent = track.clientWidth
    for (const child of children) {
      contentExtent = Math.max(contentExtent, child.offsetLeft + child.offsetWidth)
    }
    const trackStyle = getComputedStyle(track)
    const bankStyle = getComputedStyle(bank)
    const appNameCell = document.querySelector('.kevin-hud-cell[data-cell="appName"]')
    const appNameValue = appNameCell?.querySelector('.kevin-hud-metric-value')
    const animations = track.getAnimations().map((animation) => ({
      name: animation.animationName || '',
      playState: animation.playState
    }))
    return {
      appName: appNameCell && appNameValue
        ? {
            cellWidth: appNameCell.offsetWidth,
            valueWidth: appNameValue.offsetWidth,
            valueScrollWidth: appNameValue.scrollWidth,
            text: appNameValue.textContent?.trim() ?? ''
          }
        : null,
      hostWidth: window.innerWidth,
      surfaceWidth: surface.offsetWidth,
      bankClientWidth: bank.clientWidth,
      bankScrollWidth: bank.scrollWidth,
      trackWidth: track.offsetWidth,
      trackClientWidth: track.clientWidth,
      contentExtent: round(contentExtent),
      overflow: bank.getAttribute('data-overflow'),
      overflowDistance: Number.parseFloat(bankStyle.getPropertyValue('--khud-overflow-distance')) || 0,
      animationName: trackStyle.animationName,
      animationDuration: trackStyle.animationDuration,
      animationDelay: trackStyle.animationDelay,
      scrollAnimation: animations.find((animation) => animation.name === 'kevin-hud-scroll') || null,
      animations,
      trackHeight: track.offsetHeight,
      bankHeight: bank.clientHeight,
      cellCount: document.querySelectorAll('.kevin-hud-cell').length
    }
  })()`)
  assert.ok(state, 'The overflow fixture DOM must be present.')
  assert.ok(approximately(state.hostWidth, 220, 1), 'The fixture must use the user max width as the host width.')
  assert.ok(approximately(state.surfaceWidth, 220, 1), 'The plate must fill the max-width host.')
  assert.equal(state.overflow, 'true', 'A row wider than the small max must mark the bank as overflowing.')
  assert.equal(state.cellCount, metrics.length, 'Every selected metric must render in the one-row bank.')
  assert.ok(state.appName, 'The narrow overflow row must keep the merged app identity.')
  assert.equal(state.appName.text, APP_NAME)
  assert.ok(
    state.appName.cellWidth >= state.appName.valueWidth,
    `The app name cell must contain its value (${state.appName.cellWidth} < ${state.appName.valueWidth}).`
  )
  assert.ok(
    state.appName.valueScrollWidth <= state.appName.valueWidth + 1,
    `The long app name must not clip (${state.appName.valueScrollWidth} > ${state.appName.valueWidth}).`
  )
  assert.ok(state.contentExtent > state.bankClientWidth + 8, 'The bank content must genuinely exceed its viewport.')
  assert.ok(state.overflowDistance > 0, 'The overflow distance must be available to the scroll animation.')
  assert.ok(
    state.trackHeight <= state.bankHeight + 1,
    'The overflowing bank must stay one row rather than wrapping.'
  )
  const reducedMotion = await ctx.execute(
    'matchMedia("(prefers-reduced-motion: reduce)").matches'
  )
  if (!reducedMotion) {
    assert.ok(
      String(state.animationName).includes('kevin-hud-scroll'),
      `The overflowing track must run the scroll animation, received ${state.animationName}.`
    )
    assert.ok(
      Number.parseFloat(state.animationDuration) > 0,
      'The scroll animation must have a finite positive duration.'
    )
    const moved = await ctx.execute(`(() => {
      const track = document.querySelector('.kevin-hud-track')
      const animation = track?.getAnimations().find(
        (candidate) => (candidate.animationName || '') === 'kevin-hud-scroll'
      )
      if (!animation || !animation.effect) {
        return { ok: false, reason: 'scroll animation missing' }
      }
      const timing = animation.effect.getTiming()
      animation.pause()
      animation.currentTime = Math.max(0, Number(timing.delay) || 0) + Number(timing.duration) * 0.5
      const transform = getComputedStyle(track).transform
      const numbers = (transform.match(/-?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[-+]?\\d+)?/gi) || []).map(Number)
      return {
        ok: true,
        transform,
        translateX: numbers.length >= 6 ? numbers[4] : null,
        keyframes: animation.effect.getKeyframes().map((keyframe) => ({
          offset: keyframe.computedOffset ?? keyframe.offset,
          transform: keyframe.transform ?? ''
        }))
      }
    })()`)
    assert.equal(moved.ok, true, `Could not seek the overflow scroll animation: ${JSON.stringify(moved)}`)
    assert.ok(
      Number.isFinite(moved.translateX) && moved.translateX < -0.5,
      `The overflow animation must actually move the track left, received ${moved.transform}.`
    )
    record.overflowMotion = moved
  }
  record.overflowScroll = state
  record.overflowScroll.reducedMotion = reducedMotion
}

/* ------------------------------------------------------------------------- */
/* fixture window and bounded DOM helpers                                    */
/* ------------------------------------------------------------------------- */

async function mountScenario({ label, width, height, frame }) {
  latestFrame = null
  const win = createFixtureWindow(preloadPath, width, height)
  activeWindow = win
  activeWindowLabel = label
  const execute = (source) => {
    if (!win || win.isDestroyed()) {
      return Promise.reject(new Error(`The ${label} fixture window was destroyed.`))
    }
    return win.webContents.executeJavaScript(source, false)
  }
  const url = pathToFileURL(rendererPath)
  url.searchParams.set('kevinHud', '1')
  await win.loadURL(url.href)
  await until(execute, `document.readyState === 'complete'`, `${label} document ready`)
  await until(
    execute,
    `!!window.kevinHud && typeof window.kevinHud.onFrame === 'function'`,
    `${label} HUD preload bridge`
  )
  const bridge = await execute(`(() => {
    const api = window.kevinHud
    return {
      keys: api ? Object.keys(api).sort() : [],
      onFrame: typeof api?.onFrame,
      genericApi: typeof window.api,
      nodeRequire: typeof window.require
    }
  })()`)
  assert.equal(bridge.onFrame, 'function', 'The dedicated HUD preload must expose onFrame.')
  assert.equal(bridge.genericApi, 'undefined', 'The HUD must not load the launcher generic preload.')
  assert.equal(bridge.nodeRequire, 'undefined', 'The HUD renderer must not expose Node require().')

  try {
    win.showInactive()
  } catch {
    // Visibility is only needed so Chromium keeps layout/animation frames live.
  }
  const send = (nextFrame) => {
    latestFrame = nextFrame
    if (!win.isDestroyed()) win.webContents.send(channels.frame, nextFrame)
  }
  send(frame)
  await until(
    execute,
    `!!document.querySelector('.kevin-hud-surface')`,
    `${label} HUD surface`
  )
  return {
    win,
    execute,
    send,
    until: (expression, waitLabel, timeout) =>
      until(execute, expression, waitLabel || `${label} condition`, timeout)
  }
}

function createFixtureWindow(fixturePreload, width, height) {
  const win = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    roundedCorners: false,
    thickFrame: false,
    type: process.platform === 'win32' ? 'toolbar' : undefined,
    autoHideMenuBar: true,
    title: 'Kevin HUD layout smoke',
    webPreferences: {
      preload: fixturePreload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  })
  try {
    win.setMenuBarVisibility(false)
    win.setSkipTaskbar(true)
    win.setIgnoreMouseEvents(true)
    win.setAlwaysOnTop(false)
  } catch {
    // Native conveniences are outside this layout smoke's contract.
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('preload-error', (_event, preload, error) => {
    recordConsole('preload-error', `${preload}: ${errorMessage(error)}`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    recordConsole('renderer', `render process gone: ${details.reason}`)
    if (!finished) fail(new Error(`HUD renderer process gone: ${details.reason}`))
  })
  win.webContents.on('console-message', (...args) => {
    const details = args[1] && typeof args[1] === 'object' ? args[1] : null
    if (details) {
      const level = String(details.level || '').toLowerCase()
      if (level === 'error' || level === 'warning') {
        recordConsole(level, details.message || '')
      }
      return
    }
    const level = args[1]
    if (level < 2) return
    recordConsole(level === 3 ? 'error' : 'warning', String(args[2] || ''))
  })
  return win
}

function makeFrame(phase, config, values) {
  return {
    phase,
    config: {
      ...config,
      itemStyle: { ...config.itemStyle },
      itemStyles: { ...config.itemStyles },
      metrics: [...config.metrics]
    },
    appName: APP_NAME,
    iconUrl: null,
    fontFamily: null,
    fontFamilyEn: null,
    fontFamilyZh: null,
    appGlass: null,
    values: { ...values }
  }
}

function inspectChannels(preloadText) {
  const found = new Set()
  for (const match of preloadText.matchAll(/['"`](kevin[-_]?hud:[a-z-]+)['"`]/gi)) {
    found.add(match[1])
  }
  const channelNames = [...found]
  const frameChannels = channelNames.filter((channel) => /:frame$/i.test(channel))
  const readyChannels = channelNames.filter((channel) => /:ready$/i.test(channel))
  if (frameChannels.length !== 1) {
    throw new Error(
      `Could not identify exactly one KEVIN HUD frame channel in the preload (found: ${
        channelNames.join(', ') || 'none'
      }).`
    )
  }
  return {
    frame: frameChannels[0],
    ready: readyChannels.length === 1 ? readyChannels[0] : null
  }
}

async function until(execute, expression, label, timeout = 5000) {
  const deadline = Date.now() + timeout
  let lastError = null
  while (Date.now() < deadline) {
    if (finished) throw new Error(`Verification stopped while waiting for ${label}.`)
    try {
      const value = await execute(expression)
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(35)
  }
  const suffix = lastError ? `; last renderer error: ${errorMessage(lastError)}` : ''
  throw new Error(`Timed out waiting for ${label}${suffix}.`)
}

async function fontsReady(execute) {
  await execute(`(document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true)`)
}

async function nextFrames(execute) {
  await execute(
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`
  )
}

async function settleMotion(execute, keepScroll = false) {
  await execute(`(async () => {
    for (const animation of document.getAnimations()) {
      const name = animation.animationName || ''
      if (${JSON.stringify(keepScroll)} && /scroll/i.test(name)) continue
      try {
        animation.finish()
      } catch {
        // Infinite or otherwise un-finishable animations are left untouched.
      }
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return true
  })()`)
}

async function untilHasHeightAnimation(execute, label) {
  await until(
    execute,
    `(() => {
      const surface = document.querySelector('.kevin-hud-surface')
      if (!surface) return false
      const hasHeight = (animation) => {
        try {
          return (animation.effect?.getKeyframes?.() || []).some((keyframe) =>
            Object.keys(keyframe).some((key) => key.toLowerCase() === 'height')
          )
        } catch {
          return false
        }
      }
      return surface.getAnimations().some(hasHeight)
    })()`,
    label
  )
}

/**
 * Seek the real height animation to its first or last pose. Only bounded
 * Web Animations methods are used; no screenshot, input automation or polling
 * of the animation clock is involved.
 */
async function untilReverseHeightAnimation(execute, label) {
  await until(
    execute,
    `(() => {
      const surface = document.querySelector('.kevin-hud-surface')
      if (!surface) return false
      const hasHeight = (animation) => {
        try {
          return (animation.effect?.getKeyframes?.() || []).some((keyframe) =>
            Object.keys(keyframe).some((key) => key.toLowerCase() === 'height')
          )
        } catch {
          return false
        }
      }
      return surface.getAnimations().some(
        (animation) =>
          hasHeight(animation) &&
          (Number(animation.playbackRate) < 0 || /exit/i.test(animation.animationName || ''))
      )
    })()`,
    label
  )
}

async function poseHeight(execute, mode) {
  return execute(`(() => {
    const surface = document.querySelector('.kevin-hud-surface')
    if (!surface) return { ok: false, reason: 'surface missing' }
    const hasHeight = (animation) => {
      try {
        return (animation.effect?.getKeyframes?.() || []).some((keyframe) =>
          Object.keys(keyframe).some((key) => key.toLowerCase() === 'height')
        )
      } catch {
        return false
      }
    }
    const all = surface.getAnimations().filter(hasHeight)
    const exitAnimations = all.filter((animation) => /exit/i.test(animation.animationName || ''))
    const animations = exitAnimations.length > 0 ? exitAnimations : all
    if (animations.length === 0) {
      return {
        ok: false,
        reason: 'height animation missing',
        animations: surface.getAnimations().map((animation) => animation.animationName || '')
      }
    }
    for (const animation of animations) {
      try {
        const timing = animation.effect.getTiming()
        const duration = Number(timing.duration) || 0
        const delay = Number(timing.delay) || 0
        const reversed = Number(animation.playbackRate) < 0
        const target =
          ${JSON.stringify(mode)} === 'start'
            ? reversed
              ? delay + duration
              : 0
            : reversed
              ? 0
              : delay + duration
        animation.pause()
        animation.currentTime = target
      } catch {
        // Keep every animation we can control; the computed pose is read below.
      }
    }
    const style = getComputedStyle(surface)
    const keyframes = []
    for (const animation of animations) {
      try {
        for (const keyframe of animation.effect.getKeyframes()) {
          for (const key of Object.keys(keyframe)) {
            if (key.toLowerCase() === 'height') keyframes.push(String(keyframe[key]))
          }
        }
      } catch {
        // Diagnostics only.
      }
    }
    return {
      ok: true,
      cssHeight: Number.parseFloat(style.height),
      offsetHeight: surface.offsetHeight,
      rectHeight: surface.getBoundingClientRect().height,
      keyframeHeights: [...new Set(keyframes)],
      animationNames: animations.map((animation) => animation.animationName || '')
    }
  })()`)
}

async function readRevealCells(execute) {
  return execute(`(() => {
    const round = (value) => Math.round(value * 100) / 100
    const surface = document.querySelector('.kevin-hud-surface')
    const root = document.querySelector('.kevin-hud-root')
    if (!surface || !root) return { anchor: '', cells: [], left: [], right: [] }
    const surfaceRect = surface.getBoundingClientRect()
    const surfaceCenter = surfaceRect.left + surfaceRect.width / 2
    const cells = [...surface.querySelectorAll('.kevin-hud-cell[data-khud-reveal="item"]')].map((cell) => {
      const rect = cell.getBoundingClientRect()
      const style = getComputedStyle(cell)
      return {
        cell: cell.getAttribute('data-cell') || '',
        originX: Number.parseFloat(style.getPropertyValue('--khud-origin-x')) || 0,
        originY: Number.parseFloat(style.getPropertyValue('--khud-origin-y')) || 0,
        centerX: round(rect.left + rect.width / 2),
        width: round(rect.width),
        left: round(rect.left),
        right: round(rect.right)
      }
    })
    return {
      anchor: root.getAttribute('data-anchor') || '',
      surface: { centerX: round(surfaceCenter), width: round(surfaceRect.width) },
      cells,
      left: cells.filter((cell) => cell.centerX < surfaceCenter - 0.5),
      right: cells.filter((cell) => cell.centerX > surfaceCenter + 0.5)
    }
  })()`)
}

async function waitForAnchorOrigins(execute, anchor, predicateSource, label) {
  await until(
    execute,
    `(() => {
      const root = document.querySelector('.kevin-hud-root')
      if (!root || root.getAttribute('data-anchor') !== ${JSON.stringify(anchor)}) return false
      const surface = document.querySelector('.kevin-hud-surface')
      if (!surface) return false
      const cells = [...surface.querySelectorAll('.kevin-hud-cell[data-khud-reveal="item"]')].map((cell) => {
        const rect = cell.getBoundingClientRect()
        return {
          cell: cell.getAttribute('data-cell') || '',
          originX: Number.parseFloat(getComputedStyle(cell).getPropertyValue('--khud-origin-x')) || 0,
          centerX: rect.left + rect.width / 2
        }
      })
      return cells.length > 0 && (${predicateSource})(cells)
    })()`,
    label
  )
}

async function readValueBoxes(execute, metric) {
  return execute(`(() => {
    const cell = document.querySelector('.kevin-hud-cell[data-cell=${JSON.stringify(metric)}]')
    const value = cell?.querySelector('.kevin-hud-metric-value')
    const copy = cell?.querySelector('.kevin-hud-copy')
    const description = cell?.querySelector('.kevin-hud-metric-description')
    if (!cell || !value) return null
    const direct = [...value.children]
    const leaf = [...value.querySelectorAll('*')].filter(
      (element) => element.children.length === 0 && (element.textContent || '').trim()
    )
    const parts = direct.length >= 2 ? direct : leaf.length >= 2 ? leaf : []
    return {
      text: value.textContent?.trim() ?? '',
      cellWidth: cell.offsetWidth,
      cellLeft: cell.offsetLeft,
      copyWidth: copy?.offsetWidth ?? 0,
      descriptionWidth: description?.offsetWidth ?? 0,
      valueWidth: value.offsetWidth,
      valueLeft: value.offsetLeft,
      valueHeight: value.offsetHeight,
      parts: parts.map((part) => ({
        className: typeof part.className === 'string' ? part.className : '',
        text: (part.textContent || '').trim(),
        width: part.offsetWidth,
        height: part.offsetHeight
      }))
    }
  })()`)
}

async function captureSnapshot(win) {
  if (!win || win.isDestroyed()) return { destroyed: true }
  const bounds = (() => {
    try {
      return win.getBounds()
    } catch {
      return null
    }
  })()
  let contentSize = null
  try {
    contentSize = win.getContentSize()
  } catch {
    // Diagnostics only.
  }
  try {
    const dom = await win.webContents.executeJavaScript(`(() => {
      const round = (value) => Math.round(value * 100) / 100
      const rect = (element) => {
        if (!element) return null
        const box = element.getBoundingClientRect()
        return {
          left: round(box.left), right: round(box.right), top: round(box.top),
          bottom: round(box.bottom), width: round(box.width), height: round(box.height)
        }
      }
      const surface = document.querySelector('.kevin-hud-surface')
      const style = surface ? getComputedStyle(surface) : null
      const bank = document.querySelector('.kevin-hud-bank')
      const track = document.querySelector('.kevin-hud-track')
      const readout = document.querySelector('.kevin-hud-memory-readout')
      const animations = document.getAnimations().slice(0, 24).map((animation) => {
        const target = animation.effect?.target
        return {
          name: animation.animationName || '',
          playState: animation.playState,
          currentTime: animation.currentTime == null ? null : Number(animation.currentTime),
          target: target
            ? (target.getAttribute?.('data-cell') || target.className || target.tagName || '')
            : ''
        }
      })
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        root: document.querySelector('.kevin-hud-root')?.getAttribute('data-phase') ?? '',
        surface: surface ? {
          rect: rect(surface),
          offsetWidth: surface.offsetWidth,
          offsetHeight: surface.offsetHeight,
          attrs: {
            background: surface.getAttribute('data-background'),
            motion: surface.getAttribute('data-motion'),
            phase: surface.getAttribute('data-phase')
          },
          tokens: {
            width: style.getPropertyValue('--khud-width').trim(),
            height: style.getPropertyValue('--khud-height').trim(),
            plateHeight: style.getPropertyValue('--khud-plate-height').trim(),
            contentMinHeight: style.getPropertyValue('--khud-content-min-height').trim(),
            openHeight: style.getPropertyValue('--khud-open-height').trim()
          }
        } : null,
        fill: document.querySelector('.kevin-hud-fill') ? {
          color: getComputedStyle(document.querySelector('.kevin-hud-fill')).backgroundColor,
          opacity: getComputedStyle(document.querySelector('.kevin-hud-fill')).opacity
        } : null,
        memory: readout ? {
          text: readout.textContent?.trim().slice(0, 180) ?? '',
          left: rect(document.querySelector('.kevin-hud-memory-readout__left')),
          center: rect(document.querySelector('.kevin-hud-memory-readout__center')),
          right: rect(document.querySelector('.kevin-hud-memory-readout__right')),
          partWidths: [
            '.kevin-hud-memory-readout__used',
            '.kevin-hud-memory-readout__total-value',
            '.kevin-hud-memory-readout__unit',
            '.kevin-hud-memory-readout__percent',
            '.kevin-hud-memory-readout__arc'
          ].map((selector) => {
            const element = document.querySelector(selector)
            return { selector, width: element?.offsetWidth ?? null }
          })
        } : null,
        cells: [...document.querySelectorAll('.kevin-hud-cell[data-khud-reveal="item"]')].slice(0, 12).map((cell) => ({
          cell: cell.getAttribute('data-cell') || '',
          text: cell.textContent?.trim().slice(0, 100) ?? '',
          rect: rect(cell),
          originX: getComputedStyle(cell).getPropertyValue('--khud-origin-x').trim()
        })),
        bank: bank && track ? {
          overflow: bank.getAttribute('data-overflow'),
          bankWidth: bank.clientWidth,
          trackWidth: track.offsetWidth,
          distance: getComputedStyle(bank).getPropertyValue('--khud-overflow-distance').trim(),
          animation: getComputedStyle(track).animationName,
          animationDuration: getComputedStyle(track).animationDuration
        } : null,
        animations,
        bodyText: (document.body?.innerText || '').slice(0, 500)
      }
    })()`, false)
    return { bounds, contentSize, dom }
  } catch (error) {
    return { bounds, contentSize, domError: errorMessage(error) }
  }
}

/* ------------------------------------------------------------------------- */
/* report and utility helpers                                                */
/* ------------------------------------------------------------------------- */

function finishSuccess(result) {
  if (finished) return
  finished = true
  if (hardTimer) clearTimeout(hardTimer)
  result.evidence = evidencePath
  writeEvidence(result)
  writeJson(1, result)
  destroyActiveWindow()
  cleanProfile()
  exitProcess(0)
}

function fail(reason) {
  if (finished) return
  finished = true
  if (hardTimer) clearTimeout(hardTimer)
  const error = reason instanceof Error ? reason : new Error(String(reason))
  const payload = {
    ok: false,
    stage,
    error: error.message,
    stack: typeof error.stack === 'string' ? error.stack.split('\n').slice(0, 10).join('\n') : undefined,
    electron: process.versions.electron || null,
    outDirectory,
    artifacts,
    ipc: channels ? { frameChannel: channels.frame, readyChannel: channels.ready } : null,
    scenarios: scenarioResults,
    rendererConsole: consoleMessages,
    activeWindow: activeWindowLabel,
    snapshot: lastSnapshot,
    isolatedProfile: Boolean(profileRoot)
  }
  payload.evidence = evidencePath
  writeEvidence(payload)
  writeJson(2, payload)
  destroyActiveWindow()
  cleanProfile()
  exitProcess(1)
}

function exitProcess(code) {
  try {
    app.exit(code)
  } catch {
    process.exit(code)
  }
}

function writeEvidence(payload) {
  if (!evidencePath) return
  if (!writeEvidenceFile(evidencePath, payload)) {
    recordConsole('evidence', `could not write ${evidencePath}`)
  }
}

function writeEvidenceFile(file, payload) {
  try {
    const parent = path.dirname(file)
    if (parent && parent !== '.' && !fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true })
    }
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

function writeJson(fileDescriptor, payload) {
  const text = `${JSON.stringify(payload, null, 2)}\n`
  const reportFile = process.env[CHILD_REPORT_ENV]
  if (reportFile) {
    try {
      fs.writeFileSync(reportFile, text, 'utf8')
    } catch {
      // The bootstrap report is best-effort; stdout/stderr still carries JSON.
    }
  }
  try {
    fs.writeSync(fileDescriptor, text)
  } catch {
    // The process may already be tearing down.
  }
}

function recordConsole(level, message) {
  if (consoleMessages.length >= 24) return
  const line = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 400)
  if (line) consoleMessages.push({ level, message: line })
}

function parseColor(value) {
  const match = String(value || '').match(/rgba?\(([^)]+)\)/i)
  if (!match) return null
  const parts = match[1].split(',').map((part) => Number.parseFloat(part.trim()))
  if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null
  return {
    r: parts[0],
    g: parts[1],
    b: parts[2],
    alpha: parts.length >= 4 && Number.isFinite(parts[3]) ? parts[3] : 1
  }
}

function approximately(actual, expected, tolerance = 0.01) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
