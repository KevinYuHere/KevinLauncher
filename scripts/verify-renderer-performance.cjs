// Run with the repository Electron binary. Uses an offscreen window, synthetic
// images and disposable Chromium profile. Keep --baseline for the old renderer.
const { app, BrowserWindow, ipcMain, protocol, screen } = require('electron')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { crc32, deflateSync } = require('node:zlib')
const { pathToFileURL } = require('node:url')

const args = process.argv.slice(2)
const out = path.resolve(args.find(arg => !arg.startsWith('--')) || path.join(__dirname, '../out'))
const baseline = args.includes('--baseline')
const galleryWhilePaused = args.includes('--gallery-while-paused')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-renderer-perf-'))
app.setPath('userData', temp)
app.setPath('crashDumps', path.join(temp, 'crashes'))
app.disableHardwareAcceleration()
protocol.registerSchemesAsPrivileged([{
  scheme: 'kevin-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}])
function png() {
  const chunk = (name, bytes) => {
    const result = Buffer.alloc(bytes.length + 12)
    result.writeUInt32BE(bytes.length)
    result.write(name, 4)
    bytes.copy(result, 8)
    result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4)
    return result
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1280)
  header.writeUInt32BE(720, 4)
  header[8] = 1
  const stride = 161
  const raster = Buffer.alloc(stride * 720, 0x33)
  for (let row = 0; row < 720; row++) raster[row * stride] = 0
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(raster)), chunk('IEND', Buffer.alloc(0))])
}
const blankImage = png()
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const round = n => Math.round(n * 10) / 10
const percentile = (values, fraction) => round([...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0)

const instrument = `(() => {
  const samples = { workersStarted: 0, activeWorkers: 0, urlsCreated: 0, urlsRevoked: 0, longTasks: [] }
  window.__perfStats = samples
  const spawn = Worker
  window.Worker = class extends spawn {
    constructor(...args) { super(...args); samples.workersStarted++; samples.activeWorkers++ }
    terminate() {
      if (!this.ended) { samples.activeWorkers--; this.ended = true }
      super.terminate()
    }
  }
  const originalCreate = URL.createObjectURL.bind(URL), originalRevoke = URL.revokeObjectURL.bind(URL)
  URL.createObjectURL = blob => { samples.urlsCreated++; return originalCreate(blob) }
  URL.revokeObjectURL = url => { samples.urlsRevoked++; originalRevoke(url) }
  new PerformanceObserver(entries => {
    for (const entry of entries.getEntries()) samples.longTasks.push(entry.duration)
  }).observe({ entryTypes: ['longtask'] })
})()`

async function fixture() {
  await app.whenReady()
  let mediaReads = 0
  protocol.handle('kevin-media', () => {
    ++mediaReads
    return new Response(blankImage, {
      headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
    })
  })
  const items = Array.from({ length: 3000 }, (_, index) => ({
    path: `C:\\kl-fixture\\${index}.png`, name: `${index}.png`, size: 8192, mtimeMs: 20000 - index, ctimeMs: 20000 - index
  }))
  const entry = {
    id: 'synthetic', name: '性能样本', launchMethods: Array.from({ length: 25 }, (_, index) => ({
      id: `m${index + 1}`, name: index ? `方式 ${index + 1}` : '启动',
      targetPath: '', arguments: '', workingDirectory: '', runAsAdmin: false
    })),
    defaultLaunchMethodId: 'm1', linkedLaunchIds: [], monitorProcessNames: [], environmentVariables: {},
    homeModules: {}, launchEffect: 'none', autoTheme: false, backgroundBlur: 0, backgroundDim: 0,
    wallpapers: [], wallpaperIndex: 0, wallpaperSettings: {}, screenshotDirectory: 'C:\\kl-fixture',
    glass: { material: 'liquid', brightness: 40, blur: 8 }
  }
  let apps = [entry]
  let failStartup = false
  let failGallery = false
  let launched = 0
  let savedMethods
  const answers = {
    'addons:list': [], 'ui:getPrefs': { gamesRowHidden: false }, 'runtime:list': [], 'linked:list': [],
    'playtime:totals': {}, 'launcher:getSettings': { themeAreas: {}, themeLocks: {}, updateChannel: 'stable' },
    'fonts:list': [], 'app:version': 'fixture', 'wallpaper:desktop': null, 'dataDir:get': { current: temp },
    'housekeeping:usage': { staleStaging: 0, retainedStaging: 0, legacyThumbs: 0, logs: 0, gameCache: 0, media: 0, recovery: 0 },
    'housekeeping:clean': { diskBytes: 0, failures: [] }, 'appUpdate:status': {}, 'appUpdate:state': { phase: 'idle' },
    'window:isMaximized': false, 'window:activity': true, 'app:ready': undefined,
    'gallery:openViewer': undefined,
    'update:status': { appId: 'synthetic', phase: 'idle' }
  }
  for (const [channel, value] of Object.entries(answers)) ipcMain.handle(channel, () => value)
  ipcMain.handle('apps:list', () => {
    if (failStartup) { failStartup = false; throw new Error('synthetic load failure') }
    return apps
  })
  ipcMain.handle('gallery:list', () => {
    if (failGallery) { failGallery = false; throw new Error('synthetic gallery refresh failure') }
    return items
  })
  ipcMain.handle('apps:launch', () => { launched++; return { started: true } })
  ipcMain.handle('apps:setLaunchMethods', (_event, _id, methods) => { savedMethods = methods })

  const rendererDir = path.join(out, 'renderer')
  const fixtureHtml = path.join(temp, 'instrumented.html')
  fs.writeFileSync(fixtureHtml, fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8').replace('<head>',
    `<head><base href="${pathToFileURL(rendererDir + path.sep).href}"><script>${instrument}</script>`))
  const start = performance.now()
  const win = new BrowserWindow({
    width: 1000, height: 660, show: false, focusable: false, skipTaskbar: true,
    webPreferences: {
      preload: path.join(out, 'preload/index.js'), sandbox: true, offscreen: true, backgroundThrottling: false
    }
  })
  const run = source => win.webContents.executeJavaScript(source)
  await win.loadURL('about:blank')
  win.webContents.debugger.attach('1.3')
  async function until(condition, label, timeout = 12000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await run(condition)) return
      await wait(16)
    }
    throw new Error(`${label}: ${await run('document.body.innerText.slice(0, 300)')}`)
  }
  async function open() {
    await win.loadFile(fixtureHtml)
    await until("!!document.querySelector('.stage .home')", 'first usable home')
  }
  const metrics = async () => ({
    processes: app.getAppMetrics().map(({ type, cpu, memory }) => ({
      type, cpuPercent: cpu.percentCPUUsage, workingSetKiB: memory.workingSetSize, privateKiB: memory.privateBytes ?? null
    })),
    heap: await win.webContents.debugger.sendCommand('Runtime.getHeapUsage'),
    dom: await win.webContents.debugger.sendCommand('Memory.getDOMCounters')
  })
  const nav = async (label, selector) => {
    const started = performance.now()
    await run(`document.querySelector(${JSON.stringify(`.rail-item[aria-label="${label}"]`)}).click()`)
    await until(`!!document.querySelector(${JSON.stringify(selector)})`, label)
    return performance.now() - started
  }
  // Gallery thumbnails are static visible content: the shared visual-activity
  // gate (game running / paused visuals) must not stop them loading. The tile
  // `active` prop is wired to window visibility only.
  async function verifyGalleryWhilePaused() {
    win.webContents.send('window:activity', false)
    await until("document.documentElement.hasAttribute('data-visual-paused')", 'paused visual session')
    const pausedWorkers = await run('window.__perfStats.activeWorkers')
    await nav('图库', '.gallery-thumb')
    await until("!!document.querySelector('.gallery-thumb img')", 'gallery thumbnails keep loading while visuals are paused')
    assert.equal(await run("document.documentElement.hasAttribute('data-visual-paused')"), true,
      'gallery must not resume paused visuals')
    return pausedWorkers
  }
  await open()
  const firstUsableMs = round(performance.now() - start)
  if (galleryWhilePaused) {
    const pausedWorkers = await verifyGalleryWhilePaused()
    console.log(JSON.stringify({ mode: 'gallery-while-paused', firstUsableMs, pausedWorkers }))
    win.destroy()
    return
  }
  if (!baseline) await until("!!document.querySelector('.glass-defs filter')", 'liquid map decoded and installed')
  const afterStart = await run('window.__perfStats')
  const startupMetrics = await metrics()
  const galleryFirstMs = round(await nav('图库', '.gallery-thumb'))
  const firstTileCount = await run("document.querySelectorAll('.gallery-thumb').length")
  await until("!!document.querySelector('.gallery-thumb img')", 'first gallery thumbnail')
  const firstImageMetrics = await metrics()
  let peakTileCount = firstTileCount
  const scrollMs = []
  for (let i = 1; i <= 16; i++) {
    const started = performance.now()
    await run(`new Promise(resolve => {
      const el = document.querySelector('.gallery-page')
      el.scrollTop = el.scrollHeight * ${i * 0.059};
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    })`)
    scrollMs.push(performance.now() - started)
    peakTileCount = Math.max(peakTileCount, await run("document.querySelectorAll('.gallery-thumb').length"))
  }
  if (!baseline) {
    assert.ok(firstTileCount > 0 && peakTileCount < 100, `gallery kept ${peakTileCount} tiles mounted`)
    await run(`(() => {
      const button = [...document.querySelectorAll('.gallery-thumb')].at(-1)
      button.focus()
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    })()`)
    await until("document.activeElement?.dataset.tileIndex === '2999'", 'keyboard reaches the last image')
    const refresh = `Array.from(document.querySelectorAll('.gallery-page .page-actions button')).find(button => button.textContent === '刷新').click()`
    await run("document.querySelector('.gallery-grid').dataset.previousFixtureGrid = 'yes'")
    failGallery = true
    await run(refresh)
    await until("document.querySelector('.gallery-page').innerText.includes('读取截图目录失败') && !document.querySelector('.gallery-grid[data-previous-fixture-grid]')", 'failed refresh unmounts the gallery')
    await run(refresh)
    await until("!!document.querySelector('.gallery-grid:not([data-previous-fixture-grid])')", 'retry remounts the gallery')
    await run(`(() => {
      document.querySelector('.gallery-grid').style.width = '320px'
      const page = document.querySelector('.gallery-page')
      page.scrollTop = 0
      page.dispatchEvent(new Event('scroll'))
    })()`)
    await until("document.querySelector('.gallery-thumb')?.style.width === '320px'", 'retried gallery measures its new grid width')
  }
  await nav('主页', '.stage .home')

  const clicks = []
  for (let i = 0; i < 100; i++) {
    const target = i % 2 === 0 ? ['图库', '.gallery-thumb'] : ['主页', '.stage .home']
    clicks.push(await nav(...target))
  }
  await wait(300)
  const afterCycles = await run('window.__perfStats')
  const cycleMetrics = await metrics()
  if (!baseline) {
    assert.equal(await run("!!document.querySelector('canvas.launch-fx')"), false)
    const stateBefore = await run('window.__perfStats.activeWorkers')
    const stateHidden = await verifyGalleryWhilePaused()
    assert.ok(stateHidden < stateBefore, 'liquid worker stops when the desktop becomes inactive')
    await nav('主页', '.stage .home')
    win.webContents.send('window:activity', true)
    await until("!document.documentElement.hasAttribute('data-visual-paused')", 'resumed visual session')
    const startButton = "document.querySelector('.start-btn')"
    await run(`(() => {
      const btn = ${startButton}
      for (const [type, button] of [['pointerup', 0], ['pointerdown', 2], ['pointerup', 2],
        ['pointerdown', 0], ['pointercancel', 0], ['pointerup', 0]]) {
        btn.dispatchEvent(new PointerEvent(type, { button, pointerId: 1, bubbles: true }))
      }
    })()`)
    assert.equal(launched, 0)
    await nav('设置', '.stage .settings')
    await run("[...document.querySelectorAll('button')].find(b => b.textContent === '启动器设置').click()")
    await until("document.body.innerText.includes('清理缩略图')", 'cache settings')
    const cached = await run('window.__perfStats.urlsCreated - window.__perfStats.urlsRevoked')
    assert.ok(cached > 0, 'fixture must leave real thumbnail data to clear')
    await run("[...document.querySelectorAll('button')].find(b => b.textContent === '清理缩略图').click()")
    await until("window.__perfStats.urlsCreated === window.__perfStats.urlsRevoked", 'thumbnail URLs reclaimed by Settings')
    await nav('模块管理', '[data-module-id="launch"]')
    await run(`document.querySelector('[data-module-id="launch"] .module-caret').click()`)
    const method = '.method-card-pinned [role=switch]'
    await until(`!document.querySelector(${JSON.stringify(method)}).closest('[inert]')`, 'launch methods expanded')
    await run(`document.querySelector(${JSON.stringify(method)})
      .dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))`)
    for (let i = 0; i < 30 && !savedMethods; i++) await wait(16)
    assert.equal(savedMethods?.[0]?.runAsAdmin, true)
    const select = '.launch-editor .select-trigger'
    await run(`document.querySelector(${JSON.stringify(select)}).click()`)
    await until("!!document.querySelector('.select-menu')", 'launch-method dropdown open')
    await run("document.querySelector('.select-menu').dispatchEvent(new WheelEvent('wheel', { deltaY: 180, bubbles: true }))")
    await wait(200)
    assert.equal(await run(`document.querySelector(${JSON.stringify(select)}).getAttribute('aria-expanded')`), 'true')
    await run(`document.querySelector(${JSON.stringify(select)})
      .dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles: true }))`)
    await until("!document.querySelector('.select-menu')", 'keyboard dismissal of dropdown')
    // A startup-read IPC error should leave a visible retry and respond to it.
    failStartup = true
    await win.reload()
    await until("document.body.innerText.includes('读取启动器数据失败')", 'startup error shown')
    await run("[...document.querySelectorAll('button')].find(b => b.textContent === '重试').click()")
    await until("!!document.querySelector('.stage .home')", 'startup retry recovered')
    apps = []
    win.webContents.send('apps:changed')
    await until("!!document.querySelector('.stage .welcome')", 'empty app list')
    await nav('设置', '.stage .settings')
    assert.match(await run("document.querySelector('.stage').innerText"), /启动器设置|启动器本体/)
    await nav('关联启动', '.stage .page')
    assert.match(await run("document.querySelector('.stage .page-title').textContent"), /关联启动/)
    const previous = await run(`(() => {
      const add = document.querySelector('.game-add') ??
        [...document.querySelectorAll('button')].find(b => b.textContent === '添加应用')
      add?.focus(); add?.click(); return !!add
    })()`)
    if (previous) {
      await until("!!document.querySelector('[role=dialog]')", 'add application dialog')
      assert.equal(await run("document.querySelector('.app-anim').inert"), true)
      assert.equal(await run("document.querySelector('[role=dialog]').contains(document.activeElement)"), true)
      await run("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
      await until("!document.querySelector('[role=dialog]')", 'Escape removes dialog')
    }
  }
  const cpu = os.cpus()[0]?.model ?? null
  const power = process.platform === 'win32'
    ? execFileSync('powercfg', ['/getactivescheme'], { windowsHide: true }).toString().match(/[a-f0-9-]{36}/i)?.[0]
    : null
  console.log(JSON.stringify({
    mode: baseline ? 'baseline' : 'after', electron: process.versions.electron, os: os.release(), arch: os.arch(),
    cpu, ramMiB: Math.round(os.totalmem() / 1024 ** 2), power,
    display: screen.getAllDisplays().map(({ size, scaleFactor, displayFrequency }) => ({ size, scaleFactor, displayFrequency })),
    profileDrive: path.parse(temp).root, appDrive: path.parse(out).root,
    compositor: 'offscreen / software / 1000x660 / synthetic screenshot backend', firstUsableMs, galleryFirstMs,
    firstTileCount, peakTileCount, reads: mediaReads,
    scrollP50Ms: percentile(scrollMs, 0.5), scrollP95Ms: percentile(scrollMs, 0.95),
    navigationP50Ms: percentile(clicks, 0.5), navigationP95Ms: percentile(clicks, 0.95),
    afterStart, afterCycles, startupMetrics, firstImageMetrics, cycleMetrics,
    formSaved: Boolean(savedMethods)
  }))
  win.destroy()
}

fixture().then(() => app.exit(0), (error) => { console.error(error); app.exit(1) })
app.on('quit', () => {
  const target = path.resolve(temp)
  if (path.dirname(target) === path.resolve(os.tmpdir()) && path.basename(target).startsWith('kl-renderer-perf-')) {
    try { fs.rmSync(target, { recursive: true, force: true }) } catch { /* Chromium may still own a cache handle. */ }
  }
})
