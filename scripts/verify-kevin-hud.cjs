#!/usr/bin/env node
/**
 * KEVIN HUD renderer/preload smoke test.
 *
 * This is an independent Electron main process, not the launcher. It creates a
 * disposable userData/sessionData directory in the OS temp area, loads ONLY the
 * built KEVIN HUD entry (`out/renderer/hud.html`) with the dedicated HUD preload
 * (`out/preload/kevinHud.js`), and drives the real renderer through the real
 * preload over IPC with synthetic frames.
 *
 * It deliberately does not start the launcher, open an existing user profile,
 * inspect game directories, sample hardware, register a hotkey, or test the
 * production window's focus/click-through/lifecycle (the main-process service
 * owns those and verifies them separately).
 *
 * The fixture emulates the corrected native host contract: the BrowserWindow
 * stays at the configured 448x48 in every phase. The renderer grows from a
 * shorter plate into that exact height, keeps one sampled row, reveals items
 * from their measured anchor origin, and reverses the same elements on exit.
 *
 * Usage:
 *   node scripts/verify-kevin-hud.cjs [out-dir]
 *   node scripts/verify-kevin-hud.cjs --out <out-dir>
 *   node_modules/electron/dist/electron.exe scripts/verify-kevin-hud.cjs
 *
 * Running it with Node re-executes the same file with the repository's pinned
 * Electron. A successful run prints one JSON object and exits 0; any failure
 * prints one JSON object to stderr and exits non-zero. This smoke is read-only
 * and never builds or writes into the shared `out/` directory.
 */
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const SCRIPT_PATH = __filename
const REPORT_PREFIX = 'kl-kevin-hud-verify-'
const CHILD_REPORT_ENV = 'KEVIN_HUD_VERIFY_REPORT'
const MOTION_TOTAL_MS = 1180
const WIDTH = 448
const HEIGHT = 48
const OPEN_HEIGHT = 33
const OPEN_RADIUS = 17
const REVEAL_MAX_X = 30
const REVEAL_VERTICAL = 12

let electronApi = null
try {
  const loaded = require('electron')
  // In a normal Electron main process this is the API object. In Node, and in
  // Electron's ELECTRON_RUN_AS_NODE mode, it is the executable path instead.
  if (loaded && typeof loaded === 'object' && loaded.app && loaded.BrowserWindow) {
    electronApi = loaded
  }
} catch {
  // The bootstrap below reports a missing or unusable Electron installation.
}
if (!electronApi) {
  relaunchUnderElectron()
}

const { app, BrowserWindow, ipcMain } = electronApi

const APP_NAME = '合成 HUD 测试'
const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
  '<rect width="32" height="32" rx="7" fill="#2f81f7"/>' +
  '<path d="M8 22 16 8l8 14" fill="none" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>' +
  '</svg>'
const ICON_URL = `data:image/svg+xml,${encodeURIComponent(ICON_SVG)}`
const FONT_FAMILY = 'Segoe UI'
const FONT_FAMILY_EN = 'Kevin HUD Sans'
const FONT_FAMILY_ZH = 'Kevin HUD Han'
const MEMORY_TEXT = '9.7 / 31.3 GB · 31%'
const LEGACY_MEMORY_TEXT = '68%'

const BASE_CONFIG = {
  enabled: true,
  alwaysVisible: false,
  displaySeconds: 6,
  sampleSeconds: 1,
  direction: 'center',
  bounce: 0.275,
  ripple: 1,
  anchor: 'center',
  x: 50,
  y: 3,
  width: WIDTH,
  height: HEIGHT,
  radius: 24,
  borderWidth: 1,
  borderColor: '#223344',
  backgroundMode: 'solid',
  material: 'blur',
  backgroundColor: '#312F30',
  backgroundOpacity: 1,
  textColor: '#FFFFFF',
  iconColor: null,
  textOffsetX: 0,
  textOffsetY: 0,
  iconOffsetX: 0,
  iconOffsetY: 0,
  fontScale: 1,
  monitor: 'primary',
  autoWidth: false,
  restoreLauncher: true,
  hotkey: null,
  metrics: ['appName', 'appIcon', 'clock', 'fps', 'cpu', 'gpu']
}

const STYLED_CONFIG = {
  ...BASE_CONFIG,
  direction: 'left',
  radius: 12,
  borderWidth: 3,
  borderColor: '#FEDCBA',
  backgroundColor: '#654321',
  backgroundOpacity: 0.85,
  textColor: '#010203',
  iconColor: '#ABCDEF',
  textOffsetX: -11,
  textOffsetY: 4,
  iconOffsetX: 7,
  iconOffsetY: -3
}

const VALUES_MONITOR = {
  clock: '23:08',
  fps: '171 FPS',
  cpu: null,
  gpu: 'GPU 88%',
  memory: '不应出现'
}
const VALUES_REFRESH = {
  clock: '23:09',
  fps: '180',
  cpu: null,
  gpu: 'GPU 91%'
}

const EXPECTED_DIRECTIONS = {
  left: { x: '-28px', y: '0px', scale: '0.72' },
  right: { x: '28px', y: '0px', scale: '0.72' },
  top: { x: '0px', y: '-20px', scale: '0.72' },
  bottom: { x: '0px', y: '20px', scale: '0.72' },
  center: { x: '0px', y: '0px', scale: '0.6' }
}

const ALL_METRICS = [
  'appName',
  'appIcon',
  'clock',
  'fps',
  'cpu',
  'gpu',
  'memory',
  'download',
  'upload'
]

let stage = 'bootstrap'
let finished = false
let profileRoot = null
let profilePaths = null
let reportWindow = null
let reportArtifacts = null
let reportChannels = null
let readyHandlerChannel = null
let consoleMessages = []
let hardTimeout = null
let verificationStartedAt = Date.now()
let lastMotionDiagnostics = null

try {
  prepareProfile()
  app.setName('kevin-hud-smoke')
  app.setPath('userData', profilePaths.userData)
  app.setPath('sessionData', profilePaths.sessionData)
  app.setPath('crashDumps', profilePaths.crashDumps)
} catch (error) {
  writeJson(2, {
    ok: false,
    stage: 'prepare isolated profile',
    error: error instanceof Error ? error.message : String(error)
  })
  cleanProfile()
  process.exit(1)
}

process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)
process.on('exit', cleanProfile)
app.on('quit', cleanProfile)
app.on('window-all-closed', () => {
  // The fixture keeps the process alive until it has emitted its report.
})

app.whenReady()
  .then(run)
  .then(finishSuccess)
  .catch(fail)

/**
 * Node bootstrap. Running with the repository Electron keeps the test entirely
 * inside a disposable process and never loads `out/main/index.js`.
 */
function relaunchUnderElectron() {
  let executable = null
  try {
    const candidate = require('electron')
    if (typeof candidate === 'string') executable = candidate
  } catch {
    // Fall through to the conventional local installation below.
  }
  if (!executable) {
    const binary = process.platform === 'win32' ? 'electron.exe' : 'electron'
    executable = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', binary)
  }
  if (!executable || !fs.existsSync(executable)) {
    writeJson(2, {
      ok: false,
      error: 'Electron executable not found. Run npm install first or invoke the script with the repository Electron.',
      script: SCRIPT_PATH
    })
    process.exit(1)
    return
  }

  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const reportFile = path.join(
    os.tmpdir(),
    `kl-kevin-hud-verify-boot-${process.pid}-${Date.now()}.json`
  )
  environment[CHILD_REPORT_ENV] = reportFile
  const child = spawnSync(executable, [SCRIPT_PATH, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: environment,
    windowsHide: false
  })
  let reportWritten = false
  try {
    reportWritten = fs.statSync(reportFile).size > 0
  } catch {
    // The child did not get as far as emitting its JSON report.
  }
  try {
    fs.unlinkSync(reportFile)
  } catch {
    // It never existed or was already cleaned up.
  }

  if (child.error || !reportWritten) {
    writeJson(2, {
      ok: false,
      stage: 'electron bootstrap',
      error: child.error
        ? `Could not start Electron: ${child.error.message}`
        : `Electron exited before the verifier could emit its JSON report (exit code: ${
          child.status ?? 'none'
        }). Check that Electron 44 can start in this desktop session.`,
      electron: executable
    })
    process.exit(1)
    return
  }
  process.exit(typeof child.status === 'number' ? child.status : 1)
}

function prepareProfile() {
  profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), REPORT_PREFIX))
  const expectedParent = path.resolve(os.tmpdir())
  if (path.dirname(path.resolve(profileRoot)) !== expectedParent) {
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
  if (path.dirname(target) !== parent || !path.basename(target).startsWith(REPORT_PREFIX)) {
    return
  }
  try {
    fs.rmSync(target, { recursive: true, force: true })
    profileRoot = null
  } catch {
    // Chromium may still own a cache handle while the process is exiting; the
    // process 'exit' handler gets one final attempt.
  }
}

function parseArguments() {
  const values = process.argv.slice(2)
  let outArgument = null
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--out') {
      if (outArgument !== null || index + 1 >= values.length) {
        throw new Error('Usage: node scripts/verify-kevin-hud.cjs [--out] <out-dir>')
      }
      outArgument = values[index + 1]
      index += 1
      continue
    }
    if (value.startsWith('--out=')) {
      if (outArgument !== null || !value.slice('--out='.length)) {
        throw new Error('Usage: node scripts/verify-kevin-hud.cjs [--out] <out-dir>')
      }
      outArgument = value.slice('--out='.length)
      continue
    }
    if (value.startsWith('-')) {
      throw new Error(`Unknown argument: ${value}`)
    }
    if (outArgument !== null) {
      throw new Error('Only one output directory may be supplied.')
    }
    outArgument = value
  }

  const outDirectory = path.resolve(outArgument || path.join(__dirname, '..', 'out'))
  if (!fs.existsSync(outDirectory) || !fs.statSync(outDirectory).isDirectory()) {
    throw new Error(`Built output directory not found: ${outDirectory}. Run npm run build first.`)
  }
  return outDirectory
}

function artifact(file, label) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    throw new Error(`${label} not found: ${file}. Run npm run build first.`)
  }
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`${label} is not a non-empty file: ${file}.`)
  }
  return { path: path.resolve(file), bytes: stat.size }
}

/**
 * Find the real frame/ready channels in the built preload. The HUD contract
 * itself lives in `src/shared/kevinHud.ts`; this smoke intentionally follows
 * the channel compiled into the preload so it keeps testing the real receiver
 * even if the punctuation of the channel name is changed.
 */
function inspectChannels(preloadText) {
  const found = new Set()
  for (const match of preloadText.matchAll(/['"`](kevin[-_]?hud:[a-z-]+)['"`]/gi)) {
    found.add(match[1])
  }
  const channels = [...found]
  const frameChannels = channels.filter((channel) => /:frame$/i.test(channel))
  const readyChannels = channels.filter((channel) => /:ready$/i.test(channel))
  if (frameChannels.length !== 1) {
    throw new Error(
      `Could not identify exactly one KEVIN HUD frame channel in the preload (found: ${
        channels.join(', ') || 'none'
      }).`
    )
  }
  return {
    frame: frameChannels[0],
    ready: readyChannels.length === 1 ? readyChannels[0] : null
  }
}

function createFixtureWindow(preloadPath) {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
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
    title: 'Kevin HUD verification fixture',
    webPreferences: {
      preload: preloadPath,
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
    // Native window conveniences are not part of this smoke's assertions.
  }

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('preload-error', (_event, preload, error) => {
    recordConsole('preload-error', `${preload}: ${error instanceof Error ? error.message : String(error)}`)
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

function recordConsole(level, message) {
  if (consoleMessages.length >= 20) return
  const line = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 320)
  if (line) consoleMessages.push({ level, message: line })
}

async function run() {
  verificationStartedAt = Date.now()
  hardTimeout = setTimeout(() => {
    fail(new Error('KEVIN HUD smoke test exceeded its 50 second budget.'))
  }, 50_000)
  assert.equal(process.versions.electron.split('.')[0], '44', 'This smoke targets the repository Electron 44 runtime.')
  stage = 'validate arguments and built entries'
  const outDirectory = parseArguments()
  const rendererPath = path.join(outDirectory, 'renderer', 'hud.html')
  const preloadPath = path.join(outDirectory, 'preload', 'kevinHud.js')
  const renderer = artifact(rendererPath, 'KEVIN HUD renderer entry')
  const preload = artifact(preloadPath, 'KEVIN HUD preload')
  const channels = inspectChannels(fs.readFileSync(preloadPath, 'utf8'))
  reportArtifacts = {
    outDirectory,
    renderer: path.relative(outDirectory, renderer.path),
    rendererBytes: renderer.bytes,
    preload: path.relative(outDirectory, preload.path),
    preloadBytes: preload.bytes
  }
  reportChannels = channels

  const expectedUserData = path.resolve(profilePaths.userData)
  assert.equal(path.resolve(app.getPath('userData')), expectedUserData, 'The fixture must use its disposable userData path.')
  assert.equal(path.resolve(app.getPath('sessionData')), path.resolve(profilePaths.sessionData), 'The fixture must use its disposable sessionData path.')
  assert.equal(path.dirname(expectedUserData), path.resolve(profileRoot), 'The disposable profile must stay under the temp root.')

  if (channels.ready) {
    readyHandlerChannel = channels.ready
    ipcMain.handle(readyHandlerChannel, () => null)
  }

  stage = 'create fixture window'
  const win = createFixtureWindow(preloadPath)
  reportWindow = win

  const execute = (expression) => {
    if (win.isDestroyed()) return Promise.reject(new Error('HUD fixture window was destroyed.'))
    return win.webContents.executeJavaScript(expression, false)
  }
  const until = (expression, label, timeout = 5000) => untilTrue(execute, expression, label, timeout)
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  const hostHeight = () => win.getSize()[1]
  const assertHostHeight = (label) => {
    const [hostWidth, height] = win.getSize()
    assert.ok(approximately(hostWidth, WIDTH, 1), `${label}: host width must stay ${WIDTH}.`)
    assert.ok(approximately(height, HEIGHT, 1), `${label}: host height must stay ${HEIGHT} in every phase.`)
  }

  stage = 'load HUD entry'
  const entry = pathToFileURL(renderer.path)
  entry.searchParams.set('kevinHud', '1')
  await win.loadURL(entry.href)
  await until('document.readyState === "complete"', 'HUD document ready')

  stage = 'verify preload bridge and renderer isolation'
  await until(
    '!!window.kevinHud && typeof window.kevinHud.onFrame === "function"',
    'KEVIN HUD preload bridge'
  )
  const bridge = await execute(`(() => {
    const value = window.kevinHud
    return {
      exists: !!value,
      keys: value ? Object.keys(value).sort() : [],
      onFrame: typeof value?.onFrame,
      ready: typeof value?.ready,
      genericApi: typeof window.api,
      nodeRequire: typeof window.require,
      nodeProcess: typeof window.process,
      title: document.title
    }
  })()`)
  assert.deepEqual(bridge.keys, ['onFrame', 'ready'], 'The dedicated preload must expose only the narrow KEVIN HUD bridge.')
  assert.equal(bridge.onFrame, 'function')
  assert.equal(bridge.ready, 'function')
  assert.equal(bridge.genericApi, 'undefined', 'The HUD must not load the launcher\'s generic window.api preload.')
  assert.equal(bridge.nodeRequire, 'undefined', 'The HUD renderer must not have Node require().')
  assert.equal(bridge.nodeProcess, 'undefined', 'The HUD renderer must not expose the Node process object.')

  const preferences = win.webContents.getLastWebPreferences()
  assert.equal(preferences.sandbox, true, 'The HUD renderer must run sandboxed.')
  assert.equal(preferences.contextIsolation, true, 'The HUD renderer must use context isolation.')
  assert.equal(preferences.nodeIntegration, false, 'The HUD renderer must disable Node integration.')
  assert.equal(preferences.webviewTag, false, 'The HUD renderer must not enable webview tags.')
  if (preferences.preload) {
    assert.equal(
      path.resolve(String(preferences.preload)),
      path.resolve(preloadPath),
      'The renderer must use the dedicated HUD preload.'
    )
  }

  stage = 'show fixture without focus'
  win.showInactive()
  await sleep(120)

  const send = (frame) => {
    win.webContents.send(channels.frame, frame)
  }
  const frame = (phase, config, values) => ({
    phase,
    config: { ...config, metrics: [...config.metrics] },
    appName: APP_NAME,
    iconUrl: ICON_URL,
    fontFamily: FONT_FAMILY,
    fontFamilyEn: FONT_FAMILY_EN,
    fontFamilyZh: FONT_FAMILY_ZH,
    appGlass: null,
    values: { ...values }
  })

  stage = 'announce always shows icon + name and grows into the configured height'
  assertHostHeight('before announce')
  const reducedMotion = await execute('matchMedia("(prefers-reduced-motion: reduce)").matches')
  const announceConfig = {
    ...BASE_CONFIG,
    height: HEIGHT,
    metrics: ['clock', 'fps', 'cpu']
  }
  send(frame('announce', announceConfig, {
    clock: '23:08',
    fps: '171 FPS',
    cpu: '12%'
  }))
  await until('!!document.querySelector(".kevin-hud-root")', 'HUD root mounted', 7000).catch(() => {
    send(frame('announce', announceConfig, {}))
    return until('!!document.querySelector(".kevin-hud-root")', 'HUD root mounted after retry', 3000)
  })
  await until(
    `document.querySelector('.kevin-hud-app-name')?.textContent?.trim() === ${JSON.stringify(APP_NAME)}`,
    'announce app name',
    3000
  )
  await until(
    '(() => { const image = document.querySelector(".kevin-hud-icon-frame img.kevin-hud-icon-art"); return !!image && image.complete && image.naturalWidth > 0 })()',
    'synthetic app icon decoded',
    3000
  )

  if (!reducedMotion) {
    await until(
      `(() => {
        const surface = document.querySelector('.kevin-hud-surface')
        return !!surface && surface.getAnimations().some(
          (animation) => animation.animationName === 'kevin-hud-plate' && animation.playState === 'running'
        )
      })()`,
      'entrance plate animation running'
    )
    const opening = await readEntranceOpening(execute)
    assertOpeningPoseShorter(opening, 'entrance')
    assertHostHeight('mid entrance')
    await until(
      `(() => {
        const surface = document.querySelector('.kevin-hud-surface')
        const title = document.querySelector('.kevin-hud-title-motion')
        if (!surface || !title) return false
        const height = Number.parseFloat(getComputedStyle(surface).height)
        const opacity = Number(getComputedStyle(title).opacity)
        return Number.isFinite(height) && Math.abs(height - ${HEIGHT}) <= 0.6 && opacity > 0.99
      })()`,
      'settled entrance height and visible title',
      6000
    )
  }

  const announce = await readHudState(execute)
  assertHostHeight('settled announce')
  assert.equal(announce.phase, 'announce')
  assert.equal(announce.host, 'window')
  assert.equal(announce.appName, APP_NAME)
  assert.equal(announce.identity.present, true, 'Launch must announce the icon/name even when metrics omit them.')
  assert.equal(announce.identity.icon, 'true')
  assert.equal(announce.identity.name, 'true')
  assert.equal(announce.icon.kind, 'img')
  assert.ok(announce.icon.naturalWidth > 0, 'The synthetic icon must render from its data URL.')
  assert.equal(announce.metrics.length, 0, 'The title announcement must not show telemetry cells.')
  assert.equal(announce.tokens.height, `${HEIGHT}px`)
  assert.equal(announce.tokens.openHeight, `${OPEN_HEIGHT}px`)
  assert.equal(announce.tokens.baseHeight, `${HEIGHT}px`)
  assert.equal(announce.tokens.expandedHeight, `${HEIGHT}px`, 'There must be no 72px title peak.')
  assert.equal(announce.tokens.openRadius, `${OPEN_RADIUS}px`)
  assert.equal(announce.tokens.radius, '24px')
  assert.ok(approximately(Number.parseFloat(announce.surface.computedHeight), HEIGHT, 0.6), 'Settled entrance height must equal the configured height.')
  assert.ok(approximately(announce.surface.width, WIDTH, 1))
  assert.ok(approximately(announce.surface.height, HEIGHT, 1))
  assert.ok(announce.title.opacity > 0.99, 'The title must be visible when the timeline settles.')
  assert.ok(
    Number.parseFloat(announce.identity.originX) < 0,
    'A centre-anchored leading identity must reveal from the left.'
  )
  assert.ok(announce.font.faceStylePresent, 'The dedicated HUD document must receive the launcher font faces.')
  assert.ok(announce.font.latinFace, 'The English launcher font must be installed as a local @font-face.')
  assert.ok(announce.font.cjkFace, 'The Chinese launcher font must be installed as a local @font-face.')
  assert.ok(announce.font.appFont.includes('KevinLauncher Latin'))
  assert.ok(announce.font.appFont.includes('KevinLauncher CJK'))
  assert.ok(announce.font.surfaceFamily.includes('KevinLauncher Latin'))
  assert.equal(announce.font.inlineFontFamily, '', 'The legacy inline font stack override must be gone.')

  stage = 'settled monitor hides unselected identity and keeps one row'
  const noIdentityConfig = {
    ...BASE_CONFIG,
    metrics: ['clock', 'fps', 'cpu', 'gpu']
  }
  send(frame('monitor', noIdentityConfig, VALUES_MONITOR))
  await until(
    `(() => {
      const read = (metric) => document.querySelector('[data-cell="' + metric + '"] .kevin-hud-metric-value')?.textContent?.trim()
      return read('clock') === '23:08' && read('fps') === '171 FPS' && read('gpu') === 'GPU 88%'
    })()`,
    'monitor values'
  )
  await sleep(650)
  const noIdentity = await readHudState(execute)
  assertHostHeight('monitor without identity')
  assert.equal(noIdentity.phase, 'monitor')
  assert.equal(noIdentity.identity.present, false, 'Monitor identity appears only when selected.')
  assert.equal(noIdentity.cells.length, 4)
  assert.equal(noIdentity.bank.layout, 'single')
  assert.equal(noIdentity.bank.mode, 'metrics')
  assert.equal(noIdentity.bank.overflow, false, 'A short row must not animate overflow.')
  assert.equal(noIdentity.bank.trackAnimationName, 'none')
  assert.equal(noIdentity.surface.motion, 'enter', 'The settled surface keeps its finished entrance pose.')
  assert.equal(noIdentity.surface.exitMode, null)
  assert.ok(approximately(Number.parseFloat(noIdentity.surface.computedHeight), HEIGHT, 0.6))
  for (const cell of noIdentity.cells) {
    assert.ok(
      Math.abs(cell.top - noIdentity.cells[0].top) <= 1.5,
      'Every chosen sampled item must share one row.'
    )
  }

  stage = 'memory-only monitor uses the parsed readout'
  send(frame('monitor', { ...BASE_CONFIG, metrics: ['memory'] }, { memory: MEMORY_TEXT }))
  await until(
    '!!document.querySelector(".kevin-hud-memory-readout")',
    'memory readout'
  )
  await sleep(650)
  const memory = await readHudState(execute)
  assertHostHeight('memory-only monitor')
  assert.equal(memory.identity.present, false)
  assert.equal(memory.bank.mode, 'memory')
  assert.equal(memory.bank.layout, 'single')
  assert.equal(memory.memory.present, true)
  assert.equal(memory.memory.used, '9.7')
  assert.equal(memory.memory.total, '31.3')
  assert.equal(memory.memory.unit, 'GB')
  assert.equal(memory.memory.percent, '31%')
  assert.equal(memory.memory.progress, '31%')
  assert.equal(memory.memory.amounts, 'true')
  assert.equal(memory.memory.centerText, '', 'The memory readout must not paint a centre mark/label.')
  assert.equal(memory.cells.length, 0)
  assert.ok(memory.memory.ariaLabel.includes('9.7'))
  assert.ok(memory.memory.ariaLabel.includes('31.3'))

  send(frame('monitor', { ...BASE_CONFIG, metrics: ['memory'] }, { memory: LEGACY_MEMORY_TEXT }))
  await until(
    `document.querySelector('.kevin-hud-memory-readout__percent')?.textContent?.trim() === '68%'`,
    'legacy percent-only memory'
  )
  const legacyMemory = await readHudState(execute)
  assert.equal(legacyMemory.memory.amounts, 'false', 'Unavailable used/total values must be hidden rather than fabricated.')
  assert.equal(legacyMemory.memory.percent, '68%')
  assert.equal(legacyMemory.memory.centerText, '')

  stage = 'single-row overflow auto-scrolls only when needed'
  const manyConfig = {
    ...BASE_CONFIG,
    autoWidth: true,
    metrics: [...ALL_METRICS]
  }
  send(frame('monitor', manyConfig, {
    clock: '23:08',
    fps: '171 FPS',
    cpu: '12%',
    gpu: 'GPU 88%',
    memory: MEMORY_TEXT,
    download: '1.2 MB/s',
    upload: '48 KB/s'
  }))
  await until(
    `(() => {
      const bank = document.querySelector('.kevin-hud-bank')
      return bank?.dataset.overflow === 'true' && bank?.dataset.layout === 'single'
    })()`,
    'single-row overflow detection'
  )
  await sleep(500)
  const overflowing = await readHudState(execute)
  assertHostHeight('overflow monitor')
  assert.equal(overflowing.cells.length, 9)
  assert.deepEqual(
    overflowing.cells.map((cell) => cell.metric),
    ALL_METRICS,
    'Every selected metric, including icon and name, shares the single track in user order.'
  )
  assert.equal(
    overflowing.cells[0].ariaLabel,
    `应用名称：${APP_NAME}`,
    'The app name must remain a list item in the same single track, in configured order.'
  )
  assert.equal(
    overflowing.cells[1].ariaLabel,
    '应用图标',
    'The app icon must follow the app name in the same single track, not a separate identity row.'
  )
  assert.ok(
    overflowing.cells.every((cell) => Math.abs(cell.top - overflowing.cells[0].top) <= 1.5),
    'The app icon and name must share one row with every other selected metric.'
  )
  assert.equal(overflowing.bank.layout, 'single')
  assert.equal(overflowing.bank.overflow, true)
  assert.equal(overflowing.bank.autoWidthFallback, 'true', 'An auto-width host already clamped by the work area falls back to interior scrolling.')
  assert.ok(Number.parseFloat(overflowing.bank.overflowDistance) > 1)
  assert.ok(Number.parseFloat(overflowing.bank.overflowDistance) <= 4096)
  const overflowDurationMs = Number.parseFloat(overflowing.bank.overflowDuration)
  assert.ok(overflowDurationMs >= 7000)
  assert.ok(overflowDurationMs <= 20000)
  if (!reducedMotion) {
    assert.equal(overflowing.bank.trackAnimationName, 'kevin-hud-scroll', 'Only real overflow runs the CSS scroll animation.')
  }

  const fixedConfig = { ...manyConfig, autoWidth: false }
  send(frame('monitor', fixedConfig, {
    clock: '23:08',
    fps: '171 FPS',
    cpu: '12%',
    gpu: 'GPU 88%',
    memory: MEMORY_TEXT,
    download: '1.2 MB/s',
    upload: '48 KB/s'
  }))
  await until(
    'document.querySelector(".kevin-hud-bank")?.dataset.overflow === "true"',
    'fixed-width overflow'
  )
  const fixed = await readHudState(execute)
  assert.equal(fixed.bank.autoWidthFallback, null, 'A fixed-width row reports overflow directly, not the auto-width fallback flag.')
  assert.equal(fixed.bank.overflow, true)

  stage = 'alignment owns the measured reveal origin'
  for (const direction of ['left', 'right', 'top', 'bottom', 'center']) {
    const config = {
      ...BASE_CONFIG,
      direction,
      anchor: 'center',
      metrics: ['clock', 'fps', 'cpu', 'gpu']
    }
    send(frame('monitor', config, VALUES_MONITOR))
    await until(
      `document.querySelector('.kevin-hud-root')?.dataset.direction === ${JSON.stringify(direction)}`,
      `direction ${direction}`
    )
    await sleep(620)
    const state = await readHudState(execute)
    const expected = EXPECTED_DIRECTIONS[direction]
    assert.equal(state.direction, direction)
    assert.equal(state.enterX, expected.x, `direction ${direction} entry X vector`)
    assert.equal(state.enterY, expected.y, `direction ${direction} entry Y vector`)
    assert.equal(state.enterScale, expected.scale, `direction ${direction} entry scale`)
    assertHostHeight(`direction ${direction}`)
    assert.ok(approximately(state.surface.width, WIDTH, 1))
    assert.ok(approximately(Number.parseFloat(state.surface.computedHeight), HEIGHT, 0.6))
    assert.ok(state.reveal.length >= 4)
    for (const reveal of state.reveal) {
      assert.ok(Number.isFinite(Number.parseFloat(reveal.x)), 'Reveal X must be finite.')
      assert.ok(Math.abs(Number.parseFloat(reveal.x)) <= REVEAL_MAX_X)
      if (direction === 'top') assert.equal(reveal.y, `${-REVEAL_VERTICAL}px`)
      else if (direction === 'bottom') assert.equal(reveal.y, `${REVEAL_VERTICAL}px`)
      else assert.equal(reveal.y, '0px')
    }
  }

  stage = 'configured alignment, not the preset direction, owns horizontal origin'
  for (const anchor of ['left', 'center', 'right']) {
    send(
      frame(
        'monitor',
        {
          ...BASE_CONFIG,
          anchor,
          direction: 'center',
          metrics: ['clock', 'fps', 'cpu', 'gpu']
        },
        VALUES_MONITOR
      )
    )
    await until(
      `document.querySelector('.kevin-hud-root')?.dataset.anchor === ${JSON.stringify(anchor)}`,
      `anchor ${anchor}`
    )
    await sleep(620)
    const state = await readHudState(execute)
    const sample = state.reveal.filter((reveal) => reveal.kind === 'item')
    assert.ok(sample.length >= 4)
    if (anchor === 'left') {
      assert.ok(sample.every((reveal) => Number.parseFloat(reveal.x) < 0), 'Left alignment reveals rightwards for every item.')
    } else if (anchor === 'right') {
      assert.ok(sample.every((reveal) => Number.parseFloat(reveal.x) > 0), 'Right alignment mirrors the reveal.')
    } else {
      assert.ok(sample.some((reveal) => Number.parseFloat(reveal.x) < 0), 'Centre alignment sends left items left.')
      assert.ok(sample.some((reveal) => Number.parseFloat(reveal.x) > 0), 'Centre alignment sends right items right.')
    }
  }

  stage = 'warm the six-item monitor so newly selected cells finish entering'
  send(frame('monitor', BASE_CONFIG, VALUES_MONITOR))
  await until(
    `(() => {
      const cells = document.querySelectorAll('.kevin-hud-bank .kevin-hud-cell[data-cell]')
      if (cells.length !== 6) return false
      const read = (metric) => document.querySelector('[data-cell="' + metric + '"] .kevin-hud-metric-value')?.textContent?.trim()
      if (read('clock') !== '23:08' || read('fps') !== '171 FPS' || read('gpu') !== 'GPU 88%') return false
      return document.getAnimations().every(
        (animation) =>
          animation.playState !== 'running' ||
          !/^kevin-hud-(?:plate|icon|title|reveal|ripple)(?:-exit)?$/.test(animation.animationName || '')
      )
    })()`,
    'six selected monitor items entered',
    6000
  )
  await sleep(80)

  stage = 'ordinary value refresh must not replay the timeline'
  await execute(`(() => {
    const surface = document.querySelector('.kevin-hud-surface')
    const cell = document.querySelector('[data-cell="clock"]')
    const probe = { surface, cell, starts: [] }
    window.__kevinHudVerify = probe
    document.addEventListener('animationstart', (event) => {
      probe.starts.push({
        name: event.animationName || '',
        pseudoElement: event.pseudoElement || '',
        className: typeof event.target?.className === 'string' ? event.target.className : ''
      })
    }, true)
    return true
  })()`)
  send(frame('monitor', { ...BASE_CONFIG, direction: 'center' }, VALUES_REFRESH))
  await until(
    `(() => {
      const read = (metric) => document.querySelector('[data-cell="' + metric + '"] .kevin-hud-metric-value')?.textContent?.trim()
      return read('clock') === '23:09' && read('fps') === '180' && read('gpu') === 'GPU 91%'
    })()`,
    'refreshed monitor values'
  )
  await sleep(150)
  const refreshed = await readProbe(execute)
  const refreshedState = await readHudState(execute)
  assert.equal(refreshed.sameSurface, true, 'A normal value refresh must not replace the HUD surface.')
  assert.equal(refreshed.sameCell, true, 'A normal value refresh must not replace a sampled cell.')
  assert.deepEqual(refreshed.animationsStarted, [], 'A normal value refresh must not start a motion animation.')
  assert.deepEqual(refreshed.runningEntranceAnimations, [], 'A normal value refresh must not leave motion running.')
  assert.deepEqual(
    refreshedState.metrics.map((metric) => metric.value),
    ['23:09', '180', '--', 'GPU 91%']
  )

  stage = 'verify glass/color tokens and signed offsets without replaying motion'
  await execute('window.__kevinHudVerify.starts.length = 0; true')
  send(frame('monitor', STYLED_CONFIG, VALUES_MONITOR))
  await until(
    `(() => {
      const surface = document.querySelector('.kevin-hud-surface')
      const title =
      document.querySelector('.kevin-hud-title-block') ||
      document.querySelector('.kevin-hud-cell[data-cell="appName"] .kevin-hud-copy')
      const icon = document.querySelector('.kevin-hud-icon-frame')
      const read = (metric) => document.querySelector('[data-cell="' + metric + '"] .kevin-hud-metric-value')?.textContent?.trim()
      if (read('clock') !== '23:08' || read('fps') !== '171 FPS') return false
      const style = getComputedStyle(surface)
      return style.getPropertyValue('--khud-border-width').trim() === '3px' &&
        style.getPropertyValue('--khud-enter-x').trim() === '-28px' &&
        getComputedStyle(title).transform !== 'none' &&
        getComputedStyle(icon).transform !== 'none'
    })()`,
    'styled monitor values, direction and offsets'
  )
  await sleep(150)
  const styled = await readProbe(execute)
  const style = await readStyleState(execute)
  assert.equal(styled.sameSurface, true, 'A preview edit must not replace the HUD surface.')
  assert.deepEqual(styled.animationsStarted, [], 'A preview edit must not start a motion animation.')
  assert.deepEqual(styled.runningEntranceAnimations, [], 'A preview edit must not leave motion running.')

  assert.deepEqual(channelsOf(style.fillColor), [101, 67, 33])
  assert.ok(approximately(Number(style.fillOpacity), 0.85, 0.01), 'Background opacity must update.')
  assert.equal(style.requestedBorderWidth, '3px', 'The styled frame must request a 3px border exactly.')
  assertCssLengthWithinDeviceSnap(style.borderWidth, 3, style.devicePixelRatio, 'updated border width')
  assert.deepEqual(channelsOf(style.borderColor), [254, 220, 186])
  assert.equal(style.requestedRadius, '12px', 'The styled frame must request a 12px radius exactly.')
  assertCssLengthWithinDeviceSnap(style.borderRadius, 12, style.devicePixelRatio, 'updated border radius')
  assert.equal(style.designWidth, '448px')
  assert.equal(style.designHeight, '48px')
  assert.ok(approximately(style.boxWidth, WIDTH, 1))
  assert.ok(approximately(style.boxHeight, HEIGHT, 1))
  assert.deepEqual(channelsOf(style.appNameColor), [1, 2, 3])
  assert.deepEqual(channelsOf(style.metricColor), [1, 2, 3])
  assert.deepEqual(channelsOf(style.iconColor), [171, 205, 239])
  assert.equal(style.iconKind, 'tinted-svg')
  assertMatrix(style.textTransform, [1, 0, 0, 1, -11, 4], 'text offset transform')
  assertMatrix(style.iconTransform, [1, 0, 0, 1, 7, -3], 'icon offset transform')

  stage = 'settled exit reverses the same elements without remounting'
  const beforeExit = await readHudState(execute)
  const beforeExitSurface = await execute('window.__kevinHudVerify.surface = document.querySelector(".kevin-hud-surface"); window.__kevinHudVerify.cell = document.querySelector("[data-cell=\\"clock\\"]"); true')
  assert.equal(beforeExitSurface, true)
  await execute('window.__kevinHudVerify.starts.length = 0; true')
  send(frame('exit', STYLED_CONFIG, VALUES_MONITOR))
  await until(
    `document.querySelector('.kevin-hud-root')?.dataset.phase === 'exit'`,
    'exit phase'
  )
  await until(
    `document.querySelector('.kevin-hud-surface')?.dataset.exitMode === ${JSON.stringify(
      reducedMotion ? 'reduced' : 'restart'
    )}`,
    'settled exit mode',
    3000
  )
  const exitState = await readHudState(execute)
  assertHostHeight('settled exit')
  assert.equal(exitState.phase, 'exit')
  assert.equal(exitState.exitFrom, 'monitor')
  assert.equal(exitState.rootAriaHidden, 'true')
  assert.equal(exitState.surface.exitMode, reducedMotion ? 'reduced' : 'restart')
  if (reducedMotion) {
    assert.notEqual(exitState.surface.motion, '')
    await until(
      `(() => {
        const style = getComputedStyle(document.querySelector('.kevin-hud-surface'))
        return Number(style.opacity) < 0.02 || style.visibility === 'hidden'
      })()`,
      'exit hidden under reduced motion',
      3000
    )
  } else {
    assert.equal(exitState.surface.motion, 'exit')
    if (exitState.bank.overflow) {
      assert.equal(
        exitState.bank.trackPlayState,
        'paused',
        'Overflow auto-scroll must pause while the HUD exits.'
      )
    }
    assert.equal(exitState.surface.animationName, 'kevin-hud-plate-exit', 'Settled exit must start the reverse alias on the same node.')
    assert.equal(exitState.surface.animationDirection, 'reverse', 'Exit must play the timeline in reverse.')
    assert.ok(exitState.surface.opacity > 0.5, 'The settled exit starts from the visible pose, not an instant disappearance.')
    assert.deepEqual(exitState.reveal.map((item) => [item.kind, item.x, item.y, item.delay]), beforeExit.reveal.map((item) => [item.kind, item.x, item.y, item.delay]), 'Exit reuses the measured reveal origins on the same elements.')
    await until(
      `Number(getComputedStyle(document.querySelector('.kevin-hud-surface')).opacity) < 0.02`,
      'reverse exit finish',
      MOTION_TOTAL_MS + 1000
    )
  }
  const exitFinal = await readHudState(execute)
  assert.ok(exitFinal.surface.opacity < 0.02, 'Exit must finish with the surface hidden.')
  const exitProbe = await readProbe(execute)
  assert.equal(
    exitProbe.sameSurface,
    true,
    'The reverse exit must run on the same mounted surface, not a remounted copy.'
  )
  assert.equal(exitProbe.sameCell, true, 'The reverse exit must keep the same sampled cell elements.')
  if (!reducedMotion) {
    assert.ok(
      exitProbe.animationsStarted.some((event) => event.name === 'kevin-hud-plate-exit'),
      'Exit should report the fresh reverse plate alias starting on the same element.'
    )
    assert.ok(
      exitProbe.animationsStarted.some((event) => event.name === 'kevin-hud-reveal-exit'),
      'Exit should reverse the measured in-track metrics too.'
    )
  }

  stage = 'transient announce -> exit reverses the live CSS animation clock'
  let transientExitResult = reducedMotion
    ? { skippedBecauseReducedMotion: true }
    : null
  if (!reducedMotion) {
    send(frame('announce', announceConfig, {}))
    await until(`document.querySelector('.kevin-hud-root')?.dataset.phase === 'announce'`, 'second announce', 3000)
    await until(
      `(() => {
        const surface = document.querySelector('.kevin-hud-surface')
        return !!surface && surface.getAnimations().some(
          (animation) => animation.animationName === 'kevin-hud-plate' && animation.playState === 'running'
        )
      })()`,
      'second announcement animation running'
    )
    const transientOpening = await readEntranceOpening(execute)
    assert.ok(
      Number.isFinite(transientOpening.startTime),
      'The entrance animation must expose a start time.'
    )
    assertOpeningPoseShorter(transientOpening, 'transient announcement')

    // Close partway through the 1180ms entrance so reverse() has a real
    // mid-flight clock to preserve. These probes only read the animation; they
    // never seek, pause or otherwise mutate it.
    const midFlight = await until(
      `(() => {
        const probe = window.__kevinHudClock
        const animation = probe && probe.animation
        const surface = document.querySelector('.kevin-hud-surface')
        if (!animation || !surface || probe.surface !== surface) return false
        if (animation.playState !== 'running') return false
        const now = Number(animation.currentTime)
        if (!Number.isFinite(now) || now < 350 || now > 1000) return false
        const timing = animation.effect && animation.effect.getTiming
          ? animation.effect.getTiming()
          : null
        return {
          sameSurface: true,
          name: animation.animationName || '',
          startTime: animation.startTime === null ? null : Number(animation.startTime),
          currentTime: now,
          duration: timing ? Number(timing.duration) : NaN,
          playbackRate: Number(animation.playbackRate),
          playState: animation.playState,
          cssDirection: getComputedStyle(surface).animationDirection
        }
      })()`,
      'mid-flight entrance progress',
      6000
    )
    assert.equal(midFlight.sameSurface, true)
    assert.equal(midFlight.name, 'kevin-hud-plate')
    assert.equal(midFlight.playState, 'running', 'The transient close must happen mid-flight.')
    assert.ok(
      approximately(midFlight.playbackRate, 1, 0.01),
      'The entrance must still play forward before the transient close.'
    )
    assert.ok(midFlight.currentTime >= 350, 'The transient close must preserve real mid-flight progress.')
    assert.equal(midFlight.cssDirection, 'normal')

    const midFlightCapturedAt = Date.now()
    send(frame('exit', announceConfig, {}))
    await until(
      `document.querySelector('.kevin-hud-surface')?.dataset.exitMode === 'clock'`,
      'clock-preserving exit mode',
      3000
    )
    const clockExit = await until(
      `(() => {
        const probe = window.__kevinHudClock
        const surface = document.querySelector('.kevin-hud-surface')
        const title = document.querySelector('.kevin-hud-title-motion')
        const animation = probe && probe.animation
        const current = surface
          ? surface.getAnimations().find((item) => item.animationName === 'kevin-hud-plate')
          : null
        if (!animation || animation !== current) return false
        if (current.pending) return false
        const playbackRate = Number(current.playbackRate)
        const currentTime = Number(current.currentTime)
        if (!(playbackRate < 0) || !(currentTime > 0)) return false
        const style = getComputedStyle(surface)
        const timing = current.effect && current.effect.getTiming
          ? current.effect.getTiming()
          : null
        return {
          sameSurface: probe.surface === surface,
          sameTitle: probe.title === title,
          sameAnimation: probe.animation === current,
          cssAnimation:
            typeof CSSAnimation !== 'undefined' && current instanceof CSSAnimation,
          animationName: current.animationName || '',
          playbackRate,
          currentTime,
          beforeCurrentTime: Number(probe.currentTime),
          duration: timing ? Number(timing.duration) : NaN,
          startTime: current.startTime === null ? null : Number(current.startTime),
          playState: current.playState,
          pending: current.pending,
          cssDirection: style.animationDirection,
          exitMode: surface.dataset.exitMode || '',
          exitClock: surface.dataset.exitClock || '',
          motion: surface.dataset.motion || '',
          opacity: Number(style.opacity),
          phase: document.querySelector('.kevin-hud-root')?.dataset.phase || ''
        }
      })()`,
      'reversed Web Animations clock',
      3000
    )
    const clockExitReadAt = Date.now()
    assert.equal(clockExit.phase, 'exit')
    assert.equal(clockExit.exitMode, 'clock')
    assert.equal(clockExit.exitClock, 'true')
    assert.equal(clockExit.motion, 'enter', 'A transient close keeps the existing animation instead of remounting it.')
    assert.equal(clockExit.sameSurface, true, 'The transient close must keep the same surface element.')
    assert.equal(clockExit.sameTitle, true, 'The transient close must keep the same title element.')
    assert.equal(clockExit.sameAnimation, true, 'The transient close must reuse the same CSSAnimation object.')
    assert.equal(clockExit.cssAnimation, true, 'The reused animation must still be a CSSAnimation.')
    assert.equal(clockExit.animationName, 'kevin-hud-plate')
    assert.equal(
      clockExit.cssDirection,
      'normal',
      'Mid-flight reversal must keep animation-direction normal; playbackRate carries the reverse.'
    )
    assert.ok(clockExit.playbackRate < 0, 'A transient close must reverse the Web Animations playback rate.')
    assert.ok(
      approximately(clockExit.playbackRate, -1, 0.01),
      `The reversed entrance must play back at -1x (read ${clockExit.playbackRate}).`
    )
    assert.equal(clockExit.pending, false, 'The reversed Web Animations clock must be active, not pending.')
    assert.ok(clockExit.currentTime > 0, 'The transient close must not reset the animation clock.')
    const allowedDrift = Math.max(0, clockExitReadAt - midFlightCapturedAt) + 120
    assert.ok(
      clockExit.currentTime <= midFlight.currentTime + allowedDrift,
      `A transient close must not jump forward (before ${midFlight.currentTime}ms, after ${clockExit.currentTime}ms).`
    )
    assert.ok(
      clockExit.currentTime >= midFlight.currentTime - allowedDrift,
      `A transient close must not jump backward/reset (before ${midFlight.currentTime}ms, after ${clockExit.currentTime}ms).`
    )
    assert.ok(clockExit.opacity > 0.02, 'A transient close must not instantly disappear.')
    assertHostHeight('transient exit')

    await sleep(140)
    const clockAfter = await execute(`(() => {
      const probe = window.__kevinHudClock
      const surface = document.querySelector('.kevin-hud-surface')
      const animation = probe && probe.animation
      const current = surface
        ? surface.getAnimations().find((item) => item.animationName === 'kevin-hud-plate')
        : null
      const style = surface ? getComputedStyle(surface) : null
      return {
        sameSurface: !!probe && probe.surface === surface,
        sameAnimation: !!animation && animation === current,
        currentTime: Number(current && current.currentTime),
        playbackRate: Number(current && current.playbackRate),
        playState: current?.playState ?? '',
        opacity: style ? Number(style.opacity) : 0,
        exitMode: surface?.dataset.exitMode ?? ''
      }
    })()`)
    assert.equal(clockAfter.sameSurface, true, 'The reversed clock must stay on the same surface.')
    assert.equal(clockAfter.sameAnimation, true, 'The reversed clock must stay on the same CSSAnimation.')
    assert.equal(clockAfter.exitMode, 'clock')
    assert.ok(clockAfter.playbackRate < 0)
    assert.ok(
      clockAfter.currentTime < clockExit.currentTime,
      `The reversed clock must decrease (first ${clockExit.currentTime}ms, later ${clockAfter.currentTime}ms).`
    )
    await until(
      `Number(getComputedStyle(document.querySelector('.kevin-hud-surface')).opacity) < 0.02`,
      'transient reverse finish',
      MOTION_TOTAL_MS + 1000
    )
    transientExitResult = {
      mode: clockExit.exitMode,
      exitClock: clockExit.exitClock,
      sameSurface: clockExit.sameSurface,
      sameTitle: clockExit.sameTitle,
      sameAnimation: clockExit.sameAnimation,
      cssAnimation: clockExit.cssAnimation,
      playbackRate: clockExit.playbackRate,
      cssDirection: clockExit.cssDirection,
      durationMs: clockExit.duration,
      currentTimeMs: {
        before: midFlight.currentTime,
        first: clockExit.currentTime,
        later: clockAfter.currentTime
      },
      decreasingCurrentTime: clockAfter.currentTime < clockExit.currentTime,
      immediateOpacityVisible: clockExit.opacity > 0.02
    }
  } else {
    send(frame('announce', announceConfig, {}))
    await until(`document.querySelector('.kevin-hud-root')?.dataset.phase === 'announce'`, 'second announce under reduced motion', 3000)
    send(frame('exit', announceConfig, {}))
    await until(`document.querySelector('.kevin-hud-root')?.dataset.phase === 'exit'`, 'reduced-motion exit', 3000)
    await sleep(60)
  }

  const final = await readHudState(execute)
  return {
    ok: true,
    electron: process.versions.electron,
    platform: `${process.platform}-${process.arch}`,
    isolatedProfile: {
      userData: true,
      sessionData: true,
      disposable: true
    },
    artifacts: reportArtifacts,
    ipc: {
      frameChannel: channels.frame,
      readyChannel: channels.ready,
      readyHandlerRegistered: Boolean(readyHandlerChannel)
    },
    renderer: {
      title: bridge.title,
      genericWindowApi: bridge.genericApi,
      bridgeKeys: bridge.keys,
      nodeRequire: bridge.nodeRequire,
      nodeProcess: bridge.nodeProcess,
      sandbox: preferences.sandbox,
      contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
      webviewTag: preferences.webviewTag,
      dedicatedPreload: true
    },
    host: {
      width: WIDTH,
      height: HEIGHT,
      stableAcrossPhases: true
    },
    announce: {
      appName: announce.appName,
      identityAlwaysVisible: announce.identity.present,
      identityOnly: announce.metrics.length === 0,
      height: announce.tokens.height,
      openHeight: announce.tokens.openHeight,
      expandedHeight: announce.tokens.expandedHeight,
      openRadius: announce.tokens.openRadius,
      settledHeight: announce.surface.computedHeight,
      identityOriginX: announce.identity.originX,
      animationName: announce.surface.animationName,
      iconLoaded: true
    },
    fonts: {
      faceStylePresent: announce.font.faceStylePresent,
      latinFace: announce.font.latinFace,
      cjkFace: announce.font.cjkFace,
      appFont: announce.font.appFont,
      inlineStackRemoved: announce.font.inlineFontFamily === ''
    },
    monitor: {
      phase: noIdentity.phase,
      order: noIdentity.cells.map((cell) => cell.metric),
      metrics: noIdentity.metrics,
      identityHiddenWhenUnselected: !noIdentity.identity.present,
      height: noIdentity.surface.computedHeight
    },
    memory: {
      readout: memory.memory.present,
      used: memory.memory.used,
      total: memory.memory.total,
      percent: memory.memory.percent,
      gauge: memory.memory.progress,
      centerMark: memory.memory.centerText,
      legacyAmountsHidden: legacyMemory.memory.amounts === 'false'
    },
    singleRowOverflow: {
      layout: overflowing.bank.layout,
      cells: overflowing.cells.length,
      overflow: overflowing.bank.overflow,
      distance: overflowing.bank.overflowDistance,
      duration: overflowing.bank.overflowDuration,
      autoWidthFallback: overflowing.bank.autoWidthFallback,
      fixedWidthOverflow: fixed.bank.overflow,
      scrollAnimation: overflowing.bank.trackAnimationName,
      oneRow: overflowing.cells.every(
        (cell) => Math.abs(cell.top - overflowing.cells[0].top) <= 1.5
      )
    },
    refresh: {
      ordinaryValues: {
        animationsStarted: refreshed.animationsStarted,
        runningEntranceAnimations: refreshed.runningEntranceAnimations,
        sameSurface: refreshed.sameSurface,
        sameCell: refreshed.sameCell,
        visibleValues: refreshedState.metrics.map((metric) => metric.value)
      },
      colorsAndOffsets: {
        animationsStarted: styled.animationsStarted,
        runningEntranceAnimations: styled.runningEntranceAnimations,
        sameSurface: styled.sameSurface,
        designWidth: style.designWidth,
        designHeight: style.designHeight,
        renderedWidth: style.boxWidth,
        renderedHeight: style.boxHeight,
        borderWidth: style.borderWidth,
        borderRadius: style.borderRadius,
        offsets: {
          textTransform: style.textTransform,
          iconTransform: style.iconTransform
        }
      }
    },
    exit: {
      phase: exitState.phase,
      exitFrom: exitState.exitFrom,
      mode: exitState.surface.exitMode,
      animationName: exitState.surface.animationName,
      animationDirection: exitState.surface.animationDirection,
      finalOpacity: exitFinal.surface.opacity,
      sameSurface: exitProbe.sameSurface,
      sameCell: exitProbe.sameCell,
      reusedOrigins: exitState.reveal.every(
        (item, index) =>
          beforeExit.reveal[index] &&
          item.x === beforeExit.reveal[index].x &&
          item.y === beforeExit.reveal[index].y
      ),
      reversedSteps: exitProbe.animationsStarted
        .map((event) => event.name)
        .filter((name) => /^kevin-hud-(?:plate|icon|title|reveal|ripple)-exit$/.test(name))
    },
    transientExit: transientExitResult,
    motion: {
      prefersReducedMotion: Boolean(reducedMotion),
      durationMs: MOTION_TOTAL_MS,
      nativeCloseDelayMs: MOTION_TOTAL_MS,
      overflowDurationMs: [7000, 20000],
      revealMaxX: REVEAL_MAX_X
    },
    rendererConsole: consoleMessages,
    finalPhase: final.phase,
    notes: [
      'Synthetic frames only; no hardware sampling, game directories, hotkeys or existing user profile were touched.',
      'Native focus/click-through/lifecycle belongs to the main-process HUD service and is intentionally not asserted here.',
      'The fixture keeps a 448x48 native host in every phase, matching the corrected fixed-height host contract.'
    ]
  }
}

async function untilTrue(execute, expression, label, timeout) {
  const deadline = Date.now() + timeout
  let lastError = null
  while (Date.now() < deadline) {
    if (finished) throw new Error(`Verification stopped while waiting for ${label}.`)
    try {
      const value = await execute(expression)
      if (value) {
        lastMotionDiagnostics = null
        return value
      }
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  let visible = ''
  try {
    visible = await execute('document.body?.innerText?.slice(0, 240) || ""')
  } catch {
    // The page may already be gone.
  }
  try {
    lastMotionDiagnostics = {
      waitFor: label,
      timeoutMs: timeout,
      fixture: readFixtureDiagnostics(),
      renderer: await readMotionDiagnostics(execute)
    }
  } catch (error) {
    lastMotionDiagnostics = {
      waitFor: label,
      timeoutMs: timeout,
      fixture: readFixtureDiagnostics(),
      rendererError: error instanceof Error ? error.message : String(error)
    }
  }
  const suffix = [
    visible ? `visible text: ${JSON.stringify(visible)}` : '',
    lastError ? `last browser error: ${lastError.message}` : ''
  ].filter(Boolean).join('; ')
  const diagnostics = lastMotionDiagnostics
    ? `; motion diagnostics: ${JSON.stringify(lastMotionDiagnostics)}`
    : ''
  throw new Error(`Timed out waiting for ${label}${suffix ? ` (${suffix})` : ''}${diagnostics}.`)
}

/**
 * Main-process half of the failure snapshot. The renderer's document timeline
 * can be paused when a fixture window is hidden, occluded or minimised, so the
 * native window state is needed to tell that apart from a renderer that failed
 * to settle.
 */
function readFixtureDiagnostics() {
  const win = reportWindow
  if (!win) return { destroyed: null, reason: 'window not created' }
  let destroyed = null
  try {
    destroyed = win.isDestroyed()
  } catch (error) {
    return {
      destroyed: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
  if (destroyed) return { destroyed: true }
  const result = { destroyed: false }
  try {
    result.bounds = win.getBounds()
  } catch (error) {
    result.boundsError = error instanceof Error ? error.message : String(error)
  }
  try {
    result.visible = win.isVisible()
  } catch (error) {
    result.visibleError = error instanceof Error ? error.message : String(error)
  }
  try {
    result.focused = win.isFocused()
  } catch (error) {
    result.focusedError = error instanceof Error ? error.message : String(error)
  }
  try {
    result.minimized = win.isMinimized()
  } catch (error) {
    result.minimizedError = error instanceof Error ? error.message : String(error)
  }
  try {
    const contents = win.webContents
    result.rendererDestroyed = contents.isDestroyed()
    result.backgroundThrottling =
      typeof contents.getBackgroundThrottling === 'function'
        ? contents.getBackgroundThrottling()
        : null
  } catch (error) {
    result.contentsError = error instanceof Error ? error.message : String(error)
  }
  return result
}

/**
 * Read-only renderer half of the failure snapshot. It reports the computed
 * surface/title geometry and opacity, the viewport, every live animation's
 * name/clock/duration/playState/pending/playbackRate and the root/surface data
 * attributes. It never seeks, pauses or otherwise mutates an animation, so it
 * can run at any point without changing what is under test.
 */
async function readMotionDiagnostics(execute) {
  return execute(`(() => {
    const errorText = (error) => String((error && error.message) || error)
    const datasetOf = (element) => {
      const values = {}
      if (!element || !element.dataset) return values
      for (const key of Object.keys(element.dataset)) values[key] = element.dataset[key]
      return values
    }
    const timingOf = (animation) => {
      try {
        const timing = animation.effect && animation.effect.getTiming
          ? animation.effect.getTiming()
          : null
        if (!timing) return null
        return {
          duration: timing.duration,
          delay: timing.delay,
          endDelay: timing.endDelay,
          direction: timing.direction,
          fill: timing.fill,
          iterations: timing.iterations,
          easing: timing.easing
        }
      } catch (error) {
        return { error: errorText(error) }
      }
    }
    const targetOf = (animation) => {
      try {
        const target = animation.effect && animation.effect.target
        if (!target) return null
        return {
          tag: target.tagName || '',
          className: typeof target.className === 'string' ? target.className : '',
          cell: target.getAttribute ? target.getAttribute('data-cell') : null
        }
      } catch (error) {
        return { error: errorText(error) }
      }
    }
    const animationOf = (animation) => {
      const timing = timingOf(animation)
      return {
        type: animation.constructor ? animation.constructor.name : '',
        name: animation.animationName || '',
        id: animation.id || '',
        playState: animation.playState,
        pending: animation.pending,
        playbackRate: animation.playbackRate,
        startTime: animation.startTime === null ? null : Number(animation.startTime),
        currentTime: animation.currentTime === null ? null : Number(animation.currentTime),
        duration: timing && timing.duration,
        delay: timing && timing.delay,
        direction: timing && timing.direction,
        fill: timing && timing.fill,
        iterations: timing && timing.iterations,
        target: targetOf(animation)
      }
    }
    const root = document.querySelector('.kevin-hud-root')
    const surface = document.querySelector('.kevin-hud-surface')
    const title = document.querySelector('.kevin-hud-title-motion')
    const surfaceStyle = surface ? getComputedStyle(surface) : null
    const titleStyle = title ? getComputedStyle(title) : null
    const surfaceRect = surface ? surface.getBoundingClientRect() : null
    const titleRect = title ? title.getBoundingClientRect() : null
    const tokens = {}
    if (surfaceStyle) {
      const names = [
        '--khud-width',
        '--khud-height',
        '--khud-open-height',
        '--khud-base-height',
        '--khud-expanded-height',
        '--khud-radius',
        '--khud-open-radius',
        '--khud-motion-duration',
        '--khud-reveal-duration',
        '--khud-enter-x',
        '--khud-enter-y',
        '--khud-enter-scale'
      ]
      for (const name of names) tokens[name] = surfaceStyle.getPropertyValue(name).trim()
    }
    let documentAnimations = []
    try {
      documentAnimations = document.getAnimations().map(animationOf)
    } catch (error) {
      documentAnimations = [{ error: errorText(error) }]
    }
    let surfaceAnimations = []
    if (surface) {
      try {
        surfaceAnimations = surface.getAnimations({ subtree: true }).map(animationOf)
      } catch (error) {
        surfaceAnimations = [{ error: errorText(error) }]
      }
    }
    let hasFocus = null
    try {
      hasFocus = document.hasFocus()
    } catch (error) {
      hasFocus = 'error: ' + errorText(error)
    }
    return {
      capturedAt: Date.now(),
      document: {
        readyState: document.readyState,
        visibilityState: document.visibilityState,
        hidden: document.hidden,
        hasFocus,
        timelineCurrentTime:
          document.timeline && document.timeline.currentTime !== null
            ? Number(document.timeline.currentTime)
            : null,
        performanceNow: Number(performance.now()),
        animationCount: documentAnimations.length
      },
      viewport: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        screenX: window.screenX,
        screenY: window.screenY,
        screenWidth: screen.width,
        screenHeight: screen.height,
        availableWidth: screen.availWidth,
        availableHeight: screen.availHeight
      },
      root: root
        ? {
            className: root.className,
            ariaHidden: root.getAttribute('aria-hidden'),
            dataset: datasetOf(root)
          }
        : null,
      surface: surface
        ? {
            className: surface.className,
            dataset: datasetOf(surface),
            inlineStyle: surface.getAttribute('style') || '',
            rect: {
              width: surfaceRect.width,
              height: surfaceRect.height,
              top: surfaceRect.top,
              left: surfaceRect.left
            },
            offsetHeight: surface.offsetHeight,
            clientHeight: surface.clientHeight,
            scrollHeight: surface.scrollHeight,
            computed: {
              width: surfaceStyle.width,
              height: surfaceStyle.height,
              opacity: Number(surfaceStyle.opacity),
              visibility: surfaceStyle.visibility,
              display: surfaceStyle.display,
              transform: surfaceStyle.transform,
              animationName: surfaceStyle.animationName,
              animationDirection: surfaceStyle.animationDirection,
              animationDuration: surfaceStyle.animationDuration,
              animationDelay: surfaceStyle.animationDelay,
              animationPlayState: surfaceStyle.animationPlayState,
              animationFillMode: surfaceStyle.animationFillMode
            },
            tokens
          }
        : null,
      title: title
        ? {
            className: title.className,
            text: title.textContent ? title.textContent.trim().slice(0, 160) : '',
            dataset: datasetOf(title),
            inlineStyle: title.getAttribute('style') || '',
            rect: {
              width: titleRect.width,
              height: titleRect.height,
              top: titleRect.top,
              left: titleRect.left
            },
            computed: {
              width: titleStyle.width,
              height: titleStyle.height,
              opacity: Number(titleStyle.opacity),
              visibility: titleStyle.visibility,
              display: titleStyle.display,
              transform: titleStyle.transform,
              animationName: titleStyle.animationName,
              animationDirection: titleStyle.animationDirection,
              animationDuration: titleStyle.animationDuration,
              animationDelay: titleStyle.animationDelay,
              animationPlayState: titleStyle.animationPlayState
            }
          }
        : { present: false },
      animations: {
        document: documentAnimations,
        surfaceSubtree: surfaceAnimations
      }
    }
  })()`)
}

/**
 * Inspect the live entrance plate without depending on `animationstart`.
 * A hidden fixture may already report a running CSS animation before that
 * event is dispatched. The probe never seeks or writes the animation clock: it
 * derives the 0% pose from the active keyframes and snapshots the real clock
 * for the reverse check. No production markup or timer is involved.
 */
async function readEntranceOpening(execute) {
  return execute(`(() => {
    // A probe from an earlier phase must never satisfy this measurement.
    delete window.__kevinHudClock

    const root = document.querySelector('.kevin-hud-root')
    const phase = root?.dataset.phase ?? ''
    const surface = document.querySelector('.kevin-hud-surface')
    if (!surface) return { present: false, phase, reason: 'surface missing' }

    const animation = surface
      .getAnimations()
      .find((item) => item.animationName === 'kevin-hud-plate')
    if (!animation) return { present: false, phase, reason: 'kevin-hud-plate missing' }

    const style = getComputedStyle(surface)
    const configuredHeight = Number.parseFloat(style.getPropertyValue('--khud-height'))
    const openHeight = Number.parseFloat(style.getPropertyValue('--khud-open-height'))
    let keyframeHeight = NaN
    let keyframeCount = 0
    let keyframesError = ''
    try {
      const keyframes = animation.effect?.getKeyframes?.() ?? []
      keyframeCount = keyframes.length
      if (keyframes.length > 0) {
        const authored = keyframes[0].height
        keyframeHeight = Number.parseFloat(authored)
        if (!Number.isFinite(keyframeHeight) && typeof authored === 'string') {
          // Chromium can surface the unresolved var() reference in CSSOM.
          const token = /var\\(\\s*(--[\\w-]+)/.exec(authored)
          if (token) keyframeHeight = Number.parseFloat(style.getPropertyValue(token[1]))
        }
      }
    } catch (error) {
      keyframesError = String(error?.message || error)
    }

    const playState = animation.playState
    const startTime = animation.startTime
    const currentTime = animation.currentTime
    const title = document.querySelector('.kevin-hud-title-motion')
    let duration = NaN
    try {
      const timing = animation.effect?.getTiming?.()
      duration = timing ? Number(timing.duration) : NaN
    } catch {
      // The clock itself remains inspectable even when timing is not.
    }

    window.__kevinHudClock = {
      surface,
      title,
      animation,
      playState,
      playbackRate: animation.playbackRate,
      pending: animation.pending,
      startTime: Number(startTime),
      currentTime: Number(currentTime),
      duration
    }
    return {
      present: true,
      phase,
      motion: surface.dataset.motion ?? '',
      animationName: animation.animationName || '',
      animationDirection: animation.effect?.getTiming?.().direction ?? '',
      playState,
      playbackRate: animation.playbackRate,
      pending: animation.pending,
      duration,
      configuredHeight,
      openHeight,
      keyframeHeight,
      keyframeCount,
      keyframesError,
      startTime: Number(startTime),
      currentTime: Number(currentTime)
    }
  })()`)
}

function assertOpeningPoseShorter(opening, label) {
  assert.equal(opening.present, true, `${label}: the active entrance plate must be inspectable.`)
  assert.equal(opening.phase, 'announce', `${label}: the probe must run on the announcement phase.`)
  assert.equal(
    opening.animationName,
    'kevin-hud-plate',
    `${label}: the active plate animation must be the entrance.`
  )
  assert.ok(
    approximately(opening.configuredHeight, HEIGHT, 0.01),
    `${label}: the configured height token must resolve to ${HEIGHT}px ` +
      `(read ${opening.configuredHeight}).`
  )
  assert.ok(
    Number.isFinite(opening.keyframeHeight) &&
      opening.keyframeHeight >= 16 &&
      opening.keyframeHeight < opening.configuredHeight,
    `${label}: the 0% keyframe must start shorter than the configured ${HEIGHT}px ` +
      `(keyframe ${opening.keyframeHeight}, ${opening.keyframeCount} keyframes` +
      `${opening.keyframesError ? `, ${opening.keyframesError}` : ''}).`
  )
  assert.ok(
    Number.isFinite(opening.openHeight) &&
      approximately(opening.keyframeHeight, opening.openHeight, 0.01),
    `${label}: the start keyframe must consume the shorter --khud-open-height token ` +
      `(keyframe ${opening.keyframeHeight}, token ${opening.openHeight}).`
  )
}

async function readHudState(execute) {
  return execute(`(() => {
    const root = document.querySelector('.kevin-hud-root')
    const surface = document.querySelector('.kevin-hud-surface')
    const identity = document.querySelector('.kevin-hud-identity')
    const title = document.querySelector('.kevin-hud-title-motion')
    const iconMotion = document.querySelector('.kevin-hud-icon-motion')
    const iconFrame = document.querySelector('.kevin-hud-icon-frame')
    const image = document.querySelector('.kevin-hud-icon-frame img.kevin-hud-icon-art')
    const tinted = document.querySelector('.kevin-hud-icon-frame svg.kevin-hud-icon-art image')
    const fallback = document.querySelector('.kevin-hud-icon-frame svg.kevin-hud-icon-mark')
    const bank = document.querySelector('.kevin-hud-bank')
    const track = document.querySelector('.kevin-hud-track')
    const style = surface ? getComputedStyle(surface) : null
    const bankStyle = bank ? getComputedStyle(bank) : null
    const trackStyle = track ? getComputedStyle(track) : null
    const rect = surface
      ? surface.getBoundingClientRect()
      : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
    const iconRect = iconMotion ? iconMotion.getBoundingClientRect() : null
    const reveal = [...document.querySelectorAll('[data-khud-reveal]')].map((element) => {
      const revealRect = element.getBoundingClientRect()
      return {
        kind: element.getAttribute('data-khud-reveal') || '',
        x: element.style.getPropertyValue('--khud-origin-x').trim() || '',
        y: element.style.getPropertyValue('--khud-origin-y').trim() || '',
        delay: element.style.getPropertyValue('--khud-reveal-delay').trim() || '',
        centerX: Math.round((revealRect.left + revealRect.width / 2) * 100) / 100,
        top: Math.round(revealRect.top * 100) / 100
      }
    })
    const fontStyle = document.getElementById('kevin-launcher-font-faces')
    const fontText = fontStyle?.textContent || ''
    const memory = document.querySelector('.kevin-hud-memory')
    const memoryReadout = document.querySelector('.kevin-hud-memory-readout')
    const memoryCenter = document.querySelector('.kevin-hud-memory-readout__center')
    const memoryArc = document.querySelector('.kevin-hud-memory-readout__arc')
    return {
      phase: root?.dataset.phase ?? null,
      direction: root?.dataset.direction ?? null,
      anchor: root?.dataset.anchor ?? null,
      host: root?.dataset.host ?? null,
      exitFrom: surface?.dataset.exitFrom ?? null,
      rootAriaHidden: root?.getAttribute('aria-hidden') ?? null,
      surface: {
        left: Math.round(rect.left * 100) / 100,
        top: Math.round(rect.top * 100) / 100,
        right: Math.round(rect.right * 100) / 100,
        bottom: Math.round(rect.bottom * 100) / 100,
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
        computedHeight: style?.height ?? '',
        opacity: style ? Number(style.opacity) : 0,
        animationName: style?.animationName ?? '',
        animationDirection: style?.animationDirection ?? '',
        animationPlayState: style?.animationPlayState ?? '',
        motion: surface?.dataset.motion ?? '',
        exitMode: surface?.dataset.exitMode ?? null,
        exitClock: surface?.dataset.exitClock ?? null,
        color: style?.color ?? ''
      },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      tokens: {
        width: style?.getPropertyValue('--khud-width').trim() ?? '',
        height: style?.getPropertyValue('--khud-height').trim() ?? '',
        openHeight: style?.getPropertyValue('--khud-open-height').trim() ?? '',
        baseHeight: style?.getPropertyValue('--khud-base-height').trim() ?? '',
        expandedHeight: style?.getPropertyValue('--khud-expanded-height').trim() ?? '',
        radius: style?.getPropertyValue('--khud-radius').trim() ?? '',
        openRadius: style?.getPropertyValue('--khud-open-radius').trim() ?? '',
        enterX: style?.getPropertyValue('--khud-enter-x').trim() ?? '',
        enterY: style?.getPropertyValue('--khud-enter-y').trim() ?? '',
        enterScale: style?.getPropertyValue('--khud-enter-scale').trim() ?? ''
      },
      enterX: style?.getPropertyValue('--khud-enter-x').trim() ?? '',
      enterY: style?.getPropertyValue('--khud-enter-y').trim() ?? '',
      enterScale: style?.getPropertyValue('--khud-enter-scale').trim() ?? '',
      appName: document.querySelector('.kevin-hud-app-name')?.textContent?.trim() ?? null,
      ariaLabel: surface?.getAttribute('aria-label') ?? null,
      icon: {
        kind: image ? 'img' : tinted ? 'tinted-svg' : fallback ? 'fallback' : 'missing',
        naturalWidth: image?.naturalWidth ?? 0,
        centerX: iconRect ? Math.round((iconRect.left + iconRect.width / 2) * 100) / 100 : 0
      },
      title: {
        opacity: title ? Number(getComputedStyle(title).opacity) : 0
      },
      identity: {
        present: !!identity,
        icon: identity?.getAttribute('data-icon') ?? null,
        name: identity?.getAttribute('data-name') ?? null,
        originX: identity?.style.getPropertyValue('--khud-origin-x').trim() ?? '',
        originY: identity?.style.getPropertyValue('--khud-origin-y').trim() ?? ''
      },
      bank: {
        present: !!bank,
        layout: bank?.getAttribute('data-layout') ?? null,
        mode: bank?.getAttribute('data-mode') ?? null,
        overflow: bank?.getAttribute('data-overflow') === 'true',
        autoWidthFallback: bank?.getAttribute('data-auto-width-fallback') ?? null,
        trackAnimationName: trackStyle?.animationName ?? '',
        trackPlayState: trackStyle?.animationPlayState ?? '',
        overflowDistance: bankStyle?.getPropertyValue('--khud-overflow-distance').trim() ?? '',
        overflowDuration: bankStyle?.getPropertyValue('--khud-overflow-duration').trim() ?? '',
        clientWidth: bank?.clientWidth ?? 0,
        scrollWidth: track?.scrollWidth ?? 0
      },
      memory: {
        present: !!memoryReadout,
        amounts: memory?.getAttribute('data-memory-amounts') ?? null,
        percent: memory?.getAttribute('data-memory-percent') ?? '',
        used: document.querySelector('.kevin-hud-memory-readout__used')?.textContent?.trim() ?? '',
        total: document.querySelector('.kevin-hud-memory-readout__total-value')?.textContent?.trim() ?? '',
        unit: document.querySelector('.kevin-hud-memory-readout__unit')?.textContent?.trim() ?? '',
        progress: memoryArc?.style.getPropertyValue('--kevin-hud-memory-progress').trim() ?? '',
        centerText: memoryCenter?.textContent?.trim() ?? '',
        ariaLabel: memoryReadout?.getAttribute('aria-label') ?? ''
      },
      cells: [...document.querySelectorAll('.kevin-hud-bank .kevin-hud-cell[data-cell]')].map((element) => ({
        metric: element.dataset.cell ?? '',
        ariaLabel: element.getAttribute('aria-label') ?? '',
        top: Math.round(element.getBoundingClientRect().top * 100) / 100
      })),
      metrics: [...document.querySelectorAll('.kevin-hud-metric')].map((element) => ({
        name: element.dataset.cell ?? '',
        value: element.querySelector('.kevin-hud-metric-value')?.textContent?.trim() ?? '',
        label: element.querySelector('.kevin-hud-metric-label')?.textContent?.trim() ?? '',
        unavailable: element.dataset.unavailable === 'true',
        ariaLabel: element.getAttribute('aria-label') ?? ''
      })),
      reveal,
      font: {
        faceStylePresent: !!fontStyle,
        latinFace: fontText.includes('local("' + ${JSON.stringify(FONT_FAMILY_EN)} + '")'),
        cjkFace: fontText.includes('local("' + ${JSON.stringify(FONT_FAMILY_ZH)} + '")'),
        appFont: document.documentElement.style.getPropertyValue('--app-font') || '',
        surfaceFamily: style?.fontFamily ?? '',
        inlineFontFamily: surface?.style.fontFamily ?? ''
      },
      animations: (surface?.getAnimations?.() ?? []).map((animation) => ({
        name: animation.animationName || '',
        playState: animation.playState,
        startTime: Number(animation.startTime),
        currentTime: Number(animation.currentTime)
      })),
      bodyText: document.body?.innerText ?? ''
    }
  })()`)
}

async function readStyleState(execute) {
  return execute(`(() => {
    const surface = document.querySelector('.kevin-hud-surface')
    const fill = document.querySelector('.kevin-hud-fill')
    const title =
      document.querySelector('.kevin-hud-title-block') ||
      document.querySelector('.kevin-hud-cell[data-cell="appName"] .kevin-hud-copy')
    const iconFrame = document.querySelector('.kevin-hud-icon-frame')
    const appName = document.querySelector('.kevin-hud-app-name')
    const metricValue = document.querySelector('.kevin-hud-metric-value')
    const image = iconFrame?.querySelector('img.kevin-hud-icon-art')
    const tinted = iconFrame?.querySelector('svg.kevin-hud-icon-art image')
    const style = getComputedStyle(surface)
    const fillStyle = getComputedStyle(fill)
    const titleStyle = getComputedStyle(title)
    const iconStyle = getComputedStyle(iconFrame)
    const rect = surface.getBoundingClientRect()
    return {
      borderWidth: style.borderTopWidth,
      requestedBorderWidth: style.getPropertyValue('--khud-border-width').trim(),
      borderColor: style.borderTopColor,
      borderRadius: style.borderTopLeftRadius,
      requestedRadius: style.getPropertyValue('--khud-radius').trim(),
      designWidth: style.getPropertyValue('--khud-width').trim(),
      designHeight: style.getPropertyValue('--khud-height').trim(),
      devicePixelRatio: window.devicePixelRatio,
      boxWidth: Math.round(rect.width * 100) / 100,
      boxHeight: Math.round(rect.height * 100) / 100,
      fillColor: fillStyle.backgroundColor,
      fillOpacity: fillStyle.opacity,
      appNameColor: getComputedStyle(appName).color,
      metricColor: getComputedStyle(metricValue).color,
      iconColor: iconStyle.color,
      iconKind: tinted ? 'tinted-svg' : image ? 'img' : 'fallback',
      textTransform: titleStyle.transform,
      iconTransform: iconStyle.transform
    }
  })()`)
}

async function readProbe(execute) {
  return execute(`(() => {
    const probe = window.__kevinHudVerify
    const surface = document.querySelector('.kevin-hud-surface')
    const cell = document.querySelector('[data-cell="clock"]')
    const running = document.getAnimations()
      .filter((animation) => animation.playState === 'running')
      .filter((animation) => /^kevin-hud-(?:plate|icon|title|reveal|ripple)(?:-exit)?$/.test(animation.animationName || ''))
      .map((animation) => animation.animationName)
    return {
      sameSurface: !!probe && probe.surface === surface && !!surface && surface.isConnected,
      sameCell: !!probe && probe.cell === cell && !!cell && cell.isConnected,
      animationsStarted: probe ? probe.starts.slice() : [],
      runningEntranceAnimations: running
    }
  })()`)
}

function channelsOf(value) {
  const match = String(value || '').match(/rgba?\(([^)]+)\)/i)
  if (!match) return null
  const numbers = match[1].split(',')
  if (numbers.length < 3) return null
  return numbers.slice(0, 3).map((part) => Number(part.trim()))
}

function approximately(actual, expected, tolerance = 0.01) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance
}

/**
 * Chromium snaps painted border widths (and radii) to whole device pixels.
 * Assert the requested length through its CSS custom property separately, and
 * accept an actual computed length only when it lies within the whole-device-pixel
 * range bracketing the request. At integer device-pixel alignment this stays exact.
 */
function assertCssLengthWithinDeviceSnap(actualValue, requestedCssPx, devicePixelRatio, label) {
  const actual = Number.parseFloat(actualValue)
  const requested = Number.parseFloat(requestedCssPx)
  assert.ok(
    Number.isFinite(actual),
    `${label}: expected a computed CSS length, received ${JSON.stringify(actualValue)}.`
  )
  assert.ok(Number.isFinite(requested) && requested >= 0, `${label}: invalid requested length.`)
  const ratio =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  const devicePixels = requested * ratio
  const lower = Math.floor(devicePixels) / ratio
  const upper = Math.ceil(devicePixels) / ratio
  const tolerance = 1e-3
  assert.ok(
    actual >= lower - tolerance && actual <= upper + tolerance,
    `${label}: requested ${requested}px (${devicePixels} device px at devicePixelRatio ${ratio}); ` +
      `Chromium reported ${actualValue}, outside the whole-device-pixel snap range ` +
      `${lower}px-${upper}px.`
  )
}

function assertMatrix(value, expected, label) {
  const identity = [1, 0, 0, 1, 0, 0]
  if (value === 'none' && expected.every((number, index) => number === identity[index])) {
    return
  }
  const numbers = (String(value || '').match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || []).map(Number)
  if (numbers.length < 6) {
    throw new Error(`${label}: expected a 2D matrix, received ${JSON.stringify(value)}.`)
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (!approximately(numbers[index], expected[index], 1e-4)) {
      throw new Error(
        `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(value)}.`
      )
    }
  }
}

function finishSuccess(result) {
  if (finished) return
  finished = true
  if (hardTimeout) clearTimeout(hardTimeout)
  result.elapsedMs = Date.now() - verificationStartedAt
  writeJson(1, result)
  try {
    if (reportWindow && !reportWindow.isDestroyed()) reportWindow.destroy()
  } catch {
    // The process is exiting; the disposable window will be discarded.
  }
  cleanProfile()
  app.exit(0)
}

function fail(reason) {
  if (finished) return
  finished = true
  if (hardTimeout) clearTimeout(hardTimeout)
  const error = reason instanceof Error ? reason : new Error(String(reason))
  const payload = {
    ok: false,
    stage,
    error: error.message,
    stack: typeof error.stack === 'string' ? error.stack.split('\n').slice(0, 8).join('\n') : undefined,
    electron: process.versions.electron || null,
    artifacts: reportArtifacts,
    ipc: reportChannels ? { frameChannel: reportChannels.frame, readyChannel: reportChannels.ready } : null,
    rendererConsole: consoleMessages,
    motionDiagnostics: lastMotionDiagnostics,
    isolatedProfile: Boolean(profileRoot)
  }
  writeJson(2, payload)
  try {
    if (reportWindow && !reportWindow.isDestroyed()) reportWindow.destroy()
  } catch {
    // See finishSuccess.
  }
  cleanProfile()
  app.exit(1)
}

function writeJson(fileDescriptor, payload) {
  const text = `${JSON.stringify(payload, null, 2)}\n`
  const reportFile = process.env[CHILD_REPORT_ENV]
  if (reportFile) {
    try {
      fs.writeFileSync(reportFile, text, 'utf8')
    } catch {
      // The report is a convenience for the Node bootstrap; never fail the test on it.
    }
  }
  try {
    fs.writeSync(fileDescriptor, text)
  } catch {
    // Nothing else can report a closed stdout/stderr safely.
  }
}
