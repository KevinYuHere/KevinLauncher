// Run with Electron after building. Uses only a hidden offscreen window, generated
// images and a disposable profile; no launcher main process, UAC or system input.
const { app, BrowserWindow, ipcMain, protocol } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const zlib = require('node:zlib')
const assert = require('node:assert/strict')

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-ui-check-'))
const out = path.resolve(process.argv[2] || path.join(__dirname, '../out'))
app.setPath('userData', temp)
app.setPath('crashDumps', path.join(temp, 'crashes'))
app.disableHardwareAcceleration()
protocol.registerSchemesAsPrivileged([{ scheme: 'kevin-media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])

function png(width, height, white) {
  function chunk(name, bytes) {
    const chunk = Buffer.alloc(bytes.length + 12)
    chunk.writeUInt32BE(bytes.length)
    chunk.write(name, 4)
    bytes.copy(chunk, 8)
    chunk.writeUInt32BE(zlib.crc32(chunk.subarray(4, -4)), chunk.length - 4)
    return chunk
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 1
  const stride = Math.ceil(width / 8) + 1
  const raster = Buffer.alloc(stride * height, white ? 255 : 0x55)
  for (let y = 0; y < height; y++) raster[y * stride] = 0
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'), chunk('IHDR',header), chunk('IDAT',zlib.deflateSync(raster)), chunk('IEND',Buffer.alloc(0))])
}

async function verify() {
  await app.whenReady()
  const images = new Map([['8K.png',png(7680,4320,true)], ['16K.png',png(15360,8640,false)]])
  const reads = {}
  protocol.handle('kevin-media', request => {
    const key = new URL(request.url).pathname.slice(1)
    if (images.has(key)) reads[key] = (reads[key] || 0) + 1
    return new Response(images.get(key) || null, { status: images.has(key) ? 200 : 404,
      headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } })
  })
  const apps = ['8K', '16K','missing'].map(name => ({
    name, id:name, launchMethods:[], linkedLaunchIds: [], monitorProcessNames: [], environmentVariables:{},
    homeModules:{}, launchEffect:'none', autoTheme:false, backgroundBlur:0, backgroundDim:0,
    wallpapers:[{id:name,file:name+'.png',name}], wallpaperIndex:0, wallpaperSettings:{},
    glass:{material:'blur',brightness:40,blur:8}
  }))
  const settings = {themeAreas:{},themeLocks:{},sidebarMaterial:false,updateChannel:'stable',downloadLimitMbps:0}
  const answers = {
    'addons:list':[], 'ui:getPrefs':{},'apps:list':apps,'runtime:list':[], 'linked:list':[],
    'playtime:totals':{},'launcher:getSettings':settings,'fonts:list':[],'app:version':'trial','app:ready':null,
    'wallpaper:desktop':null,'dataDir:get':{},'housekeeping:usage':{},'appUpdate:status':{},
    'update:status':{phase:'idle'},'appUpdate:state':{phase:'idle'},'window:isMaximized':false,
    'window:activity':true,'app:ready':undefined
  }
  for (const [channel,value] of Object.entries(answers)) ipcMain.handle(channel,()=>value)
  ipcMain.handle('launcher:setBehavior',(event,patch)=>{
    Object.assign(settings,patch)
    event.sender.send('launcher:changed')
    return settings
  })
  const win = new BrowserWindow({width:1000,height:660,show:false,focusable:false,skipTaskbar:true,
    webPreferences:{preload:path.join(out,'preload/index.js'),sandbox:true,offscreen:true,backgroundThrottling:false}})
  const run = src => win.webContents.executeJavaScript(src)
  win.webContents.on('console-message',details => {
    if (details.level === 'error') console.error('renderer:',details.message)
  })
  await win.loadFile(path.join(out,'renderer/index.html'))
  async function until(condition, label, timeout=20000) {
    const until = Date.now()+timeout
    while(Date.now()<until) {
      if(await run(condition))return
      await new Promise(r=>setTimeout(r,25))
    }
    throw new Error('Timed out: '+ label+' '+JSON.stringify(await run("({body:document.body.innerText.slice(0,240),perf:window.__klPerf?.slice(-8),imgs:[...document.images].map(i=>[i.className,i.naturalWidth])})")))
  }
  const active = "document.querySelector('img.bg-layer')"
  const ready = active+"?.complete && "+active+"?.naturalWidth > 0"
  await until(ready,'first wallpaper')
  const first = await run(active+'.src')
  const firstWidth = await run(active+'.naturalWidth')
  assert.ok(first.startsWith('blob:') && firstWidth <= 1200)
  const select = index => run("document.querySelectorAll('.game-chip')["+index+"].click()")
  const paint = { frames: 0, black: 0 }
  function inspectFrame(_event, _dirty, frame) {
    const pixels = frame.resize({ width: 48, height: 32 }).toBitmap()
    if (pixels.length === 0) return
    paint.frames++
    const visible = pixels.some((value, index) => index % 4 !== 3 && value > 12)
    if (!visible) paint.black++
  }
  win.webContents.on('paint', inspectFrame)
  await run(`window.__klFrameTimes = []
    window.__klSampleFrames = true
    requestAnimationFrame(function sample(time) {
      window.__klFrameTimes.push(time)
      if (window.__klSampleFrames) requestAnimationFrame(sample)
    })`)
  const switchAt = Date.now()
  await select(1)
  await until(ready+' && '+active+'.src !== '+JSON.stringify(first),'cold 16K')
  const second = await run(active+'.src')
  assert.ok(second.startsWith('blob:') && await run(active+'.naturalWidth') <= 1200)
  const cold = Date.now()-switchAt
  const frameTimes = await run('window.__klSampleFrames = false; window.__klFrameTimes.slice()')
  const gaps = frameTimes.slice(1).map((time, index) => time - frameTimes[index])
  const coldFrames = { count: frameTimes.length, maxGapMs: gaps.length ? Math.round(Math.max(...gaps)) : null }
  await select(2)
  await new Promise(r=>setTimeout(r,300))
  assert.equal(await run(active+'.src'),second)
  const warmAt=Date.now()
  await select(0)
  await until(active+'.src === '+JSON.stringify(first),'warm 8K')
  const warm=Date.now()-warmAt
  win.webContents.removeListener('paint', inspectFrame)
  assert.ok(paint.frames > 0, 'offscreen compositor returned no wallpaper frames')
  assert.equal(paint.black, 0, 'an entirely black frame appeared during switching')
  assert.deepEqual(reads,{'8K.png':1,'16K.png':1})

  const click = async(text,selector='button')=>{
    const find="[...document.querySelectorAll("+JSON.stringify(selector)+")].find(b=>b.textContent.trim()==="+JSON.stringify(text)+")"
    await until('!!'+find,text)
    await run(find+'.click()')
  }
  async function openBulk() {
    await run("document.querySelector('.rail-item[aria-label=设置]').click()")
    await click('启动器设置')
    await until("!!document.querySelector('[aria-label=逐项主题设置]')",'theme settings')
    await run("document.querySelector('[aria-label=逐项主题设置]').click()")
  }
  const picker="document.querySelector('.select-trigger .select-value')"
  await openBulk()
  assert.equal(await run(picker+'.textContent'),'默认')
  for (const [id,label] of [['starsnow','霆骇列律'],['mitia','星轨手记']]) {
    await run(picker+'.parentElement.click()')
    await click(label,'.select-option')
    await click('应用到全部')
    await until("document.documentElement.dataset.specialTransition === "+JSON.stringify(id),'applied theme')
    await click('返回主页')
    await until("!!document.querySelector('.stage .home')",'home')
    // A sweep must be generated after a real stage slide on the next game switch.
    await run(`window.__slide = []
      document.querySelectorAll('.theme-text-sweep').forEach(node => node.remove())
      document.querySelector('.stage').addEventListener('animationend', event => {
        if (event.target === event.currentTarget) window.__slide.push(event.animationName)
      })`)
    await select(id === 'starsnow' ? 1 : 0)
    const slide = id === 'starsnow' ? 'sn-page-in' : 'mt-page-in'
    await until("window.__slide.includes("+JSON.stringify(slide)+") && !!document.querySelector('.theme-text-sweep')",'slide then sweep: '+id)
    await openBulk()
    assert.equal(await run(picker+'.textContent'),label)
  }
  await win.loadFile(path.join(out,'renderer/index.html'))
  await until(ready,'persistent wallpaper after reload')
  assert.deepEqual(reads,{'8K.png':1,'16K.png':1})
  assert.equal(win.isVisible(),false)
  console.log(JSON.stringify({firstWidth,reads,cold16kMs:cold,coldFrames,warmSwitchMs:warm,paint,persistentCache:true,themes:['starsnow','mitia'],hidden:true}))
  win.destroy()
}

verify().then(()=>app.exit(0), error=>{console.error(error);app.exit(1)})
app.on('quit',()=>{
  const target=path.resolve(temp)
  if(path.dirname(target)===path.resolve(os.tmpdir()) && path.basename(target).startsWith('kl-ui-check-')) {
    try { fs.rmSync(target,{recursive:true,force:true}) } catch { /* Chromium can still own a cache handle. */ }
  }
})
