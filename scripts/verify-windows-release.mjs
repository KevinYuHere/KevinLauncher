import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isNewerVersion } from '../src/shared/version.ts'
import { downloadInstaller, releasedAssets } from './verify-release.mjs'
import { verifyLocalAssets } from './release-assets.mjs'
import { readReleaseVersion } from './release-source.mjs'
import windowsExecutable from './windows-executable.js'
import { createRequire } from 'node:module'

const windowsLayout = createRequire(import.meta.url)('../src/shared/windowsLayout.json')

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || !process.env.RUNNER_TEMP) {
  throw new Error('正式安装和覆盖升级验证需要一次性的 GitHub 托管 Windows 运行器')
}
const dir = resolve(process.argv[2])
const fromWorktree = process.argv[3] === '--from-worktree'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim()
const source = fromWorktree ? {
  ...readReleaseVersion(), sha: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}')
} : JSON.parse(await readFile(process.argv[3], 'utf8'))
const assets = await verifyLocalAssets(dir, source.version, source.electron)
const installer = join(dir, 'KevinLauncher-Installer-' + source.version + '.exe')
const root = await mkdtemp(join(process.env.RUNNER_TEMP, 'kl-release-check-'))
const children = new Set()
let startupSequence = 0
const sandboxData = name => join(root, name, 'KevinLauncherData')
const sandboxInstall = name => join(root, name, 'KevinLauncher')

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
  const run = (expression, timeout = 150_000) => new Promise((resolveRun, reject) => {
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
        resolveRun(data.result.result.value)
      }
    }
    const timer = setTimeout(() => {
      finish()
      reject(new Error('Electron 页面调用超时：' + expression.slice(0, 60)))
    }, timeout)
    socket.addEventListener('message', receive)
    socket.addEventListener('close', closed)
    socket.send(JSON.stringify({ id: expected, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true } }))
  })
  await until(() => run('Boolean(window.api)'), '应用 IPC 就绪')
  const waitForExit = async () => {
    socket.close()
    const [code] = await Promise.race([exited, delay(15_000).then(() => {
      throw new Error('Windows 进程无法正常退出')
    })])
    assert.equal(code, 0)
    children.delete(child)
  }
  return { run, waitForExit, close: async () => {
    await run('void window.api.windowClose()', 5000).catch(() => {})
    await waitForExit()
  } }
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
  const call = 'window.api.installerRun(' + JSON.stringify(target) + ',' + JSON.stringify(data) + ')'
  assert.equal(await ui.run(call), true)
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

async function startInstalled(target, version) {
  windowsExecutable.assertExecutionLevel(join(target, windowsLayout.entry), 'requireAdministrator')
  windowsExecutable.assertExecutionLevel(join(target, windowsLayout.runtime), 'asInvoker')
  const ui = await launch(join(target, windowsLayout.entry))
  assert.equal(await ui.run('window.api.appVersion()'), version)
  assert.ok((await ui.run('navigator.userAgent')).includes('Electron/' + source.electron))
  assert.ok(Array.isArray(await ui.run('window.api.listApps()')))
  await until(async () => {
    const health = JSON.parse(await readFile(join(target, 'resources', 'app-activation.json'), 'utf8'))
    return health.healthy === version
  }, '渲染器报告启动健康')
  await ui.close()
}

async function verifyUninstall(target, data) {
  const executable = join(target, windowsLayout.entry)
  const ownFile = join(target, '用户自放记录.txt')
  await writeFile(ownFile, 'preserve')
  const before = new Set(await readdir(tmpdir()))
  const ui = await launch(executable, '--uninstall')
  const info = await ui.run('window.api.uninstallerInfo()')
  assert.equal(info.installDir.toLowerCase(), target.toLowerCase())
  assert.equal(info.dataDir.toLowerCase(), data.toLowerCase())
  await ui.run('window.api.uninstallerRun(true)').catch(error => {
    if (error.message !== 'Electron 页面已经关闭') throw error
  })
  await ui.waitForExit()
  await until(async () => {
    const reports = (await readdir(tmpdir())).filter(name => /^kevin-uninstall-.*\.result\.txt$/.test(name) && !before.has(name))
    if (!reports.length) return null
    const result = (await readFile(join(tmpdir(), reports[0]), 'utf8')).replace(/^\uFEFF/, '')
    return result.trim()
  }, '卸载辅助程序完成').then(result => assert.equal(result, 'complete'))
  for (const name of [windowsLayout.entry, windowsLayout.runtime]) {
    await assert.rejects(access(join(target, name)), { code: 'ENOENT' })
  }
  assert.equal(await readFile(ownFile, 'utf8'), 'preserve')
  const config = JSON.parse(await readFile(join(data, 'config.json'), 'utf8'))
  assert.ok(Array.isArray(config.apps))
}

async function comparePayload(installed) {
  const target = join(root, 'payload')
  await mkdir(target)
  execFileSync(join(process.env.SystemRoot, 'System32', 'tar.exe'),
    ['-xf', join(dir, 'KevinLauncher-' + source.version + '-app.zip'), '-C', target], {
      windowsHide: true, stdio: 'inherit'
    })
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
  const manifest = JSON.parse(await readFile(join(dir, 'update-manifest.json'), 'utf8'))
  assert.equal(Object.values(packed).reduce((sum, file) => sum + file.length, 0), manifest.appSize)
}

try {
  const previous = await releasedAssets(process.argv[4] ?? 'latest')
  assert.ok(isNewerVersion(source.version, previous.manifest.version), '候选版本必须高于已发布正式版本')
  const previousFile = join(root, previous.manifest.installerName)
  await downloadInstaller(previous, previousFile)
  const existing = await install(previousFile, 'upgrade', previous.manifest.version)
  const sentinel = join(sandboxData('upgrade'), 'playtime.json')
  const history = JSON.stringify({ version: 1, sessions: [{
    appId: 'windows-fixture', startUtc: '2026-01-01T00:00:00Z',
    endUtc: '2026-01-01T00:01:00Z', durationSec: 60
  }] })
  await writeFile(sentinel, history)
  const previousUi = await launch(join(existing, 'KevinLauncher.exe'))
  assert.equal(await previousUi.run('window.api.appVersion()'), previous.manifest.version)
  assert.ok(Array.isArray(await previousUi.run('window.api.listApps()')))
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
  assert.equal(await readFile(sentinel, 'utf8'), history)
  await startInstalled(covering, source.version)
  const fresh = await install(installer, 'fresh', source.version)
  await startInstalled(fresh, source.version)
  await comparePayload(fresh)
  await verifyUninstall(fresh, sandboxData('fresh'))
  assert.deepEqual(await verifyLocalAssets(dir, source.version, source.electron), assets)
  await writeFile(join(dir, 'windows-verification.json'), JSON.stringify({
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
    payloadMatchesInstalled: true,
    uninstalled: true,
    entryMode: 'requireAdministrator',
    runtimeMode: 'asInvoker',
    assets
  }, null, 2) + '\n')
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [
      '### Windows installer verification',
      '',
      'Source: ' + source.sha + ' (tree ' + source.tree + ')',
      'Version: ' + source.version + ' / Electron ' + source.electron,
      'Previous verified release: ' + previous.manifest.version,
      'Previous installer SHA-256: ' + previous.manifest.installerSha256,
      'Fresh install, launch, overwrite upgrade, saved history, and managed uninstall verified.',
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
