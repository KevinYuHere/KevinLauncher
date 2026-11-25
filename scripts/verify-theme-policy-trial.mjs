import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import { appendFile, copyFile, lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import windowsExecutable from './windows-executable.js'

const readJson = async file => JSON.parse(await readFile(file, 'utf8'))
const layout = await readJson(new URL('../src/shared/windowsLayout.json', import.meta.url))
const { version, devDependencies: { electron } } = await readJson(new URL('../package.json', import.meta.url))
const fixture = { version, themeId: 'starsnow', areas: 'all', material: 'astral', launchEffect: 'nova' }
const initial = { policy: version, dialogs: 'starsnow', material: 'astral', effect: 'nova' }
const edited = { policy: version, dialogs: 'default', material: 'mica', effect: 'shockwave' }
const appId = 'theme-regression'
const installerName = 'KevinLauncherTrial-Installer-' + version + '.exe'
const windowsProbe = fileURLToPath(new URL('./verify-trial-windows.ps1', import.meta.url))
const run = promisify(execFile)
const ignoredEnv = new Set(['ELECTRON_RUN_AS_NODE', 'PORTABLE_EXECUTABLE_DIR', 'PORTABLE_EXECUTABLE_FILE',
  'PORTABLE_EXECUTABLE_APP_FILENAME', 'GH_TOKEN', 'GITHUB_TOKEN'])
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !ignoredEnv.has(key.toUpperCase())))
const samePath = (a, b) => a?.toLowerCase() === b.toLowerCase()

const [input, output] = process.argv.slice(2)
if (input === '--write-fixture') {
  await writeFile(resolve(output), JSON.stringify(fixture))
} else {
  assert(process.platform === 'win32' && env.GITHUB_ACTIONS === 'true' &&
    env.RUNNER_ENVIRONMENT === 'github-hosted' && env.RUNNER_TEMP,
  'Installed trial verification requires an ephemeral GitHub-hosted Windows runner')
  assert(input && !output, 'Expected a trial build directory')
  await verify(await realpath(resolve(input)))
}

async function verify(batch) {
  const installer = join(batch, installerName)
  const recorded = await readJson(join(batch, 'trial-verification.json'))
  const installerSha256 = await sha256(installer)
  assert.equal(recorded.identity, 'trial')
  assert.equal(recorded.version, version)
  assert.equal(recorded.installer, installerName)
  assert.equal(recorded.size, (await stat(installer)).size)
  assert.equal(recorded.sha256, installerSha256)
  windowsExecutable.assertExecutionLevel(installer, 'requireAdministrator')

  const trial = join(await realpath(env.LOCALAPPDATA), 'KevinLauncherTrial')
  await assert.rejects(lstat(trial), { code: 'ENOENT' }, 'The runner must have a fresh trial profile')
  const integrationBefore = await windows('integration')
  const { programFiles, userSid } = await windows('paths')
  assert.match(userSid, /^S-1-[\d-]+$/)
  const installed = join(await realpath(programFiles), 'KevinLauncherTrial', userSid)
  await assert.rejects(lstat(installed), { code: 'ENOENT' }, 'The runner must have a fresh protected trial install')
  const data = join(trial, 'data')
  const configFile = join(data, 'config.json')
  const legacyPolicy = join(data, 'theme-policy.json')
  const legacy = JSON.stringify({
    version: '0.0.0', themeId: 'default', areas: 'all', material: 'blur', launchEffect: 'none'
  })
  const log = async () => (await readFile(join(data, 'launcher.log'), 'utf8').catch(() => ''))
  const entry = join(installed, layout.trialEntry)
  const runtime = join(installed, layout.trialRuntime)
  const resources = join(installed, 'resources')
  const versionDir = join(resources, 'app-' + version)
  const versionPointer = join(resources, 'app-version.txt')
  const bundled = join(versionDir, 'theme-policy.json')
  const appRenderer = pathToFileURL(join(versionDir, 'out', 'renderer', 'index.html')).href + '#app'
  const oldInstall = join(trial, 'installed', 'KevinLauncherTrial')
  const oldEntry = join(oldInstall, layout.trialEntry)
  const oldVersionPointer = join(oldInstall, 'resources', 'app-version.txt')
  await Promise.all([mkdir(data, { recursive: true }), mkdir(join(trial, 'integration'), { recursive: true }),
    mkdir(dirname(oldVersionPointer), { recursive: true })])
  // Model the old layout independently with an asInvoker binary and a version marker.
  await copyFile(join(batch, 'win-unpacked', layout.trialRuntime), oldEntry)
  windowsExecutable.assertExecutionLevel(oldEntry, 'asInvoker')
  const oldEntryHash = await sha256(oldEntry)
  await writeFile(oldVersionPointer, '0.0.0\n')
  await windows('seed-old-links')
  await verifyLinks(trial, oldEntry)
  await writeFile(legacyPolicy, legacy)
  const legacyConfig = JSON.stringify({
    version: 14, apps: [{ id: appId, name: '主题策略回归' }]
  })
  await writeFile(configFile, legacyConfig)

  console.log('Checking the no-argument Windows shell entry of the hashed trial installer')
  const outerId = await windows('launch', '-Target', installer)
  assert(Number.isInteger(outerId) && outerId > 0, 'ShellExecute did not return the trial installer process')
  const defaultSetup = await inspectWindow(installer, outerId)
  await until(async () => (await log()).includes('app: mode=install packaged=true'), 'normal setup mode')
  windowsExecutable.assertExecutionLevel(defaultSetup.entry.path, 'requireAdministrator')
  windowsExecutable.assertExecutionLevel(defaultSetup.main.path, 'asInvoker')
  await windows('close', '-ProcessId', String(defaultSetup.main.id), '-Target', defaultSetup.main.path)
  await waitForProcessesToExit([outerId, defaultSetup.entry.id, defaultSetup.main.id])

  console.log('Installing through the real setup GUI using its default trial paths')
  let immediate
  await installThroughGui(installer, installed, data, async evaluate => {
    await clickSetupButton(evaluate, '立即启动').catch(error => {
      if (error.message !== 'Chromium debugger disconnected') throw error
    })
    immediate = await inspectWindow(entry)
    await until(async () => (await log()).includes('app: mode=app packaged=true'), 'installed launcher mode')
    assert.deepEqual(await persistedSettings(configFile), initial)
    await windows('close', '-ProcessId', String(immediate.main.id), '-Target', runtime)
    await waitForProcessesToExit([immediate.entry.id, immediate.main.id])
  }).catch(async error => {
    const launchModes = (await log()).split(/\r?\n/).filter(line => line.includes('app: mode='))
    console.error('Trial startup modes', launchModes)
    throw error
  })
  assert.equal((await readFile(versionPointer, 'utf8')).trim(), version)
  assert.deepEqual(await readJson(bundled), fixture)
  assert.equal(await readFile(join(data, 'update-backup', 'config.json'), 'utf8'), legacyConfig)
  windowsExecutable.assertExecutionLevel(entry, 'requireAdministrator')
  windowsExecutable.assertExecutionLevel(runtime, 'asInvoker')
  const [entrySha256, runtimeSha256] = await Promise.all([sha256(entry), sha256(runtime)])
  assert.equal(entrySha256, await sha256(join(batch, 'win-unpacked', layout.trialEntry)))
  assert.equal(runtimeSha256, await sha256(join(batch, 'win-unpacked', layout.trialRuntime)))

  const links = await verifyLinks(trial, entry)
  console.log('Checking installed renderer settings and restarting through the installed shortcut')
  await withGui(entry, url => url === appRenderer, async (evaluate, child) => {
    await inspectWindow(entry, child.pid)
    assert.equal(await evaluate('window.api.appVersion()'), version)
    assert.equal(/Electron\/([\w.-]+)/.exec(await evaluate('navigator.userAgent'))?.[1], electron)
    assert.deepEqual(await evaluate('window.api.listApps().then(apps => apps.map(app => app.id))'), [appId])
    assert.deepEqual(await rendererSettings(evaluate), initial)
    await evaluate(`(async () => {
      await window.api.setLauncherBehavior({ themeAreas: { dialogs: 'default' }, autoStart: 'window' });
      await window.api.setGlass(${JSON.stringify(appId)}, { material: 'mica' });
      await window.api.setLaunchEffect(${JSON.stringify(appId)}, 'shockwave');
    })()`)
    assert.deepEqual(await rendererSettings(evaluate), edited)
    await evaluate('void window.api.windowClose()').catch(() => undefined)
  })
  await windows('launch', '-Target', links[0].file)
  const fromShortcut = await inspectWindow(entry)
  assert.deepEqual(await persistedSettings(configFile), edited)
  await windows('close', '-ProcessId', String(fromShortcut.main.id), '-Target', runtime)
  await waitForProcessesToExit([fromShortcut.entry.id, fromShortcut.main.id])
  assert.equal(await readFile(legacyPolicy, 'utf8'), legacy)
  const runLog = await log()
  assert.equal(runLog.split(/\r?\n/).filter(line => line.includes('themePolicy: applied v' + version + ' →')).length, 1)
  assert(runLog.includes('autoStart: window (isolated)'), 'Trial autostart must remain isolated')

  assert.equal(await sha256(oldEntry), oldEntryHash)
  assert.equal(await readFile(oldVersionPointer, 'utf8'), '0.0.0\n')
  assert.deepEqual(await windows('integration'), integrationBefore)

  const proof = {
    source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    version, electron, installer: installerName, installerSha256, size: recorded.size,
    manifests: { installer: 'requireAdministrator', entry: 'requireAdministrator', runtime: 'asInvoker' },
    entrySha256, runtimeSha256,
    windows: {
      shellNoArguments: true, runnerIntegrityRid: defaultSetup.runnerIntegrityRid,
      installerIntegrityRid: defaultSetup.outer.integrityRid,
      installedEntryIntegrityRid: immediate.entry.integrityRid,
      installedMainIntegrityRid: immediate.main.integrityRid,
      shortcutEntryIntegrityRid: fromShortcut.entry.integrityRid,
      rendererIntegrityRids: immediate.renderers.map(renderer => renderer.integrityRid),
      rendererRestricted: true, uacPromptObserved: false, installedShortcutStarted: true
    },
    firstLaunch: initial, restarted: edited, oldPolicyIntact: true,
    isolatedIntegration: true, legacyTrialProgramPreserved: true, legacyTrialDataBackedUp: true
  }
  const report = JSON.stringify(proof, null, 2)
  await writeFile(join(batch, 'installed-trial-verification.json'), report + '\n')
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, '\n## 试用版安装、权限和主题启动验收\n\n```json\n' + report + '\n```\n')
  }
  console.log(report)
}

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function windows(action, ...args) {
  const powershell = join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', windowsProbe, '-Action', action, ...args], { env, windowsHide: true, timeout: 20000 })
  return stdout.trim() ? JSON.parse(stdout.trim()) : null
}

async function until(operation, description, timeout = 90000) {
  const expires = Date.now() + timeout
  do {
    const value = await operation()
    if (value) return value
    await delay(300)
  } while (Date.now() < expires)
  throw new Error('Timed out checking ' + description)
}

async function inspectWindow(executable, pid) {
  return until(async () => {
    const state = await windows('processes', '-InstallerName', installerName)
    assert(state.runnerElevated && state.runnerIntegrityRid >= 0x3000, 'Expected an already-elevated runner token')
    const started = state.processes.find(item => (!pid || item.id === pid) && samePath(item.path, executable))
    if (!started) return null
    const installing = basename(executable) === installerName
    const entry = installing ? state.processes.find(item =>
      item.parentId === started.id && item.path && basename(item.path).toLowerCase() === layout.trialEntry.toLowerCase()) : started
    if (!entry) return null
    const exactRuntime = join(dirname(entry.path), layout.trialRuntime)
    const main = state.processes.find(item =>
      item.parentId === entry.id && samePath(item.path, exactRuntime) && item.window)
    if (!main) return null
    const renderers = state.processes.filter(item => item.parentId === main.id && item.renderer && samePath(item.path, exactRuntime))
    if (!renderers.length) return null
    assert(started.high && entry.high && main.high, 'The public and Electron main processes must run elevated')
    for (const renderer of renderers) {
      assert(!renderer.noSandbox && renderer.integrityRid <= 0x1000 &&
        (renderer.restricted || renderer.appContainer), 'Expected a sandboxed Chromium renderer: ' + JSON.stringify(renderer))
    }
    return { outer: installing ? started : null, entry, main, renderers, runnerIntegrityRid: state.runnerIntegrityRid }
  }, 'visible trial window and Windows process tokens for ' + basename(executable))
}

async function waitForProcessesToExit(ids) {
  await until(async () => {
    const { processes } = await windows('processes', '-InstallerName', installerName)
    return !processes.some(process => ids.includes(process.id))
  }, 'trial process shutdown', 30000)
}

async function verifyLinks(trial, entry) {
  const links = await windows('links', '-Target', join(trial, 'integration'))
  assert.equal(links.length, 2)
  for (const link of links) {
    assert(samePath(link.target, entry), 'Trial shortcut must lead to the installed public executable')
    assert(samePath(link.workingDirectory, dirname(entry)))
    assert.equal(link.arguments, '')
  }
  return links
}

async function persistedSettings(file) {
  const config = await readJson(file)
  assert.deepEqual(config.apps.map(app => app.id), [appId])
  return { policy: config.launcher.themePolicyVersion, dialogs: config.launcher.themeAreas.dialogs,
    material: config.apps[0].glass.material, effect: config.apps[0].launchEffect }
}

async function rendererSettings(evaluate) {
  return evaluate(`Promise.all([window.api.getLauncherSettings(), window.api.listApps()]).then(([launcher, apps]) => ({
    policy: launcher.themePolicyVersion, dialogs: launcher.themeAreas.dialogs,
    material: apps[0].glass.material, effect: apps[0].launchEffect
  }))`)
}

async function clickSetupButton(evaluate, label) {
  await until(() => evaluate(`(() => {
    const error = document.querySelector('.setup-warn-block')?.textContent
    if (error) throw new Error(error)
    const button = document.querySelector('.setup-actions button.primary')
    if (!button || button.disabled || button.textContent.trim() !== ${JSON.stringify(label)}) return false
    button.click()
    return true
  })()`), 'setup button ' + label)
}

async function installThroughGui(installer, installed, data, completed) {
  return withGui(installer, url => url.endsWith('/out/renderer/index.html#install'), async evaluate => {
    const info = await evaluate('window.api.installerInfo()').catch(async cause => {
      const document = await evaluate('location.href').catch(() => '(not available)')
      throw new Error('Setup preload invocation failed. Renderer ' + document + ', TEMP ' + env.TEMP, { cause })
    })
    assert.equal(info.version, version)
    assert(samePath(info.prefillDir, installed))
    assert(samePath(info.dataDir, data))
    await clickSetupButton(evaluate, '下一步')
    await clickSetupButton(evaluate, '开始安装')
    await until(async () => {
      const state = await evaluate(`({
        title: document.querySelector('.setup-title-lg')?.textContent,
        error: document.querySelector('.setup-warn-block')?.textContent
      })`)
      if (state.error) throw new Error(state.error)
      return state.title === '安装完成'
    }, 'installation completion', 150000)
    await completed(evaluate)
  })
}

async function withGui(executable, matches, check) {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  const child = spawn(executable, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port],
    { cwd: dirname(executable), env, stdio: 'ignore' })
  let socket
  let spawnError
  child.on('error', error => { spawnError = error })
  try {
    const target = await until(async () => {
      if (spawnError) throw spawnError
      assert(child.exitCode === null && child.signalCode === null,
        basename(executable) + ' exited before showing the GUI: ' + child.exitCode)
      let pages
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1000) })
        pages = await response.json()
      } catch { return null }
      return pages.find(page => page.type === 'page' && matches(page.url))
    }, 'Chromium GUI for ' + basename(executable))
    const endpoint = new URL(target.webSocketDebuggerUrl)
    assert.equal(endpoint.origin, 'ws://127.0.0.1:' + port)
    socket = new WebSocket(endpoint)
    await Promise.race([
      once(socket, 'open'),
      once(socket, 'error').then(() => { throw new Error('Could not open the Chromium debugger') }),
      delay(5000, undefined, { ref: false }).then(() => { throw new Error('Chromium debugger connect timed out') })
    ])
    const evaluate = debuggerConnection(socket)
    await until(() => evaluate('Boolean(window.api?.windowClose)'), 'actual preload IPC')
    await check(evaluate, child)
    await until(() => child.exitCode !== null, 'GUI process exit', 30000)
    assert.equal(child.exitCode, 0)
  } finally {
    socket?.close()
    if (child.exitCode === null && child.signalCode === null) child.kill()
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
    if (message.error || message.result.exceptionDetails) {
      item.reject(new Error(message.error?.message ?? message.result.exceptionDetails.exception?.description ??
        message.result.exceptionDetails.text))
    } else item.resolve(message.result.result.value)
  })
  socket.addEventListener('close', () => {
    for (const item of pending.values()) {
      clearTimeout(item.timeout)
      item.reject(new Error('Chromium debugger disconnected'))
    }
    pending.clear()
  })
  return expression => new Promise((resolve, reject) => {
    const id = ++nextId
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Chromium debugger command timed out'))
    }, 10000)
    pending.set(id, { resolve, reject, timeout })
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true } }))
  })
}
