// A normal, non-focus-stealing Windows test window using only synthetic media.
// Usage: electron scripts/verify-renderer-gpu.cjs out 1.5
const { app, BrowserWindow, ipcMain, protocol, screen } = require('electron')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-renderer-gpu-'))
const out = path.resolve(process.argv[2] ?? path.join(__dirname, '../out'))
const scale = process.argv[3] ?? '1'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
app.setPath('userData', root)
app.setPath('crashDumps', path.join(root, 'crashes'))
app.commandLine.appendSwitch('force-device-scale-factor', scale)
protocol.registerSchemesAsPrivileged([{
  scheme: 'kevin-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}])

function makeMedia() {
  const video = path.join(root, 'video.mp4')
  const picture = path.join(root, 'picture.png')
  const ffmpeg = process.env.KL_TEST_FFMPEG || 'ffmpeg.exe'
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=1280x720:rate=30', '-t', '6', '-an', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video], { windowsHide: true })
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=3840x2160:rate=1', '-frames:v', '1', '-threads', '1', picture], { windowsHide: true })
  return new Map([['video.mp4', fs.readFileSync(video)], ['picture.png', fs.readFileSync(picture)]])
}

async function verify() {
  const media = makeMedia()
  await app.whenReady()
  protocol.handle('kevin-media', request => {
    const name = new URL(request.url).pathname.slice(1)
    const source = media.get(name)
    if (!source) return new Response(null, { status: 404 })
    const headers = {
      'Content-Type': name.endsWith('.mp4') ? 'video/mp4' : 'image/png',
      'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store'
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('range') ?? '')
    if (!range) return new Response(source, { headers: { ...headers, 'Content-Length': String(source.length) } })
    const start = Number(range[1])
    const end = Math.min(range[2] ? Number(range[2]) : source.length - 1, source.length - 1)
    if (start > end) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': 'bytes */' + source.length } })
    const bytes = source.subarray(start, end + 1)
    return new Response(bytes, { status: 206, headers: {
      ...headers, 'Content-Length': String(bytes.length), 'Content-Range': `bytes ${start}-${end}/${source.length}`
    } })
  })
  const apps = ['picture.png', 'video.mp4'].map(name => ({
    name, id: name, launchMethods: [], linkedLaunchIds: [], monitorProcessNames: [], environmentVariables: {},
    homeModules: {}, launchEffect: 'none', autoTheme: false, backgroundBlur: 0, backgroundDim: 0,
    wallpapers: [{ id: name, file: name, name }], wallpaperIndex: 0, wallpaperSettings: {},
    glass: { material: 'liquid', brightness: 45, blur: 10 }
  }))
  const answers = {
    'addons:list': [], 'ui:getPrefs': { gamesRowHidden: false }, 'apps:list': apps,
    'runtime:list': [], 'linked:list': [], 'playtime:totals': {}, 'launcher:getSettings': { themeAreas: {}, themeLocks: {} },
    'fonts:list': [], 'app:version': 'gpu-fixture', 'wallpaper:desktop': null, 'dataDir:get': { current: root },
    'housekeeping:usage': {}, 'appUpdate:status': {}, 'appUpdate:state': { phase: 'idle' },
    'window:isMaximized': false, 'window:activity': true, 'app:ready': undefined,
    'update:status': { phase: 'idle' }
  }
  for (const [channel, value] of Object.entries(answers)) ipcMain.handle(channel, () => value)
  const win = new BrowserWindow({
    width: 1000, height: 650, show: false, focusable: false, skipTaskbar: true,
    title: 'KevinLauncher 图形性能夹具',
    webPreferences: { preload: path.join(out, 'preload/index.js'), sandbox: true }
  })
  const run = source => win.webContents.executeJavaScript(source)
  await win.loadURL('about:blank')
  win.webContents.debugger.attach('1.3')
  const properties = {}
  win.webContents.debugger.on('message', (_event, method, params) => {
    if (method === 'Media.playerPropertiesChanged') {
      for (const { name, value } of params.properties) properties[name] = value
    }
  })
  await win.webContents.debugger.sendCommand('Media.enable')
  async function until(condition, label) {
    for (let i = 0; i < 200; i++) {
      if (await run(condition)) return
      await wait(30)
    }
    throw new Error(label + ' ' + await run('document.body.innerText.slice(0, 160)'))
  }
  await win.loadFile(path.join(out, 'renderer/index.html'))
  win.showInactive()
  const staticReady = "document.querySelector('img.bg-layer')?.naturalWidth > 0"
  const videoReady = "document.querySelector('video.bg-layer')?.currentTime > 0.15"
  await until(staticReady, 'prepared 4K static wallpaper')
  await until("!!document.querySelector('.glass-defs filter')", 'liquid filters')
  const frames = () => run(`new Promise(resolve => {
    const gaps = []
    const start = performance.now()
    let previous
    function sample(now) {
      if (previous != null) gaps.push(now - previous)
      previous = now
      if (performance.now() - start < 1000) requestAnimationFrame(sample)
      else {
        gaps.sort((a,b) => a-b)
        resolve({ count: gaps.length + 1, p50: gaps[Math.floor(gaps.length * .5)],
          p95: gaps[Math.floor(gaps.length * .95)], max: gaps.at(-1) })
      }
    }
    requestAnimationFrame(sample)
  })`)
  const measures = async () => {
    const samples = []
    for (let i = 0; i < 3; i++) {
      await wait(400)
      samples.push(app.getAppMetrics().map(({ type, cpu, memory }) => ({
        type, cpu: cpu.percentCPUUsage, workingSetKiB: memory.workingSetSize, privateKiB: memory.privateBytes
      })))
    }
    return samples
  }
  const staticData = {
    frames: await frames(), process: await measures(),
    dimensions: await run('[devicePixelRatio,innerWidth,innerHeight,document.querySelector("img.bg-layer").naturalWidth]'),
    filters: await run("document.querySelectorAll('.glass-defs filter').length")
  }
  const arm = i => run(`document.querySelectorAll('.game-chip')[${i}].click()`)
  const start = performance.now()
  await arm(1)
  await until(videoReady, 'motion wallpaper playback')
  const videoData = {
    firstSampleMs: performance.now() - start, frames: await frames(), process: await measures(),
    quality: await run(`(() => {
      const v = document.querySelector('video.bg-layer'), q = v.getVideoPlaybackQuality()
      return { decoded: q.totalVideoFrames, dropped: q.droppedVideoFrames, width: v.videoWidth, height: v.videoHeight }
    })()`),
    decoder: properties.kVideoDecoderName ?? null, platformDecoder: properties.kIsPlatformVideoDecoder ?? null
  }
  const before = await win.webContents.debugger.sendCommand('Runtime.getHeapUsage')
  for (let i = 0; i < 12; i++) {
    const picture = i % 2 === 0
    await arm(picture ? 0 : 1)
    await until(picture ? staticReady : videoReady, 'wallpaper switch ' + i)
  }
  const after = await win.webContents.debugger.sendCommand('Runtime.getHeapUsage')
  const foreground = await measures()
  win.hide()
  await until("document.visibilityState === 'hidden' && document.querySelector('video.bg-layer')?.paused", 'hidden video pause')
  const hiddenAt = await run("document.querySelector('video.bg-layer').currentTime")
  const hidden = await measures()
  const hiddenEnd = await run("document.querySelector('video.bg-layer').currentTime")
  assert.equal(hiddenAt, hiddenEnd)
  win.showInactive()
  await until("document.visibilityState === 'visible' && !document.querySelector('video.bg-layer')?.paused", 'video resumed')
  const info = await app.getGPUInfo('complete')
  const aux = info.auxAttributes ?? {}
  const status = app.getGPUFeatureStatus()
  const powerGuid = execFileSync('powercfg', ['/getactivescheme'], { windowsHide: true }).toString().match(/[a-f0-9-]{36}/i)?.[0]
  console.log(JSON.stringify({
    electron: process.versions.electron, os: os.release(), requestedScale: Number(scale), powerGuid,
    displays: screen.getAllDisplays().map(({ size, scaleFactor, displayFrequency }) => ({ size, scaleFactor, displayFrequency })),
    features: { gpuCompositing: status.gpu_compositing, rasterization: status.rasterization, videoDecode: status.video_decode },
    glRenderer: aux.glRenderer, glVendor: aux.glVendor,
    adapters: info.gpuDevice?.map(({ active, deviceId, vendorId, driverVersion }) => ({ active, deviceId, vendorId, driverVersion })),
    staticData, videoData, repeatSwitches: 12, heapBefore: before, heapAfter: after,
    foreground, hidden, videoStayedPaused: hiddenEnd === hiddenAt, videoResumed: true
  }))
  win.destroy()
}

verify().then(() => app.exit(0), (error) => { console.error(error); app.exit(1) })
app.on('quit', () => {
  const target = path.resolve(root)
  if (path.dirname(target) === path.resolve(os.tmpdir()) && path.basename(target).startsWith('kl-renderer-gpu-')) {
    try { fs.rmSync(target, { recursive: true, force: true }) } catch { /* Chromium may hold a cache handle. */ }
  }
})
