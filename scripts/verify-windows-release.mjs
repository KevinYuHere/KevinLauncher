import assert from 'node:assert/strict'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isNewerVersion } from '../src/shared/version.ts'
import { downloadInstaller, releasedAssets } from './verify-release.mjs'
import { identifyFile, verifyLocalAssets } from './release-assets.mjs'
import { readReleaseVersion } from './release-source.mjs'
import windowsExecutable from './windows-executable.js'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const windowsLayout = createRequire(import.meta.url)('../src/shared/windowsLayout.json')
const windowsProbe = fileURLToPath(new URL('./verify-setup-windows.ps1', import.meta.url))
const run = promisify(execFile)
const samePath = (actual, expected) => actual?.toLowerCase() === expected.toLowerCase()
const setupField = label => `[...document.querySelectorAll('.setup-field')].find(field =>
  field.querySelector('.setup-field-label')?.textContent.trim() === ${JSON.stringify(label)})`

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || !process.env.RUNNER_TEMP) {
  throw new Error('正式安装和覆盖升级验证需要一次性的 GitHub 托管 Windows 运行器')
}
const dir = resolve(process.argv[2])
const beta = process.argv[3] === '--beta-from-worktree'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim()
const betaRecord = beta ? JSON.parse(await readFile(join(dir, 'beta-verification.json'), 'utf8')) : null
if (beta && !/^\d+\.\d+\.\d+-beta\.[1-9]\d*$/.test(betaRecord.version)) throw new Error('预期本地 Beta 版本')
const source = beta || process.argv[3] === '--from-worktree' ? {
  ...(beta ? { version: betaRecord.version, electron: createRequire(import.meta.url)('../package.json').devDependencies.electron }
    : readReleaseVersion()), sha: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}')
} : JSON.parse(await readFile(process.argv[3], 'utf8'))
const installer = join(dir, 'KevinLauncher-Installer-' + source.version + '.exe')
const assets = beta ? await verifyBetaInstaller() : await verifyLocalAssets(dir, source.version, source.electron)
const root = beta ? await betaFixtureRoot() : await mkdtemp(join(process.env.RUNNER_TEMP, 'kl-release-check-'))
const children = new Set()
let startupSequence = 0
const sandboxData = name => join(root, beta && name === 'fresh' ? '中文 数据位置' : name, 'KevinLauncherData')
const sandboxInstall = name => join(root, beta && name === 'fresh' ? '中文 安装位置' : name, 'KevinLauncher')

async function windows(action, ...args) {
  const shell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const { stdout } = await run(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', windowsProbe, '-Action', action, ...args], { windowsHide: true, timeout: 26000 })
  return stdout.trim() ? JSON.parse(stdout.trim()) : null
}

async function verifyBetaInstaller() {
  const actual = await identifyFile(installer)
  assert.equal(betaRecord.installer, basename(installer))
  assert.equal(betaRecord.size, actual.size)
  assert.equal(betaRecord.sha256, actual.sha256)
  windowsExecutable.assertExecutionLevel(installer, 'requireAdministrator')
  windowsExecutable.assertExecutionLevel(join(dir, 'win-unpacked', windowsLayout.entry), 'requireAdministrator')
  windowsExecutable.assertExecutionLevel(join(dir, 'win-unpacked', windowsLayout.runtime), 'asInvoker')
  return { [basename(installer)]: actual }
}

async function betaFixtureRoot() {
  const system = parse(process.env.LOCALAPPDATA).root
  for (const volume of (await windows('volumes')).filter(candidate => !samePath(candidate, system))) {
    try {
      return await realpath(await mkdtemp(join(volume, 'kl-beta-check-')))
    } catch (error) {
      if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error
      console.log(`Cannot create the verifier fixture on ${volume}: ${error.code}`)
    }
  }
  return realpath(await mkdtemp(join(process.env.RUNNER_TEMP, 'kl-beta-check-')))
}

async function until(operation, description, timeout = 120_000, failed) {
  const end = Date.now() + timeout
  let lastError
  while (Date.now() < end) {
    const failure = failed?.()
    if (failure) throw failure
    try {
      const found = await operation()
      if (found) return found
    } catch (error) {
      lastError = error
    }
    await delay(300)
  }
  throw new Error('验证超时：' + description, { cause: lastError })
}

async function launch(file, ...args) {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  const env = { ...process.env }
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  delete env.ELECTRON_RUN_AS_NODE
  delete env.PORTABLE_EXECUTABLE_DIR
  delete env.PORTABLE_EXECUTABLE_FILE
  const startupLog = join(root, `chromium-startup-${++startupSequence}.log`)
  const child = spawn(file, [...args, '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + port, '--enable-logging=file', '--log-file=' + startupLog], {
      env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']
    })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8192) })
  children.add(child)
  await once(child, 'spawn')
  const exited = once(child, 'exit')
  const target = await until(async () => {
    const response = await fetch('http://127.0.0.1:' + port + '/json/list', {
      signal: AbortSignal.timeout(1500)
    })
    return (await response.json()).find(item => item.type === 'page' && /^file:/.test(item.url))
  }, basename(file) + ' Electron 页面就绪', 120_000, () => {
    if (child.exitCode === null) return null
    const hex = (child.exitCode >>> 0).toString(16).padStart(8, '0')
    return new Error(basename(file) + ' 提前退出，代码 0x' + hex + (stderr.trim() ? '\n' + stderr.trim() : ''))
  }).catch(async error => {
    const diagnostics = (await readFile(startupLog, 'utf8').catch(() => '')).trim().slice(-8_192)
    if (diagnostics) console.error(basename(file) + ' Chromium 启动日志\n' + diagnostics)
    throw error
  })
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await Promise.race([
    once(socket, 'open'),
    once(socket, 'error').then(() => { throw new Error('无法连接 Electron 页面') }),
    delay(5000).then(() => { throw new Error('Electron 页面连接超时') })
  ])
  let id = 0
  const command = (method, params, timeout = 150_000) => new Promise((resolveRun, reject) => {
    const expected = ++id
    const finish = () => {
      clearTimeout(timer)
      socket.removeEventListener('message', receive)
      socket.removeEventListener('close', closed)
    }
    const closed = () => {
      finish()
      reject(new Error('Electron 页面已经关闭'))
    }
    const receive = message => {
      const data = JSON.parse(message.data)
      if (data.id !== expected) return
      finish()
      if (data.error || data.result.exceptionDetails) {
        reject(new Error(data.error?.message ?? data.result.exceptionDetails.exception?.description ??
          data.result.exceptionDetails.text))
      } else {
        resolveRun(data.result)
      }
    }
    const timer = setTimeout(() => {
      finish()
      reject(new Error('Electron 页面调用超时：' + method))
    }, timeout)
    socket.addEventListener('message', receive)
    socket.addEventListener('close', closed)
    socket.send(JSON.stringify({ id: expected, method, params }))
  })
  const run = async (expression, timeout) => (await command('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true
  }, timeout)).result.value
  await until(() => run('Boolean(window.api)'), '应用 IPC 就绪')
  const waitForExit = async () => {
    socket.close()
    const [code] = await Promise.race([exited, delay(15_000).then(() => {
      throw new Error('Windows 进程无法正常退出')
    })])
    assert.equal(code, 0)
    children.delete(child)
  }
  return { run, command, pid: child.pid, waitForExit, close: async () => {
    await run('void window.api.windowClose()', 5000).catch(() => {})
    await waitForExit()
  } }
}

async function clickSetup(ui, expression, description) {
  const point = await until(() => ui.run(`(() => {
    const failure = document.querySelector('.setup-warn-block')?.textContent
    if (failure) throw new Error(failure)
    const button = ${expression}
    if (!button || button.disabled || !button.checkVisibility({ visibilityProperty: true })) return null
    button.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const box = button.getBoundingClientRect()
    const point = { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    return button.contains(document.elementFromPoint(point.x, point.y)) ? point : null
  })()`), description, 10_000)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await ui.command('Input.dispatchMouseEvent', { ...point, type, button: 'left', clickCount: 1 })
  }
}

async function setupPath(ui, label, expected) {
  await until(async () => samePath(await ui.run(`(${setupField(label)})?.querySelector('input')?.value`), expected),
    label + ' 显示 ' + expected, 10_000)
}

async function pickSetupPath(ui, label, selected) {
  await clickSetup(ui, `(${setupField(label)})?.querySelector('button')`, label + '可浏览')
  assert.equal(await windows('choose-folder', '-ProcessId', String(ui.pid), '-Target', dirname(selected)), true)
  await setupPath(ui, label, selected)
}

async function clickPrimary(ui, text) {
  return clickSetup(ui, `[...document.querySelectorAll('.setup-actions button.primary')].find(button =>
    button.textContent.trim() === ${JSON.stringify(text)})`, text + '可点击')
}

async function installThroughSetup(ui, info, target, data) {
  await mkdir(dirname(target), { recursive: true })
  await setupPath(ui, '安装位置', info.prefillDir)
  await setupPath(ui, '用户数据目录', info.dataDir)
  await pickSetupPath(ui, '安装位置', target)
  await pickSetupPath(ui, '用户数据目录', data)
  await clickPrimary(ui, '下一步')
  const locations = await ui.run(`[...document.querySelectorAll('.setup-list em')].map(element => element.textContent)`)
  assert(locations.some(path => samePath(path, target)), '确认页显示选中的程序目录')
  assert(locations.some(path => samePath(path, data)), '确认页显示选中的数据目录')
  await clickPrimary(ui, '开始安装')
  await until(() => ui.run(`(() => {
    const failure = document.querySelector('.setup-warn-block')?.textContent
    if (failure) throw new Error(failure)
    return document.querySelector('.setup-title-lg')?.textContent === '安装完成'
  })()`), 'Beta 安装完成')
  assert(samePath(await ui.run(`document.querySelector('.setup-panel .setup-sub b')?.textContent`), target))
}

async function install(file, name, version, previousVersion) {
  const target = sandboxInstall(name)
  const data = sandboxData(name)
  await mkdir(data, { recursive: true })
  const ui = await launch(file)
  const info = await ui.run('window.api.installerInfo()')
  assert.equal(info.version, version)
  if (previousVersion) {
    const inspection = await ui.run('window.api.installerInspect(' + JSON.stringify(target) + ')')
    assert.equal(inspection.version, previousVersion)
  }
  if (beta && name === 'fresh') {
    await installThroughSetup(ui, info, target, data)
  } else {
    const call = 'window.api.installerRun(' + JSON.stringify(target) + ',' + JSON.stringify(data) + ')'
    assert.equal(await ui.run(call), true)
  }
  await ui.close()
  assert.equal((await readFile(join(target, 'resources', 'app-version.txt'), 'utf8')).trim(), version)
  return target
}

async function diagnoseUnpackedSetup() {
  const source = join(dir, 'win-unpacked')
  for (const level of ['requireAdministrator', 'asInvoker']) {
    console.log('Diagnostic installed-image setup launch with ' + level)
    try {
      const image = join(root, 'diagnostic-' + level)
      await cp(source, image, { recursive: true, force: false, errorOnExist: true })
      const executable = join(image, windowsLayout.runtime)
      if (level === 'requireAdministrator') windowsExecutable.prepareWindowsExecutable(executable, undefined, level)
      windowsExecutable.assertExecutionLevel(executable, level)
      const ui = await launch(executable, '--install')
      const info = await ui.run('window.api.installerInfo()')
      await ui.close()
      console.log('Diagnostic ' + level + ' reached setup IPC for ' + info.version)
    } catch (error) {
      console.error('Diagnostic ' + level + ' failed: ' + error.message)
    }
  }
}

async function checkProfile(data, fixture, history) {
  const config = JSON.parse(await readFile(join(data, 'config.json'), 'utf8'))
  assert.ok(config.apps.some(app => app.id === fixture.id && app.name === fixture.name))
  assert.deepEqual(JSON.parse(await readFile(join(data, 'playtime.json'), 'utf8')), history)
}

async function startInstalled(target, version, fixture) {
  windowsExecutable.assertExecutionLevel(join(target, windowsLayout.entry), 'requireAdministrator')
  windowsExecutable.assertExecutionLevel(join(target, windowsLayout.runtime), 'asInvoker')
  const ui = await launch(join(target, windowsLayout.entry))
  assert.equal(await ui.run('window.api.appVersion()'), version)
  assert.ok((await ui.run('navigator.userAgent')).includes('Electron/' + source.electron))
  assert.ok((await ui.run('window.api.listApps()')).some(app => app.id === fixture.id && app.name === fixture.name))
  assert.equal((await ui.run('window.api.playTimeTotals()'))[fixture.id], 60)
  await until(async () => {
    const health = JSON.parse(await readFile(join(target, 'resources', 'app-activation.json'), 'utf8'))
    return health.healthy === version
  }, '渲染器报告启动健康')
  await ui.close()
}

async function verifyBetaIntegration(target, data) {
  const entry = join(target, windowsLayout.entry)
  const runtime = join(target, windowsLayout.runtime)
  for (const executable of [windowsLayout.entry, windowsLayout.runtime]) {
    assert.deepEqual(await identifyFile(join(target, executable)), await identifyFile(join(dir, 'win-unpacked', executable)))
  }
  const { uninstall, program, data: registeredData, task } = await windows('integration')
  assert.equal(uninstall.name, 'KevinLauncher')
  assert.equal(uninstall.version, source.version)
  assert(samePath(uninstall.path, target) && samePath(program, target))
  assert(samePath(registeredData, data))
  assert.equal(uninstall.command, `"${entry}" --uninstall`)
  assert(samePath(task?.target?.replace(/^"|"$/g, ''), entry), '开机计划任务应启动所选程序目录的公开入口')
  assert.match(task.level, /^Highest/i)
  const links = await windows('links')
  assert.equal(links?.length, 2)
  for (const link of links) {
    assert(samePath(link.target, entry) && samePath(link.workingDirectory, target))
    assert.equal(link.arguments, '')
  }
  await windows('launch', '-Target', links[0].path)
  const launched = await until(async () => {
    const { processes, runnerIntegrityRid } = await windows('processes', '-Target', target)
    const started = processes.find(process => samePath(process.path, entry))
    const main = processes.find(process => process.parentId === started?.id && process.window && samePath(process.path, runtime))
    const renderers = processes.filter(process => process.parentId === main?.id && process.renderer)
    if (!started || !main || renderers.length === 0) return null
    return { started, main, renderers, runnerIntegrityRid }
  }, '从 Windows 快捷方式启动所选位置的 Beta')
  assert(launched.started.elevated && launched.main.elevated)
  assert(launched.renderers.every(renderer => !renderer.noSandbox && renderer.restricted && renderer.integrityRid <= 0x1000))
  await windows('close', '-Target', runtime, '-ProcessId', String(launched.main.id))
  await until(async () => !(await windows('processes', '-Target', target)).processes.length, '快捷方式启动的实例退出')
  await assert.rejects(access(join(process.env.LOCALAPPDATA, 'Programs', 'KevinLauncher')), { code: 'ENOENT' })
  return {
    nativeFolderDialogs: 2, program: target, data,
    differentSystemVolume: !samePath(parse(target).root, parse(process.env.LOCALAPPDATA).root),
    defaultProgramUntouched: true, shortcutLaunched: true, productionRegistration: true,
    startupTask: task.level, runnerIntegrityRid: launched.runnerIntegrityRid,
    entryIntegrityRid: launched.started.integrityRid, runtimeIntegrityRid: launched.main.integrityRid,
    rendererIntegrityRids: launched.renderers.map(renderer => renderer.integrityRid), rendererSandboxed: true,
    uacPromptObserved: false
  }
}

async function verifyUninstall(target, data) {
  const executable = join(target, windowsLayout.entry)
  const ownFile = join(target, '用户自放记录.txt')
  assert(samePath((await windows('integration')).uninstall?.path, target), '鲜装后的卸载入口应存在')
  await writeFile(ownFile, 'preserve')
  const profileFiles = ['config.json', 'playtime.json']
  const beforeData = await Promise.all(profileFiles.map(file => readFile(join(data, file))))
  const logFile = join(data, 'launcher.log')
  const before = await readFile(logFile, 'utf8')
  const ui = await launch(executable, '--uninstall')
  const info = await ui.run('window.api.uninstallerInfo()')
  assert.equal(info.installDir.toLowerCase(), target.toLowerCase())
  assert.equal(info.dataDir.toLowerCase(), data.toLowerCase())
  await ui.run('window.api.uninstallerRun(true)').catch(error => {
    if (error.message !== 'Electron 页面已经关闭') throw error
  })
  await ui.waitForExit()
  const launcherLog = await readFile(logFile, 'utf8')
  const handoff = launcherLog.startsWith(before) ? launcherLog.slice(before.length) : launcherLog
  assert.ok(handoff.includes('setup: received launcher close request'), '托盘模式下的运行实例应收到正常退出请求')
  const marker = 'uninstall: handed off to helper. Result: '
  const line = handoff.split(/\r?\n/).find(item => item.includes(marker))
  assert.ok(line, '卸载进程退出前没有记录辅助程序交接\n' + handoff.trim().slice(-8192))
  const report = line.slice(line.indexOf(marker) + marker.length)
  assert.ok(isAbsolute(report) && /^kevin-uninstall-[\da-f-]{36}\.result\.txt$/i.test(basename(report)), report)
  const result = await until(async () => {
    const diagnostic = (await readFile(report, 'utf8')).replace(/^\uFEFF/, '').trim()
    return /^(?:complete$|failed:|cleanup pending:)/.test(diagnostic) ? diagnostic : null
  }, '卸载辅助程序完成，诊断文件 ' + report).catch(async error => {
    const diagnostic = (await readFile(report, 'utf8').catch(reportError => reportError.message)).trim().slice(-8192)
    throw new Error(error.message + '\n' + handoff.trim().slice(-8192) + '\n' + diagnostic, { cause: error })
  })
  assert.equal(result, 'complete')
  for (const name of [windowsLayout.entry, windowsLayout.runtime, 'install.json']) {
    await assert.rejects(access(join(target, name)), { code: 'ENOENT' })
  }
  assert.equal(await readFile(ownFile, 'utf8'), 'preserve')
  assert.deepEqual(await Promise.all(profileFiles.map(file => readFile(join(data, file)))), beforeData)
  assert.equal((await windows('integration')).uninstall, null, '卸载应清理原有 Windows 注册入口')
  if (beta) assert.equal(await windows('links'), null, '卸载应清理指向已卸载目录的快捷方式')
}

async function comparePayload(installed) {
  const target = beta ? join(dir, 'win-unpacked', 'resources', 'app-' + source.version) : join(root, 'payload')
  if (!beta) {
    await mkdir(target)
    execFileSync(join(process.env.SystemRoot, 'System32', 'tar.exe'),
      ['-xf', join(dir, 'KevinLauncher-' + source.version + '-app.zip'), '-C', target], {
        windowsHide: true, stdio: 'inherit'
      })
  }
  const files = async (base, profile = '') => {
    const entries = await readdir(join(base, profile), { withFileTypes: true })
    const indexed = {}
    for (const entry of entries) {
      const file = join(profile, entry.name)
      if (entry.isDirectory()) Object.assign(indexed, await files(base, file))
      else if (entry.isFile()) indexed[file] = await readFile(join(base, file))
      else throw new Error('发现异常更新包文件：' + file)
    }
    return indexed
  }
  const packed = await files(target)
  assert.deepEqual(packed, await files(join(installed, 'resources', 'app-' + source.version)))
  if (!beta) {
    const manifest = JSON.parse(await readFile(join(dir, 'update-manifest.json'), 'utf8'))
    assert.equal(Object.values(packed).reduce((sum, file) => sum + file.length, 0), manifest.appSize)
  }
}

try {
  const previous = await releasedAssets(process.argv[4] ?? 'latest')
  assert.ok(isNewerVersion(source.version, previous.manifest.version), '候选版本必须高于已发布正式版本')
  const previousFile = join(root, previous.manifest.installerName)
  await downloadInstaller(previous, previousFile)
  const existing = await install(previousFile, 'upgrade', previous.manifest.version)
  const oldEntry = join(existing, windowsLayout.entry)
  const seeded = await launch(oldEntry)
  assert.equal(await seeded.run('window.api.appVersion()'), previous.manifest.version)
  const fixture = await seeded.run('window.api.addApp({ name: "Windows 验收夹具", launchMethods: [] })')
  assert.equal(typeof fixture.id, 'string')
  await seeded.close()
  const data = sandboxData('upgrade')
  const end = new Date()
  const history = { version: 1, sessions: [{
    appId: fixture.id, startUtc: new Date(end.getTime() - 60_000).toISOString(),
    endUtc: end.toISOString(), durationSec: 60
  }] }
  await writeFile(join(data, 'playtime.json'), JSON.stringify(history))
  await checkProfile(data, fixture, history)
  const previousUi = await launch(oldEntry)
  assert.equal(await previousUi.run('window.api.appVersion()'), previous.manifest.version)
  assert.ok((await previousUi.run('window.api.listApps()')).some(app => app.id === fixture.id))
  assert.equal((await previousUi.run('window.api.playTimeTotals()'))[fixture.id], 60)
  console.log('Verified and started the published setup and launcher, v' + previous.manifest.version)
  const covering = await install(installer, 'upgrade', source.version, previous.manifest.version).catch(async error => {
    const launcherLog = (await readFile(join(sandboxData('upgrade'), 'launcher.log'), 'utf8').catch(() => ''))
      .split(/\r?\n/).filter(line => /\b(?:install:|app:|shutdown:)/.test(line)).slice(-25).join('\n')
    if (launcherLog) console.error('Installation and previous launcher log\n' + launcherLog)
    if (/提前退出|Electron 页面就绪/.test(error.message)) await diagnoseUnpackedSetup()
    throw error
  })
  await previousUi.waitForExit()
  assert.equal(existing, covering)
  await checkProfile(data, fixture, history)
  await checkProfile(join(data, 'update-backup'), fixture, history)
  await startInstalled(covering, source.version, fixture)
  console.log('Verified overwrite upgrade, startup, saved history and previous profile backup')
  const fresh = await install(installer, 'fresh', source.version)
  await startInstalled(fresh, source.version, fixture)
  await comparePayload(fresh)
  console.log('Verified fresh install, startup and byte-for-byte app payload')
  const freshData = sandboxData('fresh')
  const betaIntegration = beta ? await verifyBetaIntegration(fresh, freshData) : null
  const runningFresh = await launch(join(fresh, windowsLayout.entry))
  const tray = await runningFresh.run('window.api.setLauncherBehavior({ closeAction: "tray" })')
  assert.equal(tray.closeAction, 'tray')
  await verifyUninstall(fresh, freshData)
  await runningFresh.waitForExit()
  await checkProfile(freshData, fixture, history)
  assert.deepEqual(beta ? await verifyBetaInstaller() : await verifyLocalAssets(dir, source.version, source.electron), assets)
  const verification = {
    sha: source.sha,
    tree: source.tree,
    runId: process.env.GITHUB_RUN_ID,
    version: source.version,
    electron: source.electron,
    previous: previous.manifest.version,
    previousInstallerSha256: previous.manifest.installerSha256,
    freshInstall: true,
    launched: true,
    overwriteUpgrade: true,
    historyPreserved: true,
    backupVerified: true,
    payloadMatchesInstalled: true,
    uninstalled: true,
    entryMode: 'requireAdministrator',
    runtimeMode: 'asInvoker',
    ...(beta ? { betaIntegration } : {}),
    assets
  }
  await writeFile(join(dir, 'windows-verification.json'), JSON.stringify(verification, null, 2) + '\n')
  if (beta) console.log('Windows Beta verification: ' + JSON.stringify(verification))
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [
      '### Windows installer verification',
      '',
      'Source: ' + source.sha + ' (tree ' + source.tree + ')',
      'Version: ' + source.version + ' / Electron ' + source.electron,
      'Previous verified release: ' + previous.manifest.version,
      'Previous installer SHA-256: ' + previous.manifest.installerSha256,
      'Verified fresh install, launch, overwrite upgrade, backup, saved history, and managed uninstall.',
      ...(beta ? ['Beta production integration: ' + JSON.stringify(betaIntegration)] : []),
      '',
      ...Object.entries(assets).map(([file, asset]) => '- ' + file + ': ' + asset.sha256)
    ].join('\n') + '\n'
    const { appendFile } = await import('node:fs/promises')
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary)
  }
} finally {
  for (const child of children) {
    if (child.exitCode === null) {
      try {
        execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      } catch {
        child.kill()
      }
    }
  }
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
}
