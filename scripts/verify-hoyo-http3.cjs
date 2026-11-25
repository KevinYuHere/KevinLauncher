// Invoke with Node. Both the QUIC fixture and the windowless Electron app run
// under this supervisor, with a fresh certificate and an isolated profile.
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { createChunkFixture, runWorker } = require('./verify-hoyo-trial.cjs')
const repo = path.resolve(__dirname, '..')
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))

async function supervise() {
  const output = path.resolve(process.argv[2] || 'out')
  const electron = require('electron')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-http3-trial-'))
  const onExit = proc => new Promise((resolve, reject) => {
    proc.once('error', reject).once('exit', resolve)
  })
  const interpreter = process.env.PYTHON || path.join(repo, '.venv-hoyo',
    ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']))
  if (!fs.existsSync(interpreter)) throw new Error('缺少 HTTP/3 验证环境，请按 INSTALLATION.md 创建')
  const python = cp.spawn(interpreter, ['-u', path.join(__dirname, 'verify-hoyo-http3-server.py'), root], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'],
    env: process.env
  })
  const serverExit = onExit(python)
  let success = false
  let child
  try {
    for (let i = 0; !fs.existsSync(path.join(root, 'ready.json')); i++) {
      if (i > 120 || python.exitCode !== null) throw new Error('本地 HTTP/3 服务未启动')
      await delay(100)
    }
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    child = cp.spawn(electron, [__filename, root, output], { windowsHide: true, stdio: 'inherit', env })
    const timer = setTimeout(() => child.kill(), 90_000)
    try { assert.equal(await onExit(child), 0, 'Electron HTTP/3 验收失败') }
    finally { clearTimeout(timer) }
    success = true
  } finally {
    child?.kill()
    python.kill()
    await serverExit
    if (success && path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('kl-http3-trial-')) {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    } else if (!success) console.error('HTTP/3 诊断文件', root)
  }
}

async function verifyElectron() {
  const { app, netLog } = require('electron')
  const root = process.argv[2], out = process.argv[3]
  const spec = readJson(path.join(root, 'ready.json'))
  assert.equal(new URL(spec.origin).hostname, '127.0.0.1')
  app.setPath('userData', path.join(root, 'electron'))
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('ignore-certificate-errors-spki-list', spec.spki)
  // Chromium also checks the trust anchor for QUIC. Scope its test allowance
  // to the loopback hostname using an unused port; the actual fixture port
  // still has to learn Alt-Svc from its initial ordinary HTTPS request.
  assert.notEqual(new URL(spec.origin).port, '1')
  app.commandLine.appendSwitch('origin-to-force-quic-on', '127.0.0.1:1')
  app.commandLine.appendSwitch('no-proxy-server')
  app.commandLine.appendSwitch('disable-background-networking')
  app.commandLine.appendSwitch('disable-component-update')
  await app.whenReady()
  await netLog.startLogging(path.join(root, 'netlog.json'))
  try {
    const buildDir = path.join(out, 'main')
    const entries = fs.readdirSync(buildDir)
    const code = entries.find(name => /^sophonPatch-.*\.js$/.test(name))
    assert.ok(code, '缺少已构建的游戏更新模块')
    const api = require(path.join(buildDir, code))
    const log = () => fs.readFileSync(spec.evidence, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    const response = () => api.hoyoFetch(spec.origin + '/warmup', {}, true)
    let prefixLength
    await api.withHoYoNetwork(root, 'runner', async () => {
      for (let i = 0; i < 24; i++) {
        await (await response()).arrayBuffer()
        if (log().at(-1)?.protocol === 'h3') break
        await delay(250)
      }
      assert.ok(log().some(row => row.protocol === 'h3' && row.path === '/warmup'), '未观察到通过 Alt-Svc 协商的 HTTP/3')
      assert.equal(log()[0].protocol, 'http/1.1')
      const target = path.join(root, 'resumed')
      const expected = Buffer.alloc(spec.payloadSize)
      for (let i = 0; i < expected.length; i++) expected[i] = i % 256
      const pause = new AbortController()
      await assert.rejects(api.downloadGameFile({ url: spec.origin + '/payload', path: target, size: expected.length,
        signal: pause.signal, onProgress: n => { if (n >= 8192) pause.abort() } }))
      const prefix = fs.readFileSync(target)
      prefixLength = prefix.length
      assert.ok(prefixLength >= 8192 && prefixLength < expected.length)
      assert.deepEqual(prefix, expected.subarray(0, prefixLength))
      await api.downloadGameFile({ url: spec.origin + '/payload', path: target, size: expected.length })
      assert.deepEqual(fs.readFileSync(target), expected)
      assert.ok(log().some(row => row.protocol === 'h3' && row.path === '/payload' && row.range === 'bytes=' + prefixLength + '-' && row.status === 206))
    }, '2.0.5-beta.2')

    const payload = crypto.randomBytes(65_536)
    const { name, files, build } = createChunkFixture(spec.origin, payload)
    for (const [url, bytes] of Object.entries(files)) fs.writeFileSync(path.join(root, path.basename(url)), bytes)
    const dir = path.join(root, '游戏')
    fs.mkdirSync(dir)
    const workerFile = entries.find(name => /^sophonWorker-.*\.js$/.test(name))
    assert.ok(workerFile)
    await runWorker(path.join(buildDir, workerFile), {
      dir, userData: root, gameId: 'fixture', launcherVersion: '2.0.5-beta.2',
      plan: { kind: 'chunk', build, mainBuild: build }, version: '1.0', predownload: false, blacklist: [], hpatchz: ''
    }, file => api.createHoYoDownloadWorker(file, { hoyoPortBudget: api.hoyoPortBudget }))
    assert.deepEqual(fs.readFileSync(path.join(dir, name)), payload)
    const observed = log()
    for (const resource of Object.keys(files)) {
      assert.ok(observed.some(row => row.path === resource && row.protocol === 'h3' && row.status === 200), '资源未通过 HTTP/3 获取 ' + resource)
    }
    console.log(JSON.stringify({ electron: process.versions.electron, protocols: [...new Set(observed.map(row => row.protocol))],
      h3Requests: observed.filter(row => row.protocol === 'h3').length, resumedFrom: prefixLength, verifiedDownload: spec.payloadSize, verifiedGameFile: payload.length }))
  } finally { await netLog.stopLogging() }
}

if (process.versions.electron) {
  const { app } = require('electron')
  verifyElectron().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
} else supervise().catch(error => { console.error(error); process.exitCode = 1 })
