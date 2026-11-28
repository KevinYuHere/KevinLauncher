import assert from 'node:assert/strict'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { access, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isNewerVersion } from '../src/shared/version.ts'
import {
  isBetaVersion,
  isPositiveFileSize,
  parseBetaVerification,
  parseUpdateManifest,
  payloadAssetName
} from '../src/main/services/appUpdateManifest.ts'
import { downloadInstaller, downloadPayload, releasedAssets } from './verify-release.mjs'
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
const FRESH_HUD_DEFAULTS = Object.freeze({
  enabled: true,
  alwaysVisible: true,
  metrics: ['fps', 'gpu', 'cpu'],
  backgroundMode: 'gradient',
  borderWidth: 2,
  borderColor: '#A7AD48'
})
const setupField = label => `[...document.querySelectorAll('.setup-field')].find(field =>
  field.querySelector('.setup-field-label')?.textContent.trim() === ${JSON.stringify(label)})`

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || !process.env.RUNNER_TEMP) {
  throw new Error('正式安装和覆盖升级验证需要一次性的 GitHub 托管 Windows 运行器')
}
const liveFlag = process.argv.indexOf('--live-beta-channel')
const live = liveFlag >= 0
const liveBetaVersion = live ? (process.argv[liveFlag + 1] ?? '3.0.0-beta.12') : null
if (live && (liveFlag !== 2 || process.argv.length > 4 || !isBetaVersion(liveBetaVersion))) {
  throw new Error('实时 Beta 通道验证用法：node scripts/verify-windows-release.mjs --live-beta-channel 3.0.0-beta.12')
}
const dir = live
  ? await mkdtemp(join(process.env.RUNNER_TEMP, 'kl-live-beta-verification-'))
  : resolve(process.argv[2])
const beta = !live && process.argv[3] === '--beta-from-worktree'
const scenario = live ? 'live-beta' : beta ? process.argv[5] : 'release'
if (!live && (!['fresh', 'legacy-tray', 'release'].includes(scenario) || (beta && scenario === 'release'))) {
  throw new Error('Beta 安装验证须在独立运行器请选择 fresh 或 legacy-tray')
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim()
const betaRecord = beta ? JSON.parse(await readFile(join(dir, 'beta-verification.json'), 'utf8')) : null
if (beta && !isBetaVersion(betaRecord.version)) throw new Error('预期本地 Beta 版本')
const liveBeta = live ? await loadPublishedBeta(liveBetaVersion, dir) : null
const source = live ? {
  version: liveBeta.manifest.version,
  electron: liveBeta.manifest.electron,
  sha: process.env.GITHUB_SHA ?? null,
  tree: null
} : beta || process.argv[3] === '--from-worktree' ? {
  ...(beta ? { version: betaRecord.version, electron: createRequire(import.meta.url)('../package.json').devDependencies.electron }
    : readReleaseVersion()), sha: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}')
} : JSON.parse(await readFile(process.argv[3], 'utf8'))
const installer = live ? null : join(dir, 'KevinLauncher-Installer-' + source.version + '.exe')
const assets = live ? liveBeta.assets
  : beta ? await verifyBetaInstaller() : await verifyLocalAssets(dir, source.version, source.electron)
const root = beta || live ? await betaFixtureRoot() : await mkdtemp(join(process.env.RUNNER_TEMP, 'kl-release-check-'))
const children = new Set()
let startupSequence = 0
let activity
let liveInstalled
const sandboxData = name => join(root, beta && name === 'fresh' ? '中文 数据位置' : name, 'KevinLauncherData')
const sandboxInstall = name => join(root, beta && name === 'fresh' ? '中文 安装位置' : name, 'KevinLauncher')

async function windows(action, ...args) {
  const shell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const { stdout } = await run(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', windowsProbe, '-Action', action, ...args], { windowsHide: true, timeout: 26000 })
  return stdout.trim() ? JSON.parse(stdout.trim()) : null
}

async function githubJson(path) {
  const token = process.env.GH_TOKEN
  let lastError
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch('https://api.github.com/repos/KevinYuHere/KevinLauncher' + path, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'KevinLauncher',
          ...(token ? { authorization: 'Bearer ' + token } : {})
        },
        signal: AbortSignal.timeout(30_000)
      })
      if (!response.ok) throw new Error('GitHub API ' + path + ' 返回 HTTP ' + response.status)
      return await response.json()
    } catch (error) {
      lastError = error
      if (attempt < 3) await delay(500 * attempt)
    }
  }
  throw lastError
}

async function fetchReleaseAsset(asset, description) {
  const token = process.env.GH_TOKEN
  const headers = { accept: 'application/octet-stream', 'user-agent': 'KevinLauncher' }
  if (token && new URL(asset.url).hostname === 'api.github.com') headers.authorization = 'Bearer ' + token
  let lastError
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(asset.url, { headers, signal: AbortSignal.timeout(90_000) })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      lastError = error
      if (attempt < 3) await delay(250 * 2 ** (attempt - 1))
    }
  }
  throw new Error(description + '下载失败：' + lastError.message, { cause: lastError })
}

function assertAssetDigest(asset, sha256, description) {
  if (asset.digest) {
    assert.equal(String(asset.digest).toLowerCase(), 'sha256:' + sha256, description + '与 GitHub 摘要不一致')
  }
}

/**
 * Reads the already published Beta release. The old public 2.0.5 client only
 * consumes the conventional manifest, so the manifest must advertise the exact
 * Electron 44.7.0 runtime that beta.11/beta.12 ship and the full application
 * ZIP. This channel check deliberately ignores any installerElectron field:
 * beta.11/beta.12 do not require a newer runtime, and the v2.0.5 client must
 * accept the manifest for a lightweight application update.
 */
async function loadPublishedBeta(version, targetDir) {
  assert(isBetaVersion(version), '公开发布的 Beta 版本无效')
  const release = await githubJson('/releases/tags/v' + version)
  assert.equal(release.tag_name, 'v' + version, '公开发布的 Beta 标签不匹配')
  assert.equal(release.prerelease, true, '目标必须是 GitHub 预发布')
  assert.equal(release.draft, false, '目标不能是草稿')
  const published = Array.isArray(release.assets) ? release.assets : []
  const pick = name => {
    const asset = published.find(item => item.name === name && item.state === 'uploaded')
    assert.ok(asset, '公开 Beta 缺少资产 ' + name)
    assert.ok(isPositiveFileSize(asset.size), '公开 Beta 资产大小无效：' + name)
    return asset
  }
  const manifestAsset = pick('update-manifest.json')
  const payloadAsset = pick(payloadAssetName(version))
  const verificationAsset = pick('beta-verification.json')

  const manifestBytes = await fetchReleaseAsset(manifestAsset, 'Beta 更新清单')
  assert.equal(manifestBytes.length, manifestAsset.size, 'Beta 更新清单大小与 GitHub 资产不一致')
  const manifestFile = join(targetDir, 'update-manifest.json')
  await writeFile(manifestFile, manifestBytes)
  const manifestHash = await identifyFile(manifestFile)
  assertAssetDigest(manifestAsset, manifestHash.sha256, 'Beta 更新清单')
  const manifestText = manifestBytes.toString('utf8')
  const manifest = parseUpdateManifest(manifestText, version)
  const raw = JSON.parse(manifestText)
  assert.equal(manifest.version, version)
  assert.equal(manifest.electron, '44.7.0', '公开 Beta 清单必须声明 Electron 44.7.0')
  assert.equal(raw.electron, '44.7.0')
  assert.equal(manifest.critical, false, '公开 Beta 不能是重要更新')

  const verificationBytes = await fetchReleaseAsset(verificationAsset, 'Beta 验证清单')
  assert.equal(verificationBytes.length, verificationAsset.size, 'Beta 验证清单大小与 GitHub 资产不一致')
  const verification = parseBetaVerification(verificationBytes.toString('utf8'), version)
  assert.equal(manifest.installerName, verification.installer, '更新清单与验证清单的安装包名称不一致')
  assert.equal(manifest.installerSize, verification.size, '更新清单与验证清单的安装包大小不一致')
  assert.equal(manifest.installerSha256, verification.sha256, '更新清单与验证清单的安装包校验值不一致')
  assert.equal(payloadAsset.size, manifest.payloadSize, '应用 ZIP 大小与更新清单不一致')
  assertAssetDigest(payloadAsset, manifest.payloadSha256, 'Beta 应用包')
  const installerAsset = published.find(item => item.name === manifest.installerName && item.state === 'uploaded')
  assert.ok(installerAsset, '公开 Beta 缺少清单声明的安装程序')
  assert.equal(installerAsset.size, manifest.installerSize, '安装程序大小与更新清单不一致')
  assertAssetDigest(installerAsset, manifest.installerSha256, 'Beta 安装程序')

  const payloadFile = join(targetDir, payloadAssetName(version))
  await downloadPayload({
    payload: { url: payloadAsset.url, size: payloadAsset.size },
    manifest
  }, payloadFile)
  const payloadHash = await identifyFile(payloadFile)
  assert.equal(payloadHash.size, manifest.payloadSize)
  assert.equal(payloadHash.sha256, manifest.payloadSha256)
  console.log('Verified public Beta ' + version + ' metadata (manifest Electron ' + manifest.electron + ')')
  console.log('  update-manifest.json ' + manifestHash.size + ' bytes · ' + manifestHash.sha256)
  console.log('  ' + payloadAsset.name + ' ' + payloadHash.size + ' bytes · ' + payloadHash.sha256)
  return {
    release: {
      id: release.id,
      tag: release.tag_name,
      url: release.html_url,
      publishedAt: release.published_at,
      prerelease: release.prerelease
    },
    manifest,
    manifestFile,
    manifestSha256: manifestHash.sha256,
    payloadFile,
    payloadSha256: payloadHash.sha256,
    payloadSize: payloadHash.size,
    payloadAsset: payloadAsset.name,
    installerAsset: installerAsset.name,
    assets: {
      'update-manifest.json': manifestHash,
      [payloadAssetName(version)]: payloadHash
    }
  }
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

async function connectPage(port, description, options = {}) {
  const { timeout = 120_000, excludeTargetId, failed } = options
  const target = await until(async () => {
    const response = await fetch('http://127.0.0.1:' + port + '/json/list', {
      signal: AbortSignal.timeout(1500)
    })
    return (await response.json()).find(item => item.type === 'page' && /^file:/.test(item.url) &&
      item.id !== excludeTargetId)
  }, description, timeout, failed)
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await Promise.race([
    once(socket, 'open'),
    once(socket, 'error').then(() => { throw new Error('无法连接 Electron 页面') }),
    delay(5000).then(() => { throw new Error('Electron 页面连接超时') })
  ])
  let id = 0
  const events = []
  socket.addEventListener('message', message => {
    let data
    try {
      data = JSON.parse(message.data)
    } catch {
      return
    }
    if (data.method === 'Runtime.bindingCalled' && typeof data.params?.payload === 'string') {
      let value
      try {
        value = JSON.parse(data.params.payload)
      } catch {
        value = data.params.payload
      }
      events.push({ name: data.params.name, value })
    }
  })
  const command = (method, params, commandTimeout = 150_000) => new Promise((resolveRun, reject) => {
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
    }, commandTimeout)
    socket.addEventListener('message', receive)
    socket.addEventListener('close', closed)
    socket.send(JSON.stringify({ id: expected, method, params }))
  })
  const run = async (expression, runTimeout) => (await command('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true
  }, runTimeout)).result.value
  await until(() => run('Boolean(window.api)'), '应用 IPC 就绪')
  return { target, socket, command, run, events }
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
  let page
  try {
    page = await connectPage(port, basename(file) + ' Electron 页面就绪', {
      failed: () => {
        if (child.exitCode === null) return null
        const hex = (child.exitCode >>> 0).toString(16).padStart(8, '0')
        return new Error(basename(file) + ' 提前退出，代码 0x' + hex + (stderr.trim() ? '\n' + stderr.trim() : ''))
      }
    })
  } catch (error) {
    const diagnostics = (await readFile(startupLog, 'utf8').catch(() => '')).trim().slice(-8_192)
    if (diagnostics) console.error(basename(file) + ' Chromium 启动日志\n' + diagnostics)
    throw error
  }
  const waitForExit = async (timeout = 15_000) => {
    page.socket.close()
    const [code] = await Promise.race([exited, delay(timeout).then(() => {
      throw new Error('Windows 进程无法正常退出')
    })])
    assert.equal(code, 0)
    children.delete(child)
  }
  const waitForRelaunchExit = async (timeout = 240_000) => {
    const [code] = await Promise.race([exited, delay(timeout).then(() => {
      throw new Error('更新后的旧实例未在时限内退出')
    })])
    assert.equal(code, 0)
    page.socket.close()
    children.delete(child)
  }
  return {
    ...page,
    port,
    pid: child.pid,
    waitForExit,
    waitForRelaunchExit,
    attachRelaunched: (timeout = 120_000) => connectPage(port, '更新后的 Electron 页面就绪', {
      timeout, excludeTargetId: page.target.id
    }),
    close: async () => {
      await page.run('void window.api.windowClose()', 5000).catch(() => {})
      await waitForExit()
    }
  }
}

// The published v2.0.5 installer and installed launcher use Electron 44.7.0.
// On the headless hosted runner their GPU process repeatedly crashes
// (error_code=18) before setup IPC becomes reachable. These switches apply
// only to those already hash-verified legacy programs in --live-beta-channel
// mode. v2.0.5 calls bare app.relaunch(), which preserves argv, so the debug
// port and these switches survive the update restart. Current Beta/release
// launches keep their strict sandbox checks.
const LIVE_LEGACY_CHROMIUM_FLAGS = Object.freeze(['--no-sandbox', '--disable-gpu'])
function launchLiveLegacy(file, ...args) {
  assert(live, '旧版 Chromium 参数仅用于实时 Beta 验证')
  const verifiedInstaller = join(dir, 'KevinLauncher-Installer-2.0.5.exe')
  const verifiedLauncher = liveInstalled && join(liveInstalled, windowsLayout.entry)
  assert(samePath(file, verifiedInstaller) || (verifiedLauncher && samePath(file, verifiedLauncher)),
    '旧版 Chromium 参数只能用于已校验的 v2.0.5 安装程序或已安装启动器')
  return launch(file, ...args, ...LIVE_LEGACY_CHROMIUM_FLAGS)
}

function relaunchedUi(page, target) {
  return {
    ...page,
    close: async () => {
      await page.run('void window.api.windowClose()', 5000).catch(() => {})
      await until(async () => !(await windows('processes', '-Target', target)).processes.length,
        '更新后的启动器退出', 30_000)
    }
  }
}

async function stopExactTargetProcesses(target) {
  const allowed = [join(target, windowsLayout.entry), join(target, windowsLayout.runtime)]
  const observed = (await windows('processes', '-Target', target)).processes
  if (!observed.length) return []
  for (const process of observed) {
    assert(allowed.some(path => samePath(process.path, path)), '拒绝结束安装目录以外的进程：' + process.path)
  }
  const ids = [...new Set(observed.map(process => process.id))]
  try {
    execFileSync('taskkill.exe', ids.flatMap(id => ['/PID', String(id), '/T', '/F']), {
      windowsHide: true, stdio: 'ignore'
    })
  } catch (error) {
    if ((await windows('processes', '-Target', target)).processes.length) throw error
  }
  await until(async () => !(await windows('processes', '-Target', target)).processes.length,
    '隔离的测试启动器退出', 30_000)
  return ids
}

async function relaunchLiveInstalled(ui, target) {
  const entry = join(target, windowsLayout.entry)
  const runtime = join(target, windowsLayout.runtime)
  const previousIds = new Set((await windows('processes', '-Target', target)).processes.map(process => process.id))
  await ui.waitForRelaunchExit()
  const findMain = async () => {
    const { processes } = await windows('processes', '-Target', target)
    return processes.find(process => samePath(process.path, runtime) && process.window) ??
      processes.find(process => samePath(process.path, runtime)) ??
      processes.find(process => samePath(process.path, entry))
  }
  try {
    const page = await ui.attachRelaunched()
    const main = await until(findMain, '更新后的主进程就绪', 30_000)
    assert(!previousIds.has(main.id), '更新后应启动新的启动器进程')
    console.log('Relaunched through the existing debug port as PID ' + main.id)
    return { ui: relaunchedUi(page, target), method: 'same-debug-port', mainPid: main.id, mainImage: basename(main.path) }
  } catch (error) {
    console.warn('更新后的实例没有复用旧调试端口，改为重新启动准确入口：' + error.message)
    if ((await windows('processes', '-Target', target)).processes.length) await stopExactTargetProcesses(target)
    const restarted = await launchLiveLegacy(entry)
    const main = await until(findMain, '重新启动后的主进程就绪', 30_000)
    assert(!previousIds.has(main.id), '重新启动后应运行新的启动器进程')
    return { ui: restarted, method: 're-execed-exact-entry', mainPid: main.id, mainImage: basename(main.path) }
  }
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

async function pickSetupPath(ui, label, previous, selected) {
  await clickSetup(ui, `(${setupField(label)})?.querySelector('button')`, label + '可浏览')
  const picked = await windows('choose-folder', '-ProcessId', String(ui.pid), '-Target', dirname(selected))
  assert.equal(typeof picked, 'boolean')
  if (!picked) {
    await setupPath(ui, label, previous)
    await ui.run(`(() => {
      const input = (${setupField(label)})?.querySelector('input')
      if (!input || input.disabled || input.readOnly) throw new Error('Setup path is not editable')
      input.focus()
      input.select()
    })()`)
    await ui.command('Input.insertText', { text: selected })
  }
  await setupPath(ui, label, selected)
  return picked ? 'native-selection' : 'typed-after-native-cancel'
}

async function clickPrimary(ui, text) {
  return clickSetup(ui, `[...document.querySelectorAll('.setup-actions button.primary')].find(button =>
    button.textContent.trim() === ${JSON.stringify(text)})`, text + '可点击')
}

async function installThroughSetup(ui, info, target, data) {
  await mkdir(dirname(target), { recursive: true })
  await setupPath(ui, '安装位置', info.prefillDir)
  await setupPath(ui, '用户数据目录', info.dataDir)
  const programMethod = await pickSetupPath(ui, '安装位置', info.prefillDir, target)
  const dataMethod = await pickSetupPath(ui, '用户数据目录', info.dataDir, data)
  await confirmSetupInstall(ui, target, data)
  return { programMethod, dataMethod }
}

async function trackSetupLog(data) {
  const file = join(data, 'launcher.log')
  const read = () => readFile(file, 'utf8').catch(() => '')
  let position = (await read()).length
  return async () => {
    const contents = await read()
    const appended = contents.slice(contents.length >= position ? position : 0)
    position = contents.length
    const status = appended.split(/\r?\n/).filter(line => /\b(?:install:|setup:|shutdown:)/.test(line))
    if (status.length) console.log(status.join('\n'))
  }
}

async function confirmSetupInstall(ui, target, data, requireForeground = false) {
  await clickPrimary(ui, '下一步')
  const locations = await ui.run(`[...document.querySelectorAll('.setup-list em')].map(element => element.textContent)`)
  assert(locations.some(path => samePath(path, target)), '确认页显示选中的程序目录')
  assert(locations.some(path => samePath(path, data)), '确认页显示选中的数据目录')
  const reportProgress = requireForeground ? await trackSetupLog(data) : null
  if (requireForeground) {
    await ui.command('Page.bringToFront', {})
    const active = await until(async () => {
      const state = await windows('activate-installer', '-ProcessId', String(ui.pid))
      return state.foreground ? state : null
    }, '实际覆盖安装器处于 Windows 前台', 10_000)
    console.log('Actual installer in the Windows foreground: ' + JSON.stringify(active))
  }
  await clickPrimary(ui, '开始安装')
  const finished = await until(async () => {
    await reportProgress?.()
    const state = await ui.run(`({
      failure: document.querySelector('.setup-warn-block')?.textContent,
      complete: document.querySelector('.setup-title-lg')?.textContent === '安装完成'
    })`)
    return state.failure || state.complete ? state : null
  }, 'Beta 安装完成')
  assert(!finished.failure, finished.failure)
  assert(samePath(await ui.run(`document.querySelector('.setup-panel .setup-sub b')?.textContent`), target))
}

async function install(file, name, version, previousVersion) {
  const target = sandboxInstall(name)
  const data = sandboxData(name)
  await mkdir(data, { recursive: true })
  const ui = live && name === 'live-beta' ? await launchLiveLegacy(file) : await launch(file)
  const info = await ui.run('window.api.installerInfo()')
  let selections
  assert.equal(info.version, version)
  if (previousVersion) {
    const inspection = await ui.run('window.api.installerInspect(' + JSON.stringify(target) + ')')
    assert.equal(inspection.version, previousVersion)
  }
  if (beta && name === 'fresh') {
    selections = await installThroughSetup(ui, info, target, data)
  } else if (beta && previousVersion) {
    await setupPath(ui, '安装位置', target)
    await setupPath(ui, '用户数据目录', data)
    await confirmSetupInstall(ui, target, data, true)
  } else {
    const call = 'window.api.installerRun(' + JSON.stringify(target) + ',' + JSON.stringify(data) + ')'
    assert.equal(await ui.run(call), true)
  }
  await ui.close()
  assert.equal((await readFile(join(target, 'resources', 'app-version.txt'), 'utf8')).trim(), version)
  return { target, selections }
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

async function seedProfile(target, data, version) {
  const entry = join(target, windowsLayout.entry)
  const ui = live ? await launchLiveLegacy(entry) : await launch(entry)
  assert.equal(await ui.run('window.api.appVersion()'), version)
  assert.deepEqual(await ui.run('window.api.listApps()'), [])
  const fixture = await ui.run('window.api.addApp({ name: "Windows 验收夹具", launchMethods: [] })')
  assert.equal(typeof fixture.id, 'string')
  await ui.close()
  const end = new Date()
  const history = { version: 1, sessions: [{
    appId: fixture.id, startUtc: new Date(end.getTime() - 60_000).toISOString(),
    endUtc: end.toISOString(), durationSec: 60
  }] }
  await writeFile(join(data, 'playtime.json'), JSON.stringify(history))
  await checkProfile(data, fixture, history)
  return { fixture, history }
}

async function unrelatedLauncherWindow() {
  const outside = join(root, '另一个同名进程', windowsLayout.entry)
  await mkdir(dirname(outside), { recursive: true })
  const csc = join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  const fixture = fileURLToPath(new URL('../tests/fixtures/windows-entry-close.cs', import.meta.url))
  execFileSync(csc, ['/nologo', '/target:exe', '/out:' + outside, fixture], { windowsHide: true, stdio: 'inherit' })
  let messages = ''
  const child = spawn(outside, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  children.add(child)
  child.stdout.setEncoding('utf8').on('data', chunk => { messages += chunk })
  await once(child, 'spawn')
  const exited = once(child, 'exit')
  await until(() => /^ready:\d+\r?\n/.test(messages), '不同目录的同名 Windows 窗口就绪', 10_000)
  return async () => {
    assert.equal(child.exitCode, null, '覆盖安装不能关闭不同目录的同名进程')
    assert.match(messages, /^ready:\d+\r?\n$/, '覆盖安装不能给不同目录的同名窗口发退出通知')
    child.kill() // Owned test subprocess only.
    await exited
    children.delete(child)
  }
}

async function activityProcess(action) {
  return windows(action, '-FixtureRoot', root, '-Target', activity.file, '-ProcessId', String(activity.pid))
}

async function placeLegacyInTray(ui, installed, data) {
  const preferences = await ui.run('window.api.setLauncherBehavior({ closeAction: "tray", autoStart: "tray", afterLaunch: "none" })')
  assert.equal(preferences.closeAction, 'tray')
  assert.equal(preferences.autoStart, 'tray')
  const file = join(root, 'playtime-fixture.exe')
  await copyFile(join(process.env.SystemRoot, 'System32', 'PING.EXE'), file)
  const fixture = await ui.run('window.api.addApp(' + JSON.stringify({ name: 'Windows 覆盖验收运行会话',
    launchMethods: [{ targetPath: file, arguments: '-n 45 127.0.0.1', workingDirectory: root }] }) + ')')
  const launched = await ui.run('window.api.launchApp(' + JSON.stringify(fixture.id) + ')')
  assert.equal(launched.ok, true, launched.error)
  assert(Number.isSafeInteger(launched.pid) && launched.pid > 0, '预期运行验收进程的真实 PID')
  activity = { file, pid: launched.pid, appId: fixture.id }
  await until(async () => (await ui.run('window.api.listRunning()')).some(
    app => app.appId === fixture.id && app.pids.includes(launched.pid)), '旧模式已记录运行中的应用')
  assert.equal(await activityProcess('activity-process'), true)
  await ui.run('window.api.windowClose()', 5000)
  let observed
  const tray = await until(async () => {
    const visibility = await ui.run('document.visibilityState', 5000)
    const { processes } = await windows('processes', '-Target', installed)
    observed = { visibility, processes }
    return visibility === 'hidden' && processes.find(process => process.tray && process.chromeHidden &&
      !process.chromeVisible && !process.renderer)
  }, '旧版关闭窗口后保持在实际 Windows 托盘中', 15_000).catch(error => {
    throw new Error(error.message + '\nLegacy window observation: ' + JSON.stringify(observed), { cause: error })
  })
  console.log('Legacy launcher hidden in its Windows tray: ' + JSON.stringify({ pid: tray.id, image: tray.path, activityPid: launched.pid }))
  assert.equal(await activityProcess('activity-process'), true)
  const persisted = JSON.parse(await readFile(join(data, 'playtime.json'), 'utf8'))
  assert(!persisted.sessions.some(session => session.appId === activity.appId), '旧版退出前活动会话应尚未保存')
  await delay(1200)
  return unrelatedLauncherWindow()
}

async function expectedOverlayHistory(data, previous) {
  if (!activity) return previous
  assert.equal(await activityProcess('activity-process'), true, '覆盖安装应让运行中的应用继续运行')
  const after = JSON.parse(await readFile(join(data, 'playtime.json'), 'utf8'))
  assert.equal(after.version, previous.version)
  assert.deepEqual(after.sessions.slice(0, previous.sessions.length), previous.sessions)
  const added = after.sessions.slice(previous.sessions.length)
  assert.equal(added.length, 1, '托盘旧实例退出时应保存正在运行的会话')
  assert.equal(added[0].appId, activity.appId)
  assert(added[0].durationSec >= 1, '退出时刷新的会话应有实际使用时长')
  return after
}

// The fresh Beta profile is seeded through the installed addApp path without a
// per-app HUD. Reading the restarted app's first HUD entry proves the shared
// product default reached the real profile instead of only this verifier.
function freshHudSettings(app) {
  assert.ok(app?.kevinHud, '全新安装返回的首个应用应带有 HUD 设置')
  const hud = Object.fromEntries(Object.keys(FRESH_HUD_DEFAULTS).map(key => [key, app.kevinHud[key]]))
  assert.deepEqual(hud, FRESH_HUD_DEFAULTS, '实际安装应用返回的 HUD 设置应与产品默认值一致')
  return { app: app.name, ...hud }
}

async function startInstalled(target, version, fixture, savedSession) {
  windowsExecutable.assertExecutionLevel(join(target, windowsLayout.entry), 'requireAdministrator')
  windowsExecutable.assertExecutionLevel(join(target, windowsLayout.runtime), 'asInvoker')
  const ui = await launch(join(target, windowsLayout.entry))
  assert.equal(await ui.run('window.api.appVersion()'), version)
  assert.ok((await ui.run('navigator.userAgent')).includes('Electron/' + source.electron))
  const apps = await ui.run('window.api.listApps()')
  assert.ok(apps.some(app => app.id === fixture.id && app.name === fixture.name))
  if (beta && scenario === 'fresh') {
    assert.equal(apps[0].id, fixture.id, '全新安装返回的首个应用应为验收夹具')
    console.log('Fresh installed first app HUD settings: ' + JSON.stringify(freshHudSettings(apps[0])))
  }
  const totals = await ui.run('window.api.playTimeTotals()')
  assert.equal(totals[fixture.id], 60)
  if (savedSession) assert.equal(totals[savedSession.appId], savedSession.durationSec)
  await until(async () => {
    const health = JSON.parse(await readFile(join(target, 'resources', 'app-activation.json'), 'utf8'))
    return health.healthy === version
  }, '渲染器报告启动健康')
  if (scenario === 'legacy-tray') {
    const preserved = await ui.run('window.api.getLauncherSettings()')
    assert.equal(preserved.closeAction, 'tray', '覆盖安装应保留关闭到托盘的设置')
    // Only change this disposable profile after verifying the retained preference.
    const cleanup = await ui.run('window.api.setLauncherBehavior({ closeAction: "close" })')
    assert.equal(cleanup.closeAction, 'close')
  }
  await ui.close()
}

async function verifyBetaIntegration(target, data, selections) {
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
    assert(link.target && link.workingDirectory, 'Shortcut missing a launch path: ' + JSON.stringify(link))
    assert(samePath(await realpath(link.target), entry), 'Wrong shortcut target: ' + JSON.stringify(link))
    assert(samePath(await realpath(link.workingDirectory), target), 'Wrong shortcut working directory: ' + JSON.stringify(link))
    assert.equal(link.arguments, '')
  }
  const launchedFrom = []
  for (const link of links) launchedFrom.push(await launchBetaShortcut(link.path, target, entry, runtime))
  const [launched] = launchedFrom
  await assert.rejects(access(join(process.env.LOCALAPPDATA, 'Programs', 'KevinLauncher')), { code: 'ENOENT' })
  return {
    nativeFolderDialogs: 2, ...selections, program: target, data,
    differentSystemVolume: !samePath(parse(target).root, parse(process.env.LOCALAPPDATA).root),
    defaultProgramUntouched: true, shortcutsLaunched: launchedFrom.length, productionRegistration: true,
    startupTask: task.level, runnerIntegrityRid: launched.runnerIntegrityRid,
    entryIntegrityRid: launched.started.integrityRid, runtimeIntegrityRid: launched.main.integrityRid,
    rendererIntegrityRids: launched.renderers.map(renderer => renderer.integrityRid), rendererSandboxed: true,
    uacPromptObserved: false
  }
}

async function launchBetaShortcut(shortcut, target, entry, runtime) {
  await windows('launch', '-Target', shortcut)
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
  return launched
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
  const removed = await windows('integration')
  assert.equal(removed.uninstall, null, '卸载应清理原有 Windows 注册入口')
  if (beta) {
    assert.equal(removed.program, null, '卸载应清理指向已卸载程序的注册项')
    assert.equal(removed.task, null, '卸载应清理指向已卸载程序的开机任务')
    assert.equal(await windows('links'), null, '卸载应清理指向已卸载目录的快捷方式')
  }
}

async function readFileTree(base, profile = '') {
  const entries = await readdir(join(base, profile), { withFileTypes: true })
  const indexed = {}
  for (const entry of entries) {
    const file = join(profile, entry.name)
    if (entry.isDirectory()) Object.assign(indexed, await readFileTree(base, file))
    else if (entry.isFile()) indexed[file] = await readFile(join(base, file))
    else throw new Error('发现异常更新包文件：' + file)
  }
  return indexed
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
  const packed = await readFileTree(target)
  assert.deepEqual(packed, await readFileTree(join(installed, 'resources', 'app-' + source.version)))
  if (!beta) {
    const manifest = JSON.parse(await readFile(join(dir, 'update-manifest.json'), 'utf8'))
    assert.equal(Object.values(packed).reduce((sum, file) => sum + file.length, 0), manifest.appSize)
  }
}

async function compareLivePayload(installed) {
  const target = join(root, 'public-beta-payload')
  await mkdir(target)
  execFileSync(join(process.env.SystemRoot, 'System32', 'tar.exe'),
    ['-xf', liveBeta.payloadFile, '-C', target], { windowsHide: true, stdio: 'inherit' })
  const expected = await readFileTree(target)
  const actual = await readFileTree(join(installed, 'resources', 'app-' + liveBeta.manifest.version))
  assert.deepEqual(actual, expected, '安装后的应用目录必须与公开应用 ZIP 完全一致')
  assert.equal(Object.values(expected).reduce((sum, file) => sum + file.length, 0), liveBeta.manifest.appSize)
  console.log('Installed app directory matches the public Beta application ZIP byte for byte')
}

async function uninstallFresh(target, data, fixture, history) {
  const running = await launch(join(target, windowsLayout.entry))
  const tray = await running.run('window.api.setLauncherBehavior({ closeAction: "tray" })')
  assert.equal(tray.closeAction, 'tray')
  await verifyUninstall(target, data)
  await running.waitForExit()
  await checkProfile(data, fixture, history)
}

async function verifyFreshBeta() {
  console.log('Checking a fresh Beta on its own disposable Windows runner')
  const { target, selections } = await install(installer, 'fresh', source.version)
  const data = sandboxData('fresh')
  console.log('Installed the selected Beta paths: ' + JSON.stringify({ ...selections, program: target, data }))
  const { fixture, history } = await seedProfile(target, data, source.version)
  await startInstalled(target, source.version, fixture)
  await comparePayload(target)
  const integration = await verifyBetaIntegration(target, data, selections)
  console.log('Installed Windows Beta integration: ' + JSON.stringify(integration))
  await uninstallFresh(target, data, fixture, history)
  const proof = { ...integration, installedPayloadMatched: true, uninstalledWithDataPreserved: true }
  console.log('Fresh Windows Beta verification: ' + JSON.stringify(proof))
  return proof
}

async function verifyPublishedOverlay() {
  const previousInstaller = await releasedAssets(process.argv[4] ?? 'latest')
  const previous = beta ? await releasedAssets('v2.0.5') : previousInstaller
  assert.ok(isNewerVersion(source.version, previous.manifest.version), '候选版本必须高于已发布正式版本')
  const previousFile = join(root, previousInstaller.manifest.installerName)
  await downloadInstaller(previousInstaller, previousFile)
  const { target: existing } = await install(previousFile, 'upgrade', previousInstaller.manifest.version)
  if (beta) await loadPublishedLegacyPayload(existing, previousInstaller, previous)
  const oldEntry = join(existing, windowsLayout.entry)
  const data = sandboxData('upgrade')
  const { fixture, history } = await seedProfile(existing, data, previous.manifest.version)
  const previousUi = await launch(oldEntry)
  assert.equal(await previousUi.run('window.api.appVersion()'), previous.manifest.version)
  if (beta) assert.ok((await previousUi.run('navigator.userAgent')).includes('Electron/' + previous.manifest.electron))
  assert.ok((await previousUi.run('window.api.listApps()')).some(app => app.id === fixture.id))
  assert.equal((await previousUi.run('window.api.playTimeTotals()'))[fixture.id], 60)
  const checkUnrelated = beta ? await placeLegacyInTray(previousUi, existing, data) : null
  console.log('Verified and started the published application v' + previous.manifest.version +
    ' on the installed v' + previousInstaller.manifest.version + ' host')
  const { target: covering } = await install(installer, 'upgrade', source.version, previous.manifest.version).catch(async error => {
    const launcherLog = (await readFile(join(sandboxData('upgrade'), 'launcher.log'), 'utf8').catch(() => ''))
      .split(/\r?\n/).filter(line => /\b(?:install:|app:|shutdown:)/.test(line)).slice(-25).join('\n')
    if (launcherLog) console.error('Installation and previous launcher log\n' + launcherLog)
    if (/提前退出|Electron 页面就绪/.test(error.message)) await diagnoseUnpackedSetup()
    throw error
  })
  await previousUi.waitForExit()
  assert.equal(existing, covering)
  const updatedHistory = await expectedOverlayHistory(data, history)
  if (beta) console.log('Legacy launcher exited normally and saved its running session')
  await checkUnrelated?.()
  await checkProfile(data, fixture, updatedHistory)
  await checkProfile(join(data, 'update-backup'), fixture, updatedHistory)
  if (activity) {
    await activityProcess('stop-activity-process')
    activity = undefined
  }
  await startInstalled(covering, source.version, fixture, beta ? updatedHistory.sessions.at(-1) : undefined)
  console.log('Verified overwrite upgrade, startup, saved history and previous profile backup')
  return {
    previousVersion: previous.manifest.version, previousInstallerSha256: previousInstaller.manifest.installerSha256,
    ...(beta ? { previousInstallerVersion: previousInstaller.manifest.version,
      previousPayloadSha256: previous.manifest.payloadSha256 } : {}),
    fixture, history
  }
}

async function loadPublishedLegacyPayload(installation, runtimeRelease, applicationRelease) {
  const { electron, version, payloadSha256 } = applicationRelease.manifest
  assert.equal(electron, runtimeRelease.manifest.electron, '旧应用和运行库必须来自同一 Electron 版本')
  assert.ok(isNewerVersion(version, runtimeRelease.manifest.version), '旧应用载荷必须比夹具运行库壳更新')
  const archive = join(root, 'legacy-app-' + version + '.zip')
  await downloadPayload(applicationRelease, archive)
  const resources = join(installation, 'resources')
  const destination = join(resources, 'app-' + version)
  await mkdir(destination)
  execFileSync(join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', archive, '-C', destination], {
    windowsHide: true, stdio: 'inherit'
  })
  assert.equal(JSON.parse(await readFile(join(destination, 'package.json'), 'utf8')).version, version)
  await access(join(destination, 'out', 'main', 'index.js'))
  await writeFile(join(resources, 'app-version.txt'), version + '\n')
  console.log('Verified and loaded the published application payload v' + version + ' (SHA-256 ' + payloadSha256 +
    ') on the installed v' + runtimeRelease.manifest.version + ' Electron ' + electron + ' runtime')
}

async function verifyLiveBetaChannel() {
  console.log('Live Beta channel: published v2.0.5 -> ' + liveBeta.manifest.version)
  const stable = await releasedAssets('v2.0.5')
  assert.equal(stable.manifest.version, '2.0.5')
  assert.equal(stable.manifest.electron, '44.7.0', '公开 v2.0.5 清单必须使用 Electron 44.7.0')
  const previousFile = join(dir, 'KevinLauncher-Installer-2.0.5.exe')
  await downloadInstaller(stable, previousFile)
  const previousHash = await identifyFile(previousFile)
  assert.equal(previousHash.size, stable.manifest.installerSize)
  assert.equal(previousHash.sha256, stable.manifest.installerSha256)
  windowsExecutable.assertExecutionLevel(previousFile, 'requireAdministrator')
  console.log('Verified public v2.0.5 installer ' + previousHash.size + ' bytes · ' + previousHash.sha256)
  console.log('Temporary verifier-only Chromium switches for the published v2.0.5 installer and installed launcher: ' +
    LIVE_LEGACY_CHROMIUM_FLAGS.join(' ') + ' (no release binary is changed)')

  const { target } = await install(previousFile, 'live-beta', stable.manifest.version)
  liveInstalled = target
  assert.equal((await readFile(join(target, 'resources', 'app-version.txt'), 'utf8')).trim(), stable.manifest.version)
  const data = sandboxData('live-beta')
  const { fixture, history } = await seedProfile(target, data, stable.manifest.version)
  const ui = await launchLiveLegacy(join(target, windowsLayout.entry))
  assert.equal(await ui.run('window.api.appVersion()'), stable.manifest.version)
  assert.match(await ui.run('navigator.userAgent'), /Electron\/44\.7\.0(?:[^\d]|$)/,
    '实际安装的 v2.0.5 运行库必须是 Electron 44.7.0')
  assert.equal((await ui.run('window.api.getLauncherSettings()')).updateChannel, 'stable',
    '新安装必须从正式通道开始')
  // The old client schedules its first automatic check after four seconds.
  // Wait for that stable result before switching, otherwise its in-flight
  // response could overwrite the Beta offer.
  await until(async () => {
    const cache = JSON.parse(await readFile(join(data, 'update-check.json'), 'utf8').catch(() => '{}'))
    return cache.channels?.stable?.auto > 0 ? cache : null
  }, '正式通道启动检查完成', 45_000)
  const stableStatus = await ui.run('window.api.appUpdateCheck()')
  assert.equal(stableStatus.error, undefined, '正式通道检查不应失败：' + stableStatus.error)
  assert.equal(stableStatus.current, stable.manifest.version)
  assert.equal(stableStatus.hasUpdate, false, '正式通道不得提供 Beta 或更新')
  assert.equal(stableStatus.info, null)
  const stableCache = JSON.parse(await readFile(join(data, 'update-check.json'), 'utf8'))
  assert.equal(stableCache.forVersion, stable.manifest.version)
  assert(!JSON.stringify(stableCache).includes('-beta.'), '正式通道缓存不得包含 Beta')
  console.log('Stable channel starts without a Beta offer')

  const betaSettings = await ui.run('window.api.setLauncherBehavior({ updateChannel: "beta" })')
  assert.equal(betaSettings.updateChannel, 'beta', '旧版公开设置入口必须能切换到测试通道')
  assert.equal(JSON.parse(await readFile(join(data, 'config.json'), 'utf8')).launcher.updateChannel, 'beta')
  const betaStatus = await ui.run('window.api.appUpdateCheck()')
  assert.equal(betaStatus.error, undefined, 'Beta 检查不应失败：' + betaStatus.error)
  assert.equal(betaStatus.current, stable.manifest.version)
  assert.equal(betaStatus.hasUpdate, true, '测试通道应提供公开 Beta')
  assert.ok(betaStatus.info, '测试通道应返回公开 Beta 信息')
  assert.equal(betaStatus.info.version, liveBeta.manifest.version, '必须提供目标 Beta 版本')
  assert.equal(betaStatus.info.critical, false, '公开 Beta 不得是重要更新')
  assert.equal(betaStatus.info.electronVersion, '44.7.0', '旧客户端应看到 44.7.0 清单')
  assert.equal(betaStatus.info.payloadSize, liveBeta.manifest.payloadSize)
  assert.equal(betaStatus.info.payloadSha256, liveBeta.manifest.payloadSha256)
  assert.equal(betaStatus.info.installSize, liveBeta.manifest.appSize)
  assert.equal(betaStatus.info.installerName, liveBeta.manifest.installerName)
  assert.equal(betaStatus.info.installerSize, liveBeta.manifest.installerSize)
  assert.equal(betaStatus.info.installerSha256, liveBeta.manifest.installerSha256)
  assert.ok(betaStatus.info.payloadUrls.includes('https://github.com/KevinYuHere/KevinLauncher/releases/download/v' +
    liveBeta.manifest.version + '/' + payloadAssetName(liveBeta.manifest.version)))
  console.log('Beta channel offers ' + liveBeta.manifest.version + ' via a ' +
    betaStatus.info.payloadSize + '-byte application ZIP')

  const entryPath = join(target, windowsLayout.entry)
  const dedicatedRuntimePath = join(target, windowsLayout.runtime)
  // v2.0.5 predates the native shell and ships only KevinLauncher.exe, which
  // is itself the Electron runtime. Later shells add a dedicated runtime exe.
  const dedicatedRuntimeEntry = await lstat(dedicatedRuntimePath).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  const dedicatedRuntime = dedicatedRuntimeEntry?.isFile() === true
  const runtimeAbsent = dedicatedRuntimeEntry === null
  const runtimePath = dedicatedRuntime ? dedicatedRuntimePath : entryPath
  const entryBefore = await identifyFile(entryPath)
  const runtimeBefore = dedicatedRuntime ? await identifyFile(runtimePath) : entryBefore
  const snapshot = {}
  for (const file of ['config.json', 'playtime.json']) snapshot[file] = await identifyFile(join(data, file))
  const logFile = join(data, 'launcher.log')
  const logBeforeLength = (await readFile(logFile, 'utf8').catch(() => '')).length

  await ui.command('Runtime.addBinding', { name: 'kevinLiveUpdateState' })
  await ui.run(`(() => {
    if (!window.api.onAppUpdateState) throw new Error('旧版缺少更新状态事件')
    window.api.onAppUpdateState(state => window.kevinLiveUpdateState(JSON.stringify(state)))
    return true
  })()`)
  await ui.run('void window.api.appUpdateStart()')
  const relaunched = await relaunchLiveInstalled(ui, target)
  assert.equal(await relaunched.ui.run('window.api.appVersion()'), liveBeta.manifest.version,
    '更新后必须运行目标 Beta')
  assert.match(await relaunched.ui.run('navigator.userAgent'), /Electron\/44\.7\.0(?:[^\d]|$)/,
    '轻量更新必须继续使用旧 Electron 44.7.0')
  await until(async () => (await relaunched.ui.run('document.querySelector("#root")?.childElementCount ?? 0')) > 0,
    '更新后的真实界面完成渲染', 30_000)
  const uiState = await relaunched.ui.run(`({
    title: document.title,
    children: document.querySelector('#root')?.childElementCount ?? 0,
    text: (document.body?.innerText ?? '').trim().slice(0, 200)
  })`)
  assert.equal(uiState.title, 'KevinLauncher')
  assert.ok(uiState.children > 0 && uiState.text.length > 0, '更新后的真实界面应有内容')
  assert.equal((await readFile(join(target, 'resources', 'app-version.txt'), 'utf8')).trim(),
    liveBeta.manifest.version, '资源版本指针必须指向目标 Beta')
  assert.equal(JSON.parse(await readFile(join(target, 'resources', 'app-' + liveBeta.manifest.version,
    'package.json'), 'utf8')).version, liveBeta.manifest.version)
  await compareLivePayload(target)

  assert.equal((await relaunched.ui.run('window.api.getLauncherSettings()')).updateChannel, 'beta',
    '更新后应保留测试通道选择')
  const apps = await relaunched.ui.run('window.api.listApps()')
  assert.ok(apps.some(app => app.id === fixture.id && app.name === fixture.name), '更新后应保留应用数据')
  assert.equal((await relaunched.ui.run('window.api.playTimeTotals()'))[fixture.id], 60,
    '更新后应保留使用时长')
  await checkProfile(data, fixture, history)
  const configAfter = JSON.parse(await readFile(join(data, 'config.json'), 'utf8'))
  assert(configAfter.apps.some(app => app.id === fixture.id && app.name === fixture.name))
  assert.equal(configAfter.launcher.updateChannel, 'beta')
  assert.deepEqual(JSON.parse(await readFile(join(data, 'playtime.json'), 'utf8')), history)
  const backupConfig = JSON.parse(await readFile(join(data, 'update-backup', 'config.json'), 'utf8'))
  assert(backupConfig.apps.some(app => app.id === fixture.id && app.name === fixture.name))
  assert.equal(backupConfig.launcher.updateChannel, 'beta')
  assert.deepEqual(JSON.parse(await readFile(join(data, 'update-backup', 'playtime.json'), 'utf8')), history)
  for (const file of Object.keys(snapshot)) {
    assert.deepEqual(await identifyFile(join(data, 'update-backup', file)), snapshot[file],
      '更新快照必须保留更新前的 ' + file)
  }
  console.log('Verified update backup snapshot and preserved profile')

  const appendedLog = (await readFile(logFile, 'utf8')).slice(logBeforeLength)
  const versionPattern = liveBeta.manifest.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  assert.match(appendedLog, new RegExp('appUpdate: starting ' + versionPattern + ' \\(app payload,'),
    '旧版日志必须记录应用包更新')
  assert.match(appendedLog, new RegExp('appUpdate: version pointer -> ' + versionPattern),
    '旧版日志必须记录实际版本指针切换')
  assert.ok(!appendedLog.includes('appUpdate: opening '), '旧版不得打开安装程序')
  assert.match(appendedLog, new RegExp('backup: "update ' + versionPattern + '" ->'), '更新前应创建数据快照')
  const states = ui.events.filter(event => event.name === 'kevinLiveUpdateState').map(event => event.value)
  const transferStates = states.filter(state => state && state.total > 0)
  assert(transferStates.some(state => state.total === liveBeta.manifest.payloadSize && state.message.includes('更新')),
    '旧版更新进度应显示应用 ZIP 大小')
  assert(!transferStates.some(state => state.total === liveBeta.manifest.installerSize ||
    state.message.includes('安装程序')), '旧版更新不得请求安装程序')
  assert(states.some(state => state.phase === 'installing' || state.phase === 'done'),
    '旧版应进入应用包安装阶段')
  assert.deepEqual(await identifyFile(entryPath), entryBefore, '轻量更新后公开入口 exe 必须保持不变')
  if (dedicatedRuntime) {
    assert.deepEqual(await identifyFile(runtimePath), runtimeBefore, '轻量更新后 Electron 运行库必须保持不变')
  } else if (runtimeAbsent) {
    await assert.rejects(access(dedicatedRuntimePath), { code: 'ENOENT' },
      '初始没有独立运行库时，轻量更新不得新增 ' + windowsLayout.runtime)
  }
  console.log('Confirmed the old public updater requested the application ZIP and left ' +
    (dedicatedRuntime ? 'entry/runtime binaries' : 'the single entry binary (no separate runtime)') + ' unchanged')
  await relaunched.ui.close()

  return {
    mode: 'live-beta-channel',
    stable: {
      version: stable.manifest.version,
      electron: stable.manifest.electron,
      installerName: stable.manifest.installerName,
      installerSize: previousHash.size,
      installerSha256: previousHash.sha256
    },
    beta: {
      version: liveBeta.manifest.version,
      electron: liveBeta.manifest.electron,
      manifestSha256: liveBeta.manifestSha256,
      payloadName: liveBeta.payloadAsset,
      payloadSize: liveBeta.payloadSize,
      payloadSha256: liveBeta.payloadSha256,
      installerName: liveBeta.installerAsset,
      installerSize: liveBeta.manifest.installerSize,
      installerSha256: liveBeta.manifest.installerSha256,
      critical: liveBeta.manifest.critical,
      prerelease: liveBeta.release.prerelease
    },
    stableChannelInitially: 'stable',
    betaNotOfferedBeforeSwitch: true,
    betaOfferExact: true,
    betaOfferNoncritical: true,
    publicManifestMatched: true,
    publicPayloadDownloaded: true,
    appPayloadRequested: true,
    installerNotRequested: true,
    relaunch: { method: relaunched.method, mainPid: relaunched.mainPid, mainImage: relaunched.mainImage },
    versionPointer: liveBeta.manifest.version,
    restartedVersion: liveBeta.manifest.version,
    runtimeElectron: '44.7.0',
    rendererRendered: true,
    runtimeLayout: dedicatedRuntime ? 'dedicated-runtime' : 'entry-only',
    entryBinaryUnchanged: true,
    runtimeBinaryUnchanged: true,
    dataPreserved: true,
    backupVerified: true,
    profile: { app: fixture.name, appId: fixture.id, updateChannel: 'beta' },
    transferTotals: [...new Set(transferStates.map(state => state.total))],
    uiStates: states.length
  }
}

try {
  if (live) {
    const proof = await verifyLiveBetaChannel()
    const verification = {
      runId: process.env.GITHUB_RUN_ID,
      verifierSha: source.sha,
      ...proof,
      assets
    }
    await writeFile(join(dir, 'windows-verification.json'), JSON.stringify(verification, null, 2) + '\n')
    console.log('Live Windows Beta channel verification: ' + JSON.stringify(verification))
    if (process.env.GITHUB_STEP_SUMMARY) {
      const summary = [
        '### Published Beta channel verification',
        '',
        'Stable source: v' + proof.stable.version + ' (Electron ' + proof.stable.electron + ')',
        'Stable installer SHA-256: ' + proof.stable.installerSha256,
        'Published Beta: ' + proof.beta.version + ' (manifest Electron ' + proof.beta.electron + ')',
        'Beta manifest SHA-256: ' + proof.beta.manifestSha256,
        'Beta application ZIP SHA-256: ' + proof.beta.payloadSha256,
        'Stable channel started without a Beta offer; the old public Beta switch offered exactly the target version.',
        'The old client downloaded and applied the application ZIP; ' +
          (proof.runtimeLayout === 'dedicated-runtime'
            ? 'entry and runtime binaries stayed unchanged.'
            : 'the single entry binary stayed unchanged and no separate runtime was added.'),
        'Temporary verifier-only Chromium switches for the published v2.0.5 installer and launcher: ' +
          LIVE_LEGACY_CHROMIUM_FLAGS.join(' ') + ' (production and release launches are unchanged).',
        'Restarted on Electron 44.7.0 with the new version pointer, real renderer, profile and update backup intact.',
        '',
        ...Object.entries(assets).map(([file, asset]) => '- ' + file + ': ' + asset.sha256)
      ].join('\n') + '\n'
      const { appendFile } = await import('node:fs/promises')
      await appendFile(process.env.GITHUB_STEP_SUMMARY, summary)
    }
  } else {
    const betaIntegration = scenario === 'fresh' ? await verifyFreshBeta() : null
    const overlay = scenario === 'fresh' ? null : await verifyPublishedOverlay()
    if (!beta) {
      const { target: fresh } = await install(installer, 'fresh', source.version)
      await startInstalled(fresh, source.version, overlay.fixture)
      await comparePayload(fresh)
      console.log('Verified fresh install, startup and byte-for-byte app payload')
      await uninstallFresh(fresh, sandboxData('fresh'), overlay.fixture, overlay.history)
    }
    assert.deepEqual(beta ? await verifyBetaInstaller() : await verifyLocalAssets(dir, source.version, source.electron), assets)
    const verification = {
      sha: source.sha,
      tree: source.tree,
      runId: process.env.GITHUB_RUN_ID,
      version: source.version,
      electron: source.electron,
      launched: true,
      ...(overlay ? { previous: overlay.previousVersion, previousInstallerSha256: overlay.previousInstallerSha256,
        overwriteUpgrade: true, historyPreserved: true, backupVerified: true } : {}),
      ...(!beta || betaIntegration ? { freshInstall: true, payloadMatchesInstalled: true, uninstalled: true } : {}),
      entryMode: 'requireAdministrator',
      runtimeMode: 'asInvoker',
      ...(beta ? { scenario } : {}),
      ...(betaIntegration ? { betaIntegration } : {}),
      ...(scenario === 'legacy-tray' ? { legacyTrayOverlay: {
        previousInstallerVersion: overlay.previousInstallerVersion, previousPayloadSha256: overlay.previousPayloadSha256,
        hiddenBeforeUpgrade: true, foregroundInstaller: true, exitedNormally: true,
        simultaneousActivityFlushed: true, activeApplicationContinued: true, unrelatedSameNamedProcessPreserved: true
      } } : {}),
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
        ...(overlay ? ['Previous verified release: ' + overlay.previousVersion, 'Previous installer SHA-256: ' + overlay.previousInstallerSha256,
          'Verified overwrite upgrade, startup, backup and application history.'] : []),
        ...(overlay?.previousPayloadSha256 ? ['Legacy runtime installer version: ' + overlay.previousInstallerVersion,
          'Historical application payload SHA-256: ' + overlay.previousPayloadSha256] : []),
        ...(!beta || betaIntegration ? ['Verified fresh install, launch and managed uninstall.'] : []),
        ...(betaIntegration ? ['Beta production integration: ' + JSON.stringify(betaIntegration)] : []),
        '',
        ...Object.entries(assets).map(([file, asset]) => '- ' + file + ': ' + asset.sha256)
      ].join('\n') + '\n'
      const { appendFile } = await import('node:fs/promises')
      await appendFile(process.env.GITHUB_STEP_SUMMARY, summary)
    }
  }
} finally {
  if (activity) await activityProcess('stop-activity-process').catch(error => console.error(error.message))
  if (liveInstalled) {
    await stopExactTargetProcesses(liveInstalled).catch(error =>
      console.error('清理隔离的实时 Beta 测试进程失败：' + error.message))
  }
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
