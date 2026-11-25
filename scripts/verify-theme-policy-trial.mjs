import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const bundledPolicy = (version) => ({
  version, themeId: 'starsnow', areas: 'all', material: 'astral', launchEffect: 'nova'
})

if (args[0] === '--write-fixture') {
  assert.equal(args.length, 2)
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  await writeFile(resolve(args[1]), JSON.stringify(bundledPolicy(version)))
} else {
  assert(process.platform === 'win32', 'Theme policy verification requires Windows')
  assert(args.length >= 1 && args.length <= 2, 'Expected the unpacked trial launcher and optionally an isolated workspace')
  await verify(resolve(args[0]), resolve(args[1] ?? tmpdir()))
}

async function verify(executable, workspace) {
  assert.equal(basename(executable), 'KevinLauncherTrial.exe', 'Only the unpacked trial launcher is permitted')
  assert.equal(basename(dirname(executable)), 'win-unpacked')
  const resources = join(dirname(executable), 'resources')
  const version = (await readFile(join(resources, 'app-version.txt'), 'utf8')).trim()
  const versionDir = join(resources, `app-${version}`)
  const policy = JSON.parse(await readFile(join(versionDir, 'theme-policy.json'), 'utf8'))
  assert.deepEqual(policy, bundledPolicy(version))
  const renderer = pathToFileURL(join(versionDir, 'out', 'renderer', 'index.html')).href
  const profile = await mkdtemp(join(workspace, 'theme-policy-profile-'))
  const data = join(profile, 'KevinLauncherTrial', 'data')
  const configPath = join(data, 'config.json')
  const legacyFile = join(data, 'theme-policy.json')
  const legacy = JSON.stringify({
    version: '0.0.0', themeId: 'default', areas: 'all', material: 'blur', launchEffect: 'none'
  })
  assert.notEqual(version, '0.0.0')
  await mkdir(data, { recursive: true })
  await writeFile(legacyFile, legacy)
  await writeFile(configPath, JSON.stringify({
    version: 14, apps: [{ id: 'theme-regression', name: '主题策略回归' }]
  }))
  const initial = { policy: version, dialogs: 'starsnow', material: 'astral', effect: 'nova' }
  const edited = { policy: version, dialogs: 'default', material: 'mica', effect: 'shockwave' }
  let electron
  await launch(executable, profile, renderer, async (evaluate) => {
    assert.equal(await evaluate('window.api.appVersion()'), version)
    const ua = await evaluate('navigator.userAgent')
    electron = /\bElectron\/([\w.-]+)/.exec(ua)?.[1]
    assert(electron, 'Trial renderer did not expose its actual Electron version')
    assert.deepEqual(await settings(evaluate), initial)
    await evaluate(`(async () => {
      await window.api.setLauncherBehavior({ themeAreas: { dialogs: 'default' } });
      await window.api.setGlass('theme-regression', { material: 'mica' });
      await window.api.setLaunchEffect('theme-regression', 'shockwave');
    })()`)
    assert.deepEqual(await settings(evaluate), edited)
  })
  await launch(executable, profile, renderer, async (evaluate) => {
    assert.equal(await evaluate('window.api.appVersion()'), version)
    assert.deepEqual(await settings(evaluate), edited)
  })
  assert.equal(await readFile(legacyFile, 'utf8'), legacy)
  const log = await readFile(join(data, 'launcher.log'), 'utf8')
  assert.equal(log.split(/\r?\n/).filter((line) => line.includes(`themePolicy: applied v${version} →`)).length, 1)
  const sha256 = createHash('sha256').update(await readFile(executable)).digest('hex')
  const proof = { version, electron, sha256, firstLaunch: initial, secondLaunch: edited, oldPolicyIntact: true }
  const report = JSON.stringify(proof, null, 2)
  await writeFile(join(profile, 'verification.json'), report + '\n')
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, '\n## 试用版主题策略两次启动\n\n```json\n' + report + '\n```\n')
  }
  console.log(report)
}

async function launch(executable, localAppData, renderer, check) {
  const excluded = new Set(['LOCALAPPDATA', 'ELECTRON_RUN_AS_NODE', 'PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_DIR'])
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !excluded.has(key.toUpperCase()))),
    LOCALAPPDATA: localAppData
  }
  const proc = spawn(executable, ['--tray', '--enable-logging=stderr', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'], {
    cwd: dirname(executable), env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']
  })
  let stderr = ''
  let socket
  let spawnError
  proc.on('error', (error) => { spawnError = error })
  proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192) })
  function assertRunning() {
    if (spawnError) throw spawnError
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`Trial launcher exited during startup (${proc.exitCode ?? proc.signalCode})\n${stderr}`)
    }
  }
  try {
    let endpoint
    for (let attempt = 0; attempt < 150; attempt++) {
      assertRunning()
      endpoint = /DevTools listening on (ws:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9]\d*\/devtools\/browser\/[^\s]+)/.exec(stderr)?.[1]
      if (endpoint) break
      await delay(200)
    }
    assert(endpoint, `Trial Chromium debugger did not open\n${stderr}`)
    socket = new WebSocket(endpoint)
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out opening the local Chromium debugger')), 10000)
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve() }, { once: true })
      socket.addEventListener('error', () => {
        clearTimeout(timeout)
        reject(new Error('Could not connect to the local Chromium debugger'))
      }, { once: true })
    })
    const send = debuggerConnection(socket)
    let target
    for (let attempt = 0; attempt < 150; attempt++) {
      assertRunning()
      const { targetInfos } = await send('Target.getTargets')
      target = targetInfos.find(({ type, url }) => type === 'page' && url.split('#')[0] === renderer)
      if (target) break
      await delay(200)
    }
    assert(target, `The packaged trial renderer did not open\n${stderr}`)
    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    async function evaluate(expression) {
      const answer = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
      if (answer.exceptionDetails) throw new Error(JSON.stringify(answer.exceptionDetails))
      return answer.result.value
    }
    let ready = false
    for (let attempt = 0; attempt < 60 && !ready; attempt++) {
      ready = await evaluate('Boolean(window.api?.listApps)')
      if (!ready) await delay(100)
    }
    assert(ready, 'The actual trial preload did not expose the settings API')
    const fixture = await evaluate('window.api.listApps().then(apps => apps.map(app => app.id))')
    assert.deepEqual(fixture, ['theme-regression'], 'The isolated profile was not selected')
    await check(evaluate)
    // Closing the real window can also close this CDP session before it replies.
    await evaluate('void window.api.windowClose()').catch(() => undefined)
    for (let attempt = 0; attempt < 80 && proc.exitCode === null; attempt++) await delay(200)
    assert.equal(proc.exitCode, 0, `Trial launcher did not close cleanly\n${stderr}`)
  } finally {
    socket?.close()
    if (proc.pid && proc.exitCode === null && proc.signalCode === null) proc.kill()
  }
}

function debuggerConnection(socket) {
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id)
    clearTimeout(item.timeout)
    if (message.error) item.reject(new Error(JSON.stringify(message.error)))
    else item.resolve(message.result)
  })
  socket.addEventListener('close', () => {
    for (const item of pending.values()) {
      clearTimeout(item.timeout)
      item.reject(new Error('Trial debugger disconnected'))
    }
    pending.clear()
  })
  return (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Trial debugger command timed out (${method})`))
    }, 10000)
    pending.set(id, { resolve, reject, timeout })
    socket.send(JSON.stringify({ id, method, params, sessionId }))
  })
}

async function settings(evaluate) {
  return evaluate(`Promise.all([window.api.getLauncherSettings(), window.api.listApps()]).then(([launcher, apps]) => ({
    policy: launcher.themePolicyVersion, dialogs: launcher.themeAreas.dialogs,
    material: apps[0].glass.material, effect: apps[0].launchEffect
  }))`)
}
